import type { TestModule, TestProject, Vitest } from 'vitest/node'

/** The internal record the node worker's `onTestModuleDependencies` RPC feeds. */
interface DependenciesCache {
	record(project: TestProject, filepath: string, dependencies: string[]): void
}

function dependenciesCache(vitest: Vitest): DependenciesCache | null {
	const cache = (
		vitest as unknown as { cache?: { _dependencies?: Partial<DependenciesCache> } }
	).cache
	const record = cache?._dependencies?.record
	return typeof record === 'function'
		? { record: record.bind(cache?._dependencies) }
		: null
}

const warned = new WeakSet<Vitest>()

/**
 * Vitest's browser tester never reports what a test file imported, so
 * `dependencies.json` holds no record for a browser test and `--changed` runs
 * it every time. The project's Vite client environment transformed every
 * module the browser loaded; walking its graph from the test file and the
 * setup files gives the same set the node worker reports, recorded through
 * the same call its RPC makes. Virtual modules (`/@vitest/...`, `\0...`) have
 * no file and are left out; vitest drops `node_modules` paths itself.
 */
export function recordBrowserDependencies(
	vitest: Vitest,
	module: TestModule,
): void {
	const project = module.project
	if (!project.isBrowserEnabled()) return
	const cache = dependenciesCache(vitest)
	if (!cache) {
		if (!warned.has(vitest)) {
			warned.add(vitest)
			vitest.logger.warn(
				'[blacksmith] this vitest does not expose its dependency record; browser tests run on every --changed',
			)
		}
		return
	}
	const graph = project.vite.environments.client?.moduleGraph
	if (!graph) return
	const roots = [...(graph.getModulesByFile(module.moduleId) ?? [])]
	// A test the browser never fetched through this graph has no record to
	// give; an empty one would let `--changed` skip it on every edit.
	if (roots.length === 0) return
	const files = new Set<string>([module.moduleId])
	const seen = new Set<string>()
	const queue = [
		...roots,
		...project.config.setupFiles.flatMap((file) => [
			...(graph.getModulesByFile(file) ?? []),
		]),
	]
	while (queue.length > 0) {
		const node = queue.pop()
		if (!node?.id || seen.has(node.id)) continue
		seen.add(node.id)
		if (node.file) files.add(node.file)
		for (const imported of node.importedModules) queue.push(imported)
	}
	cache.record(project, module.moduleId, [...files])
}
