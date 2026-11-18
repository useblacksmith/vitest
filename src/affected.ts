import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import picomatch from 'picomatch'

import { recordBrowserDependencies } from './browser.js'
import { ENV_RECORD_ROOT } from './fs-recorder.js'
import {
	dependencyStore,
	envFiles,
	type DependencyRecord,
	type DependencyRecords,
	recordsPath,
} from './records.js'
import {
	cacheKey,
	ENV_CACHE_URL,
	cacheMode,
	restoreBundle,
	runtimeId,
	saveBundle,
} from './cache.js'

import type {
	Reporter,
	TestModule,
	TestRunEndReason,
	TestSpecification,
	Vitest,
} from 'vitest/node'

import {
	anchorTree,
	blobsAt,
	diffTrees,
	headSha,
	knownPaths,
	lockfilePaths,
	pathsUnder,
	repoRoot,
	type Tree,
} from './git.js'
import { shardOwner } from './sequencer.js'

export const SNAPSHOT_FILE = 'blacksmith.json'
export const UNSUPPORTED_VITEST =
	'[blacksmith] @useblacksmith/vitest selects changed tests on Vitest 4.1.1 or newer 4.x, or 5.1.0 or newer; upgrade vitest, or set `runAllTests: true` and drop --changed'
// Bumped whenever the snapshot's shape changes or the records an anchor
// vouches for gain a kind of dependency, so an older snapshot is not trusted.
const SNAPSHOT_VERSION = 7

/** A `dependencies` entry, compiled: test files matching `tests` depend on files matching `deps`; both root-relative. */
export interface DependencyRule {
	/** The `tests` glob as written, for messages. */
	source: string
	tests: (file: string) => boolean
	deps: (file: string) => boolean
	/** Root-relative directories the `deps` globs start in (`fixtures` for `fixtures/**`), where git-ignored files are looked for; a glob with no fixed start has none. */
	bases: string[]
}

/**
 * A glob written as a path from the root (`../../packages/*\/package.json`
 * from `packages/a`) in the form candidates take, `../*\/package.json`:
 * `path.relative` folds the `..` segments the same way for both.
 */
