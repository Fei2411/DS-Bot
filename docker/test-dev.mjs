import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'

const image = process.argv[2] ?? 'ds-bot:dev'
const releaseImage = process.argv[3] ?? 'ds-bot:local'
const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'ds-bot')
const name = `ds-bot-dev-test-${randomUUID()}`
const releaseName = `${name}-release`
const drainName = `${name}-drain`
const data = `${name}-data`
const workspace = `${name}-workspace`
const temporary = mkdtempSync(join(tmpdir(), 'ds-bot-dev-'))
const plugin = join(temporary, 'ds-bot')
const volumes = [data, workspace]
let server = ''

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`docker ${args[0]} failed (${result.status}): ${result.error?.message ?? result.stderr}`)
  }
  return result
}

function logs() {
  const result = docker(['logs', name])
  return result.stdout + result.stderr
}

async function waitFor(description, check, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await setTimeout(300)
  }
  throw new Error(`timed out waiting for ${description}`)
}

function httpReady(container = name) {
  const address = docker(['exec', container, 'sh', '-c', 'hostname -i 2>/dev/null || echo 127.0.0.1']).stdout.trim().split(/\s+/)[0]
  assert.ok(address, 'the container must have a listen address')
  const probe = `
    const response = await fetch('http://${address}:3080/');
    if (![200, 401].includes(response.status)) throw new Error('Unexpected HTTP status: ' + response.status);
  `
  return () => docker(['exec', container, 'node', '--input-type=module', '-e', probe], { allowFailure: true }).status === 0
}

