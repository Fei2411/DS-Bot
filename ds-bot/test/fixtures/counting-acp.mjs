// The fake ACP agent, leaving a line in the file named by its argument each time
// it starts, so a test can count how many CLIs a code path started.
import { appendFileSync } from 'node:fs'

appendFileSync(process.argv[2], 'started\n')
await import('./fake-acp.mjs')
