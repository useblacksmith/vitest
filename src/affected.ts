import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import picomatch from 'picomatch'

import { cacheKey, ENV_CACHE_URL, restoreBundle, saveBundle } from './cache.js'

import type {
	Reporter,
	TestModule,
	TestRunEndReason,
	TestSpecification,
	VCSProvider,
	VCSProviderOptions,
	Vitest,
} from 'vitest/node'

import {
	anchorTree,
	diffTrees,
	headSha,
	knownPaths,
	lockfilePaths,
	repoRoot,
	type Tree,
} from './git.js'
import { shardOwner } from './sequencer.js'

export const SNAPSHOT_FILE = 'blacksmith.json'
// Bumped whenever the snapshot's shape changes or the records an anchor
// vouches for gain a kind of dependency, so an older snapshot is not trusted.
const SNAPSHOT_VERSION = 6

/** A `dependencies` entry, compiled: test files matching `tests` depend on files matching `deps`; both root-relative. */
export interface DependencyRule {
	tests: (file: string) => boolean
	deps: (file: string) => boolean
}

export function compileDependencies(
	dependencies:
		Readonly<Record<string, string | readonly string[]>> | undefined,
): DependencyRule[] {
	return Object.entries(dependencies ?? {}).map(([tests, deps]) => ({
		tests: picomatch(tests, { dot: true }),
		deps: picomatch(typeof deps === 'string' ? deps : [...deps], { dot: true }),
	}))
}

/** `file` relative to the config root with `/` separators, the form the `dependencies` globs match. */
function rootRelative(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join('/')
}

/** `file` relative to the repository with `/` separators (git's form, whatever path.sep is); `tree` and `tests` are keyed by it. */
function repoRelative(repo: string, file: string): string {
	return path.relative(repo, file).split(path.sep).join('/')
}

export interface Shard {
	index: number
	count: number
}

/**
 * Written beside vitest's `dependencies.json` after a run that covered every
 * test the shard owns; `tree` anchors every path the dependency records name.
 */
export interface Snapshot {
	version: typeof SNAPSHOT_VERSION
	head: string
	/** Vitest's root relative to the repository, so one package's snapshot never vouches for another's. */
	root: string
	shard: Shard | null
	/** Names of the projects the run covered (`--project` narrows them). */
	projects: string[]
	tree: Tree
	/** Repo-relative test files the run vouches for, sorted: passed, or deselected by our provider as unchanged. A test outside this set (never run, failed, interrupted) reruns whatever its record says. */
	tests: string[]
}

const LOCKFILES = new Set([
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'bun.lock',
	'bun.lockb',
])

function projectNames(vitest: Vitest): string[] {
	return vitest.projects.map((project) => project.name).sort()
}

/**
 * `blacksmith.json`, or `blacksmith.<hash>.json` when `--project` narrowed the
 * run: invocations covering different project sets keep separate anchors.
 */
export function snapshotPath(vitest: Vitest, dir: string): string {
	const filtered = vitest.config.project.length > 0
	const name = filtered
		? SNAPSHOT_FILE.replace(
				'.json',
				`.${createHash('sha1').update(projectNames(vitest).join('\n')).digest('hex').slice(0, 12)}.json`,
			)
		: SNAPSHOT_FILE
	return path.join(dir, name)
}

interface DependencyRecord {
	deps: number[]
	at?: number
}

interface ProjectRecords {
	modules: string[]
	files: Record<string, DependencyRecord>
	/** What the project's config loaded, when vitest recorded it. */
	config?: DependencyRecord
	/** What `globalSetup` loaded, when the project has one. */
	globalSetup?: DependencyRecord
}

interface DependencyRecords {
	version: number
	projects: Record<string, ProjectRecords>
}

/** Vitest's `dependencies.json`, or `null` before the first recorded run. */
async function readRecords(
	vitest: Vitest,
	dir: string,
): Promise<DependencyRecords | null> {
	const file = path.join(dir, 'dependencies.json')
	try {
		return JSON.parse(await readFile(file, 'utf8')) as DependencyRecords
	} catch {
		return null
	}
}

