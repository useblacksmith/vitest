import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin } from 'vitest/config'
import type { Vitest } from 'vitest/node'
import { ENV_RECORD_ROOT, ENV_REPO } from './fs-recorder.js'
import { repoRoot } from './git.js'

import {
	compileDependencies,
	configuredProvider,
	isTreeSnapshotProvider,
	isSnapshotRecorder,
	restoreDependencyCache,
	ShadowAnalysis,
	SnapshotRecorder,
	TreeSnapshotProvider,
} from './affected.js'
import {
	customSequencer,
	HashShardSequencer,
	stableShards,
} from './sequencer.js'

/** Beside this module; `.ts` when the plugin runs from source (its own test fixtures). */
const recordReads = fileURLToPath(
	new URL(
		import.meta.url.endsWith('.ts') ? './record-reads.ts' : './record-reads.js',
		import.meta.url,
	),
)

export interface BlacksmithOptions {
	/**
	 * Run every test instead of only those affected since the last green run.
	 * By default (false) the plugin turns `--changed` on itself, provided the
	 * running Vitest routes it through the plugin's VCS provider and records
	 * dependencies; otherwise it warns once and every test runs, so an older
	 * Vitest never skips tests on a stale record.
	 */
	runAllTests?: boolean
	/**
	 * Dependencies the tracking cannot see (files a test reads through a child
	 * process, in `globalSetup`, or outside node): globs of test files mapped
	 * to the glob(s) of the files they depend on, both relative to the config
	 * root. A change to a matching file reruns every test file the key matches.
	 * `{ 'tests/*.spec.ts': 'fixtures/**' }`, say.
	 */
	dependencies?: Record<string, string | string[]>
}

/**
 * Run every test and only *report* what the affected selection would have
 * run: vitest records dependencies but gets no `--changed` and no VCS
 * provider, the shard's cached record is fetched into a temporary directory
 * (vitest's `cacheDir` is left alone) and, when the run ends, the plugin
 * logs how many of the files that ran it would have selected and which
 * failing test files it would have skipped. A green run still saves the record.
 */
type ShadowOption = { shadow?: boolean }

/** Vitest 5.1.0 is the first to hand a VCS provider the dependency records. */
export function supportsVersion(version: string): boolean {
	const [major = 0, minor = 0] = version.split('.').map(Number)
	return major > 5 || (major === 5 && minor >= 1)
}

/** Whether this Vitest wired up the pieces `--changed` selection relies on. */
function supportsChanged(vitest: Vitest): boolean {
	const { vcs } = vitest as { vcs?: { findChangedFiles?: unknown } }
	const experimental = vitest.config.experimental as
		{ recordDependencies?: boolean; vcsProvider?: unknown } | undefined
	return (
		supportsVersion(vitest.version) &&
		typeof vcs?.findChangedFiles === 'function' &&
		experimental?.recordDependencies === true &&
		isTreeSnapshotProvider(experimental.vcsProvider)
	)
}

/**
 * Vitest externalizes modules under node_modules, so the installed setup file
 * would import its own `vitest`: resolved from the plugin's directory, which a
 * package manager may point at another copy than the one running the tests
 * (pnpm, for two workspace packages whose peer sets differ). Its `afterAll`
 * would then register with that copy. Inlined, the plugin's modules get the
 * running vitest.
 */
const PACKAGE = '@useblacksmith/vitest'

