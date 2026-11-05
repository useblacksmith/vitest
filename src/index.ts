import { fileURLToPath } from 'node:url'

import type { Plugin } from 'vitest/config'
import type { Vitest } from 'vitest/node'

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
import { customSequencer, HashShardSequencer } from './sequencer.js'

export { BlacksmithReporter } from './reporter.js'
export { HashShardSequencer, shardFor } from './sequencer.js'
export {
	ShadowAnalysis,
	type ShadowResult,
	SNAPSHOT_FILE,
	type Snapshot,
} from './affected.js'
export type {
	Payload,
	RunError,
	TestResultRecord,
	TestStatus,
} from './payload.js'

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
	allTests?: boolean
	/** Leave the dependency record out of the Actions cache; it is kept there by default where a step can reach the cache service. */
	disableCache?: boolean
	/**
	 * First segment of the cache key (`<cachePrefix>-v<version>-<projects>-<shard>-<sha>`),
	 * `blacksmith-vitest` by default. Change it to start over from empty entries.
	 */
	cachePrefix?: string
	/**
	 * Run every test and only *report* what the affected selection would have
	 * run: vitest records dependencies but gets no `--changed` and no VCS
	 * provider, the shard's cached record is fetched into a temporary directory
	 * (vitest's `cacheDir` is left alone) and, when the run ends, the plugin
	 * logs how many of the files that ran it would have selected and which
	 * failed files it would have skipped. A green run still saves the record.
	 */
	shadow?: boolean
	/**
	 * Keep selecting tests when `test.sequence.sequencer` is not Blacksmith's
	 * (the config or a later plugin replaced it). By default such a run treats
	 * every test as changed, since the dependency record is only valid for the
	 * shard membership `HashShardSequencer` computes; set this when the custom
	 * sequencer keeps that membership (extends or delegates to it).
	 */
	allowCustomShards?: boolean
	/**
	 * Dependencies the tracking cannot see (files a test reads through a child
	 * process, in `globalSetup`, or outside node): globs of test files mapped
	 * to the glob(s) of the files they depend on, both relative to the config
	 * root. A change to a matching file reruns every test file the key matches.
	 * `{ 'tests/*.spec.ts': 'fixtures/**' }`, say.
	 */
	dependencies?: Record<string, string | string[]>
}

/** Whether this Vitest wired up the pieces `--changed` selection relies on. */
function supportsChanged(vitest: Vitest): boolean {
	const { vcs } = vitest as { vcs?: { findChangedFiles?: unknown } }
	const experimental = vitest.config.experimental as
		| { recordDependencies?: boolean; vcsProvider?: unknown }
		| undefined
	return (
		typeof vcs?.findChangedFiles === 'function' &&
		experimental?.recordDependencies === true &&
		isTreeSnapshotProvider(experimental.vcsProvider)
	)
}

export default function blacksmith(options: BlacksmithOptions = {}): Plugin {
	const provider = new TreeSnapshotProvider()
	provider.dependencies = compileDependencies(options.dependencies)
	let changedApplied = false
	let restored: Promise<void> | undefined
	let shadow: ShadowAnalysis | undefined
	return {
		name: 'blacksmith',
		config(userConfig) {
			// Vite merges this over the user's config, so a sequencer the config
			// names is left in place (and detected in configureVitest) rather than
			// silently replaced.
			const theirs = customSequencer(
				(userConfig as { test?: { sequence?: { sequencer?: unknown } } }).test
					?.sequence?.sequencer,
			)
			return {
				test: {
					experimental: options.shadow
						? { recordDependencies: true }
						: { recordDependencies: true, vcsProvider: provider },
					...(theirs ? {} : { sequence: { sequencer: HashShardSequencer } }),
				},
			}
		},
		async configureVitest({ vitest, project }) {
			// Vitest loads the root config's provider. A project with its own
			// `root` re-evaluates this config file, so this hook may run from a
			// second plugin instance; configure the provider vitest actually uses.
			const active = configuredProvider(vitest) ?? provider
			active.vitest = vitest
			active.dependencies = provider.dependencies
			active.customSequencer = options.allowCustomShards
				? null
				: customSequencer(vitest.config.sequence.sequencer)
			if (options.shadow) {
				if (vitest.config.changed) {
					vitest.logger.warn(
						'[blacksmith] shadow mode runs every test; ignoring --changed',
					)
					vitest.config.changed = false
				}
				shadow ??= new ShadowAnalysis(vitest, {
					cache: !options.disableCache,
					cachePrefix: options.cachePrefix,
					customSequencer: active.customSequencer,
					dependencies: active.dependencies,
				})
			} else {
				restored ??= options.disableCache
					? Promise.resolve()
					: restoreDependencyCache(vitest, options.cachePrefix)
				await restored
			}
			if (
				!options.shadow &&
				!options.allTests &&
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
						'[blacksmith] This vitest version does not support running changed tests with Blacksmith',
					)
				}
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
			if (!reporters.some(isSnapshotRecorder)) {
				reporters.push(
					new SnapshotRecorder(active, {
						cache: !options.disableCache,
						cachePrefix: options.cachePrefix,
						shadow,
					}),
				)
			}
		},
	}
}
