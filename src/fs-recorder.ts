import { createHash } from 'node:crypto'
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
/** Set when vitest keeps no dependency record and the workers write the plugin's. */
/** Beside a worker's record once the worker has finished it. */
export const FINAL_SUFFIX = '.final'
export const ENV_OWN_RECORDS = 'BLACKSMITH_OWN_RECORDS'

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
}

/** Reads that only ask whether or what a path is; one before a write leaves the path an output. */
const PROBES = ['access', 'lstat', 'readlink', 'realpath', 'stat']
const CONTENT_READS = ['opendir', 'readdir', 'readFile']

/**
 * What a call does to the file it names: `replace` leaves nothing of what was
 * there; `keep` (append, exclusive create, write in place) leaves a file
 * already there in place, whole or in part.
 */
type Effect = 'read' | 'replace' | 'keep'

/** The effect of opening a file with `flags`, `open`'s second argument or a `flag`/`flags` option. */
function effectOf(fs: typeof FS, flags: unknown, fallback: Effect): Effect {
	if (typeof flags === 'string') {
		if (flags.includes('x') || flags.includes('a')) return 'keep'
		if (flags.includes('w')) return 'replace'
		// `r+` creates nothing: it needs the file that is there.
		return 'read'
	}
	if (typeof flags !== 'number') return fallback
	const { O_APPEND, O_CREAT, O_EXCL, O_RDWR, O_TRUNC, O_WRONLY } = fs.constants
	if ((flags & (O_WRONLY | O_RDWR)) === 0) return 'read'
	if ((flags & (O_EXCL | O_APPEND)) !== 0) return 'keep'
	if ((flags & O_TRUNC) !== 0) return 'replace'
	return (flags & O_CREAT) !== 0 ? 'keep' : 'read'
}

/** The `flag` (`writeFile`) or `flags` (`createWriteStream`) of an options argument. */
function flagOption(options: unknown): unknown {
	if (typeof options !== 'object' || options === null) return undefined
	const { flag, flags } = options as { flag?: unknown; flags?: unknown }
	return flag ?? flags
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
	const apply = (file: string, effect: Effect) => {
		if (effect === 'read') return read(file, true)
		let existing: FS.Stats | undefined
		try {
			existing = statSync(file)
		} catch {}
		// `mkdir -p` and a copy onto a directory that is already there change nothing.
		if (existing?.isDirectory()) return
		// What was there stays, so the call depends on it.
		if (existing && effect === 'keep') return read(file, true)
		wrote(file)
	}
	/** A call writing the path at `index`; `flags` picks the argument that can make it keep the file. */
	const writer =
		(index: number, fallback: Effect, flags?: (args: unknown[]) => unknown) =>
		(args: unknown[]) => {
			const file = toPath(args[index])
			if (file === null) return
			apply(file, flags ? effectOf(fs, flags(args), fallback) : fallback)
		}
	const copyFile = (args: unknown[]) => {
		reader(true)(args)
		const to = toPath(args[1])
		if (to === null) return
		const exclusive =
			typeof args[2] === 'number' &&
			(args[2] & fs.constants.COPYFILE_EXCL) !== 0
		apply(to, exclusive ? 'keep' : 'replace')
	}
	const tree = (args: unknown[]) => {
		const from = toPath(args[0])
		const to = toPath(args[1])
		if (from === null) return
		const options = (args[2] ?? {}) as { force?: boolean }
		const effect: Effect = options.force === false ? 'keep' : 'replace'
		read(from, true)
		if (to !== null) apply(to, effect)
		let entries: string[]
		try {
			entries = readdirSync(from, { recursive: true, encoding: 'utf8' })
		} catch {
			return
		}
		for (const entry of entries) {
			read(path.join(from, entry), true)
			if (to !== null) apply(path.join(to, entry), effect)
		}
	}
	const target = fs as unknown as Wrappable
	const promises = fs.promises as unknown as Wrappable
	const each = (name: string, before: (args: unknown[]) => void) => {
		wrap(target, name, before)
		wrap(target, `${name}Sync`, before)
		wrap(promises, name, before)
	}
	const second = (args: unknown[]) => args[1]
	const option = (index: number) => (args: unknown[]) =>
		typeof args[index] === 'string' ? undefined : flagOption(args[index])
	for (const name of PROBES) each(name, reader(false))
	for (const name of CONTENT_READS) each(name, reader(true))
	each('open', writer(0, 'read', second))
	each('writeFile', writer(0, 'replace', option(2)))
	each('appendFile', writer(0, 'keep', option(2)))
	each('mkdir', writer(0, 'replace'))
	each('copyFile', copyFile)
	each('cp', tree)
	each('rename', (args) => {
		reader(true)(args)
		writer(1, 'replace')(args)
	})
	// What the new name reads is the target's content; a link that is already
	// there makes the call fail.
	each('link', (args) => {
		reader(true)(args)
		writer(1, 'keep')(args)
	})
	each('symlink', (args) => {
		const target = toPath(args[0])
		const link = toPath(args[1])
		// A relative target is relative to the link's directory.
		if (target !== null && link !== null) {
			read(path.resolve(path.dirname(link), target), true)
		}
		writer(1, 'keep')(args)
	})
	wrap(target, 'createWriteStream', writer(0, 'replace', option(1)))
	wrap(target, 'existsSync', reader(false))
	wrap(target, 'createReadStream', reader(true))
}

// Here, not with the store that reads it: a worker must not import `node:fs`
// before `record-reads` wraps it, or the `vm` pools hand tests the unwrapped one.
/** Where a worker leaves what the test file `test` of `project` loaded, under the run's record root. */
export function workerRecordPath(
	root: string,
	project: string,
	test: string,
): string {
	const name = createHash('sha1').update(`${project}\0${test}`).digest('hex')
	return path.join(root, 'deps', `${name}.json`)
}
