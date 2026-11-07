// The Bot tools of LAN multi-device: a Bot lists the paired machines and runs one
// allowlisted command on the machine whose role fits the task. The hub that serves those
// tools runs inside the plugin process on the center machine; the worker stays a separate
// process on the other machine (cli.js), so a Windows PC needs no DSH install.
import { homedir, hostname as localHostname } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from '../tools.js'
import { createHub } from './hub.js'
import { checkCommand, describePolicy } from './policy.js'

const DEFAULT_PORT = 8787
const DEFAULT_WAIT_MS = 20_000
const MAX_WAIT_MS = 55_000
const TERMINAL = new Set(['done', 'failed', 'rejected', 'timeout', 'cancelled'])

const isTerminal = state => TERMINAL.has(state)

// The hub's settings. They are always available: the Devices page can turn the hub
// on later, and a profile that only names `multiDevice: true` gets the defaults. A
// profile that says `multiDevice: false` keeps the switch out of reach.
export function multiDeviceOptions(config = {}) {
  const raw = config.multiDevice
  const options = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const dataDir = typeof options.dataDir === 'string' && options.dataDir !== ''
    ? options.dataDir
    : String(process.env.DSBOT_LAN_DATA ?? join(homedir(), '.ds-bot', 'multi-device'))
  return {
    dataDir,
    host: typeof options.host === 'string' && options.host !== '' ? options.host : '0.0.0.0',
    port: Number.isInteger(options.port) ? options.port : DEFAULT_PORT,
    name: typeof options.name === 'string' && options.name !== '' ? options.name : localHostname(),
  }
}

// What the Bot writes about a finished task: the output first, so it can be read as is,
// and one line of context after it.
function formatResult(task) {
  const result = task.result ?? {}
  const lines = [`[${task.nodeName}] ${task.argv.join(' ')} — ${task.state}, exit ${result.exitCode ?? '?'}${Number.isFinite(result.durationMs) ? `, ${result.durationMs} ms` : ''}`]
  if (result.rejected === true) lines.push('The machine refused this command: it is not on the worker allowlist.')
  if (result.stdout) lines.push(result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout)
  if (result.stderr) lines.push(`stderr: ${result.stderr.endsWith('\n') ? result.stderr.slice(0, -1) : result.stderr}`)
  if (result.stdout === '' && result.stderr === '') lines.push('(no output)')
  if (result.truncated === true) lines.push('The output was truncated.')
  return lines.join('\n')
}

function formatPending(task) {
  return `[${task.nodeName}] ${task.argv.join(' ')} — ${task.state}. The task is still running; ask for device_task ${task.id} to read its result.`
}

const seenText = node => (node.lastSeen === undefined ? 'never seen' : `last seen ${node.lastSeen}`)

function machineText(node) {
  const os = [node.os, node.arch].filter(Boolean).join('/')
  const host = node.hostname === undefined ? '' : `, host ${node.hostname}`
  return `${os === '' ? 'unknown OS' : os}${host}`
}

// The Web UI of this DSH serves the same Bot session the Bot is talking in; another
// machine opens that page instead of starting its own team. The origin is read on every
// list call because the Web server comes up after the plugin loads.
function sharedOriginOf(ctx) {
  try {
    const origin = ctx.get?.('webServer')?.getOrigin?.()
    return typeof origin === 'string' && origin !== '' ? origin : undefined
  } catch {
    return undefined
  }
}

/**
 * The four Bot tools over one hub. `hub` is the hub, or a getter for it when the
 * plugin starts and stops the hub at run time. `ready` is the hub's start promise,
 * so a call made while the listener is still binding waits for it, and a failed
 * start reaches the Bot as a plain explanation instead of a task that would never
 * leave the queue.
 */