try {
  cpSync(source, plugin, {
    recursive: true,
    filter(path) {
      const rel = relative(source, path)
      if (!rel) return true
      if (basename(path) === 'node_modules' || basename(path) === '.git') return false
      return rel !== join('dev', 'harness') && !rel.startsWith(join('dev', 'harness') + sep)
    },
  })
  const buildScript = join(plugin, 'scripts', 'build-client.mjs')
  const holdableBuild = [
    "import { existsSync } from 'node:fs'",
    "import { setTimeout } from 'node:timers/promises'",
    "writeFileSync('/tmp/ds-bot-dev-build-started', '')",
    "while (existsSync('/app/ds-bot/.build-hold')) await setTimeout(50)",
    '',
  ].join('\n')
  writeFileSync(buildScript, holdableBuild + readFileSync(buildScript, 'utf8'))
  writeFileSync(join(plugin, '.build-hold'), '')
  for (const volume of volumes) docker(['volume', 'create', volume])

  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  const dataMounts = [
    '--mount', `type=volume,src=${data},dst=/data`,
    '--mount', `type=volume,src=${workspace},dst=/workspace`,
  ]
  docker([
    'run', '--detach', '--rm', '--name', releaseName, '--network', 'none', ...dataMounts,
    '-e', `PUID=${uid}`, '-e', `PGID=${gid}`, '-e', 'DSH_TELEMETRY_DISABLED=1', releaseImage,
  ])
  await waitFor('the release profile initialization', httpReady(releaseName))
  docker(['stop', releaseName])
  const addLocalDependency = `
    const fs = require('node:fs');
    const profile = '/data/profiles/web/';
    const pkg = JSON.parse(fs.readFileSync(profile + 'package.json', 'utf8'));
    pkg.dependencies['left-pad'] = 'file:/tmp/left-pad.tgz';
    fs.writeFileSync(profile + 'package.json', JSON.stringify(pkg, null, 2) + '\\n');
    fs.mkdirSync(profile + 'node_modules/left-pad', { recursive: true });
    fs.writeFileSync(profile + 'node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', version: '1.3.0', main: 'index.js' }));
    fs.writeFileSync(profile + 'node_modules/left-pad/index.js', 'module.exports = (value) => String(value)\\n');
  `
  docker([
    'run', '--rm', '--network', 'none', '--user', 'root', '--entrypoint', 'node',
    ...dataMounts, releaseImage, '-e', addLocalDependency,
  ])
  docker([
    'run', '--detach', '--name', name, '--network', 'none', ...dataMounts,
    '--mount', `type=bind,src=${plugin},dst=/app/ds-bot`,
    '-e', `PUID=${uid}`, '-e', `PGID=${gid}`, '-e', 'DSH_TELEMETRY_DISABLED=1',
    image,
  ])
  server = name

  const builds = () => logs().match(/rebuilt client\.js and office\.js/g)?.length ?? 0
  const starts = () => logs().match(/\[ds-bot-dev\] dsh started \(pid /g)?.length ?? 0
  await waitFor('the held initial build', () => docker(['exec', name, 'test', '-f', '/tmp/ds-bot-dev-build-started'], { allowFailure: true }).status === 0)
  writeFileSync(join(plugin, 'src', 'client', 'dev-startup-probe.js'), 'export const devStartupProbe = true\n')
  docker(['exec', name, 'rm', '-f', '/app/ds-bot/.build-hold'])
  await waitFor('the initial follow-up build', () => builds() >= 2)
  await waitFor('the source watcher', () => logs().includes('[ds-bot-dev] watching /app/ds-bot'))
  console.log('PASS: an edit during the initial build triggers a follow-up build')
  const linked = docker(['exec', name, 'readlink', '-f', '/data/profiles/web/node_modules/ds-bot']).stdout.trim()
  assert.equal(linked, '/app/ds-bot')
  docker(['exec', name, 'test', '-f', '/data/profiles/web/package.json.release'])
  docker(['exec', name, 'test', '-f', '/data/profiles/web/pnpm-lock.yaml.release'])
  docker(['exec', name, 'test', '-d', '/data/profiles/web/ds-bot.release'])
  await waitFor('the fresh web server', httpReady())
  docker(['exec', name, 'test', '-f', '/data/profiles/web/node_modules/left-pad/index.js'])
  console.log('PASS: development startup preserves a local plugin whose original archive is absent')

  docker(['exec', name, 'rm', '-f', '/tmp/ds-bot-dev-build-started'])
  writeFileSync(join(plugin, '.build-hold'), '')
  const beforeFrontendBuild = builds()
  writeFileSync(join(plugin, 'src', 'client', 'dev-reload-probe.js'), 'export const devReloadProbe = 1\n')
  await waitFor('the held frontend build', () => docker(['exec', name, 'test', '-f', '/tmp/ds-bot-dev-build-started'], { allowFailure: true }).status === 0)
  writeFileSync(join(plugin, 'src', 'client', 'dev-reload-probe.js'), 'export const devReloadProbe = 2\n')
  await setTimeout(2500)
  docker(['exec', name, 'rm', '-f', '/app/ds-bot/.build-hold'])
  await waitFor('the queued frontend bundle rebuild', () => builds() >= beforeFrontendBuild + 2)
  console.log('PASS: an edit during an active frontend build queues another rebuild')

  const originalBuild = readFileSync(buildScript, 'utf8')
  const failures = () => logs().match(/the client build failed/g)?.length ?? 0
  const beforeFailedBuild = builds()
  const beforeFailure = failures()
  writeFileSync(buildScript, "process.kill(process.pid, 'SIGTERM')\n")
  writeFileSync(join(plugin, 'src', 'client', 'dev-reload-probe.js'), 'export const devReloadProbe = 3\n')
  await waitFor('the signal-terminated frontend build', () => failures() > beforeFailure)
  assert.equal(builds(), beforeFailedBuild)
  writeFileSync(buildScript, originalBuild)
  writeFileSync(join(plugin, 'src', 'client', 'dev-reload-probe.js'), 'export const devReloadProbe = 4\n')
  await waitFor('the frontend build after a signal failure', () => builds() > beforeFailedBuild)
  console.log('PASS: a signal-terminated build reports failure and a later edit rebuilds')

  const beforeSharedBuild = builds()
  const beforeSharedStart = starts()
  appendFileSync(join(plugin, 'src', 'shared', 'mentions.js'), '\n// Development shared reload probe.\n')
  await waitFor('the shared source reload', () => builds() > beforeSharedBuild && starts() > beforeSharedStart)
  await waitFor('the shared-source web server', httpReady())
  console.log('PASS: a shared source change rebuilds the browser bundles and restarts DSH')

  const before = starts()
  appendFileSync(join(plugin, 'index.js'), '\n// Development reload probe.\n')
  await waitFor('the DSH restart', () => starts() > before)
  await waitFor('the restarted web server', httpReady())
  console.log('PASS: a host source change restarts DSH and restores HTTP service')

  docker(['exec', name, 'sh', '-eu', '-c', `
    mkdir -p /data/profiles/web/node_modules/extra-plugin
    printf 'extra plugin' > /data/profiles/web/node_modules/extra-plugin/index.js
  `])
  docker(['stop', name])
  docker(['rm', name])
  server = ''

  const drainScript = join(temporary, 'drain-dsh.mjs')
  const drainMarker = join(temporary, 'drain-marker')
  writeFileSync(drainScript, [
    "import { writeFileSync } from 'node:fs'",
    "import { setTimeout } from 'node:timers/promises'",
    "process.on('SIGTERM', async () => { console.log('fake dsh draining'); await setTimeout(2000); writeFileSync('/tmp/drain-output/drain-marker', 'flushed'); console.log('fake dsh flushed'); process.exit(0) })",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  docker([
    'run', '--detach', '--name', drainName, '--network', 'none', '--user', `${uid}:${gid}`, ...dataMounts,
    '--mount', `type=bind,src=${plugin},dst=/app/ds-bot`,
    '--mount', `type=bind,src=${drainScript},dst=/tmp/drain-dsh.mjs,readonly`,
    '--mount', `type=bind,src=${temporary},dst=/tmp/drain-output`,
    '--entrypoint', 'node', image,
    '/opt/ds-bot/dev-supervisor.mjs', 'node', '/tmp/drain-dsh.mjs',
  ])
  await waitFor('the draining fixture watcher', () => docker(['logs', drainName], { allowFailure: true }).stdout.includes('[ds-bot-dev] watching /app/ds-bot'))
  appendFileSync(join(plugin, 'index.js'), '\n// Development shutdown reload probe.\n')
  await waitFor('the draining fixture reload', () => docker(['logs', drainName], { allowFailure: true }).stdout.includes('host code changed; restarting dsh'))
  docker(['kill', '--signal', 'TERM', drainName])
  docker(['wait', drainName])
  if (!existsSync(drainMarker)) console.error(docker(['logs', drainName]).stdout)
  assert.equal(readFileSync(drainMarker, 'utf8'), 'flushed')
  docker(['rm', drainName])
  console.log('PASS: shutdown during a host reload waits for the stopping DSH child')

  docker([
    'run', '--detach', '--rm', '--name', releaseName, '--network', 'none', ...dataMounts,
    '-e', `PUID=${uid}`, '-e', `PGID=${gid}`, '-e', 'DSH_TELEMETRY_DISABLED=1', releaseImage,
  ])
  const releaseProbe = `
    const response = await fetch('http://127.0.0.1:3080/');
    if (![200, 401].includes(response.status)) throw new Error('Unexpected HTTP status: ' + response.status);
  `
  await waitFor('the release web server with its restored plugin', () => docker(['exec', releaseName, 'node', '--input-type=module', '-e', releaseProbe], { allowFailure: true }).status === 0)
  docker(['exec', releaseName, 'sh', '-eu', '-c', `
    test ! -L /data/profiles/web/node_modules/ds-bot
    test -f /data/profiles/web/node_modules/ds-bot/index.js
    test -f /data/profiles/web/node_modules/deep-view/package.json
    test -f /data/profiles/web/node_modules/extra-plugin/index.js
    test -f /data/profiles/web/node_modules/left-pad/index.js
    test ! -e /data/profiles/web/package.json.release
    test ! -e /data/profiles/web/pnpm-lock.yaml.release
    test ! -e /data/profiles/web/ds-bot.release
    node -e 'const assert = require("node:assert/strict"); const fs = require("node:fs"); const profile = "/data/profiles/web/"; const pkg = JSON.parse(fs.readFileSync(profile + "package.json", "utf8")); assert.notEqual(pkg.dependencies["ds-bot"], "link:/app/ds-bot"); assert.ok(!fs.readFileSync(profile + "pnpm-lock.yaml", "utf8").includes("link:/app/ds-bot")); assert.deepEqual(fs.readFileSync(profile + "node_modules/ds-bot/index.js"), fs.readFileSync("/opt/dsh-template/profiles/web/node_modules/ds-bot/index.js"))'
  `])
  console.log('PASS: release startup restores all dependencies and loads the plugin')
} catch (error) {
  if (server) {
    const output = logs().replace(/([?&]token=)[^\s)]+/g, '$1[hidden]')
    console.error(output)
  }
  throw error
} finally {
  if (server) docker(['rm', '--force', server], { allowFailure: true })
  docker(['rm', '--force', releaseName], { allowFailure: true })
  docker(['rm', '--force', drainName], { allowFailure: true })
  for (const volume of volumes) docker(['volume', 'rm', volume], { allowFailure: true })
  if (process.platform === 'win32') rmSync(temporary, { recursive: true, force: true })
  // The container leaves its build tools owned by node on a native Linux mount.
  else docker(['run', '--rm', '--user', 'root', '--entrypoint', 'sh', '--mount', `type=bind,src=${temporary},dst=/tmp/ds-bot-test`, image, '-c', 'rm -rf /tmp/ds-bot-test/* /tmp/ds-bot-test/.[!.]* /tmp/ds-bot-test/..?*'], { allowFailure: true })
  rmSync(temporary, { recursive: true, force: true })
}
