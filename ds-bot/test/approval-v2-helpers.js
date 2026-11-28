// V2 risk-driven review test harness. One isolated project directory per test,
// the real host filesystem service (dsh-fs-local over the fixture), and a
// scripted review-model stream. The review loop is text-based: each round the
// host sends one user message whose payload JSON gains an `evidence` array as
// inspections return, so the round number is the count of evidence items.
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { install } from '../src/host/approvals.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const tick = () => new Promise(resolve => setImmediate(resolve))
export const ticks = async (n = 8) => { for (let i = 0; i < n; i += 1) await tick() }

export const user = (text, seq) => ({
  type: 'user/message', ...(seq === undefined ? {} : { seq }),
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
export const scheduled = (text, seq) => ({
  type: 'user/message', ...(seq === undefined ? {} : { seq }),
  data: { source: { kind: 'schedule' }, content: [{ type: 'text', text }] },
})

export const review = ({ risk = 'low', auth = 'unknown', evidence = [], outcome = 'allow', rationale = 'A short diagnostic.' } = {}) =>
  JSON.stringify({ risk_level: risk, user_authorization: { level: auth, evidence }, outcome, rationale })
export const inspect = (kind, target, reason = 'Need this fact for the verdict.') =>
  JSON.stringify({ inspect: { kind, ...(target === undefined ? {} : { target }), reason } })

// A benign npm project: plain local scripts, no lifecycle hooks, no network
// effects in any configured step.
export function writeProject(root, { manifest, lockfile, npmrc, extra } = {}) {
  mkdirSync(root, { recursive: true })
  const base = {
    name: 'fixture-project', version: '1.0.0', private: true,
    scripts: { build: 'node scripts/build.js', test: 'node scripts/test.js' },
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest ?? base, null, 2))
  writeFileSync(join(root, lockfile === undefined ? 'package-lock.json' : 'package-lock.json'), lockfile ?? JSON.stringify({
    name: 'fixture-project', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'fixture-project', version: '1.0.0' } },
  }, null, 2))
  if (npmrc !== undefined) writeFileSync(join(root, '.npmrc'), npmrc)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'build.js'), 'console.log("build ok")\n')
  writeFileSync(join(root, 'scripts', 'test.js'), 'console.log("test ok")\n')
  for (const [name, content] of Object.entries(extra ?? {})) writeFileSync(join(root, name), content)
  return root
}

