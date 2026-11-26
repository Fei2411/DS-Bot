import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionComplete } from '../src/host/browser/session-model.js'

const header = {
  config: { provider: 'mock-provider', model: 'session-model', temperature: 0.25 },
  tools: [{ name: 'session-private-tool', description: 'not for browser_task', parameters: {} }],
}

function fixture(chunks, { attachments, inputModalities, textOnlyModels } = {}) {
  const requests = []
  const tags = []
  let modelInfoCalls = 0
  const ctx = {
    get: name => name === 'attachments' ? attachments : undefined,
    llm: {
      async *stream(request) {
        requests.push(request)
        yield* chunks
      },
      async resolveModelInfo() {
        modelInfoCalls += 1
        return { inputModalities }
      },
    },
  }
  const session = {
    id: 'session-browser-task',
    requestHeader: () => header,
  }
  const rt = {
    config: { textOnlyModels },
    tagUsage(messages, options) {
      tags.push(options)
      return messages
    },
  }
  return { ctx, exec: { agent: { session }, signal: new AbortController().signal }, rt, requests, tags, modelInfoCalls: () => modelInfoCalls }
}

const stop = { type: 'finish', reason: { kind: 'stop' } }

test('session completion converts DSH text to an OpenAI chat response', async () => {
  const setup = fixture([
    { type: 'text-delta', index: 0, text: 'The page title is Example.' },
    stop,
  ])
  const complete = sessionComplete(setup.ctx, setup.exec, setup.rt)
  const result = await complete({
    messages: [{ role: 'system', content: 'Use the browser.' }, { role: 'user', content: 'Read the title.' }],
    tools: [],
  })

  assert.equal(result.choices[0].message.content, 'The page title is Example.')
  assert.deepEqual(setup.tags, [{ sessionId: 'session-browser-task', kind: 'browser-task' }])
  assert.equal(setup.modelInfoCalls(), 0)
})

test('session completion preserves DSH tool-call identity, name, and JSON arguments', async () => {
  const setup = fixture([
    { type: 'tool-call-delta', index: 0, id: 'call-browser-1', name: 'browser_open', argumentsDelta: '{"url":"https://example.com"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await sessionComplete(setup.ctx, setup.exec, setup.rt)({
    messages: [{ role: 'user', content: 'Open example.com.' }],
    tools: [],
  })

  assert.deepEqual(result.choices[0].message.tool_calls, [{
    id: 'call-browser-1',
    type: 'function',
    function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' },
  }])
})

test('follow-up assistant tool call and tool result are converted to DSH messages', async () => {
  const setup = fixture([
    { type: 'text-delta', index: 0, text: 'Done.' },
    stop,
  ])
  const messages = [
    { role: 'system', content: 'Use browser tools.' },
    { role: 'user', content: 'Open the page.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-browser-2',
        type: 'function',
        function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-browser-2', content: 'Opened https://example.com' },
  ]
  const result = await sessionComplete(setup.ctx, setup.exec, setup.rt)({
    messages,
    tools: [{
      type: 'function',
      function: { name: 'browser_snapshot', description: 'Read page', parameters: { type: 'object' } },
    }],
  })

  assert.equal(result.choices[0].message.content, 'Done.')
  const request = setup.requests[0]
  assert.deepEqual(request.messages.map(message => message.role), ['system', 'user', 'assistant', 'tool'])
  assert.deepEqual(request.messages[2].content, [{
    type: 'tool-call',
    id: 'call-browser-2',
    name: 'browser_open',
    arguments: '{"url":"https://example.com"}',
  }])
  assert.equal(request.messages[3].toolCallId, 'call-browser-2')
  assert.deepEqual(request.messages[3].content, [{ type: 'text', text: 'Opened https://example.com' }])
  assert.deepEqual(request.tools, [{
    name: 'browser_snapshot',
    description: 'Read page',
    parameters: { type: 'object' },
  }])
  assert.equal(request.model, 'session-model')
  assert.equal(request.provider, 'mock-provider')
  assert.equal(request.sessionId, 'session-browser-task')
  assert.deepEqual(setup.tags, [{ sessionId: 'session-browser-task', kind: 'browser-task' }])
})

test('text-only model metadata omits screenshots before saving attachments', async () => {
  let saveCalls = 0
  const attachments = { async saveImages() { saveCalls += 1; return [] } }
  const setup = fixture([stop], { attachments, inputModalities: ['text'] })
  const result = await sessionComplete(setup.ctx, setup.exec, setup.rt)({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Screenshot.' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AA=' } },
      ],
    }],
    tools: [],
  })

  assert.deepEqual(setup.requests[0].messages[0].content, [
    { type: 'text', text: 'Screenshot.' },
    { type: 'text', text: '[Browser screenshot omitted.]' },
  ])
  assert.equal(setup.requests[0].messages[0].content.some(part => part.type === 'image'), false)
  assert.equal(saveCalls, 0)
  assert.equal(result.vision, 'rejected')
  assert.equal(setup.modelInfoCalls(), 1)
})

