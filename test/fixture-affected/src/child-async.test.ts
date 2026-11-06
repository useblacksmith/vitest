import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { expect, test } from 'vitest'

// Through `promisify`, whose custom form for `execFile` must still reach the
// wrapped function.
test('child-async', async () => {
	const { stdout } = await promisify(execFile)(process.execPath, [
		'src/scripts/child-script.mjs',
	])
	expect(stdout).toContain('lib')
	expect(stdout).toContain('data')
})
