import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { remoteState } from '../src/host/phone.js'
import { createRemoteService } from '../src/host/remote.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: {
      id: 'm1',
      sessionId: 'm1',
      segments: [{ sessionId: 'm1-old', endedAt: 100 }],
      name: 'Chief',
      role: 'Chief of Staff',
      instructions: '',
      createdAt: 1,
    },
  },
  rooms: {},
  agents: {
    a1: {
      id: 'a1',
      name: 'Classic',
      sessions: ['classic-1', 'classic-cold', 'classic-minimal'],
      createdAt: 1,
    },
  },
  exchanges: [],
  questions: {},
}

function makeHarness({
  readOnly = false,
  ownWindow = false,
  preset = 'workspace-write',
  planActive = false,
  continued = [],
  coldContinued = [],
  inboxBySession = {},
  rooms = {},
  onSteerQueued = null,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-session-controls-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, rooms }))

  let currentPreset = preset
  let currentModel = { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }
  let currentPlan = { active: planActive, pending: false }
  const executedCommands = []
  const selectModelCalls = []
  const updateQueueCalls = []
  const continuedAnswers = []
  const resolveAgentCalls = []
  const observeSessionCalls = []
  const attachWaitCalls = []
  const uploadedFiles = []
  const steeredMessages = []
  const projectionListeners = []
  let attachWaitRemainingMs = 60_000

  const makeInbox = (initial) => {
    const nextTurn = [...(initial ?? [])]
    const nextStep = []
    return {
      nextTurn,
      nextStep,
      remove(id) {
        const idx = nextTurn.findIndex(item => item?.id === id)
        if (idx < 0) return false
        nextTurn.splice(idx, 1)
        return true
      },
      append(bucket, msg) {
        if (bucket === 'next-step') nextStep.push(msg)
        else nextTurn.push(msg)
      },
      prepend(bucket, msg) {
        if (bucket === 'next-step') nextStep.unshift(msg)
        else nextTurn.unshift(msg)
      },
      splice(bucket, start, deleteCount, items = []) {
        const target = bucket === 'next-step' ? nextStep : nextTurn
        target.splice(start, deleteCount, ...items)
      },
    }
  }

  const liveAgents = new Map([
    ['classic-1', {
      id: 'classic-1',
      status: 'idle',
      session: { id: 'classic-1', seq: 1 },
      model: { current: () => currentModel },
      inbox: makeInbox(inboxBySession['classic-1']),
    }],
    ['m1', {
      id: 'm1',
      status: 'idle',
      session: { id: 'm1', seq: 1 },
      model: { current: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
      inbox: makeInbox(inboxBySession.m1),
      steer(msg) {
        steeredMessages.push(msg)
        this.inbox.nextStep.push(msg)
      },
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
    list: (agent) => (agent
      ? [
        { name: 'permission', description: 'Switch permission preset' },
        { name: 'plan', description: 'Toggle plan mode', input: { hint: 'on | off' } },
        { name: 'compact', description: 'Compact conversation history' },
        { name: 'attach-cmd', description: 'Command with attachments', input: { hint: 'note', attachments: true } },
      ]
      : [
        { name: 'compact', description: 'Compact conversation history' },
      ]),
    execute: async (_agent, line, submittedAttachments = []) => {
      executedCommands.push({ line, submittedAttachments })
      if (line.startsWith('/permission ')) {
        currentPreset = line.slice('/permission '.length).trim()
        return { result: { kind: 'success', text: `Permission set to ${currentPreset}` } }
      }
      if (line === '/plan' || line === '/plan on') {
        currentPlan = { active: true, pending: false }
        return { result: { kind: 'success', text: 'Plan mode enabled' } }
      }
      if (line === '/plan off') {
        currentPlan = { active: false, pending: false }
        return { result: { kind: 'success', text: 'Plan mode disabled' } }
      }
      if (line === '/unknown') return undefined
      return { result: { kind: 'success', text: `Ran ${line}` } }
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
        { path: 'src', kind: 'directory' },
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
        agentPreset: 'preset-standard',
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

  const sessionQueryService = {
    observeSession: async (sessionId, options) => {
      observeSessionCalls.push({ sessionId, options })
      if (sessionId === 'classic-cold') {
        return {
          projections: {
            values: {
              agentPreset: 'preset-standard',
              modelSelection: { next: currentModel },
              permissions: { currentValue: currentPreset },
              plan: { active: false, pending: false },
              inbox: { 'next-turn': [], 'next-step': [] },
              userQuestions: { active: coldContinued },
            },
          },
          [Symbol.dispose]() {},
        }
      }
      if (sessionId === 'classic-minimal') {
        return {
          projections: {
            values: {
              agentPreset: 'preset-minimal',
              modelSelection: { next: currentModel },
              permissions: { currentValue: currentPreset },
              plan: { active: false, pending: false },
              inbox: { 'next-turn': [], 'next-step': [] },
              userQuestions: { active: [] },
            },
          },
          [Symbol.dispose]() {},
        }
      }
      throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    },
  }

  const agentPresetsService = {
    defaultId: 'preset-standard',
    serviceFor: (agent, name) => (agent?.id === 'classic-1' && name === 'planMode' ? {} : undefined),
    inspectCompositions: () => [
      { id: 'preset-standard', modules: [{ moduleName: '@deepseek-ai/dsh-plan-mode' }] },
      { id: 'preset-minimal', modules: [{ moduleName: '@deepseek-ai/dsh-core' }] },
    ],
  }

  const userQuestionsService = {
    answer: (_agent, callId, response) => {
      continuedAnswers.push({ callId, response })
      return true
    },
    attachWait: async function* (_agent, callId, signal) {
      attachWaitCalls.push({ callId, signal })
      yield { remainingMs: attachWaitRemainingMs }
      await new Promise((resolve) => {
        if (signal?.aborted) { resolve(); return }
        signal?.addEventListener?.('abort', resolve, { once: true })
      })
    },
  }

  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const attachmentsService = {
    readImage: async (att) => ({ data: imageBytes, mediaType: att.mediaType ?? 'image/png' }),
  }
  const fileUploadsService = {
    uploadStream: async (meta) => {
      uploadedFiles.push(meta)
      return { receiptId: `rcpt-${uploadedFiles.length}` }
    },
  }

  const agentsService = {
    get: id => liveAgents.get(id),
    list: () => [...liveAgents.values()],
  }
  const sessionsService = { list: () => [...liveAgents.values()].map(a => a.session) }
  const services = {
    agents: agentsService,
    sessions: sessionsService,
    permissionPresets: permService,
    commands: commandsService,
    sessionSkillCatalog: skillsService,
    fileReferences: fileRefsService,
    sessionProjections: projectionsService,
    sessionQuery: sessionQueryService,
    agentPresets: agentPresetsService,
    userQuestions: userQuestionsService,
    attachments: attachmentsService,
    fileUploads: fileUploadsService,
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    },
  }

  const ctx = fakeContext({ services })
  ctx.agents = agentsService
  ctx.sessions = sessionsService
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
      resolveAgentCalls.push(sessionId)
      const found = liveAgents.get(sessionId)
      if (!found) {
        if (sessionId === 'classic-cold') {
          const woke = {
            id: 'classic-cold',
            session: { id: 'classic-cold', seq: 1 },
            model: { current: () => currentModel },
            inbox: { nextTurn: [], nextStep: [] },
          }
          liveAgents.set('classic-cold', woke)
          return { agent: woke }
        }
        throw Object.assign(new Error(`session "${sessionId}" not found`), { code: 'session/not-found' })
      }
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
    page: async () => ({ records: [], hasMore: false }),
  }

  const routes = {}
  const origRegister = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return origRegister(options)
  }

  if (readOnly) {
    writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 1, at: Date.now() }))
  }

  const rt = createRuntime(ctx, { home, ...(ownWindow ? { ownWindow: true } : {}) })

  if (typeof onSteerQueued === 'function') {
    // Allow testing Bot hidden-work steer isolation via the channel's rt if exposed, or mock on m1.
    ctx.__onSteerQueued = onSteerQueued
  }

  const call = async (endpoint, payload = {}) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return { status: response.status, body: await response.json() }
  }

  const connectLocalFeed = async () => {
    const ac = new AbortController()
    const res = await routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', {
      method: 'GET',
      signal: ac.signal,
    }))
    const reader = res.body?.getReader?.()
    await reader?.read?.()
    return async () => {
      ac.abort()
      await reader?.cancel?.().catch(() => {})
      await new Promise(resolve => setImmediate(resolve))
    }
  }

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
    rt,
    routes,
    call,
    connectLocalFeed,
    liveAgents,
    executedCommands,
    selectModelCalls,
    updateQueueCalls,
    continuedAnswers,
    resolveAgentCalls,
    observeSessionCalls,
    attachWaitCalls,
    uploadedFiles,
    steeredMessages,
    runUserQuestionWaterfall,
    setNextQueueError: (err) => { nextQueueError = err },
    setAttachWaitRemainingMs: (ms) => { attachWaitRemainingMs = ms },
    stop: async () => {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('session-controls reads model, thinking effort, permissions (incl. auto), preset-based plan availability, and filtered queue', async (t) => {
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
  assert.equal(data.plan.available, true)
  assert.equal(data.queue.length, 1, 'internal bot-kind inbox messages are filtered out')
  assert.equal(data.queue[0].id, 'q1')

  // Cold sessions inspect preset composition without waking the Agent, and pass `{ signal }` options object to `observeSession`.
  const coldStd = (await h.call('session-controls', { sessionId: 'classic-cold' })).body.value
  assert.equal(coldStd.plan.available, true, 'cold preset-standard session reports plan available')
  const coldMin = (await h.call('session-controls', { sessionId: 'classic-minimal' })).body.value
  assert.equal(coldMin.plan.available, false, 'cold preset-minimal session reports plan unavailable')
  assert.equal(h.resolveAgentCalls.length, 0, 'browsing cold sessions never wakes their Agent')
  assert.equal(h.observeSessionCalls.length >= 2, true)
  for (const call of h.observeSessionCalls) {
    assert.equal(call.options instanceof AbortSignal, false, 'observeSession must receive options object, never a bare AbortSignal')
    if (call.options !== undefined) {
      assert.equal(typeof call.options, 'object')
      assert.ok(call.options.signal instanceof AbortSignal, 'observeSession options.signal is an AbortSignal')
    }
  }
})

test('session-model and session-permission update owned Classic sessions, validate presets, and refuse Bot sessions', async (t) => {
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
  assert.deepEqual(h.executedCommands.map(c => c.line), ['/permission auto'])

  // Unknown preset returns `bot/invalid` (400), not `bot/refused` or 500.
  const badPerm = await h.call('session-permission', { sessionId: 'classic-1', preset: 'does-not-exist' })
  assert.equal(badPerm.body.ok, false)
  assert.equal(badPerm.body.error.code, 'bot/invalid')

  // Bot sessions cannot be mutated via classic session-model or session-permission.
  const botModel = await h.call('session-model', { sessionId: 'm1', ref: 'deepseek/deepseek-chat' })
  assert.equal(botModel.body.ok, false)
  assert.equal(botModel.body.error.code, 'bot/refused')

  const botPerm = await h.call('session-permission', { sessionId: 'm1', preset: 'read-only' })
  assert.equal(botPerm.body.ok, false)
  assert.equal(botPerm.body.error.code, 'bot/refused')
})

test('session-commands stays lazy on cold sessions unless wake: true, forwards attachments on command-run, and lists skills/files', async (t) => {
  const h = makeHarness()
  t.after(h.stop)

  // Cold session without wake: returns global commands without waking the cold Agent.
  const coldCmds = await h.call('session-commands', { sessionId: 'classic-cold' })
  assert.equal(coldCmds.body.ok, true)
  assert.deepEqual(coldCmds.body.value.commands.map(c => c.name), ['compact'])
  assert.equal(h.resolveAgentCalls.length, 0, 'session-commands without wake must not wake cold Agent')

  // Cold session WITH wake: wakes the Agent and returns per-agent commands.
  const wokeCmds = await h.call('session-commands', { sessionId: 'classic-cold', wake: true })
  assert.equal(wokeCmds.body.ok, true)
  assert.deepEqual(wokeCmds.body.value.commands.map(c => c.name), ['permission', 'plan', 'compact', 'attach-cmd'])
  assert.deepEqual(h.resolveAgentCalls, ['classic-cold'])

  const runPlan = await h.call('session-command-run', { sessionId: 'classic-1', line: '/plan on' })
  assert.equal(runPlan.body.ok, true)
  assert.equal(runPlan.body.value.matched, true)
  assert.equal(runPlan.body.value.controls.plan.active, true)

  // Running a command with staged image + file forwards submittedAttachments to commands.execute.
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const imgRes = await h.call('stage-image', { mediaType: 'image/png', data: pngBytes.toString('base64'), name: 'shot.png' })
  assert.equal(imgRes.body.ok, true, `stage-image should succeed: ${JSON.stringify(imgRes.body)}`)
  const img = imgRes.body.value
  const fileRes = await h.call('stage-file', { name: 'notes.txt', data: Buffer.from('hello').toString('base64'), mediaType: 'text/plain' })
  assert.equal(fileRes.body.ok, true, `stage-file should succeed: ${JSON.stringify(fileRes.body)}`)
  const file = fileRes.body.value
  const runAttach = await h.call('session-command-run', {
    sessionId: 'classic-1',
    line: '/attach-cmd check',
    images: [img.id],
    files: [file.id],
  })
  assert.equal(runAttach.body.ok, true)
  assert.equal(runAttach.body.value.matched, true)
  const lastExec = h.executedCommands.at(-1)
  assert.equal(lastExec.line, '/attach-cmd check')
  assert.equal(lastExec.submittedAttachments.length, 2)
  assert.equal(lastExec.submittedAttachments[0].type, 'image')
  assert.equal(lastExec.submittedAttachments[0].mediaType, 'image/png')
  assert.equal(lastExec.submittedAttachments[1].type, 'file')
  assert.equal(lastExec.submittedAttachments[1].receiptId, 'rcpt-1')

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

test('user-questions/request passes through untouched outside desktop app or when no desktop window is connected', async (t) => {
  // 1. Plugin / non-desktop host (ownWindow unset, DS_BOT_APP unset): must preserve NO_PROVIDER even if feed connected.
  const prevEnv = process.env.DS_BOT_APP
  delete process.env.DS_BOT_APP
  t.after(() => {
    if (prevEnv === undefined) delete process.env.DS_BOT_APP
    else process.env.DS_BOT_APP = prevEnv
  })

  const pluginHost = makeHarness({ ownWindow: false })
  t.after(pluginHost.stop)
  const closePluginFeed = await pluginHost.connectLocalFeed()
  t.after(closePluginFeed)

  await assert.rejects(
    pluginHost.runUserQuestionWaterfall({
      agent: pluginHost.liveAgents.get('classic-1'),
      questions: [{ id: 'q1', question: 'Plugin mode question?' }],
    }),
    err => err?.code === 'NO_PROVIDER',
  )

  // 2. Desktop host (ownWindow: true) with NO connected local feed client: must also preserve NO_PROVIDER.
  const desktopHost = makeHarness({ ownWindow: true })
  t.after(desktopHost.stop)
  await assert.rejects(
    desktopHost.runUserQuestionWaterfall({
      agent: desktopHost.liveAgents.get('classic-1'),
      questions: [{ id: 'q1', question: 'Headless desktop question?' }],
    }),
    err => err?.code === 'NO_PROVIDER',
  )

  // 3. Even with connected desktop window, `cua-*` consent questions pass straight through untouched.
  const closeDesktopFeed = await desktopHost.connectLocalFeed()
  t.after(closeDesktopFeed)
  await assert.rejects(
    desktopHost.runUserQuestionWaterfall({
      agent: desktopHost.liveAgents.get('classic-1'),
      questions: [{ id: 'cua-custom-action', question: 'Allow computer action?' }],
    }),
    err => err?.code === 'NO_PROVIDER',
  )
})

test('desktop window claims user-questions/request, handles timed attachWait, plan review, race, disconnect, dispose, and ownership checks', async (t) => {
  const h = makeHarness({ ownWindow: true })
  t.after(h.stop)
  const closeFeed = await h.connectLocalFeed()

  // 1. Downstream provider still wins if it answers directly.
  const passthrough = await h.runUserQuestionWaterfall(
    {
      agent: h.liveAgents.get('classic-1'),
      questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }] }],
    },
    async () => ({ answers: [{ id: 'q1', selected: ['A'] }] }),
  )
  assert.deepEqual(passthrough, { answers: [{ id: 'q1', selected: ['A'] }] })

  // 2. Blocking question answered via session-question-answer.
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
  const reqId = controls.questions[0].id

  // Ownership check: wrong sessionId is refused with bot/not-found.
  const wrongOwner = await h.call('session-question-answer', {
    sessionId: 'foreign-session',
    requestId: reqId,
    answers: [{ id: 'q1', selected: ['OAuth (Recommended)'] }, { id: 'q2', selected: [] }],
  })
  assert.equal(wrongOwner.body.ok, false)
  assert.equal(wrongOwner.body.error.code, 'bot/not-found')

  const wrongDismiss = await h.call('session-question-dismiss', {
    sessionId: 'foreign-session',
    requestId: reqId,
  })
  assert.equal(wrongDismiss.body.ok, false)
  assert.equal(wrongDismiss.body.error.code, 'bot/not-found')

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

  // 3. Timed question (`wait: { callId, timed: true }`) calls `attachWait`, exposes `deadlineAt`, and rejects `ASK_TIMED_OUT` on expiry.
  h.setAttachWaitRemainingMs(35)
  const timedPromise = h.runUserQuestionWaterfall({
    agent: h.liveAgents.get('classic-1'),
    wait: { callId: 'call-timed-1', timed: true },
    questions: [{ id: 'q-t', question: 'Still deciding?' }],
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  const timedControls = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.equal(h.attachWaitCalls.length, 1)
  assert.equal(h.attachWaitCalls[0].callId, 'call-timed-1')
  assert.equal(timedControls.questions[0]?.timed, true)
  assert.equal(timedControls.questions[0]?.callId, 'call-timed-1')
  assert.ok(Number.isFinite(timedControls.questions[0]?.deadlineAt))
  await assert.rejects(timedPromise, err => err?.name === 'UserQuestionError' && err?.code === 'ASK_TIMED_OUT')

  // 4. Plan review dismiss rejects with UserQuestionError(ASK_CANCELLED).
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
  assert.equal(planControls.questions[0].kind, 'plan-review')
  const dismissed = await h.call('session-question-dismiss', {
    sessionId: 'classic-1',
    requestId: planControls.questions[0].id,
  })
  assert.equal(dismissed.body.ok, true)
  await assert.rejects(planPromise, err => err?.name === 'UserQuestionError' && err?.code === 'ASK_CANCELLED')

  // 5. Disconnecting local desktop window releases pending question with NO_PROVIDER instead of hanging.
  const hangPromise = h.runUserQuestionWaterfall({
    agent: h.liveAgents.get('classic-1'),
    questions: [{ id: 'q-dc', question: 'Window closing?' }],
  })
  const hangCheck = assert.rejects(hangPromise, err => err?.name === 'UserQuestionError' && err?.code === 'NO_PROVIDER')
  await new Promise(resolve => setImmediate(resolve))
  await closeFeed()
  await hangCheck

  // 6. Reconnect feed and verify plugin dispose/reload rejects BOTH blocking and timed pending questions without hanging.
  const closeFeed2 = await h.connectLocalFeed()
  t.after(closeFeed2)
  h.setAttachWaitRemainingMs(60_000)
  const disposePromise = h.runUserQuestionWaterfall({
    agent: h.liveAgents.get('classic-1'),
    questions: [{ id: 'q-dispose', question: 'Reloading plugin?' }],
  })
  const disposeTimedPromise = h.runUserQuestionWaterfall({
    agent: h.liveAgents.get('classic-1'),
    wait: { callId: 'call-dispose-timed', timed: true },
    questions: [{ id: 'q-dispose-t', question: 'Reloading timed?' }],
  })
  const disposeCheck = assert.rejects(disposePromise, err => err?.name === 'UserQuestionError' && (err?.code === 'ASK_ABORTED' || err?.code === 'NO_PROVIDER'))
  const disposeTimedCheck = assert.rejects(disposeTimedPromise, err => err?.name === 'UserQuestionError' && err?.code === 'ASK_ABORTED')
  await new Promise(resolve => setImmediate(resolve))
  await h.ctx.dispose()
  await Promise.all([disposeCheck, disposeTimedCheck])
})

test('remote state strips userQuestions and sessionQueues across channel, phone, and remote browser paths', async (t) => {
  const h = makeHarness({
    ownWindow: true,
    inboxBySession: {
      'classic-1': [{ id: 'q-secret', content: [{ type: 'text', text: 'private draft queue' }], source: { kind: 'user' } }],
    },
    continued: [{
      callId: 'call-private',
      state: 'continued',
      at: 1000,
      questions: [{ id: 'q1', question: 'Secret classic prompt?' }],
    }],
  })
  t.after(h.stop)

  const localState = (await h.call('state', {})).body.value
  assert.equal(localState.userQuestions.length, 1)
  assert.equal(localState.sessionQueues['classic-1'].length, 1)

  // 1. channelCall(..., remote = true) used by phoneServe:
  const channelRemote = (await h.rt.channelCall('state', {}, undefined, true)).value
  assert.equal('userQuestions' in channelRemote, false, 'channel remote state must omit userQuestions')
  assert.equal('sessionQueues' in channelRemote, false, 'channel remote state must omit sessionQueues')

  // 2. phone.js remoteState():
  const phoneView = remoteState(localState)
  assert.equal('userQuestions' in phoneView, false, 'phone remoteState must omit userQuestions')
  assert.equal('sessionQueues' in phoneView, false, 'phone remoteState must omit sessionQueues')

  // 3. remote.js DsBotRemote.call('state') used by remote browser:
  const RemoteClass = createRemoteService(h.rt)
  const browserRemote = (await RemoteClass.prototype.call.call({}, 'state', {})).value
  assert.equal('userQuestions' in browserRemote, false, 'remote browser state must omit userQuestions')
  assert.equal('sessionQueues' in browserRemote, false, 'remote browser state must omit sessionQueues')
})

test('continued (timed-out) questions appear for both live and cold sessions and enforce ownership checks', async (t) => {
  const h = makeHarness({
    continued: [{
      callId: 'call-99',
      state: 'continued',
      at: 1000,
      questions: [{ id: 'q1', question: 'Confirm deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }],
    coldContinued: [{
      callId: 'call-cold-7',
      state: 'continued',
      at: 2000,
      questions: [{ id: 'q-cold', question: 'Resume after restart?', options: [{ label: 'Continue' }] }],
    }],
  })
  t.after(h.stop)

  // Live session continued question
  const controls = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.equal(controls.questions.length, 1)
  assert.equal(controls.questions[0].id, 'continued:call-99')
  assert.equal(controls.questions[0].mode, 'continued')

  // Cold session continued question surfaces in both session-controls AND live state without waking Agent.
  const coldControls = (await h.call('session-controls', { sessionId: 'classic-cold' })).body.value
  assert.equal(coldControls.questions.length, 1)
  assert.equal(coldControls.questions[0].id, 'continued:call-cold-7')
  assert.equal(h.resolveAgentCalls.length, 0)
  const localState = (await h.call('state', {})).body.value
  assert.ok(localState.userQuestions.some(q => q.id === 'continued:call-cold-7' && q.sessionId === 'classic-cold'))

  // Ownership check on continued answer rejects foreign sessionId.
  const badOwner = await h.call('session-question-answer', {
    sessionId: 'foreign-session',
    requestId: 'continued:call-99',
    answers: [{ id: 'q1', selected: ['Yes'] }],
  })
  assert.equal(badOwner.body.ok, false)
  assert.equal(badOwner.body.error.code, 'bot/not-found')

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

test('session-queue-update supports edit/remove/steer, rejects editing non-text rows, protects Bot work on steer, and mobile image resolves queued images', async (t) => {
  const h = makeHarness({
    inboxBySession: {
      'classic-1': [
        { id: 'q1', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } },
        { id: 'q2', content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } },
        {
          id: 'q-img',
          content: [
            { type: 'image', attachment: { attachmentId: 'att-queued-1', mediaType: 'image/png', width: 64, height: 64 } },
            { type: 'text', text: 'with photo' },
          ],
          source: { kind: 'user' },
        },
      ],
      m1: [
        { id: 'bot-q1', content: [{ type: 'text', text: 'queued for bot' }], source: { kind: 'user' } },
      ],
    },
  })
  t.after(h.stop)

  // Queued image resolves from live inbox before reaching the paged transcript!
  const imgRes = await h.call('image', { sessionId: 'classic-1', attachmentId: 'att-queued-1', preview: true })
  assert.equal(imgRes.body.ok, true)
  assert.equal(imgRes.body.value.mime, 'image/png')
  assert.ok(typeof imgRes.body.value.data === 'string' && imgRes.body.value.data.length > 0)

  // Editing a queued row containing non-text attachments is rejected with bot/invalid (no silent drop).
  const editImg = await h.call('session-queue-update', {
    sessionId: 'classic-1',
    itemId: 'q-img',
    action: { kind: 'edit', text: 'replaced text' },
  })
  assert.equal(editImg.body.ok, false)
  assert.equal(editImg.body.error.code, 'bot/invalid')

  // Edit plain text row
  const edited = await h.call('session-queue-update', { sessionId: 'classic-1', itemId: 'q1', action: { kind: 'edit', text: 'first edited' } })
  assert.equal(edited.body.ok, true)
  assert.equal(edited.body.value.accepted, true)
  assert.equal(h.liveAgents.get('classic-1').inbox.nextTurn[0].content[0].text, 'first edited')

  // Remove
  const removed = await h.call('session-queue-update', { sessionId: 'classic-1', itemId: 'q1', action: { kind: 'remove' } })
  assert.equal(removed.body.ok, true)
  assert.equal(removed.body.value.accepted, true)

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

  // Steer-all succeeds on remaining classic items
  const steered = await h.call('session-queue-update', { sessionId: 'classic-1', action: { kind: 'steer-all' } })
  assert.equal(steered.body.ok, true)
  assert.equal(steered.body.value.accepted, true)
  assert.equal(steered.body.value.steered, 2)

  // Bot session single-item steer respects rt.steerQueued (never bypasses hidden-work isolation by falling back to raw controller.updateQueue).
  const beforeUpdateCount = h.updateQueueCalls.length
  const botSteer = await h.call('session-queue-update', { sessionId: 'm1', itemId: 'bot-q1', action: { kind: 'steer' } })
  assert.equal(botSteer.body.ok, true)
  assert.equal(botSteer.body.value.accepted, false, 'idle Bot steerQueued returns 0 without falling back to raw sessionController.updateQueue')
  assert.equal(h.updateQueueCalls.length, beforeUpdateCount, 'raw sessionController.updateQueue was not called on Bot steer')
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

test('user-questions/request only claims Classic and active foreground Bot chats, skipping groups, tasks, and retired segments', async (t) => {
  const h = makeHarness({
    ownWindow: true,
    rooms: {
      r1: {
        id: 'r1',
        name: 'War Room',
        members: ['m1'],
        sessions: { m1: 'g-m1' },
        createdAt: 1,
      },
    },
  })
  t.after(h.stop)
  const closeFeed = await h.connectLocalFeed()
  t.after(closeFeed)
  await h.call('state')
  h.rt.taskOwners?.set?.('t-m1', { botId: 'm1', roomId: 'r1' })

  for (const sid of ['r1', 'g-m1', 't-m1', 'm1-old']) {
    await assert.rejects(
      h.runUserQuestionWaterfall({
        agent: { id: sid, session: { id: sid, seq: 1 } },
        questions: [{ id: 'q1', question: `Question in ${sid}?` }],
      }),
      err => err?.code === 'NO_PROVIDER',
      `non-drawable session ${sid} must pass through to NO_PROVIDER`,
    )
  }

  // Active foreground Bot chat (`m1`) IS drawable and claimed by the desktop window.
  const botAsk = h.runUserQuestionWaterfall({
    agent: h.liveAgents.get('m1'),
    questions: [{ id: 'q-bot', question: 'Confirm in Bot chat?' }],
  })
  await new Promise(resolve => setImmediate(resolve))
  const controls = (await h.call('session-controls', { sessionId: 'm1' })).body.value
  assert.equal(controls.questions.length, 1)
  const answer = await h.call('session-question-answer', {
    sessionId: 'm1',
    requestId: controls.questions[0].id,
    answers: [{ id: 'q-bot', selected: [], custom: 'Yes' }],
  })
  assert.equal(answer.body.ok, true)
  assert.deepEqual(await botAsk, { answers: [{ id: 'q-bot', selected: [], custom: 'Yes' }] })
})

test('SSE rotation emits : rotate without dropping blocking questions, and timed questions clear & re-attach attachWait across reconnects', async (t) => {
  const h = makeHarness({ ownWindow: true })
  t.after(h.stop)
  await h.call('state')

  // 1. Server-initiated MAX_LIFETIME_MS rotation emits `: rotate` and keeps blocking questions alive when reconnected within grace.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const res1 = await h.routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed'))
  const reader1 = res1.body.getReader()
  const dec = new TextDecoder()
  const helloChunk = dec.decode((await reader1.read()).value)
  assert.ok(helloChunk.includes('event: hello'))

  const blockingPromise = h.runUserQuestionWaterfall({
    agent: h.liveAgents.get('classic-1'),
    questions: [{ id: 'q-rot', question: 'Survive rotation?' }],
  })
  await Promise.resolve()
  await Promise.resolve()

  t.mock.timers.tick(6_000)
  const chunks = []
  for (;;) {
    const step = await reader1.read()
    if (step.done) break
    chunks.push(dec.decode(step.value))
  }
  assert.equal(chunks.at(-1), ': rotate\n\n', 'MAX_LIFETIME_MS emits : rotate comment before closing')

  // Reconnect immediately within grace window -> blocking question is still open and answerable!
  const ac2 = new AbortController()
  const res2 = await h.routes['/api/bot/feed'].fetch(new Request('http://localhost/api/bot/feed', { signal: ac2.signal }))
  const reader2 = res2.body.getReader()
  await reader2.read()
  const controls = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.equal(controls.questions.length, 1, 'blocking question stays open across SSE rotation')
  await h.call('session-question-answer', {
    sessionId: 'classic-1',
    requestId: controls.questions[0].id,
    answers: [{ id: 'q-rot', selected: [], custom: 'Still here' }],
  })
  assert.deepEqual(await blockingPromise, { answers: [{ id: 'q-rot', selected: [], custom: 'Still here' }] })
  t.mock.timers.reset()
  ac2.abort()
  await reader2.cancel().catch(() => {})
  await new Promise(resolve => setImmediate(resolve))

  // 2. Timed question: genuine disconnect aborts attachWait & clears stale deadlineAt; reconnect re-attaches attachWait with fresh deadlineAt!
  const closeA = await h.connectLocalFeed()
  h.setAttachWaitRemainingMs(45_000)
  const timedPromise = h.runUserQuestionWaterfall({
    agent: h.liveAgents.get('classic-1'),
    wait: { callId: 'call-reattach', timed: true },
    questions: [{ id: 'q-reattach', question: 'Pause & resume timer?' }],
  })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(h.attachWaitCalls.length, 1)
  assert.equal(h.attachWaitCalls[0].signal.aborted, false)
  const beforeDc = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.ok(Number.isFinite(beforeDc.questions[0]?.deadlineAt), 'initial deadlineAt populated')

  // Disconnect window -> first attachWait aborted and deadlineAt cleared (no stale countdown).
  await closeA()
  assert.equal(h.attachWaitCalls[0].signal.aborted, true, 'disconnect aborts initial attachWait claim')
  const whileDc = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.equal(whileDc.questions.length, 1, 'timed question remains answerable while Host unattended timer runs')
  assert.equal(whileDc.questions[0].deadlineAt, undefined, 'stale deadlineAt cleared while disconnected')

  // Reconnect window -> second attachWait starts with fresh remainingMs and restores deadlineAt!
  h.setAttachWaitRemainingMs(20_000)
  const closeB = await h.connectLocalFeed()
  t.after(closeB)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(h.attachWaitCalls.length, 2, 'reconnecting local feed re-attaches attachWait for open timed questions')
  assert.equal(h.attachWaitCalls[1].signal.aborted, false)
  const afterReconnect = (await h.call('session-controls', { sessionId: 'classic-1' })).body.value
  assert.ok(Number.isFinite(afterReconnect.questions[0]?.deadlineAt), 'fresh deadlineAt restored on reconnect')

  await h.call('session-question-answer', {
    sessionId: 'classic-1',
    requestId: afterReconnect.questions[0].id,
    answers: [{ id: 'q-reattach', selected: [], custom: 'Done' }],
  })
  assert.deepEqual(await timedPromise, { answers: [{ id: 'q-reattach', selected: [], custom: 'Done' }] })
})

test('foreground Bot single-item steer supports schedule and user-question-reply rows and reports steer-unavailable on hidden work', async (t) => {
  const h = makeHarness({
    inboxBySession: {
      m1: [
        { id: 'sched-1', content: [{ type: 'text', text: 'scheduled ping' }], source: { kind: 'schedule' } },
        { id: 'reply-1', content: [{ type: 'text', text: 'question answer' }], source: { kind: 'user-question-reply', callId: 'c1' } },
        { id: 'user-1', content: [{ type: 'text', text: 'follow up' }], source: { kind: 'user' } },
      ],
    },
  })
  t.after(h.stop)
  await h.call('state')
  const botAgent = h.liveAgents.get('m1')
  botAgent.status = 'running'

  const beforeUpdate = h.updateQueueCalls.length
  const rSched = await h.call('session-queue-update', { sessionId: 'm1', itemId: 'sched-1', action: { kind: 'steer' } })
  assert.equal(rSched.body.ok, true)
  assert.equal(rSched.body.value.accepted, true)
  assert.equal(rSched.body.value.steered, 1)

  const rReply = await h.call('session-queue-update', { sessionId: 'm1', itemId: 'reply-1', action: { kind: 'steer' } })
  assert.equal(rReply.body.ok, true)
  assert.equal(rReply.body.value.accepted, true)
  assert.equal(rReply.body.value.steered, 1)
  assert.deepEqual(h.steeredMessages.map(m => m.id), ['sched-1', 'reply-1'])
  assert.equal(h.updateQueueCalls.length, beforeUpdate, 'Bot steer runs through rt.steerQueued, never raw updateQueue')

  // When hidden Bot work turn is active, steer is blocked with explicit `session/steer-unavailable` code.
  h.rt.isHiddenBotWorkTurn = () => true
  const blocked = await h.call('session-queue-update', { sessionId: 'm1', itemId: 'user-1', action: { kind: 'steer' } })
  assert.equal(blocked.body.ok, true)
  assert.equal(blocked.body.value.accepted, false)
  assert.equal(blocked.body.value.code, 'session/steer-unavailable')
  assert.equal(h.updateQueueCalls.length, beforeUpdate)
})

test('session-command-run validates session ownership, slash syntax, and read-only BEFORE uploading files or waking Agent', async (t) => {
  const h = makeHarness()
  t.after(h.stop)

  const fileRes = await h.call('stage-file', { name: 'check.txt', data: Buffer.from('abc').toString('base64'), mediaType: 'text/plain' })
  assert.equal(fileRes.body.ok, true)
  const fileId = fileRes.body.value.id

  // 1. Bot session -> refused without calling uploadStream or resolveAgent.
  const botRes = await h.call('session-command-run', { sessionId: 'm1', line: '/compact', files: [fileId] })
  assert.equal(botRes.body.ok, false)
  assert.equal(botRes.body.error.code, 'bot/refused')
  assert.equal(h.uploadedFiles.length, 0, 'invalid target session must not upload staged files')
  assert.equal(h.resolveAgentCalls.length, 0, 'invalid target session must not wake Agent')

  // 2. Foreign / unowned session -> refused without calling uploadStream or resolveAgent.
  const foreignRes = await h.call('session-command-run', { sessionId: 'foreign-session', line: '/compact', files: [fileId] })
  assert.equal(foreignRes.body.ok, false)
  assert.equal(foreignRes.body.error.code, 'bot/refused')
  assert.equal(h.uploadedFiles.length, 0)
  assert.equal(h.resolveAgentCalls.length, 0)

  // 3. Invalid non-slash command line -> bot/invalid without uploading or waking cold Agent.
  const badLine = await h.call('session-command-run', { sessionId: 'classic-cold', line: 'not-a-command', files: [fileId] })
  assert.equal(badLine.body.ok, false)
  assert.equal(badLine.body.error.code, 'bot/invalid')
  assert.equal(h.uploadedFiles.length, 0)
  assert.equal(h.resolveAgentCalls.length, 0)

  // 4. Staged file is still intact and succeeds on a valid Classic command!
  const validRes = await h.call('session-command-run', { sessionId: 'classic-1', line: '/attach-cmd ok', files: [fileId] })
  assert.equal(validRes.body.ok, true)
  assert.equal(h.uploadedFiles.length, 1)
  assert.equal(h.uploadedFiles[0].sessionId, 'classic-1')

  // 5. Read-only host refuses before touching uploadStream or resolveAgent.
  const ro = makeHarness({ readOnly: true })
  t.after(ro.stop)
  const roCmd = await ro.call('session-command-run', { sessionId: 'classic-cold', line: '/compact', files: ['nonexistent-staged'] })
  assert.equal(roCmd.body.ok, false)
  assert.equal(roCmd.body.error.code, 'bot/read-only')
  assert.equal(ro.uploadedFiles.length, 0)
  assert.equal(ro.resolveAgentCalls.length, 0)
})