/** Recorded test file → the files it was seen importing, both absolute; empty when vitest has no records yet. */
async function recordedDependencies(
	vitest: Vitest,
	dir: string,
): Promise<Map<string, Set<string>>> {
	const records = await readRecords(vitest, dir)
	if (!records) return new Map()
	const result = new Map<string, Set<string>>()
	for (const project of Object.values(records.projects ?? {})) {
		// Vitest records every project's paths relative to the root config's root.
		const root = vitest.config.root
		for (const [test, record] of Object.entries(project.files)) {
			// A test file two projects share keeps the dependencies of both.
			const file = path.resolve(root, test)
			const deps = result.get(file) ?? new Set<string>()
			for (const index of record.deps) {
				deps.add(path.resolve(root, project.modules[index] ?? ''))
			}
			result.set(file, deps)
		}
	}
	return result
}

/**
 * Repo-relative paths the anchor covers: every module vitest's records name
 * (imports, fs reads, config and globalSetup files), every recorded test
 * file, lockfiles, and every file a `dependencies` rule names (nothing reads
 * those, so the anchor is the only way a change to them is seen).
 */
async function anchoredPaths(
	vitest: Vitest,
	repo: string,
	dir: string,
	rules: readonly DependencyRule[],
): Promise<string[]> {
	const paths = new Set(await lockfilePaths(repo, LOCKFILES))
	if (rules.length > 0) {
		for (const file of await knownPaths(repo)) {
			const fromRoot = rootRelative(vitest.config.root, path.join(repo, file))
			if (rules.some((rule) => rule.deps(fromRoot))) paths.add(file)
		}
	}
	const records = await readRecords(vitest, dir)
	for (const project of Object.values(records?.projects ?? {})) {
		// Vitest records every project's paths relative to the root config's root.
		const root = vitest.config.root
		for (const module of project.modules) {
			paths.add(repoRelative(repo, path.resolve(root, module)))
		}
		for (const test of Object.keys(project.files)) {
			paths.add(repoRelative(repo, path.resolve(root, test)))
		}
	}
	return [...paths]
}

function sameShard(a: Shard | null, b: Shard | undefined): boolean {
	if (a === null) return b === undefined
	return b !== undefined && a.index === b.index && a.count === b.count
}

function describeShard(shard: Shard | null | undefined): string {
	return shard ? `shard ${shard.index}/${shard.count}` : 'unsharded run'
}

function isShard(value: unknown): value is Shard | null {
	if (value === null) return true
	if (typeof value !== 'object') return false
	const { index, count } = value as Record<string, unknown>
	return typeof index === 'number' && typeof count === 'number'
}

function isTree(value: unknown): value is Tree {
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.values(value).every((sha) => typeof sha === 'string')
	)
}