export function deviceTools({ hub, ready = Promise.resolve({ ok: true }), sharedOrigin = () => undefined }) {
  const current = typeof hub === 'function' ? hub : () => hub
  const waitReady = typeof ready === 'function' ? ready : () => ready
  const unavailable = async () => {
    const state = await waitReady()
    if (state.ok === true) return undefined
    if (current() === undefined) {
      return `The LAN hub is not running on this machine: ${state.error}. The user can turn multi-device on in Settings → Devices, then try again.`
    }
    return `The LAN hub is not running on this machine: ${state.error}. No paired machine can be reached until it starts; tell the user, and do not retry this call in this turn.`
  }
  const tools = []

  const nodeNamed = (nodes, reference) => nodes.find(node => node.id === reference || node.name === reference)

  tools.push(defineTool({
    name: 'list_devices',
    description: 'List the user\'s other machines that are paired with this one over the local network, with their online state and operating system. Call it before run_on_device, and choose the machine whose OS, host or role fits the task: the user does not pick a machine for you. When nothing is paired, ask for a pairing code with device_pairing_code.',
    parameters: {},
    output,
    async execute() {
      const reason = await unavailable()
      if (reason !== undefined) return reason
      const nodes = current().nodes()
      const online = nodes.filter(node => node.online).length
      const lines = [`LAN multi-device: ${nodes.length} paired machine${nodes.length === 1 ? '' : 's'}, ${online} online.`]
      for (const node of nodes) {
        lines.push(`- ${node.name}${node.online ? ' (online)' : ' (offline)'} — ${machineText(node)}, ${seenText(node)}${node.id === undefined ? '' : `, id ${node.id}`}`)
      }
      if (nodes.length === 0) lines.push('No machine is paired yet. Ask the user to run the worker on the other machine with a pairing code; call device_pairing_code for one.')
      lines.push(`Every machine runs only: ${describePolicy().join(', ')}. No shell and no other program.`)
      const origin = sharedOrigin()
      lines.push(origin === undefined
        ? 'The same chat is served by this machine only; to open it on another machine, see docs/plans/966-lan-multi-device.md.'
        : `Shared chat: this machine serves the same Bot session at ${origin}. Another machine opens that page (over the LAN or a port forward) instead of starting its own team.`)
      return lines.join('\n')
    },
  }))

  tools.push(defineTool({
    name: 'run_on_device',
    description: 'Run one allowlisted read-only command on a paired machine and return its stdout, stderr and exit code. Choose node yourself from list_devices; the user does not choose per call. Commands are an argument list, never a shell line: ["hostname"], ["whoami"], ["uname", "-a"], ["echo", "hello world"]. The worker refuses anything outside its allowlist.',
    parameters: {
      node: { type: 'string', required: true, description: 'Exact machine name or id from list_devices' },
      argv: { type: 'array', required: true, items: { type: 'string' }, description: 'Program and arguments as separate strings, for example ["echo", "hello from the Mac"]' },
      timeoutMs: { type: 'integer', description: 'How long the command may run on the machine, 1000 to 300000; default 30000' },
      waitMs: { type: 'integer', description: 'How long this call waits for the result, up to 55000; default 20000. When it is still running, device_task reads it later' },
    },
    output,
    async execute(args) {
      const reason = await unavailable()
      if (reason !== undefined) return reason
      const hubHere = current()
      const nodes = hubHere.nodes()
      const target = nodeNamed(nodes, String(args.node ?? ''))
      if (target === undefined) {
        const known = nodes.map(node => node.name)
        return `No machine named ${args.node}. Paired machines: ${known.length === 0 ? 'none' : known.join(', ')}.`
      }
      if (!target.online) {
        const online = nodes.filter(node => node.online).map(node => node.name)
        return `${target.name} is offline (${seenText(target)}), so this command did not run. Online machines: ${online.length === 0 ? 'none' : online.join(', ')}. Ask the user to start the worker there.`
      }
      const argv = Array.isArray(args.argv) ? args.argv : []
      const check = checkCommand(argv)
      if (!check.ok) return `Not run: ${check.reason}. On a machine the allowed commands are ${describePolicy().join(', ')}.`
      let task
      try {
        task = hubHere.dispatch({ node: target.id, argv, timeoutMs: args.timeoutMs })
      } catch (error) {
        return `Not run: ${error.message}`
      }
      const wanted = Number.isInteger(args.waitMs) ? Math.min(Math.max(args.waitMs, 0), MAX_WAIT_MS) : DEFAULT_WAIT_MS
      if (wanted === 0) return formatPending(task)
      const settled = await hubHere.waitForTask(task.id, { timeoutMs: wanted }).catch(() => undefined)
      return settled === undefined ? formatPending(hubHere.task(task.id) ?? task) : formatResult(settled)
    },
  }))

  tools.push(defineTool({
    name: 'device_task',
    description: 'Read the state and result of a task that run_on_device started on another machine, for example one that was still running when run_on_device returned.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id from run_on_device, such as tk_1a2b3c4d5e6f' },
      waitMs: { type: 'integer', description: 'How long to wait for the result, up to 55000; default 0, read the state now' },
    },
    output,
    async execute(args) {
      const reason = await unavailable()
      if (reason !== undefined) return reason
      const hubHere = current()
      const task = hubHere.task(String(args.task_id ?? ''))
      if (task === undefined) return `No task ${args.task_id} is known on this hub.`
      const wanted = Number.isInteger(args.waitMs) ? Math.min(Math.max(args.waitMs, 0), MAX_WAIT_MS) : 0
      if (isTerminal(task.state) || wanted === 0) return isTerminal(task.state) ? formatResult(task) : formatPending(task)
      const settled = await hubHere.waitForTask(task.id, { timeoutMs: wanted }).catch(() => undefined)
      return settled === undefined ? formatPending(hubHere.task(task.id) ?? task) : formatResult(settled)
    },
  }))

  tools.push(defineTool({
    name: 'device_pairing_code',
    description: 'Make a one-use pairing code for one more machine on the local network, and give the user the exact worker command to run there. Call it only when the user asks to add a machine. The code works once, for five minutes, and is shown in this chat: the user reads it to the other machine.',
    parameters: {},
    output,
    async execute() {
      const reason = await unavailable()
      if (reason !== undefined) return reason
      const hubHere = current()
      const issued = hubHere.issueCode()
      return [
        `Pairing code: ${issued.code} (one machine, one use, valid until ${issued.expiresAt}).`,
        'On the other machine, in ds-bot/, run:',
        `npm run lan:worker -- --hub ${hubHere.url} --code ${issued.code} --name windows-pc`,
        'After that the worker keeps its token; the code cannot be used again. It is for the user: do not send it anywhere else, and do not save it to memory or a file.',
      ].join('\n')
    },
  }))

  return tools
}

