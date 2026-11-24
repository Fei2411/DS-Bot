import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as toolExecutorNative from '@deepseek-ai/dsh-tool-executor-native'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as toolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import ToolRuntime, { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
import { install as installSteer } from '../src/host/steer.js'
import { turnOf } from '../src/host/resume.js'
import { fakeContext } from './fake-ctx.js'
import { SOURCE_KIND, STEER_CUT } from '../src/host/constants.js'

// A user steer in a private Bot chat detaches a running shell call into a
// promoted job and cuts a running model call, so the steer is claimed at once.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

const SHELL_SCHEMA = { oneOf: [
  { properties: { kind: { const: 'foreground' }, exitCode: {} } },
  { properties: { kind: { const: 'promoted' }, cwd: {}, jobId: {}, timeoutMs: {}, output: {} } },
  { properties: { kind: { const: 'background' }, jobId: {} } },
] }

const shellDef = (name = 'pwsh') => {
  const calls = []
  return {
    calls,
    name,
    description: 'shell',
    output: {
      schema: SHELL_SCHEMA,
      render: (args, value) => [{ type: 'text', text: `exit ${value?.exitCode ?? '?'} out:${value?.stdout?.text ?? ''}` }],
    },
    execute: (args) => new Promise((res, rej) => { calls.push({ args, res, rej }) }),
  }
}

const jobsService = (read) => ({ read })

const start = async ({ services = {}, def = shellDef() } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-steer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  const agentMap = new Map()
  const deliveries = []
  const inboxOf = () => {
    const nextStep = []
    const nextTurn = []
    return { nextStep, nextTurn,
      prepend: (t, m) => (t === 'next-turn' ? nextTurn : nextStep).unshift(m),
      append: (t, m) => (t === 'next-turn' ? nextTurn : nextStep).push(m),
      remove: mid => { for (const l of [nextStep, nextTurn]) { const at = l.findIndex(m => m.id === mid); if (at !== -1) { l.splice(at, 1); return true } } return false },
    }
  }
  const calls = []
  const agentOf = (id, over = {}) => {
    const inbox = inboxOf()
    const agentListeners = new Map()
    const agent = {
      id,
      session: { id, header: { cwd: '/team' } },
      ctx: {
        tools: { register: t => (calls.push(['register', t]), () => {}), restrict: () => () => {} },
        on: (event, fn) => {
          calls.push(['on', event, fn])
          const list = agentListeners.get(event) ?? []
          list.push(fn)
          agentListeners.set(event, list)
          return () => {
            const at = list.indexOf(fn)
            if (at !== -1) list.splice(at, 1)
          }
        },
        effect: execute => execute?.(),
      },
      agentListeners,
      status: 'running',
      followup: msg => calls.push(['followup', msg]),
      inject: msg => calls.push(['inject', msg]),
      send: (msg, target) => inbox[target === 'next-turn' ? 'nextTurn' : 'nextStep'].push(msg),
      cancel: (cause, options) => calls.push(['cancel', cause, options]),
      inbox,
      ...over,
    }
    agentMap.set(id, agent)
    return agent
  }
  const agentById = agentOf('dm-a')
  ctx.tools.register({ ...def })
  ctx.tools.schemas = () => [{ name: 'pwsh' }, { name: 'bash' }, { name: 'ask_user_question' }]
  ctx.tools.get = (name) => (name === def.name ? def : undefined)
  ctx.tools.executable = (name) => (name === def.name ? def : undefined)
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => ({ id: 'w1', path: '/team' }), list: () => [{ id: 'w1', path: '/team' }], resolveByPath: async () => undefined, create: async p => ({ id: 'w1', path: p }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'dm-a' }), resolveAgent: async () => ({ agent: agentById }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const origGet = ctx.get
  let apiRoute
  ctx.connection.fetch.register = (route) => { apiRoute = route; return () => {} }
  Object.assign(ctx, { get: name => (name === 'agents' ? agentMap : origGet(name)) })
  const rt = createRuntime(ctx, { home })
  await rt.load?.()
  const call = async (endpoint, payload) => {
    const response = await apiRoute.fetch({ json: async () => ({ endpoint, payload }) })
    return response.json()
  }
  const origDeliver = rt.deliver
  rt.deliver = (...args) => { deliveries.push(args); return origDeliver ? origDeliver(...args) : Promise.resolve() }
  const emit = async (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) await listener({ id }, { type, data })
    }
    await new Promise(r => setTimeout(r, 0))
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  const shadowOf = (target = agentById) => {
    const handler = (target.agentListeners?.get('tools/execute') ?? []).at(-1)
    if (handler === undefined) return undefined
    return {
      calls: def.calls,
      async execute(args, exec) {
        const dispatchExec = { ...exec, arguments: args }
        const res = await handler(dispatchExec, async () => ({ isError: false, value: await def.execute(args, dispatchExec) }))
        if (res?.isError) {
          const err = new Error(res.error?.message ?? 'tool error')
          if (res.error?.code) err.code = res.error.code
          throw err
        }
        return res?.value
      },
    }
  }
  return { ctx, emit, stop, rt, agent: agentById, agentMap, calls, deliveries, shadowOf, call }
}

const userMessage = text => ({ id: `m-${text}`, content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' })
const execOf = (agent, callId = 'c1') => ({ agent, callId, name: 'pwsh', signal: AbortSignal.timeout(30_000) })

test('shell shadow: no steer returns the native value as is', async () => {
  const { stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(() => { throw new Error('no job') }) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const NATIVE = { kind: 'foreground', exitCode: 0 }
  const pending = shadow.execute({ command: 'pwd' }, execOf(agent))
  shadow.calls[0].res(NATIVE)
  assert.equal(await pending, NATIVE)
  await stop()
})

test('shell shadow: steer promotes the call and native settle notifies later', async () => {
  const { emit, stop, rt, agent, calls, shadowOf } = await start({ services: { jobs: jobsService((jobId) => ({
    job: { id: jobId, status: 'running', output: { spillPaths: ['/tmp/j1.log'] } },
    lossy: true,
    chunks: [
      { text: 'one', channel: 'stdout' },
      { text: 'oops', channel: 'stderr' },
      { text: 'two', channel: 'stdout' },
      { text: 'hidden', channel: 'log' },
    ],
  })) } })
  await emit('dm-a', 'turn/start', { turn: 1 })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 5', workdir: 'sub' }, execOf(agent))
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('hurry')] })
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  const value = await pending
  assert.equal(value.kind, 'promoted')
  assert.equal(value.jobId, 'j1')
  assert.equal(value.cwd, resolve('/team', 'sub'))
  assert.equal(value.output, 'onetwo\n[stderr]\noops\n[some output was dropped from memory; full output: /tmp/j1.log]')
  agent.status = 'idle'
  shadow.calls[0].res({ kind: 'foreground', exitCode: 0, stdout: { text: 'done' } })
  await new Promise(r => setTimeout(r, 0))
  const notice = calls.find(c => c[0] === 'followup')
  assert.ok(notice !== undefined)
  assert.equal(notice[1].content[0].text, 'background job j1 (pwsh: sleep 5) finished:\nexit 0 out:done')
  assert.equal(notice[1].source.kind, 'tool-jobs')
  await stop()
})

test('shell shadow: steer pending at call start keeps the native value inside the grace', async () => {
  const { stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(() => { throw new Error('no job') }) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  agent.inbox.nextStep.push(userMessage('waiting'))
  const pending = shadow.execute({ command: 'pwd' }, execOf(agent))
  // The native settles at once, inside the grace, so its own value comes back.
  const NATIVE = { kind: 'foreground', exitCode: 9 }
  shadow.calls[0].res(NATIVE)
  assert.equal(await pending, NATIVE)
  await stop()
})

test('shell shadow: steer before job registration detaches once registered', async () => {
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [{ text: 'x' }],
  })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 5' }, execOf(agent))
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  await new Promise(r => setTimeout(r, 1100))
  await emit('dm-a', 'job/registered', { jobId: 'j2', toolCall: { callId: 'c1' } })
  const value = await pending
  assert.equal(value.kind, 'promoted')
  assert.equal(value.jobId, 'j2')
  await stop()
})