// Payload of the single user message the host sends the review model.
export function payloadOf(args) {
  const text = args?.messages?.[0]?.content?.[0]?.text
  if (typeof text !== 'string') return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

export function setupV2(t, options = {}) {
  const listeners = new Map()
  const dispose = []
  const bots = { b: { id: 'b', permission: options.enabled !== false ? 'review' : 'workspace-write' } }
  const rooms = { r: { id: 'r', sessionId: 'relay-current', permission: 'review' }, r2: { id: 'r2', sessionId: 'relay-other', permission: 'review' } }
  const agents = {
    b: { id: 'b', session: { id: 'b', header: {} } },
    g: { id: 'g', session: { id: 'g', header: {} } },
    child: { id: 'child', session: { id: 'child', header: { parentSession: 'b', origin: 'subagent' } } },
  }
  for (const id of ['r', 'relay-current', 'relay-other', 'relay-new', 'g2']) agents[id] = { id, session: { id, header: {} } }
  agents.groupChild = { id: 'groupChild', session: { id: 'groupChild', header: { parentSession: 'g', origin: 'subagent' } } }

  // Isolated real project on disk. The working directory of every owned
  // Session resolves here unless a test redirects it.
  const root = mkdtempSync(join(tmpdir(), 'dsbot-v2-'))
  const project = writeProject(join(root, 'project'), options.project ?? {})
  const scratch = join(root, 'scratch')
  mkdirSync(scratch, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const cordis = new Context()
  const realfs = new LocalFileSystem(cordis, { cwd: project, diffBasisMaxBytes: 1024 * 1024 })
  t.after(() => cordis.dispose?.().catch(() => {}))
  // Read counting proves a bound holds before allocation, and that a refused
  // target was never opened at all. Wraps preserve the real backend behavior.
  const fileOps = []
  for (const method of ['readBytes', 'readText', 'streamText']) {
    if (typeof realfs[method] !== 'function') continue
    const original = realfs[method].bind(realfs)
    realfs[method] = (...args) => {
      const target = args[0]
      const path = typeof target === 'string' ? target : target?.displayPath ?? target?.targetKey ?? JSON.stringify(target)
      fileOps.push({ op: method, path })
      return original(...args)
    }
  }

  const sessionDirs = options.sessionDirs ?? {}
  const directories = Object.fromEntries(Object.keys(agents).map(id => [id, sessionDirs[id] ?? project]))
  const workingDirectory = { get: session => directories[session.id], ensure: async agent => directories[agent.session.id] }
  const shell = { resolve: request => ({ ...request, workdir: request.workdir }) }

  const calls = []
  const events = options.events ?? []
  const groupEvents = options.groupEvents ?? new Map()
  const rt = {
    state: { prefs: options.prefs ?? {} }, chatOwners: new Map([['b', 'b']]), groupOwners: new Map([['g', { botId: 'b', roomId: 'r' }], ['g2', { botId: 'b', roomId: 'r2' }]]),
    botOf: id => bots[id], roomOf: id => rooms[id], resolveAgent: async id => agents[id],
    sessionOfRoom: room => room?.sessionId ?? room?.id,
    defaultBotModel: async () => 'mock/default', save: async () => {}, warn() {},
    ...(options.redactSecrets ? { redactSecrets: options.redactSecrets } : {}),
    async *eventsBackwards(id) { yield* [...(id === 'b' ? events : groupEvents.get(id) ?? [])].reverse() },
    groupLinesAfter: options.groupLines ?? (async () => []),
    ctx: {
      on(name, fn) { listeners.set(name, fn) }, effect(fn) { dispose.push(fn()) },
      get: name => name === 'workingDirectory' ? workingDirectory : name === 'shell' ? shell : name === 'fs' ? realfs : ({ request: request => listeners.get('approval/request')(request, () => new Promise(() => {})) }),
      llm: {
        resolveModelInfo: async () => ({}),
        listConfigurableProviders: () => [{ provider: 'mock', defaultBaseURL: 'http://127.0.0.1:8899/v1' }],
        async *stream(args) {
          calls.push(args)
          if (options.hold) await options.hold
          const payload = payloadOf(args)
          const round = Array.isArray(payload?.evidence) ? payload.evidence.length : 0
          // Post-inspection mutation window: evidence already read can drift
          // before the verdict, which is exactly what stale-evidence re-checks
          // must catch. Runs once, after the first inspection round.
          if (round === 1 && options.mutate && !options.mutate.done) { options.mutate.done = true; options.mutate() }
          const script = options.script ?? [options.reply ?? review()]
          const step = typeof script === 'function' ? script({ args, payload, round }) : script[Math.min(round, script.length - 1)]
          if (step?.hold) await step.hold
          if (step?.error) throw new Error(typeof step.error === 'string' ? step.error : 'provider failed')
          if (step?.finish === 'length') {
            yield { type: 'text-delta', index: 0, text: step.text ?? '' }
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
            return
          }
          const text = typeof step === 'string' ? step : step?.text ?? review()
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: { kind: step?.finish ?? 'stop' } }
        },
      },
    },
  }
  install(rt)
  t.after(() => dispose.forEach(fn => fn?.()))

  const ask = ({ sessionId = 'b', callId = 'c', command = 'npm test', signal, evidence, capture = true, toolName = 'bash', args = { command } } = {}) => {
    const agent = agents[sessionId]
    const start = async () => {
      if (capture) await listeners.get('tools/pre-execute')({ agent, callId, name: toolName, arguments: args, signal }, async () => ({ kind: 'allow' }))
      const request = { agent, callId, toolName, reason: 'Requires approval', signal }
      return evidence ? rt.requestActionApproval(request, evidence) : listeners.get('approval/request')(request, options.next ?? (() => new Promise(() => {})))
    }
    return start()
  }
  const poll = async (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const waitForCalls = async (count = 1) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (calls.length >= count) return
      await poll(3)
    }
    assert.fail('the review model was never called')
  }
  const waitManual = async () => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (rt.approvalsView()[0]?.review?.status === 'manual') return rt.approvalsView()[0]
      await poll(3)
    }
    assert.fail('manual fallback did not open')
  }
  const outcome = async (result, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const settled = await Promise.race([result.then(value => ({ value }), error => ({ error })), poll(2).then(() => undefined)])
      if (settled !== undefined) {
        if (settled.error) throw settled.error
        return settled.value
      }
    }
    assert.fail('the approval never settled')
  }
  const insert = (sessionId, target, message) => {
    const agent = agents[sessionId]
    agent.inbox ??= { nextStep: [], nextTurn: [] }
    agent.inbox[target === 'next-step' ? 'nextStep' : 'nextTurn'].push(message)
    listeners.get('session/event')?.(agent.session, { type: 'agent/inbox/spliced', data: { target, start: 0, inserted: [message] } })
  }
  return {
    rt, ask, calls, bots, rooms, events, groupEvents, waitManual, waitForCalls, outcome, insert,
    agents, directories, workingDirectory, shell, fs: realfs, listeners, root, project, scratch, resolve, fileOps,
  }
}
