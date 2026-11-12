import { expect, test } from 'vitest'

// Fails only when asked to, with no input of its own changing.
test('flaky', () => {
	expect(process.env.BLACKSMITH_FLAKY).not.toBe('1')
})