test('shell shadow: a native rejection before any steer propagates unchanged', async () => {
  const { stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(() => ({ job: { status: 'running', output: {} }, chunks: [] })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const err = new Error('spawn failed')
  const pending = shadow.execute({ command: 'pwd' }, execOf(agent))
  shadow.calls[0].rej(err)
  await assert.rejects(pending, /spawn failed/)
  await stop()
})

test('shell shadow: non-private session, run_in_background and no jobs are passthrough', async () => {
  const { rt, agent, shadowOf } = await start({ services: { jobs: jobsService(() => { throw new Error('x') }) } })
  const { rt: rt2, stop: stop2, agent: noJobsAgent, shadowOf: noJobsShadow } = await start({ services: {} })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const NATIVE = { kind: 'foreground' }
  // run_in_background on the private chat is untouched.
  const p1 = shadow.execute({ command: 'pwd', run_in_background: true }, execOf(agent))
  shadow.calls[0].res(NATIVE)
  assert.equal(await p1, NATIVE)
  // A non-Bot session is untouched.
  const other = { ...agent, id: 'plain', session: { id: 'plain' } }
  const p2 = shadow.execute({ command: 'pwd' }, execOf(other))
  shadow.calls[1].res(NATIVE)
  assert.equal(await p2, NATIVE)
  // No jobs service at all is untouched.
  rt2.shadowShells(noJobsAgent)
  const shadow2 = noJobsShadow()
  const p3 = shadow2.execute({ command: 'pwd' }, execOf(noJobsAgent))
  shadow2.calls[0].res(NATIVE)
  assert.equal(await p3, NATIVE)
  await stop2()
})

test('shell shadow: a def without a promoted variant passes through without promoting', async () => {
  const def = shellDef()
  def.output.schema = { oneOf: [{ properties: { kind: { const: 'foreground' } } }] }
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(() => ({
    job: { id: 'j1', status: 'running', output: {} }, chunks: [],
  })) }, def })
  rt.state.prefs.backgroundAfterSec = 0.02
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 1' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  await new Promise(r => setTimeout(r, 50))
  const NATIVE = { kind: 'foreground', exitCode: 0 }
  shadow.calls[0].res(NATIVE)
  assert.equal(await pending, NATIVE)
  await stop()
})

test('shell shadow: a killed job gets no notice', async () => {
  const { emit, stop, rt, agent, calls, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 5' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  await emit('dm-a', 'tool/call', { name: 'job_kill', arguments: JSON.stringify({ job_id: 'j1' }) })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  assert.equal((await pending).kind, 'promoted')
  shadow.calls[0].res({ kind: 'foreground', exitCode: 0, stdout: { text: 'x' } })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(calls.find(c => c[0] === 'followup' || c[0] === 'inject'), undefined)
  await stop()
})

test('shell shadow: a replaced agent gets no notice', async () => {
  const { emit, stop, rt, agent, agentMap, calls, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 5' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  assert.equal((await pending).kind, 'promoted')
  agentMap.set('dm-a', { id: 'dm-a' })
  shadow.calls[0].res({ kind: 'foreground', exitCode: 0, stdout: { text: 'x' } })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(calls.find(c => c[0] === 'followup' || c[0] === 'inject'), undefined)
  await stop()
})

test('shell shadow: a terminal job read returns the native result', async () => {
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'completed', output: {} }, chunks: [],
  })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'pwd' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  const NATIVE = { kind: 'foreground', exitCode: 3 }
  shadow.calls[0].res(NATIVE)
  assert.equal(await pending, NATIVE)
  await stop()
})

test('shell shadow: a native promoted after detach injects only with output', async () => {
  const { emit, stop, rt, agent, calls, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 5' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  assert.equal((await pending).kind, 'promoted')
  shadow.calls[0].res({ kind: 'promoted', jobId: 'j1', output: 'still going' })
  await new Promise(r => setTimeout(r, 0))
  const notice = calls.find(c => c[0] === 'inject')
  assert.ok(notice !== undefined)
  assert.match(notice[1].content[0].text, /is still running\. Output since your last read:\nstill going/)
  await stop()
})

test('shell shadow: bash is shadowed the same way', async () => {
  const def = shellDef('bash')
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) }, def })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  assert.ok(shadow !== undefined)
  const pending = shadow.execute({ command: 'sleep 5' }, { agent, callId: 'b1', name: 'bash' })
  await emit('dm-a', 'job/registered', { jobId: 'jb', toolCall: { callId: 'b1' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  assert.equal((await pending).kind, 'promoted')
  await stop()
})

// Carry tests: the cut turn's routing state rides into the turn that claims the steer.
test('steer carry: a cut request turn hands its answer on the next turn', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'do the thing' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-b', exchangeId: 'x1', senderName: 'Writer' },
  })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'me too' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-c', exchangeId: 'x2', senderName: 'Ops' },
  })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'half done' }] } })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } })
  assert.deepEqual(deliveries, [])
  await emit(dm, 'turn/start', { turn: 2 })
  const entry = rt.live.get(dm)
  assert.equal(entry.info?.exchangeId, 'x1')
  assert.equal(entry.joined.length, 1)
  assert.equal(entry.carried, true)
  assert.deepEqual(entry.texts, ['half done'])
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } })
  await emit(dm, 'turn/end', { reason: { kind: 'completed' } })
  const reply = deliveries.find(d => d[0]?.replyTo === 'x1')
  assert.ok(reply !== undefined)
  assert.match(reply[0].text, /half done/)
  assert.match(reply[0].text, /all done/)
  const handback = deliveries.find(d => d[0]?.deferred === true)
  assert.ok(handback !== undefined)
  assert.equal(handback[0].exchangeId, 'x2')
  await stop()
})

test('steer carry: a plain user turn delivers nothing for the cut turn', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'half' }] } })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } })
  assert.deepEqual(deliveries, [])
  await emit(dm, 'turn/start', { turn: 2 })
  assert.deepEqual(rt.live.get(dm).texts, ['half'])
  await stop()
})

test('steer carry: a cut turn that ends on error keeps normal failure handling', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'do it' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-b', exchangeId: 'x1', senderName: 'Writer' },
  })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'over' } } })
  assert.equal(rt.live.get(dm).carry, undefined)
  const failed = deliveries.find(d => /could not answer/.test(d[0]?.text ?? ''))
  assert.ok(failed !== undefined)
  assert.equal(failed[0].replyTo, 'x1')
  await stop()
})

test('steer carry: a pending request survives a carry that reclaims the trigger', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'do the thing' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-b', exchangeId: 'x1', senderName: 'Writer' },
  })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'half done' }] } })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } })
  assert.deepEqual(deliveries, [])
  // Another request lands between the cut and the next turn: it waits as pending.
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: '[Ops → Chief]\nme later' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-c', exchangeId: 'x2', senderName: 'Ops' },
  })
  await emit(dm, 'turn/start', { turn: 2 })
  const entry = rt.live.get(dm)
  // The carry's own request reclaims the trigger; the pending one joins it deferred.
  assert.equal(entry.info?.exchangeId, 'x1')
  assert.equal(entry.joined.length, 1)
  assert.equal(entry.joined[0].info.exchangeId, 'x2')
  assert.equal(entry.joined[0].text, 'me later')
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } })
  await emit(dm, 'turn/end', { reason: { kind: 'completed' } })
  const reply = deliveries.find(d => d[0]?.replyTo === 'x1')
  assert.ok(reply !== undefined)
  assert.match(reply[0].text, /all done/)
  const handback = deliveries.find(d => d[0]?.deferred === true)
  assert.ok(handback !== undefined)
  assert.equal(handback[0].exchangeId, 'x2')
  assert.ok(!deliveries.some(d => /was stopped/.test(d[0]?.text ?? '')))
  await stop()
})

test('steer cut: a running part switch blocks the cut', async () => {
  const { emit, stop, rt, agent, calls } = await start()
  const dm = 'dm-a'
  // switchJobs() hands back a Map values iterator, never an array.
  const original = rt.switchJobs
  rt.switchJobs = () => new Map([['job', { botId: rt.chatOwners.get(dm) }]]).values()
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'step/start', { turn: 1, step: 1 })
  const steer = userMessage('还没好吗')
  agent.inbox.nextStep.push(steer)
  await emit(dm, 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] })
  assert.equal(calls.find(c => c[0] === 'cancel'), undefined)
  // A group part switch of the same Bot carries a roomId and must not block this cut.
  rt.switchJobs = () => new Map([['job', { botId: rt.chatOwners.get(dm), roomId: 'r1' }]]).values()
  await emit(dm, 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] })
  assert.deepEqual(calls.find(c => c[0] === 'cancel')?.[1], { kind: 'hook', reason: STEER_CUT })
  rt.switchJobs = original
  await stop()
})

// Model-cut tests.
test('steer cut: user steer during model phase cancels with hook and moves steer to next-turn', async () => {
  const { emit, stop, agent, calls } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'step/start', { turn: 1, step: 1 })
  const steer = userMessage('还没好吗')
  agent.inbox.nextStep.push(steer)
  await emit(dm, 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] })
  const cancel = calls.find(c => c[0] === 'cancel')
  assert.deepEqual(cancel?.[1], { kind: 'hook', reason: STEER_CUT })
  assert.deepEqual(cancel?.[2], { keepInbox: true })
  assert.deepEqual(agent.inbox.nextTurn.map(m => m.id), [steer.id])
  await stop()
})

