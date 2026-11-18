import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { FINAL_SUFFIX, workerRecordPath } from './fs-recorder.js'

import type { TestModule, TestProject, Vitest } from 'vitest/node'

/**
 * Vitest 5.1 records what each test file loaded and selects from that record.
 * Vitest 4.1 does neither, so on it the plugin keeps the record itself, in
 * the same shape but a file of its own, and the rest of the plugin
 * (anchor, cache bundle, selection) reads one format on every version.
 */
export const RECORDS_VERSION = 2

/** Vitest 5.1.0 is the first to record dependencies and hand them to a VCS provider. */
export function recordsNatively(version: string): boolean {
	const [major = 0, minor = 0] = version.split('.').map(Number)
	return major > 5 || (major === 5 && minor >= 1)
}

/** Vitest 4.1.1 is the first with a pluggable VCS provider; 4.x from there selects from the plugin's own record. */
export function recordsOwn(version: string): boolean {
	const [major = 0, minor = 0, patch = 0] = version
		.split('.')
		.map((part) => Number.parseInt(part, 10))
	return major === 4 && (minor > 1 || (minor === 1 && patch >= 1))
}

export interface DependencyRecord {
	deps: number[]
	at?: number
}

export interface ProjectRecords {
	modules: string[]
	files: Record<string, DependencyRecord>
	/** What the project's config loaded. */
	config?: DependencyRecord
	/** What `globalSetup` loaded, when the project has one. */
	globalSetup?: DependencyRecord
}

export interface DependencyRecords {
	version: number
	projects: Record<string, ProjectRecords>
}

/** The env files vitest reloads a project for, as `getEnvFiles` lists them. */
export function envFiles(project: Vitest['projects'][number]): string[] {
	const { envDir, mode } = project.vite.config
	if (typeof envDir !== 'string') return []
	return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].map(
		(file) => path.resolve(envDir, file),
	)
}

function rootRelative(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join('/')
}

interface ModuleNode {
	file?: string | null
	imports?: Iterable<string>
}

interface ModuleGraph {
	getModulesByFile(file: string): Iterable<ModuleNode> | undefined
	getModuleById(id: string): ModuleNode | undefined
}

/**
 * The files `globalSetup` loaded, read from the graph of the runner vitest
 * imported it with; null when this run did not load it (a run without tests
 * to run does not), so that what an earlier run recorded is kept.
 */
function globalSetupFiles(project: TestProject): string[] | null {
	const setups = [project.config.globalSetup ?? []].flat()
	if (setups.length === 0) return []
	const files = new Set<string>(setups)
	const graph = (
		project as unknown as { runner?: { evaluatedModules?: ModuleGraph } }
	).runner?.evaluatedModules
	if (!graph) return [...files].filter(isRecordable)
	const queue: ModuleNode[] = setups.flatMap((file) => [
		...(graph.getModulesByFile(file) ?? []),
	])
	if (queue.length === 0) return null
	const seen = new Set<ModuleNode>()
	while (queue.length > 0) {
		const node = queue.pop()
		if (!node || seen.has(node)) continue
		seen.add(node)
		if (node.file) files.add(node.file)
		for (const id of node.imports ?? []) {
			const imported = graph.getModuleById(id)
			if (imported) queue.push(imported)
		}
	}
	return [...files].filter(isRecordable)
}

/**
 * Files Vite's graph links to `files` that their transformed code does not
 * import: what plugins watch for them. Vitest 5.1's record adds the same.
 */
function watchedFiles(project: TestProject, files: string[]): string[] {
	const watched: string[] = []
	for (const file of files) {
		for (const environment of Object.values(project.vite.environments)) {
			const nodes = [...(environment.moduleGraph.getModulesByFile(file) ?? [])]
			const transformed = nodes.filter((node) => node.transformResult)
			if (transformed.length === 0) continue
			for (const node of transformed) {
				const imports = new Set([
					...(node.transformResult?.deps ?? []),
					...(node.transformResult?.dynamicDeps ?? []),
				])
				for (const imported of node.importedModules) {
					if (imported.file && !imports.has(imported.url)) {
						watched.push(imported.file)
					}
				}
			}
			break
		}
	}
	return watched
}

/** The plugin's own record on a Vitest that keeps none, where no Vitest reads it. */
const FINAL_WAIT_MS = 2000

export const OWN_RECORDS_FILE = 'blacksmith-dependencies.json'

/** The dependency record in `dir`: Vitest's `dependencies.json`, or the plugin's own file. */
export function recordsPath(vitest: Vitest, dir: string): string {
	return path.join(
		dir,
		recordsOwn(vitest.version) ? OWN_RECORDS_FILE : 'dependencies.json',
	)
}

/** Installed packages change with the lockfile, which reruns everything. */
function isRecordable(file: string): boolean {
	return path.isAbsolute(file) && !file.includes('node_modules')
}

/** The plugin's own dependency record, for a Vitest that keeps none. */
export class DependencyStore {
	private recorded = new Map<string, Map<string, string[]>>()

