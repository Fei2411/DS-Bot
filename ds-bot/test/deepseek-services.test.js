import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { install, normalizeServices } from '../src/host/deepseek-services.js'

// The DeepSeek services module over fakes: `keys` is the credential store,
// `profile` the deepseek-official route's settings section, `env` the launch
// environment (DEEPSEEK_BASE_URL overrides the route's endpoint the same way
// the adapter reads it), and `calls.fetch` records every api.deepseek.com hit.
function setup({ keys = {}, profile, directory, env, fs, attachments, speechToText, spillStore, inject, prefs = {}, sessions = {}, bots = {} } = {}) {
  const calls = { fetch: [] }
  const values = { ...keys }
  const ctx = {
    get: name => ({
      credentials: {
        describe: async ref => values[ref] === undefined ? { configured: false, writable: true } : { configured: true, writable: true },
        resolve: async ref => values[ref] === undefined ? undefined : { value: values[ref], source: 'test' },
      },
      settings: {
        describe: () => profile === undefined ? [] : [{ ns: 'llm-deepseek-api-key', value: profile }],
      },
      launchEnvironment: { get: name => (env?.[name] === undefined ? undefined : { value: env[name] }) },
      fs,
      attachments,
      speechToText,
      spillStore,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/' }) },
      workingDirectory: { ensure: async () => '/work' },
    })[name],
    llm: {
      // The real descriptor is minimal: no defaultBaseURL, no baseURLEnv — the
      // shipped endpoint is the adapter's own default.
      listConfigurableProviders: () => directory ?? [{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek-api-key', settingsPath: [] }],
    },
    on: () => () => {},
    effect: execute => execute(),
    inject,
  }
  let stateSaved = 0
  const rt = {
    ctx,
    state: { prefs, rooms: {}, bots },
    teamTools: [],
    warn: () => {},
    load: async () => {},
    save: async () => { stateSaved += 1 },
    selfOf: id => sessions[id],
    botOf: id => rt.state.bots[id],
    isBotSession: id => id in sessions,
    roomOf: () => undefined,
    inData: async path => String(path).startsWith('/dsh'),
    real: async path => path,
  }
  install(rt)
  return { rt, ctx, calls, keys: values, saved: () => stateSaved }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const readTool = rt => rt.teamTools.find(tool => tool.name === 'read_document')
const locatorOf = (out) => {
  const match = out.match(/saved to ("(?:\\.|[^"\\])*")/)
  assert.ok(match, 'the answer names a locator')
  return JSON.parse(match[1])
}
const exec = (session, extra = {}) => ({ agent: { id: 'bot1', session }, callId: 'call-1', ...extra })
const sessionWithFile = (attachmentId, name = 'doc.pdf') => ({
  id: 'bot1',
  surface: { nodes: [0] },
  eventAt: () => ({ type: 'user/message' }),
  deriveEventMessage: () => ({ content: [{ type: 'file', attachment: { attachmentId, name } }] }),
})
const sessionWithImage = (attachmentId, name) => ({
  id: 'bot1',
  surface: { nodes: [0] },
  eventAt: () => ({ type: 'user/message' }),
  deriveEventMessage: () => ({ content: [{ type: 'image', attachment: { attachmentId, ...(name === undefined ? {} : { name }) } }] }),
})
const stubFetch = (t, answer) => {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return answer(url, init) }
  t.after(() => { globalThis.fetch = real })
  return calls
}

// --- key route: official only, never another gateway's key ---------------

test('normalizeServices keeps only known values', () => {
  assert.deepEqual(normalizeServices(undefined), {})
  assert.deepEqual(normalizeServices({ ocr: true, tts: 'deepseek', voice: 'tide', junk: 1 }), { ocr: true, tts: 'deepseek', voice: 'tide' })
  assert.deepEqual(normalizeServices({ ocr: 'yes', tts: 'other', voice: 'me' }), {})
})

test('key route: a non-official route with a custom ref leaves DEEPSEEK_API_KEY alone', async () => {
  const profile = { apiKeyEnv: 'MY_DS_KEY', baseURL: 'https://gateway.example/v1' }
  const { rt } = setup({ keys: { MY_DS_KEY: 'sk-gateway', DEEPSEEK_API_KEY: 'sk-official' }, profile })
  const status = await rt.servicesStatus()
  assert.equal(status.key.ref, 'DEEPSEEK_API_KEY')
  assert.equal(status.key.configured, true)
})

test('key route: a non-official route whose ref IS DEEPSEEK_API_KEY blocks the services', async (t) => {
  const profile = { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://gateway.example/v1' }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-gateway' }, profile, sessions: { bot1: 'bot1' }, attachments: { async* readFileStream() { yield new Uint8Array([1]) } } })
  const status = await rt.servicesStatus()
  assert.equal(status.key.configured, false)
  assert.match(status.key.reason, /cannot tell/)
  const calls = stubFetch(t, () => json({}))
  rt.state.prefs.deepseekServices = { tts: 'deepseek' }
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-synthesize', { text: 'hi' }), /cannot tell|not set/)
  await rt.deepseekEndpoint('deepseek-services-config', { ocr: true })
  await assert.rejects(() => readTool(rt).execute({ attachment_id: 'sha256:aa' }, exec(sessionWithFile('sha256:aa'))), /cannot tell|not set/)
  assert.equal(calls.length, 0)
})

test('key route: official default baseURL keeps the route ref; no route means DEEPSEEK_API_KEY', async () => {
  const official = setup({ keys: { OWN_KEY: 'sk-1' }, profile: { apiKeyEnv: 'OWN_KEY' } })
  assert.equal((await official.rt.servicesStatus()).key.ref, 'OWN_KEY')
  const bare = setup({ keys: { DEEPSEEK_API_KEY: 'sk-2' }, directory: [] })
  const status = await bare.rt.servicesStatus()
  assert.equal(status.key.ref, 'DEEPSEEK_API_KEY')
  assert.equal(status.key.configured, true)
})

test('key route: the real minimal descriptor (no defaultBaseURL) still resolves the official key', async () => {
  // Live regression: the api-key route's descriptor names no endpoint, and a key
  // stored under DEEPSEEK_API_KEY still configures the services.
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-live' } })
  const status = await rt.servicesStatus()
  assert.equal(status.key.ref, 'DEEPSEEK_API_KEY')
  assert.equal(status.key.configured, true)
  assert.equal(status.key.reason, undefined)
})

test('key route: DEEPSEEK_BASE_URL to a gateway blocks when the ref is DEEPSEEK_API_KEY, even with no route', async () => {
  const env = { DEEPSEEK_BASE_URL: 'https://gateway.example/v1' }
  // No route at all: the env still proves the name belongs to the gateway.
  const noRoute = setup({ keys: { DEEPSEEK_API_KEY: 'sk-gateway' }, directory: [], env })
  const noRouteStatus = await noRoute.rt.servicesStatus()
  assert.equal(noRouteStatus.key.configured, false)
  assert.match(noRouteStatus.key.reason, /DEEPSEEK_BASE_URL/)
  // A route whose profile leaves baseURL unset inherits the env endpoint → blocked.
  const routed = setup({ keys: { DEEPSEEK_API_KEY: 'sk-gateway' }, profile: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, env })
  const routedStatus = await routed.rt.servicesStatus()
  assert.equal(routedStatus.key.configured, false)
  assert.match(routedStatus.key.reason, /cannot tell/)
  // With a custom ref, only DEEPSEEK_API_KEY resolves for the services.
  const custom = setup({ keys: { DEEPSEEK_API_KEY: 'sk-official', GW: 'sk-gw' }, profile: { apiKeyEnv: 'GW' }, env })
  const status = await custom.rt.servicesStatus()
  assert.equal(status.key.ref, 'DEEPSEEK_API_KEY')
  assert.equal(status.key.configured, true)
})

// --- status and config ---------------------------------------------------

test('status is local: no fetch, prefs normalized, speech.ready requires registration and key', async (t) => {
  const calls = stubFetch(t, () => json({}))
  const { rt: unmounted } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-x' }, prefs: { deepseekServices: { ocr: true, tts: 'deepseek', voice: 'tide', extra: 1 } } })
  const status = await unmounted.servicesStatus()
  assert.equal(calls.length, 0)
  assert.equal(status.endpoint, 'https://api.deepseek.com')
  assert.equal(status.key.configured, true)
  assert.deepEqual(status.preferences, { ocr: true, tts: 'deepseek', voice: 'tide' })
  assert.equal(status.ocr.enabled, true)
  assert.equal(status.tts.enabled, true)
  assert.deepEqual(status.tts.voices, ['stella', 'tide'])
  assert.equal(status.speech.providerId, 'deepseek-asr')
  // Even after the key check settles, speech.ready stays false without a mounted speechToText service.
  await new Promise(resolve => setTimeout(resolve, 0))
  const afterUnmounted = await unmounted.servicesStatus()
  assert.equal(afterUnmounted.speech.registered, false)
  assert.equal(afterUnmounted.speech.ready, false)
  assert.match(afterUnmounted.speech.reason, /no speech-to-text service/)

  // When speechToText is mounted and registers deepseek-asr, speech.ready settles true.
  const { rt: mounted } = setup({
    keys: { DEEPSEEK_API_KEY: 'sk-x' },
    speechToText: { register: () => () => {} },
    inject: (_deps, fn) => fn({ effect: execute => execute() }),
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const afterMounted = await mounted.servicesStatus()
  assert.equal(afterMounted.speech.registered, true)
  assert.equal(afterMounted.speech.ready, true)
  assert.equal(afterMounted.speech.reason, undefined)

  // If another provider already took deepseek-asr, speech.ready stays false and surfaces the reason.
  const { rt: duplicate } = setup({
    keys: { DEEPSEEK_API_KEY: 'sk-x' },
    speechToText: { register: () => { throw new Error('id taken') } },
    inject: (_deps, fn) => fn({ effect: execute => execute() }),
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const afterDuplicate = await duplicate.servicesStatus()
  assert.equal(afterDuplicate.speech.registered, false)
  assert.equal(afterDuplicate.speech.ready, false)
  assert.match(afterDuplicate.speech.reason, /id taken/)
})

test('config patch: absent keeps, null resets, invalid refuses', async () => {
  const { rt, saved } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-x' } })
  const first = await rt.deepseekEndpoint('deepseek-services-config', { ocr: true, tts: 'deepseek' })
  assert.deepEqual(rt.state.prefs.deepseekServices, { ocr: true, tts: 'deepseek' })
  assert.equal(first.preferences.tts, 'deepseek')
  const status = await rt.deepseekEndpoint('deepseek-services-config', { voice: 'tide' })
  assert.deepEqual(status.preferences, { ocr: true, tts: 'deepseek', voice: 'tide' })
  const reset = await rt.deepseekEndpoint('deepseek-services-config', { tts: null })
  assert.equal(reset.preferences.tts, 'system')
  assert.equal(reset.preferences.ocr, true)
  assert.deepEqual(rt.state.prefs.deepseekServices, { ocr: true, voice: 'tide' })
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-services-config', { tts: 'google' }), /"deepseek"/)
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-services-config', { voice: 'me' }), /voice must be/)
  assert.ok(saved() >= 3)
})

// --- TTS -------------------------------------------------------------------

const wav = (dataBytes = 4) => {
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  bytes.set([82, 73, 70, 70]) // RIFF
  view.setUint32(4, 36 + dataBytes, true)
  bytes.set([87, 65, 86, 69], 8) // WAVE
  bytes.set([102, 109, 116, 32], 12) // fmt 
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 24000, true)
  view.setUint32(28, 48000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  bytes.set([100, 97, 116, 97], 36) // data
  view.setUint32(40, dataBytes, true)
  return bytes
}

test('synthesize posts JSON to /v1/tools/tts with redirect:error and returns audio/wav', async (t) => {
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, prefs: { deepseekServices: { tts: 'deepseek' } } })
  const calls = stubFetch(t, () => new Response(wav(100), { status: 200, headers: { 'content-type': 'audio/wav' } }))
  const result = await rt.deepseekEndpoint('deepseek-synthesize', { text: '你好 world', voice: 'tide' })
  assert.equal(result.mediaType, 'audio/wav')
  assert.equal(Buffer.from(result.audioBase64, 'base64').byteLength, 144)
  const call = calls[0]
  assert.equal(call.url, 'https://api.deepseek.com/v1/tools/tts')
  assert.equal(call.init.redirect, 'error')
  assert.equal(call.init.headers.authorization, 'Bearer sk-1')
  assert.deepEqual(JSON.parse(call.init.body), { text: '你好 world', voice_id: 'tide', format: 'wav' })
})

test('synthesize refuses when off, text invalid, or upstream fails; errors stay fixed, CJK counts double', async (t) => {
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' } })
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-synthesize', { text: 'hi' }), /off/)
  const on = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, prefs: { deepseekServices: { tts: 'deepseek' } } })
  await assert.rejects(() => on.rt.deepseekEndpoint('deepseek-synthesize', { text: '  ' }), /text/)
  await assert.rejects(() => on.rt.deepseekEndpoint('deepseek-synthesize', { text: 'x', voice: 'other' }), /Voice must be/)
  const calls = stubFetch(t, () => json({}))
  await assert.rejects(() => on.rt.deepseekEndpoint('deepseek-synthesize', { text: '汉'.repeat(5001) }), /too long/)
  // Upstream messages never leak: the answer is the fixed status phrase.
  globalThis.fetch = async () => json({ error: { message: 'secret sk-1 leaked here' } }, 503)
  await assert.rejects(() => on.rt.deepseekEndpoint('deepseek-synthesize', { text: 'hi' }), /HTTP 503.*busy/, /leaked/)
  globalThis.fetch = async () => new Response(new Uint8Array([82, 73]), { status: 200 })
  await assert.rejects(() => on.rt.deepseekEndpoint('deepseek-synthesize', { text: 'hi' }), /no audio/)
  assert.equal(calls.every(call => call.url.startsWith('https://api.deepseek.com')), true)
})

test('synthesize accepts an unknown-length streaming WAV but refuses a declared-size truncation', async (t) => {
  const on = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, prefs: { deepseekServices: { tts: 'deepseek' } } })
  // RIFF size 0xFFFFFFFF + a data chunk also marked unknown: valid streaming WAV.
  const streaming = new Uint8Array(60)
  streaming.set([82, 73, 70, 70]) // RIFF
  new DataView(streaming.buffer).setUint32(4, 0xFFFFFFFF, true)
  streaming.set([87, 65, 86, 69], 8) // WAVE
  streaming.set([102, 109, 116, 32], 12) // fmt
  new DataView(streaming.buffer).setUint32(16, 16, true)
  new DataView(streaming.buffer).setUint16(20, 1, true)
  new DataView(streaming.buffer).setUint16(22, 1, true)
  new DataView(streaming.buffer).setUint32(24, 24000, true)
  new DataView(streaming.buffer).setUint32(28, 48000, true)
  new DataView(streaming.buffer).setUint16(32, 2, true)
  new DataView(streaming.buffer).setUint16(34, 16, true)
  streaming.set([100, 97, 116, 97], 36) // data
  new DataView(streaming.buffer).setUint32(40, 0xFFFFFFFF, true)
  stubFetch(t, () => new Response(streaming, { status: 200, headers: { 'content-type': 'audio/wav' } }))
  const result = await on.rt.deepseekEndpoint('deepseek-synthesize', { text: 'hi' })
  assert.equal(result.mediaType, 'audio/wav')
  // A declared size that the body does not meet is a truncated stream.
  const cut = new Uint8Array(streaming)
  new DataView(cut.buffer).setUint32(40, 1000, true) // data chunk says 1000 bytes, only 16 present
  globalThis.fetch = async () => new Response(cut.slice(0, 44 + 16), { status: 200 })
  await assert.rejects(() => on.rt.deepseekEndpoint('deepseek-synthesize', { text: 'hi' }), /ended early/)
  // A streaming header cut off before the data chunk even begins is also rejected.
  globalThis.fetch = async () => new Response(streaming.slice(0, 36), { status: 200 })
  await assert.rejects(() => on.rt.deepseekEndpoint('deepseek-synthesize', { text: 'hi' }), /ended early/)
})

// --- OCR -------------------------------------------------------------------

test('read_document stays off until enabled, then posts the upload as multipart', async (t) => {
  const attachments = { async* readFileStream() { yield new Uint8Array([1, 2, 3]) } }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, attachments, sessions: { bot1: 'bot1' } })
  assert.equal(readTool(rt), undefined)
  await rt.deepseekEndpoint('deepseek-services-config', { ocr: true })
  assert.equal(readTool(rt).name, 'read_document')
  const calls = stubFetch(t, () => json({
    id: 'ocr-1', object: 'ocr.result', created: 1, purpose: 'text_recognition', page_count: 2,
    pages: [
      { index: 0, text: 'first page', finish_reason: 'stop' },
      { index: 1, text: 'second page', finish_reason: 'length' },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }))
  const out = await readTool(rt).execute({ attachment_id: 'sha256:aa' }, exec(sessionWithFile('sha256:aa', 'scan.pdf')))
  assert.match(out, /2 pages/)
  assert.match(out, /\[page 0\]\nfirst page/)
  assert.match(out, /\[page 1 — possibly incomplete\]\nsecond page/)
  const call = calls[0]
  assert.equal(call.url, 'https://api.deepseek.com/v1/tools/ocr')
  assert.equal(call.init.method, 'POST')
  assert.ok(call.init.body instanceof FormData)
  assert.equal(call.init.body.get('purpose'), 'text_recognition')
  assert.equal(call.init.body.get('file').name, 'scan.pdf')
})

