import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as imagesInstall, offloadTargets } from '../src/host/images.js'
import { assembleLlmStream } from '../src/host/models.js'

test('offloadTargets selects live images from prior user and tool messages', () => {
  const events = [
    { type: 'user/message' },
    { type: 'assistant/message' },
    { type: 'tool/result' },
    { type: 'user/message' },
    { type: 'user/message' },
  ]
  const messages = new Map([
    [events[0], { content: [
      { type: 'image', attachment: { attachmentId: 'a' } },
      { type: 'image', offloaded: true, attachment: { attachmentId: 'b' } },
      { type: 'image', attachment: { attachmentId: 'c' } },
    ] }],
    [events[1], { content: [{ type: 'image', attachment: { attachmentId: 'ignored' } }] }],
    [events[2], { content: [{ type: 'image', attachment: { attachmentId: 'd' } }] }],
    [events[3], { content: [{ type: 'text', text: 'no image' }] }],
    [events[4], { content: [{ type: 'image', attachment: { attachmentId: 'new' } }] }],
  ])
  const session = {
    surface: { nodes: [0, 1, 2, 3, 4] },
    eventAt: seq => events[seq],
    deriveEventMessage: event => messages.get(event),
  }

  assert.deepEqual(offloadTargets(session, 4), [
    { seq: 0, imageIndexes: [0, 2] },
    { seq: 2, imageIndexes: [0] },
  ])
})

test('image OCR retries transient TRANSPORT failures instead of caching a 2-minute failure', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-images-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let calls = 0
  const ctx = {
    on: () => () => {},
    llm: {
      providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 2, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
      async *stream() {
        calls += 1
        if (calls === 1) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'Image: Retry banner.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const rt = {
    ctx,
    config: {},
    home,
    warn: () => {},
    catalog: async () => [{ ref: 'deepseek-account/deepseek-flash', name: 'DeepSeek-V4.1-Flash', input: ['text', 'image'] }],
    defaultRef: () => 'deepseek-account/deepseek-flash',
    isLocalAgentRef: () => false,
    ownRequest: () => false,
    tagUsage: messages => messages,
  }
  imagesInstall(rt)
  const [line] = await rt.imagesForGroup([{ attachmentId: 'sha256:abcdef1234567890', name: 'shot.png' }], 'g1')
  assert.equal(calls, 2)
  assert.match(line, /Image: Retry banner\./)
})

test('imagesForGroup stays neutral when no OCR model is available, while text-only members still receive the fallback warning', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-images-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const hooks = new Map()
  const sent = []
  const ctx = {
    on: (name, fn) => { hooks.set(name, fn); return () => hooks.delete(name) },
    get: name => (name === 'attachments' ? { imageHostPath: () => '/tmp/shot.png' } : undefined),
    llm: {
      resolveModelInfo: async (_provider, model) => ({
        inputModalities: model === 'text-only' ? ['text'] : ['text', 'image'],
      }),
      async *stream(options) {
        sent.push(options)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const rt = {
    ctx,
    config: {},
    home,
    load: async () => {},
    warn: () => {},
    roomOf: () => undefined,
    catalog: async () => [
      { ref: 'deepseek/text-only', name: 'TextOnly', input: ['text'] },
      { ref: 'local-claude-code/sonnet', name: 'Claude', input: ['text', 'image'] },
    ],
    defaultRef: () => 'deepseek/text-only',
    isLocalAgentRef: ref => typeof ref === 'string' && ref.startsWith('local-'),
    ownRequest: () => false,
    tagUsage: messages => messages,
  }
  imagesInstall(rt)

  const attachment = { attachmentId: 'sha256:1234567890abcdef', name: 'shot.png' }
  const [groupLine] = await rt.imagesForGroup([attachment], 'r1')
  assert.equal(groupLine, '[Image "shot.png" (read-only copy saved at "/tmp/shot.png") attached]')
  assert.doesNotMatch(groupLine, /could not be read|Ask the user/i)

  const streamHook = hooks.get('llm/stream')
  const msg = { role: 'user', content: [{ type: 'text', text: groupLine }, { type: 'image', attachment }] }
  // Vision member passes straight through with the raw image block intact.
  let passedVision = false
  const visionChunks = []
  for await (const chunk of streamHook({ sessionId: 'm1', provider: 'local-claude-code', model: 'sonnet', messages: [msg] }, async function* () {
    passedVision = true
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) visionChunks.push(chunk)
  assert.equal(passedVision, true)
  assert.equal(visionChunks.length, 1)

  // Text-only member rewrites the raw image block into an explicit "you cannot see images" fallback.
  const textChunks = []
  for await (const chunk of streamHook({ sessionId: 'm2', provider: 'deepseek', model: 'text-only', messages: [msg] }, async function* () {})) textChunks.push(chunk)
  assert.equal(textChunks.length, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].messages[0].content[1].type, 'text')
  assert.match(sent[0].messages[0].content[1].text, /you cannot see images and it could not be read right now/i)
})

test('assembleLlmStream forwards lifetime disposal signal to in-flight streams and stops on disabled retry policies', async () => {
  const lifetime = new AbortController()
  let seenSignal
  const streaming = assembleLlmStream({
    llm: {
      async *stream(options) {
        seenSignal = options.signal
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'disposed' } } }
      },
    },
  }, { provider: 'deepseek', model: 'v4', messages: [], signal: AbortSignal.timeout(60_000) }, { signal: lifetime.signal })
  lifetime.abort()
  const aborted = await streaming
  assert.equal(seenSignal.aborted, true)
  assert.equal(aborted.finish.kind, 'aborted')

  let disabledCalls = 0
  const disabled = await assembleLlmStream({
    llm: {
      providerRetryPolicy: () => ({ mode: 'disabled', initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
      async *stream() {
        disabledCalls += 1
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }
      },
    },
  }, { provider: 'deepseek', model: 'v4', messages: [] })
  assert.equal(disabledCalls, 1)
  assert.equal(disabled.finish.kind, 'error')
})


