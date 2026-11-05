import { createRequire } from 'node:module'
import path from 'node:path'
import type {
	Reporter,
	SerializedError,
	TestCase,
	TestModule,
	TestRunEndReason,
	Vitest,
} from 'vitest/node'

import {
	buildPayload,
	MAX_ERROR_MESSAGE_CHARS,
	MAX_ERROR_STACK_CHARS,
	truncate,
	type RunError,
	type TestResultRecord,
	type TestStatus,
} from './payload.js'
import { upload } from './upload.js'

export const ENV_BACKEND_URL = 'BLACKSMITH_BACKEND_URL'
export const ENV_TOKEN = 'BLACKSMITH_JOB_HISTORY_TOKEN'
export const RESULTS_PATH = '/api/jobs/test-results'

/**
 * Marks a reporter as ours across package copies: a workspace whose root and
 * project resolve two installs of this package has two `BlacksmithReporter`
 * classes, and `instanceof` would let both register.
 */
export const REPORTER_BRAND = Symbol.for('@useblacksmith/vitest:reporter')

export function isBlacksmithReporter(reporter: unknown): boolean {
	return (
		typeof reporter === 'object' &&
		reporter !== null &&
		REPORTER_BRAND in reporter
	)
}

const { version: reporterVersion } = createRequire(import.meta.url)(
	'../package.json',
) as { version: string }

/**
 * Sends every test's outcome and duration to Blacksmith in one request when
 * the run ends. Does nothing unless the runner injected BLACKSMITH_BACKEND_URL
 * and BLACKSMITH_JOB_HISTORY_TOKEN, and never changes the run's outcome.
 */
export class BlacksmithReporter implements Reporter {
	readonly [REPORTER_BRAND] = true
	private vitest!: Vitest
	private startedAt = new Date()

	onInit(vitest: Vitest): void {
		this.vitest = vitest
	}

	onTestRunStart(): void {
		this.startedAt = new Date()
	}

	async onTestRunEnd(
		testModules: ReadonlyArray<TestModule>,
		unhandledErrors: ReadonlyArray<SerializedError>,
		reason: TestRunEndReason,
	): Promise<void> {
		const backendUrl = process.env[ENV_BACKEND_URL]
		const token = process.env[ENV_TOKEN]
		if (!backendUrl || !token) return

		try {
			await this.report(backendUrl, token, testModules, unhandledErrors, reason)
		} catch (error) {
			this.vitest.logger.warn(
				`[blacksmith] could not report test results: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private async report(
		backendUrl: string,
		token: string,
		testModules: ReadonlyArray<TestModule>,
		unhandledErrors: ReadonlyArray<SerializedError>,
		reason: TestRunEndReason,
	): Promise<void> {
		const workspace = process.env.GITHUB_WORKSPACE
		const results = collectResults(testModules, workspace)
		const errors = [
			...collectModuleErrors(testModules, workspace),
			...unhandledErrors.map((error) => toRunError(null, error)),
		]
		if (results.length === 0 && errors.length === 0) return

		const payload = buildPayload(
			results,
			errors,
			{
				started_at: this.startedAt.toISOString(),
				finished_at: new Date().toISOString(),
				reason,
			},
			{ framework: this.vitest.version, reporter: reporterVersion },
		)
		const outcome = await upload(
			`${backendUrl.replace(/\/+$/, '')}${RESULTS_PATH}`,
			token,
			`blacksmith-vitest/${reporterVersion}`,
			JSON.stringify(payload),
		)
		if (!outcome.ok) {
			throw new Error(outcome.error)
		}
		const counts = [
			`${payload.results.length} test results`,
			payload.errors.length > 0 ? `${payload.errors.length} errors` : '',
			payload.truncated ? '(truncated)' : '',
		]
		this.vitest.logger.log(
			`[blacksmith] reported ${counts.filter(Boolean).join(' ')}`,
		)
	}
}

export function collectResults(
	testModules: ReadonlyArray<TestModule>,
	workspace: string | undefined,
): TestResultRecord[] {
	const records: TestResultRecord[] = []
	for (const testModule of testModules) {
		const file = relativeFile(testModule, workspace)
		const project = testModule.project.name || null
		for (const testCase of testModule.children.allTests()) {
			const result = testCase.result()
			if (result.state === 'pending') continue
			records.push(toRecord(testCase, file, project, result.state))
		}
	}
	return records
}

/** Errors a module raised while being imported or collected, outside any test (a syntax error, a top-level throw). */
export function collectModuleErrors(
	testModules: ReadonlyArray<TestModule>,
	workspace: string | undefined,
): RunError[] {
	const errors: RunError[] = []
	for (const testModule of testModules) {
		const file = relativeFile(testModule, workspace)
		for (const error of testModule.errors()) {
			errors.push(toRunError(file, error))
		}
	}
	return errors
}

/**
 * Paths are repo-relative when the test file is inside the checkout (a
 * monorepo package's vitest root is not the repo root), else Vitest's
 * root-relative id.
 */
function relativeFile(
	testModule: TestModule,
	workspace: string | undefined,
): string {
	if (workspace) {
		const relative = path.relative(workspace, testModule.moduleId)
		if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
			return relative.split(path.sep).join('/')
		}
	}
	return testModule.relativeModuleId
}

function toRecord(
	testCase: TestCase,
	file: string,
	project: string | null,
	status: TestStatus,
): TestResultRecord {
	const diagnostic = testCase.diagnostic()
	const record: TestResultRecord = {
		file,
		project,
		suite: suiteChain(testCase),
		name: testCase.name,
		status,
		duration_ms: diagnostic?.duration ?? null,
		started_at: diagnostic
			? new Date(diagnostic.startTime).toISOString()
			: null,
		retries: diagnostic?.retryCount ?? 0,
		flaky: diagnostic?.flaky ?? false,
	}
	const error = status === 'failed' ? testCase.result().errors?.[0] : undefined
	if (error) {
		record.error = {
			message: truncate(error.message ?? '', MAX_ERROR_MESSAGE_CHARS),
			stack: truncate(error.stack ?? '', MAX_ERROR_STACK_CHARS),
		}
	}
	return record
}

function toRunError(file: string | null, error: SerializedError): RunError {
	return {
		file,
		message: truncate(error.message ?? '', MAX_ERROR_MESSAGE_CHARS),
		stack: truncate(error.stack ?? '', MAX_ERROR_STACK_CHARS),
	}
}

function suiteChain(testCase: TestCase): string[] {
	const chain: string[] = []
	for (
		let parent = testCase.parent;
		parent.type === 'suite';
		parent = parent.parent
	) {
		chain.unshift(parent.name)
	}
	return chain
}
