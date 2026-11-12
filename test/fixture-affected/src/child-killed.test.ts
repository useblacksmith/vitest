import { spawn, type ChildProcess } from 'node:child_process'

import { afterAll, expect, test } from 'vitest'

let child: ChildProcess | undefined

// Killed after the test, not awaited: the common shape for a server a test
// stands up. SIGTERM gives the child no `exit` event.
afterAll(() => {
	child?.kill()
})

test('child-killed', async () => {
	child = spawn(process.execPath, ['src/scripts/child-server.mjs'], {
		stdio: ['ignore', 'pipe', 'inherit'],
	})
	const up = await new Promise<string>((resolve) =>
		child?.stdout?.once('data', (chunk: Buffer) => resolve(chunk.toString())),
	)
	expect(up).toContain('server')
})
