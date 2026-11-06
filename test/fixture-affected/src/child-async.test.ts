import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import { expect, test } from 'vitest'

// `exec` with a shell command string, through `promisify`, which the wrapped
// function must still support.
test('child-async', async () => {
	const { stdout } = await promisify(exec)(
		`"${process.execPath}" src/scripts/child-script.mjs`,
	)
	expect(stdout).toContain('lib')
	expect(stdout).toContain('data')
})
