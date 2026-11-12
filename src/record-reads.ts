import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterAll } from 'vitest'

import {
	BRAND,
	CHILD_RECORD_ENV,
	copyProperties,
	isIgnored,
	wrapReads,
} from './fs-recorder.ts'

/**
 * Runs as the first setup file of every test file. Vitest records what a
 * test imports; this records the files it reads through `node:fs` and the
 * node processes and worker threads it starts (their modules and reads, via
 * `record-child`), adding each to the dependency set vitest keeps per test
 * file.
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

interface WorkerState {
	dependencies?: Set<string>
	/** The test file being run. */
	filepath?: string
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
	'existsSync' | 'mkdtempSync' | 'readFileSync' | 'statSync' | 'unlinkSync'
>

// Unwrapped, so this module's own file handling records nothing; kept on the
// builtin because a later evaluation in the same process finds `fs` wrapped.
const {
	existsSync: exists,
	mkdtempSync: mkdtemp,
	readFileSync: read,
	statSync: stat,
	unlinkSync: unlink,
} = ((shared[ORIGINALS] as Originals | undefined) ??= {
	existsSync: fs.existsSync,
	mkdtempSync: fs.mkdtempSync,
	readFileSync: fs.readFileSync,
	statSync: fs.statSync,
	unlinkSync: fs.unlinkSync,
})

function workerState(): WorkerState | undefined {
	return (shared[CONTEXT] as Context | undefined)?.__vitest_worker__
}

function dependencies(): Set<string> | undefined {
	return workerState()?.dependencies
}

function record(file: string, cwd = process.cwd()): void {
	const set = dependencies()
	if (!set) return
	const absolute = path.resolve(cwd, file)
	if (isIgnored(absolute)) return
	set.add(absolute)
}

wrapReads(fs, (file) => record(file))

/** Beside this module; `.ts` when the plugin runs from source (its own test fixtures). */
const recordChild = fileURLToPath(
	new URL(
		import.meta.url.endsWith('.ts') ? './record-child.ts' : './record-child.js',
		import.meta.url,
	),
)

let recordDir: string | undefined
let spawned = 0

/** Where one child (and its descendants) appends what it loaded. */
function recordFile(): string {
	recordDir ??= mkdtemp(path.join(os.tmpdir(), 'blacksmith-child-'))
	return path.join(recordDir, `${process.pid}-${spawned++}.txt`)
}

type Env = Record<string, string | undefined>

/**
 * `given` (the call's `env`, or the parent's when it had none) with the
 * recorder preloaded and a file to report to; `null` when the caller asked
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
	const file = recordFile()
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
	/** The record file the child was given, `null` when nothing is being recorded. */
	file: string | null
	cwd: string
	/** The test file that started it; what it reports counts only while that file runs. */
	test: string | undefined
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
	const child: Child = { file, cwd, test: workerState()?.filepath }
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
 * a file to report to, and the command plus every argument naming a file is
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
	let reported: string
	try {
		reported = read(child.file, 'utf8')
	} catch {
		return
	}
	for (const line of reported.split('\n')) if (line !== '') record(line, child.cwd)
}

/** Records what the exited child reported and forgets it. */
function collect(child: Child): void {
	if (child.file === null) return
	recordReported(child)
	try {
		unlink(child.file)
	} catch {}
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
})

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
;(required?.syncBuiltinESMExports ?? syncBuiltinESMExports)()