function normalizeGlob(root: string, glob: string): string {
	if (!/^\.\.?\//.test(glob)) return glob
	return rootRelative(root, path.resolve(root, glob))
}

export function compileDependencies(
	dependencies:
		Readonly<Record<string, string | readonly string[]>> | undefined,
	root: string,
): DependencyRule[] {
	return Object.entries(dependencies ?? {}).map(([tests, deps]) => {
		const globs = (typeof deps === 'string' ? [deps] : [...deps]).map((glob) =>
			normalizeGlob(root, glob),
		)
		return {
			source: tests,
			tests: picomatch(normalizeGlob(root, tests), { dot: true }),
			deps: picomatch(globs, { dot: true }),
			bases: globs
				.map((glob) => picomatch.scan(glob).base)
				.filter((base) => base !== '' && base !== '.'),
		}
	})
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
	/** Node major, platform and arch the run was made on; another one does not share its skips. */
	runtime: string
	head: string
	/** Vitest's root relative to the repository, so one package's snapshot never vouches for another's. */
	root: string
	shard: Shard | null
	/** The workflow file and job the run was part of (see `jobId`), '' outside Actions; another job's `env` and steps differ, so it does not share its skips. */
	job: string
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

/**
 * Package manifests and TypeScript configs on the way up from a recorded
 * file to the repository root: `exports`, `imports`, `type`, `paths` and the
 * like change what a module resolves to without any recorded file changing.
 */
function isManifest(file: string): boolean {
	const base = path.basename(file)
	return base === 'package.json' || /^tsconfig(\..+)?\.json$/.test(base)
}

/**
 * The workflow file running this job, when it lives in this repository. Its
 * `matrix`, `env` and steps shape every test, so a change to it runs them all.
 */
function workflowPath(): string | null {
	const ref = process.env.GITHUB_WORKFLOW_REF
	const repository = process.env.GITHUB_REPOSITORY
	if (!ref || !repository || !ref.startsWith(`${repository}/`)) return null
	const file = ref.slice(repository.length + 1).split('@')[0] ?? ''
	return file.startsWith('.github/workflows/') ? file : null
}

/**
 * The workflow file and job this run is part of, `.github/workflows/ci.yml#test`;
 * '' outside Actions. Two jobs run the same tests under different `env` and
 * steps, so neither trusts the other's snapshot or restores its cache entry.
 */
export function jobId(): string {
	const workflow = workflowPath()
	const job = process.env.GITHUB_JOB
	return workflow || job ? `${workflow ?? ''}#${job ?? ''}` : ''
}

/** `dir` and every parent up to the repository root, repo-relative ('' for the root). */
function ancestors(dir: string): string[] {
	const result: string[] = []
	for (let current = dir; ; ) {
		if (current === '.' || current === '') {
			result.push('')
			return result
		}
		result.push(current)
		const parent = path.dirname(current)
		if (parent === current) return result
		current = parent
	}
}

function repoDir(file: string): string {
	const dir = path.dirname(file)
	return dir === '.' ? '' : dir
}

function projectNames(vitest: Vitest): string[] {
	return vitest.projects.map((project) => project.name).sort()
}

/**
 * `blacksmith.json`, or `blacksmith[.<hash>][.<i>of<n>].json` when `--project`
 * narrowed the run or `--shard` split it: invocations covering different
 * project sets or shards keep separate anchors, as their cache keys do.
 */
export function snapshotPath(vitest: Vitest, dir: string): string {
	const parts = [SNAPSHOT_FILE.replace('.json', '')]
	if (vitest.config.project.length > 0) {
		parts.push(
			createHash('sha1')
				.update(projectNames(vitest).join('\n'))
				.digest('hex')
				.slice(0, 12),
		)
	}
	const { shard } = vitest.config
	if (shard) parts.push(`${shard.index}of${shard.count}`)
	return path.join(dir, `${parts.join('.')}.json`)
}

/** The dependency record (vitest's, or the plugin's own on a vitest that keeps none), or `null` before the first recorded run. */
async function readRecords(
	vitest: Vitest,
	dir: string,
): Promise<DependencyRecords | null> {
	const file = recordsPath(vitest, dir)
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
	const paths = new Set<string>()
	const workflow = workflowPath()
	if (workflow) paths.add(workflow)
	const records = await readRecords(vitest, dir)
	const dirs = new Set<string>()
	for (const project of Object.values(records?.projects ?? {})) {
		// Vitest records every project's paths relative to the root config's root.
		const root = vitest.config.root
		for (const file of [...project.modules, ...Object.keys(project.files)]) {
			const relative = repoRelative(repo, path.resolve(root, file))
			paths.add(relative)
			// Outside the repository (`..`, or another drive on Windows): no manifest above it is ours.
			if (relative.startsWith('..') || path.isAbsolute(relative)) continue
			for (const dir of ancestors(repoDir(relative))) dirs.add(dir)
		}
	}
	// A lockfile pins what the tests below it resolve; a vendored repo's or a
	// fixture's lockfile pins nothing a test loads.
	for (const file of await lockfilePaths(repo, LOCKFILES)) {
		if (dirs.has(repoDir(file))) paths.add(file)
	}
	const matched = rules.map(() => 0)
	// Git-ignored files (generated code, downloaded fixtures) a rule names are
	// looked up under the directories its globs start in, never repo-wide.
	const bases = new Set<string>()
	for (const rule of rules) {
		for (const base of rule.bases) {
			const relative = repoRelative(repo, path.resolve(vitest.config.root, base))
			if (
				relative !== '' &&
				!relative.startsWith('..') &&
				!path.isAbsolute(relative)
			) {
				bases.add(relative)
			}
		}
	}
	const candidates = await knownPaths(repo)
	for (const file of await pathsUnder(repo, [...bases])) {
		if (!file.split('/').includes('node_modules')) candidates.add(file)
	}
	for (const file of candidates) {
		const fromRoot = rootRelative(vitest.config.root, path.join(repo, file))
		let byRule = false
		rules.forEach((rule, index) => {
			if (!rule.deps(fromRoot)) return
			matched[index] = (matched[index] ?? 0) + 1
			byRule = true
		})
		if (byRule) paths.add(file)
		else if (isManifest(file) && dirs.has(repoDir(file))) paths.add(file)
	}
	rules.forEach((rule, index) => {
		if (matched[index] === 0) {
			vitest.logger.warn(
				`[blacksmith] dependencies["${rule.source}"] matches no file in the repository; globs are relative to ${vitest.config.root}`,
			)
		}
	})
	return [...paths]
}

/**
 * Rewrites the dependency record without the modules outside the
 * repository (the anchor cannot cover them) and without tests that no longer
 * exist, renumbering what the remaining records point to. Vitest only ever
 * appends, so a record otherwise grows by every temp file a run touched.
 */
async function pruneRecords(
	vitest: Vitest,
	repo: string,
	dir: string,
): Promise<void> {
	const records = await readRecords(vitest, dir)
	if (!records) return
	const root = vitest.config.root
	for (const project of Object.values(records.projects ?? {})) {
		const keep = new Map<number, number>()
		const modules: string[] = []
		const renumber = (record: DependencyRecord): void => {
			record.deps = [
				...new Set(
					record.deps.flatMap((index) => {
						const module = project.modules[index]
						if (module === undefined) return []
						const absolute = path.resolve(root, module)
						if (
							repoRelative(repo, absolute).startsWith('..') ||
							path.isAbsolute(repoRelative(repo, absolute))
						) {
							return []
						}
						let next = keep.get(index)
						if (next === undefined) {
							next = modules.push(module) - 1
							keep.set(index, next)
						}
						return [next]
					}),
				),
			]
		}
		for (const [test, record] of Object.entries(project.files)) {
			if (!existsSync(path.resolve(root, test))) {
				delete project.files[test]
				continue
			}
			renumber(record)
		}
		if (project.config) renumber(project.config)
		if (project.globalSetup) renumber(project.globalSetup)
		project.modules = modules
	}
	const file = recordsPath(vitest, dir)
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmp, JSON.stringify(records))
	await rename(tmp, file)
}

/**
 * Vitest reruns a recorded test only when a file in its record changed. A
 * test that never loaded (a syntax error in it or in a setup file) has a
 * record that may name nothing, not even the test itself, so handing vitest
 * the test as changed runs nothing. Without a record vitest always runs it.
 */
async function dropUnloadedRecords(
	vitest: Vitest,
	dir: string,
	changed: ReadonlySet<string>,
): Promise<void> {
	const records = await readRecords(vitest, dir)
	if (!records) return
	const root = vitest.config.root
	let dropped = false
	for (const project of Object.values(records.projects ?? {})) {
		for (const [test, record] of Object.entries(project.files)) {
			if (!changed.has(path.resolve(root, test))) continue
			const reruns = record.deps.some((index) =>
				changed.has(path.resolve(root, project.modules[index] ?? '')),
			)
			if (reruns) continue
			delete project.files[test]
			dropped = true
		}
	}
	if (!dropped) return
	const file = recordsPath(vitest, dir)
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmp, JSON.stringify(records))
	await rename(tmp, file)
}