test('steer cut: no cut during tools phase or for a non-Bot session', async () => {
  const { emit, stop, agent, calls } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'step/start', { turn: 1, step: 1 })
  await emit(dm, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call' }] } })
  const steer = userMessage('go')
  agent.inbox.nextStep.push(steer)
  await emit(dm, 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] })
  assert.equal(calls.find(c => c[0] === 'cancel'), undefined)
  await emit('plain', 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] })
  assert.equal(calls.find(c => c[0] === 'cancel'), undefined)
  await stop()
})

test('steer cut: earlier steers and queued next-turn keep order', async () => {
  const { emit, stop, agent } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'step/start', { turn: 1, step: 1 })
  const s1 = userMessage('one'); const s2 = userMessage('two')
  agent.inbox.nextStep.push(s1, s2)
  agent.inbox.nextTurn.push(userMessage('queued'))
  await emit(dm, 'agent/inbox/spliced', { target: 'next-step', inserted: [s2] })
  assert.deepEqual(agent.inbox.nextTurn.map(m => m.content[0].text), ['two', 'queued'])
  assert.deepEqual(agent.inbox.nextStep.map(m => m.content[0].text), ['one'])
  await stop()
})

test('steer resume: turnOf follows a steer cut to its continuation', async () => {
  const turn = (n, events = []) => [
    { type: 'turn/start', data: { turn: n } },
    ...events,
  ]
  const said = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const took = exchangeId => ({ type: 'user/message', data: { source: { kind: SOURCE_KIND, role: 'request', exchangeId }, content: [{ type: 'text', text: 'do' }] } })
  const ended = reason => ({ type: 'turn/end', data: { reason } })
  const cut = { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } }

  // A cut turn whose continuation answered: the continuation's reason and the texts
  // merged, with the cut step's interrupted draft dropped.
  const follow = turnOf([
    ...turn(1, [took('x1'), said('a'), { type: 'step/start', data: { turn: 1, step: 2 } }, said('p'), ended(cut)]),
    ...turn(2, [said('b'), ended({ kind: 'completed' })]),
  ], 'x1')
  assert.deepEqual(follow?.reason, { kind: 'completed' })
  assert.deepEqual(follow?.texts, ['a', 'b'])

  // A cut turn with no continuation yet: read as unfinished, not as stopped.
  const dangling = turnOf([
    ...turn(1, [took('x1'), said('a'), ended(cut)]),
  ], 'x1')
  assert.equal(dangling?.reason, undefined)
  assert.deepEqual(dangling?.texts, ['a'])

  // A user stop stays a stop.
  const stopped = turnOf([
    ...turn(1, [took('x1'), ended({ kind: 'aborted', reason: { kind: 'user' } })]),
  ], 'x1')
  assert.deepEqual(stopped?.reason, { kind: 'aborted', reason: { kind: 'user' } })
})

test('shell shadow: a call past the background wait detaches without a steer', async () => {
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} },
    lossy: false,
    chunks: [{ text: 'building', channel: 'stdout' }],
  })) } })
  rt.state.prefs.backgroundAfterSec = 0.05
  await emit('dm-a', 'turn/start', { turn: 1 })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'npm run build' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j2', toolCall: { callId: 'c1' } })
  const value = await pending
  assert.equal(value.kind, 'promoted')
  assert.equal(value.jobId, 'j2')
  assert.equal(value.output, 'building')
  shadow.calls[0].res({ kind: 'foreground', exitCode: 0, stdout: { text: 'built' } })
  await stop()
})

test('shell shadow: backgroundAfterSec = 0 detaches immediately once registered', async () => {
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} },
    lossy: false,
    chunks: [{ text: 'started', channel: 'stdout' }],
  })) } })
  rt.state.prefs.backgroundAfterSec = 0
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 10' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j0', toolCall: { callId: 'c1' } })
  const value = await pending
  assert.equal(value.kind, 'promoted')
  assert.equal(value.jobId, 'j0')
  assert.equal(value.output, 'started')
  shadow.calls[0].res({ kind: 'foreground', exitCode: 0, stdout: { text: 'ok' } })
  await stop()
})

test('shell shadow: fast command finishing within wait returns foreground without promoting', async () => {
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) } })
  rt.state.prefs.backgroundAfterSec = 0.2
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'echo fast' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'jf', toolCall: { callId: 'c1' } })
  const NATIVE = { kind: 'foreground', exitCode: 0, stdout: { text: 'fast\n' } }
  shadow.calls[0].res(NATIVE)
  assert.equal(await pending, NATIVE)
  await stop()
})

test('shell shadow: group member session does not auto-background past wait', async () => {
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) } })
  rt.state.prefs.backgroundAfterSec = 0.02
  rt.groupOwners.set('dm-a', { roomId: 'r1', botId: 'a' })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 1' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'jg', toolCall: { callId: 'c1' } })
  await new Promise(r => setTimeout(r, 60))
  const NATIVE = { kind: 'foreground', exitCode: 0 }
  shadow.calls[0].res(NATIVE)
  assert.equal(await pending, NATIVE)
  await stop()
})

test('shell shadow: steer before registration respects shorter backgroundAfterSec cap', async () => {
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [{ text: 'cap' }],
  })) } })
  rt.state.prefs.backgroundAfterSec = 0.05
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const startedAt = Date.now()
  const pending = shadow.execute({ command: 'sleep 5' }, execOf(agent))
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('hurry')] })
  await emit('dm-a', 'job/registered', { jobId: 'jc', toolCall: { callId: 'c1' } })
  const value = await pending
  assert.equal(value.kind, 'promoted')
  assert.equal(value.jobId, 'jc')
  assert.ok(Date.now() - startedAt < 500, 'steer grace must not delay promotion past backgroundAfterSec')
  shadow.calls[0].res({ kind: 'foreground', exitCode: 0 })
  await stop()
})

