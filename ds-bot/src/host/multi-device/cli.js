// Command line for the LAN MVP: run the hub on the machine the user sits at, and the
// worker on each machine the hub may command. Nothing here is part of the DSH plugin
// load path; the plugin only imports these modules when it wires them up.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname as localHostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHub } from './hub.js'
import { createWorker } from './worker.js'
import { createSessionClient } from './session-client.js'
import { describePolicy } from './policy.js'
import { daemonStatus, installDaemon, uninstallDaemon } from './daemon.js'

const USAGE = `DS Bot LAN multi-device

  node cli.js hub    [--port 8787] [--host 0.0.0.0] [--name "Mac mini"] [--data DIR]
  node cli.js code   [--data DIR] [--hub URL]
  node cli.js nodes  [--data DIR] [--hub URL]
  node cli.js run    --node <name|id> [--timeout 60] -- <command and arguments>
  node cli.js worker --hub URL [--code 123456] [--name "windows-pc"] [--sync <bot>] [--no-sync] [--data DIR]
  node cli.js say    --text "hello" [--bot <id|name|main>] [--data DIR] [--hub URL]
  node cli.js daemon install [--hub URL] [--name "windows-pc"] [--no-sync] [--data DIR]
  node cli.js daemon status | uninstall

The data folder holds nodes.json, admin.token and, on a worker, device.json.
Default: ~/.ds-bot/multi-device (or DSBOT_LAN_DATA).`

function parseArgs(argv) {
  const options = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [key, inline] = arg.slice(2).split('=')
    if (inline !== undefined) {
      options[key] = inline
    } else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
      options[key] = argv[index + 1]
      index += 1
    } else {
      options[key] = true
    }
  }
  return { options, positional }
}

const dataDirOf = options => String(options.data ?? process.env.DSBOT_LAN_DATA ?? join(homedir(), '.ds-bot', 'multi-device'))

const HUB_FILE = 'hub.json'

function rememberedHub(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, HUB_FILE), 'utf8'))
    return typeof parsed?.url === 'string' ? parsed.url : undefined
  } catch {
    return undefined
  }
}

function hubUrlOf(options, dataDir, { paired = false } = {}) {
  const saved = paired ? readDevice(dataDir)?.hubUrl : undefined
  const url = typeof options.hub === 'string'
    ? options.hub
    : typeof saved === 'string' && saved !== '' ? saved : rememberedHub(dataDir)
  if (url === undefined) throw new Error('no hub URL: start the hub on this machine, or pass --hub http://<mac-ip>:8787')
  return url.replace(/\/+$/, '')
}

function adminTokenOf(dataDir) {
  const path = join(dataDir, 'admin.token')
  if (!existsSync(path)) throw new Error(`no admin token at ${path}: start the hub on this machine first, or pass --data`)
  const token = readFileSync(path, 'utf8').trim()
  if (token === '') throw new Error(`the admin token at ${path} is empty`)
  return token
}

async function admin(url, dataDir, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-admin-token': adminTokenOf(dataDir), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const parsed = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path}: ${parsed.error ?? `HTTP ${response.status}`}`)
  return parsed
}

