import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { mountBrowserPlugin } from '../src/host/browser/mount.js'
import { toolDefs as refsTools } from '../src/host/browser/refs.js'

test('browser handoff and resume return valid DSH outputs and clear the Bot hold', async t => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  t.after(async () => ctx.fiber.dispose())

  let hold = null
  const ref = { attachmentId: 'sha256:abcd', mediaType: 'image/jpeg', bytes: 3, width: 1, height: 1 }
  const saved = []
  const plugin = inner => {
    inner.provide('attachments', { saveImage: async input => { saved.push(input); return ref } })
    mountBrowserPlugin(inner, {
      toolDefs: refsTools.filter(tool => ['browser_handoff', 'browser_resume', 'browser_screenshot'].includes(tool.name)),
      defineTool,
      keyOf: async () => 'bot-1',
      profileRoot: '/tmp/browser-profiles',
      headless: true,
      openSession: async ({ getHold, onHold }) => ({
        handoff(reason, note) {
          const safeNote = String(note ?? '').slice(0, 300)
          onHold({ by: 'bot', reason, note: safeNote })
          return `Waiting for the user (${reason}). ${safeNote || 'Ask them to take over.'} Call browser_resume when they have finished.`
        },
        resume() {
          if (getHold()?.by === 'user') throw new Error('The user has taken over this browser. Only the user can give it back.')
          onHold(null)
          return 'The browser is yours again.'
        },
        async shot() {
          return { text: 'Screenshot of https://example.com/.', image: 'AAAA' }
        },
        async close() {},
      }),
      getHold: () => hold,
      onHold: (botId, value) => { hold = value },
    })
  }
  plugin.inject = ['tools']
  await ctx.plugin(plugin)

  const execute = (name, args) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(name),
    name,
    arguments: args,
  })

  const handoff = await execute('browser_handoff', { reason: 'other', note: 'Please take over.' })
  assert.equal(handoff.isError, false, handoff.error?.message)
  assert.deepEqual(handoff.value, {
    text: 'Waiting for the user (other). Please take over. Call browser_resume when they have finished.',
  })
  assert.deepEqual(handoff.content, [{
    type: 'text',
    text: 'Waiting for the user (other). Please take over. Call browser_resume when they have finished.',
  }])
  assert.deepEqual(hold, { by: 'bot', reason: 'other', note: 'Please take over.' })

  const resume = await execute('browser_resume', {})
  assert.equal(resume.isError, false, resume.error?.message)
  assert.deepEqual(resume.value, { text: 'The browser is yours again.' })
  assert.deepEqual(resume.content, [{ type: 'text', text: 'The browser is yours again.' }])
  assert.equal(hold, null)

  const screenshot = await execute('browser_screenshot', {})
  assert.equal(screenshot.isError, false, screenshot.error?.message)
  assert.deepEqual(saved, [{
    mediaType: 'image/jpeg',
    data: Buffer.from('AAAA', 'base64'),
    name: 'Browser screenshot',
  }])
  assert.deepEqual(screenshot.value, { text: 'Screenshot of https://example.com/.', attachment: ref })
  assert.deepEqual(screenshot.content, [
    { type: 'text', text: 'Screenshot of https://example.com/.' },
    { type: 'image', attachment: ref },
  ])
})

test('a screenshot degrades to text when no attachments service is mounted', async t => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  t.after(async () => ctx.fiber.dispose())

  const plugin = inner => {
    mountBrowserPlugin(inner, {
      toolDefs: refsTools.filter(tool => tool.name === 'browser_screenshot'),
      defineTool,
      keyOf: async () => 'bot-1',
      profileRoot: '/tmp/browser-profiles',
      headless: true,
      openSession: async () => ({
        async shot() { return { text: 'Screenshot of https://example.com/.', image: 'AAAA' } },
        async close() {},
      }),
    })
  }
  plugin.inject = ['tools']
  await ctx.plugin(plugin)

  const screenshot = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('browser_screenshot'),
    name: 'browser_screenshot',
    arguments: {},
  })
  assert.equal(screenshot.isError, false, screenshot.error?.message)
  assert.deepEqual(screenshot.value, { text: 'Screenshot of https://example.com/. (The screenshot could not be attached.)' })
  assert.deepEqual(screenshot.content, [
    { type: 'text', text: 'Screenshot of https://example.com/. (The screenshot could not be attached.)' },
  ])
})