export function install(rt) {
  const { ctx } = rt
  const options = multiDeviceOptions(rt.config)
  // `multiDevice: false` is a hard off: the profile keeps the switch out of reach.
  // Otherwise the profile only decides the first start; after that the value the user
  // saved in Settings → Devices wins, so a switch turned off stays off after a restart.
  const profileOff = rt.config.multiDevice === false
  const profileOn = rt.config.multiDevice === true
    || (rt.config.multiDevice !== null && typeof rt.config.multiDevice === 'object' && !Array.isArray(rt.config.multiDevice))
  let enabled = false
  let phase = 'off'
  let failure
  let hub
  let ready = Promise.resolve({ ok: false, error: 'multi-device is off on this computer' })
  let starting

  const status = () => ({
    available: profileOff !== true,
    configured: profileOn,
    enabled,
    hub: {
      state: phase,
      ...(failure === undefined ? {} : { error: failure }),
      ...(phase !== 'listening' || hub === undefined ? {} : { port: hub.port, url: hub.url, localUrl: `http://127.0.0.1:${hub.port}` }),
      ...(sharedOriginOf(ctx) === undefined ? {} : { webUrl: sharedOriginOf(ctx) }),
      name: options.name,
    },
    nodes: hub === undefined ? [] : hub.nodes(),
    policy: describePolicy(),
  })

  const addTools = () => {
    for (const def of deviceTools({ hub: () => hub, ready: () => ready, sharedOrigin: () => sharedOriginOf(ctx) })) {
      if (rt.teamTools.some(tool => tool.name === def.name)) continue
      if (typeof rt.addTeamTool === 'function') rt.addTeamTool(def)
      else rt.teamTools.push(def)
    }
  }
  const removeTools = () => {
    for (const name of ['list_devices', 'run_on_device', 'device_task', 'device_pairing_code']) {
      if (typeof rt.removeTeamTool === 'function') rt.removeTeamTool(name)
      else {
        const at = rt.teamTools.findIndex(tool => tool.name === name)
        if (at !== -1) rt.teamTools.splice(at, 1)
      }
    }
  }

  const startHub = () => {
    if (starting !== undefined) return starting
    if (hub !== undefined && phase === 'listening') return ready
    starting = (async () => {
      // A hub whose bind failed is thrown away and made again, so a switch turned off
      // and on retries the port instead of returning the old failure. Its stop is
      // awaited: it saves the node registry, which must not land on the new hub's file.
      const old = hub
      hub = undefined
      rt.multiDeviceHub = undefined
      if (old !== undefined) await old.stop().catch(() => {})
      phase = 'starting'
      failure = undefined
      try {
        // The plugin runs the hub, so the shortest path is one process. The CLI can also
        // read the same data folder (nodes.json, admin.token) while this hub runs.
        hub = createHub({ ...options, log: () => {} })
      } catch (error) {
        hub = undefined
        phase = 'failed'
        failure = error.message
        ready = Promise.resolve({ ok: false, error: error.message })
        rt.warn('ds-bot: the LAN multi-device hub could not be created: %s', error.message)
        return { ok: false, error: error.message }
      }
      rt.multiDeviceHub = hub
      ready = hub.start()
        .then(() => {
          phase = 'listening'
          failure = undefined
          return { ok: true }
        })
        .catch((error) => {
          // The pairing code is made later, on request; only the bind failure is logged.
          phase = 'failed'
          failure = error.message
          rt.warn('ds-bot: the LAN multi-device hub did not start: %s', error.message)
          return { ok: false, error: error.message }
        })
      return ready
    })().finally(() => { starting = undefined })
    return starting
  }

  const stopHub = async () => {
    const current = hub
    hub = undefined
    rt.multiDeviceHub = undefined
    // A start still binding settles first; its `.then` would otherwise set the phase
    // back to listening after this stop began.
    if (starting !== undefined) await starting.catch(() => {})
    if (current !== undefined) await current.stop()
    phase = 'off'
    failure = undefined
    ready = Promise.resolve({ ok: false, error: 'multi-device is off on this computer' })
  }

  const setEnabled = async (value) => {
    const next = value === true
    if (next && profileOff) throw new Error('Multi-device is turned off in this computer\'s profile configuration (multiDevice: false).')
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    await rt.load()
    if (enabled !== next) {
      rt.state.multiDevice ??= {}
      rt.state.multiDevice.enabled = next
      await rt.save()
      enabled = next
      if (next) addTools()
      else removeTools()
    }
    if (next) await startHub()
    else await stopHub()
    return status()
  }

  const pairingCode = () => {
    if (!enabled) throw new Error('Multi-device is off on this computer. Turn it on in Settings → Devices first.')
    if (hub === undefined || phase !== 'listening') {
      throw new Error(`The hub is not listening on this computer${failure === undefined ? '' : `: ${failure}`}.`)
    }
    const issued = hub.issueCode()
    return {
      code: issued.code,
      expiresAt: issued.expiresAt,
      ttlMs: issued.ttlMs,
      hubUrl: hub.url,
      command: `npm run lan:worker -- --hub ${hub.url} --code ${issued.code} --name other-pc`,
      policy: describePolicy(),
    }
  }

  const removeNode = async (reference) => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    await rt.load()
    if (hub === undefined) throw new Error('The hub is not running on this computer.')
    if (hub.removeNode(String(reference ?? '')) !== true) throw new Error(`No paired machine named ${reference}.`)
    return status()
  }

  Object.defineProperty(rt, 'multiDeviceEnabled', { get: () => enabled, configurable: true })
  Object.defineProperty(rt, 'multiDeviceError', { get: () => failure, configurable: true })
  Object.assign(rt, {
    multiDeviceStatus: status,
    multiDeviceSetEnabled: setEnabled,
    multiDevicePairingCode: pairingCode,
    multiDeviceRemoveNode: removeNode,
    multiDeviceView: status,
  })

  // The saved choice is read once the team file is loaded; the profile only supplies
  // the default while the user has never used the switch.
  const boot = (async () => {
    try {
      await rt.load()
    } catch (error) {
      rt.warn('ds-bot: the LAN multi-device switch could not be read: %s', error.message)
    }
    if (profileOff) return
    const stored = rt.state?.multiDevice?.enabled
    enabled = typeof stored === 'boolean' ? stored : profileOn
    if (!enabled) return
    addTools()
    await startHub()
  })()
  rt.multiDeviceReady = boot.then(() => ready)

  ctx.effect(() => () => { void stopHub() }, 'ds-bot: LAN multi-device hub')
}
