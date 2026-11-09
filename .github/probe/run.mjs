import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })
const dir = join('node_modules/@deepseek-ai/dsh-experimental-cua-macos/native/bin', `darwin-${process.arch}`)
const { bundle } = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8'))
const helper = join(process.cwd(), dir, bundle, 'DSH Computer Use.app')
console.log(sh('/usr/bin/sw_vers', []).stdout, sh('/usr/bin/uname', ['-m']).stdout)
console.log(sh('/usr/sbin/system_profiler', ['SPDisplaysDataType']).stdout.slice(0, 800))
console.log(sh('/usr/bin/codesign', ['-dv', helper]).stderr)

async function attempt(label, app) {
  const exe = join(app, 'Contents/MacOS/dsh-cua-native')
  const key = createHash('sha256').update(readFileSync(exe)).digest('hex')
  const runtime = mkdtempSync('/tmp/dsbp-')
  const started = Date.now()
  const launcher = spawn(exe, ['--ensure-shared', '--runtime-key', key, '--runtime-directory', runtime, '--startup-timeout-ms', '25000'], { stdio: 'inherit' })
  const sampler = setTimeout(() => {
    for (const pid of sh('/usr/bin/pgrep', ['-x', 'dsh-cua-native']).stdout.trim().split('\n').filter(Boolean)) {
      const file = join(runtime, `sample-${pid}.txt`)
      sh('/usr/bin/sample', [pid, '3', '-file', file])
      console.log(`--- ${label}: sample of ${pid}`)
      try { console.log(readFileSync(file, 'utf8').slice(0, 6000)) } catch (error) { console.log(String(error)) }
    }
  }, 14000)
  const code = await new Promise((done) => launcher.on('close', done))
  clearTimeout(sampler)
  console.log(`=== ${label}: exit ${code} after ${Date.now() - started} ms; socket ${readdirSync(runtime).some(n => n.endsWith('.sock'))}`)
  sh('/usr/bin/pkill', ['-x', 'dsh-cua-native'])
  await sleep(2000)
}

await attempt('in place', helper)
const outer = mkdtempSync('/tmp/dsbo-') + '/Outer.app'
mkdirSync(join(outer, 'Contents/MacOS'), { recursive: true })
mkdirSync(join(outer, 'Contents/Resources'), { recursive: true })
writeFileSync(join(outer, 'Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>probe.outer</string><key>CFBundleExecutable</key><string>outer</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
sh('/bin/cp', ['/usr/bin/true', join(outer, 'Contents/MacOS/outer')])
sh('/usr/bin/ditto', [helper, join(outer, 'Contents/Resources/DSH Computer Use.app')])
console.log(sh('/usr/bin/codesign', ['-s', '-', '--force', outer]).stderr)
await attempt('nested in a signed app', join(outer, 'Contents/Resources/DSH Computer Use.app'))
const copy = mkdtempSync('/tmp/dsbc-') + '/DSH Computer Use.app'
sh('/usr/bin/ditto', [helper, copy])
sh('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', copy])
await attempt('copied outside', copy)
