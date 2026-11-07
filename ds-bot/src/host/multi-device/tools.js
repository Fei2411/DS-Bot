// The Bot tools of LAN multi-device: a Bot lists the paired machines and runs one
// allowlisted command on the machine whose role fits the task. The hub that serves those
// tools runs inside the plugin process on the center machine; the worker stays a separate
// process on the other machine (cli.js), so a Windows PC needs no DSH install.
import { homedir, hostname as localHostname } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from '../tools.js'
import { createHub } from './hub.js'
import { daemonCommand } from './daemon.js'
import { APPROVED_NOTE, classifyCommand, describePolicy } from './policy.js'
import { MAX_FILE_BYTES, taskLabel } from './protocol.js'
import { bestDevice, hintedDevice } from './select.js'
import { createSessionSync } from './session-sync.js'

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
    requireApprovalForReads: options.requireApprovalForReads === true,
  }
}

// What the Bot writes about a finished task: the output first, so it can be read as is,
// and one line of context after it. `payload` says whether a file body is shown: a read
// shows text but points at device_transfer for binary, a transfer shows the body itself.
function formatResult(task, { payload = 'auto' } = {}) {
  const result = task.result ?? {}
  const lines = [`[${task.nodeName}] ${taskLabel(task)} — ${task.state}, exit ${result.exitCode ?? '?'}${Number.isFinite(result.durationMs) ? `, ${result.durationMs} ms` : ''}`]
  if (result.rejected === true) lines.push('The machine refused this task; it was not run (see below).')
  if (result.stdout) lines.push(result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout)
  if (result.stderr) lines.push(`stderr: ${result.stderr.endsWith('\n') ? result.stderr.slice(0, -1) : result.stderr}`)
  if (result.file !== undefined) {
    const file = result.file
    lines.push(`${file.size ?? '?'} bytes, ${file.mime ?? 'unknown type'}${file.truncated ? ', truncated' : ''}`)
    if (payload === 'none' || (payload === 'auto' && file.encoding !== 'utf8')) {
      lines.push(file.encoding === 'utf8'
        ? 'The file body is not shown here.'
        : 'Binary content is not shown here; use device_transfer with direction "get" to bring it over.')
    } else {
      lines.push(file.encoding === 'utf8' ? (file.data.endsWith('\n') ? file.data.slice(0, -1) : file.data) : `base64:\n${file.data}`)
    }
  }
  if (result.stdout === '' && result.stderr === '' && result.file === undefined) lines.push('(no output)')
  if (result.truncated === true) lines.push('The output was truncated.')
  return lines.join('\n')
}

function formatPending(task) {
  return `[${task.nodeName}] ${taskLabel(task)} — ${task.state}. The task is still running; ask for device_task ${task.id} to read its result.`
}

const seenText = node => (node.lastSeen === undefined ? 'never seen' : `last seen ${node.lastSeen}`)

// Online machines with their OS, so a Bot that hit an offline one can pick again from
// the same answer instead of asking the user which of the others is which.
const onlineText = nodes => {
  const online = nodes.filter(node => node.online)
  return online.length === 0 ? 'none' : online.map(node => `${node.name} (${node.os ?? 'unknown OS'})`).join(', ')
}

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
 * The Bot tools over one hub. `hub` is the hub, or a getter for it when the plugin
 * starts and stops the hub at run time. `ready` is the hub's start promise,
 * so a call made while the listener is still binding waits for it, and a failed
 * start reaches the Bot as a plain explanation instead of a task that would never
 * leave the queue. `approval` is the DSH approval service: a write, or any command
 * outside the read-only list, waits on its card before anything is dispatched.
 */