/** `null` for a missing, truncated or otherwise unusable file, which callers treat as "run everything". */
async function readSnapshot(file: string): Promise<Snapshot | null> {
	let parsed: unknown
	try {
		parsed = JSON.parse(await readFile(file, 'utf8'))
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const { version, head, root, shard, projects, tree, tests } =
		parsed as Record<string, unknown>
	if (
		version !== SNAPSHOT_VERSION ||
		typeof head !== 'string' ||
		typeof root !== 'string' ||
		!isShard(shard) ||
		!Array.isArray(projects) ||
		!projects.every((name) => typeof name === 'string') ||
		!isTree(tree) ||
		!Array.isArray(tests) ||
		!tests.every((file) => typeof file === 'string')
	) {
		return null
	}
	return {
		version: SNAPSHOT_VERSION,
		head,
		root,
		shard,
		projects: projects as string[],
		tree,
		tests: tests as string[],
	}
}

/**
 * Decides which files changed since the snapshot was written by diffing the
 * stored anchor against the recorded paths as they are now. Falls back
 * to "everything" whenever the snapshot cannot vouch for this shard.
 */
const PROVIDER_BRAND = Symbol.for('blacksmith.treeSnapshotProvider')

/** True for a `TreeSnapshotProvider` from any copy of this module (a project with its own root re-evaluates the config file, so it gets its own copy). */
export function isTreeSnapshotProvider(
	value: unknown,
): value is TreeSnapshotProvider {
	return typeof value === 'object' && value !== null && PROVIDER_BRAND in value
}

/** The provider vitest loaded: the root config's `experimental.vcsProvider`, when it is ours. */
export function configuredProvider(
	vitest: Vitest,
): TreeSnapshotProvider | null {
	const configured: unknown = vitest.config.experimental.vcsProvider
	return isTreeSnapshotProvider(configured) ? configured : null
}

export class TreeSnapshotProvider implements VCSProvider {
	readonly [PROVIDER_BRAND] = true
	vitest!: Vitest
	/**
	 * Recorded test files none of whose recorded imports changed: the provider
	 * vouches that they need not run, whatever filters the run also applies.
	 */
	deselected = new Set<string>()
	/** The plugin's `dependencies` option, compiled. */
	dependencies: DependencyRule[] = []

	async findChangedFiles(options: VCSProviderOptions): Promise<string[]> {
		this.deselected = new Set()
		const dependencies = await options.resolver.getDependencies()
		const cacheDir = this.vitest.vite.config.cacheDir
		const selected = await this.select(
			options,
			dependencies,
			cacheDir,
			(message) => this.vitest.logger.log(`[blacksmith] ${message}`),
		)
		if (selected === null) {
			// Not a changed run any more: vitest's coverage provider narrows its
			// report to `config.related`, which is about to be every test file,
			// and no source file is a test file.
			this.vitest.config.changed = false
			return dependencies.map((dependency) => dependency.file)
		}
		const changed = new Set(selected)
		for (const [test, deps] of await recordedDependencies(
			this.vitest,
			cacheDir,
		)) {
			if (changed.has(test)) continue
			if ([...deps].some((dep) => changed.has(dep))) continue
			this.deselected.add(test)
		}
		return selected
	}

	/**
	 * Changed files to hand vitest, or `null` when every test of the shard has
	 * to run; `dir` is where the record and anchor live (vitest's `cacheDir`,
	 * or a shadow run's copy of it).
	 */
	async select(
		{ root }: Pick<VCSProviderOptions, 'root'>,
		dependencies: ReadonlyArray<{
			file: string
			recordedAt?: number | undefined
		}>,
		dir: string,
		log: (message: string) => void,
	): Promise<string[] | null> {
		const shard = this.vitest.config.shard

		const snapshot = await readSnapshot(snapshotPath(this.vitest, dir))
		if (!snapshot) {
			log(
				`no dependency snapshot, running every test of the ${describeShard(shard)}`,
			)
			return null
		}
		const repo = await repoRoot(root)
		const here = repoRelative(repo, this.vitest.config.root)
		if (snapshot.root !== here) {
			log(
				`dependency snapshot is for ${snapshot.root || 'the repository root'}, this run is for ${here || 'the repository root'}, running every test of the ${describeShard(shard)}`,
			)
			return null
		}
		if (!sameShard(snapshot.shard, shard)) {
			log(
				`dependency snapshot is for ${describeShard(snapshot.shard)}, running every test of the ${describeShard(shard)}`,
			)
			return null
		}
		const projects = projectNames(this.vitest)
		if (snapshot.projects.join('\n') !== projects.join('\n')) {
			log(
				`dependency snapshot covers projects [${snapshot.projects.join(', ')}], this run covers [${projects.join(', ')}], running every test of the ${describeShard(shard)}`,
			)
			return null
		}

		const tree = await anchorTree(
			repo,
			await anchoredPaths(this.vitest, repo, dir, this.dependencies),
		)
		const changedPaths = diffTrees(snapshot.tree, tree)
		const owns = await shardOwner(this.vitest)
		// Entries without a record are test files vitest has never seen; a test
		// the snapshot does not vouch for has no trustworthy record either,
		// whatever vitest's dependencies.json holds about it.
		const uncovered = new Set(
			dependencies
				.filter(
					(dependency) =>
						dependency.recordedAt === undefined && owns(dependency.file),
				)
				.map((dependency) => dependency.file),
		)
		const vouched = new Set(snapshot.tests)
		for (const specification of await this.vitest.globTestSpecifications()) {
			const file = specification.moduleId
			if (owns(file) && !vouched.has(repoRelative(repo, file))) {
				uncovered.add(file)
			}
		}
		const changed = new Set(uncovered)
		for (const relative of changedPaths) {
			if (LOCKFILES.has(path.basename(relative))) {
				log(
					`${relative} changed, running every test of the ${describeShard(shard)}`,
				)
				return null
			}
			changed.add(path.join(repo, relative))
		}
		const triggered = this.dependencies.filter((rule) =>
			changedPaths.some((relative) =>
				rule.deps(rootRelative(root, path.join(repo, relative))),
			),
		)
		let mapped = 0
		if (triggered.length > 0) {
			for (const dependency of dependencies) {
				if (changed.has(dependency.file)) continue
				if (!owns(dependency.file)) continue
				const fromRoot = rootRelative(root, dependency.file)
				if (triggered.some((rule) => rule.tests(fromRoot))) {
					changed.add(dependency.file)
					mapped++
				}
			}
		}
		log(
			`${changedPaths.length} files changed since ${snapshot.head.slice(0, 12)}, ${uncovered.size} test files not covered by it${mapped > 0 ? `, ${mapped} test files via dependencies` : ''}`,
		)
		return [...changed]
	}
}

function containsOnly(module: TestModule): boolean {
	return (module as { task?: { containsOnly?: boolean } }).task?.containsOnly === true
}

function isPartialSpecification(specification: TestSpecification): boolean {
	return (
		specification.testLines !== undefined ||
		specification.testIds !== undefined ||
		specification.testNames !== undefined ||
		specification.testNamePattern !== undefined ||
		specification.testTagsFilter !== undefined
	)
}

export interface ShadowResult {
	/** Test files (absolute) the affected selection would have run, `'all'` when it would have run everything, `null` when there was nothing to compare against. */
	wouldRun: Set<string> | 'all' | null
	changed: number
	head: string | null
	key: string | null
	/** Why there is nothing to compare, or why everything would have run. */
	reason: string | null
}

/**
 * Shadow mode: fetches the shard's last record and anchor into a temporary
 * directory while the full run executes, and works out what the affected
 * selection would have run, without touching vitest's `cacheDir` or the run.
 */
export class ShadowAnalysis {
	readonly result: Promise<ShadowResult>

	constructor(
		private readonly vitest: Vitest,
		private readonly dependencies: DependencyRule[],
	) {
		this.result = this.run().catch((error) => ({
			wouldRun: null,
			changed: 0,
			head: null,
			key: null,
			reason: error instanceof Error ? error.message : String(error),
		}))
	}

	private async run(): Promise<ShadowResult> {
		const none = (reason: string): ShadowResult => ({
			wouldRun: null,
			changed: 0,
			head: null,
			key: null,
			reason,
		})
		const base = process.env[ENV_CACHE_URL]
		if (!base) return none(`${ENV_CACHE_URL} is not set`)
		const vitest = this.vitest
		const repo = await repoRoot(vitest.config.root)
		const key = cacheKey({
			snapshotVersion: SNAPSHOT_VERSION,
			root: repoRelative(repo, vitest.config.root),
			projects: projectNames(vitest),
			shard: vitest.config.shard ?? null,
			head: process.env.GITHUB_SHA || (await headSha(repo)),
		})
		const dir = await mkdtemp(path.join(tmpdir(), 'blacksmith-shadow-'))
		const outcome = await restoreBundle(base, dir, key)
		if (!outcome.restored) return none(outcome.reason)
		const snapshot = await readSnapshot(snapshotPath(vitest, dir))
		const recorded = await recordedDependencies(vitest, dir)
		const records = await readRecords(vitest, dir)
		const { root } = vitest.config
		const owns = await shardOwner(vitest)
		const specifications = (await vitest.globTestSpecifications()).filter(
			(specification) => owns(specification.moduleId),
		)
		const owned = [
			...new Set(specifications.map((specification) => specification.moduleId)),
		]
		const provider = new TreeSnapshotProvider()
		provider.vitest = vitest
		provider.dependencies = this.dependencies
		let changed = 0
		let lastMessage = ''
		const selected = await provider.select(
			{ root },
			owned.map((file) => ({
				file,
				recordedAt: recorded.has(file) ? 1 : undefined,
			})),
			dir,
			(message) => {
				lastMessage = message
				const match = /^(\d+) files changed/.exec(message)
				if (match) changed = Number(match[1])
			},
		)
		const head = snapshot?.head ?? null
		const all = (reason: string): ShadowResult => ({
			wouldRun: 'all',
			changed,
			head,
			key: outcome.key,
			reason,
		})
		if (selected === null) return all(lastMessage)
		const changedFiles = new Set(selected)
		const dependsOnChange = (files: readonly string[] | undefined) =>
			files?.some((file) => changedFiles.has(file)) ?? false
		// What vitest does with the changed files: `forceRerunTriggers` and the
		// root config rerun everything; a project's config, env files, missing
		// record or globalSetup rerun the project; otherwise a test reruns when
		// it has no record or one of its recorded dependencies changed.
		const triggers = vitest.config.forceRerunTriggers
		if (
			selected.some((file) => picomatch.isMatch(file, triggers, { dot: true }))
		) {
			return all('a changed file matches forceRerunTriggers')
		}
		if (dependsOnChange(vitest.vite.config.configFileDependencies)) {
			return all('a dependency of the config changed')
		}
		const wouldRun = new Set<string>()
		for (const project of vitest.projects) {
			const specs = specifications.filter(
				(specification) => specification.project === project,
			)
			if (specs.length === 0) continue
			const record = records?.projects[project.name]
			// Record paths are relative to the root config's root, whatever the project's.
			const projectRoot = vitest.config.root
			const modules = (indexes: number[] | undefined) =>
				indexes?.map((index) =>
					path.resolve(projectRoot, record?.modules[index] ?? ''),
				)
			if (
				!record ||
				dependsOnChange(project.vite.config.configFileDependencies) ||
				dependsOnChange(envFiles(project)) ||
				(project.config.globalSetup.length > 0 &&
					(!record.globalSetup ||
						dependsOnChange(modules(record.globalSetup.deps))))
			) {
				for (const spec of specs) wouldRun.add(spec.moduleId)
				continue
			}
			for (const spec of specs) {
				const test =
					record.files[
						path.relative(projectRoot, spec.moduleId).split(path.sep).join('/')
					]
				if (
					!test ||
					changedFiles.has(spec.moduleId) ||
					dependsOnChange(modules(test.deps))
				) {
					wouldRun.add(spec.moduleId)
				}
			}
		}
		return { wouldRun, changed, head, key: outcome.key, reason: null }
	}
}

/** The env files vitest reloads a project for, as `getEnvFiles` lists them. */
function envFiles(project: Vitest['projects'][number]): string[] {
	const { envDir, mode } = project.vite.config
	if (typeof envDir !== 'string') return []
	return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].map(
		(file) => path.resolve(envDir, file),
	)
}

