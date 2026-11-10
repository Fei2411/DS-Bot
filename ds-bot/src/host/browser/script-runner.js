// Runs a browser_exec body away from the host process. The model writes the body,
// and a page can talk the model into writing anything, so it must not run with the
// host's Node: it would reach secrets.json, the network and every Bot's files with no
// approval card. See script-child.js for what the body can and cannot reach.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SCRIPT_TIMEOUT = 20_000
const CHILD = fileURLToPath(new URL('./script-child.js', import.meta.url))

// The child sees none of the host's environment (keys, tokens, DSH_HOME). Windows needs
// SystemRoot to start a process; the desktop app's host is Electron run as Node, and so
// must the child be.
function childEnv() {
  const env = {}
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

// helpers: name → async function on the host. Only JSON crosses in either direction.
export function runIsolatedScript(body, helpers, { timeout = SCRIPT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let child
    const end = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child?.exitCode === null && child.signalCode === null) child.kill()
      settle(value)
    }
    // kill() stops a script that never yields, which a Promise.race cannot.
    const timer = setTimeout(() => end(reject, new Error(`Script ran longer than ${timeout / 1000} seconds.`)), timeout)
    try {
      child = fork(CHILD, [], {
        // The host's flags (loaders, --expose-internals) are not the child's.
        execArgv: ['--max-old-space-size=128'],
        env: childEnv(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json',
        windowsHide: true,
      })
    } catch (error) {
      end(reject, new Error(`Could not start the script: ${error?.message ?? error}`))
      return
    }
    const send = message => {
      try { child.send(message) } catch {}
    }
    child.on('message', async (message) => {
      // Messages already queued when the run ended still arrive; none may act.
      if (settled) return
      if (message?.type === 'done') {
        if (typeof message.error === 'string') end(reject, new Error(message.error))
        else if (typeof message.answer === 'string' || message.answer === null) end(resolve, message.answer)
        else end(reject, new Error('Script produced an answer that is not text.'))
        return
      }
      if (message?.type !== 'call' || typeof message.name !== 'string' || typeof message.args !== 'string') return
      let reply
      try {
        if (!Object.hasOwn(helpers, message.name)) throw new Error(`${message.name} is not a browser helper.`)
        const args = JSON.parse(message.args)
        const value = await helpers[message.name](...(Array.isArray(args) ? args : []))
        const json = JSON.stringify(value)
        reply = { id: message.id, ok: true, value: json === undefined ? null : json }
      } catch (error) {
        reply = { id: message.id, ok: false, error: String(error?.message ?? error) }
      }
      if (!settled) send(reply)
    })
    child.on('error', error => end(reject, new Error(`Script stopped: ${error?.message ?? error}`)))
    child.on('exit', (code, signal) => end(reject, new Error(`Script stopped before it finished (${signal ?? `exit ${code}`}).`)))
    send({ type: 'start', body, names: Object.keys(helpers), wait: timeout })
  })
}
