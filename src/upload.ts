import { gzipSync } from 'node:zlib'

export const REQUEST_TIMEOUT_MS = 10_000
export const ATTEMPTS = 3
export const BACKOFF_MS = [1_000, 2_000]

export type UploadOutcome =
	| { ok: true; status: number; bytes: number }
	| { ok: false; status: number | null; error: string }

/**
 * One gzipped bearer POST, retried on network errors and 5xx only; a 4xx is
 * final because the same body would be rejected again.
 */
export async function upload(
	url: string,
	token: string,
	userAgent: string,
	json: string,
	sleep: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<UploadOutcome> {
	const body = gzipSync(json)
	let last: UploadOutcome = { ok: false, status: null, error: 'not attempted' }
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 0)
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
					'content-encoding': 'gzip',
					'user-agent': userAgent,
				},
				body,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			})
			if (response.ok) {
				return { ok: true, status: response.status, bytes: body.byteLength }
			}
			last = {
				ok: false,
				status: response.status,
				error: `HTTP ${response.status}`,
			}
			if (response.status < 500) return last
		} catch (error) {
			last = {
				ok: false,
				status: null,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	}
	return last
}
