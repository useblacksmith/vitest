import { expect, test } from 'vitest'

test('top-level', async () => {
	await new Promise((resolve) => setTimeout(resolve, 20))
	expect(true).toBe(true)
})
