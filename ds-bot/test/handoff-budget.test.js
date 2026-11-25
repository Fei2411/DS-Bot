import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ATTACHMENT_ALLOWANCE_BYTES,
  DEFAULT_BYTES_PER_TOKEN,
  computeHandoffBudget,
  countMessageAttachments,
  fitHandoffHistory,
  measureMessagesBytes,
  truncateUtf8Bytes,
  utf8Bytes,
} from '../src/host/handoff-budget.js'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { LocalAgentAdapter } from '../src/host/local-agents/adapter.js'
import { install as partsInstall } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

const FIXTURE = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

function hasBrokenSurrogates(str) {
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = str.charCodeAt(i + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
      i += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true
    }
  }
  return false
}

test('computeHandoffBudget follows exact formula across varying context windows, attachments, and reserves', () => {
  // Explicit byte inputs verify exact formula:
  // availableBytes = max(0, targetWindowBytes - nativeUsedBytes - currentTurnBytes - attachmentAllowanceBytes - workReserveBytes)
  const exact = computeHandoffBudget({
    targetWindowBytes: 100_000,
    nativeUsedBytes: 10_000,
    currentTurnBytes: 5_000,
    attachmentAllowanceBytes: 8_192,
    workReserveBytes: 25_000,
  })
  assert.equal(exact.availableBytes, 100_000 - 10_000 - 5_000 - 8_192 - 25_000)

  // Dynamic token window scaling (small 4k, medium 32k, large 200k)
  const small = computeHandoffBudget({ targetWindowTokens: 4_000, nativeUsedBytes: 1_000, currentTurnBytes: 1_000 })
  const medium = computeHandoffBudget({ targetWindowTokens: 32_000, nativeUsedBytes: 1_000, currentTurnBytes: 1_000 })
  const large = computeHandoffBudget({ targetWindowTokens: 200_000, nativeUsedBytes: 1_000, currentTurnBytes: 1_000 })
  assert.equal(small.targetWindowBytes, Math.floor(4_000 * DEFAULT_BYTES_PER_TOKEN))
  // Small window reserve floor clamps at 50% of window so small models degrade gracefully
  assert.equal(small.workReserveBytes, Math.floor(small.targetWindowBytes * 0.5))
  assert.ok(small.availableBytes > 0)
  assert.ok(small.availableBytes < medium.availableBytes)
  assert.ok(medium.availableBytes < large.availableBytes)

  // Attachment count subtracts per-attachment allowance
  const withTwoImages = computeHandoffBudget({
    targetWindowBytes: 80_000,
    nativeUsedBytes: 2_000,
    currentTurnBytes: 1_000,
    attachmentCount: 2,
    workReserveBytes: 20_000,
  })
  assert.equal(withTwoImages.attachmentAllowanceBytes, 2 * DEFAULT_ATTACHMENT_ALLOWANCE_BYTES)
  assert.equal(withTwoImages.availableBytes, 80_000 - 2_000 - 1_000 - 2 * DEFAULT_ATTACHMENT_ALLOWANCE_BYTES - 20_000)

  // Extreme pressure clamps cleanly to 0 (never negative)
  const squeezed = computeHandoffBudget({
    targetWindowTokens: 1_000,
    nativeUsedBytes: 5_000,
    currentTurnBytes: 50_000,
    attachmentCount: 5,
  })
  assert.equal(squeezed.availableBytes, 0)

  // maxHistoryBytes ceiling caps huge windows
  const capped = computeHandoffBudget({ targetWindowTokens: 1_000_000, maxHistoryBytes: 64_000 })
  assert.equal(capped.availableBytes, 64_000)

  // Message helpers count attachments & UTF-8 bytes accurately
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '你好🚀' }, { type: 'image', attachment: {} }, { type: 'file', attachment: {} }] },
  ]
  assert.equal(countMessageAttachments(msgs), 2)
  assert.equal(measureMessagesBytes(msgs), Buffer.byteLength('你好🚀', 'utf8'))
})

test('truncateUtf8Bytes enforces exact UTF-8 byte limits without breaking CJK or surrogate pairs', () => {
  const sample = 'A中B文🚀C🎉D𠜎EéF'
  for (let limit = 0; limit <= utf8Bytes(sample) + 4; limit += 1) {
    const cut = truncateUtf8Bytes(sample, limit)
    assert.ok(utf8Bytes(cut) <= limit, `limit=${limit} got ${utf8Bytes(cut)} bytes: ${JSON.stringify(cut)}`)
    assert.equal(hasBrokenSurrogates(cut), false, `limit=${limit} produced broken surrogate pair`)
    assert.equal(cut.includes('\uFFFD'), false, `limit=${limit} produced U+FFFD`)
  }
  // Exact fit and Infinity return unchanged without suffix
  assert.equal(truncateUtf8Bytes(sample, utf8Bytes(sample)), sample)
  assert.equal(truncateUtf8Bytes(sample, Infinity), sample)
  assert.equal(truncateUtf8Bytes('🚀🎉🔥', 0), '')
  assert.equal(truncateUtf8Bytes('🚀🎉🔥', 7, '…'), '🚀…') // 4 + 3 = 7 bytes
  assert.equal(truncateUtf8Bytes('🚀🎉🔥', 6, '…'), '…') // only 3 bytes left for body, cannot fit 4-byte emoji
})

