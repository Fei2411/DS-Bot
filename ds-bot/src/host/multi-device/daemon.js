// Keeping the worker running on a node machine. The worker already reconnects on its
// own; what it lacks is something to start it again after a login or a reboot. Each
// platform gets its native supervisor: a launchd agent on macOS, a user unit on Linux,
// and a logon task with a small restart script on Windows. The device token stays in
// device.json; a pairing code is never written here.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

export const LABEL = 'cool.dsbot.lan-worker'
export const WINDOWS_TASK = 'DSBotLanWorker'

export function daemonFile({ platform = process.platform, home = homedir(), dataDir } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  if (platform === 'win32') return join(dataDir, 'lan-worker.cmd')
  return join(home, '.config', 'systemd', 'user', `${LABEL}.service`)
}

const xml = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const quote = value => `"${String(value).replace(/"/g, '\\"')}"`

function workerArgs({ nodePath, cliPath, hubUrl, name, dataDir, sync }) {
  const args = [nodePath, cliPath, 'worker', '--hub', hubUrl, '--name', name, '--data', dataDir]
  if (typeof sync === 'string' && sync !== '') args.push('--sync', sync)
  return args
}

export function launchAgentPlist({ nodePath, cliPath, hubUrl, name, dataDir, sync, logDir = dataDir }) {
  const args = workerArgs({ nodePath, cliPath, hubUrl, name, dataDir, sync })
  const log = join(logDir, 'worker.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xml(dirname(cliPath))}</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`
}

export function systemdUnit({ nodePath, cliPath, hubUrl, name, dataDir, sync }) {
  const args = workerArgs({ nodePath, cliPath, hubUrl, name, dataDir, sync }).map(quote).join(' ')
  return `[Unit]
Description=DS Bot LAN worker
After=network-online.target

[Service]
Type=simple
ExecStart=${args}
Restart=always
RestartSec=5
WorkingDirectory=${dirname(cliPath)}

[Install]
WantedBy=default.target
`
}

export function windowsScript({ nodePath, cliPath, hubUrl, name, dataDir, sync }) {
  const args = workerArgs({ nodePath, cliPath, hubUrl, name, dataDir, sync }).map(quote).join(' ')
  return `@echo off
rem DS Bot LAN worker. The logon task starts this file; the loop restarts it if it exits.
:loop
${args}
ping -n 6 127.0.0.1 >nul
goto loop
`
}

export function daemonFileContent({ platform = process.platform, nodePath, cliPath, hubUrl, name, dataDir, sync = 'main' }) {
  if (platform === 'darwin') return launchAgentPlist({ nodePath, cliPath, hubUrl, name, dataDir, sync })
  if (platform === 'win32') return windowsScript({ nodePath, cliPath, hubUrl, name, dataDir, sync })
  return systemdUnit({ nodePath, cliPath, hubUrl, name, dataDir, sync })
}

function run(command, args) {
  try {
    return { ok: true, output: execFileSync(command, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (error) {
    return { ok: false, output: String(error?.stderr ?? error?.message ?? error).trim() }
  }
}

// Installs the supervisor for this machine and starts it. `runCommands: false` only
// writes the file, which is what the tests use; a real install also loads it.
export function installDaemon({
  platform = process.platform,
  home = homedir(),
  dataDir,
  hubUrl,
  name = 'lan-worker',
  nodePath = process.execPath,
  cliPath,
  sync = 'main',
  runCommands = true,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('installDaemon needs a dataDir')
  if (typeof hubUrl !== 'string' || hubUrl === '') throw new Error('installDaemon needs the hub URL')
  if (typeof cliPath !== 'string' || cliPath === '') throw new Error('installDaemon needs the worker CLI path')
  const file = daemonFile({ platform, home, dataDir })
  mkdirSync(dirname(file), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, daemonFileContent({ platform, nodePath, cliPath, hubUrl, name, dataDir, sync }), { mode: 0o600 })
  const commands = []
  if (runCommands) {
    if (platform === 'darwin') {
      run('launchctl', ['unload', file])
      commands.push(run('launchctl', ['load', '-w', file]))
    } else if (platform === 'win32') {
      // schtasks wants the task command as one argument; the script path may hold spaces.
      commands.push(run('schtasks', ['/Create', '/TN', WINDOWS_TASK, '/SC', 'ONLOGON', '/TR', `"${file}"`, '/F', '/RL', 'LIMITED']))
    } else {
      run('systemctl', ['--user', 'daemon-reload'])
      commands.push(run('systemctl', ['--user', 'enable', '--now', `${LABEL}.service`]))
    }
  }
  const failed = commands.find(entry => entry.ok !== true)
  return {
    installed: true,
    file,
    platform,
    label: platform === 'win32' ? WINDOWS_TASK : LABEL,
    ...(failed === undefined ? {} : { warning: `the file was written, but starting it failed: ${failed.output}` }),
    ...(commands.length === 0 ? {} : { output: commands.map(entry => entry.output).filter(Boolean).join('\n') }),
  }
}

export function uninstallDaemon({ platform = process.platform, home = homedir(), dataDir, runCommands = true } = {}) {
  const file = daemonFile({ platform, home, dataDir })
  if (runCommands) {
    if (platform === 'darwin') run('launchctl', ['unload', '-w', file])
    else if (platform === 'win32') run('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F'])
    else run('systemctl', ['--user', 'disable', '--now', `${LABEL}.service`])
  }
  const existed = existsSync(file)
  if (existed) rmSync(file, { force: true })
  return { uninstalled: existed, file, label: platform === 'win32' ? WINDOWS_TASK : LABEL }
}

// Whether the supervisor is installed, and what the platform says about it. The file is
// the source of truth for "installed": the platform answer only says whether it runs.
export function daemonStatus({ platform = process.platform, home = homedir(), dataDir, runCommands = true } = {}) {
  const file = daemonFile({ platform, home, dataDir })
  const installed = existsSync(file)
  let detail
  if (installed && runCommands) {
    if (platform === 'darwin') {
      const uid = userInfo().uid
      detail = run('launchctl', ['print', `gui/${uid}/${LABEL}`])
    } else if (platform === 'win32') {
      detail = run('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/FO', 'LIST'])
    } else {
      detail = run('systemctl', ['--user', 'is-active', `${LABEL}.service`])
    }
  }
  return {
    installed,
    file,
    label: platform === 'win32' ? WINDOWS_TASK : LABEL,
    ...(detail === undefined ? {} : { running: detail.ok && !/inactive|not running|FAILED/i.test(detail.output), detail: detail.output }),
    ...(installed ? {} : { hint: `not installed; run the daemon install command shown in Settings → Devices on this machine` }),
  }
}

// The exact command the Devices page shows for the other machine.
export function daemonCommand({ hubUrl, name = 'other-pc' } = {}) {
  return `npm run lan:daemon -- install --hub ${hubUrl} --name ${name} --sync main`
}
