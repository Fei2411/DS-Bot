import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { install, manualDirectory, manualProvider } from '../src/host/manual-skills.js'
import { fakeContext } from './fake-ctx.js'

test('manual provider lists and loads the bundled, invocable manual', async () => {
  const provider = manualProvider()
  const [item] = await provider.list()
  assert.equal(item.name, 'ds-bot-manual')
  assert.equal(item.source, 'bundled')
  assert.ok(item.description.length > 40)
  assert.deepEqual(item.invocation, { modelInvocable: true, userInvocable: true })
  const loaded = await provider.get(item)
  assert.match(loaded.content, /## Authority/)
  assert.ok(!loaded.content.startsWith('---'))
  assert.equal(item.resourceBase.kind, 'directory')
  assert.equal(readFileSync(join(item.resourceBase.path, 'SKILL.md'), 'utf8').includes(item.description), true)
})

test('manual injection is optional and registers a provider when skills exist', () => {
  install({ ctx: {} })
  let registered
  install({ ctx: { inject(deps, callback) {
    assert.deepEqual(deps, { skills: null })
    callback({ skills: { registerProvider(factory) { registered = factory() } } })
  } } })
  assert.equal(registered.name, 'ds-bot-manual')
})

test('manual references form a complete index and all claimed tools are registered', async () => {
  const [item] = await manualProvider().list()
  const root = item.resourceBase.path
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8')
  const links = [...skill.matchAll(/\]\((references\/[^)#]+\.md)\)/gu)].map(match => match[1])
  const files = readdirSync(join(root, 'references')).filter(file => file.endsWith('.md')).map(file => `references/${file}`)
  assert.ok(files.length >= 12)
  assert.deepEqual([...new Set(links)].sort(), files.sort())
  const documents = [skill, ...files.map(file => readFileSync(join(root, file), 'utf8'))]
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-manual-'))
  const ctx = fakeContext()
  try {
    const rt = createRuntime(ctx, { home, browser: true })
    await rt.load()
    const names = new Set(rt.teamTools.map(tool => tool.name))
    // Every inline-code identifier is a tool claim; prose uses plain field names.
    const claims = documents.flatMap(doc => [...doc.matchAll(/`([a-z][a-z0-9_]+)`/gu)].map(match => match[1]))
    assert.ok(claims.length > 30)
    for (const name of claims) assert.ok(names.has(name), `manual claims unavailable host tool ${name}`)
    const prompt = ctx.sections.get('bot-identity')
    assert.ok(prompt)
    assert.match(readFileSync(new URL('../src/host/prompt.js', import.meta.url), 'utf8'), /Load the ds-bot-manual skill/)
  } finally {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('manual maps packaged resources to plain files and leaves other paths alone', () => {
  const suffix = ['node_modules', 'ds-bot', 'src', 'host', 'skills', 'ds-bot-manual'].join(sep)
  assert.equal(manualDirectory(join('opt', 'app.asar', suffix)), join('opt', 'app.asar.unpacked', suffix))
  assert.equal(manualDirectory(join('opt', suffix)), join('opt', suffix))
})

test('manual loading reports missing and malformed resources', async () => {
  const provider = manualProvider()
  const [item] = await provider.list()
  await assert.rejects(provider.get({ ...item, locator: join(item.resourceBase.path, 'missing.md') }), /ENOENT/)
  await assert.rejects(provider.get({ ...item, locator: join(item.resourceBase.path, 'references', 'bots.md') }), /has no description/)
})
