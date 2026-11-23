import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { mountBrowserPlugin } from '../src/host/browser/mount.js'
import { toolDefs as refsTools } from '../src/host/browser/refs.js'
import { callAside } from '../src/host/btw.js'
import { install as installCapabilities } from '../src/host/capabilities.js'
import { install as installChatIndex, termQuery } from '../src/host/chat-index.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { install as installMemory } from '../src/host/memory.js'
import { install as installPrompt } from '../src/host/prompt.js'
import { install as installSide } from '../src/host/side.js'
import { install as installThinking } from '../src/host/thinking.js'
import { install as installTimeContext } from '../src/host/time-context.js'
import { fakeContext } from './fake-ctx.js'

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

// -----------------------------------------------------------------------------
// P0-2: Local-agent /side isolation, purpose:'aside' guard, and side.js unload
// -----------------------------------------------------------------------------
test('P0-2: local-agent /side runs in an isolated read-only dsbot-side-* session without touching the live CLI session or live.handed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-p02-side-'))

  const opened = []
  const prompted = []
  const steered = []
  const closed = []
  const forgotten = []
  const mainTurnRelease = createDeferred()
  let mainTurnEntered = createDeferred()

  const makeMockEngine = () => ({
    open: async (id, args) => {
      opened.push({ id, args })
      const queue = []
      const waiters = []
      const push = (ev) => {
        const w = waiters.shift()
        if (w) w(ev)
        else queue.push(ev)
      }
      return {
        id,
        acpSessionId: `acp-${id}`,
        resumed: false,
        dead: false,
        push,
        next: () => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise(r => waiters.push(r))),
      }
    },
    prompt: async (session, blocks) => {
      prompted.push({ id: session.id, blocks })
      if (session.id.startsWith('dsbot-side-')) {
        session.push({ type: 'text', text: 'Isolated side answer.' })
        session.push({ type: 'done', usage: { inputTokens: 120, outputTokens: 15 } })
        return
      }
      // Main turn: first call completes cleanly; second call blocks in-flight so we can test concurrent /side.
      if (prompted.filter(p => p.id === session.id).length === 1) {
        session.push({ type: 'text', text: 'Main turn 1 reply.' })
        session.push({ type: 'done', usage: { inputTokens: 200, outputTokens: 20 } })
      } else {
        mainTurnEntered.resolve()
        await mainTurnRelease.promise
        session.push({ type: 'text', text: 'Main turn 2 reply.' })
        session.push({ type: 'done', usage: { inputTokens: 250, outputTokens: 25 } })
      }
    },
    steer: async (session, blocks) => { steered.push({ id: session.id, blocks }) },
    cancel: async () => {},
    closeSession: async (session) => { closed.push(session.id) },
    forget: (id) => { forgotten.push(id) },
    close: async () => {},
  })

  const records = {}
  const usageRecorded = []
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: () => makeMockEngine(),
    record: sessionId => records[sessionId],
    saveRecord: (sessionId, record) => { records[sessionId] = record },
    presetFor: () => 'workspace-write',
    cwdFor: async () => home,
    probeCwd: () => home,
    toolsFor: () => [],
    recordUsage: entry => usageRecorded.push(entry),
  })
  t.after(async () => {
    await adapter.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  // 1) Run main turn 1 on live session s1 so adapter.live.get('s1').handed is populated.
  const mainMessages1 = [
    { id: 'sys-1', role: 'system', content: [{ type: 'text', text: 'You are Chief.' }] },
    { id: 'u-1', role: 'user', content: [{ type: 'text', text: 'Start the migration.' }], source: { kind: 'user' } },
  ]
  const mainTurn1Chunks = []
  for await (const chunk of adapter.stream({
    provider: 'local-acp-fake',
    model: 'default',
    sessionId: 's1',
    messages: mainMessages1,
    signal: AbortSignal.timeout(10_000),
  })) mainTurn1Chunks.push(chunk)
  assert.ok(mainTurn1Chunks.length > 0)

  const live = adapter.live.get('s1')
  assert.ok(live, 'live session s1 must exist after main turn 1')
  assert.equal(live.handed, 'u-1', 'live.handed must point to u-1')

  // 2) Start main turn 2 in-flight on s1.
  const mainMessages2 = [
    ...mainMessages1,
    { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'Main turn 1 reply.' }] },
    { id: 'u-2', role: 'user', content: [{ type: 'text', text: 'Now run step 2.' }], source: { kind: 'user' } },
  ]
  const turn2Promise = (async () => {
    let text = ''
    for await (const chunk of adapter.stream({
      provider: 'local-acp-fake',
      model: 'default',
      sessionId: 's1',
      messages: mainMessages2,
      signal: AbortSignal.timeout(10_000),
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    return text
  })()
  await mainTurnEntered.promise
  const livePromptsBeforeSide = prompted.filter(p => p.id === 's1').length

  // 3) Invoke callAside (local agent route) WHILE main turn 2 is actively in-flight,
  //    with a handoff message older than 48 KB of newer turns to also test handoff preservation.
  const hugeFiller = Array.from({ length: 16 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `Turn ${i}: ${'x'.repeat(3_500)}` }],
  }))
  const snapshot = {
    sessionId: 's1',
    header: { config: { provider: 'local-acp-fake', model: 'default' } },
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are Chief.' }] },
      { role: 'user', source: { handoff: true }, content: [{ type: 'text', text: '[Handoff · part 2] Keep DB password rotated.' }] },
      ...hugeFiller,
      { role: 'user', content: [{ type: 'text', text: 'Latest question in main chat.' }] },
    ],
  }
  const rt = {
    isLocalAgentRoute: p => p === 'local-acp-fake',
    isLocalAgentRef: () => false,
    localAgentAsk: (sessionId, req) => adapter.ask(sessionId, req),
  }
  const sideResult = await callAside(fakeContext(), rt, snapshot, {
    extra: [
      { role: 'user', content: [{ type: 'text', text: 'Earlier side question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier side reply' }] },
    ],
    question: 'What did we decide about the DB?',
    promptFor: q => `Answer this side question: ${q}`,
    kind: 'side',
    signal: AbortSignal.timeout(10_000),
  })

  assert.equal(sideResult.failed, undefined)
  assert.equal(sideResult.text, 'Isolated side answer.')
  assert.equal(sideResult.toolCalls, false)

  // Live session s1 must NOT have been touched, steered, or had live.handed corrupted!
  assert.equal(prompted.filter(p => p.id === 's1').length, livePromptsBeforeSide, 'side call must never prompt live session s1')
  assert.deepEqual(steered, [], 'side call must never steer live session s1')
  assert.equal(live.handed, 'u-2', 'live.handed must remain untouched by concurrent /side')

  // Side call must have used an ephemeral read-only dsbot-side-* session with mcp: undefined, and closed+forgotten it.
  const sideOpen = opened.find(entry => entry.id.startsWith('dsbot-side-'))
  assert.ok(sideOpen, 'side call must open an isolated dsbot-side-* session')
  assert.equal(sideOpen.args.preset, 'read-only')
  assert.equal(sideOpen.args.mcp, undefined)
  assert.equal(sideOpen.args.ephemeral, true)
  assert.ok(closed.includes(sideOpen.id), 'isolated side session must be closed after answering')
  assert.ok(forgotten.includes(sideOpen.id), 'isolated side session must be forgotten after answering')

  // Side prompt must contain preserved handoff, latest turn, earlier side chat, and the question.
  const sidePromptText = prompted.find(p => p.id === sideOpen.id)?.blocks?.[0]?.text ?? ''
  assert.match(sidePromptText, /Keep DB password rotated/, 'latest handoff must survive transcript byte cap')
  assert.match(sidePromptText, /Latest question in main chat/)
  assert.match(sidePromptText, /Earlier side chat[\s\S]*Side user: Earlier side question[\s\S]*Side assistant: Earlier side reply/)
  assert.match(sidePromptText, /Answer this side question: What did we decide about the DB\?/)
  assert.equal(usageRecorded.some(u => u.sessionId === 's1' && u.kind === 'side'), true, 'side usage must be metered under kind=side')

  // Release main turn 2 and verify it completes cleanly without corruption.
  mainTurnRelease.resolve()
  assert.equal(await turn2Promise, 'Main turn 2 reply.')
})