/**
 * Writes the snapshot once a passing run has covered every test the shard owns,
 * so the next `--changed` run can trust the dependency records for all of them.
 */
const RECORDER_BRAND = Symbol.for('blacksmith.snapshotRecorder')

/** True for a `SnapshotRecorder` from any copy of this module (a project's config bundles its own). */
export function isSnapshotRecorder(reporter: unknown): boolean {
	return (
		typeof reporter === 'object' &&
		reporter !== null &&
		RECORDER_BRAND in reporter
	)
}

export class SnapshotRecorder implements Reporter {
	readonly [RECORDER_BRAND] = true
	private vitest!: Vitest
	private started = new Set<string>()
	private partial = false

	constructor(
		private readonly provider: TreeSnapshotProvider,
		private readonly options: {
			shadow?: ShadowAnalysis | undefined
		} = {},
	) {}

	/** Shadow mode's verdict for this run, logged once the run has finished. */
	private async reportShadow(
		modules: ReadonlyArray<TestModule>,
	): Promise<void> {
		const shadow = this.options.shadow
		if (!shadow) return
		const log = (message: string) =>
			this.vitest.logger.log(`[blacksmith] shadow: ${message}`)
		const result = await shadow.result
		if (result.wouldRun === null) {
			log(`nothing to compare against (${result.reason ?? 'unknown'})`)
			return
		}
		const ran = this.started
		const would =
			result.wouldRun === 'all'
				? ran
				: new Set([...result.wouldRun].filter((file) => ran.has(file)))
		const since = result.head ? ` since ${result.head.slice(0, 12)}` : ''
		const why =
			result.wouldRun === 'all'
				? `everything: ${result.reason}`
				: `${result.changed} files changed${since}`
		log(
			`would have run ${would.size} of ${ran.size} test files (${why}, from ${result.key ?? 'the cache'})`,
		)
		const failed = modules
			.filter(
				(module) => module.state() === 'failed' || module.errors().length > 0,
			)
			.map((module) => module.moduleId)
		if (failed.length === 0) return
		const outside = failed.filter((file) => !would.has(file))
		if (outside.length === 0) {
			log(`all ${failed.length} failed test files were in the selection`)
			return
		}
		const root = this.vitest.config.root
		log(
			`${outside.length} failed test files outside the selection: ${outside
				.map((file) => path.relative(root, file))
				.join(', ')}`,
		)
	}