export default function blacksmith(options: BlacksmithOptions = {}): Plugin {
	const shadowMode = (options as ShadowOption).shadow === true
	const provider = new TreeSnapshotProvider()
	let changedApplied = false
	let restored: Promise<void> | undefined
	let shadow: ShadowAnalysis | undefined
	return {
		name: 'blacksmith',
		config(userConfig) {
			// Vite merges this over the user's config, so a sequencer the config
			// names is kept; `configureVitest` pins its shard assignment.
			const theirs = customSequencer(
				(userConfig as { test?: { sequence?: { sequencer?: unknown } } }).test
					?.sequence?.sequencer,
			)
			// Merging a list into `inline: true` would yield `[true, ...]`.
			const inlineAll =
				(userConfig as { test?: { server?: { deps?: { inline?: unknown } } } })
					.test?.server?.deps?.inline === true
			return {
				test: {
					experimental: shadowMode
						? { recordDependencies: true }
						: { recordDependencies: true, vcsProvider: provider },
					...(theirs ? {} : { sequence: { sequencer: HashShardSequencer } }),
					...(inlineAll ? {} : { server: { deps: { inline: [PACKAGE] } } }),
				},
			}
		},
		async configureVitest({ vitest, project }) {
			// Vitest loads the root config's provider. A project with its own
			// `root` re-evaluates this config file, so this hook may run from a
			// second plugin instance; configure the provider vitest actually uses.
			const active = configuredProvider(vitest) ?? provider
			active.vitest = vitest
			provider.dependencies = compileDependencies(
				options.dependencies,
				vitest.config.root,
			)
			active.dependencies = provider.dependencies
			// Workers drop what they read outside the repository: the anchor
			// cannot cover it, and vitest's record would otherwise keep every
			// temp file a run touched.
			process.env[ENV_REPO] ??= await repoRoot(vitest.config.root)
			if (!process.env[ENV_RECORD_ROOT]) {
				const root = mkdtempSync(path.join(tmpdir(), 'blacksmith-child-'))
				process.env[ENV_RECORD_ROOT] = root
				process.once('exit', () => {
					try {
						rmSync(root, { recursive: true, force: true })
					} catch {}
				})
			}
			// Their sequencer's shards must not depend on which tests the
			// selection kept, or the provider's view of the shard and vitest's
			// would differ.
			if (customSequencer(vitest.config.sequence.sequencer)) {
				vitest.config.sequence.sequencer = stableShards(
					vitest.config.sequence.sequencer,
				)
			}
			if (shadowMode) {
				if (vitest.config.changed) {
					vitest.logger.warn(
						'[blacksmith] shadow mode runs every test; ignoring --changed',
					)
					vitest.config.changed = false
				}
				shadow ??= new ShadowAnalysis(vitest, active.dependencies)
			} else {
				restored ??= restoreDependencyCache(vitest)
				await restored
			}
			// With `--changed`, vitest measures coverage for the changed files
			// alone, so thresholds would pass on a run that covers nothing.
			const covered = !shadowMode && vitest.config.coverage.enabled
			if (covered && !changedApplied) {
				changedApplied = true
				if (!options.runAllTests) {
					vitest.logger.warn(
						'[blacksmith] selecting changed tests is not supported with coverage, running every test',
					)
				}
				vitest.config.changed = false
				vitest.config.coverage.changed = false
			}
			if (
				!covered &&
				!shadowMode &&
				!options.runAllTests &&
				!vitest.config.changed &&
				!changedApplied
			) {
				changedApplied = true
				if (supportsChanged(vitest)) {
					vitest.config.changed = true
					// An empty selection is the success case here, not a misconfigured run.
					vitest.config.passWithNoTests = true
				} else {
					vitest.logger.warn(
						`[blacksmith] vitest ${vitest.version} cannot select changed tests, running every test; @useblacksmith/vitest needs vitest 5.1.0 or newer`,
					)
				}
			}
			// Coverage follows the selection (vitest's `config.related`) rather
			// than asking the provider again with a `changedSince` it ignores.
			if (!shadowMode && vitest.config.changed && supportsChanged(vitest)) {
				vitest.config.coverage.changed = false
			}
			// Per project, since a project's own `setupFiles` replace the root's;
			// first, so reads by those setup files are recorded too. A browser
			// project has no `node:fs` to wrap.
			if (!project.isBrowserEnabled()) {
				project.config.setupFiles = [
					recordReads,
					...project.config.setupFiles.filter((file) => file !== recordReads),
				]
			}
			const reporters = vitest.config.reporters
			// An older vitest keeps no dependency records to snapshot.
			if (
				supportsVersion(vitest.version) &&
				!reporters.some(isSnapshotRecorder)
			) {
				reporters.push(new SnapshotRecorder(active, { shadow }))
			}
		},
	}
}
