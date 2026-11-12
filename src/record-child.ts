import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHILD_RECORD_ENV, isIgnored, wrapReads } from './fs-recorder.ts'

/**
 * Preloaded (`--import`) into every node process and worker thread a test
 * starts: records the modules it loads and the files it reads, and appends
 * them to the file the test's recorder named in the environment. Children of
 * the child inherit the environment and append to the same file.
 */
const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const nodeModule = require('node:module') as typeof import('node:module')
const output = process.env[CHILD_RECORD_ENV]

if (output) {
	// Our own bookkeeping must not count as a read.
	const { openSync, writeSync } = fs
	let fd: number | undefined
	const paths = new Set<string>()
	// Written on the spot, not batched or left to `exit`: a signal
	// (`child.kill()`) or `worker.terminate()` can end this process or thread
	// at any point, with no `exit` event and no later tick.
	const record = (file: string) => {
		const absolute = path.resolve(file)
		if (isIgnored(absolute) || paths.has(absolute)) return
		paths.add(absolute)
		try {
			fd ??= openSync(output, 'a')
			writeSync(fd, `${absolute}\n`)
		} catch {}
	}
	wrapReads(fs, record)
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