test('fitHandoffHistory preserves newest turn even at 0 budget and trims earlier -> tools -> oldest recent deterministically', () => {
  const currentTurn = 'User: Keep this newest message verbatim with 中文 and 🚀!'
  const earlier = ['[part 1 #1] older anchor A', '[part 1 #2] older anchor B']
  const tools = ['- [10:00] read_file(a.js) -> ok', '- [10:01] edit_file(b.js) -> ok']
  const recent = ['User: turn 1 older context', 'You: turn 1 reply', 'User: turn 2 newer context']

  // 1. Generous budget keeps everything
  const full = fitHandoffHistory({ currentTurn, earlier, tools, recent, availableBytes: 10_000 })
  assert.deepEqual(full.currentTurn, [currentTurn])
  assert.deepEqual(full.earlier, earlier)
  assert.deepEqual(full.tools, tools)
  assert.deepEqual(full.recent, recent)
  assert.equal(full.droppedEarlier, 0)
  assert.equal(full.droppedTools, 0)
  assert.equal(full.droppedRecent, 0)

  // 2. Budget smaller than total drops `earlier` first (oldest-first), preserving `tools` and `recent`
  const noEarlierBudget = utf8Bytes(tools.join('\n')) + 1 + utf8Bytes(recent.join('\n'))
  const step1 = fitHandoffHistory({ currentTurn, earlier, tools, recent, availableBytes: noEarlierBudget })
  assert.deepEqual(step1.earlier, [])
  assert.equal(step1.droppedEarlier, 2)
  assert.deepEqual(step1.tools, tools)
  assert.deepEqual(step1.recent, recent)
  assert.ok(step1.usedBytes <= noEarlierBudget)

  // 3. Tighter budget drops `tools` next, keeping `recent`
  const onlyRecentBudget = utf8Bytes(recent.join('\n'))
  const step2 = fitHandoffHistory({ currentTurn, earlier, tools, recent, availableBytes: onlyRecentBudget })
  assert.deepEqual(step2.earlier, [])
  assert.deepEqual(step2.tools, [])
  assert.equal(step2.droppedTools, 2)
  assert.deepEqual(step2.recent, recent)
  assert.ok(step2.usedBytes <= onlyRecentBudget)

  // 4. Tighter still drops oldest `recent` turns first, keeping newest older turn
  const oneRecentBudget = utf8Bytes(recent[2])
  const step3 = fitHandoffHistory({ currentTurn, earlier, tools, recent, availableBytes: oneRecentBudget })
  assert.deepEqual(step3.recent, [recent[2]])
  assert.equal(step3.droppedRecent, 2)
  assert.ok(step3.usedBytes <= oneRecentBudget)

  // 5. Tiny budget truncates the last remaining older `recent` entry on a clean UTF-8 boundary
  const multiByteOlder = ['User: 这是一段很长的历史记录🚀🎉需要被安全截断']
  const step4 = fitHandoffHistory({ currentTurn, recent: multiByteOlder, availableBytes: 24 })
  assert.equal(step4.recent.length, 1)
  assert.ok(utf8Bytes(step4.recent[0]) <= 24)
  assert.equal(hasBrokenSurrogates(step4.recent[0]), false)
  assert.equal(step4.truncatedEntries, 1)
  assert.deepEqual(step4.currentTurn, [currentTurn], 'newest turn stays untouched')

  // 6. Zero budget drops all historical context but NEVER drops or truncates currentTurn
  const zero = fitHandoffHistory({ currentTurn, earlier, tools, recent, availableBytes: 0 })
  assert.deepEqual(zero.earlier, [])
  assert.deepEqual(zero.tools, [])
  assert.deepEqual(zero.recent, [])
  assert.equal(zero.usedBytes, 0)
  assert.deepEqual(zero.currentTurn, [currentTurn])

  // 7. Explicit maxEntryBytes === 0 drops all non-empty historical entries (never leaves them uncapped)
  const zeroEntryCap = fitHandoffHistory({ currentTurn, earlier, tools, recent, availableBytes: 10_000, maxEntryBytes: 0 })
  assert.deepEqual(zeroEntryCap.earlier, [])
  assert.deepEqual(zeroEntryCap.tools, [])
  assert.deepEqual(zeroEntryCap.recent, [])
  assert.equal(zeroEntryCap.droppedEarlier, earlier.length)
  assert.equal(zeroEntryCap.droppedTools, tools.length)
  assert.equal(zeroEntryCap.droppedRecent, recent.length)
  assert.equal(zeroEntryCap.truncatedEntries, 0)
  assert.deepEqual(zeroEntryCap.currentTurn, [currentTurn])

  // 8. truncatedEntries counts only entries that survive in the final output (dropped entries are excluded)
  const truncatedThenDropped = fitHandoffHistory({
    currentTurn,
    earlier: ['A'.repeat(100), 'B'.repeat(100)],
    tools: ['T'.repeat(100)],
    recent: ['R'.repeat(100), 'short'],
    maxEntryBytes: 20,
    availableBytes: 10,
  })
  assert.deepEqual(truncatedThenDropped.earlier, [])
  assert.deepEqual(truncatedThenDropped.tools, [])
  assert.deepEqual(truncatedThenDropped.recent, ['short'])
  assert.equal(truncatedThenDropped.truncatedEntries, 0, 'dropped pre-truncated entries must not inflate truncatedEntries')

  // 9. Single remaining entry that truncates to empty string under tiny byte budget is dropped without incrementing truncatedEntries
  const tinyMultiByte = fitHandoffHistory({
    currentTurn,
    recent: ['中文超长内容'],
    availableBytes: 2, // smaller than 3-byte ellipsis suffix and 3-byte CJK char
  })
  assert.deepEqual(tinyMultiByte.recent, [])
  assert.equal(tinyMultiByte.droppedRecent, 1)
  assert.equal(tinyMultiByte.truncatedEntries, 0)
})