test('read_document reads a workspace path through ctx.fs and spills a long result to spillStore', async (t) => {
  const spills = []
  const fs = {
    resolve: async (path, { cwd }) => ({ targetKey: `${cwd}/${path}`, displayPath: `${cwd}/${path}` }),
    stat: async () => ({ type: 'file', size: 3, version: 'v' }),
    processPath: target => target.displayPath,
    readBytes: async () => new Uint8Array([37, 80, 68, 70]),
  }
  // The real LocalSpillStore: locator is an absolute path, retrievalHint is
  // generic guidance that never names it — the result must quote the locator.
  const spillStore = {
    saveText: async (input) => {
      spills.push(input)
      return { locator: `/tmp/dsh-spill-abc123/session-0123abcd/a1b2c3-${input.suggestedName}`, bytes: Buffer.byteLength(input.content, 'utf8'), retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }
    },
  }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, fs, spillStore, sessions: { bot1: 'bot1' }, prefs: { deepseekServices: { ocr: true } } })
  const calls = stubFetch(t, () => json({
    id: 'ocr-2', object: 'ocr.result', created: 1, purpose: 'rich_layout_recognition', page_count: 1,
    pages: [{ index: 0, text: 'long '.repeat(5000), finish_reason: 'stop' }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }))
  const out = await readTool(rt).execute({ path: 'reports/scan.pdf', purpose: 'rich_layout_recognition' }, exec(sessionWithFile('x')))
  const form = calls[0].init.body
  assert.equal(form.get('purpose'), 'rich_layout_recognition')
  assert.equal(form.get('file').name, 'scan.pdf')
  // Long result: the whole paid text went to the spill store, and the answer
  // carries BOTH the copyable locator and the generic retrieval hint.
  assert.equal(spills.length, 1)
  assert.equal(spills[0].owner.sessionId, 'bot1')
  assert.equal(spills[0].source.toolName, 'read_document')
  assert.equal(spills[0].source.callId, 'call-1')
  assert.match(spills[0].suggestedName, /scan\.ocr\.txt$/)
  const expected = `long `.repeat(5000)
  assert.equal(spills[0].content, `[page 0]\n${expected}`, 'the full text stays in the spill')
  assert.ok(out.includes('"/tmp/dsh-spill-abc123/session-0123abcd/a1b2c3-scan.ocr.txt"'), 'the locator is named in the answer')
  assert.ok(out.includes('Use read with offset/limit, or grep this path to search within it.'), 'the backend hint is kept')
  assert.match(out, /more characters in the saved result/)
})