	/** The provider vitest is using: the root config's, which may come from another copy of this module. */
	private activeProvider(): { deselected: Set<string> } {
		return configuredProvider(this.vitest) ?? this.provider
	}

	onInit(vitest: Vitest): void {
		this.vitest = vitest
	}

	onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
		this.started = new Set(
			specifications.map((specification) => specification.moduleId),
		)
		this.partial =
			specifications.some(isPartialSpecification) ||
			(this.vitest.config.tagsFilter?.length ?? 0) > 0
	}

	async onTestRunEnd(
		modules: ReadonlyArray<TestModule>,
		errors: ReadonlyArray<unknown>,
		reason: TestRunEndReason,
	): Promise<void> {
		await this.reportShadow(modules)
		// A failed run still vouches for the files that passed; the failed ones
		// are left out and rerun next time. An interrupted run left files unrun,
		// an unhandled error fails the run outside any module (`reason` does not
		// see it), and a `.only` skipped its siblings: none of those vouch.
		if (reason === 'interrupted' || errors.length > 0) return
		if (modules.some((module) => containsOnly(module))) return
		const covered = await this.coveredTests(modules)
		if (covered === null) return
		if (covered.left.length > 0) {
			this.vitest.logger.log(
				`[blacksmith] ${covered.left.length} failed test files left out of the dependency snapshot, they run again next time`,
			)
		}
		const cacheDir = this.vitest.vite.config.cacheDir
		const { root, shard } = this.vitest.config
		const repo = await repoRoot(root)
		const snapshot: Snapshot = {
			version: SNAPSHOT_VERSION,
			head: await headSha(repo),
			root: repoRelative(repo, root),
			shard: shard ?? null,
			projects: projectNames(this.vitest),
			tree: await anchorTree(
				repo,
				await anchoredPaths(
					this.vitest,
					repo,
					cacheDir,
					this.provider.dependencies,
				),
			),
			tests: covered.vouched.map((file) => repoRelative(repo, file)).sort(),
		}
		const file = snapshotPath(this.vitest, cacheDir)
		await mkdir(path.dirname(file), { recursive: true })
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
		await writeFile(tmp, JSON.stringify(snapshot))
		await rename(tmp, file)
		await this.publish(snapshot)
	}

	/** Puts the record and this anchor in the Actions cache when a run can reach it. */
	private async publish(snapshot: Snapshot): Promise<void> {
		const base = process.env[ENV_CACHE_URL]
		if (!base) return
		const key = cacheKey({
			snapshotVersion: snapshot.version,
			root: snapshot.root,
			projects: snapshot.projects,
			shard: snapshot.shard,
			head: snapshot.head,
		})
		try {
			const outcome = await saveBundle(
				base,
				this.vitest.vite.config.cacheDir,
				key,
			)
			this.vitest.logger.log(
				outcome.saved
					? `[blacksmith] saved dependency cache ${key.key} (${outcome.bytes} bytes)`
					: `[blacksmith] dependency cache not saved: ${outcome.reason}`,
			)
		} catch (error) {
			this.vitest.logger.log(
				`[blacksmith] dependency cache not saved: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * The tests this shard owns, split into those the run vouches for (passed,
	 * or deselected by our own provider) and those `left` out (failed, or never
	 * reached); `null` when the run covered less than the shard.
	 */
	private async coveredTests(
		modules: ReadonlyArray<TestModule>,
	): Promise<{ vouched: string[]; left: string[] } | null> {
		if (this.partial || this.vitest.getGlobalTestNamePattern() !== undefined) {
			return null
		}
		const owns = await shardOwner(this.vitest)
		const { deselected } = this.activeProvider()
		const owned = [
			...new Set(
				(await this.vitest.globTestSpecifications())
					.map((specification) => specification.moduleId)
					.filter(owns),
			),
		]
		// Nothing owned (an `include` matching no file) vouches for nothing.
		if (owned.length === 0) return null
		if (!owned.every((file) => this.started.has(file) || deselected.has(file)))
			return null
		// A file may run in several projects; it passed when every one did.
		const passed = new Map<string, boolean>()
		for (const module of modules) {
			const state = module.state()
			const fine =
				(state === 'passed' || state === 'skipped') &&
				module.errors().length === 0
			passed.set(module.moduleId, (passed.get(module.moduleId) ?? true) && fine)
		}
		const vouched: string[] = []
		const left: string[] = []
		for (const file of owned) {
			;(deselected.has(file) || passed.get(file) === true ? vouched : left).push(
				file,
			)
		}
		return { vouched, left }
	}
}

/**
 * Before selection: when the Actions cache is reachable and Vitest's cache
 * directory (`cacheDir`, wherever the config puts it) holds no record yet,
 * pulls the newest record for this shard and project set into it. The
 * directory itself may exist: every `vitest run` on one config shares it
 * (its hash is the root `test.name`, not the `--project` filter).
 */
export async function restoreDependencyCache(vitest: Vitest): Promise<void> {
	const base = process.env[ENV_CACHE_URL]
	if (!base) {
		if (process.env.TURBO_HASH)
			vitest.logger.warn(
				`[blacksmith] running under turbo, which hides ${ENV_CACHE_URL} in strict env mode; add it to passThroughEnv to use the dependency cache`,
			)
		return
	}
	// Only this run's own anchor blocks a restore: every `vitest run` on one config
	// shares `cacheDir`, so another project set's anchor may already be there.
	const anchor = snapshotPath(vitest, vitest.vite.config.cacheDir)
	if (existsSync(anchor)) {
		vitest.logger.warn(
			`[blacksmith] ${path.relative(vitest.config.root, anchor)} already exists, not restoring the dependency cache over it`,
		)
		return
	}
	const repo = await repoRoot(vitest.config.root)
	const key = cacheKey({
		snapshotVersion: SNAPSHOT_VERSION,
		root: repoRelative(repo, vitest.config.root),
		projects: projectNames(vitest),
		shard: vitest.config.shard ?? null,
		head: process.env.GITHUB_SHA || (await headSha(repo)),
	})
	try {
		const outcome = await restoreBundle(base, vitest.vite.config.cacheDir, key)
		vitest.logger.log(
			outcome.restored
				? `[blacksmith] restored dependency cache ${outcome.key}`
				: `[blacksmith] no dependency cache: ${outcome.reason}`,
		)
	} catch (error) {
		vitest.logger.log(
			`[blacksmith] dependency cache not restored: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}