test('parts.js moveOn enforces target model UTF-8 byte budget and preserves newest turn on small-window switch', async () => {
  const followed = []
  const historyEvents = [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `Oldest question ${'甲'.repeat(600)}` }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: `Oldest reply ${'乙'.repeat(600)}` }] } } },
    { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: `Middle question ${'🚀'.repeat(400)}` }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: `Middle reply ${'丙'.repeat(400)}` }] } } },
    { type: 'user/message', seq: 5, time: 5, data: { content: [{ type: 'text', text: 'NEWEST_TURN_MUST_SURVIVE_VERBATIM_中文_🚀' }], source: { kind: 'user' } } },
  ]
  const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 50_000 }) } } })
  ctx.logger = { warn: () => {}, info: () => {} }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  // Target model has a small 2,000-token window (~7,000 bytes), forcing exact byte-budget trimming.
  ctx.llm = {
    resolveModelInfo: async (provider, model) => ({
      context: { contextWindow: provider === 'small-provider' && model === 'tiny' ? 2_000 : 200_000 },
    }),
  }

  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'small-provider/tiny', appliedModel: 'big-provider/large', segments: [] }
  const session = {
    id: 's1',
    header: { cwd: '/tmp/team' },
    requestHeader: () => ({ config: { provider: 'big-provider', model: 'large' } }),
    deriveMessages: () => [],
    toolHistory: () => [],
  }
  const agent = {
    id: 's1', session, status: 'idle',
    whenIdle: async () => {},
    runMaintenance: async job => job(AbortSignal.timeout(10_000)),
    inbox: { nextStep: [], nextTurn: [] },
    followup: message => followed.push(message),
    send: async () => {},
  }
  const fresh = {
    id: 's2',
    session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
    status: 'idle',
    whenIdle: async () => {},
    runMaintenance: async job => job(AbortSignal.timeout(10_000)),
    inbox: { nextStep: [], nextTurn: [] },
    followup: message => followed.push(message),
    send: async () => {},
  }
  const rt = {
    ctx,
    home: '/unused',
    config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
    warn: () => {},
    async save() {},
    async load() {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    selfOf: () => 'b1',
    isMain: () => false,
    chatOf: () => 's1',
    sessionOfRoom: () => undefined,
    isBotSession: id => ['s1', 's2'].includes(id),
    isLocalAgentRef: ref => String(ref).startsWith('local-'),
    isLocalAgentRoute: route => String(route).startsWith('local-'),
    engineOf: ref => (String(ref).startsWith('small-provider/') ? 'small-engine' : 'big-engine'),
    engineOfBot: subject => (String(subject?.model).startsWith('small-provider/') ? 'small-engine' : 'big-engine'),
    engineNameOf: ref => ref,
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    teamTools: [],
    live: new Map(),
    groupSessionsOf: () => [],
    unreadOf: () => [],
    eventsBackwards: async function* () {
      for (const event of [...historyEvents].reverse()) yield event
    },
    resolveAgent: async id => (id === 's2' ? fresh : agent),
    createSession: async () => 's2',
    desiredModel: async subject => subject.model,
    desiredEffort: async () => undefined,
    selectSessionModel: async () => {},
    applyPermission: async () => {},
    ensureCapabilities: async () => {},
    renewMemory: () => {},
    moveSchedules: async () => {},
    deliver: async () => {},
    teamFolder: () => '/tmp/team',
    workDirOf: () => '/tmp/team',
    isFolder: async () => true,
    roomProgress: new Map(),
  }

  partsInstall(rt)
  await rt.followEngine('b1')
  for (let i = 0; i < 100 && bot.sessionId !== 's2'; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(bot.sessionId, 's2')
  const pkg = followed.map(m => m.content.map(b => b.text).join('')).join('\n')
  assert.ok(pkg.includes('NEWEST_TURN_MUST_SURVIVE_VERBATIM_中文_🚀'), 'newest user turn must survive intact')
  assert.equal(pkg.includes('Oldest question'), false, 'oldest history must be trimmed to fit small target window')
  assert.equal(hasBrokenSurrogates(pkg), false, 'trimmed handoff package must not split surrogate pairs')
  assert.match(pkg, /Older messages were not carried/, 'trimmed handoff must note omission honestly')
})

