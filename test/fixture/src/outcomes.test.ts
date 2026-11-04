import { describe, expect, test } from 'vitest'

let attempts = 0

describe('outer', () => {
	describe('inner', () => {
		test('passes', () => {
			expect(1).toBe(1)
		})
		test('fails', () => {
			expect({ a: 1 }).toEqual({ a: 2 })
		})
	})
	test.skip('skipped', () => {})
	test.todo('todo')
	test('flaky', { retry: 2 }, () => {
		attempts++
		if (attempts < 3) throw new Error(`boom ${attempts}`)
	})
})
