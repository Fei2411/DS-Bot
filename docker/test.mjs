import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

const image = process.argv[2] ?? 'ds-bot:local'
const name = `ds-bot-test-${randomUUID()}`
const data = `${name}-data`
const workspace = `${name}-workspace`
const containers = new Set()
const volumes = []

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  })
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`docker ${args[0]} failed (${result.status}): ${result.error?.message ?? result.stderr}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

function mounts() {
  return [
    '--mount', `type=volume,src=${data},dst=/data`,
    '--mount', `type=volume,src=${workspace},dst=/workspace`,
  ]
}

function run(args) {
  const container = `${name}-${containers.size}`
  containers.add(container)
  return docker(['run', '--rm', '--name', container, '--network', 'none', ...mounts(), ...args])
}

function shell(script) {
  return run(['--entrypoint', '/bin/sh', image, '-eu', '-c', script])
}

function startHelp(uid, gid) {
  run(['-e', `PUID=${uid}`, '-e', `PGID=${gid}`, image, '--help'])
}

function checkPluginArchive(uid = 1000, gid = 1000) {
  shell(`
    gosu ${uid}:${gid} node --input-type=module <<'JS'
      import assert from 'node:assert/strict'
      import { spawnSync } from 'node:child_process'
      import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs'
      import { fileURLToPath } from 'node:url'
      const profile = JSON.parse(readFileSync('/data/profiles/web/package.json', 'utf8'))
      const archive = profile.dependencies['ds-bot']
      assert.ok(archive.startsWith('file:/'), 'the profile must use a local plugin archive')
      accessSync(fileURLToPath(archive), constants.R_OK)
      const dir = mkdtempSync('/tmp/ds-bot-pack-')
      try {
        const result = spawnSync('npm', ['pack', archive, '--offline', '--ignore-scripts', '--pack-destination', dir], {
          encoding: 'utf8', env: { ...process.env, npm_config_cache: dir + '/cache' },
        })
        assert.equal(result.status, 0, result.stderr)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
JS
  `)
}

function checkDataOwner(uid, gid) {
  shell(`
    test -z "$(find -P /data -xdev \\( ! -uid ${uid} -o ! -gid ${gid} \\) -print -quit)"
    test "$(stat -c %a /data/profiles/web/package.json)" = 600
    test "$(cat /data/review-state.txt)" = preserved
    test "$(stat -c %u:%g /workspace)" = 2345:2346
    test "$(stat -c %u:%g /workspace/keep.txt)" = 2345:2346
    test "$(cat /workspace/keep.txt)" = untouched
  `)
}

try {
  for (const volume of [data, workspace]) {
    docker(['volume', 'create', volume])
    volumes.push(volume)
  }

  shell(`
    test "$(stat -c %a /usr/local/bin/entrypoint.sh)" = 755
    /bin/sh -n /usr/local/bin/entrypoint.sh
  `)
  startHelp(1000, 1000)
  checkPluginArchive()
  console.log('PASS: the runtime user can read the profile plugin archive')
  shell(`
    test "$(stat -c %u:%g /data/profiles/web/package.json)" = 1000:1000
    printf preserved > /data/review-state.txt
    chmod 600 /data/review-state.txt
    chown 1000:1000 /data/review-state.txt
    printf untouched > /workspace/keep.txt
    chown 2345:2346 /workspace /workspace/keep.txt
    ln -s /workspace /data/workspace-link
    ln -s /workspace/keep.txt /data/file-link
    ln -s /missing-target /data/dangling-link
  `)
  console.log('PASS: executable entrypoint and first start')

  shell(`
    node --input-type=module <<'JS'
      import { readFileSync, writeFileSync } from 'node:fs'
      const dir = '/data/profiles/web/'
      const profile = JSON.parse(readFileSync(dir + 'package.json', 'utf8'))
      const archive = profile.dependencies['ds-bot']
      for (const file of ['package.json', 'pnpm-lock.yaml']) {
        const path = dir + file
        writeFileSync(path, readFileSync(path, 'utf8').replaceAll(archive, 'file:/tmp/ds-bot.tgz'))
      }
JS
    sha256sum /data/profiles/web/package.json /data/profiles/web/pnpm-lock.yaml > /data/profile-before.sha256
  `)
  startHelp(1234, 1234)
  shell('sha256sum --check /data/profile-before.sha256')
  checkPluginArchive(1234, 1234)
  console.log('PASS: legacy archive references stay usable without rewriting the persisted profile')
  checkDataOwner(1234, 1234)
  console.log('PASS: UID/GID migration preserves data and workspace link targets')

  startHelp(1234, 1235)
  checkDataOwner(1234, 1235)
  shell(`
    mkdir -p /data/restored
    printf restored > /data/restored/private.txt
    chmod 700 /data/restored
    chmod 600 /data/restored/private.txt
    chown -R 3456:3457 /data/restored
  `)
  startHelp(1234, 1235)
  checkDataOwner(1234, 1235)
  console.log('PASS: group-only migration and restored files with mixed ownership')

  const server = `${name}-web`
  containers.add(server)
  docker([
    'run', '--detach', '--rm', '--name', server, '--network', 'none', ...mounts(),
    '-e', 'PUID=1234', '-e', 'PGID=1235', '-e', 'DSH_TELEMETRY_DISABLED=1', image,
  ])
  const address = docker(['exec', server, 'sh', '-c', 'hostname -i 2>/dev/null || echo 127.0.0.1']).stdout.trim().split(/\s+/)[0]
  assert.ok(address, 'the container must have an address for the default DSH bind')
  const probe = `
    const response = await fetch('http://${address}:3080/');
    if (![200, 401].includes(response.status)) throw new Error('Unexpected HTTP status: ' + response.status);
  `
  const deadline = Date.now() + 45_000
  let ready = false
  while (Date.now() < deadline) {
    if (docker(['exec', server, 'node', '--input-type=module', '-e', probe], { allowFailure: true }).status === 0) {
      ready = true
      break
    }
    await setTimeout(300)
  }
  assert.ok(ready, 'web server must answer HTTP after ownership migration')
  const logs = docker(['logs', server])
  const loginUrl = (logs.stdout + logs.stderr).match(/http:\/\/127\.0\.0\.1:3080\/\?token=[^\s]+/)?.[0]
  assert.ok(loginUrl, 'web server must provide a login URL')
  docker(['exec', server, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    const login = await fetch(process.argv[1], { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert.ok(cookie, 'login must return a cookie')
    const response = await fetch('http://127.0.0.1:3080/api/bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint: 'state', payload: {} }),
    })
    assert.ok(response.ok, 'the Bot API must answer')
    const result = await response.json()
    assert.ok(result.ok, result.error?.message)
    assert.ok(Array.isArray(result.value.bots), 'the DS Bot plugin must load')
  `, loginUrl])
  const processOwner = docker(['exec', server, 'stat', '-c', '%u:%g', '/proc/1']).stdout.trim()
  assert.equal(processOwner, '1234:1235', 'web process must run under the new identity')
  const identity = docker(['exec', server, 'gosu', 'node', 'id']).stdout
  assert.match(identity, /uid=1234\(node\) gid=1235\(node\)/)
  docker(['exec', server, 'gosu', 'node', '/bin/sh', '-eu', '-c', `
    test "$(cat /data/review-state.txt)" = preserved
    test "$(cat /data/restored/private.txt)" = restored
    test -w /data/profiles/web/package.json
  `])
  console.log('PASS: web startup, DS Bot API and private data access under the new identity')
} finally {
  for (const container of containers) {
    docker(['rm', '--force', container], { allowFailure: true })
  }
  for (const volume of volumes) {
    docker(['volume', 'rm', volume])
  }
}