test('parts.js moveOn accounts for session requestHeader/system prompt overhead in nativeUsedBytes', async () => {
  const runSwitch = async ({ withHeaderOverhead }) => {
    const followed = []
    const historyEvents = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `FIRST_ENTRY_${'A'.repeat(1_200)}` }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: `SECOND_ENTRY_${'B'.repeat(1_200)}` }] } } },
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: 'NEWEST_TURN_VERBATIM' }], source: { kind: 'user' } } },
    ]
    const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 50_000 }) } } })
    ctx.logger = { warn: () => {}, info: () => {} }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 4_000 } }) }

    const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'small-provider/tiny', appliedModel: 'big-provider/large', segments: [] }
    const bigTools = withHeaderOverhead
      ? [{ name: 'heavy_tool', description: 'X'.repeat(5_500), parameters: { type: 'object', properties: {} } }]
      : []
    const derivedSystem = withHeaderOverhead
      ? [{ role: 'system', content: [{ type: 'text', text: 'S'.repeat(2_000) }] }]
      : []
    const session = {
      id: 's1',
      header: { cwd: '/tmp/team' },
      requestHeader: () => ({ config: { provider: 'big-provider', model: 'large' }, tools: bigTools }),
      deriveMessages: () => derivedSystem,
      toolHistory: () => [],
    }
    const agent = {
      id: 's1', session, status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const fresh = {
      id: 's2',
      session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
      status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const rt = {
      ctx,
      home: '/unused',
      config: {},
      state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
      warn: () => {},
      async save() {},
      async load() {},
      readOnly: () => undefined,
      botOf: id => rt.state.bots[id],
      roomOf: () => undefined,
      selfOf: () => 'b1',
      isMain: () => false,
      chatOf: () => 's1',
      sessionOfRoom: () => undefined,
      isBotSession: id => ['s1', 's2'].includes(id),
      isLocalAgentRef: () => false,
      isLocalAgentRoute: () => false,
      engineOf: ref => (String(ref).startsWith('small-provider/') ? 'small-engine' : 'big-engine'),
      engineOfBot: subject => (String(subject?.model).startsWith('small-provider/') ? 'small-engine' : 'big-engine'),
      engineNameOf: ref => ref,
      chatOwners: new Map([['s1', 'b1']]),
      groupOwners: new Map(),
      pastOwners: new Map(),
      roomOwners: new Map(),
      teamTools: [],
      live: new Map(),
      groupSessionsOf: () => [],
      unreadOf: () => [],
      eventsBackwards: async function* () {
        for (const event of [...historyEvents].reverse()) yield event
      },
      resolveAgent: async id => (id === 's2' ? fresh : agent),
      createSession: async () => 's2',
      desiredModel: async subject => subject.model,
      desiredEffort: async () => undefined,
      selectSessionModel: async () => {},
      applyPermission: async () => {},
      ensureCapabilities: async () => {},
      renewMemory: () => {},
      moveSchedules: async () => {},
      deliver: async () => {},
      teamFolder: () => '/tmp/team',
      workDirOf: () => '/tmp/team',
      isFolder: async () => true,
      roomProgress: new Map(),
    }
    partsInstall(rt)
    await rt.followEngine('b1')
    for (let i = 0; i < 100 && bot.sessionId !== 's2'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(bot.sessionId, 's2')
    return followed.map(m => m.content.map(b => b.text).join('')).join('\n')
  }

  const pkgLight = await runSwitch({ withHeaderOverhead: false })
  const pkgHeavy = await runSwitch({ withHeaderOverhead: true })
  assert.ok(pkgLight.includes('FIRST_ENTRY_'), 'without heavy header/system overhead, earlier history fits')
  assert.equal(pkgHeavy.includes('FIRST_ENTRY_'), false, 'session requestHeader tools + system prompt overhead must tighten availableBytes')
  assert.ok(pkgHeavy.includes('NEWEST_TURN_VERBATIM'), 'newest turn still survives verbatim')
})

