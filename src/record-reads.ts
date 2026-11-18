import { createRequire, isBuiltin, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterAll } from 'vitest'

import {
	BRAND,
	CHILD_RECORD_ENV,
	ENV_OWN_RECORDS,
	FINAL_SUFFIX,
	ENV_RECORD_ROOT,
	Outputs,
	WRITE_PREFIX,
	copyProperties,
	isIgnored,
	workerRecordPath,
	wrapFs,
} from './fs-recorder.ts'

/**
 * Runs as the first setup file of every test file. Vitest records what a
 * test imports; this records the files it reads through `node:fs` and the
 * node processes and worker threads it starts (their modules and reads, via
 * `record-child`), adding each to the dependency set vitest keeps per test
 * file. A file the test wrote before reading it is its output and stays out.
 *
 * The functions on the builtin are replaced, so every specifier that reaches
 * them (`fs`, `node:fs`, `fs/promises`, `require`) is covered.
 */
const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const childProcess =
	require('node:child_process') as typeof import('node:child_process')
const workerThreads =
	require('node:worker_threads') as typeof import('node:worker_threads')

const CONTEXT = Symbol.for('blacksmith.recordReads.context')

interface EvaluatedModule {
	file?: string
	imports?: Iterable<string>
}

interface WorkerState {
	dependencies?: Set<string>
	/** The test file being run. */
	filepath?: string
	config?: { name?: string; setupFiles?: string[] }
	evaluatedModules?: {
		getModulesByFile(file: string): Iterable<EvaluatedModule> | undefined
		getModuleById(id: string): EvaluatedModule | undefined
	}
}

interface Context {
	__vitest_worker__?: WorkerState
}

// The `vm` pools load this file in one context and run tests in another; the
// builtin is shared, so it carries the context that holds the worker state.
const shared = fs as unknown as Record<symbol, unknown>
shared[CONTEXT] = globalThis

const ORIGINALS = Symbol.for('blacksmith.recordReads.originals')

type Originals = Pick<
	typeof fs,
	| 'existsSync'
	| 'mkdirSync'
	| 'mkdtempSync'
	| 'readdirSync'
	| 'readFileSync'
	| 'rmSync'
	| 'statSync'
	| 'writeFileSync'
>

// Unwrapped, so this module's own file handling records nothing; kept on the
// builtin because a later evaluation in the same process finds `fs` wrapped.
const {
	existsSync: exists,
	mkdirSync: mkdir,
	mkdtempSync: mkdtemp,
	readdirSync: readdir,
	readFileSync: read,
	rmSync: rm,
	statSync: stat,
	writeFileSync: write,
} = ((shared[ORIGINALS] as Originals | undefined) ??= {
	existsSync: fs.existsSync,
	mkdirSync: fs.mkdirSync,
	mkdtempSync: fs.mkdtempSync,
	readdirSync: fs.readdirSync,
	readFileSync: fs.readFileSync,
	rmSync: fs.rmSync,
	statSync: fs.statSync,
	writeFileSync: fs.writeFileSync,
})

function workerState(): WorkerState | undefined {
	return (shared[CONTEXT] as Context | undefined)?.__vitest_worker__
}

function dependencies(): Set<string> | undefined {
	return workerState()?.dependencies
}

const OUTPUTS = Symbol.for('blacksmith.recordReads.outputs')

// On the shared builtin, like the context: the wrapped `fs` keeps the first
// evaluation's closures under the `vm` pools.
/** What the running test file wrote; a worker runs its files one after another on one dependency set. */
function outputs(): Outputs {
	const test = workerState()?.filepath
	let current = shared[OUTPUTS] as
		| { test: string | undefined; outputs: Outputs }
		| undefined
	if (!current || current.test !== test) {
		current = { test, outputs: new Outputs() }
		shared[OUTPUTS] = current
	}
	return current.outputs
}

function record(file: string, cwd = process.cwd(), content = true): void {
	const set = dependencies()
	if (!set) return
	const absolute = path.resolve(cwd, file)
	if (isIgnored(absolute)) return
	if (outputs().reads(absolute, content)) set.add(absolute)
}

