export type TestStatus = 'passed' | 'failed' | 'skipped'

export interface TestError {
	message: string
	stack: string
}

export interface TestResultRecord {
	/** Test file, relative to the repository when the run is inside GITHUB_WORKSPACE */
	file: string
	/** Vitest project the test ran in; null for the root project */
	project: string | null
	/** Enclosing describe blocks, outermost first */
	suite: string[]
	name: string
	status: TestStatus
	/** null for tests that never ran (skipped, todo) */
	duration_ms: number | null
	started_at: string | null
	retries: number
	flaky: boolean
	error?: TestError
}

/** A failure outside any test: a module that threw while being imported or collected, or an unhandled error */
export interface RunError {
	/** null when the error is not attributable to a test file */
	file: string | null
	message: string
	stack: string
}

export interface Payload {
	framework: 'vitest'
	framework_version: string
	reporter_version: string
	run: {
		started_at: string
		finished_at: string
		reason: 'passed' | 'failed' | 'interrupted'
	}
	results: TestResultRecord[]
	errors: RunError[]
	/** true when results or errors beyond the count or byte caps were dropped */
	truncated: boolean
}

export const MAX_RESULTS = 50_000
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
export const MAX_ERROR_MESSAGE_CHARS = 4_096
export const MAX_ERROR_STACK_CHARS = 16_384

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Keeps results in order until either cap is hit, then errors in whatever
 * budget is left, so a payload never serializes past MAX_PAYLOAD_BYTES of
 * JSON (the gzip input, which is also the backend's memory ceiling).
 */
export function buildPayload(
	results: TestResultRecord[],
	errors: RunError[],
	run: Payload['run'],
	versions: { framework: string; reporter: string },
	maxBytes = MAX_PAYLOAD_BYTES,
): Payload {
	let bytes = 0
	let truncated = false
	const keep = <T>(items: T[], max: number): T[] => {
		const kept: T[] = []
		for (const item of items) {
			const size = JSON.stringify(item).length + 1
			if (kept.length >= max || bytes + size > maxBytes) {
				truncated = true
				break
			}
			bytes += size
			kept.push(item)
		}
		return kept
	}
	const keptResults = keep(results, MAX_RESULTS)
	const keptErrors = keep(errors, MAX_RESULTS)
	return {
		framework: 'vitest',
		framework_version: versions.framework,
		reporter_version: versions.reporter,
		run,
		results: keptResults,
		errors: keptErrors,
		truncated,
	}
}
