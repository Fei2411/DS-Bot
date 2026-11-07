import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { apply as applyPersona, PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-persona'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A preset persona is scope-only. The system-prompt service already owns the global
// persona, so registering another one on the root context collides or stays global and
// never shadows per scope. Mount it through a scoped context that injects systemPrompt,
// the same way an agent preset's isolated composition does.
const BOT_IDENTITY = 'bot-identity'

async function mountPrompt({ identity = true } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  // The host test lets createRuntime register this section on the same service.
  if (identity) {
    ctx.systemPrompt.section({
      name: BOT_IDENTITY,
      order: 640,
      interpolate: false,
      text: '# Your identity\nYou are a Bot on the user\'s team.',
    })
  }
  return ctx
}

async function mountPersona(parent, { prefix, complete }) {
  const key = {}
  const scope = createScope(parent, key)
  const plugin = {
    inject: ['systemPrompt'],
    apply: inner => applyPersona(inner, { prefix, complete }),
  }
  await scope.ctx.plugin(plugin)
  return { key, scope }
}

function sectionNames(assembly) {
  return (assembly?.sections ?? []).map(section => section.name)
}

test('a scoped complete persona drops bot-identity; a scoped ordinary persona keeps it', async (t) => {
  const ctx = await mountPrompt()
  t.after(() => ctx.fiber.dispose())
  const ordinary = await mountPersona(ctx, { prefix: 'You are a careful assistant.', complete: false })
  const complete = await mountPersona(ctx, { prefix: 'You are a helpful software engineer assistant.', complete: true })
  t.after(() => ordinary.scope.dispose())
  t.after(() => complete.scope.dispose())

  const kept = await ctx.systemPrompt.assemble({ scope: ordinary.key })
  const replaced = await ctx.systemPrompt.assemble({ scope: complete.key })
  const keptNames = sectionNames(kept)
  const replacedNames = sectionNames(replaced)

  assert.ok(keptNames.includes(BOT_IDENTITY), `ordinary preset lost ${BOT_IDENTITY}: ${keptNames.join(', ')}`)
  assert.ok(keptNames.includes(PERSONA_PREFIX_SECTION), `ordinary preset lost its persona: ${keptNames.join(', ')}`)
  assert.ok(keptNames.length > 1, 'ordinary assembly collapsed to one section')
  assert.equal(replacedNames.includes(BOT_IDENTITY), false, `complete preset kept ${BOT_IDENTITY}: ${replacedNames.join(', ')}`)
  assert.deepEqual(replacedNames, [PERSONA_PREFIX_SECTION])
  assert.match(replaced.sections[0].text, /helpful software engineer assistant/)
})

// The host probe reads ctx.get('systemPrompt') and acquireScope().key. The identity
// section createRuntime registers must be that same service, or both presets look empty.
function hostWithRealPrompt({ acquireScope, presets }) {
  return mountPrompt({ identity: false }).then(async (root) => {
    const ordinary = await mountPersona(root, { prefix: 'You are a careful assistant.', complete: false })
    const complete = await mountPersona(root, { prefix: 'You are a helpful software engineer assistant.', complete: true })
    const home = mkdtempSync(join(tmpdir(), 'ds-bot-preset-fit-'))
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      version: 1, mainBotIds: [], workspaceId: 'w1', bots: {}, rooms: {}, agents: {},
      exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
    }))
    const created = []
    const ctx = fakeContext({
      services: {
        systemPrompt: root.systemPrompt,
        agentPresets: {
          list: async () => presets,
          acquireScope,
          defaultId: 'standard',
        },
      },
    })
    // prompt.js registers through ctx.systemPrompt, while presetFits reads ctx.get.
    ctx.systemPrompt = root.systemPrompt
    Object.assign(ctx, {
      llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
      workspaceRegistry: {
        get: id => (id === 'w1' ? { id, path: join(home, 'workspace') } : undefined),
        resolveByPath: async () => undefined,
        create: async path => ({ id: 'w-new', path }),
        archiveSession: async () => {},
        unarchiveSession: async () => {},
      },
      sessionController: {
        create: async (options) => {
          const sessionId = `s${created.length + 1}`
          created.push({ sessionId, ...options })
          return { sessionId }
        },
        resolveAgent: async sessionId => ({ agent: ctx.scopeAgent(sessionId) }),
        selectModel: async () => {},
        page: async () => ({ records: [], hasMore: false }),
      },
      sessionTitle: { rename: async () => {} },
      sessions: { flush: async () => {} },
    })
    let route
    const register = ctx.connection.fetch.register
    ctx.connection.fetch.register = (options) => {
      route = options
      return register(options)
    }
    const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
    const call = async (endpoint, payload = {}) => {
      assert.equal(typeof route?.fetch, 'function', 'api/bot route was not captured')
      return (await route.fetch(new Request('http://localhost/api/bot', {
        method: 'POST', body: JSON.stringify({ endpoint, payload }),
      }))).json()
    }
    return {
      root, ordinary, complete, home, ctx, rt, created, call,
      stop: async () => {
        await ctx.dispose()
        await ordinary.scope.dispose()
        await complete.scope.dispose()
        await root.fiber.dispose()
        rmSync(home, { recursive: true, force: true, maxRetries: 5 })
      },
    }
  })
}

