import { execFileSync, spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import {
	chmodSync,
	cpSync,
	symlinkSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import path from 'node:path'

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'vitest'

import { SNAPSHOT_FILE, type Snapshot } from '../src/affected.ts'
import { BloomFilter } from '../src/bloom.ts'
import { shardFor } from '../src/sequencer.ts'
import { packageRoot } from './harness.ts'

const vitestBin = path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs')
const TESTS = ['one', 'two', 'three', 'five', 'six', 'snap', 'alias', 'mapped']

interface Run {
	exitCode: number
	output: string
	/** Basenames (without `.test.ts`) of the test files that ran. */
	ran: string[]
}

class Repo {
	/** The git repository. */
	readonly dir: string
	/** Where vitest runs: `dir`, or a package below it when `nest` is given. */
	readonly cwd: string
	private runs = 0

	constructor(name: string, fixture = 'fixture-affected', nest = '') {
		this.dir = path.join(
			packageRoot,
			'test',
			`fixture-runs-${name}-${process.pid}`,
		)
		this.cwd = path.join(this.dir, nest)
		rmSync(this.dir, { recursive: true, force: true })
		cpSync(path.join(packageRoot, 'test', fixture), this.cwd, {
			recursive: true,
		})
		// The reporter tests run the fixtures in place and leave vitest's cache behind.
		rmSync(path.join(this.cwd, 'node_modules'), {
			recursive: true,
			force: true,
		})
		if (nest !== '') {
			// The fixture config imports the plugin relative to test/<fixture>.
			const config = path.join(this.cwd, 'vitest.config.ts')
			writeFileSync(
				config,
				readFileSync(config, 'utf8').replaceAll(
					"'../../src/",
					`'${path.join(packageRoot, 'src')}/`,
				),
			)
		}
		this.git('init', '-q', '-b', 'main')
		this.git('config', 'user.email', 'ci@example.com')
		this.git('config', 'user.name', 'ci')
		this.commit('initial')
		repos.push(this)
	}

	git(...args: string[]): string {
		return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8' })
	}

	commit(message: string): void {
		this.git('add', '-A')
		this.git('commit', '-q', '-m', message)
	}

	write(file: string, content: string): void {
		const target = path.join(this.cwd, file)
		mkdirSync(path.dirname(target), { recursive: true })
		writeFileSync(target, content)
	}

	/** The snapshot file for the full run, or the one whose name carries `key` for a `--project` run. */
	private snapshotFile(key = ''): string | null {
		const cacheDir = path.join(this.cwd, 'node_modules', '.vite', 'vitest')
		if (!existsSync(cacheDir)) return null
		const files = readdirSync(cacheDir, {
			recursive: true,
			encoding: 'utf8',
		}).filter((file) =>
			key === ''
				? path.basename(file) === SNAPSHOT_FILE
				: /^blacksmith\.[0-9a-f]{12}\.json$/.test(path.basename(file)) &&
					readFileSync(path.join(cacheDir, file), 'utf8').includes(key),
		)
		if (files.length !== 1) return null
		return path.join(cacheDir, files[0] ?? '')
	}

	snapshot(key = ''): Snapshot | null {
		const file = this.snapshotFile(key)
		return file ? (JSON.parse(readFileSync(file, 'utf8')) as Snapshot) : null
	}

	/** Overwrites fields of the stored snapshot, standing in for a snapshot another run produced. */
	patchSnapshot(patch: Record<string, unknown>): void {
		const file = this.snapshotFile()
		if (!file) throw new Error('no snapshot to patch')
		const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<
			string,
			unknown
		>
		writeFileSync(file, JSON.stringify({ ...stored, ...patch }))
	}

	env: Record<string, string> = {}

	run(...args: string[]): Promise<Run> {
		const results = path.join(this.cwd, `results-${this.runs++}.json`)
		return new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					vitestBin,
					'run',
					'--reporter=json',
					`--outputFile=${results}`,
					...args,
				],
				{
					cwd: this.cwd,
					env: {
						PATH: process.env.PATH ?? '',
						HOME: process.env.HOME ?? '',
						CI: 'true',
						...this.env,
					},
				},
			)
			let output = ''
			child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
			child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
			child.on('error', reject)
			child.on('close', (exitCode) => {
				const ran = existsSync(results)
					? (
							JSON.parse(readFileSync(results, 'utf8')) as {
								testResults: { name: string }[]
							}
						).testResults.map((result) =>
							path.basename(result.name, '.test.ts'),
						)
					: []
				resolve({ exitCode: exitCode ?? -1, output, ran: ran.sort() })
			})
		})
	}
}

const repos: Repo[] = []
afterAll(() => {
	for (const repo of repos) rmSync(repo.dir, { recursive: true, force: true })
})