test('read_document keeps a long result inline when there is no spill store', async (t) => {
  const fs = {
    resolve: async (path, { cwd }) => ({ targetKey: `${cwd}/${path}`, displayPath: `${cwd}/${path}` }),
    stat: async () => ({ type: 'file', size: 3, version: 'v' }),
    processPath: target => target.displayPath,
    readBytes: async () => new Uint8Array([37, 80, 68, 70]),
  }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, fs, sessions: { bot1: 'bot1' }, prefs: { deepseekServices: { ocr: true } } })
  stubFetch(t, () => json({
    id: 'ocr-3', object: 'ocr.result', created: 1, purpose: 'text_recognition', page_count: 1,
    pages: [{ index: 0, text: 'full '.repeat(5000), finish_reason: 'stop' }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }))
  const out = await readTool(rt).execute({ path: 'big.pdf' }, exec(sessionWithFile('x')))
  assert.match(out, /full result is below/)
  assert.ok(out.length > 20000, 'the paid text is not thrown away')
  // A store that fails mid-save degrades the same way: still fully inline.
  const failing = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, fs, spillStore: { saveText: async () => { throw new Error('disk full') } }, sessions: { bot1: 'bot1' }, prefs: { deepseekServices: { ocr: true } } })
  const again = await readTool(failing.rt).execute({ path: 'big.pdf' }, exec(sessionWithFile('x')))
  assert.match(again, /full result is below/)
  assert.ok(again.length > 20000, 'a failed spill still keeps the paid text')
})