test('P0-2: HTTP callAside tags purpose: aside and LocalAgentAdapter.stream rejects purpose: aside directly', async (t) => {
  // 1) HTTP route tags callOptions.purpose = 'aside'.
  const seenOptions = []
  const rt = {
    isLocalAgentRoute: () => false,
    isLocalAgentRef: () => false,
    tagUsage: msgs => msgs,
    assembleLlm: async (opts) => {
      seenOptions.push(opts)
      return { finish: { kind: 'stop' }, blocks: () => [{ type: 'text', text: 'HTTP aside answer' }] }
    },
  }
  const res = await callAside(fakeContext(), rt, {
    sessionId: 's-http',
    header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    toolHistory: [],
  }, {
    question: 'Quick check',
    promptFor: q => q,
    kind: 'side',
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(res.text, 'HTTP aside answer')
  assert.equal(seenOptions.length, 1)
  assert.equal(seenOptions[0].purpose, 'aside', 'HTTP callAside must tag purpose=aside')

  // 2) Defense-in-depth: LocalAgentAdapter.stream rejects purpose='aside' before touching liveFor/engines.
  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake ACP', command: 'x', args: [] }],
    findExecutable: path => path,
    spawnEngine: () => assert.fail('spawnEngine must never be called for purpose=aside'),
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => tmpdir(),
    probeCwd: () => tmpdir(),
    toolsFor: () => [],
  })
  t.after(async () => { await adapter.dispose() })

  await assert.rejects(
    async () => {
      const seen = []
      for await (const chunk of adapter.stream({
        provider: 'local-acp-fake',
        model: 'default',
        sessionId: 's-live',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Sneaky aside' }] }],
        purpose: 'aside',
        signal: AbortSignal.timeout(5_000),
      })) seen.push(chunk)
      return seen
    },
    (error) => error instanceof LlmError && error.code === 'INVALID_REQUEST' && /aside/i.test(error.message),
  )
  assert.equal(adapter.live.size, 0, 'purpose=aside must reject before populating adapter.live')
  assert.equal(adapter.engines.size, 0, 'purpose=aside must reject before starting any engine')
})