describe('--changed against the tree snapshot', () => {
	let repo: Repo
	beforeAll(() => {
		repo = new Repo('changed')
	})

	test('a full run writes the snapshot, then --changed runs nothing', async () => {
		const first = await repo.run()
		expect(first.exitCode, first.output).toBe(0)
		expect(first.ran).toEqual([...TESTS].sort())
		expect(repo.snapshot()).toMatchObject({
			version: 5,
			head: repo.git('rev-parse', 'HEAD').trim(),
			root: '',
			shard: null,
			tree: { 'src/lib/a.ts': expect.any(String) },
		})

		const second = await repo.run('--changed')
		expect(second.exitCode, second.output).toBe(0)
		expect(second.ran).toEqual([])
	})

	test('a dirty dependency reruns only its dependents', async () => {
		repo.write('src/lib/b.ts', "export const b = 'b' // edited\n")
		const dirty = await repo.run('--changed')
		expect(dirty.ran).toEqual(['three', 'two'])

		expect((await repo.run('--changed')).ran).toEqual([])

		repo.commit('edit b')
		const committed = await repo.run('--changed')
		expect(committed.ran).toEqual([])
		expect(repo.snapshot()?.head).toBe(repo.git('rev-parse', 'HEAD').trim())
	})

	test('a changed fixture reruns the test that read it', async () => {
		repo.write('src/fixtures/five/data.json', '{ "value": "five", "n": 2 }\n')
		const dirty = await repo.run('--changed')
		expect(dirty.exitCode, dirty.output).toBe(0)
		expect(dirty.ran).toEqual(['five'])
		repo.commit('touch fixture')
		expect((await repo.run('--changed')).ran).toEqual([])
	})

	test('every fs specifier records its reads: fs, node:fs, fs/promises, node:fs/promises, require', async () => {
		for (const name of ['a', 'b', 'c', 'd', 'e']) {
			repo.write(
				`src/fixtures/alias/${name}.json`,
				`{ "k": "${name}", "edit": 1 }\n`,
			)
			expect((await repo.run('--changed')).ran, name).toEqual(['alias'])
			repo.commit(`edit ${name}`)
		}
	})

	test('a change to a declared dependency reruns the tests mapped to it', async () => {
		repo.env = { BLACKSMITH_CHANGED: '1' }
		try {
			expect((await repo.run()).ran).toEqual([])
			repo.write('mapped/data.txt', 'v2\n')
			const mapped = await repo.run()
			expect(mapped.exitCode, mapped.output).toBe(0)
			expect(mapped.ran).toEqual(['mapped'])
			expect(mapped.output).toContain('1 test files via dependencies')
			repo.commit('edit mapped data')
			expect((await repo.run()).ran).toEqual([])
		} finally {
			repo.env = {}
		}
	})

	test('the default runAllTests (false) turns --changed on from the config', async () => {
		repo.env = { BLACKSMITH_CHANGED: '1' }
		try {
			expect((await repo.run()).ran).toEqual([])
			repo.write('src/fixtures/five/data.json', '{ "value": "five", "n": 3 }\n')
			const dirty = await repo.run()
			expect(dirty.exitCode, dirty.output).toBe(0)
			expect(dirty.ran).toEqual(['five'])
			expect(dirty.output).not.toContain(
				'does not support running changed tests',
			)
			repo.commit('edit five via plugin changed')
			expect((await repo.run()).ran).toEqual([])
		} finally {
			repo.env = {}
		}
	})

	test('a mode change on a fixture reruns the test that read it', async () => {
		chmodSync(path.join(repo.dir, 'src/fixtures/five/data.json'), 0o755)
		const dirty = await repo.run('--changed')
		expect(dirty.exitCode, dirty.output).toBe(0)
		expect(dirty.ran).toEqual(['five'])
		repo.commit('chmod fixture')
		expect((await repo.run('--changed')).ran).toEqual([])
		expect(repo.snapshot()?.tree['src/fixtures/five/data.json']).toMatch(
			/^100755 [0-9a-f]{40}$/,
		)
	})

	test('a dirty symlink to a directory or a missing target is anchored, not hashed through', async () => {
		symlinkSync('fixtures', path.join(repo.dir, 'src/link-to-dir'))
		symlinkSync('nowhere', path.join(repo.dir, 'src/dangling'))
		repo.write(
			'src/links.test.ts',
			[
				"import { lstatSync } from 'node:fs'",
				"import { expect, test } from 'vitest'",
				"test('links', () => {",
				"	for (const link of ['./link-to-dir', './dangling'])",
				'		expect(lstatSync(new URL(link, import.meta.url)).isSymbolicLink()).toBe(true)',
				'})',
				'',
			].join('\n'),
		)
		const dirty = await repo.run('--changed')
		expect(dirty.exitCode, dirty.output).toBe(0)
		expect(dirty.ran).toEqual(['links'])
		expect(repo.snapshot()?.tree['src/link-to-dir']).toMatch(
			/^120000 [0-9a-f]{40}$/,
		)
		repo.commit('add symlinks')
		const committed = await repo.run('--changed')
		expect(committed.ran).toEqual([])
		expect(
			execFileSync('git', ['ls-tree', 'HEAD', 'src/dangling'], {
				cwd: repo.dir,
				encoding: 'utf8',
			}),
		).toContain(repo.snapshot()?.tree['src/dangling']?.split(' ')[1])
	})

	test('an entry added to a listed directory reruns the test that listed it', async () => {
		repo.write('src/fixtures/six/a.txt', 'a edited\n')
		expect((await repo.run('--changed')).ran).toEqual([])
		repo.commit('edit a')

		repo.write('src/fixtures/six/b.txt', 'b\n')
		const added = await repo.run('--changed')
		expect(added.exitCode, added.output).toBe(0)
		expect(added.ran).toEqual(['six'])
		repo.commit('add b')
		expect((await repo.run('--changed')).ran).toEqual([])
	})

	test('an entry moved within, into or out of a listed directory reruns the test that listed it', async () => {
		repo.write('src/fixtures/six/c.txt', 'c\n')
		repo.commit('add c')
		expect((await repo.run('--changed')).ran).toEqual(['six'])
		repo.git('mv', 'src/fixtures/six/c.txt', 'src/fixtures/six/d.txt')
		expect((await repo.run('--changed')).ran).toEqual(['six'])
		repo.commit('rename within six')
		expect((await repo.run('--changed')).ran).toEqual([])

		repo.git('mv', 'src/fixtures/six/d.txt', 'src/fixtures/five/d.txt')
		expect((await repo.run('--changed')).ran).toEqual(['six'])
		repo.commit('move out of six')
		expect((await repo.run('--changed')).ran).toEqual([])
		repo.git('mv', 'src/fixtures/five/d.txt', 'src/fixtures/six/d.txt')
		expect((await repo.run('--changed')).ran).toEqual(['six'])
		repo.commit('move back into six')
		expect((await repo.run('--changed')).ran).toEqual([])
	})

	test('a moved fixture reruns the test that read it at its old path', async () => {
		repo.git(
			'mv',
			'src/fixtures/five/data.json',
			'src/fixtures/five/moved.json',
		)
		const moved = await repo.run('--changed')
		expect(moved.ran).toEqual(['five'])
		expect(moved.exitCode).toBe(1)
		repo.git(
			'mv',
			'src/fixtures/five/moved.json',
			'src/fixtures/five/data.json',
		)
		expect((await repo.run('--changed')).ran).toEqual([])
	})

	test('renaming a listed directory reruns the test that listed it', async () => {
		repo.git('mv', 'src/fixtures/six', 'src/fixtures/seven')
		const renamed = await repo.run('--changed')
		expect(renamed.ran).toEqual(['six'])
		expect(renamed.exitCode).toBe(1)
		repo.git('mv', 'src/fixtures/seven', 'src/fixtures/six')
		expect((await repo.run('--changed')).ran).toEqual([])
	})

	test('the anchor covers only recorded paths and lockfiles', async () => {
		const tree = repo.snapshot()?.tree ?? {}
		expect(Object.keys(tree)).toContain('src/fixtures/five/data.json')
		expect(tree['src/fixtures/six']).toMatch(/^040000 [0-9a-f]{40}$/)
		expect(Object.keys(tree)).toContain('package-lock.json')
		expect(Object.keys(tree)).not.toContain('src/fixtures/six/a.txt')
		expect(Object.keys(tree)).not.toContain('package.json')
	})

	test('a changed snapshot file reruns its test', async () => {
		repo.write(
			'src/__snapshots__/snap.test.ts.snap',
			'// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html\n\nexports[`snap 1`] = `"hello"`;\n// touched\n',
		)
		repo.commit('touch snapshot')
		expect((await repo.run('--changed')).ran).toEqual(['snap'])
	})

	test('a new test file runs even though nothing it imports changed', async () => {
		repo.write(
			'src/four.test.ts',
			"import { expect, test } from 'vitest'\n\ntest('four', () => expect(1).toBe(1))\n",
		)
		expect((await repo.run('--changed')).ran).toEqual(['four'])
		repo.commit('add four')
		expect((await repo.run('--changed')).ran).toEqual([])
	})

	test('a lockfile change reruns everything', async () => {
		repo.write(
			'package-lock.json',
			'{ "name": "fixture-affected", "lockfileVersion": 3, "x": 1 }\n',
		)
		repo.commit('bump lock')
		const run = await repo.run('--changed')
		expect(run.ran).toEqual([...TESTS, 'four', 'links'].sort())
		expect(run.output).toContain('package-lock.json changed')
	})
})

