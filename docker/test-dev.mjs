import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'

const image = process.argv[2] ?? 'ds-bot:dev'
const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'ds-bot')
const name = `ds-bot-dev-test-${randomUUID()}`
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

function httpReady() {
  const address = docker(['exec', name, 'sh', '-c', 'hostname -i 2>/dev/null || echo 127.0.0.1']).stdout.trim().split(/\s+/)[0]
  assert.ok(address, 'the development container must have a listen address')
  const probe = `
    const response = await fetch('http://${address}:3080/');
    if (![200, 401].includes(response.status)) throw new Error('Unexpected HTTP status: ' + response.status);
  `
  return () => docker(['exec', name, 'node', '--input-type=module', '-e', probe], { allowFailure: true }).status === 0
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
  for (const volume of volumes) docker(['volume', 'create', volume])

  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  docker([
    'run', '--detach', '--name', name, '--network', 'none',
    '--mount', `type=volume,src=${data},dst=/data`,
    '--mount', `type=volume,src=${workspace},dst=/workspace`,
    '--mount', `type=bind,src=${plugin},dst=/app/ds-bot`,
    '-e', `PUID=${uid}`, '-e', `PGID=${gid}`, '-e', 'DSH_TELEMETRY_DISABLED=1',
    image,
  ])
  server = name

  await waitFor('the source watcher', () => logs().includes('[ds-bot-dev] watching /app/ds-bot'))
  const linked = docker(['exec', name, 'readlink', '-f', '/data/profiles/web/node_modules/ds-bot']).stdout.trim()
  assert.equal(linked, '/app/ds-bot')
  docker(['exec', name, 'test', '-f', '/data/profiles/web/package.json.release'])
  await waitFor('the fresh web server', httpReady())
  console.log('PASS: fresh data starts with the mounted plugin linked into the profile')

  writeFileSync(join(plugin, 'src', 'client', 'dev-reload-probe.js'), 'export const devReloadProbe = true\n')
  await waitFor('the frontend bundle rebuild', () => logs().includes('rebuilt client.js and office.js'))
  console.log('PASS: a frontend source change rebuilds the browser bundles')

  const starts = () => logs().match(/\[ds-bot-dev\] dsh started \(pid /g)?.length ?? 0
  const before = starts()
  appendFileSync(join(plugin, 'index.js'), '\n// Development reload probe.\n')
  await waitFor('the DSH restart', () => starts() > before)
  await waitFor('the restarted web server', httpReady())
  console.log('PASS: a host source change restarts DSH and restores HTTP service')
} catch (error) {
  if (server) {
    const output = logs().replace(/([?&]token=)[^\s)]+/g, '$1[hidden]')
    console.error(output)
  }
  throw error
} finally {
  if (server) docker(['rm', '--force', server], { allowFailure: true })
  for (const volume of volumes) docker(['volume', 'rm', volume], { allowFailure: true })
  rmSync(temporary, { recursive: true, force: true })
}
