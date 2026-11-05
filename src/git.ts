import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readlinkSync, type Stats } from 'node:fs'
import path from 'node:path'

/** Repository-relative path → `<mode> <sha>` (see `anchorTree`), so a chmod is a change. */
export type Tree = Record<string, string>

function git(cwd: string, args: string[], input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, {
			cwd,
			stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
		})
		const stdout: Buffer[] = []
		const stderr: Buffer[] = []
		child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
		child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'))
			else {
				reject(
					new Error(
						`git ${args.join(' ')} exited with ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
					),
				)
			}
		})
		if (input !== undefined) {
			child.stdin?.on('error', reject)
			child.stdin?.end(input)
		}
	})
}

export async function repoRoot(cwd: string): Promise<string> {
	return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
}

export async function headSha(repo: string): Promise<string> {
	return (await git(repo, ['rev-parse', 'HEAD'])).trim()
}

/** A dirty submodule is the only directory `git ls-files` names itself; its checked-out commit stands in for a blob sha. */
async function submoduleHead(repo: string, dir: string): Promise<string> {
	try {
		return `160000 ${(await git(path.join(repo, dir), ['rev-parse', 'HEAD'])).trim()}`
	} catch {
		return `160000 dirty:${dir}`
	}
}

/** False where git ignores the executable bit (`core.fileMode`, e.g. FAT or Windows); a file then keeps the mode the index has for it. */
async function tracksFileMode(repo: string): Promise<boolean> {
	try {
		const value = await git(repo, ['config', '--type=bool', 'core.fileMode'])
		return value.trim() !== 'false'
	} catch {
		return true
	}
}

/** Lockfiles anywhere in the worktree, tracked or not. */
export function lockfilePaths(
	repo: string,
	names: Iterable<string>,
): Promise<string[]> {
	return listKnown(
		repo,
		[...names].map((name) => `:(glob)**/${name}`),
		false,
	).then((known) => [...known].sort())
}

/** Every path git would show for the worktree: tracked and untracked, not ignored. */
export function knownPaths(repo: string): Promise<Set<string>> {
	return listKnown(repo, ['.'], false)
}

/**
 * Paths git would show for the pathspecs: tracked files still on disk and
 * untracked files not ignored, so a directory's listing is what `git status`
 * would attribute to it. Index entries whose file is gone are left out.
 */
async function listKnown(
	repo: string,
	pathspecs: string[],
	literal = true,
): Promise<Set<string>> {
	const known = new Set<string>()
	const gone = new Set<string>()
	for (let i = 0; i < pathspecs.length; i += 500) {
		const output = await git(repo, [
			...(literal ? ['--literal-pathspecs'] : []),
			'ls-files',
			'-z',
			'-t',
			'--cached',
			'--others',
			'--deleted',
			'--exclude-standard',
			'--',
			...pathspecs.slice(i, i + 500),
		])
		for (const entry of output.split('\0')) {
			if (entry === '') continue
			const file = entry.slice(2)
			if (entry[0] === 'R') gone.add(file)
			else known.add(file)
		}
	}
	for (const file of gone) known.delete(file)
	return known
}

/** Entries of `sorted` under `dir/`, by binary search for the prefix. */
function under(sorted: string[], dir: string): string[] {
	const prefix = `${dir}/`
	let low = 0
	let high = sorted.length
	while (low < high) {
		const mid = (low + high) >>> 1
		if ((sorted[mid] ?? '') < prefix) low = mid + 1
		else high = mid
	}
	const listing: string[] = []
	for (let i = low; i < sorted.length; i++) {
		const entry = sorted[i] ?? ''
		if (!entry.startsWith(prefix)) break
		listing.push(entry)
	}
	return listing
}

const DIRECTORY_MODE = '040000'

/**
 * What each path looks like now: a file is `<mode> <blob>` as `git ls-tree`
 * prints it, a symlink hashes its target, a directory hashes its listing (every
 * tracked or untracked non-ignored path under it, so an entry moving in, out or
 * within changes it; an edit to one does not), a submodule stands by its
 * commit. Ignored files and paths that do not exist get no entry, the same
 * absence as before they appeared.
 *
 * e.g. `['src/a.ts', 'fixtures']` → `{ 'src/a.ts': '100644 3b18e5…', fixtures: '040000 9f2c…' }`
 */
export async function anchorTree(
	repo: string,
	paths: Iterable<string>,
): Promise<Tree> {
	const wanted = [...new Set(paths)]
		.filter(
			(file) =>
				file !== '' &&
				file !== '.' &&
				file !== '..' &&
				!file.startsWith('../') &&
				!path.isAbsolute(file),
		)
		.sort()
	const tree: Tree = {}
	if (wanted.length === 0) return tree
	const present = new Map<string, Stats>()
	for (const file of wanted) {
		const stat = lstatSync(path.join(repo, file), { throwIfNoEntry: false })
		if (stat !== undefined) present.set(file, stat)
	}
	// Directories apart from files: a directory pathspec walks its contents, a
	// file pathspec is a lookup, and a chunk mixing them pays the walk for all.
	const dirs: string[] = []
	const others: string[] = []
	for (const [file, stat] of present)
		(stat.isDirectory() ? dirs : others).push(file)
	const known = await listKnown(repo, dirs)
	for (const file of await listKnown(repo, others)) known.add(file)
	const sorted = [...known].sort()
	const files: string[] = []
	const modes: string[] = []
	let fileMode: boolean | undefined
	for (const [file, stat] of present) {
		if (stat.isDirectory()) {
			tree[file] = known.has(file)
				? await submoduleHead(repo, file)
				: `${DIRECTORY_MODE} ${createHash('sha1').update(under(sorted, file).join('\0')).digest('hex')}`
		} else if (!known.has(file)) continue
		else if (stat.isSymbolicLink()) {
			const target = readlinkSync(path.join(repo, file))
			const sha = (await git(repo, ['hash-object', '--stdin'], target)).trim()
			tree[file] = `120000 ${sha}`
		} else {
			files.push(file)
			fileMode ??= await tracksFileMode(repo)
			modes.push(!fileMode ? '' : stat.mode & 0o111 ? '100755' : '100644')
		}
	}
	if (files.length === 0) return tree
	if (fileMode === false) {
		const indexModes = new Map<string, string>()
		for (let i = 0; i < files.length; i += 500) {
			const staged = await git(repo, [
				'--literal-pathspecs',
				'ls-files',
				'-z',
				'--stage',
				'--',
				...files.slice(i, i + 500),
			])
			for (const entry of staged.split('\0')) {
				const tab = entry.indexOf('\t')
				if (tab === -1) continue
				indexModes.set(entry.slice(tab + 1), entry.slice(0, 6))
			}
		}
		files.forEach((file, index) => {
			modes[index] = indexModes.get(file) ?? '100644'
		})
	}
	const shas = (
		await git(repo, ['hash-object', '--stdin-paths'], files.join('\n'))
	)
		.trim()
		.split('\n')
	files.forEach((file, index) => {
		const sha = shas[index]
		if (sha === undefined)
			throw new Error(`git hash-object returned no sha for ${file}`)
		tree[file] = `${modes[index]} ${sha}`
	})
	return tree
}

/** Paths whose blob differs between the trees, including files only present in one of them. */
export function diffTrees(before: Tree, after: Tree): string[] {
	const changed: string[] = []
	for (const [file, sha] of Object.entries(after)) {
		if (before[file] !== sha) changed.push(file)
	}
	for (const file of Object.keys(before)) {
		if (!(file in after)) changed.push(file)
	}
	return changed
}