test('read_document reads an uploaded image through attachments.readImage, still session-scoped', async (t) => {
  const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const attachments = {
    async readImage(ref) { return { ref: { ...ref, mediaType: 'image/png' }, data: imageBytes } },
    async* readFileStream() { yield new Uint8Array([1]) },
  }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, attachments, sessions: { bot1: 'bot1' }, prefs: { deepseekServices: { ocr: true } } })
  const calls = stubFetch(t, () => json({
    id: 'ocr-img', object: 'ocr.result', created: 1, purpose: 'text_recognition', page_count: 1,
    pages: [{ index: 0, text: 'text in the photo', finish_reason: 'stop' }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }))
  const out = await readTool(rt).execute({ attachment_id: 'sha256:img1' }, exec(sessionWithImage('sha256:img1', 'note.png')))
  assert.match(out, /text in the photo/)
  const file = calls[0].init.body.get('file')
  assert.equal(file.name, 'note.png')
  assert.equal(file.type, 'image/png')
  // An image id that is not in the session is still refused.
  await assert.rejects(() => readTool(rt).execute({ attachment_id: 'sha256:stranger' }, exec(sessionWithImage('sha256:img1'))), /not in this conversation/)
})

test('read_document refuses an attachment_id that is not in the calling session', async (t) => {
  const attachments = { async* readFileStream() { yield new Uint8Array([1]) } }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, attachments, sessions: { bot1: 'bot1' }, prefs: { deepseekServices: { ocr: true } } })
  const calls = stubFetch(t, () => json({}))
  await assert.rejects(() => readTool(rt).execute({ attachment_id: 'sha256:guessed' }, exec(sessionWithFile('sha256:other'))), /not in this conversation/)
  assert.equal(calls.length, 0)
})