test('adapter.js renderReplay truncates multi-byte CJK/emoji history safely and counts rendered tool-call bytes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-replay-utf8-'))
  const spawnedEngines = []
  const prompts = []
  const origPrompt = AcpEngine.prototype.prompt
  t.after(() => { AcpEngine.prototype.prompt = origPrompt })
  AcpEngine.prototype.prompt = function (session, blocks, opts) {
    prompts.push(blocks.map(block => block.text ?? '').join(''))
    return origPrompt.call(this, session, blocks, opts)
  }

  const adapter = new LocalAgentAdapter({
    rt: { warn: () => {} },
    customAgents: () => [{ id: 'fake', name: 'Fake', command: 'x', args: [] }],
    findExecutable: p => p,
    spawnEngine: (_kind, route, spec) => {
      const engine = new AcpEngine(route, { ...spec, command: process.execPath, args: [FIXTURE('fake-acp.mjs')] }, { findExecutable: p => p })
      spawnedEngines.push(engine)
      return engine
    },
    record: () => undefined,
    saveRecord: () => {},
    presetFor: () => 'workspace-write',
    cwdFor: async () => root,
    probeCwd: () => root,
    toolsFor: () => [],
  })
  t.after(async () => {
    const children = []
    for (const engine of spawnedEngines) {
      if (engine.child) children.push(engine.child)
      for (const session of engine.sessions?.values?.() ?? []) {
        if (session?.child) children.push(session.child)
      }
    }
    const exits = children.map(child => (child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
        const done = () => { child.off('exit', done); child.off('close', done); resolve() }
        child.once('exit', done)
        child.once('close', done)
      })))
    try {
      await adapter.dispose()
      let timer
      try {
        await Promise.race([
          Promise.all(exits),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 3_000)
            timer.unref?.()
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 })
    }
  })

  const messages = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '🚀'.repeat(1_200) }], source: { kind: 'user' } },
    { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '中文'.repeat(1_200) }] },
    { id: 'm3', role: 'user', content: [{ type: 'text', text: 'LATEST_CURRENT_INPUT_中文_🎉' }], source: { kind: 'user' } },
  ]
  const seen = []
  for await (const chunk of adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's1', messages, tools: [] })) seen.push(chunk.type)
  assert.ok(seen.includes('finish'))
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].includes('LATEST_CURRENT_INPUT_中文_🎉'))
  assert.equal(hasBrokenSurrogates(prompts[0]), false)
  assert.equal(prompts[0].includes('\uFFFD'), false)

  // Pure tool-call historical messages must count their rendered `[tool: ...]` bytes against REPLAY_BYTES (24 KiB)
  const toolHeavyMessages = []
  for (let i = 0; i < 20; i += 1) {
    toolHeavyMessages.push({
      id: `tc-${i}`,
      role: 'assistant',
      content: Array.from({ length: 18 }, (_, j) => ({
        type: 'tool-call',
        name: 'read_file',
        arguments: { path: `/workspace/dir-${i}/segment-${j}/${'x'.repeat(80)}.js` },
      })),
    })
  }
  toolHeavyMessages.push({ id: 'latest-u', role: 'user', content: [{ type: 'text', text: 'CURRENT_AFTER_TOOLS' }], source: { kind: 'user' } })
  const seen2 = []
  for await (const chunk of adapter.stream({ provider: 'local-acp-fake', model: 'default', sessionId: 's2', messages: toolHeavyMessages, tools: [] })) seen2.push(chunk.type)
  assert.ok(seen2.includes('finish'))
  assert.equal(prompts.length, 2)
  assert.ok(prompts[1].includes('CURRENT_AFTER_TOOLS'))
  // 20 * ~2000 bytes would be ~40 KiB if pure tool-call messages were counted as 5 bytes each;
  // with rendered entry byte accounting, historical replay stays strictly bounded near REPLAY_BYTES (24 KiB).
  assert.ok(utf8Bytes(prompts[1]) < 26 * 1024, `expected bounded replay under 26 KiB, got ${utf8Bytes(prompts[1])} bytes`)
  assert.equal(prompts[1].includes('/dir-0/'), false, 'oldest pure tool-call message must be evicted by REPLAY_BYTES')
})