describe('sharding', () => {
	let repo: Repo
	beforeAll(() => {
		repo = new Repo('shard')
	})

	const owned = (index: number, count: number) =>
		TESTS.filter(
			(name) => shardFor(`src/${name}.test.ts`, count) === index - 1,
		).sort()

	test('shards partition by path hash', async () => {
		const one = await repo.run('--shard=1/2')
		const two = await repo.run('--shard=2/2')
		expect(one.ran).toEqual(owned(1, 2))
		expect(two.ran).toEqual(owned(2, 2))
		expect([...one.ran, ...two.ran].sort()).toEqual([...TESTS].sort())
		expect(repo.snapshot()?.shard).toEqual({ index: 2, count: 2 })
	})

	test("another shard's snapshot is not trusted", async () => {
		const other = await repo.run('--changed', '--shard=1/2')
		expect(other.ran).toEqual(owned(1, 2))
		expect(other.output).toContain('snapshot is for shard 2/2')
		expect(repo.snapshot()?.shard).toEqual({ index: 1, count: 2 })

		expect((await repo.run('--changed', '--shard=1/2')).ran).toEqual([])
		expect((await repo.run('--changed', '--shard=1/3')).output).toContain(
			'snapshot is for shard 1/2',
		)
	})

	test('a changed dependency only reruns dependents the shard owns', async () => {
		await repo.run('--shard=1/2')
		repo.write('src/lib/a.ts', "export const a = 'a' // edited\n")
		const run = await repo.run('--changed', '--shard=1/2')
		expect(run.ran).toEqual(
			owned(1, 2).filter((name) => ['one', 'two'].includes(name)),
		)
	})

	test('a test the snapshot does not vouch for reruns even with its dependencies unchanged', async () => {
		await repo.run('--shard=1/2')
		expect(repo.snapshot()?.tests).toMatchObject({ m: expect.any(Number) })
		const [moved, ...rest] = owned(1, 2)
		repo.patchSnapshot({
			tests: BloomFilter.from(rest.map((name) => `src/${name}.test.ts`)),
		})
		const run = await repo.run('--changed', '--shard=1/2')
		expect(run.output).toContain('0 files changed')
		expect(run.output).toContain('1 test files not covered by it')
		expect(run.ran).toEqual([moved])
		expect((await repo.run('--changed', '--shard=1/2')).ran).toEqual([])
	})
})

