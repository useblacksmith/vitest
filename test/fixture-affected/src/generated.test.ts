import { readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

// src/generated/ is git-ignored, like a build step's output or .env.local.
const data = JSON.parse(
	readFileSync(new URL('./generated/value.json', import.meta.url), 'utf8'),
) as { value: string }

test('generated', () => expect(data.value).toBe('generated'))
