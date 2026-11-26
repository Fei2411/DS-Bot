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

test('parts.js canMakeRoom uses idle mode on first-step rollover and idle group switch preserves latest request+reply pair', async () => {
  // 1. First-step pre-step check (`step: 1`, non-carried) must run `canMakeRoom` with
  // `activeTurn: false` (protecting the latest completed reply, matching `moveOn`),
  // while mid-turn (`step: 2`) uses `activeTurn: true` (protecting the initiating request):
  // on an 8,192-token model (usable = 6,144, hard = 5,836) with 4,500 system tokens,
  // 400 prior handoff tokens, 10-token request, 950-token reply (total = 5,860 >= 5,836),
  // and 800-token queued prompt, `step: 1` must reject rollover (4,500 + ~1,900 > 6,144)
  // whereas `step: 2` approves rollover (evicting the reply -> 4,500 + ~960 <= 6,144).
  const runPreStep = async ({ step }) => {
    let created = 0
    let historyReads = 0
    const largeReply = `LARGE_FINAL_REPLY_${'R'.repeat(3_800)}`
    const queuedPrompt = `LARGE_QUEUED_PROMPT_${'P'.repeat(3_200)}`
    const historyEvents = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'Short request' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: largeReply }] } } },
    ]
    const derived = [
      { role: 'system', content: [{ type: 'text', text: 'S'.repeat(18_000) }] },
      { role: 'user', content: [{ type: 'text', text: 'prior handoff' }], source: { handoff: true } },
      { role: 'user', content: [{ type: 'text', text: 'Short request' }], source: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'text', text: largeReply }] },
    ]
    const estimateMessage = (message) => {
      const text = (message?.content ?? []).map(b => b.text ?? '').join('')
      return Math.ceil(text.length / 4)
    }
    const ctx = fakeContext({
      services: {
        tokenMeter: {
          estimateMessage,
          measure: () => ({
            totalTokens: 4_500 + 400 + 10 + 950,
            nodes: [
              { seq: 1, tokens: 4_500 },
              { seq: 2, tokens: 400 },
              { seq: 3, tokens: 10 },
              { seq: 4, tokens: 950 },
            ],
          }),
        },
      },
    })
    ctx.logger = { warn: () => {}, info: () => {} }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    ctx.llm = {
      resolveModelInfo: async () => ({ context: { contextWindow: 8_192 }, defaultMaxTokens: 2_048 }),
    }
    const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'provider/small', segments: [] }
    const session = {
      id: 's1',
      header: { cwd: '/tmp/team' },
      requestHeader: () => ({ config: { provider: 'provider', model: 'small' } }),
      deriveMessages: () => derived,
      eventAt: seq => ({ type: seq === 1 ? 'system/message' : 'user/message' }),
      toolHistory: () => [],
    }
    const agent = {
      id: 's1', session, status: 'running',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: () => {},
      send: async () => {},
    }
    const fresh = {
      id: 's2',
      session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
      status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: () => {},
      send: async () => {},
    }
    const live = new Map()
    const rt = {
      ctx, home: '/unused', config: {},
      state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
      warn: () => {}, async save() {}, async load() {}, readOnly: () => undefined,
      botOf: id => rt.state.bots[id], roomOf: () => undefined, selfOf: () => 'b1',
      isMain: () => false, chatOf: () => 's1', sessionOfRoom: () => undefined,
      isBotSession: id => ['s1', 's2'].includes(id), isLocalAgentRef: () => false, isLocalAgentRoute: () => false,
      chatOwners: new Map([['s1', 'b1']]), groupOwners: new Map(), pastOwners: new Map(), roomOwners: new Map(),
      teamTools: [], live,
      liveOf: id => {
        let entry = live.get(id)
        if (entry === undefined) { entry = { joined: [] }; live.set(id, entry) }
        return entry
      },
      groupSessionsOf: () => [], unreadOf: () => [],
      eventsBackwards: async function* (_sid, _sig, _pages, scan) {
        historyReads += 1
        for (const event of [...historyEvents].reverse()) yield event
        if (scan) scan.complete = true
      },
      resolveAgent: async id => (id === 's2' ? fresh : agent),
      createSession: async () => { created += 1; return 's2' },
      desiredModel: async subject => subject.model,
      desiredEffort: async () => undefined,
      selectSessionModel: async () => {}, applyPermission: async () => {}, ensureCapabilities: async () => {},
      renewMemory: () => {}, moveSchedules: async () => {}, deliver: async () => {},
      teamFolder: () => '/tmp/team', workDirOf: () => '/tmp/team', isFolder: async () => true,
      roomProgress: new Map(),
    }
    partsInstall(rt)
    const preStepListeners = ctx.listeners.get('agent/pre-step') ?? []
    let nextCalled = false
    const payload = {
      agent,
      step,
      messages: [{ role: 'user', content: [{ type: 'text', text: queuedPrompt }], source: { kind: 'user' } }],
      modelSelection: { provider: 'provider', model: 'small' },
      signal: AbortSignal.timeout(5_000),
    }
    const dispatch = i => (i < preStepListeners.length
      ? preStepListeners[i](payload, () => dispatch(i + 1))
      : Promise.resolve((nextCalled = true)))
    await dispatch(0)
    if (!nextCalled) {
      for (let i = 0; i < 100 && created === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
    }
    return { nextCalled, created, historyReads }
  }
  const firstStep = await runPreStep({ step: 1 })
  assert.ok(firstStep.historyReads >= 1, 'pre-step must actually invoke canMakeRoom (totalTokens >= hard)')
  assert.equal(firstStep.nextCalled, true, 'first-step preflight must reject rollover when protecting last reply exceeds usable limit')
  assert.equal(firstStep.created, 0, 'no fresh session should be created when canMakeRoom returns false')

  const midTurnStep = await runPreStep({ step: 2 })
  assert.ok(midTurnStep.historyReads >= 1)
  assert.equal(midTurnStep.nextCalled, false, 'mid-turn preflight (activeTurn: true) approves rollover by trimming interim reply')
  assert.equal(midTurnStep.created, 1)

  // 2. Idle group run-mode switch from a small source model (source scan budget ~1,200 tokens)
  // to a larger destination model (32,000 tokens) must keep BOTH the 1,300-token group request
  // and its completed reply, even when an intermediate assistant message also appeared in that turn.
  {
    const followed = []
    const longGroupReq = `GROUP_REQUEST_START_${'群'.repeat(1_800)}_GROUP_REQUEST_END`
    const historyEvents = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'OLDER_GROUP_MSG' }], source: { kind: 'user' } } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: longGroupReq }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: `INTERIM_${'中'.repeat(1_400)}` }] } } },
      { type: 'assistant/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: 'Summary is ready.' }] } } },
    ]
    const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 1_500 }) } } })
    ctx.logger = { warn: () => {}, info: () => {} }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    ctx.llm = {
      resolveModelInfo: async (provider) => ({
        context: { contextWindow: provider === 'big-provider' ? 32_000 : 8_000 },
        defaultMaxTokens: 2_000,
      }),
    }
    const bot = { id: 'b1', name: 'Kai', sessionId: 'b1-main', model: 'big-provider/big', segments: [] }
    const room = { id: 'r1', name: 'Ops', members: ['b1'], sessions: { b1: 'g1' }, segments: {} }
    const session = {
      id: 'g1',
      header: { cwd: '/tmp/team' },
      requestHeader: () => ({ config: { provider: 'small-provider', model: 'small' } }),
      deriveMessages: () => [],
      toolHistory: () => [],
    }
    const agent = {
      id: 'g1', session, status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const fresh = {
      id: 'g2',
      session: { id: 'g2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
      status: 'idle',
      whenIdle: async () => {},
      runMaintenance: async job => job(AbortSignal.timeout(10_000)),
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const rt = {
      ctx, home: '/unused', config: {},
      state: { bots: { b1: bot }, rooms: { r1: room }, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {} },
      warn: () => {}, async save() {}, async load() {}, readOnly: () => undefined,
      botOf: id => rt.state.bots[id], roomOf: id => rt.state.rooms[id],
      selfOf: id => (id === 'g1' || id === 'g2' ? 'b1' : undefined),
      isMain: () => false, chatOf: () => 'b1-main', sessionOfRoom: () => undefined,
      isBotSession: id => ['g1', 'g2'].includes(id), isLocalAgentRef: () => false, isLocalAgentRoute: () => false,
      engineOf: ref => (String(ref).startsWith('big-provider/') ? 'big-engine' : 'small-engine'),
      engineOfBot: subject => (String(subject?.model).startsWith('big-provider/') ? 'big-engine' : 'small-engine'),
      engineNameOf: ref => ref,
      chatOwners: new Map(),
      groupOwners: new Map([['g1', { botId: 'b1', roomId: 'r1' }]]),
      pastOwners: new Map(), roomOwners: new Map(),
      teamTools: [], live: new Map(),
      groupSessionsOf: () => ['g1'], unreadOf: () => [],
      eventsBackwards: async function* (_sid, _sig, _pages, scan) {
        for (const event of [...historyEvents].reverse()) yield event
        if (scan) scan.complete = true
      },
      resolveAgent: async id => (id === 'g2' ? fresh : agent),
      createSession: async () => 'g2',
      desiredModel: async subject => subject.model,
      desiredEffort: async () => undefined,
      selectSessionModel: async () => {}, applyPermission: async () => {}, ensureCapabilities: async () => {},
      renewMemory: () => {}, moveSchedules: async () => {}, deliver: async () => {},
      teamFolder: () => '/tmp/team', workDirOf: () => '/tmp/team', isFolder: async () => true,
      roomProgress: new Map(),
    }
    partsInstall(rt)
    await rt.followEngine('b1')
    for (let i = 0; i < 100 && room.sessions.b1 !== 'g2'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(room.sessions.b1, 'g2')
    const pkg = followed.map(m => m.content.map(b => b.text).join('')).join('\n')
    assert.ok(pkg.includes('GROUP_REQUEST_START_'), 'idle group switch to larger route must carry the latest group request')
    assert.ok(pkg.includes('GROUP_REQUEST_END'), 'latest group request must survive verbatim')
    assert.ok(pkg.includes('Summary is ready.'), 'latest completed reply must survive alongside its request')
  }
})

test('parts.js runtime-lost recovery reserves budget for full unread request and attachments without duplicating it in handoff', async () => {
  const followed = []
  const sent = []
  const longUnread = `UNREAD_DOC_START_${'长文档内容片段_'.repeat(300)}_UNREAD_DOC_END`
  const unreadMessage = {
    id: 'msg-unread-1',
    role: 'user',
    content: [
      { type: 'text', text: longUnread },
      { type: 'image', attachment: { attachmentId: 'shot-1' } },
      { type: 'image', attachment: { attachmentId: 'shot-2' } },
    ],
    source: { kind: 'user' },
  }
  const historyEvents = [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `OLDER_HISTORY_${'旧'.repeat(400)}` }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: `OLDER_REPLY_${'答'.repeat(400)}` }] } } },
    { type: 'user/message', seq: 3, time: 3, data: { content: unreadMessage.content, source: { kind: 'user' } } },
  ]
  const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 4_000 }) } } })
  ctx.logger = { warn: () => {}, info: () => {} }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  // Tight 8k-token window: full unread request (~7.2 KiB) + 2 image allowances (2 * 6 KiB)
  // leaves 0 history bytes, so older history and clipped transcript copy must both be trimmed.
  ctx.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: 8_000 } }),
  }

  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'local-claude-code/default', segments: [] }
  const session = {
    id: 's1',
    header: { cwd: '/tmp/team' },
    requestHeader: () => ({ config: { provider: 'local-claude-code', model: 'default' } }),
    deriveMessages: () => [
      { id: 'msg-1', role: 'user', content: [{ type: 'text', text: 'older' }], source: { kind: 'user' } },
      { id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'older reply' }] },
      unreadMessage,
    ],
    toolHistory: () => [],
  }
  const agent = {
    id: 's1', session, status: 'idle',
    whenIdle: async () => {},
    runMaintenance: async job => job(AbortSignal.timeout(10_000)),
    inbox: { nextStep: [], nextTurn: [] },
    followup: message => followed.push({ to: 's1', message }),
    send: async message => sent.push({ to: 's1', message }),
  }
  const fresh = {
    id: 's2',
    session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
    status: 'idle',
    whenIdle: async () => {},
    runMaintenance: async job => job(AbortSignal.timeout(10_000)),
    inbox: { nextStep: [], nextTurn: [] },
    followup: message => followed.push({ to: 's2', message }),
    send: async message => sent.push({ to: 's2', message }),
  }
  const live = new Map()
  const rt = {
    ctx, home: '/unused', config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: {}, views: {}, localAgents: { sessions: { s1: { handedId: 'msg-2' } } } },
    warn: () => {}, async save() {}, async load() {}, readOnly: () => undefined,
    botOf: id => rt.state.bots[id], roomOf: () => undefined,
    selfOf: () => 'b1', isMain: () => false, chatOf: () => 's1', sessionOfRoom: () => undefined,
    isBotSession: id => ['s1', 's2'].includes(id),
    isLocalAgentRef: () => true, isLocalAgentRoute: () => true,
    chatOwners: new Map([['s1', 'b1']]), groupOwners: new Map(), pastOwners: new Map(), roomOwners: new Map(),
    teamTools: [], live,
    liveOf: id => {
      let entry = live.get(id)
      if (entry === undefined) { entry = { joined: [] }; live.set(id, entry) }
      return entry
    },
    groupSessionsOf: () => [], unreadOf: () => [],
    eventsBackwards: async function* (_sid, _sig, _pages, scan) {
      for (const event of [...historyEvents].reverse()) yield event
      if (scan) scan.complete = true
    },
    resolveAgent: async id => (id === 's2' ? fresh : agent),
    createSession: async () => 's2',
    desiredModel: async subject => subject.model,
    desiredEffort: async () => undefined,
    selectSessionModel: async () => {}, applyPermission: async () => {}, ensureCapabilities: async () => {},
    renewMemory: () => {}, moveSchedules: async () => {}, deliver: async () => {},
    teamFolder: () => '/tmp/team', workDirOf: () => '/tmp/team', isFolder: async () => true,
    roomProgress: new Map(),
  }
  partsInstall(rt)

  const reqErrListeners = ctx.listeners.get('agent/request-error') ?? []
  const payload = {
    agent,
    failure: { code: 'LOCAL_AGENT_SESSION_LOST', message: 'no conversation found' },
  }
  const dispatch = i => (i < reqErrListeners.length ? reqErrListeners[i](payload, () => dispatch(i + 1)) : Promise.resolve(undefined))
  await dispatch(0)
  for (let i = 0; i < 100 && bot.sessionId !== 's2'; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(bot.sessionId, 's2')
  const handoffMsg = followed.find(entry => entry.to === 's2' && entry.message.source?.handoff === true)?.message
  assert.ok(handoffMsg !== undefined, 'fresh part must receive the handoff package')
  const handoffText = handoffMsg.content.map(b => b.text).join('')
  assert.equal(handoffText.includes('OLDER_HISTORY_'), false, 'older history must be dropped when full unread request + attachments fill the window')
  assert.equal(handoffText.includes('UNREAD_DOC_START_'), false, 'clipped transcript copy of unread request must not be pinned in handoff when original is forwarded')

  const forwarded = [...followed, ...sent].filter(entry => entry.to === 's2' && entry.message.source?.handoff !== true).map(entry => entry.message)
  assert.equal(forwarded.length, 1, 'unread request must be forwarded once to fresh part')
  assert.equal(forwarded[0].content[0].text, longUnread, 'forwarded unread request text must remain verbatim')
  assert.deepEqual(
    forwarded[0].content.filter(b => b.type === 'image').map(b => b.attachment.attachmentId),
    ['shot-1', 'shot-2'],
    'forwarded unread request must preserve all image attachments',
  )
})