describe('snapshot is only written by runs that cover the shard', () => {
	let repo: Repo
	beforeAll(() => {
		repo = new Repo('partial')
	})

	test('name and file filters do not write it, a full run does', async () => {
		await repo.run('-t', 'one')
		expect(repo.snapshot()).toBeNull()
		await repo.run('src/one.test.ts')
		expect(repo.snapshot()).toBeNull()
		await repo.run()
		expect(repo.snapshot()).not.toBeNull()
	})

	test('a file filter combined with --changed does not advance it', async () => {
		const before = repo.snapshot()
		repo.write('src/lib/b.ts', "export const b = 'b' // filtered\n")
		const unaffected = await repo.run('src/one.test.ts', '--changed')
		expect(unaffected.exitCode, unaffected.output).toBe(0)
		expect(unaffected.ran).toEqual([])
		expect(repo.snapshot()).toEqual(before)

		const affected = await repo.run('src/two.test.ts', '--changed')
		expect(affected.exitCode, affected.output).toBe(0)
		expect(affected.ran).toEqual(['two'])
		expect(repo.snapshot()).toEqual(before)

		expect((await repo.run('--changed')).ran).toEqual(['three', 'two'])
	})

	test('a failing run does not advance it', async () => {
		const before = repo.snapshot()
		repo.write(
			'src/lib/a.ts',
			"export const a = 'broken' // fails one and two\n",
		)
		const failing = await repo.run('--changed')
		expect(failing.exitCode).toBe(1)
		expect(failing.ran).toEqual(['one', 'two'])
		expect(repo.snapshot()).toEqual(before)
		expect((await repo.run('--changed')).ran).toEqual(['one', 'two'])
		repo.write('src/lib/a.ts', "export const a = 'a'\n")
	})

	test('a corrupt snapshot file runs everything', async () => {
		const cacheDir = path.join(repo.dir, 'node_modules', '.vite', 'vitest')
		const files = readdirSync(cacheDir, {
			recursive: true,
			encoding: 'utf8',
		}).filter((file) => path.basename(file) === SNAPSHOT_FILE)
		const file = path.join(cacheDir, files[0] ?? '')
		writeFileSync(file, readFileSync(file, 'utf8').slice(0, 40))
		const truncated = await repo.run('--changed')
		expect(truncated.exitCode, truncated.output).toBe(0)
		expect(truncated.ran).toEqual([...TESTS].sort())
		expect(truncated.output).toContain('no dependency snapshot')

		writeFileSync(file, JSON.stringify({ version: 3, head: 'x' }))
		expect((await repo.run('--changed')).ran).toEqual([...TESTS].sort())
		expect((await repo.run('--changed')).ran).toEqual([])
	})

	test('a dirty submodule is hashed by its checked-out commit', async () => {
		const sub = new Repo('submodule-source')
		repo.git(
			'-c',
			'protocol.file.allow=always',
			'submodule',
			'add',
			'-q',
			sub.dir,
			'vendor/sub',
		)
		repo.commit('add submodule')
		const added = await repo.run('--changed')
		expect(added.exitCode, added.output).toBe(0)

		execFileSync(
			'git',
			[
				'-c',
				'user.email=ci@example.com',
				'-c',
				'user.name=ci',
				'commit',
				'-q',
				'--allow-empty',
				'-m',
				'advance',
			],
			{ cwd: path.join(repo.dir, 'vendor', 'sub') },
		)
		expect(repo.git('status', '--porcelain')).toContain('vendor/sub')
		const dirty = await repo.run('--changed')
		expect(dirty.exitCode, dirty.output).toBe(0)
		expect(dirty.ran).toEqual([])
	})
})