test('presetFits marks only the complete preset broken and createSession refuses it', async (t) => {
  const keys = {}
  const host = await hostWithRealPrompt({
    presets: [{ id: 'standard', name: 'Standard' }, { id: 'minimal', name: 'Minimal' }],
    acquireScope: async (id) => {
      const key = id === 'standard' ? keys.ordinary : id === 'minimal' ? keys.complete : undefined
      if (key === undefined) throw new Error(`no scope for ${id}`)
      return { key, [Symbol.asyncDispose]: async () => {} }
    },
  })
  keys.ordinary = host.ordinary.key
  keys.complete = host.complete.key
  t.after(host.stop)

  const listed = await host.call('presets')
  assert.equal(listed.ok, true, JSON.stringify(listed))
  const standard = listed.value.presets.find(row => row.id === 'standard')
  const minimal = listed.value.presets.find(row => row.id === 'minimal')
  assert.equal(standard.broken, undefined)
  assert.match(minimal.broken, /replaces/)

  await host.call('state')
  const before = host.created.length
  const refused = await host.call('create-bot', { name: 'Writer', agentPreset: 'minimal' })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.match(refused.error.message, /cannot be used for a Bot/)
  assert.match(refused.error.message, /replaces/)
  assert.equal(host.created.length, before, 'a complete preset must not create a Session')

  const made = await host.call('create-bot', { name: 'Writer', agentPreset: 'standard' })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal(host.created.at(-1).agentPreset, 'standard')
})

test('a probe that throws is refused, and a registry without acquireScope stays usable', async (t) => {
  const keys = {}
  const host = await hostWithRealPrompt({
    presets: [{ id: 'standard', name: 'Standard' }, { id: 'odd', name: 'Odd' }],
    acquireScope: async (id) => {
      if (id === 'odd') throw new Error('scope lease failed')
      return { key: keys.ordinary, [Symbol.asyncDispose]: async () => {} }
    },
  })
  keys.ordinary = host.ordinary.key
  t.after(host.stop)
  const listed = await host.call('presets')
  assert.equal(listed.ok, true, JSON.stringify(listed))
  assert.equal(listed.value.presets.find(row => row.id === 'standard').broken, undefined)
  assert.match(listed.value.presets.find(row => row.id === 'odd').broken, /could not verify/)

  const bare = fakeContext({ services: { agentPresets: { list: async () => [{ id: 'standard', name: 'Standard' }] } } })
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-preset-old-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: [], workspaceId: 'w1', bots: {}, rooms: {}, agents: {},
    exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  const rt = createRuntime(bare, { home, github: false, diagnosticsFile: false })
  t.after(async () => {
    await bare.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const rows = await rt.agentPresetRows({ fit: true })
  assert.deepEqual(rows, [{ id: 'standard', name: 'Standard' }])
})