test('P0-2: side.js plugin unload between persist() and complete() returns entry and preserves saved side chat on disk', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-p02-unload-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

  let botExists = true
  let llmCalls = 0
  const ctx = fakeContext()
  const session = {
    id: 's1',
    seq: 2,
    header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    toolHistory: () => [],
    snapshotEvents: () => [],
  }
  let disposeTriggered = false
  const rt = {
    ctx,
    home,
    config: {},
    readOnly: () => undefined,
    warn: () => {},
    save: async () => {
      // Trigger plugin unload inside persist(botId) AFTER writeBot() wrote the file,
      // hitting side.js's post-persist `if (disposing && present(...))` branch deterministically.
      if (!disposeTriggered) {
        disposeTriggered = true
        void rt.sideDispose()
      }
    },
    botOf: id => (botExists && id === 'b1' ? { id: 'b1', sessionId: 's1', name: 'Chief' } : undefined),
    selfOf: sid => (sid === 's1' ? 'b1' : undefined),
    chatOf: id => (id === 'b1' ? 's1' : undefined),
    roomOf: () => undefined,
    isBotSession: sid => sid === 's1',
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    resolveAgent: async () => ({ id: 's1', session }),
    tagUsage: m => m,
    assembleLlm: async () => { llmCalls += 1; return { finish: { kind: 'stop' }, blocks: () => [{ type: 'text', text: 'ok' }] } },
    isLocalAgentRoute: () => false,
    isLocalAgentRef: () => false,
    onBotDelete: fn => { rt._onDelete = fn },
  }
  installSide(rt)

  const out = await rt.sideAsk({ sessionId: 's1', text: 'Will this survive unload?' })
  assert.ok(out.chatId, 'unload during sideAsk must return chatId instead of throwing Unknown Bot')
  assert.ok(out.entryId, 'unload during sideAsk must return entryId')
  assert.equal(llmCalls, 0, 'unloading host must not start LLM call after dispose')

  // Verify the saved file on disk kept the answering entry for the next owner.
  const saved = JSON.parse(readFileSync(join(home, 'side', 'b1.json'), 'utf8'))
  assert.equal(saved.length, 1)
  assert.equal(saved[0].entries.length, 1)
  assert.equal(saved[0].entries[0].id, out.entryId)
  assert.equal(saved[0].entries[0].status, 'answering')

  // Verify actual Bot deletion still rejects and removes the file.
  botExists = false
  await rt._onDelete('b1')
  assert.throws(() => readFileSync(join(home, 'side', 'b1.json')), /ENOENT/)
})