test('parts.js overflow handoff preserves initiating user request and attachments verbatim after interim assistant output and tool calls', async () => {
  const runOverflow = async ({ targetWindowTokens }) => {
    const followed = []
    // Long multi-byte comparison request (~2,400 chars, ~6.7 KiB UTF-8) with an image attachment.
    const longRequest = `INITIATING_START_比较两份报告: ${'核心对比指标_'.repeat(320)} INITIATING_END_完整保留_🚀`
    const historyEvents = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `OLDER_TURN_1_${'旧'.repeat(500)}` }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: `OLDER_REPLY_1_${'史'.repeat(500)}` }] } } },
      {
        type: 'user/message',
        seq: 3,
        time: 3,
        data: {
          content: [
            { type: 'text', text: longRequest },
            { type: 'image', attachment: { attachmentId: 'report-chart-1' } },
          ],
          source: { kind: 'user' },
        },
      },
      { type: 'assistant/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: "I'll check both reports." }] } } },
      { type: 'tool/call', seq: 5, time: 5, data: { callId: 'c1', name: 'read_file', arguments: { path: '/workspace/report-a.md' } } },
      { type: 'tool/result', seq: 6, time: 6, data: { message: { toolCallId: 'c1', ok: true, content: [{ type: 'text', text: 'R'.repeat(20_000) }] } } },
    ]
    const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 50_000 }) } } })
    ctx.logger = { warn: () => {}, info: () => {} }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    ctx.llm = {
      resolveModelInfo: async () => ({ context: { contextWindow: targetWindowTokens } }),
    }

    const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'provider/small', segments: [] }
    const session = {
      id: 's1',
      header: { cwd: '/tmp/team' },
      requestHeader: () => ({ config: { provider: 'provider', model: 'small' } }),
      deriveMessages: () => [],
      toolHistory: () => [],
    }
    const agent = {
      id: 's1', session, status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const fresh = {
      id: 's2',
      session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
      status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const live = new Map()
    const rt = {
      ctx,
      home: '/unused',
      config: {},
      state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
      warn: () => {},
      async save() {},
      async load() {},
      readOnly: () => undefined,
      botOf: id => rt.state.bots[id],
      roomOf: () => undefined,
      selfOf: () => 'b1',
      isMain: () => false,
      chatOf: () => 's1',
      sessionOfRoom: () => undefined,
      isBotSession: id => ['s1', 's2'].includes(id),
      isLocalAgentRef: () => false,
      isLocalAgentRoute: () => false,
      chatOwners: new Map([['s1', 'b1']]),
      groupOwners: new Map(),
      pastOwners: new Map(),
      roomOwners: new Map(),
      teamTools: [],
      live,
      liveOf: id => {
        let entry = live.get(id)
        if (entry === undefined) { entry = { joined: [] }; live.set(id, entry) }
        return entry
      },
      groupSessionsOf: () => [],
      unreadOf: () => [],
      eventsBackwards: async function* (_sid, _sig, _pages, scan) {
        for (const event of [...historyEvents].reverse()) yield event
        if (scan) scan.complete = true
      },
      resolveAgent: async id => (id === 's2' ? fresh : agent),
      createSession: async () => 's2',
      desiredModel: async subject => subject.model,
      desiredEffort: async () => undefined,
      selectSessionModel: async () => {},
      applyPermission: async () => {},
      ensureCapabilities: async () => {},
      renewMemory: () => {},
      moveSchedules: async () => {},
      deliver: async () => {},
      teamFolder: () => '/tmp/team',
      workDirOf: () => '/tmp/team',
      isFolder: async () => true,
      roomProgress: new Map(),
    }

    partsInstall(rt)
    const reqErrListeners = ctx.listeners.get('agent/request-error') ?? []
    const payload = {
      agent,
      failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' },
    }
    const dispatch = i => (i < reqErrListeners.length ? reqErrListeners[i](payload, () => dispatch(i + 1)) : Promise.resolve(undefined))
    await dispatch(0)
    for (let i = 0; i < 100 && bot.sessionId !== 's2'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(bot.sessionId, 's2')
    return followed.map(m => m.content.map(b => b.text).join('')).join('\n')
  }

  // 1. Extreme budget (availableBytes === 0): initiating request survives completely verbatim;
  // older history is evicted rather than dropping the active request.
  const pkgZeroBudget = await runOverflow({ targetWindowTokens: 2_500 })
  assert.ok(pkgZeroBudget.includes('INITIATING_START_比较两份报告'), 'initiating request head must survive at 0 history budget')
  assert.ok(pkgZeroBudget.includes('INITIATING_END_完整保留_🚀'), 'initiating request tail must survive intact at 0 history budget')
  assert.equal(pkgZeroBudget.includes('OLDER_TURN_1_'), false, 'older history must be evicted first')
  assert.equal(pkgZeroBudget.includes('OLDER_REPLY_1_'), false, 'older assistant reply must be evicted first')
  assert.equal(hasBrokenSurrogates(pkgZeroBudget), false)

  // 2. Tight budget with room for the interim assistant reply (~50 bytes) but not old turns:
  // both initiating request and interim reply survive in chronological order, while old turns are evicted.
  const pkgTightWithInterim = await runOverflow({ targetWindowTokens: 4_500 })
  assert.ok(pkgTightWithInterim.includes('INITIATING_START_比较两份报告'))
  assert.ok(pkgTightWithInterim.includes('INITIATING_END_完整保留_🚀'))
  assert.ok(pkgTightWithInterim.includes("I'll check both reports."), 'interim reply survives when budget allows')
  assert.ok(
    pkgTightWithInterim.indexOf('INITIATING_END_完整保留_🚀') < pkgTightWithInterim.indexOf("I'll check both reports."),
    'initiating user request must precede interim assistant reply chronologically',
  )
  assert.equal(pkgTightWithInterim.includes('OLDER_TURN_1_'), false, 'older turn evicted before interim reply')
})

