import { readdir } from 'node:fs/promises'

import { expect, test } from 'vitest'

test('six', async () => {
	const names = await readdir(new URL('./fixtures/six/', import.meta.url))
	expect(names).toContain('a.txt')
})