describe('vm pools', () => {
	let repo: Repo
	beforeAll(() => {
		repo = new Repo('vm')
	})

	test('reads are charged to the file of the current context', async () => {
		const first = await repo.run('--pool=vmThreads')
		expect(first.exitCode, first.output).toBe(0)
		repo.write('src/fixtures/five/data.json', '{ "value": "five", "vm": 1 }\n')
		expect((await repo.run('--changed', '--pool=vmThreads')).ran).toEqual([
			'five',
		])
	})
})

describe('--project narrows what a snapshot vouches for', () => {
	let repo: Repo
	beforeAll(() => {
		repo = new Repo('projects', 'fixture-projects')
	})

	test('each project set keeps its own anchor', async () => {
		const unit = await repo.run('--project', 'unit')
		expect(unit.exitCode, unit.output).toBe(0)
		expect(repo.snapshot()).toBeNull()
		expect(repo.snapshot('"unit"')).toMatchObject({ projects: ['unit'] })

		const second = await repo.run('--project', 'second', '--changed')
		expect(second.output).toContain('no dependency snapshot')
		expect(second.ran).toEqual(['shared'])
		expect(repo.snapshot('"second"')).toMatchObject({ projects: ['second'] })

		const all = await repo.run('--changed')
		expect(all.output).toContain('no dependency snapshot')
		expect(all.ran).toEqual(['shared', 'shared'])
		expect(repo.snapshot()).toMatchObject({ projects: ['second', 'unit'] })

		expect((await repo.run('--project', 'unit', '--changed')).ran).toEqual([])
		expect((await repo.run('--changed')).ran).toEqual([])
	})
})

/** In-memory stand-in for the Actions cache service's twirp API plus its blob URLs. */
function fakeCacheService(): Promise<{
	server: Server
	url: string
	entries: Map<string, { blob?: Buffer; final: boolean }>
}> {
	const entries = new Map<string, { blob?: Buffer; final: boolean }>()
	const read = (req: import('node:http').IncomingMessage) =>
		new Promise<Buffer>((resolve) => {
			const chunks: Buffer[] = []
			req.on('data', (chunk: Buffer) => chunks.push(chunk))
			req.on('end', () => resolve(Buffer.concat(chunks)))
		})
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://x')
		const body = await read(req)
		const json = (status: number, payload: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' })
			res.end(JSON.stringify(payload))
		}
		const blobUrl = (key: string) =>
			`http://127.0.0.1:${port}/blob/${encodeURIComponent(key)}`
		if (url.pathname.startsWith('/blob/')) {
			const key = decodeURIComponent(url.pathname.slice('/blob/'.length))
			if (req.method === 'PUT') {
				entries.set(key, { blob: body, final: false })
				res.writeHead(201).end()
			} else {
				const blob = entries.get(key)?.blob
				if (!blob) return void res.writeHead(404).end()
				res.writeHead(200).end(blob)
			}
			return
		}
		const method = url.pathname.split('/').pop()
		const request = JSON.parse(body.toString('utf8')) as {
			key: string
			restore_keys?: string[]
			version: string
			size_bytes?: number
		}
		if (method === 'GetCacheEntryDownloadURL') {
			const final = [...entries].filter(([, e]) => e.final).map(([k]) => k)
			const match =
				final.find((k) => k === request.key) ??
				final
					.reverse()
					.find((k) => request.restore_keys?.some((p) => k.startsWith(p)))
			return match
				? json(200, {
						ok: true,
						signed_download_url: blobUrl(match),
						matched_key: match,
					})
				: json(200, { ok: false })
		}
		if (method === 'CreateCacheEntry') {
			return entries.get(request.key)?.final
				? json(200, { ok: false })
				: json(200, { ok: true, signed_upload_url: blobUrl(request.key) })
		}
		if (method === 'FinalizeCacheEntryUpload') {
			const entry = entries.get(request.key)
			if (!entry?.blob || !Number.isInteger(request.size_bytes))
				return json(200, { ok: false })
			if (entry.blob.byteLength !== request.size_bytes)
				return json(422, { msg: 'size mismatch' })
			entry.final = true
			return json(200, { ok: true })
		}
		json(404, { msg: `unknown ${method}` })
	})
	let port = 0
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			port = (server.address() as { port: number }).port
			resolve({ server, url: `http://127.0.0.1:${port}/`, entries })
		})
	})
}

