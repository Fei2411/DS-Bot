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
    return Response.json({ models: [
      { slug: 'new-model', supported_reasoning_levels: ['low', 'max', 'ultra'].map(effort => ({ effort })) },
    ] })
  })
  const api = 'openai-responses'
  const expected = { low: 'low', max: 'max' }
  assert.deepEqual(await Promise.all([lookup('new-model', api), lookup('openai/new-model', api)]), [expected, expected])
  assert.equal(await lookup('other/new-model', api), undefined)
  assert.equal(await lookup('new-model-preview', api), null)
  assert.equal(calls.length, 1)
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
  assert.equal(await lookup('claude-sonnet', 'google-generative-ai'), undefined)
})
