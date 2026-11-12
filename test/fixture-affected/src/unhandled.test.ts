import { expect, test } from 'vitest'

// Passes on its own; with BLACKSMITH_UNHANDLED=1 it leaves a rejection no one
// handles, which fails the run after every module has passed.
test('unhandled', async () => {
	expect(1).toBe(1)
	if (process.env.BLACKSMITH_UNHANDLED === '1') {
		Promise.reject(new Error('nobody handles this'))
		await new Promise((resolve) => setImmediate(resolve))
	}
})
