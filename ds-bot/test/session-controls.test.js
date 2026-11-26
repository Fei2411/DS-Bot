import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  agents: {
    a1: { id: 'a1', name: 'Classic', sessions: ['classic-1'], createdAt: 1 },
  },
  exchanges: [],
  questions: {},
}

function makeHarness({ readOnly = false, preset = 'workspace-write', planActive = false, continued = [], inboxBySession = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-session-controls-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  let currentPreset = preset
  let currentModel = { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }
  let currentPlan = { active: planActive, pending: false }
  const executedCommands = []
  const selectModelCalls = []
  const updateQueueCalls = []
  const continuedAnswers = []
  const projectionListeners = []

  const liveAgents = new Map([
    ['classic-1', {
      id: 'classic-1',
      session: { id: 'classic-1' },
      model: { current: () => currentModel },
      inbox: { nextTurn: inboxBySession['classic-1'] ?? [] },
    }],
    ['m1', {
      id: 'm1',
      session: { id: 'm1' },
      model: { current: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
      inbox: { nextTurn: inboxBySession.m1 ?? [] },
    }],
  ])

  const permService = {
    catalog: () => ({
      defaultPreset: 'workspace-write',
      options: [
        { value: 'read-only', name: 'Read only', description: 'Inspect files without modifying them.' },
        { value: 'workspace-write', name: 'Workspace', description: 'Edit files inside the workspace.' },
        { value: 'danger-full-access', name: 'Full access', description: 'Run any command without approval.' },
        { value: 'auto', name: 'Auto review', description: 'Session-only automated approval review.' },
      ],
    }),
    current: () => currentPreset,
    resolve: (name) => {
      if (!['read-only', 'workspace-write', 'danger-full-access', 'auto'].includes(name)) {
        throw new Error(`Unknown permission preset: ${name}`)
      }
      return { name }
    },
    set: (_session, name) => { currentPreset = name },
  }

  const commandsService = {
    list: () => [
      { name: 'permission', description: 'Switch permission preset' },
      { name: 'plan', description: 'Toggle plan mode', input: { placeholder: 'on | off' } },
      { name: 'compact', description: 'Compact conversation history' },
    ],
    execute: async (_agent, line) => {
      executedCommands.push(line)
      if (line.startsWith('/permission ')) {
        currentPreset = line.slice('/permission '.length).trim()
        return { result: { kind: 'info', text: `Permission set to ${currentPreset}` } }
      }
      if (line === '/plan' || line === '/plan on') {
        currentPlan = { active: true, pending: false }
        return { result: { kind: 'info', text: 'Plan mode enabled' } }
      }
      if (line === '/plan off') {
        currentPlan = { active: false, pending: false }
        return { result: { kind: 'info', text: 'Plan mode disabled' } }
      }
      if (line === '/unknown') return undefined
      return { result: { kind: 'info', text: `Ran ${line}` } }
    },
  }

  const skillsService = {
    list: async () => ({
      skills: [
        { name: 'code-review', description: 'Review pull requests' },
        { name: 'refactor', description: 'Clean up module structure' },
      ],
    }),
  }

  const fileRefsService = {
    list: async (_agent, query) => {
      const all = [
        { path: 'src/', kind: 'directory' },
        { path: 'src/index.js', kind: 'file' },
        { path: 'docs/my plan.md', kind: 'file' },
      ]
      const q = query.trim().toLowerCase()
      return q ? all.filter(item => item.path.toLowerCase().includes(q)) : all
    },
  }

  const projectionsService = {
    snapshot: (session) => ({
      values: {
        modelSelection: { next: currentModel },
        permissions: { currentValue: currentPreset },
        plan: currentPlan,
        inbox: {
          'next-turn': liveAgents.get(session.id)?.inbox?.nextTurn ?? [],
          'next-step': [],
        },
        userQuestions: {
          active: session.id === 'classic-1' ? continued : [],
        },
      },
    }),
    onEventChanged: (listener) => {
      projectionListeners.push(listener)
      return () => {}
    },
  }

  const userQuestionsService = {
    answer: (_agent, callId, response) => {
      continuedAnswers.push({ callId, response })
      return true
    },
  }

  const services = {
    permissionPresets: permService,
    commands: commandsService,
    sessionSkillCatalog: skillsService,
    fileReferences: fileRefsService,
    sessionProjections: projectionsService,
    planMode: {},
    userQuestions: userQuestionsService,
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    },
  }

  const ctx = fakeContext({ services })
  ctx.agents = {
    get: id => liveAgents.get(id),
    list: () => [...liveAgents.values()],
  }
  ctx.sessions = { list: () => [...liveAgents.values()].map(a => a.session) }
  ctx.llm.listProviders = () => [{ id: 'deepseek', name: 'DeepSeek' }]
  ctx.llm.listModels = async (providerId) => (providerId === 'deepseek' ? [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ] : [])
  ctx.llm.resolveModelInfo = async (provider, model) => (
    provider === 'deepseek' && model === 'deepseek-reasoner'
      ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } }
      : {}
  )

  let nextQueueError = null
  ctx.sessionController = {
    resolveAgent: async (sessionId) => {
      const found = liveAgents.get(sessionId)
      if (!found) throw Object.assign(new Error(`session "${sessionId}" not found`), { code: 'session/not-found' })
      return { agent: found }
    },
    selectModel: async (req) => {
      selectModelCalls.push(req)
      currentModel = {
        provider: req.provider,
        model: req.model,
        ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
      }
    },
    updateQueue: async (req) => {
      updateQueueCalls.push(req)
      if (nextQueueError) {
        const err = nextQueueError
        nextQueueError = null
        throw err
      }
      const agent = liveAgents.get(req.sessionId)
      if (!agent) return
      const rows = agent.inbox.nextTurn
      const idx = rows.findIndex(r => r.id === req.itemId)
      if (idx < 0) throw Object.assign(new Error('not found'), { code: 'session/queue-item-not-found' })
      if (req.action.kind === 'remove' || req.action.kind === 'steer') rows.splice(idx, 1)
      else if (req.action.kind === 'edit') rows[idx] = { ...rows[idx], content: req.action.content }
    },
  }

  const routes = {}
  const origRegister = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return origRegister(options)
  }

  // Trigger read-only lock when requested by creating a lock held by current PID?
  // Simpler: pass readOnly via lock file or mutate after apply? Let's test via real state.lock?
  // Wait: ds-bot checks state.lock only if another live pid holds it; let's check via options or a separate helper.
  if (readOnly) {
    // Hold state.lock with PID 1 (launchd on macOS / init on Linux, always alive and !== process.pid).
    writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 1, at: Date.now() }))
  }

  apply(ctx, { home })

  const call = async (endpoint, payload = {}) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return { status: response.status, body: await response.json() }
  }

  // Run the registered `user-questions/request` waterfall listeners in order, mimicking Cordis.
  const runUserQuestionWaterfall = async (request, trailingProvider = null) => {
    const handlers = [...(ctx.listeners.get('user-questions/request') ?? [])]
    if (trailingProvider) handlers.push(trailingProvider)
    const dispatch = async (index) => {
      if (index >= handlers.length) {
        throw Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' })
      }
      return await handlers[index](request, () => dispatch(index + 1))
    }
    return await dispatch(0)
  }

  return {
    ctx,
    call,
    liveAgents,
    executedCommands,
    selectModelCalls,
    updateQueueCalls,
    continuedAnswers,
    runUserQuestionWaterfall,
    setNextQueueError: (err) => { nextQueueError = err },
    stop: async () => {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('session-controls reads model, thinking effort, permissions (incl. auto), plan state, and filtered queue', async (t) => {
  const h = makeHarness({
    planActive: true,
    inboxBySession: {
      'classic-1': [
        { id: 'q1', content: [{ type: 'text', text: 'follow up' }], source: { kind: 'user' } },
        { id: 'q-internal', content: [{ type: 'text', text: 'relay' }], source: { kind: 'bot' } },
      ],
    },
  })
  t.after(h.stop)

  const res = await h.call('session-controls', { sessionId: 'classic-1' })
  assert.equal(res.body.ok, true)
  const data = res.body.value
  assert.equal(data.model.ref, 'deepseek/deepseek-reasoner')
  assert.equal(data.model.effort, 'high')
  assert.deepEqual(data.model.reasoning, {
    efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
    defaultEffort: 'medium',
  })
  assert.equal(data.permission.current, 'workspace-write')
  assert.ok(data.permission.options.some(opt => opt.value === 'auto'))
  assert.equal(data.plan.active, true)
  assert.equal(data.queue.length, 1, 'internal bot-kind inbox messages are filtered out')
  assert.equal(data.queue[0].id, 'q1')
})

test('session-model and session-permission update owned Classic sessions and refuse Bot sessions', async (t) => {
  const h = makeHarness()
  t.after(h.stop)

  const m1 = await h.call('session-model', { sessionId: 'classic-1', ref: 'deepseek/deepseek-reasoner', effort: 'low' })
  assert.equal(m1.body.ok, true)
  assert.equal(m1.body.value.model.effort, 'low')
  assert.equal(h.selectModelCalls.length, 1)
  assert.equal(h.selectModelCalls[0].reasoningEffort, 'low')

  // Clear effort back to default (null).
  const m2 = await h.call('session-model', { sessionId: 'classic-1', ref: 'deepseek/deepseek-chat', effort: null })
  assert.equal(m2.body.ok, true)
  assert.equal(m2.body.value.model.ref, 'deepseek/deepseek-chat')
  assert.equal(m2.body.value.model.effort, null)

  // Permission preset delegates to `/permission <preset>` when registered.
  const p1 = await h.call('session-permission', { sessionId: 'classic-1', preset: 'auto' })
  assert.equal(p1.body.ok, true)
  assert.equal(p1.body.value.permission.current, 'auto')
  assert.deepEqual(h.executedCommands, ['/permission auto'])

  // Bot sessions cannot be mutated via classic session-model or session-permission.
  const botModel = await h.call('session-model', { sessionId: 'm1', ref: 'deepseek/deepseek-chat' })
  assert.equal(botModel.body.ok, false)
  assert.equal(botModel.body.error.code, 'bot/refused')

  const botPerm = await h.call('session-permission', { sessionId: 'm1', preset: 'read-only' })
  assert.equal(botPerm.body.ok, false)
  assert.equal(botPerm.body.error.code, 'bot/refused')
})

test('session-commands, session-command-run, session-skills, and session-files work for Classic sessions', async (t) => {
  const h = makeHarness()
  t.after(h.stop)

  const cmds = await h.call('session-commands', { sessionId: 'classic-1' })
  assert.equal(cmds.body.ok, true)
  assert.deepEqual(cmds.body.value.commands.map(c => c.name), ['permission', 'plan', 'compact'])

  const runPlan = await h.call('session-command-run', { sessionId: 'classic-1', line: '/plan on' })
  assert.equal(runPlan.body.ok, true)
  assert.equal(runPlan.body.value.matched, true)
  assert.equal(runPlan.body.value.controls.plan.active, true)

  const runUnknown = await h.call('session-command-run', { sessionId: 'classic-1', line: '/unknown' })
  assert.equal(runUnknown.body.ok, true)
  assert.equal(runUnknown.body.value.matched, false)

  const skills = await h.call('session-skills', { sessionId: 'classic-1' })
  assert.equal(skills.body.ok, true)
  assert.deepEqual(skills.body.value.skills.map(s => s.name), ['code-review', 'refactor'])

  const files = await h.call('session-files', { sessionId: 'classic-1', query: 'plan' })
  assert.equal(files.body.ok, true)
  assert.deepEqual(files.body.value.files, [{ path: 'docs/my plan.md', kind: 'file' }])
})

test('user-questions/request waterfall passes through to DSH Web providers, and captures NO_PROVIDER requests for DS Bot desktop', async (t) => {
  const h = makeHarness()
  t.after(h.stop)

  // 1. When a DSH Web provider answers downstream, our fallback passes its result through untouched.
  const passthrough = await h.runUserQuestionWaterfall(
    {
      agent: h.liveAgents.get('classic-1'),
      questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }] }],
    },
    async () => ({ answers: [{ id: 'q1', selected: ['A'] }] }),
  )
  assert.deepEqual(passthrough, { answers: [{ id: 'q1', selected: ['A'] }] })

  // 2. When no DSH Web provider answers (`NO_PROVIDER`), we hold the request, expose it in controls, and resolve via `session-question-answer`.
  const askPromise = h.runUserQuestionWaterfall({
    agent: h.liveAgents.get('classic-1'),
    questions: [
      { id: 'q1', header: 'Auth', question: 'Which method?', options: [{ label: 'OAuth (Recommended)' }, { label: 'API Key' }] },
      { id: 'q2', question: 'Extra notes?' },
    ],
  })
  await new Promise(resolve => setImmediate(resolve))
  const controls = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.equal(controls.questions.length, 1)
  assert.equal(controls.questions[0].kind, 'question')
  const reqId = controls.questions[0].id

  const answered = await h.call('session-question-answer', {
    sessionId: 'classic-1',
    requestId: reqId,
    answers: [
      { id: 'q1', selected: ['OAuth (Recommended)'] },
      { id: 'q2', selected: [], custom: 'keep it minimal' },
    ],
  })
  assert.equal(answered.body.ok, true)
  assert.deepEqual(await askPromise, {
    answers: [
      { id: 'q1', selected: ['OAuth (Recommended)'] },
      { id: 'q2', selected: [], custom: 'keep it minimal' },
    ],
  })

  // 3. Plan review (`intent.kind === 'plan-review'`) is tagged as kind: 'plan-review' and dismiss rejects with UserQuestionError(ASK_CANCELLED).
  const planPromise = h.runUserQuestionWaterfall({
    agent: h.liveAgents.get('classic-1'),
    questions: [{
      id: 'plan-review',
      question: 'Review this plan',
      detail: '# Refactor plan\n\n- Step 1',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }],
  })
  await new Promise(resolve => setImmediate(resolve))
  const planControls = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.equal(planControls.questions.length, 1)
  assert.equal(planControls.questions[0].kind, 'plan-review')

  const dismissed = await h.call('session-question-dismiss', {
    sessionId: 'classic-1',
    requestId: planControls.questions[0].id,
  })
  assert.equal(dismissed.body.ok, true)
  await assert.rejects(planPromise, err => err?.name === 'UserQuestionError' && err?.code === 'ASK_CANCELLED')

  // 4. Even when a downstream DSH remote-events bridge holds `next()` indefinitely (no web client connected),
  // DS Bot's own window can still answer immediately and the downstream linked signal is aborted cleanly.
  let downstreamSignal = null
  const racePromise = h.runUserQuestionWaterfall(
    {
      agent: h.liveAgents.get('classic-1'),
      questions: [{ id: 'q-race', question: 'Ready?' }],
    },
    (req) => new Promise((_resolve, reject) => {
      downstreamSignal = req.signal
      req.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })), { once: true })
    }),
  )
  await new Promise(resolve => setImmediate(resolve))
  const raceControls = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.equal(raceControls.questions.length, 1)
  const raceAns = await h.call('session-question-answer', {
    sessionId: 'classic-1',
    requestId: raceControls.questions[0].id,
    answers: [{ id: 'q-race', selected: [], custom: 'Yes!' }],
  })
  assert.equal(raceAns.body.ok, true)
  assert.deepEqual(await racePromise, { answers: [{ id: 'q-race', selected: [], custom: 'Yes!' }] })
  assert.equal(downstreamSignal?.aborted, true, 'downstream remote-events wait is aborted once own window answers')

  // 5. Aborting the request signal rejects with ASK_ABORTED and removes the pending entry.
  const ac = new AbortController()
  const abortedPromise = h.runUserQuestionWaterfall({
    agent: h.liveAgents.get('classic-1'),
    signal: ac.signal,
    questions: [{ id: 'q-abort', question: 'Still there?' }],
  })
  await new Promise(resolve => setImmediate(resolve))
  ac.abort()
  await assert.rejects(abortedPromise, err => err?.name === 'UserQuestionError' && err?.code === 'ASK_ABORTED')
  const afterAbort = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.equal(afterAbort.questions.length, 0)
})