test('read_document surfaces in-body errors and refuses DSH data paths', async (t) => {
  const fs = {
    resolve: async (path, { cwd }) => ({ targetKey: `${cwd}/${path}`, displayPath: `/dsh/${path}` }),
    stat: async () => ({ type: 'file', size: 1, version: 'v' }),
    processPath: target => target.displayPath,
    readBytes: async () => new Uint8Array([1]),
  }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, fs, sessions: { bot1: 'bot1' }, prefs: { deepseekServices: { ocr: true } } })
  await assert.rejects(() => readTool(rt).execute({ path: 'secrets.json' }, exec(sessionWithFile('x'))), /cannot read/)
  stubFetch(t, () => json({ error: { type: 'gateway_timeout_error', message: 'OCR did not finish' } }, 200))
  const ok = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, attachments: { async* readFileStream() { yield new Uint8Array([1]) } }, sessions: { bot1: 'bot1' }, prefs: { deepseekServices: { ocr: true } } })
  await assert.rejects(() => readTool(ok.rt).execute({ attachment_id: 'sha256:aa' }, exec(sessionWithFile('sha256:aa'))), /reported an error/)
})

test('upstream error bodies never echo secrets: fixed phrases only', async (t) => {
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-fake-secret-123' }, prefs: { deepseekServices: { ocr: true, tts: 'deepseek' } }, sessions: { bot1: 'bot1' }, attachments: { async* readFileStream() { yield new Uint8Array([1]) } } })
  const secret = 'sk-fake-secret-123'
  stubFetch(t, () => json({ error: { type: `type-${secret}`, message: `message-${secret}`, code: `code-${secret}` } }, 400))
  await assert.rejects(
    () => rt.deepseekEndpoint('deepseek-synthesize', { text: 'hi' }),
    (error) => {
      assert.match(error.message, /HTTP 400/)
      assert.equal(error.message.includes(secret), false, `leaked: ${error.message}`)
      return true
    })
  await assert.rejects(
    () => readTool(rt).execute({ attachment_id: 'sha256:aa' }, exec(sessionWithFile('sha256:aa'))),
    (error) => {
      assert.match(error.message, /HTTP 400/)
      assert.equal(error.message.includes(secret), false, `leaked: ${error.message}`)
      return true
    })
  // A 200 in-body error with secret-bearing type and code also stays generic.
  globalThis.fetch = async () => json({ error: { type: secret, message: secret, code: secret } })
  await assert.rejects(
    () => readTool(rt).execute({ attachment_id: 'sha256:aa' }, exec(sessionWithFile('sha256:aa'))),
    (error) => {
      assert.match(error.message, /reported an error/)
      assert.equal(error.message.includes(secret), false, `leaked: ${error.message}`)
      return true
    })
})

test('read_document is a team tool: a plain DSH session is refused', async () => {
  const attachments = { async* readFileStream() { yield new Uint8Array([1]) } }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, attachments, sessions: {}, prefs: { deepseekServices: { ocr: true } } })
  const out = await readTool(rt).execute({ attachment_id: 'sha256:aa' }, exec(sessionWithFile('sha256:aa')))
  assert.match(out, /Only Bots on the team/)
})

// --- ASR provider ----------------------------------------------------------

const wav16 = (seconds = 2, rate = 16000) => {
  const dataBytes = seconds * rate * 2
  const bytes = new Uint8Array(44 + dataBytes)
  bytes.set([82, 73, 70, 70]) // RIFF
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 36 + dataBytes, true)
  bytes.set([87, 65, 86, 69], 8) // WAVE
  bytes.set([102, 109, 116, 32], 12) // fmt
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true) // 16-bit
  bytes.set([100, 97, 116, 97], 36) // data
  view.setUint32(40, dataBytes, true)
  return bytes
}

test('the speech provider registers through inject', async () => {
  const registered = []
  const inject = (deps, fn) => {
    assert.deepEqual(deps, ['speechToText'])
    fn({ effect: execute => execute() })
  }
  const speechToText = { register(provider) { registered.push(provider); return () => {} } }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, speechToText, inject })
  assert.equal(registered.length, 1)
  const provider = registered[0]
  assert.equal(provider.info.id, 'deepseek-asr')
  assert.equal(provider.info.location, 'cloud')
  assert.deepEqual(provider.info.languages, ['auto'])
  assert.equal((await rt.servicesStatus()).speech.registered, true)
})

test('ASR readiness follows the key, and transcribe posts the audio', async (t) => {
  const registered = []
  const inject = (deps, fn) => fn({ effect: execute => execute() })
  const speechToText = { register(provider) { registered.push(provider); return () => {} } }
  setup({ speechToText, inject })
  const provider = registered[0]
  assert.equal(provider.preparation.snapshot().phase, 'unprepared')
  await assert.rejects(() => provider.transcribe({ audio: wav16() }), /API key|key/)
  setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, speechToText, inject })
  const ready = registered[1]
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(ready.preparation.snapshot().phase, 'ready')
  const calls = stubFetch(t, () => json({ request_id: 'r1', text: 'hello there', duration_ms: 3200 }))
  const result = await ready.transcribe({ audio: wav16() }, AbortSignal.timeout(1000))
  assert.equal(result.text, 'hello there')
  assert.equal(result.audioSeconds, 3.2)
  const call = calls[0]
  assert.equal(call.url, 'https://api.deepseek.com/v1/tools/asr')
  assert.ok(call.init.body instanceof FormData)
  assert.equal(call.init.body.get('file').name, 'speech.wav')
})