/** `since`: see `Outputs.writes`. */
function wrote(file: string, cwd = process.cwd(), since?: number): void {
	const set = dependencies()
	if (!set) return
	const absolute = path.resolve(cwd, file)
	if (isIgnored(absolute)) return
	if (outputs().writes(absolute, since)) set.delete(absolute)
}

wrapFs(
	fs,
	(file, content) => record(file, undefined, content),
	(file) => wrote(file),
)

/** Beside this module; `.ts` when the plugin runs from source (its own test fixtures). */
const recordChild = fileURLToPath(
	new URL(
		import.meta.url.endsWith('.ts') ? './record-child.ts' : './record-child.js',
		import.meta.url,
	),
)

const RECORD_DIRS = Symbol.for('blacksmith.recordReads.recordDirs')

interface RecordDirs {
	root: string
	byTest: Map<string, string>
}

/**
 * The directory the children of the running test file report to, each in a
 * file of its own. One per test file, not per child: a test comparing the
 * environments of two children it started must find them equal.
 */
function recordDir(): string {
	let dirs = shared[RECORD_DIRS] as RecordDirs | undefined
	if (!dirs) {
		// The main process makes and removes the root: vitest may end a
		// worker with no `exit` event, and a child can outlive the hooks here.
		const given = process.env[ENV_RECORD_ROOT]
		const root = given ?? mkdtemp(path.join(os.tmpdir(), 'blacksmith-child-'))
		dirs = shared[RECORD_DIRS] = { root, byTest: new Map() }
		if (!given) {
			process.once('exit', () => {
				try {
					rm(root, { recursive: true, force: true })
				} catch {}
			})
		}
	}
	const test = workerState()?.filepath ?? ''
	let dir = dirs.byTest.get(test)
	if (!dir) {
		dir = mkdtemp(path.join(dirs.root, 't-'))
		dirs.byTest.set(test, dir)
	}
	return dir
}

type Env = Record<string, string | undefined>

/**
 * `given` (the call's `env`, or the parent's when it had none) with the
 * recorder preloaded and a directory to report to; `null` when the caller asked
 * for a child free of node options with `env: { ...process.env, NODE_OPTIONS:
 * undefined }`, which is left alone.
 */
function recordedEnv(
	given: Env | undefined,
): { env: Env; file: string } | null {
	const cleared =
		given !== undefined &&
		Object.prototype.hasOwnProperty.call(given, 'NODE_OPTIONS') &&
		given.NODE_OPTIONS === undefined
	if (cleared) return null
	const env: Env = { ...(given ?? process.env) }
	const file = recordDir()
	env[CHILD_RECORD_ENV] = file
	env.NODE_OPTIONS = [
		env.NODE_OPTIONS,
		`--import ${pathToFileURL(recordChild).href}`,
	]
		.filter(Boolean)
		.join(' ')
	return { env, file }
}

interface Child {
	/** The record directory the child was given, `null` when nothing is being recorded. */
	file: string | null
	cwd: string
	/** The test file that started it; what it reports counts only while that file runs. */
	test: string | undefined
	/** `Outputs.now()` at its start: what the test read after that does not make a file the child wrote a dependency. */
	startedAt: number
}

const OUTSTANDING = Symbol.for('blacksmith.recordReads.outstanding')

// On the shared builtin, like the context: the `vm` pools evaluate this file
// once per test file while the wrapped `child_process` and `Worker` keep the
// first evaluation's closures, so every evaluation must see one set.
/** Children that have not exited yet, each still charged to the test file that started it. */
function outstanding(): Set<Child> {
	return ((shared[OUTSTANDING] as Set<Child> | undefined) ??= new Set())
}

function startChild(file: string | null, cwd: string): Child {
	const child: Child = {
		file,
		cwd,
		test: workerState()?.filepath,
		startedAt: outputs().now(),
	}
	if (file !== null) outstanding().add(child)
	return child
}

/** The options object of a `child_process` call, inserted when the call had none. */
function optionsOf(args: unknown[]): Record<string, unknown> {
	let index = args.findIndex(
		(arg, i) =>
			i > 0 && typeof arg === 'object' && arg !== null && !Array.isArray(arg),
	)
	if (index === -1) {
		index = Array.isArray(args[1]) ? 2 : 1
		args.splice(index, 0, {})
	}
	const options = { ...(args[index] as Record<string, unknown>) }
	args[index] = options
	return options
}