test('continued (timed-out) questions appear in session-controls and answer via ctx.userQuestions.answer', async (t) => {
  const h = makeHarness({
    continued: [{
      callId: 'call-99',
      state: 'continued',
      at: 1000,
      questions: [{ id: 'q1', question: 'Confirm deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }],
  })
  t.after(h.stop)

  const controls = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.equal(controls.questions.length, 1)
  assert.equal(controls.questions[0].id, 'continued:call-99')
  assert.equal(controls.questions[0].mode, 'continued')

  const res = await h.call('session-question-answer', {
    sessionId: 'classic-1',
    requestId: 'continued:call-99',
    answers: [{ id: 'q1', selected: ['Yes'] }],
  })
  assert.equal(res.body.ok, true)
  assert.equal(h.continuedAnswers.length, 1)
  assert.equal(h.continuedAnswers[0].callId, 'call-99')
  assert.deepEqual(h.continuedAnswers[0].response, { answers: [{ id: 'q1', selected: ['Yes'] }] })
})

test('session-queue-update supports edit, remove, steer, steer-all, and handles races cleanly', async (t) => {
  const h = makeHarness({
    inboxBySession: {
      'classic-1': [
        { id: 'q1', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } },
        { id: 'q2', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } },
      ],
    },
  })
  t.after(h.stop)

  // Edit
  const edited = await h.call('session-queue-update', { sessionId: 'classic-1', itemId: 'q1', action: { kind: 'edit', text: 'first edited' } })
  assert.equal(edited.body.ok, true)
  assert.equal(edited.body.value.accepted, true)
  assert.equal(h.liveAgents.get('classic-1').inbox.nextTurn[0].content[0].text, 'first edited')

  // Remove
  const removed = await h.call('session-queue-update', { sessionId: 'classic-1', itemId: 'q1', action: { kind: 'remove' } })
  assert.equal(removed.body.ok, true)
  assert.equal(removed.body.value.accepted, true)
  assert.equal(h.liveAgents.get('classic-1').inbox.nextTurn.length, 1)

  // Race: item already started -> accepted: false, no 500
  const staleRemove = await h.call('session-queue-update', { sessionId: 'classic-1', itemId: 'gone', action: { kind: 'remove' } })
  assert.equal(staleRemove.body.ok, true)
  assert.equal(staleRemove.body.value.accepted, false)
  assert.equal(staleRemove.body.value.code, 'session/queue-item-not-found')

  // Steer unavailable -> accepted: false
  h.setNextQueueError(Object.assign(new Error('idle'), { code: 'session/steer-unavailable' }))
  const idleSteer = await h.call('session-queue-update', { sessionId: 'classic-1', itemId: 'q2', action: { kind: 'steer' } })
  assert.equal(idleSteer.body.ok, true)
  assert.equal(idleSteer.body.value.accepted, false)
  assert.equal(idleSteer.body.value.code, 'session/steer-unavailable')

  // Steer-all succeeds on remaining item
  const steered = await h.call('session-queue-update', { sessionId: 'classic-1', action: { kind: 'steer-all' } })
  assert.equal(steered.body.ok, true)
  assert.equal(steered.body.value.accepted, true)
  assert.equal(steered.body.value.steered, 1)
})

test('read-only window rejects session control writes', async (t) => {
  const h = makeHarness({ readOnly: true })
  t.after(h.stop)

  const m = await h.call('session-model', { sessionId: 'classic-1', ref: 'deepseek/deepseek-chat' })
  assert.equal(m.body.ok, false)
  assert.equal(m.body.error.code, 'bot/read-only')

  const p = await h.call('session-permission', { sessionId: 'classic-1', preset: 'read-only' })
  assert.equal(p.body.ok, false)
  assert.equal(p.body.error.code, 'bot/read-only')

  const q = await h.call('session-queue-update', { sessionId: 'classic-1', itemId: 'q1', action: { kind: 'remove' } })
  assert.equal(q.body.ok, false)
  assert.equal(q.body.error.code, 'bot/read-only')
})