export function deviceTools({ hub, ready = Promise.resolve({ ok: true }), sharedOrigin = () => undefined, approval, requireApprovalForReads = false }) {
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

  const askApproval = async (exec, { tool, reason, zh }) => {
    const service = typeof approval === 'function' ? approval() : approval
    if (service?.request === undefined || exec?.agent?.session === undefined) {
      return { ok: false, message: 'Not done: this needs the user\'s approval, and there is no approval card here, so nothing was sent to the machine. Ask the user to do it, or turn the action into a read-only one.' }
    }
    let outcome
    try {
      outcome = await service.request({
        agent: exec.agent,
        toolName: exec.name ?? tool,
        ...(exec.callId === undefined ? {} : { callId: exec.callId }),
        reason,
        displayReason: { en: reason, zh },
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
    } catch {
      return { ok: false, message: 'Not done: the approval service was unavailable, so nothing was sent to the machine.' }
    }
    if (outcome === 'allowed-once') return { ok: true }
    if (outcome === 'rejected') return { ok: false, message: 'Not done: the user did not approve this, so nothing was sent to the machine. Do not try again unless the user asks.' }
    if (outcome === 'cancelled') return { ok: false, message: 'Not done: the approval was cancelled, so nothing was sent to the machine.' }
    return { ok: false, message: 'Not done: the approval could not be answered, so nothing was sent to the machine.' }
  }

  const waitFor = async (hubHere, task, waitMs, options) => {
    const wanted = Number.isInteger(waitMs) ? Math.min(Math.max(waitMs, 0), MAX_WAIT_MS) : DEFAULT_WAIT_MS
    if (wanted === 0) return formatPending(task)
    const settled = await hubHere.waitForTask(task.id, { timeoutMs: wanted }).catch(() => undefined)
    return settled === undefined ? formatPending(hubHere.task(task.id) ?? task) : formatResult(settled, options)
  }

  tools.push(defineTool({
    name: 'list_devices',
    description: 'List the user\'s other machines that are paired with this one over the local network, with their online state, operating system and hostname. Call it before run_on_device, device_read_file, device_write_file or device_transfer, and choose the machine whose OS, host, path style or role fits the task: the user does not pick a machine for you. A Windows path (C:\\..., \\\\share, .exe) points at a Windows machine; /Users/..., /Applications or /Volumes points at a macOS machine. Never send a task to an offline machine: use an online one instead or say none fits.',
    parameters: {
      hint: { type: 'string', description: 'Optional words from the user\'s request or a path, used to name the best matching online machine' },
    },
    output,
    async execute(args = {}) {
      const reason = await unavailable()
      if (reason !== undefined) return reason
      const nodes = current().nodes()
      const online = nodes.filter(node => node.online).length
      const lines = [`LAN multi-device: ${nodes.length} paired machine${nodes.length === 1 ? '' : 's'}, ${online} online.`]
      for (const node of nodes) {
        lines.push(`- ${node.name}${node.online ? ' (online)' : ' (offline)'} — ${machineText(node)}, ${seenText(node)}${node.id === undefined ? '' : `, id ${node.id}`}`)
      }
      if (nodes.length === 0) lines.push('No machine is paired yet. Ask the user to run the worker on the other machine with a pairing code; call device_pairing_code for one.')
      lines.push(`Read-only commands run directly: ${describePolicy().join(', ')}. ${APPROVED_NOTE}`)
      lines.push('Choose an online machine: a Windows path (C:\\..., .exe) means win32; /Users/..., /Applications or .app means darwin; a hostname in the request names that machine.')
      const hinted = typeof args.hint === 'string' ? args.hint : ''
      const suggestion = hinted === '' ? undefined : hintedDevice(nodes, hinted)
      if (suggestion !== undefined) lines.push(`Best match for "${hinted.slice(0, 120)}": ${suggestion.name}${suggestion.online ? '' : ' (offline, so it cannot be used now)'}.`)
      const origin = sharedOrigin()
      lines.push(origin === undefined
        ? 'The same chat is served by this machine only; to open it on another machine, see docs/plans/966-lan-multi-device.md.'
        : `Shared chat: this machine serves the same Bot session at ${origin}. Another machine opens that page (over the LAN or a port forward) instead of starting its own team.`)
      return lines.join('\n')
    },
  }))

  tools.push(defineTool({
    name: 'run_on_device',
    description: 'Run one command on a paired machine and return its stdout, stderr and exit code. Choose node yourself from list_devices by OS, hostname and the paths in the request; the user does not choose per call. Commands are an argument list, never a shell line: ["hostname"], ["uname", "-a"], ["ls", "-la", "."], ["python", "script.py"]. Read-only commands (hostname, whoami, uname, echo, pwd, ls, dir) run directly; any other program shows the user an approval card first, and is not dispatched if they refuse. For reading or writing a file, prefer device_read_file, device_write_file and device_transfer.',
    parameters: {
      node: { type: 'string', required: true, description: 'Exact machine name or id from list_devices' },
      argv: { type: 'array', required: true, items: { type: 'string' }, description: 'Program and arguments as separate strings, for example ["echo", "hello from the Mac"]' },
      timeoutMs: { type: 'integer', description: 'How long the command may run on the machine, 1000 to 300000; default 30000' },
      waitMs: { type: 'integer', description: 'How long this call waits for the result, up to 55000; default 20000. When it is still running, device_task reads it later' },
    },
    output,
    async execute(args, exec) {
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
        const argv = Array.isArray(args.argv) ? args.argv : []
        const alternative = bestDevice(nodes, argv.join(' '))
        return `${target.name} is offline (${seenText(target)}), so this command did not run. Online machines: ${onlineText(nodes)}.${alternative === undefined ? '' : ` ${alternative.name} (${alternative.os ?? 'unknown OS'}) looks like the best online match.`} Ask the user to start the worker there if no online machine fits.`
      }
      const argv = Array.isArray(args.argv) ? args.argv : []
      const check = classifyCommand(argv)
      if (!check.ok) return `Not run: ${check.reason}.`
      let approved = false
      if (!check.safe) {
        const ask = await askApproval(exec, {
          tool: 'run_on_device',
          reason: `Run "${argv.join(' ')}" on ${target.name}? This program is outside the read-only list, so it can change things there.`,
          zh: `允许在 ${target.name} 上运行“${argv.join(' ')}”吗？它不在只读命令列表里，可能会改动那台机器。`,
        })
        if (!ask.ok) return ask.message
        approved = true
      }
      let task
      try {
        task = hubHere.dispatch({ node: target.id, kind: 'shell', argv, approved, timeoutMs: args.timeoutMs })
      } catch (error) {
        return `Not run: ${error.message}`
      }
      return waitFor(hubHere, task, args.waitMs)
    },
  }))

  const runFileTask = async (exec, { node, spec, waitMs, label }) => {
    const reason = await unavailable()
    if (reason !== undefined) return reason
    const hubHere = current()
    const nodes = hubHere.nodes()
    const target = nodeNamed(nodes, String(node ?? ''))
    if (target === undefined) {
      const known = nodes.map(entry => entry.name)
      return `No machine named ${node}. Paired machines: ${known.length === 0 ? 'none' : known.join(', ')}.`
    }
    if (!target.online) {
      const alternative = bestDevice(nodes, String(spec.path ?? ''))
      return `${target.name} is offline (${seenText(target)}), so nothing was sent. Online machines: ${onlineText(nodes)}.${alternative === undefined ? '' : ` ${alternative.name} (${alternative.os ?? 'unknown OS'}) looks like the best online match for this path.`}`
    }
    let task
    try {
      task = hubHere.dispatch({ node: target.id, ...spec })
    } catch (error) {
      return `Not run: ${error.message}`
    }
    return waitFor(hubHere, task, waitMs, label === undefined ? undefined : { payload: label })
  }

  tools.push(defineTool({
    name: 'device_read_file',
    description: `Read a file on a paired machine and return its text, or its type and size when it is binary (up to ${MAX_FILE_BYTES} bytes). This is read-only and runs without an approval card. A relative path is under that machine's worker workspace; an absolute path is the one the user gave. Choose node from list_devices by OS and path style.`,
    parameters: {
      node: { type: 'string', required: true, description: 'Exact machine name or id from list_devices' },
      path: { type: 'string', required: true, description: 'Absolute path on that machine, or a path relative to its worker workspace' },
      maxBytes: { type: 'integer', description: `How much of the file to read, up to ${MAX_FILE_BYTES}; default ${MAX_FILE_BYTES}` },
      waitMs: { type: 'integer', description: 'How long to wait for the result, up to 55000; default 20000' },
    },
    output,
    async execute(args, exec) {
      if (requireApprovalForReads) {
        const ask = await askApproval(exec, {
          tool: 'device_read_file',
          reason: `Read ${args.path} on ${args.node}?`,
          zh: `允许读取 ${args.node} 上的 ${args.path} 吗？`,
        })
        if (!ask.ok) return ask.message
      }
      return runFileTask(exec, {
        node: args.node,
        spec: { kind: 'read_file', path: args.path, maxBytes: args.maxBytes },
        waitMs: args.waitMs,
      })
    },
  }))

  tools.push(defineTool({
    name: 'device_write_file',
    description: `Write a file on a paired machine. This always shows the user an approval card first, and nothing is sent if they refuse. Content is text, or base64 when encoding is "base64"; at most ${MAX_FILE_BYTES} bytes. A relative path is under that machine's worker workspace.`,
    parameters: {
      node: { type: 'string', required: true, description: 'Exact machine name or id from list_devices' },
      path: { type: 'string', required: true, description: 'Absolute path on that machine, or a path relative to its worker workspace' },
      content: { type: 'string', required: true, description: 'The file content; text, or base64 with encoding "base64"' },
      encoding: { type: 'string', description: 'utf8 (default) or base64' },
      waitMs: { type: 'integer', description: 'How long to wait for the result, up to 55000; default 20000' },
    },
    output,
    async execute(args, exec) {
      const ask = await askApproval(exec, {
        tool: 'device_write_file',
        reason: `Write ${args.path} on ${args.node}? ${String(args.content ?? '').length} characters will be sent.`,
        zh: `允许在 ${args.node} 上写入 ${args.path} 吗？将发送 ${String(args.content ?? '').length} 个字符。`,
      })
      if (!ask.ok) return ask.message
      return runFileTask(exec, {
        node: args.node,
        spec: { kind: 'write_file', path: args.path, data: args.content, encoding: args.encoding, approved: true },
        waitMs: args.waitMs,
        label: 'none',
      })
    },
  }))

  tools.push(defineTool({
    name: 'device_transfer',
    description: `Move a file between this computer and a paired machine. direction "get" brings the file's bytes back (text, or base64 for binary) so you can save them here; direction "put" sends content to that machine and always shows an approval card first. At most ${MAX_FILE_BYTES} bytes each way. A relative path is under that machine's worker workspace.`,
    parameters: {
      node: { type: 'string', required: true, description: 'Exact machine name or id from list_devices' },
      direction: { type: 'string', required: true, description: 'get: from the machine to this computer; put: from this computer to the machine' },
      path: { type: 'string', required: true, description: 'Absolute path on that machine, or a path relative to its worker workspace' },
      content: { type: 'string', description: 'For put: the file content; text, or base64 with encoding "base64"' },
      encoding: { type: 'string', description: 'For put: utf8 (default) or base64' },
      waitMs: { type: 'integer', description: 'How long to wait for the result, up to 55000; default 20000' },
    },
    output,
    async execute(args, exec) {
      const direction = args.direction === 'put' ? 'put' : 'get'
      if (direction === 'put') {
        const ask = await askApproval(exec, {
          tool: 'device_transfer',
          reason: `Send ${args.path} (${String(args.content ?? '').length} characters) to ${args.node}?`,
          zh: `允许把 ${args.path}（${String(args.content ?? '').length} 个字符）发送到 ${args.node} 吗？`,
        })
        if (!ask.ok) return ask.message
      }
      return runFileTask(exec, {
        node: args.node,
        spec: { kind: 'transfer', direction, path: args.path, data: args.content, encoding: args.encoding, approved: direction === 'put' },
        waitMs: args.waitMs,
        label: direction === 'get' ? 'payload' : 'none',
      })
    },
  }))

  tools.push(defineTool({
    name: 'device_task',
    description: 'Read the state and result of a task that run_on_device, device_read_file, device_write_file or device_transfer started on another machine, for example one that was still running when the call returned.',
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
  // The conversation sync is created once, with the plugin runtime: the hub is the one
  // writer of the Session, and a node only ever reads snapshots of it.
  let sessionSync
  try {
    sessionSync = createSessionSync({ rt })
  } catch (error) {
    rt.warn('ds-bot: LAN session sync is off: %s', error.message)
  }

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
    // How far the paired screens have been let into the one conversation: a revision a
    // node can compare, and how many polls are waiting for the next change.
    sync: sessionSync === undefined ? null : { ...sessionSync.status(), active: enabled && phase === 'listening' },
    policy: describePolicy(),
    readsNeedApproval: options.requireApprovalForReads === true,
    // The exact command to make the worker start at login on another machine. It is
    // safe to show: the pairing token already lives in that machine's device.json.
    ...(hub === undefined || phase !== 'listening' ? {} : {
      daemon: {
        command: daemonCommand({ hubUrl: hub.url }),
        uninstall: 'npm run lan:daemon -- uninstall',
        status: 'npm run lan:daemon -- status',
      },
    }),
  })

  const addTools = () => {
    for (const def of deviceTools({
      hub: () => hub,
      ready: () => ready,
      sharedOrigin: () => sharedOriginOf(ctx),
      approval: () => ctx.get?.('approval'),
      requireApprovalForReads: options.requireApprovalForReads,
    })) {
      if (rt.teamTools.some(tool => tool.name === def.name)) continue
      if (typeof rt.addTeamTool === 'function') rt.addTeamTool(def)
      else rt.teamTools.push(def)
    }
  }
  const removeTools = () => {
    for (const name of ['list_devices', 'run_on_device', 'device_read_file', 'device_write_file', 'device_transfer', 'device_task', 'device_pairing_code']) {
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
        hub = createHub({ ...options, sessionSync, log: () => {} })
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