test('setPrefs validates backgroundAfterSec bounds and integer requirement', async () => {
  const { stop, rt, call } = await start()
  const res = (body) => call('set-prefs', body)
  assert.equal((await res({ backgroundAfterSec: 0 })).ok, true)
  assert.equal(rt.state.prefs.backgroundAfterSec, 0)
  assert.equal((await res({ backgroundAfterSec: 600 })).ok, true)
  assert.equal(rt.state.prefs.backgroundAfterSec, 600)
  assert.equal((await res({ backgroundAfterSec: null })).ok, true)
  assert.equal(rt.state.prefs.backgroundAfterSec, undefined)
  for (const bad of [-1, 601, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
    const out = await res({ backgroundAfterSec: bad })
    assert.equal(out.ok, false, `expected ${String(bad)} to be rejected`)
  }
  await stop()
})

// Real-contract harness: mounts DSH's actual LocalJobRegistry + dsh-tool-jobs +
// dsh-tool-bash so we exercise real waitOnJob, job/registered lifecycle,
// job_output, tool-jobs completion delivery, approveEscalation, and AbortSignal
// handling instead of mocking bash's internal behavior.
async function startRealBash({ approveDelayMs = 0, maxConcurrentJobsPerOwner = 10, delayJobsPlugin = false, wireToolsChange = false, redactSecrets, shellPlugin = toolBash, toolName = 'bash', agentScoped = false, presetParent = false, beforeShadow } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(toolExecutorNative)
  const agents = new Map()
  ctx.provide('agents', agents)
  const spawned = []
  const resolvedSpecs = []
  const makeStream = () => {
    let text = ''
    return {
      push(chunk) { text += chunk },
      readFrom(from) {
        const buf = Buffer.from(text, 'utf8')
        const slice = from >= buf.length ? '' : buf.subarray(from).toString('utf8')
        return { text: slice, nextOffset: buf.length, lossy: false }
      },
      all: () => text,
    }
  }
  let nextBehavior = () => ({})
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve: (req) => {
      const spec = { ...req, workdir: req.workdir ?? '/team', timeoutMs: req.timeoutMs ?? 30_000 }
      resolvedSpecs.push(spec)
      return spec
    },
    async execute(spec) {
      const stdout = makeStream()
      const stderr = makeStream()
      let resolveDone
      const done = new Promise((r) => { resolveDone = r })
      const proc = {
        status: 'running',
        exitCode: null,
        signal: null,
        killed: false,
        aborted: false,
        observed: { stdout, stderr },
        done,
        finish(exitCode = 0, out = '') {
          if (proc.status !== 'running') return
          if (out) stdout.push(out)
          proc.status = 'completed'
          proc.exitCode = exitCode
          resolveDone()
        },
        kill() {
          if (proc.status !== 'running') return
          proc.killed = true
          proc.aborted = true
          proc.status = 'killed'
          proc.signal = 'SIGTERM'
          resolveDone()
        },
        async result() {
          await done
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            timedOut: false,
            aborted: proc.aborted,
            timeoutMs: spec.timeoutMs,
            stdout: { text: stdout.all(), truncated: false },
            stderr: { text: stderr.all(), truncated: false },
          }
        },
      }
      if (spec.signal?.aborted) proc.kill()
      else spec.signal?.addEventListener('abort', () => proc.kill(), { once: true })
      spawned.push(proc)
      nextBehavior(proc, spec)
      return proc
    },
  })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
  ctx.provide('shellEnv', { collect: () => ({}) })
  ctx.provide('workingDirectory', { ensure: async () => '/team' })
  ctx.provide('approval', {
    async request({ signal }) {
      if (approveDelayMs <= 0) return 'allowed-once'
      return new Promise((resolveApproval) => {
        if (signal?.aborted) return resolveApproval('cancelled')
        const onAbort = () => { clearTimeout(timer); resolveApproval('cancelled') }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolveApproval('allowed-once') }, approveDelayMs)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
  })
  const notices = []
  const inboxNextStep = []
  const inboxNextTurn = []
  const agent = {
    id: 'dm-a',
    ctx: null,
    status: 'running',
    inbox: {
      nextStep: inboxNextStep,
      nextTurn: inboxNextTurn,
      prepend(target, msg) { (target === 'next-turn' ? inboxNextTurn : inboxNextStep).unshift(msg) },
      append(target, msg) { (target === 'next-turn' ? inboxNextTurn : inboxNextStep).push(msg) },
      remove(mid) {
        for (const list of [inboxNextStep, inboxNextTurn]) {
          const at = list.findIndex(m => m.id === mid)
          if (at !== -1) { list.splice(at, 1); return true }
        }
        return false
      },
    },
    followup: (msg) => { inboxNextTurn.push(msg); notices.push({ kind: 'followup', msg }) },
    inject: (msg) => { inboxNextStep.push(msg); notices.push({ kind: 'inject', msg }) },
    send() {},
    cancel() {},
    session: {
      id: 'dm-a',
      header: { cwd: '/team' },
      append(type, data) {
        ctx.emit('session/event', agent.session, { type, data })
      },
    },
  }
  const agentScope = createScope(ctx, agent)
  await agentScope.ctx.plugin({ inject: ['tools'], apply(scoped) { agent.ctx = scoped } })
  let presetScope
  let parentLink
  if (presetParent) {
    const presetKey = {}
    presetScope = createScope(ctx, presetKey)
    parentLink = bindScopeParent(agent, presetKey)
  }
  const toolHost = presetParent ? presetScope.ctx : agentScoped ? agentScope.ctx : ctx
  const mountJobs = async () => {
    await ctx.plugin(LocalJobRegistry, { pumpPollMs: 10, maxConcurrentJobsPerOwner })
    await toolHost.plugin(toolJobs)
  }
  if (!delayJobsPlugin) await mountJobs()
  const shellFiber = toolHost.plugin(shellPlugin)
  await shellFiber

  agents.set('dm-a', agent)
  const warnings = []
  const rt = {
    ctx,
    state: { prefs: { backgroundAfterSec: 0.05 } },
    chatOwners: new Map([['dm-a', 'a']]),
    groupOwners: new Map(),
    taskOwners: new Map(),
    live: new Map(),
    isBotSession: (id) => id === 'dm-a',
    sessionFolder: () => '/team',
    ...(redactSecrets === undefined ? {} : { redactSecrets }),
    warn: (...args) => warnings.push(args),
  }
  installSteer(rt)
  if (wireToolsChange) ctx.on('tools/change', () => rt.refreshShellShadows(agent))
  const rawShell = ctx.tools.get(toolName, agent)
  const promoted = (rawShell?.output?.schema?.oneOf ?? []).find(v => v?.properties?.kind?.const === 'promoted')
  const hasPromoted = typeof rawShell?.output?.render === 'function'
    && promoted?.properties?.cwd !== undefined
    && promoted?.properties?.jobId !== undefined
    && promoted?.properties?.timeoutMs !== undefined
    && promoted?.properties?.output !== undefined
  if (!hasPromoted) {
    parentLink?.dispose?.()
    await presetScope?.dispose()
    await agentScope.dispose()
    await ctx.fiber.dispose()
    return null
  }
  beforeShadow?.(ctx)
  const disposers = rt.shadowShells(agent)
  assert.equal(disposers?.length, 1, `expected ${toolName} interceptor to attach; warnings: ${JSON.stringify(warnings)}`)
  const execShellRaw = async (args, { callId = 'c1', signal = AbortSignal.timeout(5000), name = toolName, targetAgent = agent, rawArguments } = {}) => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: callId, name, arguments: rawArguments ?? JSON.stringify(args) }],
      agent: targetAgent,
      signal,
    })
    return batch.results[0]?.result
  }
  const execShell = async (args, opts = {}) => {
    const outcome = await execShellRaw(args, opts)
    if (outcome?.isError) {
      const err = new Error(outcome.error?.message ?? outcome.content?.[0]?.text ?? 'tool failed')
      if (outcome.error?.info?.code) err.code = outcome.error.info.code
      err.info = outcome.error?.info
      throw err
    }
    return outcome?.value
  }
  const bash = () => ({
    ...ctx.tools.get(toolName, agent),
    execute: (args, exec = {}) => execShell(args, { callId: exec.callId, signal: exec.signal, name: exec.name ?? toolName, targetAgent: exec.agent ?? agent }),
  })
  const jobOutput = () => ctx.tools.get('job_output', agent)
  assert.ok(ctx.tools.get(toolName, agent) !== undefined, `${toolName} tool should be visible on agent scope`)
  const stop = async () => { parentLink?.dispose?.(); await presetScope?.dispose(); await agentScope.dispose(); await ctx.fiber.dispose() }
  const unloadShell = () => shellFiber.dispose()
  return { ctx, rt, agent, bash, execShell, execShellRaw, jobOutput, spawned, resolvedSpecs, notices, warnings, disposers, mountJobs, unloadShell, setBehavior: (fn) => { nextBehavior = fn }, stop }
}

