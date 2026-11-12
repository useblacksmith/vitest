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

// Unwrapped, so this module's own file handling records nothing.
const {
	existsSync: exists,
	mkdtempSync: mkdtemp,
	readFileSync: read,
	statSync: stat,
	unlinkSync: unlink,
} = fs

const CONTEXT = Symbol.for('blacksmith.recordReads.context')

interface WorkerState {
	dependencies?: Set<string>
}

interface Context {
	__vitest_worker__?: WorkerState
}

// The `vm` pools load this file in one context and run tests in another; the
// builtin is shared, so it carries the context that holds the worker state.
const shared = fs as unknown as Record<symbol, unknown>
shared[CONTEXT] = globalThis

function dependencies(): Set<string> | undefined {
	return (shared[CONTEXT] as Context | undefined)?.__vitest_worker__
		?.dependencies
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
	/** Its test file has finished: what it reports from now on belongs to no test. */
	detached: boolean
}

/** Children of the current test file that have not exited yet. */
const outstanding = new Set<Child>()

function startChild(file: string | null, cwd: string): Child {
	const child: Child = { file, cwd, detached: false }
	if (file !== null) outstanding.add(child)
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

/** What the child has reported so far, relative to its working directory. */
function recordReported(child: Child): void {
	if (child.file === null || child.detached) return
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
	outstanding.delete(child)
}

// Vitest ships the test file's dependency set as soon as its hooks are done,
// so a child still running then (a server the test tears down, a worker it
// never joins) reports what it has loaded so far here and nothing afterwards.
afterAll(() => {
	for (const child of outstanding) {
		recordReported(child)
		child.detached = true
	}
	outstanding.clear()
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
				if (typeof process?.once === 'function') {
					const done = () => collect(child)
					process.once('exit', done)
					process.once('error', done)
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

/**
 * A worker thread has its own `fs` builtin and module registry, so it is
 * recorded like a child: the preload comes through its `env` (`NODE_OPTIONS`
 * is read from there), and the script it runs is recorded right away. A
 * worker sharing the parent's environment (`env: SHARE_ENV`) contributes
 * only its script.
 */
function wrapWorker(): void {
	const target = workerThreads as unknown as Wrappable
	const Original = workerThreads.Worker
	if (BRAND in Original) return
	type WorkerOptions = import('node:worker_threads').WorkerOptions
	class RecordedWorker extends Original {
		constructor(filename: string | URL, options?: WorkerOptions) {
			let child: Child = { file: null, cwd: process.cwd(), detached: false }
			if (dependencies()) {
				const script =
					options?.eval === true
						? null
						: filename instanceof URL
							? filename.protocol === 'file:'
								? fileURLToPath(filename)
								: null
							: filename.startsWith('data:') || filename.startsWith('node:')
								? null
								: filename
				if (script !== null) record(script)
				const given = options?.env
				if (given !== workerThreads.SHARE_ENV) {
					const recorded = recordedEnv(given as Env | undefined)
					if (recorded) {
						options = { ...options, env: recorded.env }
						child = startChild(recorded.file, process.cwd())
					}
				}
			}
			super(filename, options)
			if (child.file !== null) {
				const done = () => collect(child)
				this.once('exit', done)
				this.once('error', done)
			}
		}
	}
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