/** Whether the run is already set to exit non-zero. */
function failing(): boolean {
	return process.exitCode !== undefined && process.exitCode !== 0
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
	const { version, runtime, head, root, shard, job, projects, tree, tests } =
		parsed as Record<string, unknown>
	if (
		version !== SNAPSHOT_VERSION ||
		typeof runtime !== 'string' ||
		typeof head !== 'string' ||
		typeof root !== 'string' ||
		!isShard(shard) ||
		typeof job !== 'string' ||
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
		runtime,
		head,
		root,
		shard,
		job,
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

/** Vitest's `VCSProviderOptions`; only 5.1 and newer pass a `resolver`, and 4.1 does not export the type. */
interface VCSProviderOptions {
	root: string
	changedSince?: string | boolean
	resolver?: {
		getDependencies(): Promise<
			Array<{ file: string; recordedAt?: number | undefined }>
		>
	}
}

export class TreeSnapshotProvider {
	readonly [PROVIDER_BRAND] = true
	vitest!: Vitest
	/**
	 * Recorded test files none of whose recorded imports changed: the provider
	 * vouches that they need not run, whatever filters the run also applies.
	 */
	deselected = new Set<string>()
	/** The plugin's `dependencies` option, compiled. */
	dependencies: DependencyRule[] = []

	/**
	 * Paths whose content differs from the snapshot's. A path the snapshot did
	 * not anchor (a later run recorded it, or a file it imported was recorded
	 * after another shard's run) is a change only if it was not tracked with
	 * the same blob at the snapshot's commit.
	 */
	private async changedSince(
		repo: string,
		snapshot: Snapshot,
		tree: Tree,
	): Promise<string[]> {
		const changed = diffTrees(snapshot.tree, tree)
		const fresh = changed.filter(
			(file) => !Object.hasOwn(snapshot.tree, file) && Object.hasOwn(tree, file),
		)
		if (fresh.length === 0) return changed
		const blobs = await blobsAt(repo, snapshot.head, fresh)
		if (!blobs) return changed
		return changed.filter((file) => {
			const entry = tree[file]
			const sha = entry?.split(' ')[1]
			return !(blobs.has(file) && blobs.get(file) === sha)
		})
	}

	async findChangedFiles(options: VCSProviderOptions): Promise<string[]> {
		this.deselected = new Set()
		const cacheDir = this.vitest.vite.config.cacheDir
		// Vitest 5.1 hands over its record and selects from the changed files
		// itself; on an older one both are the plugin's.
		const own = dependencyStore(this.vitest) !== null
		if (!own && !options.resolver) throw new Error(UNSUPPORTED_VITEST)
		const specifications = own
			? await this.vitest.globTestSpecifications()
			: []
		const dependencies = options.resolver
			? await options.resolver.getDependencies()
			: await ownDependencies(this.vitest, cacheDir, specifications)
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
		await dropUnloadedRecords(this.vitest, cacheDir, changed)
		for (const [test, deps] of await recordedDependencies(
			this.vitest,
			cacheDir,
		)) {
			if (changed.has(test)) continue
			if ([...deps].some((dep) => changed.has(dep))) continue
			this.deselected.add(test)
		}
		if (own) {
			const affected = await affectedTests(
				this.vitest,
				selected,
				await readRecords(this.vitest, cacheDir),
				specifications,
			)
			// Vitest 4.1 runs a test file named among the changed files.
			if (affected.wouldRun !== 'all') return [...affected.wouldRun]
			this.vitest.logger.log(
				`[blacksmith] ${affected.reason}, running every test`,
			)
			this.vitest.config.changed = false
			return specifications.map((specification) => specification.moduleId)
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
		if (snapshot.job !== jobId()) {
			log(
				`dependency snapshot was made by ${snapshot.job || 'a run outside Actions'}, this is ${jobId() || 'a run outside Actions'}, running every test of the ${describeShard(shard)}`,
			)
			return null
		}
		if (snapshot.runtime !== runtimeId()) {
			log(
				`dependency snapshot was made on ${snapshot.runtime}, this is ${runtimeId()}, running every test of the ${describeShard(shard)}`,
			)
			return null
		}

		const tree = await anchorTree(
			repo,
			await anchoredPaths(this.vitest, repo, dir, this.dependencies),
		)
		const changedPaths = await this.changedSince(repo, snapshot, tree)
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
		const workflow = workflowPath()
		const manifestDirs: string[] = []
		for (const relative of changedPaths) {
			if (LOCKFILES.has(path.basename(relative)) || relative === workflow) {
				log(
					`${relative} changed, running every test of the ${describeShard(shard)}`,
				)
				return null
			}
			if (isManifest(relative)) manifestDirs.push(repoDir(relative))
			changed.add(path.join(repo, relative))
		}
		// A manifest changes resolution for everything below it: every test
		// with a recorded file under its directory runs.
		let viaManifest = 0
		if (manifestDirs.length > 0) {
			const under = (file: string): boolean => {
				const relative = repoRelative(repo, file)
				return (
					!relative.startsWith('..') &&
					manifestDirs.some(
						(manifestDir) =>
							manifestDir === '' || relative.startsWith(`${manifestDir}/`),
					)
				)
			}
			for (const [test, deps] of await recordedDependencies(this.vitest, dir)) {
				if (changed.has(test) || !owns(test)) continue
				if (under(test) || [...deps].some(under)) {
					changed.add(test)
					viaManifest++
				}
			}
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
			`${changedPaths.length} files changed since ${snapshot.head.slice(0, 12)}, ${uncovered.size} test files not covered by it${viaManifest > 0 ? `, ${viaManifest} test files under a changed manifest` : ''}${mapped > 0 ? `, ${mapped} test files via dependencies` : ''}`,
		)
		return [...changed]
	}
}

/** Test file → when it was recorded, as Vitest 5.1's resolver lists them; no time for a file without a record. */
async function ownDependencies(
	vitest: Vitest,
	dir: string,
	specifications: ReadonlyArray<TestSpecification>,
): Promise<Array<{ file: string; recordedAt?: number | undefined }>> {
	const records = await readRecords(vitest, dir)
	const { root } = vitest.config
	const recordedAt = new Map<string, number | undefined>()
	for (const specification of specifications) {
		const record =
			records?.projects[specification.project.name]?.files[
				path.relative(root, specification.moduleId).split(path.sep).join('/')
			]
		const file = specification.moduleId
		const previous = recordedAt.get(file)
		if (!record) recordedAt.set(file, undefined)
		else if (!recordedAt.has(file)) recordedAt.set(file, record.at ?? 0)
		else if (previous !== undefined) {
			recordedAt.set(file, Math.min(previous, record.at ?? 0))
		}
	}
	return Array.from(recordedAt, ([file, at]) => ({ file, recordedAt: at }))
}

/**
 * The test files Vitest 5.1 runs for the changed files `selected`: shadow
 * mode's prediction there, and the selection itself on a vitest that has none.
 */
async function affectedTests(
	vitest: Vitest,
	selected: readonly string[],
	records: DependencyRecords | null,
	specifications: ReadonlyArray<TestSpecification>,
): Promise<
	{ wouldRun: Set<string>; reason: null } | { wouldRun: 'all'; reason: string }
> {
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
		return { wouldRun: 'all', reason: 'a changed file matches forceRerunTriggers' }
	}
	if (dependsOnChange(vitest.vite.config.configFileDependencies)) {
		return { wouldRun: 'all', reason: 'a dependency of the config changed' }
	}
	// The root's globalSetup runs for every project, and is recorded under
	// the root project even when that one has no tests of its own.
	const rootProject = vitest.getRootProject()
	if (
		dependencyStore(vitest) &&
		!vitest.projects.includes(rootProject) &&
		rootProject.config.globalSetup.length > 0
	) {
		const record = records?.projects[rootProject.name]
		const setup = record?.globalSetup?.deps.map((index) =>
			path.resolve(vitest.config.root, record.modules[index] ?? ''),
		)
		if (!setup || dependsOnChange(setup)) {
			return { wouldRun: 'all', reason: 'a dependency of globalSetup changed' }
		}
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
	return { wouldRun, reason: null }
}

function containsOnly(module: TestModule): boolean {
	return (module as { task?: { containsOnly?: boolean } }).task?.containsOnly === true
}

function isPartialSpecification(specification: TestSpecification): boolean {
	// Not every filter exists on every supported vitest.
	const filters = specification as unknown as Record<string, unknown>
	return (
		filters.testLines !== undefined ||
		filters.testIds !== undefined ||
		filters.testNames !== undefined ||
		filters.testNamePattern !== undefined ||
		filters.testTagsFilter !== undefined
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
			runtime: runtimeId(),
			root: repoRelative(repo, vitest.config.root),
			job: jobId(),
			projects: projectNames(vitest),
			shard: vitest.config.shard ?? null,
			head: process.env.GITHUB_SHA || (await headSha(repo)),
		})
		const dir = await mkdtemp(path.join(tmpdir(), 'blacksmith-shadow-'))
		const outcome = await restoreBundle(
			base,
			dir,
			key,
			path.basename(recordsPath(vitest, dir)),
		)
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
		const affected = await affectedTests(
			vitest,
			selected,
			records,
			specifications,
		)
		if (affected.wouldRun === 'all') return all(affected.reason)
		const { wouldRun } = affected
		return { wouldRun, changed, head, key: outcome.key, reason: null }
	}
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
	/** Tests a run vouches for once its coverage thresholds have passed. */
	private pending: string[] | null = null
	/** Worker records being read into the plugin's own store. */
	private ended: TestModule[] = []

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

	/** How many of the shard's test files the selection left out, logged once the run has finished. */
	private async reportFiltered(): Promise<void> {
		if (this.options.shadow) return
		const owns = await shardOwner(this.vitest)
		const { deselected } = this.activeProvider()
		// Vitest reports every shard's specifications as started, and the
		// record holds tests of other project sets and deleted files.
		const owned = new Set(
			(await this.vitest.globTestSpecifications())
				.map((specification) => specification.moduleId)
				.filter(owns),
		)
		let ran = 0
		let filtered = 0
		for (const file of owned) {
			if (this.started.has(file)) ran++
			else if (deselected.has(file)) filtered++
		}
		this.vitest.logger.log(
			`[blacksmith] filtered out ${filtered} of ${ran + filtered} test files as unaffected, ran ${ran}`,
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

	async onTestModuleEnd(module: TestModule): Promise<void> {
		recordBrowserDependencies(this.vitest, module)
		const store = dependencyStore(this.vitest)
		const root = process.env[ENV_RECORD_ROOT]
		if (store && root && !module.project.isBrowserEnabled()) {
			this.ended.push(module)
		}
	}

	async onTestRunEnd(
		modules: ReadonlyArray<TestModule>,
		errors: ReadonlyArray<unknown>,
		reason: TestRunEndReason,
	): Promise<void> {
		await this.reportShadow(modules)
		const store = dependencyStore(this.vitest)
		if (store) {
			// At the end of the run, not of the module: a worker finishes a
			// file's record when it starts its next file or exits.
			const root = process.env[ENV_RECORD_ROOT]
			if (root) {
				await Promise.all(
					this.ended.splice(0).map((module) => store.collect(module, root)),
				)
			}
			const namePattern = this.vitest.getGlobalTestNamePattern() !== undefined
			const cut = this.partial || namePattern || reason === 'interrupted'
			await store.update(modules, (module) => cut || containsOnly(module))
		}
		await this.reportFiltered()
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
		// Vitest checks coverage thresholds after this hook and fails the run
		// through the exit code alone; the snapshot waits for that verdict. A run
		// already failing hides it, and writes now so its failed tests rerun.
		if (this.checksThresholds(modules) && !failing()) {
			this.pending = covered.vouched
			return
		}
		await this.write(covered.vouched)
	}

	/** Whether vitest is about to report coverage and check `coverage.thresholds`. */
	private checksThresholds(modules: ReadonlyArray<TestModule>): boolean {
		const coverage = this.vitest.config.coverage
		if (!coverage.enabled || !coverage.thresholds) return false
		return (
			coverage.reportOnFailure === true ||
			modules.every((module) => module.ok())
		)
	}

	/** Called by vitest once coverage is reported and its thresholds checked. */
	async onFinishedReportCoverage(): Promise<void> {
		const vouched = this.pending
		this.pending = null
		if (vouched === null) return
		if (failing()) {
			// An empty snapshot, not none: a fresh checkout would otherwise
			// restore an older one that vouches for these tests.
			this.vitest.logger.log(
				'[blacksmith] coverage thresholds failed, the dependency snapshot vouches for no test and the next run runs them all',
			)
			await this.write([])
			return
		}
		await this.write(vouched)
	}

	private async write(vouched: readonly string[]): Promise<void> {
		const cacheDir = this.vitest.vite.config.cacheDir
		const { root, shard } = this.vitest.config
		const repo = await repoRoot(root)
		await pruneRecords(this.vitest, repo, cacheDir)
		const snapshot: Snapshot = {
			version: SNAPSHOT_VERSION,
			runtime: runtimeId(),
			head: await headSha(repo),
			root: repoRelative(repo, root),
			shard: shard ?? null,
			job: jobId(),
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
			tests: vouched.map((file) => repoRelative(repo, file)).sort(),
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
			runtime: snapshot.runtime,
			root: snapshot.root,
			job: snapshot.job,
			projects: snapshot.projects,
			shard: snapshot.shard,
			head: snapshot.head,
		})
		try {
			const outcome = await saveBundle(
				base,
				this.vitest.vite.config.cacheDir,
				key,
				path.basename(
					recordsPath(this.vitest, this.vitest.vite.config.cacheDir),
				),
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
		// Vitest reruns a deselected file when its config or globalSetup changed;
		// one that ran is judged by its result, deselection vouches only for
		// files that did not run.
		for (const file of owned) {
			const fine = this.started.has(file)
				? passed.get(file) === true
				: deselected.has(file)
			;(fine ? vouched : left).push(file)
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
		runtime: runtimeId(),
		root: repoRelative(repo, vitest.config.root),
		job: jobId(),
		projects: projectNames(vitest),
		shard: vitest.config.shard ?? null,
		head: process.env.GITHUB_SHA || (await headSha(repo)),
	})
	if (!cacheMode().readable) {
		vitest.logger.log(
			'[blacksmith] no dependency cache: the Actions cache is not readable for this job',
		)
		return
	}
	try {
		const outcome = await restoreBundle(
			base,
			vitest.vite.config.cacheDir,
			key,
			path.basename(recordsPath(vitest, vitest.vite.config.cacheDir)),
		)
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