	constructor(private readonly vitest: Vitest) {}

	private get file(): string {
		return recordsPath(this.vitest, this.vitest.vite.config.cacheDir)
	}

	/** What the test file `filepath` of `project` loaded this run; the same call Vitest 5.1's record takes. */
	record(project: TestProject, filepath: string, dependencies: string[]): void {
		let files = this.recorded.get(project.name)
		if (!files) this.recorded.set(project.name, (files = new Map()))
		files.set(
			filepath,
			[...dependencies, ...watchedFiles(project, dependencies)].filter(
				isRecordable,
			),
		)
	}

	/** Takes in what the worker that ran `module` left behind. */
	async collect(module: TestModule, recordRoot: string): Promise<void> {
		const file = workerRecordPath(
			recordRoot,
			module.project.name,
			module.moduleId,
		)
		// Vitest stops a worker without waiting for it, so the record may
		// still be the one from before the file's teardown.
		const deadline = Date.now() + FINAL_WAIT_MS
		while (!existsSync(`${file}${FINAL_SUFFIX}`) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		await rm(`${file}${FINAL_SUFFIX}`, { force: true })
		let dependencies: unknown
		try {
			dependencies = JSON.parse(await readFile(file, 'utf8'))
		} catch {
			// The file never got to its hooks: no record, so it runs next time.
			return
		}
		await rm(file, { force: true })
		if (Array.isArray(dependencies)) {
			this.record(module.project, module.moduleId, dependencies as string[])
		}
	}

	private async read(): Promise<DependencyRecords> {
		try {
			const records = JSON.parse(
				await readFile(this.file, 'utf8'),
			) as DependencyRecords
			if (records.version === RECORDS_VERSION && records.projects) return records
		} catch {}
		return { version: RECORDS_VERSION, projects: {} }
	}

	/**
	 * Merges this run's records into the plugin's record. A `partial` run
	 * skipped tests and with them their dynamic imports: it adds to a file's
	 * record and never starts one, so a file without a record keeps running.
	 */
	async update(
		modules: ReadonlyArray<TestModule>,
		partial: (module: TestModule) => boolean,
	): Promise<void> {
		const { root } = this.vitest.config
		const records = await this.read()
		const at = Date.now()
		const indexes = new Map<ProjectRecords, Map<string, number>>()
		const projectRecords = (name: string): ProjectRecords =>
			(records.projects[name] ??= { modules: [], files: {} })
		const intern = (project: ProjectRecords, files: string[]): number[] => {
			let index = indexes.get(project)
			if (!index) {
				index = new Map(project.modules.map((file, i) => [file, i]))
				indexes.set(project, index)
			}
			return [
				...new Set(
					files.map((file) => {
						const relative = rootRelative(root, file)
						let i = index.get(relative)
						if (i === undefined) {
							i = project.modules.push(relative) - 1
							index.set(relative, i)
						}
						return i
					}),
				),
			]
		}
		const projects = new Set(modules.map((module) => module.project))
		projects.add(this.vitest.getRootProject())
		for (const project of projects) {
			const entry = projectRecords(project.name)
			// Env files stay in when absent: one created later is a change.
			const config = [
				...new Set([
					...[
						...(this.vitest.vite.config.configFileDependencies ?? []),
						...(project.vite.config.configFileDependencies ?? []),
					].filter((file) => existsSync(file)),
					...envFiles(project),
				]),
			]
			entry.config = { at, deps: intern(entry, config) }
			const globalSetup = globalSetupFiles(project)
			if (globalSetup && globalSetup.length > 0) {
				entry.globalSetup = { at, deps: intern(entry, globalSetup) }
			}
		}
		for (const module of modules) {
			const files = this.recorded.get(module.project.name)?.get(module.moduleId)
			if (!files) continue
			const entry = projectRecords(module.project.name)
			const test = rootRelative(root, module.moduleId)
			const previous = entry.files[test]
			if (!partial(module)) {
				entry.files[test] = { at, deps: intern(entry, files) }
			} else if (previous) {
				previous.deps = [...new Set([...previous.deps, ...intern(entry, files)])]
			}
		}
		this.recorded.clear()
		await mkdir(path.dirname(this.file), { recursive: true })
		const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
		await writeFile(tmp, JSON.stringify(records))
		await rename(tmp, this.file)
	}
}

const STORES = Symbol.for('blacksmith.vitest.dependencyStores')

/**
 * The store for `vitest`, `null` when Vitest keeps the record itself. Kept on
 * the process, not the module: a project's config bundles its own copy of
 * this file, and every copy has to feed one record.
 */
export function dependencyStore(vitest: Vitest): DependencyStore | null {
	if (!recordsOwn(vitest.version)) return null
	const shared = globalThis as { [STORES]?: WeakMap<Vitest, DependencyStore> }
	const stores = (shared[STORES] ??= new WeakMap())
	let store = stores.get(vitest)
	if (!store) stores.set(vitest, (store = new DependencyStore(vitest)))
	return store
}
