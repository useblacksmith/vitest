import { readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

const data = JSON.parse(
	readFileSync(new URL('./fixtures/five/data.json', import.meta.url), 'utf8'),
) as { value: string }

test('five', () => expect(data.value).toBe('five'))
