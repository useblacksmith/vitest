import { expect, test } from 'vitest'

import { double } from './lib/math.ts'

test('doubles', () => {
	expect(double(2)).toBe('shared: 4')
})