test('parts.js folder switch writes handoff summary note when destination byte budget trims history, and skips note only when all messages fit', async () => {
  const NOTE_SECTIONS = ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look']
  const fakeNote = NOTE_SECTIONS.map(name => `## ${name}\n- FOLDER_SUMMARY_MARKER`).join('\n\n')
  function* noteChunks(text) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const runFolderSwitch = async ({ contextWindow, withOverhead }) => {
    const followed = []
    let noteCalls = 0
    // Short chat (~900 tokens total): easily fits preliminary RECENT_TOKENS (4,000 / 4 = 1,000+)
    // and has zero tool messages, so preliminary `carried.whole` is true.
    const historyEvents = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `FIRST_FOLDER_MSG_${'A'.repeat(1_200)}` }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: `SECOND_FOLDER_MSG_${'B'.repeat(1_200)}` }] } } },
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: 'LATEST_FOLDER_MSG' }], source: { kind: 'user' } } },
    ]
    const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 1_200 }) } } })
    ctx.logger = { warn: () => {}, info: () => {} }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    ctx.llm = {
      resolveModelInfo: async () => ({ context: { contextWindow }, defaultMaxTokens: 1_024 }),
      stream: () => {
        noteCalls += 1
        return noteChunks(fakeNote)
      },
    }

    const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'provider/model', segments: [] }
    const heavyTools = withOverhead
      ? [{ name: 'heavy_tool', description: 'T'.repeat(4_500), parameters: { type: 'object', properties: {} } }]
      : []
    const derivedMessages = withOverhead
      ? [{ role: 'system', content: [{ type: 'text', text: 'S'.repeat(2_000) }] }]
      : []
    const queuedInput = withOverhead
      ? [{ id: 'q1', role: 'user', content: [{ type: 'text', text: `QUEUED_${'Q'.repeat(1_500)}` }], source: { kind: 'user' } }]
      : []
    const session = {
      id: 's1',
      header: { cwd: '/tmp/old-folder' },
      requestHeader: () => ({ config: { provider: 'provider', model: 'model' }, tools: heavyTools }),
      deriveMessages: () => derivedMessages,
      toolHistory: () => [],
    }
    const agent = {
      id: 's1', session, status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: {
        nextStep: [],
        nextTurn: [...queuedInput],
        remove: (id) => {
          const idx = agent.inbox.nextTurn.findIndex(m => m.id === id)
          if (idx !== -1) agent.inbox.nextTurn.splice(idx, 1)
        },
      },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const fresh = {
      id: 's2',
      session: { id: 's2', header: { cwd: '/tmp/new-folder' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
      status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const rt = {
      ctx,
      home: '/unused',
      config: {},
      state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
      warn: () => {},
      async save() {},
      async load() {},
      readOnly: () => undefined,
      botOf: id => rt.state.bots[id],
      roomOf: () => undefined,
      selfOf: () => 'b1',
      isMain: () => false,
      chatOf: () => 's1',
      sessionOfRoom: () => undefined,
      isBotSession: id => ['s1', 's2'].includes(id),
      isLocalAgentRef: () => false,
      isLocalAgentRoute: () => false,
      chatOwners: new Map([['s1', 'b1']]),
      groupOwners: new Map(),
      pastOwners: new Map(),
      roomOwners: new Map(),
      teamTools: [],
      live: new Map(),
      groupSessionsOf: () => [],
      unreadOf: () => [],
      eventsBackwards: async function* (_sid, _sig, _pages, scan) {
        for (const event of [...historyEvents].reverse()) yield event
        if (scan) scan.complete = true
      },
      resolveAgent: async id => (id === 's2' ? fresh : agent),
      createSession: async () => 's2',
      desiredModel: async subject => subject.model,
      desiredEffort: async () => undefined,
      selectSessionModel: async () => {},
      applyPermission: async () => {},
      ensureCapabilities: async () => {},
      renewMemory: () => {},
      moveSchedules: async () => {},
      deliver: async () => {},
      teamFolder: () => '/tmp/old-folder',
      workDirOf: () => '/tmp/new-folder',
      isFolder: async () => true,
      roomProgress: new Map(),
    }

    partsInstall(rt)
    await rt.followFolder({ botId: 'b1' })
    for (let i = 0; i < 100 && bot.sessionId !== 's2'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(bot.sessionId, 's2')
    return {
      noteCalls,
      segment: bot.segments[0],
      pkg: followed.map(m => m.content.map(b => b.text).join('')).join('\n'),
    }
  }

  // 1. Small-window model where preliminary history fits, but instructions + queued input + work reserve
  // cause applyHandoffBudget to drop older messages: must NOT skip writing the summary note.
  const trimmed = await runFolderSwitch({ contextWindow: 4_000, withOverhead: true })
  assert.equal(trimmed.noteCalls, 1, 'folder change with byte-trimmed history must write a summary note')
  assert.equal(trimmed.segment.fallback, undefined, 'persisted segment must not record fallback=whole')
  assert.ok(trimmed.segment.note?.includes('FOLDER_SUMMARY_MARKER'), 'written summary note must be persisted')
  assert.ok(trimmed.pkg.includes('FOLDER_SUMMARY_MARKER'), 'handoff package must carry the written summary note')
  assert.equal(trimmed.pkg.includes('every message of the part was carried over word for word'), false, 'noteText must not falsely claim whole-part carry')
  assert.equal(trimmed.pkg.includes('FIRST_FOLDER_MSG_'), false, 'older message was indeed dropped by destination byte budget')
  assert.ok(trimmed.pkg.includes('LATEST_FOLDER_MSG'), 'latest message survives verbatim')

  // 2. Positive control: when all messages genuinely survive applyHandoffBudget with no tool work,
  // folder change still takes the note-free whole fast path.
  const whole = await runFolderSwitch({ contextWindow: 64_000, withOverhead: false })
  assert.equal(whole.noteCalls, 0, 'untrimmed folder change with no tool work skips note writing')
  assert.equal(whole.segment.fallback, 'whole')
  assert.ok(whole.pkg.includes('every message of the part was carried over word for word'))
  assert.ok(whole.pkg.includes('FIRST_FOLDER_MSG_'))
  assert.ok(whole.pkg.includes('LATEST_FOLDER_MSG'))
})

test('parts.js idle engine switch preserves the latest completed reply and does not reserve budget for unforwarded historical photos', async () => {
  const runIdleSwitch = async ({ historyEvents, targetWindowTokens }) => {
    const followed = []
    const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 800 }) } } })
    ctx.logger = { warn: () => {}, info: () => {} }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    ctx.llm = {
      resolveModelInfo: async () => ({ context: { contextWindow: targetWindowTokens } }),
    }
    const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'small-provider/small', segments: [] }
    const session = {
      id: 's1',
      header: { cwd: '/tmp/team' },
      requestHeader: () => ({ config: { provider: 'big-provider', model: 'big' } }),
      deriveMessages: () => [],
      toolHistory: () => [],
    }
    const agent = {
      id: 's1', session, status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const fresh = {
      id: 's2',
      session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
      status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const rt = {
      ctx,
      home: '/unused',
      config: {},
      state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
      warn: () => {},
      async save() {},
      async load() {},
      readOnly: () => undefined,
      botOf: id => rt.state.bots[id],
      roomOf: () => undefined,
      selfOf: () => 'b1',
      isMain: () => false,
      chatOf: () => 's1',
      sessionOfRoom: () => undefined,
      isBotSession: id => ['s1', 's2'].includes(id),
      isLocalAgentRef: () => false,
      isLocalAgentRoute: () => false,
      engineOf: ref => (String(ref).startsWith('small-provider/') ? 'small-engine' : 'big-engine'),
      engineOfBot: subject => (String(subject?.model).startsWith('small-provider/') ? 'small-engine' : 'big-engine'),
      engineNameOf: ref => ref,
      chatOwners: new Map([['s1', 'b1']]),
      groupOwners: new Map(),
      pastOwners: new Map(),
      roomOwners: new Map(),
      teamTools: [],
      live: new Map(),
      groupSessionsOf: () => [],
      unreadOf: () => [],
      eventsBackwards: async function* (_sid, _sig, _pages, scan) {
        for (const event of [...historyEvents].reverse()) yield event
        if (scan) scan.complete = true
      },
      resolveAgent: async id => (id === 's2' ? fresh : agent),
      createSession: async () => 's2',
      desiredModel: async subject => subject.model,
      desiredEffort: async () => undefined,
      selectSessionModel: async () => {},
      applyPermission: async () => {},
      ensureCapabilities: async () => {},
      renewMemory: () => {},
      moveSchedules: async () => {},
      deliver: async () => {},
      teamFolder: () => '/tmp/team',
      workDirOf: () => '/tmp/team',
      isFolder: async () => true,
      roomProgress: new Map(),
    }
    partsInstall(rt)
    await rt.followEngine('b1')
    for (let i = 0; i < 100 && bot.sessionId !== 's2'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(bot.sessionId, 's2')
    return followed.map(m => m.content.map(b => b.text).join('')).join('\n')
  }

  // 1. Idle switch under zero remaining history budget must preserve the latest completed reply.
  const idlePkg = await runIdleSwitch({
    targetWindowTokens: 1_500,
    historyEvents: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `REQUEST_FOR_REPORT_${'X'.repeat(2_000)}` }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'FINAL_COMPLETED_REPORT_42' }] } } },
    ],
  })
  assert.ok(idlePkg.includes('FINAL_COMPLETED_REPORT_42'), 'idle switch must preserve the newest completed reply even at 0 history budget')

  // 2. Historical request containing multiple photos does not subtract 4 KiB per photo from
  // availableBytes because moveOn sends history as a text block without forwarding old images.
  const photoEvents = [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `PRIOR_CONTEXT_${'H'.repeat(800)}` }], source: { kind: 'user' } } },
    {
      type: 'user/message',
      seq: 2,
      time: 2,
      data: {
        content: [
          { type: 'text', text: 'LOOK_AT_PHOTOS' },
          { type: 'image', attachment: { attachmentId: 'img-1' } },
          { type: 'image', attachment: { attachmentId: 'img-2' } },
        ],
        source: { kind: 'user' },
      },
    },
  ]
  const photoPkg = await runIdleSwitch({ targetWindowTokens: 3_000, historyEvents: photoEvents })
  assert.ok(photoPkg.includes('LOOK_AT_PHOTOS'))
  assert.ok(photoPkg.includes('PRIOR_CONTEXT_'), 'unforwarded historical photos must not consume 4 KiB each and evict fitting history')
})
