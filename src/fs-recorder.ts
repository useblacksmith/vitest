import type * as FS from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Marks a function this module already wrapped, so a second load leaves it alone. */
export const BRAND = Symbol.for('blacksmith.recordReads')

/** Set in a child process's environment: the file its recorder appends the paths it loaded or read to. */
export const CHILD_RECORD_ENV = 'BLACKSMITH_CHILD_RECORD'

export function toPath(target: unknown): string | null {
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

/** Installed packages are vouched for by the lockfile, not by their files. */
export function isIgnored(absolute: string): boolean {
	return absolute.split(path.sep).includes('node_modules')
}

type Wrappable = Record<string, unknown>

/** Replaces `object[name]` with a function that calls `before(args)` first; properties and symbols of the original (`realpathSync.native`, `promisify.custom`) carry over. */
export function wrap(
	object: Wrappable,
	name: string,
	before: (args: unknown[]) => void,
): void {
	const original = object[name]
	if (typeof original !== 'function' || BRAND in original) return
	const wrapped = function (this: unknown, ...args: unknown[]) {
		before(args)
		return (original as (...args: unknown[]) => unknown).apply(this, args)
	}
	copyProperties(wrapped, original)
	wrap(wrapped as unknown as Wrappable, 'native', before)
	Object.defineProperty(wrapped, BRAND, { value: true })
	object[name] = wrapped
}

/** Own properties of `original` that `wrapped` lacks, non-enumerable ones included. */
export function copyProperties(wrapped: object, original: object): void {
	for (const key of Reflect.ownKeys(original)) {
		if (Object.prototype.hasOwnProperty.call(wrapped, key)) continue
		const descriptor = Object.getOwnPropertyDescriptor(original, key)
		if (descriptor) Object.defineProperty(wrapped, key, descriptor)
	}
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

/** Wraps every read entry point of `fs` so `record` sees the path argument; a copied tree is recorded file by file. */
export function wrapReads(fs: typeof FS, record: (file: string) => void): void {
	const first = (args: unknown[]) => {
		const file = toPath(args[0])
		if (file !== null) record(file)
	}
	const tree = (args: unknown[]) => {
		first(args)
		const file = toPath(args[0])
		if (file === null) return
		let entries: string[]
		try {
			entries = fs.readdirSync(file, { recursive: true, encoding: 'utf8' })
		} catch {
			return
		}
		for (const entry of entries) record(path.join(file, entry))
	}
	const target = fs as unknown as Wrappable
	const promises = fs.promises as unknown as Wrappable
	for (const name of READS) {
		wrap(target, name, first)
		wrap(target, `${name}Sync`, first)
		wrap(promises, name, first)
	}
	wrap(target, 'existsSync', first)
	wrap(target, 'createReadStream', first)
	wrap(target, 'cp', tree)
	wrap(promises, 'cp', tree)
	wrap(target, 'cpSync', tree)
}