describe('the dependency record travels through the Actions cache', () => {
	// One service per test: entries from one test must not restore into another.
	let cache: Awaited<ReturnType<typeof fakeCacheService>>
	beforeEach(async () => {
		cache = await fakeCacheService()
	})
	afterEach(() => cache.server.close())

	test('a green run saves the record; a fresh checkout restores it and runs only what changed', async () => {
		const producer = new Repo('cache-producer')
		producer.env = { ACTIONS_RESULTS_URL: cache.url }
		const first = await producer.run()
		expect(first.exitCode, first.output).toBe(0)
		expect(first.output).toContain(
			'saved dependency cache blacksmith-vitest-v5-all-1of1-',
		)
		expect([...cache.entries.values()].filter((e) => e.final)).toHaveLength(1)

		const consumer = new Repo('cache-consumer')
		consumer.env = { ACTIONS_RESULTS_URL: cache.url }
		const restored = await consumer.run('--changed')
		expect(restored.exitCode, restored.output).toBe(0)
		expect(restored.output).toContain(
			'restored dependency cache blacksmith-vitest-v5-all-1of1-',
		)
		expect(restored.ran).toEqual([])

		consumer.write(
			'src/fixtures/five/data.json',
			'{ "value": "five", "n": 9 }\n',
		)
		const dirty = await consumer.run('--changed')
		expect(dirty.exitCode, dirty.output).toBe(0)
		expect(dirty.ran).toEqual(['five'])
	})

	test('shadow mode runs everything, reports what the selection would have run, and keeps the cache warm', async () => {
		const producer = new Repo('shadow-producer')
		producer.env = { ACTIONS_RESULTS_URL: cache.url }
		expect((await producer.run()).output).toContain('saved dependency cache')

		const repo = new Repo('shadow')
		repo.env = { ACTIONS_RESULTS_URL: cache.url, BLACKSMITH_SHADOW: '1' }
		// A different HEAD than the producer's, so this run's save gets its own key.
		repo.write('NOTES.md', 'shadow\n')
		repo.commit('notes')
		const clean = await repo.run()
		expect(clean.exitCode, clean.output).toBe(0)
		expect(clean.ran).toEqual([...TESTS].sort())
		expect(clean.output).toMatch(
			/shadow: would have run 0 of \d+ test files \(0 files changed since [0-9a-f]{12}, from blacksmith-vitest-v5-all-1of1-/,
		)
		expect(clean.output).not.toContain('restored dependency cache')
		expect(clean.output).toContain('saved dependency cache')
		expect(existsSync(path.join(repo.dir, 'node_modules/.vite/vitest'))).toBe(
			true,
		)

		repo.write('src/fixtures/five/data.json', '{ "value": "five", "n": 9 }\n')
		const dirty = await repo.run()
		expect(dirty.exitCode, dirty.output).toBe(0)
		expect(dirty.ran).toEqual([...TESTS].sort())
		expect(dirty.output).toMatch(
			/shadow: would have run 1 of \d+ test files \(1 files changed/,
		)

		repo.write(
			'vitest.config.ts',
			readFileSync(path.join(repo.dir, 'vitest.config.ts'), 'utf8') +
				'// touched\n',
		)
		const triggered = await repo.run()
		expect(triggered.exitCode, triggered.output).toBe(0)
		expect(triggered.output).toMatch(
			/shadow: would have run (\d+) of \1 test files \(everything: a changed file matches forceRerunTriggers/,
		)
		repo.commit('config')

		repo.write('src/fixtures/five/data.json', '{ "value": "not five" }\n')
		const failing = await repo.run()
		expect(failing.exitCode).toBe(1)
		expect(failing.output).toContain(
			'shadow: all 1 failed test files were in the selection',
		)
	})

	test('shadow mode without a cache entry says so and still runs everything, even with --changed', async () => {
		const repo = new Repo('shadow-empty')
		repo.env = { ACTIONS_RESULTS_URL: cache.url, BLACKSMITH_SHADOW: '1' }
		const run = await repo.run('--changed')
		expect(run.output).toContain('ignoring --changed')
		expect(run.exitCode, run.output).toBe(0)
		expect(run.ran).toEqual([...TESTS].sort())
		expect(run.output).toContain(
			'shadow: nothing to compare against (no entry under',
		)
	})

	test('a custom sequencer is kept and the selection still applies', async () => {
		const producer = new Repo('custom-sequencer-producer')
		producer.env = { ACTIONS_RESULTS_URL: cache.url }
		expect((await producer.run()).output).toContain('saved dependency cache')

		const repo = new Repo('custom-sequencer')
		repo.env = {
			ACTIONS_RESULTS_URL: cache.url,
			BLACKSMITH_CUSTOM_SEQUENCER: '1',
		}
		const run = await repo.run('--changed')
		expect(run.exitCode, run.output).toBe(0)
		expect(run.output).toContain('restored dependency cache')
		expect(run.ran).toEqual([])
	})

	test('under a custom sequencer a changed test runs on exactly one shard', async () => {
		// Contiguous slicing of only the selected specs would put two.test.ts
		// (hash shard 2/2) on a different shard in each shard's own run.
		const producer = new Repo('custom-shards-producer')
		producer.env = {
			ACTIONS_RESULTS_URL: cache.url,
			BLACKSMITH_CUSTOM_SEQUENCER: '1',
		}
		for (const shard of ['1/2', '2/2']) {
			const run = await producer.run(`--shard=${shard}`)
			expect(run.exitCode, run.output).toBe(0)
			expect(run.output).toContain('saved dependency cache')
		}
		const ran: string[] = []
		for (const shard of ['1/2', '2/2']) {
			const repo = new Repo(`custom-shards-${shard[0]}`)
			repo.env = {
				ACTIONS_RESULTS_URL: cache.url,
				BLACKSMITH_CUSTOM_SEQUENCER: '1',
			}
			repo.write('src/lib/a.ts', "export const a = 'a' // edited\n")
			const run = await repo.run('--changed', `--shard=${shard}`)
			expect(run.exitCode, run.output).toBe(0)
			expect(run.output).toContain('restored dependency cache')
			ran.push(...run.ran)
		}
		expect(ran.sort()).toEqual(['one', 'two'])
	})

	test('a custom cacheDir is where the record is restored to and saved from', async () => {
		const producer = new Repo('cache-custom-producer')
		producer.env = {
			ACTIONS_RESULTS_URL: cache.url,
			BLACKSMITH_CACHE_DIR: 'tmp/vite-cache',
		}
		const first = await producer.run()
		expect(first.exitCode, first.output).toBe(0)
		expect(first.output).toContain('saved dependency cache')
		expect(existsSync(path.join(producer.dir, 'tmp/vite-cache/vitest'))).toBe(
			true,
		)
		expect(existsSync(path.join(producer.dir, 'node_modules/.vite'))).toBe(
			false,
		)

		const consumer = new Repo('cache-custom-consumer')
		consumer.env = {
			ACTIONS_RESULTS_URL: cache.url,
			BLACKSMITH_CACHE_DIR: 'tmp/vite-cache',
		}
		const restored = await consumer.run('--changed')
		expect(restored.output).toContain('restored dependency cache')
		expect(restored.ran).toEqual([])
		expect(existsSync(path.join(consumer.dir, 'node_modules/.vite'))).toBe(
			false,
		)
	})

	test('a record already in cacheDir is left alone, with a warning; a bare directory from another run is not', async () => {
		const producer = new Repo('cache-existing-producer')
		producer.env = { ACTIONS_RESULTS_URL: cache.url }
		expect((await producer.run()).output).toContain('saved dependency cache')

		const repo = new Repo('cache-existing')
		repo.env = { ACTIONS_RESULTS_URL: cache.url }
		// Vitest's cacheDir for an unnamed root project: node_modules/.vite/vitest/<sha1 of ''>.
		const cacheDir = path.join(
			repo.dir,
			'node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709',
		)
		mkdirSync(cacheDir, { recursive: true })
		writeFileSync(path.join(cacheDir, 'results.json'), '{}')
		const bare = await repo.run('--changed')
		expect(bare.exitCode, bare.output).toBe(0)
		expect(bare.output).toContain('restored dependency cache')
		expect(bare.ran).toEqual([])

		const again = await repo.run('--changed')
		expect(again.output).toContain(
			'blacksmith.json already exists, not restoring',
		)
		expect(again.output).not.toContain('restored dependency cache')
	})

	test("another project set's anchor in cacheDir does not block the restore", async () => {
		const producer = new Repo('cache-other-anchor-producer')
		producer.env = { ACTIONS_RESULTS_URL: cache.url }
		expect((await producer.run()).output).toContain('saved dependency cache')

		const repo = new Repo('cache-other-anchor')
		repo.env = { ACTIONS_RESULTS_URL: cache.url }
		const cacheDir = path.join(
			repo.dir,
			'node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709',
		)
		mkdirSync(cacheDir, { recursive: true })
		// What an earlier `vitest run --project other` in the same job leaves behind.
		writeFileSync(path.join(cacheDir, 'blacksmith.0123456789ab.json'), '{}')
		writeFileSync(path.join(cacheDir, 'dependencies.json'), '{}')
		const run = await repo.run('--changed')
		expect(run.exitCode, run.output).toBe(0)
		expect(run.output).toContain('restored dependency cache')
		expect(run.output).not.toContain('not restoring the dependency cache')
	})

	test('under turbo with no cache URL the plugin warns about strict env mode', async () => {
		const repo = new Repo('cache-turbo-strict')
		repo.env = { TURBO_HASH: 'abc' }
		const run = await repo.run()
		expect(run.exitCode, run.output).toBe(0)
		expect(run.output).toContain('hides ACTIONS_RESULTS_URL in strict env mode')
	})

	test('no cache service, no traffic: the run is unchanged', async () => {
		const repo = new Repo('cache-none')
		const run = await repo.run()
		expect(run.exitCode, run.output).toBe(0)
		expect(run.output).not.toContain('dependency cache')
	})
})

describe('packages of one repository keep separate caches', () => {
	let cache: Awaited<ReturnType<typeof fakeCacheService>>
	beforeEach(async () => {
		cache = await fakeCacheService()
	})
	afterEach(() => cache.server.close())

	test("a package never restores the repository root's bundle, only its own", async () => {
		const root = new Repo('cache-root')
		root.env = { ACTIONS_RESULTS_URL: cache.url }
		expect((await root.run()).exitCode).toBe(0)
		expect(root.snapshot()?.root).toBe('')

		const nested = new Repo('cache-nested', 'fixture-affected', 'packages/a')
		nested.env = { ACTIONS_RESULTS_URL: cache.url }
		const first = await nested.run('--changed')
		expect(first.exitCode, first.output).toBe(0)
		expect(first.output).not.toContain('restored dependency cache')
		expect(first.ran).toEqual([...TESTS].sort())
		expect(nested.snapshot()?.root).toBe('packages/a')
		const keys = [...cache.entries]
			.filter(([, entry]) => entry.final)
			.map(([key]) => key.split('-').slice(0, 4).join('-'))
		expect(keys).toHaveLength(2)
		expect(new Set(keys).size).toBe(2)

		const again = new Repo('cache-nested-2', 'fixture-affected', 'packages/a')
		again.env = { ACTIONS_RESULTS_URL: cache.url }
		const restored = await again.run('--changed')
		expect(restored.exitCode, restored.output).toBe(0)
		expect(restored.output).toContain('restored dependency cache')
		expect(restored.ran).toEqual([])
	})

	test("a snapshot written for another package's root runs everything", async () => {
		const repo = new Repo('root-mismatch')
		expect((await repo.run()).exitCode).toBe(0)
		repo.patchSnapshot({ root: 'packages/b' })
		const run = await repo.run('--changed')
		expect(run.output).toContain(
			'dependency snapshot is for packages/b, this run is for the repository root',
		)
		expect(run.ran).toEqual([...TESTS].sort())
	})
})

describe('a project with its own root', () => {
	let repo: Repo
	beforeAll(() => {
		repo = new Repo('rooted')
		repo.env = { BLACKSMITH_ROOTED_PROJECT: '1', BLACKSMITH_CHANGED: '1' }
	})

	test("selects from the provider vitest loaded, not the re-evaluated config's copy", async () => {
		const first = await repo.run()
		expect(first.exitCode, first.output).toBe(0)
		expect(first.ran).toEqual(['five', 'one'])
		expect(first.output).not.toContain('does not support running changed tests')
		expect((await repo.run()).ran).toEqual([])
		repo.write('src/fixtures/five/data.json', '{ "value": "five", "n": 4 }\n')
		const dirty = await repo.run()
		expect(dirty.exitCode, dirty.output).toBe(0)
		expect(dirty.ran, dirty.output).toEqual(['five'])
	})
})