test('ASR refuses over-length audio before upload', async (t) => {
  const registered = []
  const inject = (deps, fn) => fn({ effect: execute => execute() })
  const speechToText = { register(p) { registered.push(p); return () => {} } }
  setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, speechToText, inject })
  const provider = registered[0]
  await new Promise(resolve => setTimeout(resolve, 0))
  const calls = stubFetch(t, () => json({}))
  await assert.rejects(() => provider.transcribe({ audio: wav16(121) }), /120/)
  assert.equal(calls.length, 0)
})

test('an out-of-order key describe cannot roll readiness back, in either direction', async () => {
  // refresh #1 (install) and #2 (prepare) race: whichever resolves later must
  // win, and the stale answer — ready or not-ready — must not roll back.
  const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve } }
  const d1 = deferred()
  const d2 = deferred()
  const describes = [d1.promise, d2.promise]
  let call = 0
  const credentials = {
    describe: async () => describes[call++] ?? d2.promise,
    resolve: async () => ({ value: 'sk-1', source: 'test' }),
  }
  const registered = []
  const inject = (deps, fn) => fn({ effect: execute => execute() })
  const speechToText = { register(p) { registered.push(p); return () => {} } }
  const ctx = {
    get: name => ({
      credentials,
      settings: { describe: () => [] },
      launchEnvironment: { get: () => undefined },
      speechToText,
    })[name],
    llm: { listConfigurableProviders: () => [] },
    on: () => () => {},
    effect: execute => execute(),
    inject,
  }
  const rt = { ctx, state: { prefs: {} }, teamTools: [], warn: () => {}, load: async () => {}, save: async () => {}, selfOf: () => 'b', isBotSession: () => true, roomOf: () => undefined, inData: async () => false, real: async p => p }
  install(rt)
  const provider = registered[0]
  // refresh #2 begins through the provider's own prepare hook.
  provider.preparation.prepare()
  // Newer answer settles first: the snapshot goes to ready.
  d2.resolve({ configured: true })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(provider.preparation.snapshot().phase, 'ready')
  // The stale #1 lands after: it must not un-ready the provider.
  d1.resolve({ configured: false })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(provider.preparation.snapshot().phase, 'ready')

  // The same race in the other direction: a stale ready answer must not
  // resurrect readiness after a newer check found the key gone.
  const d3 = deferred()
  const d4 = deferred()
  let calls = 0
  const ctx2 = {
    get: name => ({
      credentials: { describe: async () => [d3.promise, d4.promise][calls++] ?? d4.promise, resolve: async () => ({ value: 'sk-1', source: 'test' }) },
      settings: { describe: () => [] },
      launchEnvironment: { get: () => undefined },
      speechToText,
    })[name],
    llm: { listConfigurableProviders: () => [] },
    on: () => () => {},
    effect: execute => execute(),
    inject,
  }
  install({ ctx: ctx2, state: { prefs: {} }, teamTools: [], warn: () => {}, load: async () => {}, save: async () => {}, selfOf: () => 'b', isBotSession: () => true, roomOf: () => undefined, inData: async () => false, real: async p => p })
  registered[1].preparation.prepare()
  d4.resolve({ configured: false })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(registered[1].preparation.snapshot().phase, 'unprepared')
  d3.resolve({ configured: true })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(registered[1].preparation.snapshot().phase, 'unprepared')
})

test('billed characters: supplementary-plane Han counts as 2, emoji as 1', async (t) => {
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, prefs: { deepseekServices: { tts: 'deepseek' } } })
  const calls = stubFetch(t, () => json({}))
  // 𠀀 (U+20000) is Han outside the BMP; 5001 of them bill as 10002 → refused locally.
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-synthesize', { text: '𠀀'.repeat(5001) }), /too long/)
  // 10001 emoji still fit under the cap's billed count but not the 60 KiB body limit either way.
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-synthesize', { text: 'a'.repeat(10001) }), /too long/)
  assert.equal(calls.length, 0)
})

test('read_document is omitted from team tools while OCR is off', async () => {
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' } })
  assert.equal(readTool(rt), undefined)
  await rt.deepseekEndpoint('deepseek-services-config', { ocr: true })
  assert.equal(readTool(rt).name, 'read_document')
  await rt.deepseekEndpoint('deepseek-services-config', { ocr: null })
  assert.equal(readTool(rt), undefined)
})

test('read_document still refuses when the catalog and the preference race', async () => {
  const attachments = { async* readFileStream() { yield new Uint8Array([1]) } }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, attachments, sessions: { bot1: 'bot1' }, prefs: { deepseekServices: { ocr: true } } })
  const tool = readTool(rt)
  assert.ok(tool)
  rt.state.prefs.deepseekServices = {}
  await assert.rejects(() => tool.execute({ attachment_id: 'sha256:aa' }, exec(sessionWithFile('sha256:aa'))), /off/)
})

test('status and config endpoints load saved prefs before answering', async () => {
  let loads = 0
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-x' } })
  rt.load = async () => {
    loads += 1
    rt.state.prefs.deepseekServices = { ocr: true }
  }
  const status = await rt.deepseekEndpoint('deepseek-services', {})
  assert.ok(loads >= 1, 'status loads on a cold start')
  assert.equal(status.preferences.ocr, true)
  assert.equal(status.ocr.enabled, true)
  assert.equal(readTool(rt).name, 'read_document')
  const before = loads
  await rt.deepseekEndpoint('deepseek-services-config', { ocr: true })
  assert.ok(loads > before, 'config loads too')
})