/**
 * Prepares a `child_process` call: the child gets the recorder preloaded and
 * a directory to report to, and the command plus every argument naming a file is
 * recorded right away, which is all a non-node child (a shell script, a
 * binary) can contribute.
 */
function instrument(args: unknown[]): Child {
	if (!dependencies()) return startChild(null, process.cwd())
	const options = optionsOf(args)
	const cwd =
		typeof options.cwd === 'string'
			? path.resolve(options.cwd)
			: options.cwd instanceof URL
				? fileURLToPath(options.cwd)
				: process.cwd()
	const recorded = recordedEnv(options.env as Env | undefined)
	if (recorded) options.env = recorded.env
	const words = [
		...(typeof args[0] === 'string' ? args[0].split(/\s+/) : []),
		...(Array.isArray(args[1]) ? args[1] : []),
	]
	for (const word of words) {
		if (typeof word !== 'string' || word === '') continue
		const candidate = path.resolve(cwd, word)
		try {
			if (exists(candidate) && stat(candidate).isFile()) record(candidate)
		} catch {}
	}
	return startChild(recorded?.file ?? null, cwd)
}

/** What the child has reported so far, relative to its working directory, while its test file is the one running. */
function recordReported(child: Child): void {
	if (child.file === null || child.test !== workerState()?.filepath) return
	let names: string[]
	try {
		names = readdir(child.file)
	} catch {
		return
	}
	for (const name of names) {
		let reported: string
		try {
			reported = read(path.join(child.file, name), 'utf8')
		} catch {
			continue
		}
		for (const line of reported.split('\n')) {
			if (line === '') continue
			if (line.startsWith(WRITE_PREFIX)) {
				wrote(line.slice(WRITE_PREFIX.length), child.cwd, child.startedAt)
			} else {
				record(line, child.cwd)
			}
		}
	}
}

/** Records what the exited child reported and forgets it. */
function collect(child: Child): void {
	if (child.file === null) return
	recordReported(child)
	outstanding().delete(child)
}

// Vitest ships the test file's dependency set as soon as its hooks are done,
// so a child still running then (a server the test tears down, a worker it
// never joins) reports what it has loaded so far here. Whether this hook
// runs before or after the file's own `afterAll` (`sequence.hooks`), the
// child's exit still reports to this file while it is the one running.
afterAll(() => {
	const current = workerState()?.filepath
	for (const child of outstanding()) {
		if (child.test !== current) continue
		recordReported(child)
		outstanding().delete(child)
	}
	writeOwnRecord()
})

// A vitest older than 5.1 keeps no dependency set per test file: this setup
// file starts one for the reads recorded above, and once the file's hooks are
// done leaves it, with every module the file and its setup files evaluated,
// where the plugin's reporter picks it up.
const ownRecords = process.env[ENV_OWN_RECORDS] === '1'

interface PendingRecord {
	file: string
	test: string
	setupFiles: readonly string[]
	graph: NonNullable<WorkerState['evaluatedModules']>
	files: Set<string>
	late: Set<string>
}

// On the process, not the module: a worker that reuses itself evaluates this
// file again for its next test file, and a vm pool gives each its own global.
const PENDING = Symbol.for('blacksmith.vitest.pendingRecord')
const pendingHolder = process as unknown as {
	[PENDING]?: { record?: PendingRecord; exits?: true }
}
const pending = (pendingHolder[PENDING] ??= {})

function recordedFiles(
	graph: PendingRecord['graph'],
	roots: readonly string[],
	files: Set<string>,
): Set<string> {
	const seen = new Set<EvaluatedModule>()
	const queue = roots.flatMap((file) => [
		...(graph.getModulesByFile(file) ?? []),
	])
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
	return files
}

// The main process may read a record while its worker finishes it: the
// rename keeps it from ever seeing half of one.
function writeRecord(file: string, files: Set<string>): void {
	const partial = `${file}.${process.pid}.${workerThreads.threadId}.tmp`
	write(partial, JSON.stringify([...files]))
	fs.renameSync(partial, file)
}

