import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as imagesInstall, offloadTargets } from '../src/host/images.js'

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

