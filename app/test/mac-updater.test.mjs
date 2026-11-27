import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createMacUpdater, parseSha256Sums, resolveMacAppBundle } from '../src/mac-updater.mjs'
import { watchUpdates } from '../src/updates.mjs'

const quietLog = () => {
  const lines = []
  return { lines, info: (line) => { lines.push(line) }, error: (line) => { lines.push(line) } }
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

const makeResponse = (body, { status = 200, url = '', headers = {} } = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const headerMap = new Map(Object.entries({ 'content-length': String(buf.length), ...headers }).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
    json: async () => JSON.parse(buf.toString('utf8')),
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    body: new ReadableStream({
      start(controller) {
        const mid = Math.max(1, Math.floor(buf.length / 2))
        if (buf.length > 1) {
          controller.enqueue(buf.subarray(0, mid))
          controller.enqueue(buf.subarray(mid))
        } else if (buf.length === 1) {
          controller.enqueue(buf)
        }
        controller.close()
      },
    }),
  }
}

const makeRelease = (version, { arch = 'arm64', body = '- Faster startup (#100)', baseUrl = 'https://github.com/Fei-Craft/DS-Bot/releases/download', includeSums = true, draft = false, prerelease = false } = {}) => {
  const assetName = `DS-Bot-${version}-mac-${arch}.zip`
  const assets = [{ name: assetName, browser_download_url: `${baseUrl}/v${version}/${assetName}` }]
  if (includeSums) assets.push({ name: 'SHA256SUMS.txt', browser_download_url: `${baseUrl}/v${version}/SHA256SUMS.txt` })
  return { tag_name: `v${version}`, html_url: `https://github.com/Fei-Craft/DS-Bot/releases/tag/v${version}`, draft, prerelease, body, assets }
}

function makeFakeBundle(extractDir, { name = 'DS Bot.app', executable = 'DS Bot' } = {}) {
  const appDir = join(extractDir, name)
  const macosDir = join(appDir, 'Contents', 'MacOS')
  mkdirSync(macosDir, { recursive: true })
  const execFile = join(macosDir, executable)
  writeFileSync(execFile, '#!/bin/sh\nexit 0\n')
  chmodSync(execFile, 0o755)
  return appDir
}

function makeFakeExecFile({ plist, failCodesign = false, createApps } = {}) {
  const calls = []
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args })
    if (options?.signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      callback(err)
      return
    }
    if (file === '/usr/bin/ditto') {
      const extractDir = args.at(-1)
      if (createApps) createApps(extractDir)
      else makeFakeBundle(extractDir)
      callback(null, '', '')
      return
    }
    if (file === '/usr/bin/plutil') {
      callback(null, JSON.stringify(plist), '')
      return
    }
    if (file === '/usr/bin/codesign') {
      if (failCodesign) { callback(new Error('invalid signature'), '', 'code object is not signed at all'); return }
      callback(null, '', '')
      return
    }
    callback(new Error(`Unexpected execFile: ${file}`))
  }
  return { execFile, calls }
}

describe('resolveMacAppBundle', () => {
  test('accepts a writable .app bundle path', () => {
    const res = resolveMacAppBundle('/Applications/DS Bot.app/Contents/MacOS/DS Bot', { access: () => {} })
    assert.deepEqual(res, { eligible: true, appPath: '/Applications/DS Bot.app' })
  })

  test('rejects non-bundle paths, App Translocation, and read-only locations', () => {
    assert.equal(resolveMacAppBundle('/usr/local/bin/node', { access: () => {} }).reason, 'not-bundle')
    assert.equal(resolveMacAppBundle('', { access: () => {} }).reason, 'not-bundle')
    assert.equal(
      resolveMacAppBundle('/private/var/folders/ab/cd/T/AppTranslocation/1234/d/DS Bot.app/Contents/MacOS/DS Bot', { access: () => {} }).reason,
      'translocated',
    )
    assert.equal(
      resolveMacAppBundle('/Applications/DS Bot.app/Contents/MacOS/DS Bot', { access: () => { throw new Error('EACCES') } }).reason,
      'not-writable',
    )
  })
})