test('configured text-only models omit screenshots without attachment saves', async () => {
  let saveCalls = 0
  const attachments = { async saveImages() { saveCalls += 1; return [] } }
  const setup = fixture([stop], {
    attachments,
    inputModalities: ['text', 'image'],
    textOnlyModels: ['mock-provider/session-model'],
  })
  const result = await sessionComplete(setup.ctx, setup.exec, setup.rt)({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AA=' } }],
    }],
    tools: [],
  })

  assert.equal(setup.requests[0].messages[0].content.some(part => part.type === 'image'), false)
  assert.equal(setup.requests[0].messages[0].content[0].text, '[Browser screenshot omitted.]')
  assert.equal(saveCalls, 0)
  assert.equal(result.vision, 'rejected')
  assert.equal(setup.modelInfoCalls(), 0)
})

test('browser screenshots become DSH image blocks when the route supports images', async () => {
  const saved = []
  const attachments = {
    async saveImages(inputs) {
      saved.push(...inputs)
      return [{
        attachmentId: 'sha256:image',
        mediaType: 'image/jpeg',
        bytes: inputs[0].data.length,
        width: 1,
        height: 1,
      }]
    },
  }
  const setup = fixture([stop], { attachments, inputModalities: ['text', 'image'] })
  const result = await sessionComplete(setup.ctx, setup.exec, setup.rt)({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Screenshot.' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AA=' } },
      ],
    }],
    tools: [],
  })

  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/jpeg')
  assert.deepEqual(setup.requests[0].messages[0].content[1], {
    type: 'image',
    attachment: {
      attachmentId: 'sha256:image',
      mediaType: 'image/jpeg',
      bytes: saved[0].data.length,
      width: 1,
      height: 1,
    },
  })
  assert.equal(result.vision, 'accepted')
})

test('missing Bot session model fails with a clear error', async () => {
  const setup = fixture([stop])
  const complete = sessionComplete(setup.ctx, { agent: { session: {} } })
  await assert.rejects(
    complete({ messages: [], tools: [] }),
    { message: 'browser_task needs a Bot session model' },
  )
})

test('session completion retries TRANSPORT failures and cancels during retry backoff on abort', async () => {
  let attempts = 0
  const ctx = {
    get: () => undefined,
    llm: {
      providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 3, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }),
      async *stream() {
        attempts += 1
        if (attempts < 3) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'Recovered.' }
        yield stop
      },
    },
  }
  const exec = { agent: { session: { id: 's-browser', requestHeader: () => header } }, signal: new AbortController().signal }
  const result = await sessionComplete(ctx, exec)({ messages: [{ role: 'user', content: 'Open.' }], tools: [] })
  assert.equal(attempts, 3)
  assert.equal(result.choices[0].message.content, 'Recovered.')

  const abort = new AbortController()
  let abortedAttempts = 0
  const slowCtx = {
    get: () => undefined,
    llm: {
      providerRetryPolicy: () => ({ mode: 'normal', maxRetries: 3, retryableCodes: ['TRANSPORT'], initialDelayMs: 5_000, maxDelayMs: 5_000, jitterRatio: 0 }),
      async *stream() {
        abortedAttempts += 1
        setTimeout(() => abort.abort(), 10)
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } } }
      },
    },
  }
  await assert.rejects(
    sessionComplete(slowCtx, { agent: { session: { id: 's-browser', requestHeader: () => header } }, signal: abort.signal })({ messages: [{ role: 'user', content: 'Open.' }], tools: [] }),
  )
  assert.equal(abortedAttempts, 1)
})

