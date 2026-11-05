import { expect, test } from 'vitest'

import {
	buildPayload,
	MAX_RESULTS,
	truncate,
	type RunError,
	type TestResultRecord,
} from '../src/payload.ts'

const record = (i: number): TestResultRecord => ({
	file: 'a.test.ts',
	project: null,
	suite: [],
	name: `t${i}`,
	status: 'passed',
	duration_ms: 1,
	started_at: null,
	retries: 0,
	flaky: false,
})

const run = {
	started_at: '2026-01-01T00:00:00.000Z',
	finished_at: '2026-01-01T00:00:01.000Z',
	reason: 'passed' as const,
}
const versions = { framework: '5', reporter: '0' }

test('keeps the first MAX_RESULTS results and flags the rest as dropped', () => {
	const results = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => record(i))
	const payload = buildPayload(results, [], run, versions)
	expect(payload.results).toHaveLength(MAX_RESULTS)
	expect(payload.results.at(-1)!.name).toBe(`t${MAX_RESULTS - 1}`)
	expect(payload.truncated).toBe(true)
})

test('stops adding results once their JSON would pass the byte budget', () => {
	const results = Array.from({ length: 100 }, (_, i) => ({
		...record(i),
		error: { message: 'x'.repeat(1000), stack: '' },
	}))
	const oneRecord = JSON.stringify(results[0]).length + 1
	const payload = buildPayload(results, [], run, versions, oneRecord * 10)
	expect(payload.results).toHaveLength(10)
	expect(payload.errors).toEqual([])
	expect(payload.truncated).toBe(true)
	expect(JSON.stringify(payload.results).length).toBeLessThanOrEqual(
		oneRecord * 10 + 2,
	)
})

test('errors share the budget after results and survive a run with no tests', () => {
	const errors: RunError[] = [
		{ file: 'broken.test.ts', message: 'boom', stack: 'Error: boom' },
	]
	const payload = buildPayload([], errors, run, versions)
	expect(payload.results).toEqual([])
	expect(payload.errors).toEqual(errors)
	expect(payload.truncated).toBe(false)
})

test('a batch under the caps is not truncated', () => {
	const payload = buildPayload([record(0)], [], run, versions)
	expect(payload.truncated).toBe(false)
	expect(payload.framework).toBe('vitest')
})

test('truncate marks a cut string and leaves short ones alone', () => {
	expect(truncate('abc', 5)).toBe('abc')
	expect(truncate('abcdef', 3)).toBe('abc…')
})
