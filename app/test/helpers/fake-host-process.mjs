// The Host of the app, as a test double: it reports a launch URL and counts how often it was
// started, so that a test can see that no second Host was started.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './fake-electron.mjs'

// The port the app gave the Host: the launch URL is on the Host's own address.
const port = () => {
  try {
    return String(JSON.parse(readFileSync(join(paths.userData, 'host-port.json'), 'utf8')).port)
  } catch {
    return '43117'
  }
}

let gate
let open

export const state = {
  starts: 0,
  stops: 0,
  fail: false,
  // The Host waits for the test to let it answer.
  held: false,
  release: () => { if (open !== undefined) { open(); open = undefined } },
}

/** Keep the Host waiting until the test lets it answer. */
export const hold = () => {
  state.held = true
  gate = new Promise((done) => { open = done })
}

export class HostProcess {
  #options
  #messageListeners = new Set()

  constructor(options) { this.#options = options }

  async start() {
    state.starts += 1
    if (state.held) await gate
    if (state.fail) throw new Error('the Host did not start')
    return { url: `http://127.0.0.1:${port()}/?token=test-token`, injections: [] }
  }

  onMessage(listener) { this.#messageListeners.add(listener); return () => this.#messageListeners.delete(listener) }

  send() {}

  async stop() { state.stops += 1 }
}
