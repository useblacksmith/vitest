import type * as FS from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Marks a function this module already wrapped, so a second load leaves it alone. */
export const BRAND = Symbol.for('blacksmith.recordReads')

/** Set in a child process's environment: the directory its recorder writes the paths it loaded or read to, the same for every child of one test file. */
export const CHILD_RECORD_ENV = 'BLACKSMITH_CHILD_RECORD'
/** The repository root; a read outside it is not recorded, the anchor cannot cover it. */
export const ENV_REPO = 'BLACKSMITH_REPO'
/** Directory, made and removed by the main process, that holds every child record. */
export const ENV_RECORD_ROOT = 'BLACKSMITH_RECORD_ROOT'

/** Starts a line of a child's record that names a path the child wrote, not one it read. */
export const WRITE_PREFIX = 'write:'

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
	if (absolute.split(path.sep).includes('node_modules')) return true
	const repo = process.env[ENV_REPO]
	if (!repo) return false
	const relative = path.relative(repo, absolute)
	return relative.startsWith('..') || path.isAbsolute(relative)
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

/**
 * Tells what a run produced from what it depended on: a path written before
 * its content was read is an output, the same on every run whatever was on
 * disk before, so it is not a dependency.
 *
 * e.g. `cpSync(src, 'public/gen')` then `readFileSync('public/gen/a.png')` → `src/a.png` is a dependency, `public/gen/a.png` is not
 */
export class Outputs {
	private contentRead = new Map<string, number>()
	private written = new Set<string>()
	private clock = 0

	/** Grows with every first content read; a child keeps the value it started at. */
	now(): number {
		return this.clock
	}

	/** False when `file` is an output, which is not to be recorded. */
	reads(file: string, content: boolean): boolean {
		if (this.written.has(file)) return false
		if (content && !this.contentRead.has(file)) {
			this.contentRead.set(file, ++this.clock)
		}
		return true
	}

	/** True when the write makes `file` an output: its content was not read first, reads after `since` (a child's start, its writes being reported late) aside. */
	writes(file: string, since = Infinity): boolean {
		if (this.written.has(file)) return true
		const at = this.contentRead.get(file)
		if (at !== undefined && at <= since) return false
		this.written.add(file)
		return true
	}

	*[Symbol.iterator](): IterableIterator<string> {
		yield* this.written
	}
}

/** Reads that only ask whether or what a path is; one before a write leaves the path an output. */
const PROBES = ['access', 'lstat', 'readlink', 'realpath', 'stat']
const CONTENT_READS = ['copyFile', 'opendir', 'readdir', 'readFile', 'rename']
const WRITES = ['appendFile', 'mkdir', 'writeFile']
/** Writes whose target is the second argument. */
const WRITES_TO = ['copyFile', 'link', 'rename', 'symlink']

/** Whether `open(path, flags)` replaces the file's content rather than reading it. */
function opensForWrite(fs: typeof FS, flags: unknown): boolean {
	if (typeof flags === 'string') return /[wa]/.test(flags)
	if (typeof flags !== 'number') return false
	const { O_RDWR, O_TRUNC, O_WRONLY } = fs.constants
	return (flags & O_TRUNC) !== 0 || (flags & (O_WRONLY | O_RDWR)) === O_WRONLY
}

/**
 * Wraps every entry point of `fs` that takes a path: `read` sees each path
 * read (`content` false for a probe such as `stat`), `wrote` each path
 * written; a copied tree is reported file by file on both sides.
 */
export function wrapFs(
	fs: typeof FS,
	read: (file: string, content: boolean) => void,
	wrote: (file: string) => void,
): void {
	const { readdirSync, statSync } = fs
	const reader = (content: boolean) => (args: unknown[]) => {
		const file = toPath(args[0])
		if (file !== null) read(file, content)
	}
	// `mkdir -p` and a copy onto a directory that is already there change nothing.
	const write = (file: string) => {
		try {
			if (statSync(file).isDirectory()) return
		} catch {}
		wrote(file)
	}
	const writer = (index: number) => (args: unknown[]) => {
		const file = toPath(args[index])
		if (file !== null) write(file)
	}
	const open = (args: unknown[]) => {
		const file = toPath(args[0])
		if (file === null) return
		if (opensForWrite(fs, args[1])) write(file)
		else read(file, true)
	}
	const tree = (args: unknown[]) => {
		const from = toPath(args[0])
		const to = toPath(args[1])
		if (from === null) return
		read(from, true)
		if (to !== null) write(to)
		let entries: string[]
		try {
			entries = readdirSync(from, { recursive: true, encoding: 'utf8' })
		} catch {
			return
		}
		for (const entry of entries) {
			read(path.join(from, entry), true)
			if (to !== null) write(path.join(to, entry))
		}
	}
	const target = fs as unknown as Wrappable
	const promises = fs.promises as unknown as Wrappable
	const each = (name: string, before: (args: unknown[]) => void) => {
		wrap(target, name, before)
		wrap(target, `${name}Sync`, before)
		wrap(promises, name, before)
	}
	const both =
		(...before: Array<(args: unknown[]) => void>) =>
		(args: unknown[]) => {
			for (const call of before) call(args)
		}
	for (const name of PROBES) each(name, reader(false))
	for (const name of CONTENT_READS) {
		each(
			name,
			WRITES_TO.includes(name) ? both(reader(true), writer(1)) : reader(true),
		)
	}
	for (const name of WRITES) each(name, writer(0))
	for (const name of WRITES_TO) each(name, writer(1))
	each('open', open)
	each('cp', tree)
	wrap(target, 'existsSync', reader(false))
	wrap(target, 'createReadStream', reader(true))
	wrap(target, 'createWriteStream', writer(0))
}
