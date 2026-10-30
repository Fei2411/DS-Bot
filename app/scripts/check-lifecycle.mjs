// Check the window and the tray of the app in a real Electron, with a fake Host: no DSH, no
// model, no data of the user. The app hides the window instead of closing it, the tray opens
// it again, and a window that is gone for good is built anew and talks to the Host that runs.
// Usage: node scripts/check-lifecycle.mjs
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const electron = require('electron')
const here = import.meta.dirname
// The data of the run is a folder of its own in the app's own directory: the check never
// writes into the data of the user.
const work = join(here, '..', '.dsh-test-tray-lifecycle')

// The app answers over its standard output and over a plain socket. Both carry one answer
// per line, so that the check needs no dependency.
const answers = []
const waiters = []
let output = ''

const take = (answer) => {
  if (waiters.length > 0) waiters.shift()(answer)
  else answers.push(answer)
}

const nextAnswer = (timeout = 30_000) => {
  if (answers.length > 0) return Promise.resolve(answers.shift())
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { fail(new Error('the app did not answer in time')) }, timeout)
    waiters.push((value) => { clearTimeout(timer); done(value) })
  })
}

// A stream that carries one answer per line: the rest of it is the output of the app.
const reader = (keep = true) => {
  let buffer = ''
  return (chunk) => {
    if (keep) output += chunk
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.startsWith('{')) take(JSON.parse(line))
    }
  }
}

const fail = (message) => { throw new Error(message) }

let child
let connection

try {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  mkdirSync(work, { recursive: true })
  child = spawn(electron, [join(here, '..', 'test', 'electron', 'lifecycle-main.mjs')], {
    cwd: join(here, '..'),
    env: { ...process.env, DS_BOT_SHELL_DATA: work },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', reader())
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', reader())
  const exited = new Promise((done) => { child.once('exit', (code, signal) => { done({ code, signal }) }) })
  const broken = new Promise((_, fail) => { child.once('error', error => fail(error)) })

  const first = await Promise.race([
    nextAnswer(60_000),
    exited.then(outcome => fail(`the app ended before it answered (${JSON.stringify(outcome)})`)),
    broken,
  ])

  connection = net.connect(Number(first.port), '127.0.0.1')
  await new Promise((done, fail) => {
    connection.once('connect', done)
    connection.once('error', fail)
  })
  connection.setEncoding('utf8')
  connection.on('data', reader(false))
  const ask = async (command, timeout = 30_000) => {
    const answer = nextAnswer(timeout)
    connection.write(`${command}\n`)
    return answer
  }

  if (!first.ready) fail('the window did not start')
  if (first.visible !== true) fail('the window is not on the screen')
  if (!first.url?.startsWith('http://127.0.0.1:')) fail(`the window did not reach the Host: ${String(first.url)}`)
  if (first.title !== 'DeepSeek Bot') fail(`the page did not load: ${String(first.title)}`)
  if (first.hasTray !== true) fail('the tray is not there')
  console.log('check-lifecycle: the window shows the Host and the tray is there')

  const closed = await ask('close')
  if (closed.destroyed !== false) fail('the window was destroyed instead of hidden')
  if (closed.visible !== false) fail('the window is still on the screen')
  if (closed.quitting !== false) fail('the app ended with its window')
  console.log('check-lifecycle: the close hides the window and the app goes on')

  const opened = await ask('open')
  if (opened.visible !== true) fail('the tray did not open the window')
  if (opened.destroyed !== false) fail('the window was destroyed')
  console.log('check-lifecycle: the tray opens the window again')

  const gone = await ask('destroy')
  if (gone.destroyed !== null) fail('the window is still there')
  const rebuilt = await ask('open')
  if (rebuilt.visible !== true) fail('the tray did not build a new window')
  if (rebuilt.destroyed !== false) fail('the new window is not there')
  if (rebuilt.url?.includes('token=')) fail(`the new window used the launch URL again: ${String(rebuilt.url)}`)
  if (!rebuilt.url?.startsWith('http://127.0.0.1:')) fail(`the new window did not reach the Host: ${String(rebuilt.url)}`)
  if (rebuilt.hosts !== 1) fail('a second Host was started')
  console.log('check-lifecycle: a window that is gone is built anew and talks to the same Host')

  // The quit ends the app, so the answer never comes: the exit does.
  connection.write('quit\n')
  const outcome = await Promise.race([exited, sleep(20_000).then(() => undefined)])
  if (outcome === undefined) fail('the app did not end after the tray quit')
  if (outcome.code !== 0) fail(`the app ended with code ${String(outcome.code)}`)
  console.log('check-lifecycle: the tray quit ends the app')
  console.log('check-lifecycle: passed')
} catch (error) {
  console.error(`check-lifecycle: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  if (output !== '') console.error(output)
  process.exitCode = 1
} finally {
  connection?.destroy()
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGKILL')
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
