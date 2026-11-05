import { readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

// Reads that fail before they reach a file still land in vitest's dependency
// record: a component longer than NAME_MAX and a NUL byte.
for (const name of [`${'n'.repeat(300)}.json`, 'nul\0.json']) {
	try {
		readFileSync(
			new URL(`./fixtures/five/${encodeURIComponent(name)}`, import.meta.url),
			'utf8',
		)
	} catch {}
}

const data = JSON.parse(
	readFileSync(new URL('./fixtures/five/data.json', import.meta.url), 'utf8'),
) as { value: string }

test('five', () => expect(data.value).toBe('five'))
