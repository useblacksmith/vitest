import { spawnSync } from 'node:child_process'

import { expect, test } from 'vitest'

// The script, what it imports and what it reads are only visible through the
// child process; none of them are imported here.
test('child', () => {
	const result = spawnSync(process.execPath, ['src/scripts/child-script.mjs'], {
		encoding: 'utf8',
	})
	expect(result.status, result.stderr).toBe(0)
	expect(result.stdout).toContain('lib')
	expect(result.stdout).toContain('data')
})