describe('parseSha256Sums', () => {
  test('parses standard sha256sum entries and ignores malformed lines', () => {
    const hashA = 'a'.repeat(64)
    const hashB = 'B'.repeat(64)
    const map = parseSha256Sums(`\n${hashA}  DS-Bot-0.4.1-mac-arm64.zip\n${hashB} *DS-Bot-0.4.1-mac-x64.zip\nnot-a-hash foo\n`)
    assert.equal(map.get('DS-Bot-0.4.1-mac-arm64.zip'), hashA)
    assert.equal(map.get('DS-Bot-0.4.1-mac-x64.zip'), 'b'.repeat(64))
    assert.equal(map.size, 2)
  })
})

describe('createMacUpdater (unit)', () => {
  test('downloads, verifies SHA-256 + plist + codesign, and spawns swap helper on quitAndInstall', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-mac-upd-unit-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const zipBytes = Buffer.from('fake-zip-bytes-for-unit-test-0123456789')
    const zipHash = sha256Hex(zipBytes)
    const rel = makeRelease('0.4.1')
    const spawned = []
    let quitCalls = 0
    const willQuitHooks = []

    const { execFile, calls } = makeFakeExecFile({
      plist: { CFBundleIdentifier: 'io.github.fei2411.dsbot', CFBundleShortVersionString: '0.4.1', CFBundleExecutable: 'DS Bot' },
    })

    const updater = createMacUpdater({
      current: '0.4.0',
      arch: 'arm64',
      appPath: '/Applications/DS Bot.app',
      stagingRoot: join(root, 'staging'),
      logFile: join(root, 'logs', 'mac-updater.log'),
      pid: 4242,
      execFile,
      spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} } },
      quit: () => { quitCalls += 1 },
      onWillQuit: (fn) => { willQuitHooks.push(fn) },
      log: quietLog(),
      fetch: async (url) => {
        if (url.includes('api.github.com')) return makeResponse([rel], { url })
        if (url.endsWith('SHA256SUMS.txt')) return makeResponse(`${zipHash}  DS-Bot-0.4.1-mac-arm64.zip\n`, { url })
        if (url.endsWith('.zip')) return makeResponse(zipBytes, { url })
        return makeResponse('not found', { status: 404, url })
      },
    })

    const asked = []
    const steps = []
    const updates = watchUpdates({
      updater,
      log: quietLog(),
      beforeInstall: async () => { steps.push('stopHost') },
      ask: async (version, info) => { asked.push({ version, info }); return false },
    })
    t.after(updates.stop)

    const latest = await updates.latest()
    assert.equal(latest.version, '0.4.1')
    assert.equal(await latest.downloaded, true)
    await sleep(10)

    assert.equal(updates.state().phase, 'downloaded')
    assert.equal(updates.state().autoInstall, true)
    assert.equal(updates.state().notes, '• Faster startup')
    assert.equal(asked.length, 1)
    assert.equal(asked[0].version, '0.4.1')
    assert.equal(willQuitHooks.length, 1)
    assert.deepEqual(calls.map(c => c.file), ['/usr/bin/ditto', '/usr/bin/plutil', '/usr/bin/codesign'])

    await updates.install()
    assert.deepEqual(steps, ['stopHost'])
    assert.equal(quitCalls, 1)
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].cmd, '/bin/sh')
    assert.equal(spawned[0].opts.detached, true)
    // args: ['-c', script, 'ds-bot-mac-updater', pid, appPath, stagedApp, relaunch, stageDir, logFile]
    assert.equal(spawned[0].args[3], '4242')
    assert.equal(spawned[0].args[4], '/Applications/DS Bot.app')
    assert.equal(spawned[0].args[6], '1')

    // Subsequent will-quit hook must not double-spawn after explicit quitAndInstall.
    willQuitHooks[0]()
    assert.equal(spawned.length, 1)
  })

  test('autoInstallOnAppQuit swaps with relaunch=0 on quit and respects disabling before quit', async (t) => {
    for (const disableBeforeQuit of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'ds-bot-mac-upd-quit-'))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      const zipBytes = Buffer.from('fake-zip-bytes')
      const rel = makeRelease('0.4.1')
      const spawned = []
      const willQuitHooks = []
      const { execFile } = makeFakeExecFile({
        plist: { CFBundleIdentifier: 'io.github.fei2411.dsbot', CFBundleShortVersionString: '0.4.1', CFBundleExecutable: 'DS Bot' },
      })

      const updater = createMacUpdater({
        current: '0.4.0',
        arch: 'arm64',
        appPath: '/Applications/DS Bot.app',
        stagingRoot: join(root, 'staging'),
        execFile,
        spawn: (cmd, args) => { spawned.push({ cmd, args }); return { unref() {} } },
        onWillQuit: (fn) => { willQuitHooks.push(fn) },
        log: quietLog(),
        fetch: async (url) => {
          if (url.includes('api.github.com')) return makeResponse([rel], { url })
          if (url.endsWith('SHA256SUMS.txt')) return makeResponse(`${sha256Hex(zipBytes)}  DS-Bot-0.4.1-mac-arm64.zip\n`, { url })
          return makeResponse(zipBytes, { url })
        },
      })

      const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
      t.after(updates.stop)
      const latest = await updates.latest()
      assert.equal(await latest.downloaded, true)
      if (disableBeforeQuit) updates.setAutoUpdate(false)
      willQuitHooks[0]()
      if (disableBeforeQuit) assert.equal(spawned.length, 0)
      else {
        assert.equal(spawned.length, 1)
        assert.equal(spawned[0].args[6], '0', 'quit-install must not reopen the app')
      }
    }
  })

  test('rejects SHA-256 mismatch, bad bundle id, version mismatch, codesign failure, and non-HTTPS redirect', async (t) => {
    const zipBytes = Buffer.from('good-zip')
    const goodHash = sha256Hex(zipBytes)
    const cases = [
      {
        name: 'SHA-256 mismatch',
        sums: `${'0'.repeat(64)}  DS-Bot-0.4.1-mac-arm64.zip\n`,
        plist: { CFBundleIdentifier: 'io.github.fei2411.dsbot', CFBundleShortVersionString: '0.4.1', CFBundleExecutable: 'DS Bot' },
      },
      {
        name: 'wrong bundle id',
        sums: `${goodHash}  DS-Bot-0.4.1-mac-arm64.zip\n`,
        plist: { CFBundleIdentifier: 'com.evil.app', CFBundleShortVersionString: '0.4.1', CFBundleExecutable: 'DS Bot' },
      },
      {
        name: 'version mismatch',
        sums: `${goodHash}  DS-Bot-0.4.1-mac-arm64.zip\n`,
        plist: { CFBundleIdentifier: 'io.github.fei2411.dsbot', CFBundleShortVersionString: '0.3.0', CFBundleExecutable: 'DS Bot' },
      },
      {
        name: 'path traversal executable',
        sums: `${goodHash}  DS-Bot-0.4.1-mac-arm64.zip\n`,
        plist: { CFBundleIdentifier: 'io.github.fei2411.dsbot', CFBundleShortVersionString: '0.4.1', CFBundleExecutable: '../MacOS/DS Bot' },
      },
      {
        name: 'codesign failure',
        sums: `${goodHash}  DS-Bot-0.4.1-mac-arm64.zip\n`,
        plist: { CFBundleIdentifier: 'io.github.fei2411.dsbot', CFBundleShortVersionString: '0.4.1', CFBundleExecutable: 'DS Bot' },
        failCodesign: true,
      },
      {
        name: 'non-HTTPS redirect on production feed',
        sums: `${goodHash}  DS-Bot-0.4.1-mac-arm64.zip\n`,
        plist: { CFBundleIdentifier: 'io.github.fei2411.dsbot', CFBundleShortVersionString: '0.4.1', CFBundleExecutable: 'DS Bot' },
        zipRedirectUrl: 'http://mirror.example.com/DS-Bot.zip',
      },
    ]

    for (const c of cases) {
      const root = mkdtempSync(join(tmpdir(), 'ds-bot-mac-upd-neg-'))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      const rel = makeRelease('0.4.1')
      const { execFile } = makeFakeExecFile({ plist: c.plist, failCodesign: c.failCodesign })
      const updater = createMacUpdater({
        current: '0.4.0',
        arch: 'arm64',
        appPath: '/Applications/DS Bot.app',
        stagingRoot: join(root, 'staging'),
        execFile,
        spawn: () => { throw new Error('must not spawn on failure') },
        log: quietLog(),
        fetch: async (url) => {
          if (url.includes('api.github.com')) return makeResponse([rel], { url })
          if (url.endsWith('SHA256SUMS.txt')) return makeResponse(c.sums, { url })
          return makeResponse(zipBytes, { url: c.zipRedirectUrl ?? url })
        },
      })
      const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
      t.after(updates.stop)
      const latest = await updates.latest()
      assert.equal(await latest.downloaded, false, c.name)
      assert.equal(updates.state().phase, 'failed', c.name)
      // Failed staging directory must be cleaned up.
      const remaining = readdirSync(join(root, 'staging'))
      assert.deepEqual(remaining, [], `staging cleaned after ${c.name}`)
    }
  })

  test('cancelling background download keeps phase available and allows manual download', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-mac-upd-cancel-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const zipBytes = Buffer.from('fake-zip-bytes')
    const rel = makeRelease('0.4.1')
    let zipRequests = 0
    const { execFile } = makeFakeExecFile({
      plist: { CFBundleIdentifier: 'io.github.fei2411.dsbot', CFBundleShortVersionString: '0.4.1', CFBundleExecutable: 'DS Bot' },
    })

    const updater = createMacUpdater({
      current: '0.4.0',
      arch: 'arm64',
      appPath: '/Applications/DS Bot.app',
      stagingRoot: join(root, 'staging'),
      execFile,
      spawn: () => ({ unref() {} }),
      log: quietLog(),
      fetch: async (url, init) => {
        if (url.includes('api.github.com')) return makeResponse([rel], { url })
        if (url.endsWith('SHA256SUMS.txt')) return makeResponse(`${sha256Hex(zipBytes)}  DS-Bot-0.4.1-mac-arm64.zip\n`, { url })
        zipRequests += 1
        if (zipRequests === 1) {
          // Hold the first request until cancelled by setAutoUpdate(false).
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('Aborted')
              err.name = 'AbortError'
              reject(err)
            })
          })
        }
        return makeResponse(zipBytes, { url })
      },
    })

    const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
    t.after(updates.stop)
    await sleep(20)
    assert.equal(updates.state().phase, 'downloading')

    updates.setAutoUpdate(false)
    assert.equal(updates.state().phase, 'available')
    assert.equal(updates.state().canDownload, true)

    updates.download()
    for (let i = 0; i < 100 && updates.state().phase !== 'downloaded'; i += 1) await sleep(10)
    assert.equal(updates.state().phase, 'downloaded')
    assert.equal(updates.state().autoInstall, false)
  })
})

