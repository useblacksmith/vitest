import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { expect, test } from 'vitest'

// Through `promisify`, whose custom form for `execFile` must still reach the
// wrapped function.
test('child-async', async () => {
	const pending = promisify(execFile)(process.execPath, [
		'src/scripts/child-script.mjs',
	])
	expect(pending.child.pid).toBeGreaterThan(0)
	const { stdout } = await pending
	expect(stdout).toContain('lib')
	expect(stdout).toContain('data')
})
