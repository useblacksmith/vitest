import { afterEach, describe, expect, test } from 'vitest'

import { FakeBackend, runFixture } from './harness.ts'

let backend: FakeBackend | undefined

afterEach(async () => {
	await backend?.stop()
	backend = undefined
})

function credentials(url: string): Record<string, string> {
	return {
		BLACKSMITH_BACKEND_URL: `${url}/`,
		BLACKSMITH_JOB_HISTORY_TOKEN: 'test-token',
	}
}

describe('reporting', () => {
	test('sends every outcome and duration in one gzipped bearer request', async () => {
		backend = await new FakeBackend().start()
		const run = await runFixture(credentials(backend.url))

		expect(run.exitCode, run.output).toBe(1)
		expect(run.output).toContain(
			'[blacksmith] reported 6 test results 1 errors',
		)
		expect(backend.requests).toHaveLength(1)

		const [request] = backend.requests
		expect(request!.path).toBe('/api/jobs/test-results')
		expect(request!.headers.authorization).toBe('Bearer test-token')
		expect(request!.headers['content-encoding']).toBe('gzip')
		expect(request!.headers['content-type']).toBe('application/json')
		expect(request!.headers['user-agent']).toMatch(/^blacksmith-vitest\/\d/)

		const { payload } = request!
		expect(payload.framework).toBe('vitest')
		expect(payload.framework_version).toMatch(/^\d+\.\d+\.\d+/)
		expect(payload.run.reason).toBe('failed')
		expect(Date.parse(payload.run.finished_at)).toBeGreaterThanOrEqual(
			Date.parse(payload.run.started_at),
		)
		expect(payload.truncated).toBe(false)
		expect(payload.errors).toHaveLength(1)
		expect(payload.errors[0]).toMatchObject({
			file: 'test/fixture/src/broken.test.ts',
			message: 'top-level boom',
		})
		expect(payload.errors[0]!.stack).toContain('broken.test.ts')

		const byName = new Map(payload.results.map((r) => [r.name, r]))
		expect([...byName.keys()].sort()).toEqual([
			'fails',
			'flaky',
			'passes',
			'skipped',
			'todo',
			'top-level',
		])

		const passes = byName.get('passes')!
		expect(passes).toMatchObject({
			file: 'test/fixture/src/outcomes.test.ts',
			project: null,
			suite: ['outer', 'inner'],
			status: 'passed',
			retries: 0,
			flaky: false,
		})
		expect(passes.duration_ms).toBeGreaterThanOrEqual(0)
		expect(Date.parse(passes.started_at!)).not.toBeNaN()
		expect(passes.error).toBeUndefined()

		const fails = byName.get('fails')!
		expect(fails.status).toBe('failed')
		expect(fails.error?.message).toContain('expected { a: 1 } to deeply equal')
		expect(fails.error?.stack).toContain('outcomes.test.ts')

		expect(byName.get('skipped')).toMatchObject({
			suite: ['outer'],
			status: 'skipped',
			duration_ms: null,
			started_at: null,
		})
		expect(byName.get('todo')!.status).toBe('skipped')

		expect(byName.get('flaky')).toMatchObject({
			status: 'passed',
			retries: 2,
			flaky: true,
		})
		expect(byName.get('flaky')!.error).toBeUndefined()

		const topLevel = byName.get('top-level')!
		expect(topLevel.file).toBe('test/fixture/src/other.test.ts')
		expect(topLevel.suite).toEqual([])
		expect(topLevel.duration_ms).toBeGreaterThanOrEqual(15)
	})

	test('names the project of each result and reports once when the root config carries the reporter', async () => {
		backend = await new FakeBackend().start()
		const run = await runFixture(credentials(backend.url), 'fixture-projects')

		expect(run.exitCode, run.output).toBe(0)
		expect(backend.requests).toHaveLength(1)
		const { payload } = backend.requests[0]!
		expect(
			payload.results.map((r) => [r.project, r.file, r.status]).sort(),
		).toEqual([
			['second', 'test/fixture-projects/src/shared.test.ts', 'passed'],
			['unit', 'test/fixture-projects/src/shared.test.ts', 'passed'],
		])
		expect(payload.run.reason).toBe('passed')
	})

	test('the plugin alone reports nothing, even with the runner credentials', async () => {
		backend = await new FakeBackend().start()
		const run = await runFixture(credentials(backend.url), 'fixture-affected')

		expect(run.exitCode, run.output).toBe(0)
		expect(run.output).not.toContain('[blacksmith] reported')
		expect(backend.requests).toHaveLength(0)
	})

	test('does nothing without the runner credentials', async () => {
		backend = await new FakeBackend().start()
		const run = await runFixture({ BLACKSMITH_BACKEND_URL: backend.url })

		expect(run.exitCode).toBe(1)
		expect(run.output).not.toContain('[blacksmith]')
		expect(backend.requests).toHaveLength(0)
	})

	test('retries server errors, then gives up without changing the run outcome', async () => {
		backend = await new FakeBackend([500, 503, 502]).start()
		const run = await runFixture(credentials(backend.url))

		expect(run.exitCode).toBe(1)
		expect(backend.requests).toHaveLength(3)
		expect(run.output).toContain(
			'[blacksmith] could not report test results: HTTP 502',
		)
	})

	test('does not retry a rejected request', async () => {
		backend = await new FakeBackend([401]).start()
		const run = await runFixture(credentials(backend.url))

		expect(backend.requests).toHaveLength(1)
		expect(run.output).toContain(
			'[blacksmith] could not report test results: HTTP 401',
		)
	})

	test('an unreachable backend is a warning, not a failure', async () => {
		const run = await runFixture(credentials('http://127.0.0.1:9'))

		expect(run.exitCode).toBe(1)
		expect(run.output).toContain('[blacksmith] could not report test results:')
	})
})