test('a private Bot spills a long OCR result under its own folder with the literal session id', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'ds-bot-ocr-private-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const spills = []
  const fs = {
    resolve: async (path, { cwd }) => ({ targetKey: `${cwd}/${path}`, displayPath: `${cwd}/${path}` }),
    stat: async () => ({ type: 'file', size: 3, version: 'v' }),
    processPath: target => target.displayPath,
    readBytes: async () => new Uint8Array([37, 80, 68, 70]),
  }
  const spillStore = {
    saveText: async (input) => {
      spills.push(input)
      return { locator: `/tmp/dsh-spill-abc123/session-0123abcd/a1b2c3-${input.suggestedName}`, bytes: Buffer.byteLength(input.content, 'utf8'), retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }
    },
  }
  const { rt } = setup({
    keys: { DEEPSEEK_API_KEY: 'sk-1' }, fs, spillStore,
    sessions: { bot1: 'bot1' },
    bots: { bot1: { id: 'bot1', name: 'Diary', private: true, workDir } },
    prefs: { deepseekServices: { ocr: true } },
  })
  stubFetch(t, () => json({
    id: 'ocr-priv', object: 'ocr.result', created: 1, purpose: 'text_recognition', page_count: 1,
    pages: [{ index: 0, text: 'secret '.repeat(5000), finish_reason: 'stop' }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }))
  const out = await readTool(rt).execute({ path: 'scan.pdf' }, exec(sessionWithFile('x')))
  assert.equal(spills.length, 0, 'the shared spill store is not used for a private Bot')
  const locator = locatorOf(out)
  assert.equal(dirname(locator), join(workDir, '.ocr', 'bot1', 'bot1'))
  assert.ok(locator.includes('bot1'), 'the path names the literal session id so ownerOfPath needles match')
  assert.match(locator, /scan\.ocr\.txt$/)
  const expected = `[page 0]\n${'secret '.repeat(5000)}`
  assert.equal(readFileSync(locator, 'utf8'), expected)
})

