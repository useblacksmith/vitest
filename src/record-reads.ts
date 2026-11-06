import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

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
 * node processes it spawns (their modules and reads, via `record-child`),
 * adding each to the dependency set vitest keeps per test file.
 *
 * The functions on the builtin are replaced, so every specifier that reaches
 * them (`fs`, `node:fs`, `fs/promises`, `require`) is covered.
 */
const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const childProcess =
	require('node:child_process') as typeof import('node:child_process')

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

interface Child {
	/** The record file the child was given, `null` when nothing is being recorded. */
	file: string | null
	cwd: string
}

/**
 * Prepares a `child_process` call: the child gets the recorder preloaded and
 * a file to report to, and the command plus every argument naming a file is
 * recorded right away, which is all a non-node child (a shell script, a
 * binary) can contribute.
 */
function instrument(args: unknown[]): Child {
	if (!dependencies()) return { file: null, cwd: process.cwd() }
	const options = optionsOf(args)
	const cwd =
		typeof options.cwd === 'string'
			? path.resolve(options.cwd)
			: options.cwd instanceof URL
				? fileURLToPath(options.cwd)
				: process.cwd()
	const file = recordFile()
	const given = options.env as Record<string, string | undefined> | undefined
	const env = { ...(given ?? process.env) }
	// `env: { ...process.env, NODE_OPTIONS: undefined }` asks for a child free
	// of node options; such a child is left alone and contributes only its
	// command line.
	const cleared =
		given !== undefined &&
		Object.prototype.hasOwnProperty.call(given, 'NODE_OPTIONS') &&
		given.NODE_OPTIONS === undefined
	if (!cleared) {
		env[CHILD_RECORD_ENV] = file
		env.NODE_OPTIONS = [
			env.NODE_OPTIONS,
			`--import ${pathToFileURL(recordChild).href}`,
		]
			.filter(Boolean)
			.join(' ')
	}
	options.env = env
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
	return { file, cwd }
}

/** Records what the exited child reported, relative to its working directory. */
function collect({ file, cwd }: Child): void {
	if (file === null) return
	let reported: string
	try {
		reported = read(file, 'utf8')
	} catch {
		return
	} finally {
		try {
			unlink(file)
		} catch {}
	}
	for (const line of reported.split('\n')) if (line !== '') record(line, cwd)
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

// `import { readFileSync } from 'node:fs'` binds the builtin's ESM namespace,
// which only sees the wrapped functions once the namespace is resynced; the
// vm pools keep their own per-context namespaces and expose their resync.
const required = (
	globalThis as { __vitest_required__?: { syncBuiltinESMExports?: () => void } }
).__vitest_required__
;(required?.syncBuiltinESMExports ?? syncBuiltinESMExports)()