/**
 * Writes the last test file's record again with what it loaded and read
 * after this file's `afterAll`: teardown that runs later (a `beforeAll`
 * cleanup, a fixture, a later `afterAll`) and imports still in flight.
 */
function finishPendingRecord(): void {
	const record = pending.record
	if (!record) return
	delete pending.record
	for (const file of record.late) record.files.add(file)
	recordedFiles(record.graph, [record.test, ...record.setupFiles], record.files)
	try {
		writeRecord(record.file, record.files)
		// Tells the main process this record has all of the file's teardown.
		write(`${record.file}${FINAL_SUFFIX}`, '')
	} catch {}
}

if (ownRecords) {
	finishPendingRecord()
	const state = workerState()
	if (state) state.dependencies = new Set()
	// Vitest runs these when it tears the worker down, after every hook.
	;(state as { onCleanup?: (cb: () => void) => void } | undefined)?.onCleanup?.(
		finishPendingRecord,
	)
	if (!pending.exits) {
		pending.exits = true
		process.on('exit', finishPendingRecord)
	}
}

function writeOwnRecord(): void {
	const state = workerState()
	const root = process.env[ENV_RECORD_ROOT]
	const graph = state?.evaluatedModules
	if (!ownRecords || !state?.filepath || !root || !graph) return
	// A graph without the test file would leave a record without its
	// imports, and a record is what lets a later run skip the file.
	if (![...(graph.getModulesByFile(state.filepath) ?? [])].length) return
	const setupFiles = state.config?.setupFiles ?? []
	const files = recordedFiles(
		graph,
		[state.filepath, ...setupFiles],
		new Set<string>(state.dependencies),
	)
	const file = workerRecordPath(root, state.config?.name ?? '', state.filepath)
	mkdir(path.dirname(file), { recursive: true })
	rm(`${file}${FINAL_SUFFIX}`, { force: true })
	writeRecord(file, files)
	// What is read from here on is still this file's until the worker starts
	// its next one, and never that one's.
	const late = new Set<string>()
	state.dependencies = late
	pending.record = { file, test: state.filepath, setupFiles, graph, files, late }
}

type Wrappable = Record<string, unknown>

function wrapChildProcess(name: string, sync: boolean): void {
	const target = childProcess as unknown as Wrappable
	const original = target[name]
	if (typeof original !== 'function' || BRAND in original) return
	const call = original as (...args: unknown[]) => unknown
	const wrapped = sync
		? function (this: unknown, ...args: unknown[]) {
				const child = instrument(args)
				try {
					return call.apply(this, args)
				} finally {
					collect(child)
				}
			}
		: function (this: unknown, ...args: unknown[]) {
				const child = instrument(args)
				const process = call.apply(this, args) as
					| { once?: (event: string, listener: () => void) => unknown }
					| undefined
				// Only `exit`: an `error` listener would keep a spawn failure from
				// surfacing as the uncaught error it is. A child that never ran
				// reported nothing and is forgotten with its test file.
				if (typeof process?.once === 'function') {
					process.once('exit', () => collect(child))
				}
				return process
			}
	// Node's own promisified `exec`/`execFile` call the unwrapped function;
	// `promisify(execFile)` must go through the wrapper to reach the child.
	if (promisify.custom in original) {
		Object.defineProperty(wrapped, promisify.custom, {
			value: (...args: unknown[]) => {
				let child: unknown
				const promise = new Promise((resolve, reject) => {
					child = wrapped(
						...args,
						(error: Error | null, stdout: unknown, stderr: unknown) =>
							error
								? reject(Object.assign(error, { stdout, stderr }))
								: resolve({ stdout, stderr }),
					)
				})
				return Object.defineProperty(promise, 'child', {
					value: child,
					enumerable: true,
				})
			},
		})
	}
	copyProperties(wrapped, original)
	Object.defineProperty(wrapped, BRAND, { value: true })
	target[name] = wrapped
}

for (const name of ['spawn', 'exec', 'execFile', 'fork']) {
	wrapChildProcess(name, false)
}
for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
	wrapChildProcess(name, true)
}

type WorkerOptions = import('node:worker_threads').WorkerOptions

