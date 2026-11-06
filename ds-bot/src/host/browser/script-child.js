// The child process side of browser_exec. The script runs in a fresh vm context that
// has only the JavaScript built-ins: no process, require, import(), fetch or timers of
// this realm. This realm does have Node, so no object of it may ever reach the script:
// the context gets only the two functions `call` and `finish`, they take and hand back
// strings and null only, and they never throw, because an exception would carry this
// realm's constructors back into the script. The prelude keeps its own copies of the
// built-ins it uses, so a script that rewrites JSON or String cannot feed the bridge
// something else. It is a process and not a worker thread because a worker that runs
// out of heap in one large allocation aborts the whole host; this process only ends
// itself, and the host can kill it when the script never returns.
import vm from 'node:vm'

const PRELUDE = `'use strict';
(function (call, finish, namesJson, body) {
  const { parse, stringify } = JSON
  const toText = String
  const PromiseOf = Promise
  const ErrorOf = Error
  const names = parse(namesJson)
  // No stack hook: V8 would hand it call sites of whatever is on the stack.
  Object.defineProperty(ErrorOf, 'prepareStackTrace', { value: undefined, writable: false, configurable: false })
  // Frames would show this process's file paths; the script has no use for them.
  Object.defineProperty(ErrorOf, 'stackTraceLimit', { value: 0, writable: false, configurable: false })
  const describe = error => {
    try { return toText(error !== null && typeof error === 'object' && 'message' in error ? error.message : error) } catch { return 'Script failed.' }
  }
  const ask = name => (...args) => new PromiseOf((resolve, reject) => {
    // JSON turns a trailing undefined into null, which would defeat a helper's default.
    while (args.length > 0 && args[args.length - 1] === undefined) args.length -= 1
    const json = stringify(args)
    // Several copies of a huge argument would exhaust this process's heap mid-call.
    if (typeof json === 'string' && json.length > 4_000_000) {
      reject(new ErrorOf('Helper arguments are larger than 4 MB.'))
      return
    }
    call(name, json, value => {
      try { resolve(value === null ? undefined : parse(value)) } catch (error) { reject(error) }
    }, message => reject(new ErrorOf(message)))
  })
  const helpers = []
  for (let index = 0; index < names.length; index += 1) helpers[index] = ask(names[index])
  let answer
  const done = value => { answer = value }
  const timers = new Set()
  let lastTimer = 0
  const setTimeout = (fn, ms, ...rest) => {
    const id = ++lastTimer
    timers.add(id)
    call('wait', stringify([+ms || 0]), () => { if (timers.delete(id) && typeof fn === 'function') fn(...rest) }, () => {})
    return id
  }
  const clearTimeout = id => { timers.delete(id) }
  const noop = () => {}
  const console = { log: noop, info: noop, warn: noop, error: noop, debug: noop }
  const settle = value => {
    let text = null
    try { text = value === undefined ? null : toText(value) } catch (error) { finish(null, describe(error)); return }
    finish(text, null)
  }
  let run
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    run = new AsyncFunction(...names, 'done', 'setTimeout', 'clearTimeout', 'console', '"use strict";\\n' + body)
  } catch (error) {
    finish(null, describe(error))
    return
  }
  run(...helpers, done, setTimeout, clearTimeout, console).then(value => settle(answer ?? value), error => finish(null, describe(error)))
})`

const waiting = new Map()
let lastCall = 0
let waitLimit = 0

// Calls a function of the context with plain arguments and no `this`; what it throws
// is the context's own and stays here.
const invoke = (fn, value) => {
  try { if (typeof fn === 'function') fn(value) } catch {}
}

const send = message => {
  try { process.send(message) } catch {}
}

const call = (name, args, resolve, reject) => {
  try {
    if (typeof name !== 'string' || typeof args !== 'string') {
      invoke(reject, 'Helper arguments must be plain JSON values.')
      return
    }
    if (name === 'wait') {
      let ms = 0
      try { ms = Number(JSON.parse(args)[0]) } catch {}
      setTimeout(() => invoke(resolve, null), Number.isFinite(ms) ? Math.min(Math.max(ms, 0), waitLimit) : 0)
      return
    }
    const id = ++lastCall
    waiting.set(id, { resolve, reject })
    send({ type: 'call', id, name, args })
  } catch {
    invoke(reject, 'The helper call failed.')
  }
}

const finish = (answer, error) => {
  const valid = (typeof answer === 'string' || answer === null) && (typeof error === 'string' || error === null)
  send(valid ? { type: 'done', answer, error } : { type: 'done', answer: null, error: 'Script produced an answer that is not text.' })
}

const start = ({ body, names, wait }) => {
  waitLimit = wait
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false } })
  const install = new vm.Script(PRELUDE, { filename: 'browser_exec' }).runInContext(context)
  install(call, finish, JSON.stringify(names), body)
}

let started = false
process.on('message', message => {
  if (message?.type === 'start') {
    if (started || typeof message.body !== 'string' || !Array.isArray(message.names)) return
    started = true
    start(message)
    return
  }
  const waiter = waiting.get(message?.id)
  if (waiter === undefined) return
  waiting.delete(message.id)
  const ok = message.ok === true && (typeof message.value === 'string' || message.value === null)
  if (ok) invoke(waiter.resolve, message.value)
  else invoke(waiter.reject, typeof message.error === 'string' ? message.error : 'The helper failed.')
})
// The host went away: nothing is left to answer the script.
process.on('disconnect', () => process.exit(0))
// A helper promise the script never awaited can reject; its reason belongs to the
// context and needs no handling here, and it must not end the run.
process.on('unhandledRejection', () => {})
