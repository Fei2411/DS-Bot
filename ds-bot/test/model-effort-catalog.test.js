import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createEffortCatalog } from '../src/host/model-effort-catalog.js'

test('capability lookup shares downloads, uses exact IDs, and keeps the last usable list offline', async t => {
  const home = await mkdtemp(join(tmpdir(), 'model-catalog-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const calls = []
  const lookup = createEffortCatalog(home, async url => {
    calls.push(url)
    if (url.endsWith('/models.json')) return Response.json({ xai: [{ id: 'grok', thinking: { levels: ['low'] } }] })
    return Response.json({ models: [
      { slug: 'new-model', supported_reasoning_levels: ['low', 'max', 'ultra'].map(effort => ({ effort })) },
    ] })
  })
  const api = 'openai-responses'
  const expected = { low: 'low', max: 'max' }
  assert.deepEqual(await Promise.all([lookup('new-model', api), lookup('openai/new-model', api)]), [expected, expected])
  assert.deepEqual(await lookup('new-model', api, ['low', 'medium', 'max', 'ultra']), { ...expected, ultra: 'ultra' })
  assert.equal(await lookup('other/new-model', api), null)
  assert.equal(await lookup('new-model-preview', api), null)
  assert.equal(calls.length, 2)
  const file = join(home, 'model-catalog-codex.json')
  const disk = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...disk, updated: 1 }))
  const offline = createEffortCatalog(home, async () => Response.json({ error: 'unavailable' }))
  assert.deepEqual(await offline('new-model', api), expected)
})

test('Claude and Gemini use the named levels for the exact model and protocol', async t => {
  const home = await mkdtemp(join(tmpdir(), 'vendor-catalog-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const lookup = createEffortCatalog(home, async () => Response.json({
    claude: [{ id: 'claude-sonnet', thinking: { levels: ['low', 'max'] } }],
    gemini: [{ id: 'gemini-flash', thinking: { levels: ['minimal', 'high'] } },
      { id: 'gemini-budget', thinking: { min: 128, max: 32768 } }],
  }))
  assert.deepEqual(await lookup('anthropic/claude-sonnet', 'anthropic-messages'), { low: 'low', max: 'max' })
  assert.deepEqual(await lookup('models/gemini-flash', 'google-generative-ai'), { minimal: 'minimal', high: 'high' })
  assert.equal(await lookup('gemini-budget', 'google-generative-ai'), null)
  assert.equal(await lookup('claude-sonnet', 'google-generative-ai'), null)
})

test('gateway catalogs resolve namespaced and bare IDs without borrowing another channel’s levels', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gateway-catalog-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const model = (id, ...levels) => ({ id, thinking: { levels } })
  const lookup = createEffortCatalog(home, async url => {
    if (url.endsWith('/devin_models.json')) return Response.json({ devin: [model('glm-5-3', 'low', 'max'), model('swe-2', 'high')] })
    if (url.endsWith('/deepseek_codex_models.json')) return Response.json({
      models: [{ slug: 'deepseek-v4-flash', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] }],
    })
    if (url.endsWith('/codex_client_models.json')) return Response.json({ models: [{ slug: 'gpt-test', supported_reasoning_levels: [{ effort: 'low' }] }] })
    return Response.json({
      copilot: [model('grok-4.7', 'high'), model('shared', 'low', 'max'), model('fixed', 'high')],
      xai: [model('grok-4.7', 'low', 'high', 'xhigh')],
      kimi: [model('kimi-k3', 'low', 'max')],
      meta: [model('muse-wonder', 'medium', 'max')],
      antigravity: [model('shared', 'medium', 'max')],
      vertex: [model('fixed')],
      future: [model('new-family-1', 'none', 'high'), model('fixed-off', 'none')],
    })
  })
  const api = 'openai-responses'
  for (const id of ['grok-4.7', 'xai/grok-4.7', 'x-ai/grok-4.7']) {
    assert.deepEqual(await lookup(id, api), { low: 'low', high: 'high', xhigh: 'xhigh' })
  }
  assert.deepEqual(await lookup('copilot/grok-4.7', api), { high: 'high' })
  assert.deepEqual(await lookup('shared', api), { max: 'max' })
  assert.equal(await lookup('fixed', api), null)
  assert.equal(await lookup('unknown/grok-4.7', api), null)
  assert.equal(await lookup('xai/grok-4.7', 'anthropic-messages'), undefined)
  for (const id of ['kimi-k3', 'moonshotai/kimi-k3', 'moonshot/kimi-k3', 'devin/glm-5-3',
    'deepseek/deepseek-v4-flash', 'deepseek-flash']) {
    assert.deepEqual(await lookup(id, api), { low: 'low', max: 'max' })
  }
  assert.equal(await lookup('deepseek-v99-unknown', api), null)
  assert.deepEqual(await lookup('meta/muse-wonder', api), { medium: 'medium', max: 'max' })
  assert.deepEqual(await lookup('swe-2', api), { high: 'high' })
  assert.deepEqual(await lookup('future/new-family-1', 'openai-completions'), { off: 'none', high: 'high' })
  assert.equal(await lookup('future/fixed-off', api), null)
  assert.deepEqual(await lookup('github-copilot/grok-4.7', api), { high: 'high' })
})

test('legacy vendor caches serve exact Claude and Gemini IDs while offline and refresh on upgrade', async t => {
  const home = await mkdtemp(join(tmpdir(), 'legacy-catalog-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, 'model-catalog-vendor.json'), JSON.stringify({ updated: Date.now(), rows: [['claude-old', ['low']]] }))
  const offline = createEffortCatalog(home, async () => { throw Error('offline') })
  assert.deepEqual(await offline('anthropic/claude-old', 'anthropic-messages'), { low: 'low' })
  const online = createEffortCatalog(home, async () => Response.json({ xai: [{ id: 'grok-new', thinking: { levels: ['high'] } }] }))
  assert.deepEqual(await online('xai/grok-new', 'openai-responses'), { high: 'high' })
})
