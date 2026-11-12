import { readFileSync } from 'node:fs'
import { parentPort } from 'node:worker_threads'

import { worker } from './worker-lib.mjs'

const data = readFileSync(
	new URL('../fixtures/worker/data.txt', import.meta.url),
	'utf8',
)
parentPort.postMessage(`${worker} ${data}`)
// Stays alive until the test terminates it, so it never reaches `exit`.
setInterval(() => {}, 1000)
