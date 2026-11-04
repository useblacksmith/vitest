import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Setup file the plugin puts first in every worker: each `fs` read lands in
 * the dependency set Vitest keeps for the test file being run, beside its
 * imports, so a fixture, a listed directory or a probed-but-missing file
 * reruns the test when it changes. The wrapped functions stay on the shared
 * `fs` object across the files a worker runs; the set is looked up per call,
 * so a read is charged to whichever file is current.
 */
// Loaded with `require`, not `import`: under `vmThreads`/`vmForks` an import
// would build this context's `node:fs` module namespace now, from the
// functions as they are before wrapping, and a test file's own
// `import { readFileSync } from 'node:fs'` would get that snapshot.
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs')

const BRAND = Symbol.for('blacksmith.recordReads')
const CONTEXT = Symbol.for('blacksmith.recordReads.context')

interface WorkerState {
	dependencies?: Set<string>
}

interface Context {
	__vitest_worker__?: WorkerState
}

// `vmThreads`/`vmForks` evaluate this file once per test context while the
// builtin `fs` object is shared, so the wrappers read the worker state through
// a slot the latest evaluation points at the current context's global.
const shared = fs as unknown as Record<symbol, unknown>
shared[CONTEXT] = globalThis

function toPath(target: unknown): string | null {
	if (typeof target === 'string') return target
	if (Buffer.isBuffer(target)) return target.toString()
	if (target instanceof URL) {
		try {
			return fileURLToPath(target)
		} catch {
			return null
		}
	}
	return null
}

function record(target: unknown): void {
	const dependencies = (shared[CONTEXT] as Context | undefined)
		?.__vitest_worker__?.dependencies
	if (!dependencies) return
	const file = toPath(target)
	if (file === null) return
	const absolute = path.resolve(file)
	if (absolute.split(path.sep).includes('node_modules')) return
	dependencies.add(absolute)
}

/** A recursive copy reads every file below its source. */
function recordTree(target: unknown): void {
	record(target)
	const file = toPath(target)
	if (file === null) return
	let entries: string[]
	try {
		entries = fs.readdirSync(file, { recursive: true, encoding: 'utf8' })
	} catch {
		return
	}
	for (const entry of entries) record(path.join(file, entry))
}

type Wrappable = Record<string, unknown>

function wrap(
	object: Wrappable,
	name: string,
	recorder: (target: unknown) => void = record,
): void {
	const original = object[name]
	if (typeof original !== 'function' || BRAND in original) return
	const wrapped = function (this: unknown, ...args: unknown[]) {
		recorder(args[0])
		return (original as (...args: unknown[]) => unknown).apply(this, args)
	}
	// `realpathSync.native` and friends live on the function.
	Object.assign(wrapped, original)
	wrap(wrapped as unknown as Wrappable, 'native', recorder)
	Object.defineProperty(wrapped, BRAND, { value: true })
	object[name] = wrapped
}

const READS = [
	'access',
	'copyFile',
	'lstat',
	'open',
	'opendir',
	'readdir',
	'readFile',
	'readlink',
	'realpath',
	'stat',
]

for (const name of READS) {
	wrap(fs as unknown as Wrappable, name)
	wrap(fs as unknown as Wrappable, `${name}Sync`)
	wrap(fs.promises as unknown as Wrappable, name)
}
wrap(fs as unknown as Wrappable, 'existsSync')
wrap(fs as unknown as Wrappable, 'createReadStream')
for (const object of [fs, fs.promises]) {
	wrap(object as unknown as Wrappable, 'cp', recordTree)
}
wrap(fs as unknown as Wrappable, 'cpSync', recordTree)

// `import { readFileSync } from 'node:fs'` binds the builtin's ESM namespace,
// which only sees the wrapped functions once the namespace is resynced; the
// vm pools keep their own per-context namespaces and expose their resync.
const required = (
	globalThis as { __vitest_required__?: { syncBuiltinESMExports?: () => void } }
).__vitest_required__
;(required?.syncBuiltinESMExports ?? syncBuiltinESMExports)()