function readDevice(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, 'device.json'), 'utf8'))
    if (typeof parsed?.token === 'string' && parsed.token !== '') return parsed
  } catch {
    // No saved pairing on this machine yet.
  }
  return undefined
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function commandHub(options) {
  const dataDir = dataDirOf(options)
  const port = Number(options.port ?? 8787)
  const host = String(options.host ?? '0.0.0.0')
  const hub = createHub({
    dataDir,
    host,
    port,
    name: typeof options.name === 'string' ? options.name : undefined,
    log: (message, ...args) => console.log(message, ...args),
  })
  const { url } = await hub.start()
  writeFileSync(join(dataDir, HUB_FILE), `${JSON.stringify({ url, port: hub.port, name: options.name ?? 'DS Bot hub' }, null, 2)}\n`)
  const issued = hub.issueCode()
  console.log(`Hub listening on ${url} (LAN) and http://127.0.0.1:${hub.port} (this machine)`)
  console.log(`Data folder: ${dataDir}`)
  console.log(`Admin token: ${hub.adminTokenFile}`)
  console.log('')
  console.log(`Pairing code: ${issued.code}   (valid until ${issued.expiresAt}, one device)`)
  console.log('On the other machine run:')
  console.log(`  node cli.js worker --hub ${url} --code ${issued.code} --name windows-pc`)
  console.log('')
  const stop = async () => {
    console.log('Stopping the hub…')
    await hub.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return new Promise(() => {})
}

async function commandCode(options) {
  const dataDir = dataDirOf(options)
  const issued = await admin(hubUrlOf(options, dataDir), dataDir, '/admin/pair-code', {})
  console.log(`Pairing code: ${issued.code}   (valid until ${issued.expiresAt}, one device)`)
}

async function commandNodes(options) {
  const dataDir = dataDirOf(options)
  const { nodes } = await admin(hubUrlOf(options, dataDir), dataDir, '/admin/nodes')
  if (nodes.length === 0) {
    console.log('No paired nodes yet. Run `code` on this machine and `worker` on the other.')
    return
  }
  for (const node of nodes) {
    const seen = node.lastSeen === undefined ? 'never' : node.lastSeen
    console.log(`${node.online ? 'online ' : 'offline'}  ${node.name.padEnd(20)} ${node.id}  ${node.os ?? '?'}/${node.arch ?? '?'}  ${node.hostname ?? ''}  last seen ${seen}`)
  }
}

function commandOf(options, positional) {
  if (positional.length > 0) return positional
  if (typeof options.command === 'string') return options.command.split(/\s+/).filter(part => part !== '')
  throw new Error('no command: pass it after -- (for example: run --node mac -- hostname)')
}

async function commandRun(options, positional) {
  const dataDir = dataDirOf(options)
  const url = hubUrlOf(options, dataDir)
  const node = typeof options.node === 'string' ? options.node : undefined
  if (node === undefined) throw new Error('no node: pass --node <name or id>')
  const argv = commandOf(options, positional)
  const waitSeconds = Number(options.timeout ?? 60)
  // This command runs on the hub machine with the admin token, so it is the user's own
  // decision: the task is marked approved and the worker runs it without another card.
  const started = await admin(url, dataDir, '/admin/tasks', { node, kind: 'shell', argv, approved: true, timeoutMs: Math.round(waitSeconds * 1000) })
  const id = started.task.id
  const deadline = Date.now() + waitSeconds * 1000 + 10_000
  let task = started.task
  while (!['done', 'failed', 'rejected', 'timeout', 'cancelled'].includes(task.state)) {
    if (Date.now() > deadline) throw new Error(`task ${id} did not finish; the hub keeps it, check it later with \`nodes\``)
    await sleep(250)
    task = (await admin(url, dataDir, `/admin/tasks/${id}`)).task
  }
  if (task.result?.stdout) process.stdout.write(task.result.stdout.endsWith('\n') ? task.result.stdout : `${task.result.stdout}\n`)
  if (task.result?.stderr) process.stderr.write(task.result.stderr.endsWith('\n') ? task.result.stderr : `${task.result.stderr}\n`)
  const exitCode = task.result?.exitCode ?? 1
  console.log(`[${task.nodeName}] task ${task.id}: ${task.state}, exit ${exitCode}${task.result?.durationMs === undefined ? '' : `, ${task.result.durationMs} ms`}${task.result?.truncated ? ', output truncated' : ''}`)
  process.exitCode = task.state === 'done' ? 0 : Math.min(Math.abs(exitCode) || 1, 255)
}

async function commandWorker(options) {
  const dataDir = dataDirOf(options)
  const hubUrl = hubUrlOf(options, dataDir)
  // A worker follows the center's conversation by default, so pairing is enough to keep
  // a screen aligned; --no-sync leaves a task-only worker.
  const sync = options['no-sync'] === true ? undefined : typeof options.sync === 'string' ? options.sync : 'main'
  const worker = createWorker({
    hubUrl,
    dataDir,
    name: typeof options.name === 'string' ? options.name : undefined,
    code: typeof options.code === 'string' ? options.code : undefined,
    sync,
    log: (message, ...args) => console.log(message, ...args),
  })
  if (!worker.paired() && typeof options.code !== 'string') {
    throw new Error('this machine is not paired yet: pass --code <the code the hub printed>')
  }
  await worker.start()
  const connected = await worker.connected({ timeoutMs: Number(options.connectTimeout ?? 15) * 1000 }).catch(error => {
    console.log(`Not connected yet (${error.message}); retrying in the background.`)
    return undefined
  })
  if (connected !== undefined) {
    console.log(`Worker ${connected.nodeName} (${connected.nodeId}) connected to ${hubUrl}`)
  }
  if (sync !== undefined) console.log(`Session sync: following ${sync === 'main' ? 'the Main Bot' : sync} into ${join(dataDir, 'sync')}`)
  console.log(`Allowed commands: ${describePolicy().join(', ')}`)
  const stop = async () => {
    console.log('Stopping the worker…')
    await worker.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return new Promise(() => {})
}

// One message from this paired machine into the center's conversation. It is the same
// path the worker's sync loop uses; the process exits after the hub accepts it.
async function commandSay(options, positional) {
  const dataDir = dataDirOf(options)
  const device = readDevice(dataDir)
  if (device === undefined) throw new Error(`this machine is not paired yet: no device token in ${dataDir}`)
  const text = typeof options.text === 'string' ? options.text : positional.join(' ')
  if (text.trim() === '') throw new Error('no message: pass --text "hello"')
  const client = createSessionClient({
    hubUrl: hubUrlOf(options, dataDir, { paired: true }),
    dataDir,
    token: device.token,
    bot: typeof options.bot === 'string' ? options.bot : 'main',
    waitMs: 0,
  })
  const result = await client.send(text)
  console.log(`Sent to ${result.botId ?? 'the Main Bot'}: revision ${result.revision}${result.duplicate === true ? ' (already accepted)' : ''}`)
}

async function commandDaemon(options, positional) {
  const action = positional[0] ?? 'status'
  const dataDir = dataDirOf(options)
  const home = typeof options.home === 'string' ? options.home : homedir()
  if (action === 'install') {
    if (!existsSync(join(dataDir, 'device.json'))) {
      throw new Error('this machine is not paired yet: run `npm run lan:worker -- --hub <hub URL> --code <code>` once, then install the daemon. The token stays in device.json.')
    }
    const sync = options['no-sync'] === true ? undefined : typeof options.sync === 'string' ? options.sync : 'main'
    const result = installDaemon({
      home,
      dataDir,
      hubUrl: hubUrlOf(options, dataDir),
      name: typeof options.name === 'string' ? options.name : localHostname(),
      sync,
      cliPath: fileURLToPath(import.meta.url),
    })
    console.log(`Installed the worker daemon at ${result.file}`)
    if (result.warning !== undefined) console.log(`Warning: ${result.warning}`)
    console.log('It starts at login and after a reboot, and keeps running when the connection drops.')
    return
  }
  if (action === 'uninstall') {
    const result = uninstallDaemon({ home, dataDir })
    console.log(result.uninstalled ? `Removed ${result.file}` : `Nothing was installed at ${result.file}`)
    return
  }
  if (action === 'status') {
    const status = daemonStatus({ home, dataDir })
    console.log(`${status.installed ? 'installed' : 'not installed'}  ${status.file}`)
    if (status.detail !== undefined) console.log(status.detail)
    if (status.installed) console.log(`Start it with: npm run lan:daemon -- install --hub ${rememberedHub(dataDir) ?? '<hub URL>'}`)
    return
  }
  throw new Error(`unknown daemon action: ${action} (use install, uninstall or status)`)
}

export async function main(argv = process.argv.slice(2)) {
  const { options, positional } = parseArgs(argv)
  const command = positional.shift()
  if (command === undefined || command === 'help' || options.help === true) {
    console.log(USAGE)
    return
  }
  if (command === 'hub') return commandHub(options)
  if (command === 'code') return commandCode(options)
  if (command === 'nodes') return commandNodes(options)
  if (command === 'run') return commandRun(options, positional)
  if (command === 'worker') return commandWorker(options)
  if (command === 'say') return commandSay(options, positional)
  if (command === 'daemon') return commandDaemon(options, positional)
  throw new Error(`unknown command: ${command}\n\n${USAGE}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
