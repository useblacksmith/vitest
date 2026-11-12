import { server } from './child-server-lib.mjs'

// Stays up until the test kills it, so it never reaches `exit`.
process.stdout.write(`up ${server}\n`)
setInterval(() => {}, 1000)
