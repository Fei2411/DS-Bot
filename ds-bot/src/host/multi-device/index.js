// The module's public surface. The plugin loads tools.js (see index.js) when the profile
// turns multiDevice on; cli.js runs a hub or a worker as a separate process for debugging.
export { createHub, PROTOCOL, VERSION } from './hub.js'
export { createWorker } from './worker.js'
export { ALLOWED_PROGRAMS, checkCommand, describePolicy } from './policy.js'
export { install, deviceTools, multiDeviceOptions } from './tools.js'