/** The script a worker runs, when it is a file; `null` for `eval`, `data:` and `node:` sources. */
function workerScript(
	filename: string | URL,
	options: WorkerOptions | undefined,
): string | null {
	if (options?.eval === true) return null
	if (filename instanceof URL) {
		return filename.protocol === 'file:' ? fileURLToPath(filename) : null
	}
	return filename.startsWith('data:') || filename.startsWith('node:')
		? null
		: filename
}

/**
 * A worker thread has its own `fs` builtin and module registry, so it is
 * recorded like a child: the preload comes through its `env` (a worker reads
 * `NODE_OPTIONS` from there), and the script it runs is recorded right away.
 * A worker sharing the parent's environment (`env: SHARE_ENV`) contributes
 * only its script, and so does one whose `NODE_OPTIONS` node refuses to
 * change (the parent's holds an option a worker's may not carry, `--title`
 * say): it is then started exactly as asked.
 */
function wrapWorker(): void {
	const target = workerThreads as unknown as Wrappable
	const Original = workerThreads.Worker
	if (BRAND in Original) return
	type Instance = import('node:worker_threads').Worker
	function RecordedWorker(
		this: unknown,
		filename: string | URL,
		options?: WorkerOptions,
	): Instance {
		const construct = (given: WorkerOptions | undefined) =>
			Reflect.construct(
				Original,
				[filename, given],
				new.target ?? RecordedWorker,
			) as Instance
		if (!dependencies()) return construct(options)
		const script = workerScript(filename, options)
		if (script !== null) record(script)
		const recorded =
			options?.env === workerThreads.SHARE_ENV
				? null
				: recordedEnv(options?.env as Env | undefined)
		if (!recorded) return construct(options)
		const child = startChild(recorded.file, process.cwd())
		let worker: Instance
		try {
			worker = construct({ ...options, env: recorded.env })
		} catch (error) {
			outstanding().delete(child)
			if (
				(error as { code?: unknown }).code !== 'ERR_WORKER_INVALID_EXEC_ARGV'
			) {
				throw error
			}
			return construct(options)
		}
		// `exit` follows an uncaught error in the worker too; an `error`
		// listener here would swallow that error instead of letting Vitest report it.
		worker.once('exit', () => collect(child))
		return worker
	}
	RecordedWorker.prototype = Original.prototype
	Object.setPrototypeOf(RecordedWorker, Original)
	copyProperties(RecordedWorker, Original)
	Object.defineProperty(RecordedWorker, BRAND, { value: true })
	target.Worker = RecordedWorker
}

wrapWorker()

// `import { readFileSync } from 'node:fs'` binds the builtin's ESM namespace,
// which only sees the wrapped functions once the namespace is resynced; the
// vm pools keep their own per-context namespaces and expose their resync.
const required = (
	globalThis as { __vitest_required__?: { syncBuiltinESMExports?: () => void } }
).__vitest_required__
if (required?.syncBuiltinESMExports) required.syncBuiltinESMExports()
else {
	syncBuiltinESMExports()
	syncContextBuiltins()
}

/**
 * A `vm` pool older than vitest 5.1 has no resync: a builtin the context
 * imported before this file ran keeps the functions it had then, which in a
 * thread's first test file are the unwrapped ones.
 */
function syncContextBuiltins(): void {
	const cache = (
		globalThis as {
			__vitest_vm_context__?: {
				externalModulesExecutor?: {
					cjs?: { moduleCache?: Map<string, unknown> }
				}
			}
		}
	).__vitest_vm_context__?.externalModulesExecutor?.cjs?.moduleCache
	// A Map of the outer realm: `instanceof` fails from inside the context.
	if (typeof cache?.entries !== 'function') return
	for (const [identifier, module] of cache.entries()) {
		if (!isBuiltin(identifier)) continue
		const setExport = (module as { setExport?: unknown }).setExport
		if (typeof setExport !== 'function') continue
		const exports = require(identifier) as Record<string, unknown>
		for (const key of Object.keys(exports)) {
			try {
				setExport.call(module, key, exports[key])
			} catch {
				// Not evaluated yet (it reads the builtin when it is), or a
				// key the module was not created with.
			}
		}
	}
}
