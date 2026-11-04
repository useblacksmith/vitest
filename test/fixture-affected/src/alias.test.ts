import { createRequire } from 'node:module'
import fsDefault from 'fs'
import { readFileSync as readNode } from 'node:fs'
import { readFile as readPromises } from 'fs/promises'
import * as nodePromises from 'node:fs/promises'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const dir = new URL('./fixtures/alias/', import.meta.url)

test('alias', async () => {
	expect(
		JSON.parse(fsDefault.readFileSync(new URL('a.json', dir), 'utf8')).k,
	).toBe('a')
	expect(JSON.parse(readNode(new URL('b.json', dir), 'utf8')).k).toBe('b')
	expect(JSON.parse(await readPromises(new URL('c.json', dir), 'utf8')).k).toBe(
		'c',
	)
	expect(
		JSON.parse(await nodePromises.readFile(new URL('d.json', dir), 'utf8')).k,
	).toBe('d')
	expect(
		JSON.parse(require('fs').readFileSync(new URL('e.json', dir), 'utf8')).k,
	).toBe('e')
})
