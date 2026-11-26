#!/usr/bin/env node
// Dev supervisor for the Docker deployment.
//
// dsh loads a plugin's host code when it starts, so new host code needs a new
// process; the browser bundle is a build artifact that the plugin serves
// itself. The supervisor therefore:
//
//   src/client/**, src/office/**,
//   src/shared/**               → rebuild client.js / office.js, then the
//                                   browser needs a refresh
//   src/host/**, src/shared/**,    → restart dsh, which is how the new code
//   index.js, web-search.js           gets loaded
//
// The team, the chats and the sessions live in DSH_HOME (/data), so a restart
// keeps them; only a turn that is running is interrupted.
//
// The changes are found by polling: a bind mount on Docker Desktop does not
// deliver the host's file events into the container, so fs.watch stays quiet.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

const PLUGIN = process.env.DSBOT_PLUGIN_DIR || '/app/ds-bot'
const PROFILE = process.env.DSH_PROFILE_DIR || '/data/profiles/web'
const DSH = process.argv.slice(2)
const RESTART_DELAY_MS = 800
const POLL_MS = 1500

// What the supervisor watches. The bundles the build writes are not in here,
// so the rebuild does not trigger the next poll.
const WATCHED = ['src', 'plugin.js', 'index.js', 'web-search.js', 'package.json', 'cordis.patch.yml']

const log = message => console.log(`[ds-bot-dev] ${message}`)

const IGNORED = /^(node_modules|\.git|\.pnpm-store)$/

let child = null
let stopping = false
let pending = new Set()
let timer = null
let building = false
let buildQueued = false
let restarting = false
let known = new Map()

const run = (command, args, options = {}) => new Promise(resolve => {
  const done = spawn(command, args, { stdio: 'inherit', ...options })
  done.on('exit', code => resolve(code ?? 1))
  done.on('error', error => {
    console.error(`[ds-bot-dev] ${command} failed: ${error.message}`)
    resolve(1)
  })
})

// The profile must point at the mounted checkout, not at a packed tarball.
// The release spec is kept aside, so the release image can be restored.
const linkProfile = () => {
  const manifestPath = join(PROFILE, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`no profile manifest at ${manifestPath}`)
  const backupPath = join(PROFILE, 'package.json.release')
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, readFileSync(manifestPath, 'utf8'))
    log('kept the release profile manifest as package.json.release')
    const installed = join(PROFILE, 'node_modules', 'ds-bot')
    if (existsSync(installed)) renameSync(installed, join(PROFILE, 'ds-bot.release'))
  }
  const lockPath = join(PROFILE, 'pnpm-lock.yaml')
  const lockBackupPath = join(PROFILE, 'pnpm-lock.yaml.release')
  if (existsSync(lockPath) && !existsSync(lockBackupPath)) {
    writeFileSync(lockBackupPath, readFileSync(lockPath, 'utf8'))
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, 'ds-bot': `link:${PLUGIN}` }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

const installProfile = async () => {
  log('linking the plugin into the mounted checkout')
  const installed = join(PROFILE, 'node_modules', 'ds-bot')
  mkdirSync(dirname(installed), { recursive: true })
  rmSync(installed, { recursive: true, force: true })
  symlinkSync(PLUGIN, installed, 'dir')
  // The profile must resolve to the checkout, or the container would keep
  // serving the packed plugin and every change would be ignored.
  let target = ''
  try {
    target = realpathSync(installed)
  } catch {
    target = ''
  }
  if (target !== PLUGIN) {
    throw new Error(`the profile resolves the plugin to ${target || 'nothing'}, not ${PLUGIN}`)
  }
  log(`the profile resolves the plugin to ${target}`)
}

// A team lock left behind by a container that is gone would make this one
// read-only: the plugin reads the pid as alive, because the new container
// reuses it. The lock names the host it was taken on, so a foreign one is stale.
const clearForeignLock = () => {
  if (process.env.DSBOT_CLEAR_FOREIGN_LOCK === '0') return
  const lockPath = join(process.env.DSBOT_TEAM_DIR || '/data/bot', 'state.lock')
  if (!existsSync(lockPath)) return
  let lock
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return
  }
  if (!lock.host || lock.host === hostname()) return
  log(`removing the team lock left by another container (${lock.host})`)
  rmSync(lockPath, { force: true })
}

