import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

// Deep View registers show_view globally for plain sessions; ds-bot registers its
// own in the agent scope of every session it owns, and the scoped one wins.
const tool = (description) => defineTool({
  name: 'show_view',
  description,
  parameters: { type: 'object', additionalProperties: true },
  execute: async () => description,
})

const setup = async (t, run) => {
  const ctx = new Context()
  await ctx.plugin(ToolRuntime)
  t.after(async () => ctx.fiber.dispose())
  const plugin = { inject: ['tools'], apply: inner => run(inner.tools, inner) }
  await ctx.plugin(plugin)
}

test('a scoped show_view shadows the global one inside a Bot session', async t => {
  await setup(t, (tools, ctx) => {
    tools.register(tool('global'))

    const bot = {}
    const scope = createScope(ctx, bot)
    t.after(async () => scope.dispose())
    scope.ctx.tools.register(tool('bot'))

    assert.equal(tools.get('show_view', bot)?.description, 'bot', 'Bot agent sees its own definition')
    assert.equal(tools.schemas(bot).find(schema => schema.name === 'show_view')?.description, 'bot')

    const stranger = {}
    assert.equal(tools.get('show_view', stranger)?.description, 'global', 'other agents keep the global one')
    assert.equal(tools.schemas(stranger).find(schema => schema.name === 'show_view')?.description, 'global')
    assert.equal(tools.get('show_view')?.description, 'global', 'an unscoped lookup is global too')
  })
})

test('without a global show_view a non-Bot agent has none', async t => {
  await setup(t, (tools, ctx) => {
    const bot = {}
    const scope = createScope(ctx, bot)
    t.after(async () => scope.dispose())
    scope.ctx.tools.register(tool('bot'))

    const stranger = {}
    assert.equal(tools.get('show_view', stranger), undefined, 'no global, no tool outside the Bot scope')
    assert.equal(tools.get('show_view', bot)?.description, 'bot')
  })
})