test('a private Bot keeps distinct spills when two long readings share a basename', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'ds-bot-ocr-private-dup-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const fs = {
    resolve: async (path, { cwd }) => ({ targetKey: `${cwd}/${path}`, displayPath: `${cwd}/${path}` }),
    stat: async () => ({ type: 'file', size: 3, version: 'v' }),
    processPath: target => target.displayPath,
    readBytes: async () => new Uint8Array([37, 80, 68, 70]),
  }
  const { rt } = setup({
    keys: { DEEPSEEK_API_KEY: 'sk-1' }, fs,
    spillStore: { saveText: async () => { throw new Error('private spills must not use the shared store') } },
    sessions: { bot1: 'bot1' },
    bots: { bot1: { id: 'bot1', name: 'Diary', private: true, workDir } },
    prefs: { deepseekServices: { ocr: true } },
  })
  let n = 0
  stubFetch(t, () => {
    n += 1
    const word = n === 1 ? 'invoice ' : 'receipt '
    return json({
      id: `ocr-dup-${n}`, object: 'ocr.result', created: 1, purpose: 'text_recognition', page_count: 1,
      pages: [{ index: 0, text: word.repeat(5000), finish_reason: 'stop' }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
  })
  const invoice = await readTool(rt).execute({ path: 'invoices/scan.pdf' }, exec(sessionWithFile('x'), { callId: 'call-invoice' }))
  const receipt = await readTool(rt).execute({ path: 'receipts/scan.pdf' }, exec(sessionWithFile('x'), { callId: 'call-receipt' }))
  const invoiceLocator = locatorOf(invoice)
  const receiptLocator = locatorOf(receipt)
  assert.notEqual(invoiceLocator, receiptLocator)
  assert.equal(dirname(invoiceLocator), join(workDir, '.ocr', 'bot1', 'bot1'))
  assert.equal(dirname(receiptLocator), join(workDir, '.ocr', 'bot1', 'bot1'))
  const invoiceText = `[page 0]\n${'invoice '.repeat(5000)}`
  const receiptText = `[page 0]\n${'receipt '.repeat(5000)}`
  assert.equal(readFileSync(invoiceLocator, 'utf8'), invoiceText)
  assert.equal(readFileSync(receiptLocator, 'utf8'), receiptText)
  assert.ok(invoiceText.length > 8000)
  assert.ok(receiptText.length > 8000)
})

test('a private Bot deleted while OCR is in flight still never uses the shared spill store', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'ds-bot-ocr-private-toctou-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const spills = []
  const fs = {
    resolve: async (path, { cwd }) => ({ targetKey: `${cwd}/${path}`, displayPath: `${cwd}/${path}` }),
    stat: async () => ({ type: 'file', size: 3, version: 'v' }),
    processPath: target => target.displayPath,
    readBytes: async () => new Uint8Array([37, 80, 68, 70]),
  }
  const bots = { bot1: { id: 'bot1', name: 'Diary', private: true, workDir } }
  const { rt } = setup({
    keys: { DEEPSEEK_API_KEY: 'sk-1' }, fs,
    spillStore: { saveText: async (input) => { spills.push(input); return { locator: '/tmp/shared.txt', bytes: 1, retrievalHint: '' } } },
    sessions: { bot1: 'bot1' },
    bots,
    prefs: { deepseekServices: { ocr: true } },
  })
  stubFetch(t, () => {
    // Simulate deleting the private Bot while the OCR request is in flight.
    delete bots.bot1
    return json({
      id: 'ocr-toctou', object: 'ocr.result', created: 1, purpose: 'text_recognition', page_count: 1,
      pages: [{ index: 0, text: 'secret '.repeat(5000), finish_reason: 'stop' }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
  })
  const out = await readTool(rt).execute({ path: 'scan.pdf' }, exec(sessionWithFile('x')))
  assert.equal(spills.length, 0, 'in-flight deletion must not downgrade spill isolation to shared spillStore')
  const locator = locatorOf(out)
  assert.equal(dirname(locator), join(workDir, '.ocr', 'bot1', 'bot1'))
})

test('a private Bot truncates inline instead of risking shared spill when read-only or unable to write', async (t) => {
  const spills = []
  const fs = {
    resolve: async (path, { cwd }) => ({ targetKey: `${cwd}/${path}`, displayPath: `${cwd}/${path}` }),
    stat: async () => ({ type: 'file', size: 3, version: 'v' }),
    processPath: target => target.displayPath,
    readBytes: async () => new Uint8Array([37, 80, 68, 70]),
  }
  const { rt } = setup({
    keys: { DEEPSEEK_API_KEY: 'sk-1' }, fs,
    spillStore: { saveText: async (input) => { spills.push(input); return { locator: '/tmp/shared.txt', bytes: 1, retrievalHint: '' } } },
    sessions: { bot1: 'bot1' },
    bots: { bot1: { id: 'bot1', name: 'Diary', private: true, workDir: '/nonexistent-dir-should-not-be-written' } },
    prefs: { deepseekServices: { ocr: true } },
  })
  rt.readOnly = () => 'team is open in another window'
  stubFetch(t, () => json({
    id: 'ocr-ro', object: 'ocr.result', created: 1, purpose: 'text_recognition', page_count: 1,
    pages: [{ index: 0, text: 'secret '.repeat(10_000), finish_reason: 'stop' }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }))
  const out = await readTool(rt).execute({ path: 'scan.pdf' }, exec(sessionWithFile('x')))
  assert.equal(spills.length, 0)
  assert.match(out, /could not save a private copy/)
  assert.ok(out.length < 10_000, 'truncated inline answer stays well below DSH spill threshold')
})

test('config rejects non-object payloads, rolls back on save failure, and rejects JSON null OCR bodies', async (t) => {
  const { rt } = setup({
    keys: { DEEPSEEK_API_KEY: 'sk-1' },
    env: { DEEPSEEK_BASE_URL: '' },
    sessions: { bot1: 'bot1' },
    attachments: { async* readFileStream() { yield new Uint8Array([1]) } },
  })
  const initial = await rt.deepseekEndpoint('deepseek-services', {})
  assert.equal(initial.key.configured, true, 'empty DEEPSEEK_BASE_URL does not block official key')
  await assert.rejects(
    () => rt.deepseekEndpoint('deepseek-services-config', 'bad'),
    error => error.code === 'bot/invalid')
  await assert.rejects(
    () => rt.deepseekEndpoint('deepseek-services-config', []),
    error => error.code === 'bot/invalid')
  const origSave = rt.save
  rt.save = async () => { throw new Error('disk full') }
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-services-config', { ocr: true }), /disk full/)
  assert.equal(rt.state.prefs.deepseekServices, undefined, 'failed save rolls back in-memory prefs')
  assert.equal(readTool(rt), undefined)
  rt.save = origSave
  await rt.deepseekEndpoint('deepseek-services-config', { ocr: true })
  stubFetch(t, () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }))
  await assert.rejects(
    () => readTool(rt).execute({ attachment_id: 'sha256:aa' }, exec(sessionWithFile('sha256:aa'))),
    /no usable answer/)
})

test('ASR wavSeconds handles truncated fmt chunks and zero sample rate without throwing RangeError', async (t) => {
  const registered = []
  const inject = (_deps, fn) => fn({ effect: execute => execute() })
  const speechToText = { register(p) { registered.push(p); return () => {} } }
  setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, speechToText, inject })
  const provider = registered[0]
  await new Promise(resolve => setTimeout(resolve, 0))
  const calls = stubFetch(t, () => json({ request_id: 'r-malformed', text: 'ok', duration_ms: 500 }))
  // Truncated fmt chunk near end of a >= 44-byte RIFF/WAVE buffer (size declares 16, only 4 bytes remain).
  const truncatedFmt = new Uint8Array(48)
  const v1 = new DataView(truncatedFmt.buffer)
  truncatedFmt.set([82, 73, 70, 70], 0)
  v1.setUint32(4, 40, true)
  truncatedFmt.set([87, 65, 86, 69], 8)
  truncatedFmt.set([74, 85, 78, 75], 12) // JUNK
  v1.setUint32(16, 16, true)
  truncatedFmt.set([102, 109, 116, 32], 36) // fmt  at offset 36 (at + 24 = 60 > 48)
  v1.setUint32(40, 16, true)
  const res1 = await provider.transcribe({ audio: truncatedFmt })
  assert.equal(res1.text, 'ok')
  // Zero sample rate must not divide by zero into Infinity or reject locally.
  const zeroRate = wav(16)
  new DataView(zeroRate.buffer).setUint32(24, 0, true)
  const res2 = await provider.transcribe({ audio: zeroRate })
  assert.equal(res2.text, 'ok')
  assert.equal(calls.length, 2)
})

test('servicesStatus keeps speech.ready synchronized with key changes and pre-aborted calls skip fetch', async (t) => {
  const { rt, keys } = setup({
    keys: { DEEPSEEK_API_KEY: 'sk-1' },
    speechToText: { register: () => () => {} },
    inject: (_deps, fn) => fn({ effect: execute => execute() }),
    prefs: { deepseekServices: { tts: 'deepseek' } },
  })
  // Even before any timer tick, servicesStatus resolves key + asrReady together.
  const first = await rt.servicesStatus()
  assert.equal(first.speech.configured, true)
  assert.equal(first.speech.ready, true)
  // Deleting the key immediately reflects as configured: false AND ready: false in the same snapshot.
  delete keys.DEEPSEEK_API_KEY
  const second = await rt.servicesStatus()
  assert.equal(second.speech.configured, false)
  assert.equal(second.speech.ready, false)
  assert.ok(second.speech.reason)
  // Pre-aborted signal rejects before touching fetch.
  keys.DEEPSEEK_API_KEY = 'sk-1'
  const calls = stubFetch(t, () => new Response(wav(16), { status: 200 }))
  const ctl = new AbortController()
  ctl.abort(new Error('cancelled'))
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-synthesize', { text: 'hi' }, ctl.signal), /cancelled/)
  assert.equal(calls.length, 0)
})
