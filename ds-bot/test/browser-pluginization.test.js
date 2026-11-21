import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, defineBrowserProvider } from '../index.js'
import { resolveStdioCommand, sanitizeMcpForView, splitArgs } from '../src/host/browser/catalog.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writer', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function makeAgent(sessionId, servedNames) {
  const denied = new Set()
  const registered = new Map()
  const agent = {
    id: sessionId,
    session: { id: sessionId, header: { id: sessionId } },
    denied,
    registered,
    ctx: {
      tools: {
        register(tool) {
          registered.set(tool.name, tool)
          return () => { registered.delete(tool.name) }
        },
        restrict({ deny = [] }) {
          for (const name of deny) denied.add(name)
          return () => { for (const name of deny) denied.delete(name) }
        },
      },
      effect() {},
      on: () => () => {},
    },
  }
  agent.served = () => servedNames().filter(name => !denied.has(name))
  return agent
}

function start({ config = {}, services = {}, team = TEAM, globalTools = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-browser-plug-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const agents = []
  const ctx = fakeContext({
    services: {
      agents: {
        list: () => agents,
        get: id => agents.find(agent => agent.id === id),
      },
      ...services,
    },
  })
  const servedList = [...globalTools]
  ctx.tools.schemas = (agent) => servedList
    .filter(name => !agent?.denied?.has(name))
    .map(name => ({ name }))
  const mountedPlugins = []
  ctx.plugin = (plugin, cfg) => {
    const entry = { plugin, cfg, disposed: false }
    mountedPlugins.push(entry)
    return {
      await: async () => {},
      dispose: () => { entry.disposed = true },
    }
  }
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, browser: true, ...config })
  return {
    home,
    ctx,
    rt,
    agents,
    servedList,
    mountedPlugins,
    async addAgent(sessionId) {
      const agent = makeAgent(sessionId, () => servedList)
      agents.push(agent)
      await ctx.emitAsync('agent/created', { agent })
      return agent
    },
    call: async (endpoint, payload = {}) => {
      const response = await route.fetch(new Request('http://localhost/api/bot', {
        method: 'POST',
        body: JSON.stringify({ endpoint, payload }),
      }))
      return response.json()
    },
    stop: async () => {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test('hot-switching between readonly, built-in refs, and script swaps Bot tools and prompt without restart', async (t) => {
  const env = start()
  t.after(() => env.stop())
  await env.rt.load()
  const botAgent = await env.addAgent('b2')

  // Default: readonly -> read_browser is present, no interactive Playwright tools, empty browser prompt.
  assert.ok(env.rt.teamTools.some(tool => tool.name === 'read_browser'))
  assert.ok(botAgent.registered.has('read_browser'))
  assert.equal(env.rt.teamTools.some(tool => tool.name === 'browser_open'), false)
  assert.equal(env.ctx.sections.get('bot-browser').text({ agent: { id: 'b2' } }), '')

  // Hot-switch to built-in refs.
  const refsRes = await env.call('browser-set-backend', { id: 'builtin:refs' })
  assert.equal(refsRes.ok, true)
  assert.equal(refsRes.value.active, 'builtin:refs')
  assert.equal(refsRes.value.status.state, 'ready')
  assert.ok(env.rt.teamTools.some(tool => tool.name === 'browser_open'))
  assert.ok(botAgent.registered.has('browser_open'))
  assert.ok(env.rt.teamTools.some(tool => tool.name === 'read_browser'))
  assert.match(env.ctx.sections.get('bot-browser').text({ agent: { id: 'b2' } }), /browser_click/)
  assert.equal(env.ctx.sections.get('bot-browser').text({ agent: { id: 'outsider' } }), '')

  // Persisted to state.json.
  const disk = JSON.parse(readFileSync(join(env.home, 'state.json'), 'utf8'))
  assert.equal(disk.browser.active, 'builtin:refs')

  // Hot-switch to built-in script: refs tools disappear, browser_exec appears on live agents.
  const scriptRes = await env.call('browser-set-backend', { id: 'script' })
  assert.equal(scriptRes.ok, true)
  assert.equal(scriptRes.value.active, 'builtin:script')
  assert.equal(env.rt.teamTools.some(tool => tool.name === 'browser_open'), false)
  assert.equal(botAgent.registered.has('browser_open'), false)
  assert.ok(env.rt.teamTools.some(tool => tool.name === 'browser_exec'))
  assert.ok(botAgent.registered.has('browser_exec'))

  // Switch back to readonly: interactive tools are removed.
  const roRes = await env.call('browser-set-backend', { id: 'readonly' })
  assert.equal(roRes.ok, true)
  assert.equal(roRes.value.active, 'readonly')
  assert.equal(env.rt.teamTools.some(tool => tool.name === 'browser_exec'), false)
  assert.equal(botAgent.registered.has('browser_exec'), false)
  assert.equal(env.ctx.sections.get('bot-browser').text({ agent: { id: 'b2' } }), '')
})

test('switching to an installed DSH browser plugin (ego lite) replaces built-in browser tools and isolates inactive plugin tools', async (t) => {
  const bundles = [
    { name: 'dsh-ego-browser', version: '0.14.1', installed: true, selected: true, description: 'Ego Browser' },
    { name: 'community-stagehand-browser', version: '1.0.0', installed: true, selected: true, description: 'Stagehand' },
  ]
  const env = start({
    globalTools: ['ego_open', 'ego_snapshot', 'ego_click', 'stagehand_act', 'bash'],
    services: {
      pluginManager: {
        listBundles: async () => bundles,
      },
    },
  })
  t.after(() => env.stop())
  await env.rt.load()
  const botAgent = await env.addAgent('b2')
  const plainAgent = await env.addAgent('plain-dsh-session')

  // Refresh discovery so community-stagehand-browser is detected too.
  const listed = await env.call('browser-backends')
  assert.equal(listed.ok, true)
  assert.ok(listed.value.dshPlugins.some(p => p.id === 'dsh:dsh-ego-browser' && p.installed === true))
  assert.ok(listed.value.dshPlugins.some(p => p.id === 'dsh:community-stagehand-browser' && p.discovered === true))

  // While on readonly, inactive external DSH browser tools (ego_*, stagehand_*) are masked from Bots,
  // while non-Bot DSH sessions remain untouched.
  env.rt.reapplyBrowserMasks()
  assert.ok(botAgent.denied.has('ego_open'))
  assert.ok(botAgent.denied.has('stagehand_act'))
  assert.equal(botAgent.denied.has('bash'), false)
  assert.equal(plainAgent.denied.size, 0)

  // Switch to built-in refs first, then replace with dsh:dsh-ego-browser.
  await env.call('browser-set-backend', { id: 'builtin:refs' })
  assert.ok(env.rt.teamTools.some(tool => tool.name === 'browser_open'))

  const egoRes = await env.call('browser-set-backend', { id: 'dsh:dsh-ego-browser' })
  assert.equal(egoRes.ok, true)
  assert.equal(egoRes.value.active, 'dsh:dsh-ego-browser')
  assert.equal(egoRes.value.status.state, 'ready')
  assert.equal(egoRes.value.status.supportsGrants, false)

  // Built-in Playwright tools AND read_browser are removed; ego_* is unmasked for Bots; stagehand_* stays masked.
  assert.equal(env.rt.teamTools.some(tool => tool.name === 'browser_open'), false)
  assert.equal(env.rt.teamTools.some(tool => tool.name === 'read_browser'), false)
  assert.equal(botAgent.registered.has('read_browser'), false)
  assert.equal(botAgent.denied.has('ego_open'), false)
  assert.equal(botAgent.denied.has('ego_snapshot'), false)
  assert.ok(botAgent.denied.has('stagehand_act'))
  assert.match(env.ctx.sections.get('bot-browser').text({ agent: { id: 'b2' } }), /Ego Browser \(ego lite\)/)
  assert.match(env.ctx.sections.get('bot-browser').text({ agent: { id: 'b2' } }), /ego_open/)

  // Switching back to readonly restores read_browser and re-masks ego_*.
  await env.call('browser-set-backend', { id: 'readonly' })
  assert.ok(env.rt.teamTools.some(tool => tool.name === 'read_browser'))
  assert.ok(botAgent.registered.has('read_browser'))
  assert.ok(botAgent.denied.has('ego_open'))
})

test('installing a DSH browser plugin through pluginManager handles both live activation and restart-needed', async (t) => {
  const installed = []
  let bundles = []
  let restartRequired = false
  const env = start({
    services: {
      pluginManager: {
        listBundles: async () => bundles,
        installBundle: async (spec, opts) => {
          installed.push({ spec, opts })
          bundles = [{ name: 'dsh-ego-browser', version: '0.14.1', installed: true, selected: true }]
          if (!restartRequired) env.servedList.push('ego_run')
          return { restartRequired }
        },
      },
    },
  })
  t.after(() => env.stop())
  await env.rt.load()

  // Selecting an uninstalled plugin reports not-installed with installCommand.
  const before = await env.call('browser-set-backend', { id: 'dsh:dsh-ego-browser' })
  assert.equal(before.value.status.state, 'not-installed')
  assert.match(before.value.status.installCommand, /dsh plugin add dsh-ego-browser/)

  // Install with live HMR -> immediately ready.
  const live = await env.call('browser-install-plugin', { id: 'dsh:dsh-ego-browser' })
  assert.equal(live.ok, true)
  assert.deepEqual(installed[0], { spec: 'dsh-ego-browser', opts: { activate: true } })
  assert.equal(live.value.status.state, 'ready')
  assert.equal(live.value.restartRequired, false)

  // Install when restart is required -> restart-needed state.
  restartRequired = true
  const reboot = await env.call('browser-install-plugin', { id: 'dsh:@dshworks/dsh-ego-browser' })
  assert.equal(reboot.ok, true)
  assert.equal(reboot.value.status.state, 'restart-needed')
  assert.equal(reboot.value.restartRequired, true)
})

test('MCP browser servers mount via dsh-mcp-client, hide read_browser, isolate non-Bot sessions, and dispose on switch', async (t) => {
  const fakeMcpPlugin = { name: 'fake-mcp' }
  const env = start({
    globalTools: ['mcp__browser-playwright-mcp__browser_navigate'],
    services: {
      loader: {
        import: async (name) => {
          assert.equal(name, '@deepseek-ai/dsh-mcp-client')
          return fakeMcpPlugin
        },
      },
    },
  })
  t.after(() => env.stop())
  await env.rt.load()
  const botAgent = await env.addAgent('b2')
  const plainAgent = await env.addAgent('plain-dsh-session')

  const res = await env.call('browser-set-backend', { id: 'mcp:playwright-mcp' })
  assert.equal(res.ok, true)
  assert.equal(res.value.active, 'mcp:playwright-mcp')
  assert.equal(res.value.status.state, 'ready')
  assert.equal(env.mountedPlugins.length, 1)
  assert.equal(env.mountedPlugins[0].cfg.transport, 'stdio')
  assert.equal(env.mountedPlugins[0].cfg.command, 'npx')
  assert.equal(env.mountedPlugins[0].cfg.serverName, 'browser-playwright-mcp')

  // Built-in read_browser is hidden; Bots see MCP tools, non-Bot sessions have DS Bot's MCP masked.
  assert.equal(env.rt.teamTools.some(tool => tool.name === 'read_browser'), false)
  assert.equal(botAgent.denied.has('mcp__browser-playwright-mcp__browser_navigate'), false)
  assert.ok(plainAgent.denied.has('mcp__browser-playwright-mcp__browser_navigate'))

  // Custom HTTP MCP server save & remove.
  const added = await env.call('browser-custom-save', {
    kind: 'mcp',
    name: 'Remote Browser',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:8931/mcp',
    activate: true,
  })
  assert.equal(added.ok, true)
  assert.equal(env.mountedPlugins[0].disposed, true)
  assert.equal(env.mountedPlugins.length, 2)
  assert.equal(env.mountedPlugins[1].cfg.transport, 'streamable-http')
  assert.equal(env.mountedPlugins[1].cfg.url, 'http://127.0.0.1:8931/mcp')

  const customId = added.value.active
  const removed = await env.call('browser-custom-remove', { id: customId })
  assert.equal(removed.ok, true)
  assert.equal(removed.value.active, 'readonly')
  assert.equal(env.mountedPlugins[1].disposed, true)
  assert.ok(env.rt.teamTools.some(tool => tool.name === 'read_browser'))
})

test('third-party native browser providers plug into dsBotBrowser with custom mount, host capabilities, and Bot deletion cleanup', async (t) => {
  const env = start()
  t.after(() => env.stop())
  await env.rt.load()

  let disposed = 0
  const dropped = []
  let sawHost = null

  const unregister = env.rt.dsBotBrowser.registerProvider(defineBrowserProvider({
    id: 'provider:custom-engine',
    name: 'Custom Engine',
    description: 'Pluggable non-Playwright browser engine',
    mode: 'cdp',
    supportsGrants: true,
    supportsHandoff: true,
    supportsPerBotProfile: true,
    systemPrompt: 'Use custom_browse to navigate.',
    mount(host) {
      sawHost = host
      const removeTool = host.registerTool(host.defineTool({
        name: 'custom_browse',
        description: 'Open page in custom engine',
        parameters: { url: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute(args, exec) {
          const botId = await host.resolveBotId(exec)
          return `${botId}:${host.profileDir(botId)}:${args.url}`
        },
      }))
      return {
        frame: async botId => ({ mime: 'image/jpeg', data: 'abc', url: `https://${botId}.test`, title: botId }),
        drop: async botId => { dropped.push(botId) },
        dispose: async () => {
          disposed += 1
          removeTool()
        },
      }
    },
  }))

  const switched = await env.call('browser-set-backend', { id: 'provider:custom-engine' })
  assert.equal(switched.ok, true)
  assert.equal(switched.value.active, 'provider:custom-engine')
  assert.equal(switched.value.status.state, 'ready')
  assert.ok(sawHost)
  assert.equal(typeof sawHost.authorize, 'function')
  assert.equal(typeof sawHost.profileDir, 'function')
  assert.equal(typeof sawHost.downloadRoots, 'function')
  assert.equal(typeof sawHost.getHold, 'function')

  // Execute the custom provider's tool and verify per-Bot resolution + frame.
  const tool = env.rt.teamTools.find(item => item.name === 'custom_browse')
  assert.ok(tool)
  const output = await tool.execute({ url: 'https://example.com' }, { agent: { id: 'b2' } })
  assert.match(output, /^b2:.*browser-profiles[\\/]b2:https:\/\/example\.com$/)
  const frame = await env.rt.browserFrame('b2')
  assert.equal(frame.url, 'https://b2.test')

  // Switching away disposes the provider and removes its tools.
  await env.call('browser-set-backend', { id: 'readonly' })
  assert.equal(disposed, 1)
  assert.equal(env.rt.teamTools.some(item => item.name === 'custom_browse'), false)
  unregister()
  assert.equal(env.rt.dsBotBrowser.listProviders().some(p => p.id === 'provider:custom-engine'), false)
})

test('DSH ChangeResult application states (failed, cancelled, restart-required) and availability: missing are handled accurately', async (t) => {
  let nextResult = { changed: false, application: 'failed', stage: 'install', target: 'dsh-ego-browser', error: { code: 'operation-error', diagnostic: 'network down' } }
  let bundles = [
    { name: 'dsh-ego-browser', availability: 'missing', installed: false, enabled: false },
  ]
  const env = start({
    services: {
      pluginManager: {
        listBundles: async () => bundles,
        installBundle: async () => nextResult,
      },
    },
  })
  t.after(() => env.stop())
  await env.rt.load()

  // availability: 'missing' must NOT be treated as installed.
  const listed = await env.call('browser-backends')
  assert.equal(listed.value.dshPlugins.find(p => p.id === 'dsh:dsh-ego-browser').installed, false)

  // Failed install returns error, restores prior status (never stuck in loading), and does not change active backend.
  const failed = await env.call('browser-install-plugin', { id: 'dsh:dsh-ego-browser' })
  assert.equal(failed.ok, false)
  assert.match(failed.error.message, /network down/)
  assert.equal(env.rt.browserStatusView().state, 'ready')
  assert.equal(env.rt.browserStatusView().id, 'readonly')

  // Cancelled install also fails cleanly without activating.
  nextResult = { changed: false, application: 'cancelled', stage: 'install', target: 'dsh-ego-browser' }
  const cancelled = await env.call('browser-install-plugin', { id: 'dsh:dsh-ego-browser' })
  assert.equal(cancelled.ok, false)
  assert.match(cancelled.error.message, /cancelled/i)
  assert.equal(env.rt.browserStatusView().id, 'readonly')

  // Real DSH ChangeResult application === 'restart-required' with github spec resolves package name via result.target.
  nextResult = { changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'install', target: 'community-ego-fork' }
  bundles = [{ name: 'community-ego-fork', availability: 'profile', installed: true, enabled: true, version: '1.2.3' }]
  const installed = await env.call('browser-install-plugin', { spec: 'github:someone/community-ego-fork' })
  assert.equal(installed.ok, true)
  assert.equal(installed.value.active, 'dsh:community-ego-fork')
  assert.equal(installed.value.status.state, 'restart-needed')
  assert.equal(installed.value.restartRequired, true)
})

test('external DSH plugins never mask DS Bot own built-in tools and custom validation blocks catalog overwrites and bad commands', async (t) => {
  const bundles = [
    { name: 'community-playwright-extra', availability: 'profile', installed: true, enabled: true, version: '0.1.0' },
  ]
  const env = start({
    globalTools: ['browser_open', 'playwright_nav', 'read_browser'],
    services: {
      pluginManager: {
        listBundles: async () => bundles,
      },
    },
  })
  t.after(() => env.stop())
  await env.rt.load()
  const botAgent = await env.addAgent('b2')

  await env.call('browser-backends')
  await env.call('browser-set-backend', { id: 'builtin:refs' })
  env.rt.reapplyBrowserMasks()

  // External playwright_* tool is masked while built-in refs is active,
  // but DS Bot's own browser_open and read_browser are NEVER masked.
  assert.ok(botAgent.denied.has('playwright_nav'))
  assert.equal(botAgent.denied.has('browser_open'), false)
  assert.equal(botAgent.denied.has('read_browser'), false)

  // Custom DSH entry cannot overwrite a curated catalog ID, and MCP command rejects shell metacharacters.
  const dupCatalog = await env.call('browser-custom-save', { kind: 'dsh-plugin', name: 'Fake Ego', packageName: 'dsh-ego-browser' })
  assert.equal(dupCatalog.ok, false)
  const badCmd = await env.call('browser-custom-save', { kind: 'mcp', name: 'Bad', transport: 'stdio', command: 'npx;whoami' })
  assert.equal(badCmd.ok, false)
})

test('legacy browserPlugin: null and false leave interactive browsing off without throwing', async (t) => {
  for (const browserPlugin of [null, false, '']) {
    const env = start({ config: { browserPlugin } })
    t.after(() => env.stop())
    await env.rt.load()
    assert.equal(env.rt.browserStatusView().id, 'readonly')
    assert.equal(env.rt.browserStatusView().state, 'ready')
  }
})

test('installing one Ego plugin does not mark the sibling Ego plugin as installed or usable', async (t) => {
  const bundles = [
    { name: 'dsh-ego-browser', availability: 'profile', installed: true, enabled: true, version: '0.14.1' },
  ]
  const env = start({
    globalTools: ['ego_open', 'ego_click'],
    services: {
      pluginManager: {
        listBundles: async () => bundles,
      },
    },
  })
  t.after(() => env.stop())
  await env.rt.load()

  const listed = await env.call('browser-backends')
  const first = listed.value.dshPlugins.find(p => p.id === 'dsh:dsh-ego-browser')
  const second = listed.value.dshPlugins.find(p => p.id === 'dsh:@dshworks/dsh-ego-browser')
  assert.equal(first.installed, true)
  assert.equal(first.enabled, true)
  assert.equal(second.installed, false)
  assert.equal(second.enabled, false)
  assert.deepEqual(second.detectedTools, [])

  const pickSecond = await env.call('browser-set-backend', { id: 'dsh:@dshworks/dsh-ego-browser' })
  assert.equal(pickSecond.value.status.state, 'not-installed')
  assert.ok(env.rt.teamTools.some(tool => tool.name === 'read_browser'))
})

test('installing a custom GitHub DSH plugin reconciles guessed repo name with actual result.target package name', async (t) => {
  let bundles = []
  const env = start({
    services: {
      pluginManager: {
        listBundles: async () => bundles,
        installBundle: async () => {
          bundles = [{ name: '@example/browser-engine', availability: 'profile', installed: true, enabled: true, version: '0.2.0' }]
          env.servedList.push('acme_nav')
          return { changed: true, application: 'applied', stage: 'install', target: '@example/browser-engine' }
        },
      },
    },
  })
  t.after(() => env.stop())
  await env.rt.load()

  const saved = await env.call('browser-custom-save', {
    kind: 'dsh-plugin',
    name: 'Acme Engine',
    installSpec: 'github:example/browser-engine',
    toolPrefixes: 'acme_',
  })
  assert.equal(saved.ok, true)
  const guessed = saved.value.dshPlugins.find(p => p.name === 'Acme Engine')
  assert.equal(guessed.id, 'dsh:browser-engine')

  const installed = await env.call('browser-install-plugin', { id: guessed.id })
  assert.equal(installed.ok, true)
  assert.equal(installed.value.active, 'dsh:@example/browser-engine')
  assert.equal(installed.value.status.state, 'ready')
  const updated = installed.value.dshPlugins.find(p => p.id === 'dsh:@example/browser-engine')
  assert.equal(updated.name, 'Acme Engine')
  assert.equal(updated.installed, true)
  assert.deepEqual(updated.toolPrefixes, ['acme_'])
  assert.equal(installed.value.dshPlugins.some(p => p.id === 'dsh:browser-engine'), false)
})

test('late-registered native provider reconciles from readonly fallback without bouncing unrelated active backends', async (t) => {
  const team = { ...TEAM, browser: { active: 'provider:late-engine' } }
  const env = start({ team })
  t.after(() => env.stop())
  await env.rt.load()
  // Allow startup reconciliation to settle into readonly fallback.
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(env.rt.browserStatusView().id, 'readonly')
  assert.equal(env.rt.browserStatusView().state, 'ready')

  let mounts = 0
  const unregister = env.rt.dsBotBrowser.registerProvider(defineBrowserProvider({
    id: 'provider:late-engine',
    name: 'Late Engine',
    mount() {
      mounts += 1
      return { dispose() {} }
    },
  }))
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(env.rt.browserStatusView().id, 'provider:late-engine')
  assert.equal(env.rt.browserStatusView().state, 'ready')
  assert.equal(mounts, 1)

  // Registering and unregistering an unrelated provider must NOT remount the active provider.
  const dropOther = env.rt.dsBotBrowser.registerProvider(defineBrowserProvider({
    id: 'provider:unrelated',
    name: 'Unrelated',
    mount() { return { dispose() {} } },
  }))
  await new Promise(resolve => setTimeout(resolve, 25))
  dropOther()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(mounts, 1)

  // Temporarily unregistering and re-registering the active provider recovers it automatically.
  unregister()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(env.rt.browserStatusView().id, 'readonly')
  env.rt.dsBotBrowser.registerProvider(defineBrowserProvider({
    id: 'provider:late-engine',
    name: 'Late Engine',
    mount() {
      mounts += 1
      return { dispose() {} }
    },
  }))
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(env.rt.browserStatusView().id, 'provider:late-engine')
  assert.equal(mounts, 2)
})

test('failed native provider mount cleans up partially registered tools on sync throw and async rejection', async (t) => {
  const env = start()
  t.after(() => env.stop())
  await env.rt.load()
  const botAgent = await env.addAgent('b2')

  const makeTool = (host, name) => host.defineTool({
    name,
    description: 'temp tool',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute() { return 'ok' },
  })

  env.rt.dsBotBrowser.registerProvider(defineBrowserProvider({
    id: 'provider:sync-boom',
    name: 'Sync Boom',
    mount(host) {
      host.registerTool(makeTool(host, 'sync_leak_tool'))
      throw new Error('sync init failed')
    },
  }))
  env.rt.dsBotBrowser.registerProvider(defineBrowserProvider({
    id: 'provider:async-boom',
    name: 'Async Boom',
    async mount(host) {
      host.registerTool(makeTool(host, 'async_leak_tool'))
      throw new Error('async init failed')
    },
  }))

  const syncRes = await env.call('browser-set-backend', { id: 'provider:sync-boom' })
  assert.equal(syncRes.value.status.state, 'error')
  assert.equal(env.rt.teamTools.some(tool => tool.name === 'sync_leak_tool'), false)
  assert.equal(botAgent.registered.has('sync_leak_tool'), false)

  const asyncRes = await env.call('browser-set-backend', { id: 'provider:async-boom' })
  assert.equal(asyncRes.value.status.state, 'error')
  assert.equal(env.rt.teamTools.some(tool => tool.name === 'async_leak_tool'), false)
  assert.equal(botAgent.registered.has('async_leak_tool'), false)
})

test('removing an active custom DSH plugin keeps its non-inferable tool prefixes masked while bundle stays installed', async (t) => {
  const bundles = [
    { name: 'acme-custom-driver', availability: 'profile', installed: true, enabled: true, version: '1.0.0' },
  ]
  const env = start({
    globalTools: ['acme_click', 'acme_open'],
    services: {
      pluginManager: {
        listBundles: async () => bundles,
      },
    },
  })
  t.after(() => env.stop())
  await env.rt.load()
  const botAgent = await env.addAgent('b2')

  const added = await env.call('browser-custom-save', {
    kind: 'dsh-plugin',
    name: 'Acme Driver',
    packageName: 'acme-custom-driver',
    toolPrefixes: 'acme_',
    activate: true,
  })
  assert.equal(added.ok, true)
  assert.equal(added.value.status.state, 'ready')
  assert.equal(botAgent.denied.has('acme_click'), false)

  const removed = await env.call('browser-custom-remove', { id: 'dsh:acme-custom-driver' })
  assert.equal(removed.ok, true)
  assert.equal(removed.value.active, 'readonly')
  assert.ok(botAgent.denied.has('acme_click'))
  assert.ok(botAgent.denied.has('acme_open'))
})

test('retry while restart-needed preserves restart-needed state and keeps read_browser visible', async (t) => {
  const bundles = []
  const env = start({
    services: {
      pluginManager: {
        listBundles: async () => bundles,
        installBundle: async () => {
          bundles.push({ name: 'dsh-ego-browser', availability: 'profile', installed: true, enabled: true, version: '0.14.1' })
          return { changed: true, application: 'restart-required', stage: 'install', target: 'dsh-ego-browser' }
        },
      },
    },
  })
  t.after(() => env.stop())
  await env.rt.load()

  const installed = await env.call('browser-install-plugin', { id: 'dsh:dsh-ego-browser' })
  assert.equal(installed.value.status.state, 'restart-needed')
  assert.ok(env.rt.teamTools.some(tool => tool.name === 'read_browser'))

  const retried = await env.call('browser-retry')
  assert.equal(retried.ok, true)
  assert.equal(retried.value.status.state, 'restart-needed')
  assert.ok(env.rt.teamTools.some(tool => tool.name === 'read_browser'))
})

test('MCP argument splitting preserves quoted paths, blocks plaintext credentials, redacts views, and handles missing npx', async (t) => {
  // Quoted args parsing without shell invocation.
  assert.deepEqual(
    splitArgs('--user-data-dir="/Users/example/Browser Profiles" --flag=\'a b\' plain'),
    ['--user-data-dir=/Users/example/Browser Profiles', '--flag=a b', 'plain'],
  )
  assert.throws(() => splitArgs('--dir="/unterminated'), /Unclosed quote/)

  // Desktop bundled pnpm fallback and clear missing-npx error.
  const desktopLaunch = resolveStdioCommand('npx', ['-y', '@playwright/mcp@latest'], { FOO: '1' }, {
    env: { PATH: '', DS_BOT_APP: '1' },
    argv: ['node', 'host.mjs', '/app/node_modules/pnpm/bin/pnpm.mjs'],
    execPath: '/app/Electron',
    exists: path => path === '/app/node_modules/pnpm/bin/pnpm.mjs',
  })
  assert.equal(desktopLaunch.command, '/app/Electron')
  assert.deepEqual(desktopLaunch.args, ['--expose-internals', '/app/node_modules/pnpm/bin/pnpm.mjs', 'dlx', '@playwright/mcp@latest'])
  assert.equal(desktopLaunch.env.ELECTRON_RUN_AS_NODE, '1')

  assert.throws(() => resolveStdioCommand('npx', ['-y', '@playwright/mcp@latest'], {}, {
    env: { PATH: '' },
    argv: ['node', 'host.mjs'],
    exists: () => false,
  }), /npx.*not found/i)

  // View sanitization redacts pre-existing plaintext secrets while preserving $DSH_SECRET_* references.
  const sanitized = sanitizeMcpForView({
    url: 'https://alice:hunter2@mcp.example.com/mcp?api_key=sk-123&mode=fast',
    headers: { Authorization: 'Bearer raw-secret', 'X-Ref': 'Bearer $DSH_SECRET_TOKEN' },
    env: { RAW: 'plain', REF: '$DSH_SECRET_KEY' },
  })
  assert.equal(sanitized.url.includes('hunter2'), false)
  assert.equal(sanitized.url.includes('sk-123'), false)
  assert.equal(sanitized.headers.Authorization, '[configured]')
  assert.equal(sanitized.headers['X-Ref'], 'Bearer $DSH_SECRET_TOKEN')
  assert.equal(sanitized.env.RAW, '[configured]')
  assert.equal(sanitized.env.REF, '$DSH_SECRET_KEY')

  // Endpoint rejects plaintext URL/query/header credentials and allows $DSH_SECRET_* refs.
  let importAttempts = 0
  const env = start({
    services: {
      loader: {
        import: async () => {
          importAttempts += 1
          if (importAttempts === 1) throw new Error('transient import error')
          return { name: 'recovered-mcp' }
        },
      },
    },
  })
  t.after(() => env.stop())
  await env.rt.load()

  const badUserinfo = await env.call('browser-custom-save', { kind: 'mcp', name: 'Leak1', transport: 'streamable-http', url: 'https://user:pass@example.com/mcp' })
  assert.equal(badUserinfo.ok, false)
  assert.match(badUserinfo.error.message, /\$DSH_SECRET_NAME/)

  const badQuery = await env.call('browser-custom-save', { kind: 'mcp', name: 'Leak2', transport: 'streamable-http', url: 'https://example.com/mcp?api_key=sk-live' })
  assert.equal(badQuery.ok, false)

  const badHeader = await env.call('browser-custom-save', { kind: 'mcp', name: 'Leak3', transport: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer sk-live' } })
  assert.equal(badHeader.ok, false)

  const goodSecretRef = await env.call('browser-custom-save', { kind: 'mcp', name: 'Safe', transport: 'streamable-http', url: 'https://example.com/mcp?api_key=$DSH_SECRET_BROWSER_KEY', headers: { Authorization: 'Bearer $DSH_SECRET_BROWSER_KEY' } })
  assert.equal(goodSecretRef.ok, true)

  // MCP loader does not permanently cache a rejected import promise: retry recovers.
  const firstTry = await env.call('browser-set-backend', { id: 'mcp:playwright-mcp' })
  assert.equal(firstTry.value.status.state, 'error')
  const secondTry = await env.call('browser-retry')
  assert.equal(secondTry.ok, true)
  assert.equal(secondTry.value.status.state, 'ready')
  assert.equal(importAttempts, 2)
})


