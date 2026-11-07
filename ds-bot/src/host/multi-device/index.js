// The module's public surface. The plugin does not load it yet; v0 is run from the CLI
// (see cli.js) so a hub and a worker are separate processes on two machines.
export { createHub, PROTOCOL, VERSION } from './hub.js'
export { createWorker } from './worker.js'
export { ALLOWED_PROGRAMS, checkCommand, describePolicy } from './policy.js'