test('parts.js crash recovery (ensureHandoffDelivered) enforces handoff budget, activeTurn preservation, and runtime-lost unread reservation', async () => {
  // 1. Overflow crash recovery: activeTurn=true + applyHandoffBudget trims older history while preserving initiating request.
  {
    const followed = []
    const initiating = `CRASH_INIT_START_${'关键需求说明_'.repeat(180)}_CRASH_INIT_END`
    const historyEvents = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `CRASH_OLD_1_${'旧'.repeat(500)}` }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: `CRASH_OLD_REPLY_${'答'.repeat(500)}` }] } } },
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: initiating }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: 'Working on it...' }] } } },
    ]
    const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 1_000 }) } } })
    ctx.logger = { warn: () => {}, info: () => {} }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 2_500 } }) }
    const bot = { id: 'b1', name: 'Kai', sessionId: 's2', model: 'provider/small', segments: [{ number: 1, sessionId: 's1', fallback: 'overflow', endedAt: 10 }, { number: 2, sessionId: 's2' }] }
    const oldAgent = {
      id: 's1',
      session: { id: 's1', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: { provider: 'provider', model: 'small' } }), deriveMessages: () => [], toolHistory: () => [] },
      inbox: { nextStep: [], nextTurn: [] },
    }
    const freshAgent = {
      id: 's2',
      session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: { provider: 'provider', model: 'small' } }), deriveMessages: () => [], toolHistory: () => [] },
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const rt = {
      ctx, home: '/unused', config: {},
      state: {
        bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, questions: {}, views: {},
        switching: {
          s1: { botId: 'b1', handoffPending: true, handoffMeta: { resume: true, overflow: true } },
        },
      },
      warn: () => {}, async save() {}, async load() {}, readOnly: () => undefined,
      botOf: id => rt.state.bots[id], roomOf: () => undefined,
      selfOf: () => 'b1', isMain: () => false, chatOf: () => 's2', sessionOfRoom: () => undefined,
      isBotSession: id => ['s1', 's2'].includes(id), isLocalAgentRef: () => false, isLocalAgentRoute: () => false,
      chatOwners: new Map([['s2', 'b1']]), groupOwners: new Map(), pastOwners: new Map([['s1', { botId: 'b1' }]]), roomOwners: new Map(),
      teamTools: [], live: new Map(), groupSessionsOf: () => [], unreadOf: () => [],
      eventsBackwards: async function* (_sid, _sig, _pages, scan) {
        for (const event of [...historyEvents].reverse()) yield event
        if (scan) scan.complete = true
      },
      resolveAgent: async id => (id === 's2' ? freshAgent : oldAgent),
      desiredModel: async subject => subject.model, desiredEffort: async () => undefined,
      ensureCapabilities: async () => {}, renewMemory: () => {}, moveSchedules: async () => {}, deliver: async () => {},
      teamFolder: () => '/tmp/team', workDirOf: () => '/tmp/team', isFolder: async () => true, roomProgress: new Map(),
    }
    partsInstall(rt)
    await rt.heldBack()
    assert.equal(rt.state.switching.s1, undefined, 'recovered switch entry must clear after handoff delivery')
    assert.equal(followed.length, 1)
    const text = followed[0].content.map(b => b.text).join('')
    assert.ok(text.includes('CRASH_INIT_START_') && text.includes('_CRASH_INIT_END'), 'crash recovery must preserve active initiating request verbatim')
    assert.equal(text.includes('CRASH_OLD_1_'), false, 'crash recovery must trim older history to fit destination budget')
  }

  // 2. Runtime-lost crash recovery: reserves budget for full unread request + attachments without pinning clipped duplicate.
  {
    const followed = []
    const sent = []
    const longUnread = `CRASH_UNREAD_START_${'未读文档内容_'.repeat(300)}_CRASH_UNREAD_END`
    const unreadMessage = {
      id: 'msg-crash-unread',
      role: 'user',
      content: [
        { type: 'text', text: longUnread },
        { type: 'image', attachment: { attachmentId: 'crash-shot-1' } },
        { type: 'image', attachment: { attachmentId: 'crash-shot-2' } },
      ],
      source: { kind: 'user' },
    }
    const historyEvents = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `CRASH_RL_OLD_${'旧'.repeat(400)}` }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: `CRASH_RL_REPLY_${'答'.repeat(400)}` }] } } },
      { type: 'user/message', seq: 3, time: 3, data: { content: unreadMessage.content, source: { kind: 'user' } } },
    ]
    const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 4_000 }) } } })
    ctx.logger = { warn: () => {}, info: () => {} }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 8_000 } }) }
    const bot = { id: 'b1', name: 'Kai', sessionId: 's2', model: 'local-claude-code/default', segments: [{ number: 1, sessionId: 's1', fallback: 'runtime-lost', endedAt: 10 }, { number: 2, sessionId: 's2' }] }
    const oldAgent = {
      id: 's1',
      session: {
        id: 's1', header: { cwd: '/tmp/team' },
        requestHeader: () => ({ config: { provider: 'local-claude-code', model: 'default' } }),
        deriveMessages: () => [
          { id: 'm1', role: 'user', content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } },
          { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'old reply' }] },
          unreadMessage,
        ],
        toolHistory: () => [],
      },
      inbox: { nextStep: [], nextTurn: [] },
    }
    const freshAgent = {
      id: 's2',
      session: { id: 's2', header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: {} }), deriveMessages: () => [], toolHistory: () => [] },
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async message => sent.push(message),
    }
    const rt = {
      ctx, home: '/unused', config: {},
      state: {
        bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, questions: {}, views: {},
        localAgents: { sessions: { s1: { handedId: 'm2' } } },
        switching: {
          s1: { botId: 'b1', handoffPending: true, runtimeLost: true, handoffMeta: { resume: true, runtimeLost: true, runtimeLostHasUnread: true } },
        },
      },
      warn: () => {}, async save() {}, async load() {}, readOnly: () => undefined,
      botOf: id => rt.state.bots[id], roomOf: () => undefined,
      selfOf: () => 'b1', isMain: () => false, chatOf: () => 's2', sessionOfRoom: () => undefined,
      isBotSession: id => ['s1', 's2'].includes(id), isLocalAgentRef: () => true, isLocalAgentRoute: () => true,
      chatOwners: new Map([['s2', 'b1']]), groupOwners: new Map(), pastOwners: new Map([['s1', { botId: 'b1' }]]), roomOwners: new Map(),
      teamTools: [], live: new Map(), groupSessionsOf: () => [], unreadOf: () => [],
      eventsBackwards: async function* (_sid, _sig, _pages, scan) {
        for (const event of [...historyEvents].reverse()) yield event
        if (scan) scan.complete = true
      },
      resolveAgent: async id => (id === 's2' ? freshAgent : oldAgent),
      desiredModel: async subject => subject.model, desiredEffort: async () => undefined,
      ensureCapabilities: async () => {}, renewMemory: () => {}, moveSchedules: async () => {}, deliver: async () => {},
      teamFolder: () => '/tmp/team', workDirOf: () => '/tmp/team', isFolder: async () => true, roomProgress: new Map(),
    }
    partsInstall(rt)
    await rt.heldBack()
    const handoffMsg = followed.find(m => m.source?.handoff === true)
    assert.ok(handoffMsg !== undefined, 'crash recovery must deliver budgeted handoff')
    const handoffText = handoffMsg.content.map(b => b.text).join('')
    assert.equal(handoffText.includes('CRASH_RL_OLD_'), false, 'older history must be dropped when full unread request + attachments fill window')
    assert.equal(handoffText.includes('CRASH_UNREAD_START_'), false, 'clipped transcript duplicate must not be pinned in recovered handoff')
    const forwarded = [...followed, ...sent].filter(m => m.source?.handoff !== true)
    assert.equal(forwarded.length, 1, 'unread request must still be forwarded verbatim during crash recovery')
    assert.equal(forwarded[0].content[0].text, longUnread)
    assert.deepEqual(forwarded[0].content.filter(b => b.type === 'image').map(b => b.attachment.attachmentId), ['crash-shot-1', 'crash-shot-2'])
  }

  // 3. Folder-switch crash recovery whose persisted segment had fallback:'whole' must
  // persist fallback:'trimmed' onto the stored bot.segments entry before saving.
  {
    const followed = []
    const savedFallbacks = []
    const historyEvents = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: `WHOLE_OLD_${'旧'.repeat(1200)}` }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: `WHOLE_MID_${'中'.repeat(1200)}` }] } } },
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: `WHOLE_REQ_${'新'.repeat(800)}` }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: `WHOLE_REPLY_${'答'.repeat(800)}` }] } } },
    ]
    const ctx = fakeContext({ services: { tokenMeter: { measure: () => ({ totalTokens: 1_000 }) } } })
    ctx.logger = { warn: () => {}, info: () => {} }
    ctx.sessions = { flush: async () => {} }
    ctx.workspaceRegistry = { archiveSession: async () => {} }
    ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 2_500 } }) }
    const bot = { id: 'b1', name: 'Kai', sessionId: 's2', model: 'provider/small', segments: [{ number: 1, sessionId: 's1', fallback: 'whole', endedAt: 10 }, { number: 2, sessionId: 's2' }] }
    const oldAgent = {
      id: 's1',
      session: { id: 's1', header: { cwd: '/tmp/old' }, requestHeader: () => ({ config: { provider: 'provider', model: 'small' } }), deriveMessages: () => [], toolHistory: () => [] },
      inbox: { nextStep: [], nextTurn: [] },
    }
    const freshAgent = {
      id: 's2',
      session: { id: 's2', header: { cwd: '/tmp/new' }, requestHeader: () => ({ config: { provider: 'provider', model: 'small' } }), deriveMessages: () => [], toolHistory: () => [] },
      inbox: { nextStep: [], nextTurn: [] },
      followup: message => followed.push(message),
      send: async () => {},
    }
    const rt = {
      ctx, home: '/unused', config: {},
      state: {
        bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, questions: {}, views: {},
        switching: {
          s1: { botId: 'b1', handoffPending: true, handoffMeta: { folder: true } },
        },
      },
      warn: () => {},
      async save() { savedFallbacks.push(bot.segments[0].fallback) },
      async load() {},
      readOnly: () => undefined,
      botOf: id => rt.state.bots[id], roomOf: () => undefined,
      selfOf: () => 'b1', isMain: () => false, chatOf: () => 's2', sessionOfRoom: () => undefined,
      isBotSession: id => ['s1', 's2'].includes(id), isLocalAgentRef: () => false, isLocalAgentRoute: () => false,
      chatOwners: new Map([['s2', 'b1']]), groupOwners: new Map(), pastOwners: new Map([['s1', { botId: 'b1' }]]), roomOwners: new Map(),
      teamTools: [], live: new Map(), groupSessionsOf: () => [], unreadOf: () => [],
      eventsBackwards: async function* (_sid, _sig, _pages, scan) {
        for (const event of [...historyEvents].reverse()) yield event
        if (scan) scan.complete = true
      },
      resolveAgent: async id => (id === 's2' ? freshAgent : oldAgent),
      desiredModel: async subject => subject.model, desiredEffort: async () => undefined,
      ensureCapabilities: async () => {}, renewMemory: () => {}, moveSchedules: async () => {}, deliver: async () => {},
      teamFolder: () => '/tmp/team', workDirOf: () => '/tmp/new', isFolder: async () => true, roomProgress: new Map(),
    }
    partsInstall(rt)
    await rt.heldBack()
    assert.equal(bot.segments[0].fallback, 'trimmed', 'persisted bot.segments entry must downgrade from whole to trimmed when recovery trims history')
    assert.ok(savedFallbacks.includes('trimmed'), 'rt.save() must persist the downgraded fallback')
    assert.equal(followed.length, 1)
    const text = followed[0].content.map(b => b.text).join('')
    assert.ok(text.includes('trimmed to fit'), 'delivered handoff note must reflect trimmed fallback')
  }
})