test('real dsh-tool-bash + dsh-tool-jobs contract: native promotion survives STEER_CUT, keeps job_output valid, and delivers one bounded notice', async (t) => {
  const env = await startRealBash()
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.setBehavior((proc) => { proc.observed.stdout.push('building...\n') })
  const turn = new AbortController()
  const result = await env.bash().execute(
    { description: 'Run slow build', command: 'npm run build' },
    { agent: env.agent, callId: 'call-1', name: 'bash', signal: turn.signal },
  )
  assert.equal(result.kind, 'promoted')
  assert.ok(result.jobId)
  assert.equal(env.resolvedSpecs[0].timeoutMs, 50, 'shadow should tighten timeoutMs into DSH waitOnJob')
  assert.equal(env.ctx.jobs.get(result.jobId, 'dm-a').status, 'running')

  // Simulate a subsequent user steer cancelling the original turn (STEER_CUT).
  turn.abort({ kind: 'hook', reason: STEER_CUT })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(env.spawned[0].killed, false, 'promoted job process must survive original turn STEER_CUT')
  assert.equal(env.ctx.jobs.get(result.jobId, 'dm-a').status, 'running')

  // job_output can read the live promoted job without hitting "unknown job".
  const liveRead = await env.jobOutput().execute(
    { job_id: result.jobId, wait: false },
    { agent: env.agent, callId: 'call-read-1', name: 'job_output', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(liveRead.job.id, result.jobId)
  assert.equal(liveRead.job.status, 'running')

  // Command finishes later; DSH's own tool-jobs delivers exactly ONE notice (no duplicate from detachAfter).
  env.agent.status = 'idle'
  env.spawned[0].finish(0, 'build ok\n')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(env.notices.length, 1, 'tool-jobs alone should deliver one completion notice')
  assert.equal(env.notices[0].kind, 'followup')
  assert.match(env.notices[0].msg.content[0].text, new RegExp(result.jobId))
  assert.match(env.notices[0].msg.content[0].text, /build ok/)

  // Job stays queryable after settlement (native waitOnJob did not remove it prematurely).
  const settled = env.ctx.jobs.get(result.jobId, 'dm-a')
  assert.equal(settled.status, 'completed')
})

test('real dsh-tool-bash + dsh-tool-jobs contract: job_output(wait:true) after promotion suppresses duplicate notice', async (t) => {
  const env = await startRealBash()
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.setBehavior(() => {})
  const result = await env.bash().execute(
    { description: 'Run job', command: 'sleep 1' },
    { agent: env.agent, callId: 'call-wait', name: 'bash', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.kind, 'promoted')

  const waiting = env.jobOutput().execute(
    { job_id: result.jobId, wait: true, timeout_ms: 5000 },
    { agent: env.agent, callId: 'call-jo-wait', name: 'job_output', signal: AbortSignal.timeout(5000) },
  )
  await new Promise(r => setTimeout(r, 15))
  env.agent.status = 'idle'
  env.spawned[0].finish(0, 'collected via job_output\n')
  const read = await waiting
  assert.equal(read.job.status, 'completed')
  const rendered = (env.jobOutput().output.render({}, read) ?? []).map(b => b.text).join('\n')
  assert.match(rendered, /collected via job_output/)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(env.notices.length, 0, 'awaited job_output must not trigger a duplicate notice')
})

test('real dsh-tool-bash + dsh-tool-jobs contract: backgroundAfterSec = 0 uses native run_in_background', async (t) => {
  const env = await startRealBash({ approveDelayMs: 30 })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.rt.state.prefs.backgroundAfterSec = 0
  env.setBehavior(() => {})
  const result = await env.bash().execute(
    {
      description: 'Immediate background command',
      command: 'echo bg',
      sandbox_permissions: 'danger-full-access',
      justification: 'Need host access',
    },
    { agent: env.agent, callId: 'call-zero', name: 'bash', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.kind, 'promoted', '0s wait should delegate to native run_in_background and present as 0ms promoted')
  assert.equal(result.timeoutMs, 0)
  assert.ok(result.jobId)
  env.agent.status = 'idle'
  env.spawned[0].finish(0, 'bg done\n')
  await new Promise(r => setTimeout(r, 50))
  assert.equal(env.notices.length, 1)
  assert.match(env.notices[0].msg.content[0].text, /bg done/)
})

test('real dsh-tool-bash contract: full job capacity does not tighten timeoutMs into an expiry kill', async (t) => {
  const env = await startRealBash({ maxConcurrentJobsPerOwner: 1 })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.rt.state.prefs.backgroundAfterSec = 0.05
  env.setBehavior(() => {})

  // Occupy the single background job slot.
  const first = await env.bash().execute(
    { description: 'Fill job slot', command: 'sleep 10' },
    { agent: env.agent, callId: 'call-cap-1', name: 'bash', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(first.kind, 'promoted')

  // Second call runs while at capacity; timeoutMs must stay at default (30s), NOT 50ms.
  env.setBehavior((proc) => { setTimeout(() => proc.finish(0, 'ran fg\n'), 80) })
  const second = await env.bash().execute(
    { description: 'Run at capacity', command: 'echo fg' },
    { agent: env.agent, callId: 'call-cap-2', name: 'bash', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(env.resolvedSpecs[1].timeoutMs, 30_000, 'must not tighten timeoutMs when job registry is full')
  assert.equal(second.kind, 'foreground')
  assert.equal(second.stdout.text, 'ran fg\n')
  env.spawned[0].finish(0, '')
})

test('real dsh-tool-bash contract: late jobs attachment refreshes bash shadow on refreshShellShadows', async (t) => {
  const env = await startRealBash({ delayJobsPlugin: true })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  // Mount jobs + tool-jobs after initial shadow registration; dsh-tool-bash re-registers bash(jobs).
  await env.mountJobs()
  env.rt.refreshShellShadows(env.agent)
  env.rt.state.prefs.backgroundAfterSec = 0.05
  env.setBehavior(() => {})
  const result = await env.bash().execute(
    { description: 'Run after late jobs mount', command: 'sleep 5' },
    { agent: env.agent, callId: 'call-late', name: 'bash', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.kind, 'promoted', 'refreshed shadow must bind the jobs-backed bash tool')
  assert.equal(env.resolvedSpecs[0].timeoutMs, 50)
  env.spawned[0].finish(0, 'late ok\n')
  await new Promise(r => setTimeout(r, 40))
})

test('real dsh-tool-bash contract: approval delay past backgroundAfterSec does not mis-promote a fast command', async (t) => {
  const env = await startRealBash({ approveDelayMs: 200 })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.rt.state.prefs.backgroundAfterSec = 0.12
  // Fast command completes 10ms after approval grants execution.
  env.setBehavior((proc) => { setTimeout(() => proc.finish(0, 'ok\n'), 10) })
  const turn = new AbortController()
  const fast = await env.bash().execute(
    {
      description: 'Run fast escalated command',
      command: 'echo ok',
      sandbox_permissions: 'danger-full-access',
      justification: 'Need host access to check tool',
    },
    { agent: env.agent, callId: 'call-approve-fast', name: 'bash', signal: turn.signal },
  )
  assert.equal(fast.kind, 'foreground', 'approval wait must not trigger background promotion of a fast command')
  assert.equal(fast.exitCode, 0)
  assert.equal(fast.stdout.text, 'ok\n')

  // Slow command after the same approval delay promotes based on post-registration execution time only.
  env.setBehavior(() => {})
  const slow = await env.bash().execute(
    {
      description: 'Run slow escalated command',
      command: 'sleep 10',
      sandbox_permissions: 'danger-full-access',
      justification: 'Need host access for long job',
    },
    { agent: env.agent, callId: 'call-approve-slow', name: 'bash', signal: turn.signal },
  )
  assert.equal(slow.kind, 'promoted')
  assert.equal(slow.timeoutMs, 120, 'timeoutMs should reflect configured wait, not approval delay')
  env.spawned[1].finish(0, 'done\n')
  await new Promise(r => setTimeout(r, 20))
})

test('real dsh-tool-bash contract: abort before detach still cancels and kills the running job', async (t) => {
  const env = await startRealBash()
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.rt.state.prefs.backgroundAfterSec = 0.5
  env.setBehavior(() => {})
  const turn = new AbortController()
  const pending = env.execShellRaw(
    { description: 'Run cancellable command', command: 'sleep 10' },
    { callId: 'call-abort', signal: turn.signal },
  )
  await new Promise(r => setTimeout(r, 25))
  turn.abort('user stop')
  const raw = await pending
  assert.equal(raw.isError, true)
  assert.match(raw.error.message, /aborted/i)
  assert.deepEqual(raw.error.info, { name: 'AbortError', code: TOOL_ABORTED }, 'abort must preserve canonical DSH error.info')
  assert.equal(env.spawned[0].killed, true, 'abort before detach must kill the running job')
  assert.equal(env.ctx.jobs.list('dm-a').length, 0)
})

test('shell shadow: steer detach truncates oversized fallback output and skips duplicate after job_output(wait:true)', async () => {
  const { emit, stop, rt, agent, calls, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) } })
  rt.state.prefs.backgroundAfterSec = 60
  rt.shadowShells(agent)
  const shadow = shadowOf()

  // First call: steer detaches and huge output is bounded to 2048 bytes.
  const p1 = shadow.execute({ command: 'big' }, execOf(agent, 'c-big'))
  await emit('dm-a', 'job/registered', { jobId: 'j-big', toolCall: { callId: 'c-big' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('next')] })
  assert.equal((await p1).kind, 'promoted')
  agent.status = 'idle'
  shadow.calls[0].res({ kind: 'foreground', exitCode: 0, stdout: { text: 'A'.repeat(5000) } })
  await new Promise(r => setTimeout(r, 0))
  const notice = calls.find(c => c[0] === 'followup')?.[1]?.content?.[0]?.text ?? ''
  assert.match(notice, /\[output truncated to 2048 bytes\]/)
  assert.ok(notice.length < 2300)

  // Second call: model reads terminal result via job_output(wait:true); fallback notice is suppressed.
  calls.length = 0
  const p2 = shadow.execute({ command: 'read-once' }, execOf(agent, 'c-read'))
  await emit('dm-a', 'job/registered', { jobId: 'j-read', toolCall: { callId: 'c-read' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('check')] })
  assert.equal((await p2).kind, 'promoted')
  await emit('dm-a', 'tool/call', { name: 'job_output', arguments: JSON.stringify({ job_id: 'j-read', wait: true }) })
  shadow.calls[1].res({ kind: 'foreground', exitCode: 0, stdout: { text: 'done' } })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(calls.find(c => c[0] === 'followup' || c[0] === 'inject'), undefined)
  await stop()
})

test('real dsh-tool-bash contract: tools/change re-entry during mount, late jobs reload, and dispose emits no duplicate warnings or leaked shadows', async (t) => {
  const env = await startRealBash({ delayJobsPlugin: true, wireToolsChange: true })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  assert.deepEqual(env.warnings, [], 'initial shadow registration must not re-enter tools/change into duplicate errors')

  // Late jobs mount re-registers bash globally and triggers tools/change automatically.
  await env.mountJobs()
  assert.deepEqual(env.warnings, [], 'late jobs reload must refresh shadow without duplicate errors')
  env.rt.state.prefs.backgroundAfterSec = 0.05
  env.setBehavior(() => {})
  const promoted = await env.bash().execute(
    { description: 'Run after auto tools/change refresh', command: 'sleep 5' },
    { agent: env.agent, callId: 'call-reentry', name: 'bash', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(promoted.kind, 'promoted')
  assert.equal(env.resolvedSpecs[0].timeoutMs, 50)
  env.spawned[0].finish(0, 'ok\n')
  await new Promise(r => setTimeout(r, 30))

  // Disposing the interceptor removes it cleanly and later tools/change events must not revive it.
  for (const dispose of env.disposers) dispose()
  const liftDummy = env.ctx.tools.register({
    name: 'dummy_reentry_probe',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => '',
  })
  liftDummy()
  // Prove via real execution that the disposed interceptor no longer tightens timeoutMs or promotes.
  env.setBehavior((proc) => { setTimeout(() => proc.finish(0, 'ran without interceptor\n'), 80) })
  const afterDispose = await env.execShell(
    { description: 'Run after dispose', command: 'echo after' },
    { callId: 'call-after-dispose', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(afterDispose.kind, 'foreground', 'disposed interceptor must not revive on later tools/change')
  assert.equal(env.resolvedSpecs[1].timeoutMs, 30_000, 'disposed interceptor must not tighten timeoutMs')
  assert.deepEqual(env.warnings, [])
})

test('real dsh-tool-bash + dsh-tool-jobs contract: steer detach still notifies after timed-out job_output(wait:true) and failed job_kill', async (t) => {
  const env = await startRealBash({
    redactSecrets: text => text.replaceAll('SUPER_SECRET_TOKEN', '[secret:API_TOKEN]'),
  })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.rt.state.prefs.backgroundAfterSec = 60
  env.setBehavior(() => {})

  const pending = env.bash().execute(
    { description: 'Long command with steer', command: 'sleep 5' },
    { agent: env.agent, callId: 'call-steer-read', name: 'bash', signal: AbortSignal.timeout(10_000) },
  )
  await new Promise(r => setTimeout(r, 30))
  const steerMsg = userMessage('hey')
  env.agent.inbox.nextStep.push(steerMsg)
  env.ctx.emit('session/event', env.agent.session, { type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [steerMsg] } })
  const promoted = await pending
  assert.equal(promoted.kind, 'promoted')

  // Model calls job_output(wait:true, timeout_ms:40), which times out while the job is still running.
  env.agent.session.append('tool/call', { callId: 'call-jo-1', name: 'job_output', arguments: JSON.stringify({ job_id: promoted.jobId, wait: true, timeout_ms: 40 }) })
  const partial = await env.jobOutput().execute(
    { job_id: promoted.jobId, wait: true, timeout_ms: 40 },
    { agent: env.agent, callId: 'call-jo-1', name: 'job_output', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(partial.job.status, 'running')
  env.agent.session.append('tool/result', {
    message: { toolCallId: 'call-jo-1', isError: false, content: env.jobOutput().output.render({}, partial) },
  })

  // A failed job_kill must not silence the eventual completion notice either.
  env.agent.session.append('tool/call', { callId: 'call-jk-fail', name: 'job_kill', arguments: JSON.stringify({ job_id: promoted.jobId }) })
  env.agent.session.append('tool/result', {
    message: { toolCallId: 'call-jk-fail', isError: true, content: [{ type: 'text', text: 'kill failed' }] },
  })

  // Command settles before the 60s native timeout; fallback notice must fire once and redact secrets.
  env.agent.status = 'idle'
  env.spawned[0].finish(0, 'done token=SUPER_SECRET_TOKEN\n')
  await new Promise(r => setTimeout(r, 80))
  assert.equal(env.notices.length, 1, 'timed-out job_output and failed job_kill must not drop the completion notice')
  const text = env.notices[0].msg.content[0].text
  assert.match(text, /\[secret:API_TOKEN\]/)
  assert.ok(!text.includes('SUPER_SECRET_TOKEN'), 'fallback notice must not leak raw secret values')
})

test('shell shadow: steer detach redacts secrets from failure notice', async () => {
  const { emit, stop, rt, agent, calls, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) } })
  rt.state.prefs.backgroundAfterSec = 60
  rt.redactSecrets = text => text.replaceAll('SECRET_FAIL_KEY', '[secret:FAIL_KEY]')
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'deploy' }, execOf(agent, 'c-fail'))
  await emit('dm-a', 'job/registered', { jobId: 'j-fail', toolCall: { callId: 'c-fail' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('stop')] })
  assert.equal((await pending).kind, 'promoted')
  agent.status = 'idle'
  shadow.calls[0].rej(new Error('auth failed with SECRET_FAIL_KEY'))
  await new Promise(r => setTimeout(r, 0))
  const notice = calls.find(c => c[0] === 'followup')?.[1]?.content?.[0]?.text ?? ''
  assert.match(notice, /\[secret:FAIL_KEY\]/)
  assert.ok(!notice.includes('SECRET_FAIL_KEY'))
  await stop()
})

test('real dsh-tool-pwsh + dsh-tool-jobs contract: native promotion tightens timeoutMs and delivers one notice', async (t) => {
  const env = await startRealBash({ shellPlugin: toolPwsh, toolName: 'pwsh', wireToolsChange: true })
  if (env === null) return t.skip('dsh-tool-pwsh in this DSH version has no promoted result format')
  t.after(env.stop)
  assert.deepEqual(env.warnings, [])
  env.setBehavior((proc) => { proc.observed.stdout.push('pwsh running...\n') })
  const result = await env.bash().execute(
    { description: 'Run pwsh job', command: 'Start-Sleep 5' },
    { agent: env.agent, callId: 'call-pwsh-1', name: 'pwsh', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.kind, 'promoted')
  assert.equal(env.resolvedSpecs[0].timeoutMs, 50, 'pwsh shadow should tighten timeoutMs into native waitOnJob')
  env.agent.status = 'idle'
  env.spawned[0].finish(0, 'pwsh done\n')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(env.notices.length, 1)
  assert.match(env.notices[0].msg.content[0].text, /pwsh done/)
})

test('real dsh-tool-bash contract: shadow respects tools.restrict() and clears when global bash unloads', async (t) => {
  const env = await startRealBash({ wireToolsChange: true })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)

  // Restricted agent: deny bash before shadowShells; shadow must NOT revive it.
  const restrictedAgent = {
    id: 'dm-restricted',
    ctx: null,
    status: 'running',
    inbox: { nextStep: [], nextTurn: [], prepend() {}, append() {}, remove() { return false } },
    followup() {},
    inject() {},
    send() {},
    cancel() {},
    session: { id: 'dm-restricted', header: { cwd: '/team' }, append() {} },
  }
  const restrictedScope = createScope(env.ctx, restrictedAgent)
  await restrictedScope.ctx.plugin({ inject: ['tools'], apply(scoped) { restrictedAgent.ctx = scoped } })
  t.after(() => restrictedScope.dispose())
  env.rt.chatOwners.set('dm-restricted', 'a')
  const prevIsBot = env.rt.isBotSession
  env.rt.isBotSession = (id) => prevIsBot(id) || id === 'dm-restricted'
  restrictedAgent.ctx.tools.restrict({ deny: ['bash'] })
  assert.equal(env.ctx.tools.get('bash', restrictedAgent), undefined)
  env.rt.shadowShells(restrictedAgent)
  assert.equal(env.ctx.tools.get('bash', restrictedAgent), undefined, 'shadowShells must not revive a restricted bash tool')
  const restrictedRes = await env.execShellRaw(
    { description: 'Should be unknown', command: 'echo no' },
    { callId: 'call-restricted', targetAgent: restrictedAgent },
  )
  assert.equal(restrictedRes.isError, true, 'restricted bash must fail as unknown tool through tools.execute')
  assert.equal(env.spawned.length, 0)

  // Unloading global bash plugin must make execution fail cleanly without reviving a zombie shell.
  await env.unloadShell()
  assert.equal(env.ctx.tools.get('bash'), undefined)
  assert.equal(env.ctx.tools.get('bash', env.agent), undefined, 'unloading global bash must remove its visibility')
  const unloadedRes = await env.execShellRaw(
    { description: 'Should be unloaded', command: 'echo gone' },
    { callId: 'call-unloaded' },
  )
  assert.equal(unloadedRes.isError, true, 'unloaded bash must fail cleanly through tools.execute')
  assert.equal(env.spawned.length, 0)
})

test('real dsh-tool-bash + dsh-tool-jobs contract: backgroundAfterSec = 0 presents background card and invalid timeoutMs passes through', async (t) => {
  const env = await startRealBash()
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.rt.state.prefs.backgroundAfterSec = 0
  env.setBehavior(() => {})
  const origArgs = { description: 'Immediate bg', command: 'echo bg' }
  const rawResult = await env.execShellRaw(origArgs, { callId: 'call-bg-card', signal: AbortSignal.timeout(5000) })
  assert.equal(rawResult.isError, false)
  assert.equal(rawResult.value.kind, 'promoted')
  assert.equal(rawResult.value.timeoutMs, 0)
  const card = env.ctx.tools.get('bash', env.agent).presentResult(origArgs, rawResult)
  assert.equal(card?.card, 'generic', '0s native background start must render as a generic background card')
  assert.notEqual(card?.exitCode, 0, '0s native background start must not render as an exited exitCode:0 terminal card')
  env.spawned[0].finish(0, 'ok\n')
  await new Promise(r => setTimeout(r, 30))

  // Non-positive caller timeoutMs must not be silently replaced by backgroundAfterSec.
  env.rt.state.prefs.backgroundAfterSec = 5
  const beforeCalls = env.resolvedSpecs.length
  await assert.rejects(
    env.bash().execute(
      { description: 'Bad timeout', command: 'echo bad', timeoutMs: -5 },
      { agent: env.agent, callId: 'call-bad-to', name: 'bash', signal: AbortSignal.timeout(5000) },
    ),
    /timeoutMs|positive|greater/i,
    'invalid caller timeoutMs must be rejected rather than overwritten with backgroundAfterSec',
  )
  assert.equal(env.resolvedSpecs.length, beforeCalls)
})

test('real dsh-tool-bash + dsh-tool-jobs contract: in-flight job_output(wait:true) after steer detach does not drop fallback completion notice', async (t) => {
  const env = await startRealBash()
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.rt.state.prefs.backgroundAfterSec = 60
  env.setBehavior(() => {})

  const pending = env.bash().execute(
    { description: 'Long command with steer and wait', command: 'sleep 5' },
    { agent: env.agent, callId: 'call-steer-inflight', name: 'bash', signal: AbortSignal.timeout(10_000) },
  )
  await new Promise(r => setTimeout(r, 30))
  const steerMsg = userMessage('hey')
  env.agent.inbox.nextStep.push(steerMsg)
  env.ctx.emit('session/event', env.agent.session, { type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [steerMsg] } })
  const promoted = await pending
  assert.equal(promoted.kind, 'promoted')

  // Simulate an in-flight job_output(wait:true) whose tool/result has not landed yet
  // (e.g., it rejects with "unknown job" once waitOnJob removes the settled job).
  env.agent.session.append('tool/call', { callId: 'call-jo-inflight', name: 'job_output', arguments: JSON.stringify({ job_id: promoted.jobId, wait: true, timeout_ms: 5000 }) })
  const waitRead = env.jobOutput().execute(
    { job_id: promoted.jobId, wait: true, timeout_ms: 5000 },
    { agent: env.agent, callId: 'call-jo-inflight', name: 'job_output', signal: AbortSignal.timeout(5000) },
  ).then(() => ({ ok: true }), error => ({ ok: false, error: error.message }))
  await new Promise(r => setTimeout(r, 20))

  env.agent.status = 'idle'
  env.spawned[0].finish(0, 'final output preserved\n')
  const readOutcome = await waitRead
  if (!readOutcome.ok) assert.match(readOutcome.error, /unknown job/)
  await new Promise(r => setTimeout(r, 60))
  assert.equal(env.notices.length, 1, 'fallback notice must fire instead of being dropped by unconfirmed in-flight activeWaitReads')
  assert.match(env.notices[0].msg.content[0].text, /final output preserved/)
})

test('preset-standard (agent-scoped dsh-tool-bash): slow command promotes without duplicate-registration error and delivers one notice', async (t) => {
  const env = await startRealBash({ agentScoped: true })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  // Confirm bash is registered ONLY on the agent scope, matching app/engine/preset-standard.patch.yml.
  assert.equal(env.ctx.tools.get('bash'), undefined, 'preset-standard must not register bash globally')
  assert.ok(env.ctx.tools.get('bash', env.agent) !== undefined, 'preset-standard must register bash on agent scope')
  assert.deepEqual(env.warnings, [], 'attaching steer interceptor on agent-scoped bash must emit zero warnings')

  env.rt.state.prefs.backgroundAfterSec = 0.05
  env.setBehavior((proc) => { proc.observed.stdout.push('preset building...\n') })
  const turn = new AbortController()
  const raw = await env.execShellRaw(
    { description: 'Run slow preset build', command: 'npm run build' },
    { callId: 'call-preset-1', signal: turn.signal },
  )
  assert.equal(raw.isError, false)
  assert.equal(raw.value.kind, 'promoted')
  assert.ok(raw.value.jobId)
  assert.equal(env.resolvedSpecs[0].timeoutMs, 50, 'tools/execute must tighten timeoutMs on agent-scoped bash')
  assert.match(raw.content[0].text, /moved to background job/)
  assert.equal(env.ctx.jobs.get(raw.value.jobId, 'dm-a').status, 'running')

  // Original turn STEER_CUT must not kill the promoted job.
  turn.abort({ kind: 'hook', reason: STEER_CUT })
  await new Promise(r => setTimeout(r, 25))
  assert.equal(env.spawned[0].killed, false)

  // Command settles later and tool-jobs delivers exactly one completion notice.
  env.agent.status = 'idle'
  env.spawned[0].finish(0, 'preset build ok\n')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(env.notices.length, 1)
  assert.match(env.notices[0].msg.content[0].text, /preset build ok/)
})

test('preset-standard (agent-scoped dsh-tool-pwsh): slow command promotes without duplicate-registration error', async (t) => {
  const env = await startRealBash({ agentScoped: true, shellPlugin: toolPwsh, toolName: 'pwsh' })
  if (env === null) return t.skip('dsh-tool-pwsh in this DSH version has no promoted result format')
  t.after(env.stop)
  assert.equal(env.ctx.tools.get('pwsh'), undefined)
  assert.ok(env.ctx.tools.get('pwsh', env.agent) !== undefined)
  assert.deepEqual(env.warnings, [])

  env.rt.state.prefs.backgroundAfterSec = 0.05
  env.setBehavior(() => {})
  const result = await env.execShell(
    { description: 'Run slow preset pwsh', command: 'Start-Sleep 5' },
    { callId: 'call-preset-pwsh', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(result.kind, 'promoted')
  assert.equal(env.resolvedSpecs[0].timeoutMs, 50)
  env.agent.status = 'idle'
  env.spawned[0].finish(0, 'preset pwsh ok\n')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(env.notices.length, 1)
  assert.match(env.notices[0].msg.content[0].text, /preset pwsh ok/)
})

test('preset-standard (agent-scoped dsh-tool-bash): backgroundAfterSec = 0 starts immediately and presents generic card', async (t) => {
  const env = await startRealBash({ agentScoped: true })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.rt.state.prefs.backgroundAfterSec = 0
  env.setBehavior(() => {})
  const origArgs = { description: 'Immediate preset bg', command: 'echo hi' }
  const raw = await env.execShellRaw(origArgs, { callId: 'call-preset-zero', signal: AbortSignal.timeout(5000) })
  assert.equal(raw.isError, false)
  assert.equal(raw.value.kind, 'promoted')
  assert.equal(raw.value.timeoutMs, 0)
  const card = env.ctx.tools.get('bash', env.agent).presentResult(origArgs, raw)
  assert.equal(card?.card, 'generic')
  assert.notEqual(card?.exitCode, 0)
  env.agent.status = 'idle'
  env.spawned[0].finish(0, 'zero bg done\n')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(env.notices.length, 1)
  assert.match(env.notices[0].msg.content[0].text, /zero bg done/)
})

test('preset-standard (agent-scoped dsh-tool-bash): host privacy/secrets tools/execute wrappers see content+meta outside steerShellExecute and background tasks are not cut at 5s', async (t) => {
  const order = []
  let outerSawContent = false
  let outerSawMetaCwd
  let offHost
  const env = await startRealBash({
    agentScoped: true,
    beforeShadow: (ctx) => {
      offHost = ctx.on('tools/execute', async (exec, next) => {
        order.push('host-before')
        if (exec.arguments?.command === 'blocked-by-privacy') {
          throw new Error('blocked by privacy')
        }
        const res = await next()
        order.push('host-after')
        if (!res?.isError) {
          outerSawContent = Array.isArray(res?.content) && res.content.length > 0 && typeof res.content[0]?.text === 'string'
          outerSawMetaCwd = res?.meta?.cwd
        }
        if (!res?.isError && typeof res?.value?.output === 'string') {
          return { ...res, value: { ...res.value, output: res.value.output.replaceAll('RAW_SECRET', '[redacted]') } }
        }
        return res
      })
    },
  })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(() => { offHost?.(); return env.stop() })

  env.rt.state.prefs.backgroundAfterSec = 0.05
  env.setBehavior((proc) => { proc.observed.stdout.push('out RAW_SECRET\n') })

  // 1. Privacy denial stops execution BEFORE bash spawns.
  const denied = await env.execShellRaw({ description: 'Blocked cmd', command: 'blocked-by-privacy' }, { callId: 'call-priv' })
  assert.equal(denied.isError, true)
  assert.equal(env.spawned.length, 0, 'blocked command must never spawn')

  // 2. Allowed slow command promotes, outer wrapper sees content + meta, and host redacts output.
  order.length = 0
  const promoted = await env.execShellRaw({ description: 'Secret cmd', command: 'echo RAW_SECRET' }, { callId: 'call-sec' })
  assert.equal(promoted.isError, false)
  assert.equal(promoted.value.kind, 'promoted')
  assert.deepEqual(order, ['host-before', 'host-after'])
  assert.equal(outerSawContent, true, 'outer tools/execute wrapper must receive rendered content array')
  assert.equal(outerSawMetaCwd, '/team', 'outer tools/execute wrapper must receive presentationMeta')
  assert.ok(!promoted.content[0].text.includes('RAW_SECRET'), 'host redaction wrapper must run after steerShellExecute')
  assert.match(promoted.content[0].text, /\[redacted\]/)
  env.spawned[0].finish(0, '')

  // 3. Background tasks (taskOwners) run shell commands to completion without 5s auto-background interruption.
  env.rt.taskOwners.set('dm-a', { botId: 'a', taskId: 't1' })
  env.setBehavior((proc) => { setTimeout(() => proc.finish(0, 'task ran straight through\n'), 80) })
  const taskResult = await env.execShell({ description: 'Task build', command: 'npm test' }, { callId: 'call-task' })
  assert.equal(taskResult.kind, 'foreground', 'background task shell command must not be cut at backgroundAfterSec')
  assert.equal(taskResult.stdout.text, 'task ran straight through\n')
})

test('preset-standard (two-level parent preset scope): slow command promotes and late jobs reload needs no re-shadow', async (t) => {
  const env = await startRealBash({ presetParent: true, delayJobsPlugin: true, wireToolsChange: true })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  assert.equal(env.ctx.tools.get('bash'), undefined, 'preset parent scope must not register bash globally')
  assert.ok(env.ctx.tools.get('bash', env.agent) !== undefined, 'agent must inherit bash from parent preset scope')
  assert.deepEqual(env.warnings, [])

  // Mount jobs after initial scope attach; parent preset re-registers bash(jobs) cleanly.
  await env.mountJobs()
  env.rt.state.prefs.backgroundAfterSec = 0.05
  env.setBehavior((proc) => { proc.observed.stdout.push('parent preset...\n') })
  const raw = await env.execShellRaw(
    { description: 'Parent preset build', command: 'npm test' },
    { callId: 'call-parent-1', signal: AbortSignal.timeout(5000) },
  )
  assert.equal(raw.isError, false)
  assert.equal(raw.value.kind, 'promoted')
  assert.equal(env.resolvedSpecs[0].timeoutMs, 50)
  env.agent.status = 'idle'
  env.spawned[0].finish(0, 'parent preset done\n')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(env.notices.length, 1)
  assert.match(env.notices[0].msg.content[0].text, /parent preset done/)
})

test('real dsh-tool-bash contract: malformed non-object arguments pass through untouched with DSH error.info intact', async (t) => {
  const env = await startRealBash({ agentScoped: true })
  if (env === null) return t.skip('dsh-tool-bash in this DSH version has no promoted result format')
  t.after(env.stop)
  env.rt.state.prefs.backgroundAfterSec = 0.05

  for (const [label, rawArguments] of [['malformed JSON', '{not json'], ['null JSON', 'null'], ['array JSON', '["echo"]']]) {
    const res = await env.execShellRaw(undefined, { callId: `call-bad-${label}`, rawArguments })
    assert.equal(res.isError, true, `${label} must fail validation`)
    assert.equal(res.error?.info?.code, 'INVALID_ARGS', `${label} must preserve DSH INVALID_ARGS error.info`)
  }
  assert.equal(env.spawned.length, 0, 'malformed arguments must never spawn a command')
})

test('createRuntime with pre-existing live agent: steerShellExecute defers until after secrets.js so shell results are still redacted on reload', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-steer-reload-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    ...TEAM,
    prefs: { backgroundAfterSec: 0.05 },
  }))

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(toolExecutorNative)
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 10 })

  const spawned = []
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve: req => ({ ...req, workdir: req.workdir ?? '/team', timeoutMs: req.timeoutMs ?? 30_000 }),
    async execute(spec) {
      let text = 'secret=RELOAD_LIVE_SECRET_VALUE\n'
      const stdout = {
        readFrom(from) {
          const buf = Buffer.from(text, 'utf8')
          return { text: from >= buf.length ? '' : buf.subarray(from).toString('utf8'), nextOffset: buf.length, lossy: false }
        },
      }
      const stderr = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
      let resolveDone
      const done = new Promise(r => { resolveDone = r })
      const proc = {
        status: 'running',
        observed: { stdout, stderr },
        done,
        finish() { if (proc.status === 'running') { proc.status = 'completed'; resolveDone() } },
        kill() { if (proc.status === 'running') { proc.status = 'killed'; resolveDone() } },
        async result() {
          await done
          return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text, truncated: false }, stderr: { text: '', truncated: false } }
        },
      }
      spawned.push(proc)
      return proc
    },
  })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
  ctx.provide('shellEnv', { collect: () => ({}), register: () => () => {} })
  ctx.provide('workingDirectory', { ensure: async () => '/team' })

  // Pre-existing live Bot agent present BEFORE createRuntime installs MODULES (plugin reload scenario).
  const agentsMap = new Map()
  const agent = {
    id: 'dm-a',
    ctx: null,
    status: 'running',
    inbox: { nextStep: [], nextTurn: [], prepend() {}, append() {}, remove() { return false } },
    followup() {},
    inject() {},
    send() {},
    cancel() {},
    session: {
      id: 'dm-a',
      header: { cwd: '/team' },
      append(type, data) { ctx.emit('session/event', agent.session, { type, data }) },
      snapshotEvents: () => [],
    },
  }
  const agentScope = createScope(ctx, agent)
  await agentScope.ctx.plugin({ inject: ['tools'], apply(scoped) { agent.ctx = scoped } })
  await agentScope.ctx.plugin(toolJobs)
  await agentScope.ctx.plugin(toolBash)
  agentsMap.set('dm-a', agent)
  t.after(async () => { await agentScope.dispose(); await ctx.fiber.dispose() })

  let listCalls = 0
  ctx.provide('agents', {
    get: id => agentsMap.get(id),
    list: () => { listCalls += 1; return [...agentsMap.values()] },
  })
  ctx.provide('llm', { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) })
  ctx.provide('workspaceRegistry', { get: () => ({ id: 'w1', path: '/team' }), list: () => [{ id: 'w1', path: '/team' }], resolveByPath: async () => undefined, create: async p => ({ id: 'w1', path: p }), archiveSession: async () => {} })
  ctx.provide('sessionController', { create: async () => ({ sessionId: 'dm-a' }), resolveAgent: async () => ({ agent }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) })
  ctx.provide('sessionTitle', { rename: async () => {} })
  ctx.provide('sessions', { flush: async () => {} })
  ctx.provide('connection', { fetch: { register: () => () => {} } })

  const rt = createRuntime(ctx, { home })
  assert.ok(listCalls >= 2, 'reload must walk live agents both during install (deferred) and post-install (after secrets.js)')
  await rt.load()
  await rt.secretEndpoint('secret-set', { name: 'RELOAD_TOKEN', value: 'RELOAD_LIVE_SECRET_VALUE' })

  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: 'call-reload-sec', name: 'bash', arguments: JSON.stringify({ description: 'Echo secret', command: 'echo secret' }) }],
    agent,
    signal: AbortSignal.timeout(5000),
  })
  const result = batch.results[0]?.result
  assert.equal(result.isError, false)
  assert.equal(result.value.kind, 'promoted')
  assert.ok(!result.content[0].text.includes('RELOAD_LIVE_SECRET_VALUE'), 'secrets.js must redact promoted shell output even when live agent pre-existed createRuntime')
  assert.match(result.content[0].text, /\[secret:RELOAD_TOKEN\]/)
  for (const proc of spawned) proc.finish()
})