const startDsh = () => {
  child = spawn(DSH[0], DSH.slice(1), { stdio: 'inherit' })
  log(`dsh started (pid ${child.pid})`)
  child.on('exit', (code, signal) => {
    child = null
    // A restart in progress starts the new process itself, once the old one
    // has let go of the port.
    if (stopping || restarting) return
    log(`dsh exited (${signal ? `signal ${signal}` : `code ${code}`}); starting it again`)
    setTimeout(() => {
      if (!stopping && !child) startDsh()
    }, RESTART_DELAY_MS)
  })
}

const stopDsh = () => {
  if (!child) return null
  const dying = child
  // Keep the child tracked until exit so a signal during reload can await it.
  dying.kill('SIGTERM')
  const killer = setTimeout(() => dying.kill('SIGKILL'), 12_000)
  killer.unref?.()
  return dying
}

const rebuild = async () => {
  if (building) {
    buildQueued = true
    return
  }
  building = true
  try {
    do {
      buildQueued = false
      const code = await run(process.execPath, [join(PLUGIN, 'scripts', 'build-client.mjs')], { cwd: PLUGIN })
      if (code === 0) log('rebuilt client.js and office.js; refresh the browser to see it')
      else log('the client build failed; see the output above')
    } while (buildQueued)
  } finally {
    building = false
  }
}

const restart = () => {
  if (restarting) return
  restarting = true
  try {
    log('host code changed; restarting dsh')
    const dying = stopDsh()
    if (!dying) {
      restarting = false
      startDsh()
      return
    }
    // The new dsh may not start before the old one has closed the port.
    const killer = setTimeout(() => dying.kill('SIGKILL'), 12_000)
    killer.unref?.()
    dying.on('exit', () => {
      clearTimeout(killer)
      restarting = false
      if (stopping) return
      setTimeout(() => {
        if (!stopping && !child) startDsh()
      }, 500)
    })
  } catch (error) {
    restarting = false
    console.error(`[ds-bot-dev] ${error.message}`)
  }
}

const apply = async () => {
  const files = [...pending]
  pending = new Set()
  if (files.length === 0) return
  const bundle = files.some(file => file.startsWith('src/client/') || file.startsWith('src/office/')
    || file.startsWith('src/shared/'))
  const host = files.some(file => file.startsWith('src/host/') || file.startsWith('src/shared/')
    || file === 'plugin.js' || file === 'index.js' || file === 'web-search.js' || file === 'package.json'
    || file === 'cordis.patch.yml')
  if (bundle) await rebuild()
  if (host) restart()
}

const schedule = () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    apply().catch(error => console.error(`[ds-bot-dev] ${error.message}`))
  }, 400)
}

// The mtime of every watched file, relative to the plugin directory.
const snapshot = () => {
  const files = new Map()
  const walk = directory => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORED.test(entry.name)) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        try {
          files.set(full.slice(PLUGIN.length + 1), statSync(full).mtimeMs)
        } catch {
          // The file went away between the listing and the stat.
        }
      }
    }
  }
  for (const target of WATCHED) {
    const full = join(PLUGIN, target)
    if (!existsSync(full)) continue
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) walk(full)
    else files.set(target, stat.mtimeMs)
  }
  return files
}

const pollPlugin = () => {
  const current = snapshot()
  for (const [file, mtime] of current) {
    if (known.get(file) !== mtime) pending.add(file)
  }
  for (const file of known.keys()) {
    if (!current.has(file)) pending.add(file)
  }
  known = current
  if (pending.size > 0) schedule()
}

const watchPlugin = () => {
  log(`watching ${PLUGIN} for changes (every ${POLL_MS} ms)`)
  setInterval(() => {
    try {
      pollPlugin()
    } catch (error) {
      console.error(`[ds-bot-dev] ${error.message}`)
    }
  }, POLL_MS)
}

const main = async () => {
  if (DSH.length === 0) throw new Error('usage: dev-supervisor.mjs <command> [args...]')
  linkProfile()
  await installProfile()
  known = snapshot()
  await rebuild()
  pollPlugin()
  clearForeignLock()
  startDsh()
  watchPlugin()
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    // Wait for dsh to leave, so it can release the team lock. A lock left
    // behind makes the next start read the team as owned by another dsh.
    const dying = stopDsh()
    if (!dying) {
      process.exit(0)
      return
    }
    const killer = setTimeout(() => {
      dying.kill('SIGKILL')
      process.exit(0)
    }, 12_000)
    killer.unref?.()
    dying.on('exit', () => {
      clearTimeout(killer)
      process.exit(0)
    })
  })
}

main().catch(error => {
  console.error(`[ds-bot-dev] ${error.message}`)
  process.exit(1)
})