test('a stored browser screenshot is repaired before the next step and survives reload', async t => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  t.after(async () => ctx.fiber.dispose())
  const session = Session.create('old-browser-chat')
  const call = session.append('tool/call', { turn: 1, step: 1, callId: 'shot', name: 'browser_screenshot', arguments: '{}' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({
      callId: 'shot', isError: false,
      content: [{ type: 'text', text: 'Old screenshot' }, { type: 'image', data: 'AAAA', mediaType: 'image/jpeg', offloaded: true }],
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const ref = { attachmentId: 'sha256:abcd', mediaType: 'image/jpeg', bytes: 3, width: 1, height: 1 }
  let flushed
  const plugin = inner => {
    inner.provide('attachments', { saveImage: async () => ref })
    inner.provide('sessions', { flush: async value => { flushed = value.snapshotEvents() } })
    mountBrowserPlugin(inner, {
      toolDefs: refsTools, defineTool, keyOf: async () => 'bot-1', profileRoot: '/tmp/browser-profiles', headless: true,
    })
  }
  plugin.inject = ['tools']
  await ctx.plugin(plugin)
  const step = () => ctx.waterfall('agent/pre-step', { agent: { id: 'bot-1', session } }, async () => 'next')
  await step()
  assert.ok(flushed, 'the repair is durable before the model sees it')
  const restored = Session.create('old-browser-chat', flushed)
  assert.deepEqual(restored.deriveMessages()[0].content, [
    { type: 'text', text: 'Old screenshot' }, { type: 'image', attachment: ref, offloaded: true },
  ])
  const afterRepair = session.seq
  await step()
  assert.equal(session.seq, afterRepair, 'a repaired result is not rewritten again')
})

test('browser tools refuse every operation while a user hold is active', async t => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  t.after(async () => ctx.fiber.dispose())
  const hold = { by: 'user', reason: 'stopped', note: 'The user is controlling this browser.' }
  const plugin = inner => {
    mountBrowserPlugin(inner, {
      toolDefs: refsTools.filter(tool => ['browser_tabs', 'browser_screenshot', 'browser_handoff', 'browser_resume'].includes(tool.name)),
      defineTool,
      keyOf: async () => 'bot-1',
      profileRoot: '/tmp/browser-profiles',
      headless: true,
      openSession: async () => ({
        async tabs() { return [] },
        async shot() { return { text: 'shot' } },
        handoff() { throw new Error('handoff should not run') },
        resume() { throw new Error('resume should not run') },
        async close() {},
      }),
      getHold: () => hold,
    })
  }
  plugin.inject = ['tools']
  await ctx.plugin(plugin)
  const execute = (name, args) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(name),
    name,
    arguments: args,
  })
  for (const [name, args] of [
    ['browser_tabs', { action: 'list' }],
    ['browser_screenshot', {}],
    ['browser_handoff', { reason: 'other' }],
    ['browser_resume', {}],
  ]) {
    const result = await execute(name, args)
    assert.equal(result.isError, true, `${name} should be refused`)
    assert.match(result.error.message, /user has taken over/u)
  }
})

test('browser endpoint connection uses the execution Bot identity, not tool arguments', async t => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  t.after(async () => ctx.fiber.dispose())
  let connected
  const plugin = inner => {
    mountBrowserPlugin(inner, {
      toolDefs: refsTools.filter(tool => tool.name === 'browser_open'),
      defineTool,
      keyOf: async () => 'a',
      profileRoot: '/tmp/browser-profiles',
      headless: true,
      connect: async botId => { connected = botId; return 'ws://127.0.0.1:1' },
      openSession: async options => {
        await options.connect?.(options.botId)
        return {
          async open() { return 'opened' },
          async close() {},
        }
      },
    })
  }
  plugin.inject = ['tools']
  await ctx.plugin(plugin)
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('browser_open'),
    name: 'browser_open',
    arguments: { url: 'http://127.0.0.1:43118/', botId: 'b' },
  })
  assert.equal(result.isError, false, result.error?.message)
  assert.equal(connected, 'a')
})

test('a channel user hold closes the cached Playwright session and give-back reconnects', async t => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  t.after(async () => ctx.fiber.dispose())
  let hold = null
  let notifyHold
  let opens = 0
  let closes = 0
  const plugin = inner => {
    mountBrowserPlugin(inner, {
      toolDefs: refsTools.filter(tool => tool.name === 'browser_snapshot'),
      defineTool,
      keyOf: async () => 'bot-1',
      profileRoot: '/tmp/browser-profiles',
      headless: true,
      getHold: () => hold,
      subscribeHolds: listener => { notifyHold = listener; return () => { notifyHold = undefined } },
      openSession: async () => {
        opens += 1
        return { snapshotText: async () => 'page', async close() { closes += 1 } }
      },
    })
  }
  plugin.inject = ['tools']
  await ctx.plugin(plugin)
  const execute = () => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('browser_snapshot'),
    name: 'browser_snapshot',
    arguments: {},
  })
  assert.equal((await execute()).isError, false)
  hold = { by: 'user', reason: 'takeover', note: '' }
  notifyHold('bot-1', hold)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closes, 1)
  assert.equal((await execute()).isError, true)
  hold = null
  notifyHold('bot-1', null)
  assert.equal((await execute()).isError, false)
  assert.equal(opens, 2)
})