describe('createMacUpdater (real macOS bundle contract)', { skip: process.platform !== 'darwin' }, () => {
  function buildRealSignedApp(dir, version) {
    const appPath = join(dir, 'DS Bot.app')
    const macosDir = join(appPath, 'Contents', 'MacOS')
    const resDir = join(appPath, 'Contents', 'Resources')
    const fwVersions = join(appPath, 'Contents', 'Frameworks', 'Test.framework', 'Versions', 'A')
    const fwRes = join(fwVersions, 'Resources')
    mkdirSync(macosDir, { recursive: true })
    mkdirSync(resDir, { recursive: true })
    mkdirSync(fwRes, { recursive: true })
    const fwBin = join(fwVersions, 'Test')
    writeFileSync(fwBin, `#!/bin/sh\necho "framework-${version}"\n`)
    chmodSync(fwBin, 0o755)
    writeFileSync(join(fwRes, 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '  <key>CFBundleIdentifier</key><string>io.github.fei2411.dsbot.testfw</string>',
      '  <key>CFBundleName</key><string>Test</string>',
      '  <key>CFBundleExecutable</key><string>Test</string>',
      `  <key>CFBundleShortVersionString</key><string>${version}</string>`,
      `  <key>CFBundleVersion</key><string>${version}</string>`,
      '  <key>CFBundlePackageType</key><string>FMWK</string>',
      '</dict></plist>',
    ].join('\n'))
    // Real framework symlinks matching Electron's layout (regression guard for #1994).
    const fwRoot = join(appPath, 'Contents', 'Frameworks', 'Test.framework')
    symlinkSync('A', join(fwRoot, 'Versions', 'Current'))
    symlinkSync('Versions/Current/Test', join(fwRoot, 'Test'))
    symlinkSync('Versions/Current/Resources', join(fwRoot, 'Resources'))
    writeFileSync(join(appPath, 'Contents', 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '  <key>CFBundleIdentifier</key><string>io.github.fei2411.dsbot</string>',
      '  <key>CFBundleName</key><string>DS Bot</string>',
      '  <key>CFBundleExecutable</key><string>DS Bot</string>',
      `  <key>CFBundleShortVersionString</key><string>${version}</string>`,
      `  <key>CFBundleVersion</key><string>${version}</string>`,
      '  <key>CFBundlePackageType</key><string>APPL</string>',
      '</dict></plist>',
    ].join('\n'))
    const exe = join(macosDir, 'DS Bot')
    writeFileSync(exe, `#!/bin/sh\necho "${version}"\n`)
    chmodSync(exe, 0o755)
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
    return appPath
  }

  test('downloads real zip, preserves symlinks + ad-hoc seal, and atomically swaps bundle on exit', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-mac-real-contract-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const installDir = join(root, 'Applications')
    const buildDir = join(root, 'build')
    const stagingRoot = join(root, 'staging')
    const logFile = join(root, 'logs', 'mac-updater.log')
    mkdirSync(installDir, { recursive: true })
    mkdirSync(buildDir, { recursive: true })

    const targetApp = buildRealSignedApp(installDir, '0.4.0')
    const newApp = buildRealSignedApp(buildDir, '0.4.1')
    const assetName = `DS-Bot-0.4.1-mac-${process.arch}.zip`
    const zipFile = join(root, assetName)
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', newApp, zipFile])
    const zipBytes = readFileSync(zipFile)
    const sumsText = `${sha256Hex(zipBytes)}  ${assetName}\n`

    let baseUrl = ''
    const server = createServer((req, res) => {
      if (req.url === '/releases.json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([makeRelease('0.4.1', { arch: process.arch, baseUrl })]))
        return
      }
      if (req.url === `/v0.4.1/${assetName}`) {
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBytes.length) })
        res.end(zipBytes)
        return
      }
      if (req.url === '/v0.4.1/SHA256SUMS.txt') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(sumsText)) })
        res.end(sumsText)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    baseUrl = `http://127.0.0.1:${String(server.address().port)}`

    // Spawn a real dummy process simulating the exiting Electron main process.
    const dummy = spawn('/bin/sleep', ['60'])
    t.after(() => { try { dummy.kill('SIGKILL') } catch { /* already exited */ } })

    const bundle = resolveMacAppBundle(join(targetApp, 'Contents', 'MacOS', 'DS Bot'))
    assert.deepEqual(bundle, { eligible: true, appPath: targetApp })

    const updater = createMacUpdater({
      current: '0.4.0',
      arch: process.arch,
      appPath: targetApp,
      stagingRoot,
      logFile,
      pid: dummy.pid,
      quit: () => { dummy.kill('SIGTERM') },
      log: quietLog(),
    })

    const updates = watchUpdates({
      updater,
      feed: `${baseUrl}/releases.json`,
      beforeInstall: async () => {},
      log: quietLog(),
    })
    t.after(updates.stop)

    const latest = await updates.latest()
    assert.equal(latest.version, '0.4.1')
    assert.equal(await latest.downloaded, true)
    assert.equal(updates.state().phase, 'downloaded')

    // Trigger install with relaunch=false so the test never pops an open GUI window.
    updater.quitAndInstall(true, false)

    // Wait for the detached /bin/sh swap script to replace DS Bot.app after dummy exits.
    const deadline = Date.now() + 15_000
    let swappedVersion = '0.4.0'
    while (Date.now() < deadline) {
      try {
        const plistJson = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(targetApp, 'Contents', 'Info.plist')], { encoding: 'utf8' })
        swappedVersion = JSON.parse(plistJson).CFBundleShortVersionString
        if (swappedVersion === '0.4.1') break
      } catch { /* mid-swap */ }
      await sleep(50)
    }
    assert.equal(swappedVersion, '0.4.1', `swap log:\n${readFileSync(logFile, 'utf8')}`)

    // Wait briefly for cleanup after swap.
    for (let i = 0; i < 40 && readdirSync(installDir).length > 1; i += 1) await sleep(50)
    assert.deepEqual(readdirSync(installDir), ['DS Bot.app'], 'no leftover .old/.new sibling bundles')

    // Verify symlinks, executable bit, ad-hoc codesign integrity, and absence of quarantine.
    const fwLink = join(targetApp, 'Contents', 'Frameworks', 'Test.framework', 'Test')
    assert.equal(lstatSync(fwLink).isSymbolicLink(), true, 'framework symlink preserved')
    assert.equal(readlinkSync(fwLink), 'Versions/Current/Test')
    assert.equal(execFileSync(join(targetApp, 'Contents', 'MacOS', 'DS Bot'), [], { encoding: 'utf8' }).trim(), '0.4.1')
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', targetApp])
    const xattrs = execFileSync('/usr/bin/xattr', [targetApp], { encoding: 'utf8' })
    assert.equal(xattrs.includes('com.apple.quarantine'), false, 'no quarantine xattr on updated app')
  })

  test('rejects a zip whose signed bundle was tampered with and leaves target untouched', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-mac-tampered-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const installDir = join(root, 'Applications')
    const buildDir = join(root, 'build')
    mkdirSync(installDir, { recursive: true })
    mkdirSync(buildDir, { recursive: true })

    const targetApp = buildRealSignedApp(installDir, '0.4.0')
    const badApp = buildRealSignedApp(buildDir, '0.4.1')
    // Tamper with the executable AFTER signing so codesign --verify --deep --strict must fail.
    writeFileSync(join(badApp, 'Contents', 'MacOS', 'DS Bot'), '#!/bin/sh\necho tampered\n')
    chmodSync(join(badApp, 'Contents', 'MacOS', 'DS Bot'), 0o755)

    const assetName = `DS-Bot-0.4.1-mac-${process.arch}.zip`
    const zipFile = join(root, assetName)
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', badApp, zipFile])
    const zipBytes = readFileSync(zipFile)
    const sumsText = `${sha256Hex(zipBytes)}  ${assetName}\n`

    let baseUrl = ''
    const server = createServer((req, res) => {
      if (req.url === '/releases.json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([makeRelease('0.4.1', { arch: process.arch, baseUrl })]))
        return
      }
      if (req.url === `/v0.4.1/${assetName}`) {
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBytes.length) })
        res.end(zipBytes)
        return
      }
      if (req.url === '/v0.4.1/SHA256SUMS.txt') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(sumsText)) })
        res.end(sumsText)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    baseUrl = `http://127.0.0.1:${String(server.address().port)}`

    const updater = createMacUpdater({
      current: '0.4.0',
      arch: process.arch,
      appPath: targetApp,
      stagingRoot: join(root, 'staging'),
      log: quietLog(),
    })

    const updates = watchUpdates({ updater, feed: `${baseUrl}/releases.json`, beforeInstall: async () => {}, log: quietLog() })
    t.after(updates.stop)

    const latest = await updates.latest()
    assert.equal(await latest.downloaded, false)
    assert.equal(updates.state().phase, 'failed')
    assert.equal(execFileSync(join(targetApp, 'Contents', 'MacOS', 'DS Bot'), [], { encoding: 'utf8' }).trim(), '0.4.0')
  })
})
