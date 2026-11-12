import { Worker } from 'node:worker_threads'

import { expect, test } from 'vitest'

// The script, what it imports and what it reads run in another thread with
// its own `fs`; `terminate()` ends it without an `exit` event in the thread.
test('worker', async () => {
	const worker = new Worker(
		new URL('./scripts/worker-script.mjs', import.meta.url),
	)
	const message = await new Promise<string>((resolve, reject) => {
		worker.once('message', resolve)
		worker.once('error', reject)
	})
	expect(message).toContain('worker')
	expect(message).toContain('data')
	await worker.terminate()
})
