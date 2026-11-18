import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	CHILD_RECORD_ENV,
	Outputs,
	WRITE_PREFIX,
	isIgnored,
	wrapFs,
} from './fs-recorder.ts'

/**
 * Preloaded (`--import`) into every node process and worker thread a test
 * starts: records the modules it loads and the files it reads or writes, and
 * appends them to a file of its own in the directory the test's recorder named in the
 * environment. Children of the child inherit the environment and report there too.
 */
const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const nodeModule = require('node:module') as typeof import('node:module')
const workerThreads =
	require('node:worker_threads') as typeof import('node:worker_threads')
const dir = process.env[CHILD_RECORD_ENV]
const output = dir
	? path.join(dir, `${process.pid}-${workerThreads.threadId}.txt`)
	: undefined

if (output) {
	// Our own bookkeeping must not count as a read.
	const { openSync, writeSync } = fs
	let fd: number | undefined
	const lines = new Set<string>()
	const outputs = new Outputs()
	// Written on the spot, not batched or left to `exit`: a signal
	// (`child.kill()`) or `worker.terminate()` can end this process or thread
	// at any point, with no `exit` event and no later tick.
	const report = (line: string) => {
		if (lines.has(line)) return
		lines.add(line)
		try {
			fd ??= openSync(output, 'a')
			writeSync(fd, `${line}\n`)
		} catch {}
	}
	const record = (file: string, content = true) => {
		const absolute = path.resolve(file)
		if (isIgnored(absolute) || !outputs.reads(absolute, content)) return
		report(absolute)
	}
	wrapFs(fs, record, (file) => {
		const absolute = path.resolve(file)
		if (isIgnored(absolute) || !outputs.writes(absolute)) return
		report(WRITE_PREFIX + absolute)
	})
	// A loader preloaded before this one (tsx) may already hold the ESM
	// namespace of `node:fs`; resync so its named imports see the wrappers.
	syncBuiltinESMExports()
	// Node 22.15+: every ESM and CJS resolution, including through loaders such as tsx.
	if (typeof nodeModule.registerHooks === 'function') {
		nodeModule.registerHooks({
			resolve(specifier, context, next) {
				const result = next(specifier, context)
				if (result.url.startsWith('file:')) {
					try {
						record(fileURLToPath(result.url))
					} catch {}
				}
				return result
			},
		})
	}
	process.on('exit', function blacksmithRecordChild() {
		const script = process.argv[1]
		if (script) record(script)
		for (const id of Object.keys(require.cache)) record(id)
	})
}