// -----------------------------------------------------------------------------
// P1-2: KV-cache prompt section ordering & dynamic section stability
// -----------------------------------------------------------------------------
test('P1-2: real DSH SystemPrompt places shared bot-team-rules (640) and DSH static sections (800..10200) ahead of per-Bot tail (10300..10320)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-p12-order-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  // Register representative DSH static tool/harness sections at documented DSH SECTION_ORDERS.
  ctx.systemPrompt.section({ name: 'dsh-file-ref', order: ctx.systemPrompt.getSectionOrder('FILE_REFERENCE'), text: () => '# File reference\nStatic DSH file guidance.' })
  ctx.systemPrompt.section({ name: 'dsh-tool-bash', order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'), text: () => '# Bash\nStatic DSH bash guidance.' })
  ctx.systemPrompt.section({ name: 'dsh-suffix', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: () => '# Deployment suffix\nStatic DSH suffix.' })

  const state = {
    bots: {
      main: { id: 'main', name: 'Chief', role: 'Lead', instructions: 'Lead the team.', sessionId: 's-main', packs: ['pack-a'] },
      w1: { id: 'w1', name: 'Alpha', role: 'Backend', instructions: 'Write Go services.', sessionId: 's-w1', packs: ['pack-a'] },
      w2: { id: 'w2', name: 'Beta', role: 'Frontend', instructions: 'Build UI components.', sessionId: 's-w2', packs: ['pack-b'] },
    },
    rooms: {},
    capabilities: {
      items: {
        'pack-a': { kind: 'mcp', description: 'Database tools' },
        'pack-b': { kind: 'skill', description: 'Design system rules' },
      },
    },
    prefs: {},
  }
  const rt = {
    ctx,
    home,
    config: {},
    state,
    load: async () => {},
    save: async () => {},
    warn: () => {},
    readOnly: () => undefined,
    botOf: id => state.bots[id],
    roomOf: () => undefined,
    selfOf: sid => ({ 's-main': 'main', 's-w1': 'w1', 's-w2': 'w2' }[sid]),
    isMain: id => id === 'main',
    isPrivate: sid => ['s-main', 's-w1', 's-w2'].includes(sid),
    isBotSession: sid => ['s-main', 's-w1', 's-w2'].includes(sid),
    chatOf: id => state.bots[id]?.sessionId,
    chatOwners: new Map([['s-main', 'main'], ['s-w1', 'w1'], ['s-w2', 'w2']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    teamTools: [],
    onBotDelete: () => {},
  }

  // Seed distinct per-Bot MEMORY.md files so bot-memory renders unique text per Bot.
  for (const [id, fact] of [['main', 'Main prefers concise reports.'], ['w1', 'Alpha owns Postgres migrations.'], ['w2', 'Beta owns CSS tokens.']]) {
    mkdirSync(join(home, 'memory', 'bots', id), { recursive: true })
    writeFileSync(join(home, 'memory', 'bots', id, 'MEMORY.md'), `- ${fact}\n`)
  }

  installPrompt(rt)
  installCapabilities(rt)
  installMemory(rt)

  const assembleFor = async (sid) => {
    const out = await ctx.systemPrompt.assemble({ agent: { id: sid, session: { id: sid } }, signal: AbortSignal.timeout(5_000) })
    return renderPrompt(out)
  }

  const mainPrompt = await assembleFor('s-main')
  const w1Prompt = await assembleFor('s-w1')
  const w2Prompt = await assembleFor('s-w2')

  // Verify strict ordering inside assembled system prompt:
  // bot-team-rules (640) < DSH static (900..10200) < bot-identity (10300) < feature-packs (10310) < bot-memory (10320).
  for (const prompt of [mainPrompt, w1Prompt, w2Prompt]) {
    const idxTeam = prompt.indexOf('## How your Bot team works')
    const idxFileRef = prompt.indexOf('# File reference')
    const idxBash = prompt.indexOf('# Bash')
    const idxSuffix = prompt.indexOf('# Deployment suffix')
    const idxIdentity = prompt.indexOf('# Your identity')
    const idxPacks = prompt.indexOf('# Feature packs')
    const idxMemory = prompt.indexOf('# Your memory')
    assert.ok(idxTeam >= 0 && idxFileRef > idxTeam && idxBash > idxFileRef && idxSuffix > idxBash, 'DSH static sections must follow bot-team-rules')
    assert.ok(idxIdentity > idxSuffix, 'per-Bot identity must sit AFTER DSH static sections (order > 10200)')
    assert.ok(idxPacks > idxIdentity, 'feature-packs must sit after bot-identity')
    assert.ok(idxMemory > idxPacks, 'bot-memory must sit after feature-packs')
  }

  // Main Bot, Worker A, and Worker B MUST ALL share a byte-identical prefix all the way
  // through bot-team-rules (640) AND DSH DEPLOYMENT_PERSONA_SUFFIX (10200) up to # Your identity (10300)!
  const cutMain = mainPrompt.indexOf('# Your identity')
  const cutW1 = w1Prompt.indexOf('# Your identity')
  const cutW2 = w2Prompt.indexOf('# Your identity')
  assert.equal(w1Prompt.slice(0, cutW1), w2Prompt.slice(0, cutW2), 'all Worker Bots must share a byte-identical static prefix up to # Your identity')
  assert.equal(mainPrompt.slice(0, cutMain), w1Prompt.slice(0, cutW1), 'Main Bot and Worker Bots must share the entire static prefix through DSH sections (800..10200)')

  // Main Bot authority rules sit inside bot-identity (after # Your identity, before # Feature packs).
  const idxMainRules = mainPrompt.indexOf('## You are the Main Bot (Chief of Staff)')
  assert.ok(idxMainRules > cutMain && idxMainRules < mainPrompt.indexOf('# Feature packs'), 'MAIN_RULES must sit inside bot-identity (order 10300)')
  assert.equal(w1Prompt.includes('## You are the Main Bot (Chief of Staff)'), false, 'Worker Bots must not receive MAIN_RULES')

  // Feature packs MUST NOT contain volatile runtime `(\d+ tools)` suffixes.
  assert.doesNotMatch(w1Prompt, /\(\d+ tools\)/)
  assert.match(w1Prompt, /- pack-a: Database tools/)
})

test('P1-2: capabilities feature-packs catalog stays byte-identical across MCP mounts with zero volatile tool counts', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-p12-caps-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const state = {
    bots: {
      b1: { id: 'b1', name: 'Alpha', sessionId: 's1', packs: ['db'] },
      b2: { id: 'b2', name: 'Beta', sessionId: 's2', packs: ['db'] },
    },
    rooms: {},
    capabilities: {
      items: {
        db: { kind: 'mcp', description: 'Database query tools', command: 'echo', args: [] },
      },
    },
    prefs: {},
  }
  const rt = {
    ctx,
    home,
    config: {},
    state,
    load: async () => {},
    save: async () => {},
    warn: () => {},
    readOnly: () => undefined,
    botOf: id => state.bots[id],
    roomOf: () => undefined,
    selfOf: sid => ({ s1: 'b1', s2: 'b2' }[sid]),
    isBotSession: sid => sid === 's1' || sid === 's2',
    chatOwners: new Map([['s1', 'b1'], ['s2', 'b2']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    teamTools: [],
    onBotDelete: () => {},
  }
  installCapabilities(rt)

  const assembleCatalog = async (sid) => {
    const out = await ctx.systemPrompt.assemble({ agent: { id: sid, session: { id: sid } }, signal: AbortSignal.timeout(5_000) })
    return out.sections.find(s => s.name === 'feature-packs')?.text ?? ''
  }

  const s1Before = await assembleCatalog('s1')
  const s2Before = await assembleCatalog('s2')
  assert.equal(s1Before, s2Before, 'Bots sharing the same packs must render byte-identical feature-packs text')
  assert.match(s1Before, /^- db: Database query tools$/m)
  assert.doesNotMatch(s1Before, /\(\d+ tools\)/, 'feature-packs must never append volatile runtime tool counts')
})

// -----------------------------------------------------------------------------
// P1-3 + P2-2: Cold chat-index reads, messages_session_time index, CJK fallback
// -----------------------------------------------------------------------------
test('P1-3: eventsBackwards reads archived multi-page sessions cold via sessionController.page without calling resolveAgent, and handles session/not-found cleanly', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-p13-cold-'))
  const allEvents = Array.from({ length: 450 }, (_, seq) => ({
    seq,
    time: 1_000 + seq,
    text: seq === 5 ? 'Ancient secret alpha-zero' : `Archived message ${seq}`,
  }))
  const pageCalls = []
  let resolveAgentCalls = 0
  const liveAgents = new Map([
    ['s-live', { id: 's-live', session: { id: 's-live', seq: 3 } }],
    ['s-empty', { id: 's-empty', session: { id: 's-empty', seq: 0 } }],
  ])
  const dispose = []
  const rt = {
    home,
    ctx: {
      get: name => (name === 'agents' ? liveAgents : undefined),
      effect: fn => dispose.push(fn()),
      sessionController: {
        page: async (req) => {
          pageCalls.push({ ...req })
          const sid = req.address.sessionId
          if (sid === 's-missing') throw Object.assign(new Error('session "s-missing" not found'), { code: 'session/not-found' })
          if (sid === 's-io-err') throw Object.assign(new Error('disk read failed'), { code: 'gateway/internal' })
          if (sid === 's-mid-missing') {
            if (req.beforeSeq === undefined) {
              return { cursor: 10, records: [{ event: { seq: 10, time: 10, text: 'page1' } }], hasMore: true }
            }
            throw Object.assign(new Error('session disappeared mid-read'), { code: 'session/not-found' })
          }
          const through = req.throughSeq ?? (allEvents.length - 1)
          const filtered = allEvents.filter(ev => ev.seq <= through && (req.beforeSeq === undefined || ev.seq < req.beforeSeq))
          const slice = filtered.slice(-req.maxMessages)
          return {
            cursor: through,
            records: slice.map(event => ({ event })),
            hasMore: filtered.length > slice.length,
          }
        },
      },
    },
    partsOf: () => [{ sessionId: 's-archived', number: 1, startedAt: 0 }],
    resolveAgent: async () => {
      resolveAgentCalls += 1
      throw new Error('workDir deleted on disk — resolveAgent must NOT be called')
    },
    historyEntry: event => ({ text: event.text, who: 'user', keepAnswers: true }),
    clock: time => String(time),
    warn: (...args) => assert.fail(args.join(' ')),
  }
  t.after(() => {
    for (const close of dispose) close()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  installChatIndex(rt)

  // 1) Cold multi-page read across 450 events (3 pages of 200).
  const read = {}
  const collected = []
  for await (const ev of rt.eventsBackwards('s-archived', AbortSignal.timeout(5_000), Infinity, read)) {
    collected.push(ev.seq)
  }
  assert.equal(resolveAgentCalls, 0, 'cold archived read must NEVER call rt.resolveAgent')
  assert.equal(read.complete, true)
  assert.equal(collected.length, 450)
  assert.equal(collected[0], 449)
  assert.equal(collected.at(-1), 0)
  assert.equal(pageCalls.length, 3)
  assert.equal('throughSeq' in pageCalls[0], false, 'page 1 of cold read must omit throughSeq')
  assert.equal(pageCalls[1].throughSeq, 449, 'page 2 must pin throughSeq from page 1 cursor')
  assert.equal(pageCalls[2].throughSeq, 449, 'page 3 must keep pinned throughSeq')

  // 2) Full searchOwnChat on archived part indexes all 450 events cold without waking an agent.
  const found = await rt.searchOwnChat('b1', 'alpha-zero', { limit: 5 })
  assert.equal(resolveAgentCalls, 0, 'searchOwnChat must index archived part without resolveAgent')
  assert.equal(found.lines.length, 1)
  assert.match(found.lines[0], /Ancient secret alpha-zero/)

  // 3) Live session in ctx.get('agents') pins throughSeq=seq-1 immediately, and seq=0 skips paging altogether.
  pageCalls.length = 0
  const emptyRead = {}
  const emptyOut = []
  for await (const ev of rt.eventsBackwards('s-empty', AbortSignal.timeout(5_000), Infinity, emptyRead)) emptyOut.push(ev)
  assert.equal(emptyOut.length, 0)
  assert.equal(emptyRead.complete, true)
  assert.equal(pageCalls.length, 0, 'empty live session (seq=0) must return without paging')

  const liveOut = []
  for await (const ev of rt.eventsBackwards('s-live', AbortSignal.timeout(5_000), Infinity)) liveOut.push(ev.seq)
  assert.equal(pageCalls.length, 1)
  assert.equal(pageCalls[0].throughSeq, 2, 'live session must pin throughSeq=seq-1 on page 1')
  assert.deepEqual(liveOut, [2, 1, 0])

  // 4) Uninitialized/missing session (DSH RemoteError 'session/not-found' on page 1) returns empty & complete=true.
  const missingRead = {}
  const missingOut = []
  for await (const ev of rt.eventsBackwards('s-missing', AbortSignal.timeout(5_000), Infinity, missingRead)) missingOut.push(ev)
  assert.deepEqual(missingOut, [])
  assert.equal(missingRead.complete, true, 'page-1 session/not-found must complete cleanly with 0 events')

  // 5) Non-not-found errors AND mid-pagination session/not-found failures MUST still propagate!
  await assert.rejects(async () => {
    const out = []
    for await (const ev of rt.eventsBackwards('s-io-err', AbortSignal.timeout(5_000), Infinity)) out.push(ev)
    return out
  }, /disk read failed/)
  await assert.rejects(async () => {
    const out = []
    for await (const ev of rt.eventsBackwards('s-mid-missing', AbortSignal.timeout(5_000), Infinity)) out.push(ev)
    return out
  }, /session disappeared mid-read/)
})

test('P1-3 + P2-2: short (<3-char) termQuery uses messages_session_time index (no FTS5 scan), upgrades v5 DB in place, and Tier-2 CJK bigram fallback recovers unsegmented queries', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-p13-p22-'))
  const dbPath = join(home, 'chat-index.sqlite')
  // Seed an existing v5 database WITHOUT messages_session_time to verify zero-rebuild upgrade!
  const seed = new DatabaseSync(dbPath)
  seed.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, text, session, seq, time, who);
    CREATE INDEX messages_session_seq ON messages (session, seq);
    CREATE VIRTUAL TABLE lines USING fts5(text, session UNINDEXED, seq UNINDEXED, time UNINDEXED, who UNINDEXED, content = 'messages', content_rowid = 'id', tokenize = 'trigram');
    CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, keep INTEGER NOT NULL, sealed INTEGER NOT NULL, turn INTEGER NOT NULL);
    INSERT INTO messages (text, session, seq, time, who) VALUES ('旧数据保留验证', 's-other', 0, 100, 'user');
    INSERT INTO lines (rowid, text, session, seq, time, who) VALUES (1, '旧数据保留验证', 's-other', 0, 100, 'user');
    INSERT INTO marks VALUES ('s-other', 0, 1, 1, -1);
    PRAGMA user_version = 5;
  `)
  seed.close()

  const s1Events = [
    { seq: 0, time: 1000, text: '今天天气不错' },
    { seq: 1, time: 2000, text: '我们配置了路由器' },
    { seq: 2, time: 3000, text: '我们先配置了生产数据库，再跑迁移' },
    { seq: 3, time: 4000, text: 'PR #42 已合并' },
  ]
  const dispose = []
  let db
  t.after(() => {
    db?.close()
    for (const close of dispose) close()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const rt = {
    home,
    ctx: {
      effect: fn => dispose.push(fn()),
      sessionController: {
        page: async ({ address }) => {
          const list = address.sessionId === 's1' ? s1Events : []
          return { cursor: list.length - 1, records: list.map(event => ({ event })), hasMore: false }
        },
      },
    },
    partsOf: () => [{ sessionId: 's1', number: 1, startedAt: 0 }],
    historyEntry: event => ({ text: event.text, who: 'user', keepAnswers: true }),
    clock: time => String(time),
    warn: (...args) => assert.fail(args.join(' ')),
  }
  installChatIndex(rt)

  // Trigger index open + catch-up for s1.
  await rt.latestOwnChat('b1', { limit: 10 })

  // 1) Verify existing v5 row was preserved (no rebuild wipe) AND messages_session_time index was added.
  db = new DatabaseSync(dbPath)
  assert.equal(db.prepare("SELECT text FROM messages WHERE session = 's-other'").get()?.text, '旧数据保留验证', 'existing v5 rows must not be wiped')

  // 2) Verify EXPLAIN QUERY PLAN for short (<3-char) queries uses messages_session_time (NOT FTS5 SCAN lines).
  for (const shortTerm of ['配置', 'pr']) {
    const q = termQuery([shortTerm], ['s1'], 20)
    assert.match(q.sql, /FROM messages WHERE/, `short term "${shortTerm}" must query messages table`)
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.args).map(row => row.detail).join('\n')
    assert.match(plan, /USING INDEX messages_session_time/, `short term "${shortTerm}" must use messages_session_time index; got:\n${plan}`)
    assert.doesNotMatch(plan, /SCAN lines/, `short term "${shortTerm}" must never scan FTS5 virtual table lines`)
  }
  // Short query returns only s1's rows newest-first (time DESC).
  const shortCfg = termQuery(['配置'], ['s1'], 20)
  const shortRows = db.prepare(shortCfg.sql).all(...shortCfg.args)
  assert.deepEqual(shortRows.map(r => r.seq), [2, 1], 'short query must return matching s1 rows ordered by time DESC')

  // 3) Tier-2 CJK bigram fallback: unsegmented >=4-char Han query with 0 exact hits recovers best match!
  const fallbackSingle = await rt.searchOwnChat('b1', '配置数据库', { limit: 10 })
  assert.equal(fallbackSingle.every, false, 'Tier-2 CJK fallback must report every=false')
  assert.ok(fallbackSingle.lines.length >= 1, 'Tier-2 CJK fallback must recover split phrase')
  assert.ok(fallbackSingle.lines.some(line => line.includes('我们先配置了生产数据库，再跑迁移')), 'must recover message containing split CJK sub-terms')

  // Multi-term unsegmented CJK fallback when both exact terms miss.
  const fallbackMulti = await rt.searchOwnChat('b1', '配置数据库 生产迁移', { limit: 10 })
  assert.equal(fallbackMulti.every, false)
  assert.ok(fallbackMulti.lines.some(line => line.includes('我们先配置了生产数据库，再跑迁移')))

  // 4) Tier-1 exact match still wins cleanly once an exact message exists!
  s1Events.push({ seq: 4, time: 5000, text: '这里直接配置数据库即可' })
  const exact = await rt.searchOwnChat('b1', '配置数据库', { limit: 10 })
  assert.equal(exact.every, true, 'Tier-1 exact match must win with every=true when exact phrase exists')
  assert.equal(exact.lines.length, 1)
  assert.match(exact.lines[0], /这里直接配置数据库即可/)
})

// -----------------------------------------------------------------------------
// P2-1: time-context LRU cache, browser/mount checkedState, thinking LRU/cleanup
// -----------------------------------------------------------------------------
test('P2-1: time-context.js scans eventsBackwards at most once on cold miss, refreshes without rescan, and clears on onBotDelete', async () => {
  const ctx = fakeContext()
  let now = 1_700_000_000_000
  const origNow = Date.now
  Date.now = () => now
  try {
    let scans = 0
    const deleteHooks = []
    const rt = {
      ctx,
      config: { timeZone: 'UTC' },
      load: async () => {},
      isBotSession: () => true,
      botOf: id => (id === 'b1' ? { id: 'b1', sessionId: 's1', segments: [{ sessionId: 's0' }] } : undefined),
      chatOf: id => (id === 'b1' ? 's1' : undefined),
      groupSessionsOf: () => [],
      onBotDelete: fn => deleteHooks.push(fn),
      async *eventsBackwards() {
        scans += 1
        // Empty cold history on first scan.
        yield* []
      },
    }
    installTimeContext(rt)
    const preStep = ctx.listeners.get('agent/pre-step').at(-1)
    const runStep = () => preStep(
      { agent: { id: 's1', session: {} }, signal: AbortSignal.timeout(5_000) },
      async () => ({ kind: 'enter', messages: [] }),
    )

    // Step 1 (cold miss): 1 scan, emits clock.
    const d1 = await runStep()
    assert.equal(scans, 1)
    assert.equal(d1.messages.length, 1)

    // Steps 2-5 within 10 minutes: 0 scans, no extra clock.
    for (let i = 0; i < 4; i += 1) {
      now += 60_000
      const d = await runStep()
      assert.equal(d.messages.length, 0)
    }
    assert.equal(scans, 1, 'subsequent steps within interval must hit lastClockAt cache with 0 eventsBackwards calls')

    // Advance past 10-minute interval: refreshes clock with 0 eventsBackwards calls!
    now += 11 * 60_000
    const d6 = await runStep()
    assert.equal(d6.messages.length, 1, 'must emit refreshed clock after interval')
    assert.equal(scans, 1, 'interval refresh must use cached timestamp with 0 eventsBackwards calls')

    // onBotDelete clears cached entries so a re-scanned session performs a cold lookup again.
    for (const hook of deleteHooks) hook('b1')
    now += 60_000
    await runStep()
    assert.equal(scans, 2, 'onBotDelete must evict session from lastClockAt cache')
  } finally {
    Date.now = origNow
  }
})

test('P2-1: browser/mount.js skips already-checked surface nodes in O(1) AND still fixes mid-array surfaceOp:replace nodes', async (t) => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  t.after(async () => { await ctx.fiber.dispose() })

  const savedRef = { attachmentId: 'sha256:fixed', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  let flushed = 0
  let savedCount = 0
  let onSaveImage
  const plugin = (inner) => {
    inner.provide('sessions', { flush: async () => { flushed += 1 } })
    inner.provide('attachments', {
      saveImage: async () => {
        savedCount += 1
        if (onSaveImage) await onSaveImage()
        return savedRef
      },
    })
    mountBrowserPlugin(inner, {
      toolDefs: refsTools.filter(tool => tool.name === 'browser_screenshot'),
      defineTool,
      keyOf: async () => 'bot-1',
      profileRoot: '/tmp/browser-profiles',
      headless: true,
      openSession: async () => ({ async shot() { return { text: 'ok' } }, async close() {} }),
    })
  }
  plugin.inject = ['tools']
  await ctx.plugin(plugin)

  // Construct a real DSH Session with an already-clean browser_screenshot result + a later user message.
  const session = Session.create('s-browser')
  const callEvent = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: ToolCallId('call-1'),
    name: 'browser_screenshot',
    arguments: '{}',
  })
  const resultEvent = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call-1'),
      isError: false,
      content: [{ type: 'image', attachment: savedRef }],
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Next turn' }] }, { surfaceOp: 'append' })

  let deriveCalls = 0
  let eventAtCalls = 0
  const origDerive = session.deriveEventMessage.bind(session)
  const origEventAt = session.eventAt.bind(session)
  session.deriveEventMessage = (ev) => { deriveCalls += 1; return origDerive(ev) }
  session.eventAt = (seq) => { eventAtCalls += 1; return origEventAt(seq) }

  const runPreStep = () => ctx.waterfall('agent/pre-step', { agent: { id: 's-browser', session } }, async () => ({ kind: 'enter', messages: [] }))

  // Step 1: inspects surface once.
  await runPreStep()
  assert.equal(deriveCalls, 1)
  const eventAtAfterStep1 = eventAtCalls

  // Steps 2-4 with unchanged surface: O(1) fast path -> 0 eventAt and 0 deriveEventMessage calls!
  for (let i = 0; i < 3; i += 1) await runPreStep()
  assert.equal(deriveCalls, 1, 'steady steps must not re-derive already-checked tool results')
  assert.equal(eventAtCalls, eventAtAfterStep1, 'steady steps must hit O(1) replaceGeneration+tail fast path')

  // Appending a newer non-browser event inspects ONLY the new seq (still 0 deriveEventMessage on old tool/result).
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Another message' }] }, { surfaceOp: 'append' })
  await runPreStep()
  assert.equal(deriveCalls, 1, 'appending a new user message must not re-derive old tool results')

  // Mid-array surfaceOp:replace at resultEvent.seq (tail nodes.at(-1) stays UNCHANGED, replaceGeneration increments!):
  // mountBrowserPlugin must detect the higher-seq replacement in the middle of surface.nodes and rewrite its inline image!
  const tailBefore = session.surface.nodes.at(-1)
  session.append('tool/result', {
    ...resultEvent.data,
    message: {
      ...resultEvent.data.message,
      content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
    },
  }, { surfaceOp: { op: 'replace', startSeq: resultEvent.seq, endSeq: resultEvent.seq }, sourceEventSeqs: [callEvent.seq, resultEvent.seq] })
  assert.equal(session.surface.nodes.at(-1), tailBefore, 'mid-array replace leaves tail seq unchanged')

  await runPreStep()
  assert.equal(savedCount, 1, 'mid-array surface replacement with malformed inline image must still be caught and saved')
  assert.equal(flushed, 1, 'rewritten replacement must flush session')

  // Concurrent append during async saveImage await: a second malformed browser tool/result arriving
  // while pre-step is awaiting saveImage must NOT be skipped by checkedState on the next step!
  const call2 = session.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('call-2'), name: 'browser_screenshot', arguments: '{}' })
  session.append('tool/result', {
    turn: 2,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call-2'),
      isError: false,
      content: [{ type: 'image', mediaType: 'image/png', data: 'BBBB' }],
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call2.seq] })

  onSaveImage = async () => {
    onSaveImage = undefined
    // Append a concurrent browser tool/result BEFORE the replacement of call-2 gets appended!
    const call3 = session.append('tool/call', { turn: 2, step: 2, callId: ToolCallId('call-3'), name: 'browser_screenshot', arguments: '{}' })
    session.append('tool/result', {
      turn: 2,
      step: 2,
      message: createToolResultMessage({
        callId: ToolCallId('call-3'),
        isError: false,
        content: [{ type: 'image', mediaType: 'image/png', data: 'CCCC' }],
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call3.seq] })
  }
  await runPreStep()
  assert.equal(savedCount, 2, 'call-2 image repaired on this step')
  await runPreStep()
  assert.equal(savedCount, 3, 'concurrent call-3 image appended during saveImage await must still be caught on next step')
})

test('P2-1: thinking.js caches closed turns, evicts deleted Bot sessions on onBotDelete, and bounds settled cache', async () => {
  let scans = 0
  const deleteHooks = []
  const events = [
    { seq: 0, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    {
      seq: 1,
      time: 1_100,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [] },
        stream: [{ type: 'reasoning-chunks', time0: 1_000, index: 0, dt: [420], texts: ['a', 'b'] }],
      },
    },
    { seq: 2, time: 1_600, type: 'turn/end', data: { turn: 1 } },
  ]
  const rt = {
    botOf: id => (id === 'b1' ? { id: 'b1', sessionId: 's1', segments: [{ sessionId: 's0' }] } : undefined),
    chatOf: id => (id === 'b1' ? 's1' : undefined),
    groupSessionsOf: () => ['g1'],
    onBotDelete: fn => deleteHooks.push(fn),
    eventsBackwards: async function* () {
      scans += 1
      for (const ev of [...events].reverse()) yield ev
    },
  }
  installThinking(rt)

  // First read scans history and caches closed turn 1; second read hits cache (0 scans).
  assert.equal(await rt.thinkingOf('s1', 1), 420)
  assert.equal(await rt.thinkingOf('s1', 1), 420)
  assert.equal(scans, 1)

  // Group session of b1 is also cached and cleared on onBotDelete.
  assert.equal(await rt.thinkingOf('g1', 1), 420)
  assert.equal(scans, 2)

  for (const hook of deleteHooks) hook('b1')

  // After onBotDelete('b1'), both s1 and g1 are evicted and must rescan.
  assert.equal(await rt.thinkingOf('s1', 1), 420)
  assert.equal(await rt.thinkingOf('g1', 1), 420)
  assert.equal(scans, 4, 'onBotDelete must evict all settled thinking cache keys belonging to deleted Bot')
})
