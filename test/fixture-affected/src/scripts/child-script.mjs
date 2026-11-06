import { readFileSync } from 'node:fs'

import { lib } from './child-lib.mjs'

const data = readFileSync(
	new URL('../fixtures/child/data.txt', import.meta.url),
	'utf8',
)
process.stdout.write(`${lib} ${data}`)
