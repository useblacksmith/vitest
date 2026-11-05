import { describe, expect, test } from 'vitest'

import { BloomFilter } from '../src/bloom.ts'

const keys = (count: number, prefix = 'src/') =>
	Array.from({ length: count }, (_, i) => `${prefix}${i}.test.ts`)

describe('BloomFilter', () => {
	test('never misses a member, and a JSON round trip preserves membership', () => {
		const members = keys(5000)
		const filter = BloomFilter.from(members)
		expect(members.every((key) => filter.has(key))).toBe(true)
		const parsed = BloomFilter.parse(JSON.parse(JSON.stringify(filter)))
		expect(parsed).not.toBeNull()
		expect(members.every((key) => parsed?.has(key))).toBe(true)
	})

	test('sized for ~1e-9 false positives: ~43 bits per entry, none among 200k strangers', () => {
		const filter = BloomFilter.from(keys(5000))
		expect(filter.m / 5000).toBeCloseTo(43.1, 0)
		expect(filter.k).toBe(30)
		expect(keys(200_000, 'other/').filter((key) => filter.has(key))).toEqual([])
	})

	test('an empty set vouches for nothing', () => {
		const filter = BloomFilter.from([])
		expect(filter.has('src/one.test.ts')).toBe(false)
	})

	test('rejects malformed input', () => {
		expect(BloomFilter.parse(null)).toBeNull()
		expect(BloomFilter.parse({ m: 8, k: 1 })).toBeNull()
		expect(BloomFilter.parse({ m: 8, k: 1, bits: 'AAAA' })).toBeNull()
		expect(BloomFilter.parse({ m: 0, k: 1, bits: '' })).toBeNull()
		expect(BloomFilter.parse({ m: 8, k: 1, bits: 'AA==' })).not.toBeNull()
	})
})
