import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, normalizeServices } from '../src/host/deepseek-services.js'

// The DeepSeek document service over fakes: `keys` is the credential store,
// `profile` the deepseek-official route's settings section, `env` the launch
// environment (DEEPSEEK_BASE_URL overrides the route's endpoint the same way
// the adapter reads it), and `calls.fetch` records every api.deepseek.com hit.
function setup({ keys = {}, profile, directory, env, fs, attachments, spillStore, inject, prefs = {}, sessions = {} } = {}) {
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
    state: { prefs, rooms: {}, bots: {} },
    teamTools: [],
    warn: () => {},
    load: async () => {},
    save: async () => { stateSaved += 1 },
    selfOf: id => sessions[id],
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
  assert.deepEqual(normalizeServices({ ocr: true, junk: 1 }), { ocr: true })
  assert.deepEqual(normalizeServices({ ocr: 'yes' }), {})
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
  const attachments = { async* readFileStream() { yield new Uint8Array([1]) } }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-gateway' }, profile, attachments, sessions: { bot1: 'bot1' } })
  const status = await rt.servicesStatus()
  assert.equal(status.key.configured, false)
  assert.match(status.key.reason, /cannot tell/)
  const calls = stubFetch(t, () => json({}))
  rt.state.prefs.deepseekServices = { ocr: true }
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

test('status is local: no fetch, prefs normalized', async (t) => {
  const calls = stubFetch(t, () => json({}))
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-x' }, prefs: { deepseekServices: { ocr: true, extra: 1 } } })
  const status = await rt.servicesStatus()
  assert.equal(calls.length, 0)
  assert.equal(status.endpoint, 'https://api.deepseek.com')
  assert.equal(status.key.configured, true)
  assert.deepEqual(status.preferences, { ocr: true })
  assert.equal(status.ocr.enabled, true)
})

test('config patch: absent keeps, null resets, invalid refuses', async () => {
  const { rt, saved } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-x' } })
  const first = await rt.deepseekEndpoint('deepseek-services-config', { ocr: true })
  assert.deepEqual(rt.state.prefs.deepseekServices, { ocr: true })
  assert.equal(first.preferences.ocr, true)
  const reset = await rt.deepseekEndpoint('deepseek-services-config', { ocr: null })
  assert.equal(reset.preferences.ocr, false)
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-services-config', { ocr: 'yes' }), /true, false or null/)
  assert.ok(saved() >= 2)
})

// --- OCR -------------------------------------------------------------------

test('read_document stays off until enabled, then posts the upload as multipart', async (t) => {
  const attachments = { async* readFileStream() { yield new Uint8Array([1, 2, 3]) } }
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' }, attachments, sessions: { bot1: 'bot1' } })
  await assert.rejects(() => readTool(rt).execute({ attachment_id: 'sha256:aa' }, exec(sessionWithFile('sha256:aa'))), /off/)
  rt.state.prefs.deepseekServices = { ocr: true }
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
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-fake-secret-123' }, prefs: { deepseekServices: { ocr: true } }, sessions: { bot1: 'bot1' }, attachments: { async* readFileStream() { yield new Uint8Array([1]) } } })
  const secret = 'sk-fake-secret-123'
  stubFetch(t, () => json({ error: { type: `type-${secret}`, message: `message-${secret}`, code: `code-${secret}` } }, 400))
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

test('an unknown endpoint is refused', async () => {
  const { rt } = setup({ keys: { DEEPSEEK_API_KEY: 'sk-1' } })
  await assert.rejects(() => rt.deepseekEndpoint('deepseek-synthesize', {}), /Unknown endpoint/)
})
