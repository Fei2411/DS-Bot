import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { classify, levelAllows, isComputerTool } from '../src/host/computer/catalog.js'
import { createLeases } from '../src/host/computer/leases.js'
import { isProtectedApp } from '../src/host/computer/index.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w1', name: 'Writer', role: '', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function setup({ team = TEAM, services = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-computer-'))
  if (team !== undefined) {
    const { writeFileSync } = process.getBuiltinModule('node:fs')
    writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  }
  const ctx = fakeContext({ services })
  const rt = createRuntime(ctx, { home })
  return { ctx, home, rt }
}

test('the catalog classifies every provider call into observe, background, foreground', () => {
  // cua observe
  for (const method of ['getCapabilities', 'listApps', 'findApps', 'getApp', 'listWindows', 'getState', 'listActions', 'screenshot', 'permissionStatus', 'applicationIcons']) {
    assert.deepEqual(classify('cua', { method }), { provider: 'cua', kind: 'observe', method })
  }
  // cua foreground: activate, hover, mouseMove with useSystemPointer, and the permission UI
  for (const method of ['activate', 'hover', 'requestPermission', 'openPermissionSettings']) {
    assert.equal(classify('cua', { method }).kind, 'foreground')
  }
  assert.equal(classify('cua', { method: 'mouseMove', params: { useSystemPointer: true } }).kind, 'foreground')
  // cua background input (including AX-only mouseMove)
  for (const method of ['click', 'scroll', 'drag', 'setValue', 'selectText', 'invoke', 'performAction', 'performSecondaryAction', 'typeText', 'paste', 'pressKey', 'sendKeyEvent', 'show', 'launchApp', 'mouseMove']) {
    assert.equal(classify('cua', { method }).kind, 'background')
  }
  assert.equal(classify('cua', { method: 'mouseMove', params: { useSystemPointer: false } }).kind, 'background')
  // unknown methods fail closed to foreground
  assert.equal(classify('cua', { method: 'reboot' }).kind, 'foreground')
  assert.equal(classify('cua', {}).kind, 'foreground')
  // cua-driver read-only names
  for (const name of ['list_apps', 'list_windows', 'get_window_state', 'get_accessibility_tree', 'verify_state', 'parse_visual_regions', 'get_desktop_state', 'get_screen_size', 'get_cursor_position', 'zoom', 'debug_window_info', 'get_browser_state', 'get_session', 'list_sessions', 'get_session_state', 'get_agent_cursor_state', 'get_recording_state', 'get_config', 'check_permissions', 'health_report']) {
    assert.equal(classify(`cua_driver_native__${name}`, {}).kind, 'observe', name)
  }
  // driver foreground: window raising and cursor-moving names, and an explicit ask
  for (const name of ['bring_to_front', 'move_cursor', 'escalate_session', 'set_agent_cursor_enabled']) {
    assert.equal(classify(`cua_driver_native__${name}`, {}).kind, 'foreground', name)
  }
  for (const name of ['click', 'double_click', 'right_click', 'drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'launch_app', 'kill_app', 'invoke_menu', 'browser_click', 'browser_type']) {
    assert.equal(classify(`cua_driver_native__${name}`, {}).kind, 'background', name)
  }
  assert.equal(classify('cua_driver_native__click', { foreground: true }).kind, 'foreground')
  assert.equal(classify('cua_driver_native__mystery', {}).kind, 'foreground')
  // not a computer tool
  assert.equal(classify('message_bot', {}), undefined)
  assert.equal(isComputerTool('cua'), true)
  assert.equal(isComputerTool('cua_driver_native__click'), true)
  assert.equal(isComputerTool('schedule_list'), false)
})

test('levels admit their kinds and nothing above', () => {
  assert.equal(levelAllows('off', 'observe'), false)
  assert.equal(levelAllows('view', 'observe'), true)
  assert.equal(levelAllows('view', 'background'), false)
  assert.equal(levelAllows('background', 'background'), true)
  assert.equal(levelAllows('background', 'foreground'), false)
  assert.equal(levelAllows('foreground', 'foreground'), true)
})

test('leases: one Bot per app, release on turn end, idle and release', async () => {
  const leases = createLeases({ idleMs: 50 })
  assert.equal(leases.takeApp('notes', 'w1', 'w1'), undefined)
  const held = leases.takeApp('notes', 'm1', 'm1')
  assert.equal(held.botId, 'w1')
  // same Bot refreshes its lease
  assert.equal(leases.takeApp('notes', 'w1', 'w1'), undefined)
  // turn end releases
  leases.endSession('w1')
  assert.equal(leases.takeApp('notes', 'm1', 'm1'), undefined)
  // foreground is one Bot at a time
  assert.equal(leases.takeForeground('m1', 'm1'), undefined)
  assert.equal(leases.takeForeground('w1', 'w1').botId, 'm1')
  // release all of a Bot's leases on stop
  leases.releaseBot('m1')
  assert.equal(leases.takeApp('notes', 'w1', 'w1'), undefined)
  assert.equal(leases.takeForeground('w1', 'w1'), undefined)
  // idle release
  assert.equal(leases.takeApp('mail', 'w1', 'w1'), undefined)
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(leases.takeApp('mail', 'm1', 'm1'), undefined)
  leases.dispose()
})

test('protected apps match by id, name and executable', () => {
  for (const app of [
    { id: 'io.github.fei2411.dsbot' },
    { id: 'com.deepseek.harness.computer-use.dev' },
    { id: 'com.apple.systempreferences' },
    { id: 'com.apple.keychainaccess' },
    { name: 'DS Bot' },
    { name: 'DSH Computer Use' },
    { name: 'DSH Computer Use Dev' },
    { name: 'DeepSeek Harness' },
    { name: 'Keychain Access' },
    { name: 'Credential Manager' },
    { path: '/Applications/DSH Computer Use.app/Contents/MacOS/dsh-cua-native' },
    { path: 'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe' },
  ]) assert.equal(isProtectedApp(app), true, JSON.stringify(app))
  assert.equal(isProtectedApp({ name: 'Notes' }), false)
  assert.equal(isProtectedApp({ id: 'com.apple.Notes' }), false)
  assert.equal(isProtectedApp({ name: 'Mail', path: '/Applications/Mail.app' }), false)
})

test('the guard refuses in order: switch, Bot, level, control, protected, consent, lease, user idle', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  // state with the switch off
  await rt.load()
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const allow = async () => 'allowed'
  const call = (sessionId, name, args = {}) => gate({ name, arguments: args, agent: { id: sessionId }, callId: `c-${sessionId}` }, allow)
  // off: refused before anything else
  assert.equal((await call('w1', 'cua', { method: 'click', params: {} })).kind, 'deny')
  // turn it on through the endpoint like the switch does
  await rt.computerEndpoint('set-enabled', { enabled: true })
  // view level: reads pass, input does not
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'view' })
  assert.equal(await call('w1', 'cua', { method: 'getState', params: {} }), 'allowed')
  assert.equal((await call('w1', 'cua', { method: 'click', params: {} })).kind, 'deny')
  // background: clicks pass, foreground does not
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  assert.equal(await call('w1', 'cua', { method: 'click', params: {} }), 'allowed')
  assert.equal((await call('w1', 'cua', { method: 'activate', params: {} })).kind, 'deny')
  // foreground level allows it
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'foreground' })
  assert.equal(await call('w1', 'cua', { method: 'activate', params: {} }), 'allowed')
  // a protected app is refused even at getApp
  const denied = await call('w1', 'cua', { method: 'getApp', params: { selector: 'DSH Computer Use' } })
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /protected/)
  // another Bot holds the app lease: the refusal names it
  await rt.computerEndpoint('set-level', { botId: 'm1', level: 'background' })
  const [track] = ctx.listeners.get('tools/execute').filter(fn => fn.name === 'computerTrack')
  // w1 holds an Always grant for Notes, so its calls on the handle are allowed.
  const w1 = rt.botOf('w1')
  w1.computer = { ...w1.computer, apps: { 'com.apple.Notes': { name: 'Notes', id: 'com.apple.Notes', grantedAt: 0 } } }
  await track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: 'w1' }, callId: 'get-1' },
    async () => ({ isError: false, value: { appHandle: 'h1', pid: 42, authorization: { id: 'com.apple.Notes', name: 'Notes' } } }))
  assert.equal(await call('w1', 'cua', { method: 'click', params: { appHandle: 'h1' } }), 'allowed')
  // m1 sees the same app through its own getApp; its call is refused and names w1.
  const m1 = rt.botOf('m1')
  m1.computer = { ...m1.computer, apps: { 'com.apple.Notes': { name: 'Notes', id: 'com.apple.Notes', grantedAt: 0 } } }
  await track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: 'm1' }, callId: 'get-2' },
    async () => ({ isError: false, value: { appHandle: 'h1', pid: 42, authorization: { id: 'com.apple.Notes', name: 'Notes' } } }))
  const blocked = await call('m1', 'cua', { method: 'click', params: { appHandle: 'h1' } })
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /Writer is using Notes/)
  // A call another Bot's lease refuses takes no lease of its own.
  const other = await call('w1', 'cua', { method: 'click', params: { appHandle: 'h1' } })
  assert.equal(other, 'allowed')
})

test('cua-driver consent: first call asks, This time lasts the session, Deny refuses it', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const allow = async () => 'allowed'
  const call = (sessionId, name, args = {}) => gate({ name, arguments: args, agent: { id: sessionId }, callId: `c-${sessionId}` }, allow)
  // unknown pid: refused until the Bot lists windows
  const unknown = await call('w1', 'cua_driver_native__click', { pid: 42 })
  assert.equal(unknown.kind, 'deny')
  assert.match(unknown.reason, /list/i)
  // record the pid through a list result
  const execute = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  await execute({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'list-1' }, async () => ({ windows: [{ pid: 42, name: 'Notes', path: '/Applications/Notes.app' }] }))
  // the first input call opens an ask; answering resolves it
  const pending = call('w1', 'cua_driver_native__click', { pid: 42 })
  await new Promise(resolve => setImmediate(resolve))
  const asks = rt.computerLive().asks
  assert.equal(Object.keys(asks).length, 1)
  const ask = Object.values(asks)[0]
  const id = ask.id // the card answers with the id inside the payload, not the map key
  assert.equal(typeof id, 'string')
  assert.equal(ask.appName, 'Notes')
  assert.equal(await rt.computerEndpoint('app-answer', { id, answer: 'once' }), true)
  assert.equal(await pending, 'allowed')
  // same session asks no more for the allowed app; another app asks again
  assert.equal(await call('w1', 'cua_driver_native__click', { pid: 42 }), 'allowed')
  await execute({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'list-2' }, async () => ({ windows: [{ pid: 43, name: 'Mail' }] }))
  const denied = call('w1', 'cua_driver_native__type_text', { pid: 43 })
  await new Promise(resolve => setImmediate(resolve))
  const ask2 = Object.entries(rt.computerLive().asks)[0]
  assert.notEqual(ask2, undefined)
  await rt.computerEndpoint('app-answer', { id: ask2[0], answer: 'deny' })
  assert.equal((await denied).kind, 'deny')
})

test('macOS consent answerer: grants allow, the card answers, Always records, DSH Always is never returned', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  const answerer = ctx.listeners.get('user-questions/request').find(fn => fn.name === 'computerConsent')
  const ask = (sessionId, name = 'Notes') => answerer({
    agent: { id: sessionId },
    questions: [{ id: 'cua-app-access', intent: { subject: { name } }, options: [{ label: 'Allow for this session' }, { label: 'Deny' }] }],
  }, async () => 'next')
  // non-Bot sessions pass through
  assert.equal(await ask('plain'), 'next')
  // a protected name denies without a card
  assert.deepEqual(await ask('w1', 'Keychain Access'), { answers: [{ id: 'cua-app-access', selected: ['Deny'] }] })
  // the card answers This time
  const pending = ask('w1')
  await new Promise(resolve => setImmediate(resolve))
  const shown = Object.values(rt.computerLive().asks)[0]
  const id = shown.id
  assert.equal(typeof id, 'string')
  assert.equal(shown.appName, 'Notes')
  await rt.computerEndpoint('app-answer', { id, answer: 'once' })
  assert.deepEqual(await pending, { answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
  // Always records the grant and still answers session-allow
  const pending2 = ask('w1', 'Mail')
  await new Promise(resolve => setImmediate(resolve))
  const [id2] = Object.entries(rt.computerLive().asks)[0]
  await rt.computerEndpoint('app-answer', { id: id2, answer: 'always' })
  const answer2 = await pending2
  assert.equal(answer2.answers[0].selected[0], 'Allow for this session')
  assert.notEqual(answer2.answers[0].selected[0], 'Always allow')
  // a later ask for the same app is auto-allowed by the grant
  assert.deepEqual(await ask('w1', 'Mail'), { answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
  assert.equal(rt.botOf('w1').computer.apps['mail']?.name, 'Mail')
  // 0.2.2-rc.2 mouse-control consent follows the Bot's foreground level without hanging on DSH's card
  const askMouse = sessionId => answerer({
    agent: { id: sessionId },
    questions: [{ id: 'cua-mouse-control', intent: { kind: 'approval', approve: 'Allow for this session', reject: 'Deny' }, options: [{ label: 'Allow for this session' }, { label: 'Deny' }] }],
  }, async () => 'next')
  assert.equal(await askMouse('plain'), 'next')
  assert.deepEqual(await askMouse('w1'), { answers: [{ id: 'cua-mouse-control', selected: ['Deny'] }] })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'foreground' })
  assert.deepEqual(await askMouse('w1'), { answers: [{ id: 'cua-mouse-control', selected: ['Allow for this session'] }] })
})

// A fake Cordis plugin mount + the registry the provider registers on.
function withProvider(ctx, services, { providerName } = {}) {
  const fibers = []
  ctx.plugin = (module, config) => {
    const entry = { module, config }
    fibers.push(entry)
    // The registry mount brings the service up; only the provider mount names a provider.
    if (String(module?.name ?? '').includes('experimental')) {
      services.computerUse ??= { providerName: undefined }
      services.computerUse.providerName = providerName ?? 'fake-provider'
    } else services.computerUse ??= { providerName: undefined }
    return {
      await: async () => {},
      dispose: async () => { const index = fibers.indexOf(entry); if (index >= 0) fibers.splice(index, 1) },
    }
  }
  return fibers
}

test('the provider mounts when the switch comes on and reports its status', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const services = {}
  ctx.get = name => services[name]
  services.loader = { import: async name => ({ name }) }
  services.agents = { list: () => [] }
  const fibers = withProvider(ctx, services)
  await rt.load()
  assert.deepEqual(rt.computerStatus().state, 'off')
  await rt.computerEndpoint('set-enabled', { enabled: true })
  // provider-retry joins the mount that set-enabled started
  await rt.computerEndpoint('provider-retry', {})
  assert.deepEqual(rt.computerStatus(), { state: 'ready', name: 'fake-provider' })
  // registry + provider fibers mounted, provider with the platform config
  assert.equal(fibers.length, 2)
  assert.deepEqual(fibers[1].config, process.platform === 'darwin' ? { agentPreset: false } : {})
  // switching off disposes the provider
  await rt.computerEndpoint('set-enabled', { enabled: false })
  assert.deepEqual(rt.computerStatus(), { state: 'off' })
  assert.equal(fibers.length, 0)
})

test('provider status: occupied, missing, unsupported, error and retry', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const services = {}
  ctx.get = name => services[name]
  services.loader = { import: async name => { if (name.includes('missing')) throw new Error('Cannot find package') ; return { name } } }
  services.agents = { list: () => [] }
  withProvider(ctx, services)
  // occupied: another provider is already registered
  services.computerUse = { providerName: 'other-provider' }
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('provider-retry', {})
  assert.deepEqual(rt.computerStatus(), { state: 'occupied', name: 'other-provider' })
  services.computerUse.providerName = undefined
  await rt.computerEndpoint('provider-retry', {})
  assert.equal(rt.computerStatus().state, 'ready')
  // missing: the package cannot be imported; the fake registry keeps its name field
  services.computerUse.providerName = undefined
  services.loader = { import: async () => { throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }) } }
  await rt.computerEndpoint('provider-retry', {})
  assert.equal(rt.computerStatus().state, 'missing')
  // the status says what to install, at the running DSH's version (#1050)
  const { install } = rt.computerStatus()
  assert.equal(install.packages.length, 1)
  assert.match(install.packages[0], /^@deepseek-ai\/dsh-experimental-[\w-]+@\d/)
  assert.equal(install.command, `pnpm add ${install.packages[0]}`)
  // without the registry both packages are missing, and the profile folder is named
  services.profileContext = { dir: '/profiles/desktop' }
  services.computerUse = undefined
  await rt.computerEndpoint('provider-retry', {})
  const both = rt.computerStatus().install
  assert.match(both.packages[0], /^@deepseek-ai\/dsh-computer-use@/)
  assert.equal(both.packages.length, 2)
  assert.equal(both.command, `pnpm --dir "/profiles/desktop" add ${both.packages.join(' ')}`)
  services.computerUse = { providerName: undefined }
  // error: any other import failure
  services.loader = { import: async () => { throw new Error('boom') } }
  await rt.computerEndpoint('provider-retry', {})
  assert.equal(rt.computerStatus().state, 'error')
})

test('masking: non-Bot agents and off Bots lose the tools and the sections', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const denied = []
  const scoped = []
  const makeAgent = id => ({
    id, session: { id },
    ctx: {
      tools: { register: tool => { ctx.registeredTools.set(tool.name, tool); return () => {} }, restrict: filter => { denied.push([id, filter.deny]); return () => {} } },
      on: (event, listener) => { scoped.push({ id, event, listener }); return () => {} },
      effect: () => {},
    },
  })
  const services = { loader: { import: async name => ({ name }) }, agents: { list: () => [] } }
  ctx.get = name => services[name]
  withProvider(ctx, services)
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('provider-retry', {})
  const w1 = makeAgent('w1')
  const plain = makeAgent('plain')
  ctx.tools.schemas = () => [{ name: 'cua' }, { name: 'bash' }]
  services.agents = { list: () => [w1, plain] }
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'off' })
  // both masked: w1 is off, plain is not a Bot
  assert.deepEqual(denied.map(([id, deny]) => [id, deny]), [['w1', ['cua']], ['plain', ['cua']]])
  // w1 at view loses its mask but keeps the handoff tool off until background
  const registeredBefore = ctx.registeredTools.size
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'view' })
  assert.equal(ctx.registeredTools.has('computer_handoff'), true)
  assert.ok(ctx.registeredTools.size > registeredBefore)
})

const gateOf = ctx => {
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  return (sessionId, name, args = {}) => gate({ name, arguments: args, agent: { id: sessionId }, callId: `c-${sessionId}` }, async () => 'allowed')
}
const maskingAgent = (ctx, id, denied) => ({
  id, session: { id },
  ctx: {
    tools: { register: tool => { ctx.registeredTools.set(tool.name, tool); return () => {} }, restrict: filter => { denied.push([id, filter.deny]); return () => {} } },
    on: () => () => {},
    effect: () => {},
  },
})

test('a plain Session keeps DSH\'s own computer use while the DS Bot switch is off (#1101)', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const denied = []
  const services = { agents: { list: () => [] } }
  ctx.get = name => services[name]
  await rt.load()
  ctx.tools.schemas = () => [{ name: 'cua' }, { name: 'bash' }]
  const call = gateOf(ctx)
  assert.equal(await call('plain', 'cua', { method: 'click', params: {} }), 'allowed')
  assert.equal((await call('w1', 'cua', { method: 'click', params: {} })).kind, 'deny')
  services.agents = { list: () => [maskingAgent(ctx, 'w1', denied), maskingAgent(ctx, 'plain', denied)] }
  rt.refreshComputer()
  assert.deepEqual(denied, [['w1', ['cua']]])
})

test('with DSH\'s own provider in place Bots are refused and a plain Session is not', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const services = { loader: { import: async name => ({ name }) }, agents: { list: () => [] }, computerUse: { providerName: 'dsh-cua' } }
  ctx.get = name => services[name]
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('provider-retry', {})
  assert.equal(rt.computerStatus().state, 'occupied')
  const call = gateOf(ctx)
  assert.equal(await call('plain', 'cua', { method: 'click', params: {} }), 'allowed')
  assert.equal((await call('w1', 'cua', { method: 'getState', params: {} })).kind, 'deny')
})

test('a plain Session is refused on the provider DS Bot mounted', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const services = { loader: { import: async name => ({ name }) }, agents: { list: () => [] } }
  ctx.get = name => services[name]
  withProvider(ctx, services)
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('provider-retry', {})
  assert.equal(rt.computerStatus().state, 'ready')
  assert.equal((await gateOf(ctx)('plain', 'cua', { method: 'click', params: {} })).kind, 'deny')
})

test('Windows Bots that can operate apps are told how input really lands', async (t) => {
  const { ctx, home, rt } = setup()
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  t.after(async () => { Object.defineProperty(process, 'platform', platform); await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const services = { loader: { import: async name => ({ name }) }, agents: { list: () => [] } }
  ctx.get = name => services[name]
  withProvider(ctx, services)
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('provider-retry', {})
  const text = () => ctx.sections.get('computer-use:ds-bot').text({ agent: { id: 'w1' } })
  assert.match(text(), /If the text field supports set_value/)
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'view' })
  assert.doesNotMatch(text(), /set_value/)
})

test('the helper is protected by its real bundle id', async () => {
  const { isProtectedApp } = await import('../src/host/computer/index.js')
  assert.equal(isProtectedApp({ id: 'com.deepseek.harness.computer-use' }), true)
})

test('the ds-bot section is empty for a non-Bot, off, or provider-not-ready agent', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const services = { loader: { import: async name => ({ name }) }, agents: { list: () => [] } }
  ctx.get = name => services[name]
  withProvider(ctx, services)
  await rt.load()
  const section = ctx.sections.get('computer-use:ds-bot')
  const text = agent => section.text({ agent: { id: agent } })
  assert.equal(text('w1'), '')
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('provider-retry', {})
  assert.match(text('w1'), /## Using the computer/)
  assert.equal(text('plain'), '')
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'off' })
  assert.equal(text('w1'), '')
})

test('a revoke removes the grant, aborts the call, revokes in the provider and the guard refuses the handle', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const revoked = []
  const services = { loader: { import: async name => ({ name }) }, agents: { list: () => [] }, cuaAccess: { applications: async () => ({ allowedApps: [{ id: 'hash-notes', name: 'Notes', executablePath: '/Applications/Notes.app/Contents/MacOS/Notes' }], blockedApps: [], persistentAvailable: true }), revoke: async id => revoked.push(id) } }
  ctx.get = name => services[name]
  withProvider(ctx, services)
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  // the Bot got a name-only Always grant, then getApp returned the id
  const bot = rt.botOf('w1')
  bot.computer = { ...bot.computer, apps: { notes: { name: 'Notes', grantedAt: 0 } } }
  await track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: 'w1' }, callId: 'g1' },
    async () => ({ isError: false, value: { appHandle: 'h1', pid: 9, authorization: { id: 'com.apple.Notes', name: 'Notes', executablePath: '/Applications/Notes.app/Contents/MacOS/Notes' } } }))
  // the grant learned the id
  assert.equal(rt.botOf('w1').computer.apps.notes.id, 'com.apple.Notes')
  const allow = async () => 'allowed'
  const call = args => gate({ name: 'cua', arguments: args, agent: { id: 'w1' }, callId: 'c1' }, allow)
  assert.equal(await call({ method: 'click', params: { appHandle: 'h1' } }), 'allowed')
  // revoke: grant gone, provider revoked, the old handle asks again instead of running
  assert.equal(await rt.computerEndpoint('revoke-app', { botId: 'w1', appKey: 'notes' }), true)
  assert.equal(rt.botOf('w1').computer.apps, undefined)
  assert.deepEqual(revoked, ['hash-notes'])
  // the recorded handle is gone, so the next call refuses revoked, not a card
  assert.match((await call({ method: 'click', params: { appHandle: 'h1' } })).reason, /was revoked/)
  // a fresh getApp asks through the card again
  const answerer = ctx.listeners.get('user-questions/request').find(fn => fn.name === 'computerConsent')
  void answerer({ agent: { id: 'w1' }, questions: [{ id: 'cua-app-access', intent: { subject: { name: 'Notes' } }, options: [] }] }, async () => 'next')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Object.keys(rt.computerLive().asks).length, 1)
})

test("one Bot's revoke leaves another Bot's handle working", async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  await rt.computerEndpoint('set-level', { botId: 'm1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  for (const botId of ['w1', 'm1']) {
    rt.botOf(botId).computer = { apps: { 'com.apple.Notes': { name: 'Notes', id: 'com.apple.Notes', grantedAt: 0 } } }
  }
  await track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: 'w1' }, callId: 'g1' },
    async () => ({ isError: false, value: { appHandle: 'hA', pid: 1, authorization: { id: 'com.apple.Notes', name: 'Notes' } } }))
  await track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: 'm1' }, callId: 'g2' },
    async () => ({ isError: false, value: { appHandle: 'hB', pid: 2, authorization: { id: 'com.apple.Notes', name: 'Notes' } } }))
  await rt.computerEndpoint('revoke-app', { botId: 'w1', appKey: 'com.apple.Notes' })
  // w1's handle is dead; m1's still resolves and runs
  assert.match((await gate({ name: 'cua', arguments: { method: 'click', params: { appHandle: 'hA' } }, agent: { id: 'w1' }, callId: 'c1' }, allow)).reason, /was revoked/)
  assert.equal(await gate({ name: 'cua', arguments: { method: 'click', params: { appHandle: 'hB' } }, agent: { id: 'm1' }, callId: 'c2' }, allow), 'allowed')
})

test('grants hold in a later part and in a group Session of the same Bot', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const services = { loader: { import: async name => ({ name }) }, agents: { list: () => [] } }
  ctx.get = name => services[name]
  withProvider(ctx, services)
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const bot = rt.botOf('w1')
  bot.computer = { ...bot.computer, apps: { 'com.apple.Notes': { name: 'Notes', id: 'com.apple.Notes', grantedAt: 0 } } }
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const allow = async () => 'allowed'
  // another Session of the same Bot (a later part, or its group Session) sees the app
  const other = 'w1-group'
  rt.isBotSession = id => id === 'w1' || id === other
  const selfOf = rt.selfOf
  rt.selfOf = id => (id === other ? 'w1' : selfOf(id))
  await track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: other }, callId: 'g' },
    async () => ({ isError: false, value: { appHandle: 'h2', authorization: { id: 'com.apple.Notes', name: 'Notes' } } }))
  assert.equal(await gate({ name: 'cua', arguments: { method: 'click', params: { appHandle: 'h2' } }, agent: { id: other }, callId: 'c' }, allow), 'allowed')
})

test('getApp refuses a protected selector by bundle id', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'foreground' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const denied = await gate({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'com.apple.systempreferences' } }, agent: { id: 'w1' }, callId: 'c' }, async () => 'allowed')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /protected/)
})

test('leases release at turn end, stop and takeover; user-busy gates foreground', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'foreground' })
  await rt.computerEndpoint('set-level', { botId: 'm1', level: 'foreground' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const allow = async () => 'allowed'
  const call = (sessionId, args) => gate({ name: 'cua', arguments: args, agent: { id: sessionId }, callId: `c-${sessionId}` }, allow)
  const grant = (botId) => { const bot = rt.botOf(botId); bot.computer = { ...bot.computer, apps: { notes: { name: 'Notes', grantedAt: 0 } } } }
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const seed = async sessionId => track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: sessionId }, callId: `g-${sessionId}` },
    async () => ({ isError: false, value: { appHandle: `h-${sessionId}`, authorization: { name: 'Notes' } } }))
  grant('w1'); grant('m1')
  await seed('w1')
  // m1 sees a different app so only the foreground lease collides with w1's.
  rt.botOf('m1').computer.apps.mail = { name: 'Mail', grantedAt: 0 }
  await track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Mail' } }, agent: { id: 'm1' }, callId: 'g-m1' },
    async () => ({ isError: false, value: { appHandle: 'h-m1', authorization: { name: 'Mail' } } }))
  // user busy gates a foreground call
  await rt.computerEndpoint('user-active', { idleSeconds: 0 })
  const busy = await call('w1', { method: 'activate', params: { appHandle: 'h-w1' } })
  assert.equal(busy.kind, 'deny')
  assert.match(busy.reason, /user is using/)
  // the refused call took no lease: a background call still works
  await rt.computerEndpoint('user-active', { idleSeconds: 10 })
  assert.equal(await call('w1', { method: 'click', params: { appHandle: 'h-w1' } }), 'allowed')
  // let it continue buys foreground
  await rt.computerEndpoint('user-active', { idleSeconds: 0 })
  await rt.computerEndpoint('allow-foreground', { botId: 'w1' })
  assert.equal(await call('w1', { method: 'activate', params: { appHandle: 'h-w1' } }), 'allowed')
  // m1's foreground call is refused and names w1
  const other = await call('m1', { method: 'activate', params: { appHandle: 'h-m1' } })
  assert.equal(other.kind, 'deny')
  assert.match(other.reason, /Writer is using the foreground/)
  // turn end releases w1's leases
  for (const fn of ctx.listeners.get('session/event') ?? []) if (fn.length >= 2) fn({ id: 'w1' }, { type: 'turn/end' })
  await rt.computerEndpoint('user-active', { idleSeconds: 10 })
  assert.equal(await call('m1', { method: 'activate', params: { appHandle: 'h-m1' } }), 'allowed')
  // stop releases m1's
  await rt.computerEndpoint('stop', { botId: 'm1' })
  assert.equal(await call('w1', { method: 'activate', params: { appHandle: 'h-w1' } }), 'allowed')
})

test('takeover refuses the Bot and handback delivers a message with nothing the user did', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'foreground' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  await rt.computerEndpoint('takeover', { botId: 'w1' })
  const denied = await gate({ name: 'cua', arguments: { method: 'click', params: {} }, agent: { id: 'w1' }, callId: 'c' }, async () => 'allowed')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /user is operating/)
  // handback: control goes idle and the Bot gets the standard message
  const followups = []
  ctx.sessions = { flush: async () => {} }
  rt.resolveAgent = async () => ({ followup: message => followups.push(message), session: { id: 'w1' } })
  rt.chatOf = () => 'w1'
  await rt.computerEndpoint('handback', { botId: 'w1' })
  assert.equal(rt.computerLive().bots.w1.state, 'idle')
  const last = followups.at(-1)
  const text = last.content?.[0]?.text ?? JSON.stringify(last)
  assert.match(text, /handed|back/i)
  assert.doesNotMatch(text, /typed|clicked|password/i)
})

test('Stop all stops only Bots that hold a lease, are in-flight, or are bot/waiting', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const stopped = []
  rt.stopChat = async botId => stopped.push(botId)
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const bot = rt.botOf('w1')
  bot.computer = { ...bot.computer, apps: { notes: { name: 'Notes', grantedAt: 0 } } }
  await track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: 'w1' }, callId: 'g' },
    async () => ({ isError: false, value: { appHandle: 'h1', authorization: { name: 'Notes' } } }))
  await gate({ name: 'cua', arguments: { method: 'click', params: { appHandle: 'h1' } }, agent: { id: 'w1' }, callId: 'c' }, async () => 'allowed')
  // w1 holds a lease; m1 has a control entry but nothing held (simulated by a user state)
  await rt.computerEndpoint('takeover', { botId: 'm1' })
  await rt.computerEndpoint('stop', { all: true })
  assert.deepEqual([...stopped].sort(), ['w1'])
})

test('the Windows path also asks consent for observe calls on a known app', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'view' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const allow = async () => 'allowed'
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  await track({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'l' },
    async () => ({ windows: [{ pid: 7, name: 'Notes' }] }))
  // a screenshot of the known pid asks; list calls do not
  assert.equal(await gate({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'c1' }, allow), 'allowed')
  const pending = gate({ name: 'cua_driver_native__get_desktop_state', arguments: { pid: 7 }, agent: { id: 'w1' }, callId: 'c2' }, allow)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Object.keys(rt.computerLive().asks).length, 1)
  const [id] = Object.entries(rt.computerLive().asks)[0]
  await rt.computerEndpoint('app-answer', { id, answer: 'once' })
  assert.equal(await pending, 'allowed')
})

test('computer_handoff: the hold answers done, skip and takeover', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const services = { loader: { import: async name => ({ name }) }, agents: { list: () => [] } }
  ctx.get = name => services[name]
  withProvider(ctx, services)
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('provider-retry', {})
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'foreground' })
  // the per-agent tool is registered for an allowed Bot
  const agent = ctx.scopeAgent('w1')
  await ctx.emitAsync('agent/created', { agent })
  const handoff = ctx.registeredTools.get('computer_handoff')
  assert.notEqual(handoff, undefined)
  const followups = []
  ctx.sessions = { flush: async () => {} }
  rt.resolveAgent = async () => ({ followup: message => followups.push(message), session: { id: 'w1' } })
  rt.chatOf = () => 'w1'
  await handoff.execute({ reason: 'login', note: 'needs a sign-in' }, { agent: { id: 'w1' }, callId: 'call-9' })
  // the call shows the hold in the Bot's own chat
  const hold = Object.entries(rt.computerLive().holds ?? {})[0]
  assert.notEqual(hold, undefined)
  // done: the Bot gets the handback message
  await rt.computerEndpoint('hold-answer', { botId: 'w1', outcome: 'done' })
  const reply = JSON.parse(followups.at(-1).content[0].text)
  assert.equal(reply.kind, 'answer_to_pending_handoff')
  assert.equal(reply.outcome, 'done')
  assert.match(reply.message, /gave the computer back|handed/)
})

test('a cua call DS Bot never decided asks by card instead of saying revoked', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  // DSH's saved decision let getApp through; DS Bot's post-getApp consent asks
  // by the same card before the model ever sees the handle.
  const got = track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: 'w1' }, callId: 'g1' },
    async () => ({ isError: false, value: { appHandle: 'h1', pid: 9, authorization: { id: 'com.apple.Notes', name: 'Notes' } } }))
  for (let i = 0; i < 50 && Object.keys(rt.computerLive().asks).length === 0; i++) await new Promise(resolve => setImmediate(resolve))
  const ask = Object.values(rt.computerLive().asks)[0]
  assert.equal(ask.appName, 'Notes')
  await rt.computerEndpoint('app-answer', { id: ask.id, answer: 'once' })
  await got
  assert.equal(await gate({ name: 'cua', arguments: { method: 'click', params: { appHandle: 'h1' } }, agent: { id: 'w1' }, callId: 'c1' }, allow), 'allowed')
  // the Session decision now covers later calls without a new card
  assert.equal(await gate({ name: 'cua', arguments: { method: 'click', params: { appHandle: 'h1' } }, agent: { id: 'w1' }, callId: 'c2' }, allow), 'allowed')
  // an explicit Deny is still a refusal, not a card
  const denied = gate({ name: 'cua', arguments: { method: 'click', params: { appHandle: 'h1' } }, agent: { id: 'w1' }, callId: 'c3' }, allow)
  assert.equal(await denied, 'allowed')
  // but a deny recorded for another app refuses outright — the card now answers
  // inside getApp, and the refused handle never reaches the model
  const gotMail = track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Mail' } }, agent: { id: 'w1' }, callId: 'g2' },
    async () => ({ isError: false, value: { appHandle: 'h2', pid: 10, authorization: { id: 'com.apple.Mail', name: 'Mail' } } }))
  for (let i = 0; i < 50 && Object.keys(rt.computerLive().asks).length === 0; i++) await new Promise(resolve => setImmediate(resolve))
  const [id2] = Object.entries(rt.computerLive().asks)[0]
  await rt.computerEndpoint('app-answer', { id: id2, answer: 'deny' })
  const refused = await gotMail
  assert.match(refused.content[0].text, /did not allow/)
  const again = await gate({ name: 'cua', arguments: { method: 'click', params: { appHandle: 'h2' } }, agent: { id: 'w1' }, callId: 'c5' }, allow)
  assert.match(again.reason, /did not allow/)
})

test('a revoke clears the Bot’s session decisions for the app in every Session', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const other = 'w1-part2'
  rt.isBotSession = id => id === 'w1' || id === other
  const selfOf = rt.selfOf
  rt.selfOf = id => (id === other ? 'w1' : selfOf(id))
  for (const sessionId of ['w1', other]) {
    const got = track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: sessionId }, callId: `g-${sessionId}` },
      async () => ({ isError: false, value: { appHandle: `h-${sessionId}`, pid: 9, authorization: { id: 'com.apple.Notes', name: 'Notes' } } }))
    for (let i = 0; i < 50 && Object.keys(rt.computerLive().asks).length === 0; i++) await new Promise(resolve => setImmediate(resolve))
    const [id] = Object.entries(rt.computerLive().asks)[0]
    await rt.computerEndpoint('app-answer', { id, answer: 'once' })
    await got
    assert.equal(await gate({ name: 'cua', arguments: { method: 'click', params: { appHandle: `h-${sessionId}` } }, agent: { id: sessionId }, callId: `c-${sessionId}` }, allow), 'allowed')
  }
  // revoke: recorded handles refuse "was revoked" in each Session — the card
  // comes from the next getApp, which denies here
  await rt.computerEndpoint('revoke-app', { botId: 'w1', appKey: 'com.apple.Notes' })
  for (const sessionId of ['w1', other]) {
    const refused = await gate({ name: 'cua', arguments: { method: 'click', params: { appHandle: `h-${sessionId}` } }, agent: { id: sessionId }, callId: `d-${sessionId}` }, allow)
    assert.match(refused.reason, /was revoked/, sessionId)
    const got = track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: sessionId }, callId: `g2-${sessionId}` },
      async () => ({ isError: false, value: { appHandle: `n-${sessionId}`, pid: 9, authorization: { id: 'com.apple.Notes', name: 'Notes' } } }))
    for (let i = 0; i < 50 && Object.keys(rt.computerLive().asks).length === 0; i++) await new Promise(resolve => setImmediate(resolve))
    const [id] = Object.entries(rt.computerLive().asks)[0]
    await rt.computerEndpoint('app-answer', { id, answer: 'deny' })
    assert.match((await got).content[0].text, /did not allow/)
  }
})


test("the macOS consent answerer is prepended ahead of DSH answerer", async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  assert.ok(ctx.calls.includes('on user-questions/request (prepend)'))
})

test('a provider status change saves, so the view reaches the next poll', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const services = { loader: { import: async name => ({ name }) }, agents: { list: () => [] } }
  ctx.get = name => services[name]
  withProvider(ctx, services)
  await rt.load()
  const saves = []
  const save = rt.save
  rt.save = async () => { saves.push(1); return save() }
  await rt.computerEndpoint('set-enabled', { enabled: true })
  const before = saves.length
  await rt.computerEndpoint('provider-retry', {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rt.computerView().provider.state, 'ready')
  assert.ok(saves.length > before, 'the status change did not advance the revision')
})

test('a group computer_handoff docks by its hold id and the answer reaches the Bot chat', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const services = { loader: { import: async name => ({ name }) }, agents: { list: () => [] } }
  ctx.get = name => services[name]
  withProvider(ctx, services)
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('provider-retry', {})
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'foreground' })
  const agent = ctx.scopeAgent('w1')
  await ctx.emitAsync('agent/created', { agent })
  const handoff = ctx.registeredTools.get('computer_handoff')
  const group = 'w1-group'
  const selfOf = rt.selfOf
  rt.selfOf = id => (id === group ? 'w1' : selfOf(id))
  const isBotSession = rt.isBotSession
  rt.isBotSession = id => (id === group ? true : isBotSession(id))
  const followups = []
  ctx.sessions = { flush: async () => {} }
  rt.resolveAgent = async () => ({ followup: message => followups.push(message), session: { id: 'w1' } })
  rt.chatOf = () => 'w1'
  // the group call has no callId for the Bot's own chat
  await handoff.execute({ reason: 'login' }, { agent: { id: group }, callId: 'call-group' })
  const [, hold] = Object.entries(rt.computerLive().holds ?? {})[0]
  assert.equal(typeof hold.id, 'string')
  assert.equal(hold.callId, undefined)
  await rt.computerEndpoint('hold-answer', { botId: 'w1', outcome: 'skip' })
  const reply = JSON.parse(followups.at(-1).content[0].text)
  assert.equal(reply.kind, 'answer_to_pending_handoff')
  assert.equal(reply.callId, hold.id)
  assert.equal(reply.outcome, 'skipped')
  assert.equal(rt.computerLive().holds?.w1, undefined)
})

test('cua-driver resolves a window_id or an element token to the app, and refuses what it cannot', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const call = (name, args = {}) => gate({ name, arguments: args, agent: { id: 'w1' }, callId: `c-${name}` }, allow)
  // a targeted call with nothing to resolve against is refused before consent
  const blind = await call('cua_driver_native__click', {})
  assert.equal(blind.kind, 'deny')
  assert.match(blind.reason, /list_windows/)
  // untargeted capture and desktop-state reads are refused at every level
  assert.equal((await call('cua_driver_native__get_desktop_state', {})).kind, 'deny')
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'view' })
  assert.equal((await call('cua_driver_native__zoom', {})).kind, 'deny')
  // list_windows stays allowed metadata
  assert.equal(await call('cua_driver_native__list_windows', {}), 'allowed')
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  // get_window_state records the window and its element tokens
  await track({ name: 'cua_driver_native__get_window_state', arguments: { window_id: 7 }, agent: { id: 'w1' }, callId: 'state-1' },
    async () => ({ window_id: 7, pid: 42, name: 'Notes', path: '/Applications/Notes.app', elements: [{ token: 'el-9' }] }))
  // a window_id call resolves to Notes and asks once, then runs
  const pending = call('cua_driver_native__click', { window_id: 7 })
  await new Promise(resolve => setImmediate(resolve))
  const [id, ask] = Object.entries(rt.computerLive().asks)[0]
  assert.equal(ask.appName, 'Notes')
  await rt.computerEndpoint('app-answer', { id, answer: 'once' })
  assert.equal(await pending, 'allowed')
  // an element token from the same window resolves to the same app
  assert.equal(await call('cua_driver_native__click', { target: 'el-9' }), 'allowed')
  // an unknown window is refused
  const unknown = await call('cua_driver_native__click', { window_id: 99 })
  assert.equal(unknown.kind, 'deny')
})

test('revoke clears a This time under every key, so the next call asks again', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const call = (args = {}) => gate({ name: 'cua_driver_native__click', arguments: args, agent: { id: 'w1' }, callId: 'c-revoke' }, allow)
  await track({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'list-1' }, async () => ({ windows: [{ pid: 42, name: 'Notes', path: '/Applications/Notes.app' }] }))
  // Always grant, then a This time decision in the same Session
  const grantAsk = call({ pid: 42 })
  await new Promise(resolve => setImmediate(resolve))
  await rt.computerEndpoint('app-answer', { id: Object.keys(rt.computerLive().asks)[0], answer: 'always' })
  assert.equal(await grantAsk, 'allowed')
  // revoke the grant and record a Session decision under a different key, then revoke again
  await rt.computerEndpoint('revoke-app', { botId: 'w1', appKey: '/Applications/Notes.app' })
  const onceAsk = call({ pid: 42 })
  await new Promise(resolve => setImmediate(resolve))
  await rt.computerEndpoint('app-answer', { id: Object.keys(rt.computerLive().asks)[0], answer: 'once' })
  assert.equal(await onceAsk, 'allowed')
  await rt.computerEndpoint('revoke-app', { botId: 'w1', appKey: '/Applications/Notes.app' })
  // the This time is gone with it: the next call opens the card again
  const again = call({ pid: 42 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Object.keys(rt.computerLive().asks).length, 1)
  await rt.computerEndpoint('app-answer', { id: Object.keys(rt.computerLive().asks)[0], answer: 'deny' })
  assert.equal((await again).kind, 'deny')
})

test('computer-shot serves only screenshots the module recorded, with a safe MIME', async (t) => {
  const services = { attachments: { readFileStream: async function* () { yield Buffer.from('img') } } }
  const { ctx, home, rt } = setup({ services })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  // an arbitrary attachment id is not readable
  assert.equal(await rt.computerEndpoint('shot', { attachmentId: 'any-1' }), null)
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  // a screenshot result with a hostile MIME is served as png
  await track({ name: 'cua', arguments: { method: 'screenshot', params: {} }, agent: { id: 'w1' }, callId: 'shot-1' },
    async () => ({ attachment: { attachmentId: 'rec-1', mimeType: 'text/html' } }))
  const shot = await rt.computerEndpoint('shot', { attachmentId: 'rec-1' })
  assert.match(shot.dataUrl, /^data:image\/png;base64,/)
  // a real image MIME survives
  await track({ name: 'cua', arguments: { method: 'screenshot', params: {} }, agent: { id: 'w1' }, callId: 'shot-2' },
    async () => ({ attachment: { attachmentId: 'rec-2', mimeType: 'image/jpeg' } }))
  assert.match((await rt.computerEndpoint('shot', { attachmentId: 'rec-2' })).dataUrl, /^data:image\/jpeg;base64,/)
})

test('same-named apps do not share an approval; a name-only consent still matches', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const call = (args = {}) => gate({ name: 'cua_driver_native__click', arguments: args, agent: { id: 'w1' }, callId: `c-${args.pid}` }, allow)
  // app A at path X gets an Always grant
  await track({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'list-a' }, async () => ({ windows: [{ pid: 42, name: 'Notes', path: '/a/Notes.app' }] }))
  const askA = call({ pid: 42 })
  await new Promise(resolve => setImmediate(resolve))
  await rt.computerEndpoint('app-answer', { id: Object.keys(rt.computerLive().asks)[0], answer: 'always' })
  assert.equal(await askA, 'allowed')
  // app B: same name, another path — it asks again
  await track({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'list-b' }, async () => ({ windows: [{ pid: 43, name: 'Notes', path: '/b/Notes.app' }] }))
  const askB = call({ pid: 43 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Object.keys(rt.computerLive().asks).length, 1)
  await rt.computerEndpoint('app-answer', { id: Object.keys(rt.computerLive().asks)[0], answer: 'deny' })
  assert.equal((await askB).kind, 'deny')
  // the macOS consent question carries only a name; that path stays name-matched
  const consent = ctx.listeners.get('user-questions/request').find(fn => fn.name === 'computerConsent')
  const w1 = rt.botOf('w1')
  const question = { questions: [{ id: 'cua-app-access', intent: { subject: { name: 'Notes' } } }], agent: { id: 'w1', session: { id: 'w1' } }, signal: new AbortController().signal }
  // drop the path-keyed grants and keep a name-only Always grant
  w1.computer = { apps: { notes: { name: 'Notes', grantedAt: 0 } } }
  const answer = await consent(question, async () => 'next')
  assert.deepEqual(answer.answers[0].selected, ['Allow for this session'])
})

test('browser tools need a resolvable target, and the driver-refused methods deny at every level', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'foreground' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const call = (name, args = {}) => gate({ name, arguments: args, agent: { id: 'w1' }, callId: `c-${name}` }, allow)
  // the refused list denies at every level, before any consent or target work
  for (const method of ['set_config', 'start_recording', 'stop_recording', 'replay_trajectory', 'install_ffmpeg']) {
    const denied = await call(`cua_driver_native__${method}`, {})
    assert.equal(denied.kind, 'deny', method)
    assert.match(denied.reason, /may not use/, method)
  }
  // get_browser_state and the browser_* tools are no longer global: no target, no call
  assert.match((await call('cua_driver_native__get_browser_state', {})).reason, /list_windows/)
  assert.match((await call('cua_driver_native__browser_navigate', { url: 'https://example.com' })).reason, /list_windows/)
  // with a recorded window they resolve their app and reach consent like any target
  await track({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'list-b' },
    async () => ({ windows: [{ window_id: 5, pid: 44, name: 'Browser', path: '/Applications/Browser.app' }] }))
  const pending = call('cua_driver_native__browser_navigate', { window_id: 5, url: 'https://example.com' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(Object.keys(rt.computerLive().asks).length, 1)
  await rt.computerEndpoint('app-answer', { id: Object.keys(rt.computerLive().asks)[0], answer: 'once' })
  assert.equal(await pending, 'allowed')
})

test('launch_app resolves by its own name or path: consent, protected check, recorded app', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const call = (args = {}) => gate({ name: 'cua_driver_native__launch_app', arguments: args, agent: { id: 'w1' }, callId: 'launch' }, allow)
  // no identifying argument: refused
  const blind = await call({})
  assert.equal(blind.kind, 'deny')
  // a protected path is refused without a card
  const protectedCall = await call({ path: '/Applications/DSH Computer Use.app' })
  assert.equal(protectedCall.kind, 'deny')
  assert.match(protectedCall.reason, /protected/)
  // an unprotected app asks by card, then runs
  const pending = call({ name: 'Notes', path: '/Applications/Notes.app' })
  await new Promise(resolve => setImmediate(resolve))
  const [id, ask] = Object.entries(rt.computerLive().asks)[0]
  assert.equal(ask.appName, 'Notes')
  await rt.computerEndpoint('app-answer', { id, answer: 'once' })
  assert.equal(await pending, 'allowed')
  // the launched app is recorded: a later call on its window resolves without a card
  await track({ name: 'cua_driver_native__launch_app', arguments: { path: '/Applications/Notes.app' }, agent: { id: 'w1' }, callId: 'launch-2' },
    async () => ({ pid: 50, name: 'Notes', path: '/Applications/Notes.app', window_id: 9 }))
  assert.equal(await gate({ name: 'cua_driver_native__click', arguments: { window_id: 9 }, agent: { id: 'w1' }, callId: 'c9' }, allow), 'allowed')
})

test('the Bot cursor: relative, pixel and index calls publish a point', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  rt.botOf('w1').computer = { apps: { 'com.apple.Notes': { name: 'Notes', id: 'com.apple.Notes', grantedAt: 0 } } }
  const cua = (method, params, callId = 'c') => ({ name: 'cua', arguments: { method, params }, agent: { id: 'w1' }, callId })
  // getState records window bounds; a screenshot records that window's pixels
  await track(cua('getState', { appHandle: 'h1' }, 'g1'), async () => ({ isError: false, value: { appHandle: 'h1', focusedWindowId: 7, windows: [{ windowId: 7, pid: 42, bounds: { x: 100, y: 200, width: 300, height: 400 } }] } }))
  await track(cua('screenshot', { appHandle: 'h1', windowId: 7 }, 'g2'), async () => ({ isError: false, value: { windowId: 7, pixelWidth: 600, pixelHeight: 800 } }))
  const okResult = async () => ({ isError: false, value: { dispatched: true } })
  // relative click: thousandths of the window
  await gate(cua('click', { appHandle: 'h1', windowId: 7, relative: true, x: 500, y: 250 }, 'c1'), allow)
  await track(cua('click', { appHandle: 'h1', windowId: 7, relative: true, x: 500, y: 250 }, 'c1'), okResult)
  let cursor = rt.computerLive().cursors.find(event => event.botId === 'w1')
  assert.equal(cursor.mode, 'point')
  assert.equal(cursor.ripple, true)
  assert.ok(Math.abs(cursor.x - (100 + 500 * 300 / 999)) < 0.5)
  assert.ok(Math.abs(cursor.y - (200 + 250 * 400 / 999)) < 0.5)
  assert.equal(cursor.pid, 42)
  // pixel coordinates scale by that window's last screenshot size
  await track(cua('click', { appHandle: 'h1', windowId: 7, x: 300, y: 400 }, 'c2'), okResult)
  cursor = rt.computerLive().cursors.find(event => event.botId === 'w1')
  assert.ok(Math.abs(cursor.x - 250) < 0.5)
  assert.ok(Math.abs(cursor.y - 400) < 0.5)
  // an element-index click sits at the title bar with no ripple
  await track(cua('click', { appHandle: 'h1', windowId: 7, index: 6 }, 'c3'), okResult)
  cursor = rt.computerLive().cursors.find(event => event.botId === 'w1')
  assert.equal(cursor.mode, 'window')
  assert.equal(cursor.ripple, false)
  assert.ok(Math.abs(cursor.x - 250) < 0.5)
  assert.ok(Math.abs(cursor.y - 214) < 0.5)
  // a call on an unknown window publishes nothing
  await track(cua('click', { appHandle: 'h1', windowId: 99, index: 1 }, 'c4'), okResult)
  assert.equal(rt.computerLive().cursors.find(event => event.botId === 'w1').mode, 'window')
})

test('driver cursors: session injection, refused cursor tools, one disable per session', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const executions = []
  ctx.tools = {
    get: (name) => {
      if (name === 'cua_driver_native__set_agent_cursor_enabled') return { execute: async (args) => { executions.push(['disable', args]); return { value: {} } } }
      if (name === 'cua_driver_native__get_agent_cursor_state') return { execute: async (args) => { executions.push(['state', args]); return { isError: false, value: { position: { x: 311, y: 222 } } } } }
      return { inputSchema: { properties: { session: {}, pid: {} } } }
    },
  }
  rt.botOf('w1').computer = { apps: { 'com.apple.Notes': { name: 'Notes', id: 'com.apple.Notes', grantedAt: 0 } } }
  await track({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'list-1' }, async () => ({ windows: [{ pid: 42, name: 'Notes', path: '/Applications/Notes.app', bundleId: 'com.apple.Notes' }] }))
  // a call whose schema carries session gets a stable per-Bot session injected
  const exec = { name: 'cua_driver_native__click', arguments: { pid: 42 }, agent: { id: 'w1' }, callId: 'c1' }
  await gate(exec, allow)
  assert.match(exec.arguments.session, /^dsbot-[0-9a-f]+$/)
  await track(exec, async () => ({ isError: false, value: { done: true } }))
  // disable ran once for the session; the state query published the point
  assert.equal(executions.filter(e => e[0] === 'disable').length, 1)
  await new Promise(resolve => setImmediate(resolve))
  const cursor = rt.computerLive().cursors.find(event => event.botId === 'w1')
  assert.equal(cursor.x, 311)
  assert.equal(cursor.y, 222)
  assert.equal(cursor.ripple, true)
  // the cursor tools themselves are refused to Bots
  assert.equal((await gate({ name: 'cua_driver_native__set_agent_cursor_enabled', arguments: { session: 'x', enabled: true }, agent: { id: 'w1' }, callId: 'c2' }, allow)).kind, 'deny')
  // a tool whose schema has no session property gets nothing injected
  ctx.tools.get = () => ({ inputSchema: { properties: { pid: {} } } })
  const bare = { name: 'cua_driver_native__click', arguments: { pid: 42 }, agent: { id: 'w1' }, callId: 'c3' }
  await gate(bare, allow)
  assert.equal(bare.arguments.session, undefined)
})

test('cursor-wait returns fresh events, wakes on publish, and times out empty', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  rt.botOf('w1').computer = { apps: { 'com.apple.Notes': { name: 'Notes', id: 'com.apple.Notes', grantedAt: 0 } } }
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const cua = (method, params, callId) => ({ name: 'cua', arguments: { method, params }, agent: { id: 'w1' }, callId })
  await track(cua('getState', { appHandle: 'h1' }, 'g1'), async () => ({ isError: false, value: { appHandle: 'h1', focusedWindowId: 7, windows: [{ windowId: 7, bounds: { x: 0, y: 0, width: 100, height: 100 } }] } }))
  // a handle-only relative click resolves through the remembered windowId
  const okResult = async () => ({ isError: false, value: { dispatched: true } })
  const click = { name: 'cua', arguments: { method: 'click', params: { appHandle: 'h1', relative: true, x: 500, y: 500 } }, agent: { id: 'w1' }, callId: 'c1' }
  await gate(click, allow)
  await track(click, okResult)
  const first = await rt.computerEndpoint('cursor-wait', { after: 0 })
  assert.equal(first.events.length, 1)
  assert.ok(Math.abs(first.events[0].x - 50) < 0.5)
  assert.equal(first.events[0].windowId, 7)
  // a waiter with the same seq wakes only when a newer event lands
  const waiting = rt.computerEndpoint('cursor-wait', { after: first.events[0].seq })
  await new Promise(resolve => setImmediate(resolve))
  await track(cua('pressKey', { appHandle: 'h1', key: 'a' }, 'c2'), okResult)
  const woke = await waiting
  assert.equal(woke.events.length, 1)
  assert.equal(woke.events[0].mode, 'window')
  // nothing newer → the wait resolves empty after the timeout (stubbed short)
  // a seq ahead of ours means the host restarted: answer like after=0
  const restarted = await rt.computerEndpoint('cursor-wait', { after: 9999 })
  assert.equal(restarted.events.length, 1)
  // dispose resolves a pending waiter with no events
  const held = rt.computerEndpoint('cursor-wait', { after: restarted.events[0].seq })
  rt.closeComputerWaiters()
  assert.deepEqual((await held).events, [])
})

test('computer-shot serves a real screenshot attachment by its mediaType', async (t) => {
  const { ctx, home, rt } = setup({ services: { attachments: { readFileStream: async function* () { yield Buffer.from('PNGDATA') } } } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'view' })
  rt.botOf('w1').computer = { apps: { 'com.apple.Notes': { name: 'Notes', id: 'com.apple.Notes', grantedAt: 0 } } }
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  // the real provider's attachment carries mediaType, not mimeType
  await track(
    { name: 'cua', arguments: { method: 'screenshot', params: { appHandle: 'h1', windowId: 7 } }, agent: { id: 'w1' }, callId: 's1' },
    async () => ({ isError: false, value: { windowId: 7, attachment: { attachmentId: 'sha256:abc', mediaType: 'image/webp', width: 100, height: 100, bytes: 7 } } }),
  )
  const shot = await rt.computerEndpoint('shot', { attachmentId: 'sha256:abc' })
  assert.equal(shot?.dataUrl, `data:image/webp;base64,${Buffer.from('PNGDATA').toString('base64')}`)
  // an id this module never recorded is not readable
  assert.equal(await rt.computerEndpoint('shot', { attachmentId: 'sha256:other' }), null)
})

// A tool result as the DSH MCP bridge hands it to the tool runtime: the driver's own
// JSON stays under structuredContent, with the text rendering beside it.
const mcpResult = (structuredContent, text = 'ok') => ({
  isError: false,
  content: [{ type: 'text', text }],
  value: { content: [{ type: 'text', text }], structuredContent },
})

test('cua-driver registers apps and windows from the canonical MCP result', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const call = (name, args = {}) => gate({ name: `cua_driver_native__${name}`, arguments: args, agent: { id: 'w1' }, callId: `c-${name}-${JSON.stringify(args)}` }, allow)

  // list_apps: one running app with a window, one installed but not running.
  await track({ name: 'cua_driver_native__list_apps', arguments: {}, agent: { id: 'w1' }, callId: 'apps-1' },
    async () => mcpResult({
      apps: [
        { pid: 42, name: 'Notes', bundle_id: 'com.apple.Notes', launch_path: '/Applications/Notes.app', running: true, active: false, windows: [{ window_id: 7, pid: 42, app_name: 'Notes', title: 'Notes' }] },
        { pid: 0, name: 'Mail', bundle_id: 'com.apple.Mail', launch_path: '/Applications/Mail.app', running: false, active: false, windows: [] },
      ],
    }))
  // A running app is known by pid and its window; the app identity keeps the bundle id
  // and path, so the grant is recorded against the same identity a later list returns.
  const pending = call('click', { pid: 42 })
  await new Promise(resolve => setImmediate(resolve))
  const [, ask] = Object.entries(rt.computerLive().asks)[0]
  assert.equal(ask.appName, 'Notes')
  await rt.computerEndpoint('app-answer', { id: ask.id, answer: 'always' })
  assert.equal(await pending, 'allowed')
  const grant = Object.values(rt.botOf('w1').computer.apps).find(entry => entry.id === 'com.apple.Notes')
  assert.equal(grant?.name, 'Notes')
  assert.equal(await call('click', { window_id: 7 }), 'allowed')
  // The not-running app's pid 0 was not registered as a usable app.
  assert.equal((await call('click', { pid: 0 })).kind, 'deny')

  // list_windows: app_name names the app, and a protected app is refused before consent.
  await track({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'wins-1' },
    async () => mcpResult({ windows: [
      { window_id: 8, pid: 43, app_name: 'Mail', title: '', z_index: 1, is_on_screen: true },
      { window_id: 9, pid: 5, app_name: 'System Settings', title: 'Settings', z_index: 2, is_on_screen: true },
    ] }))
  const mail = call('click', { pid: 43 })
  await new Promise(resolve => setImmediate(resolve))
  const ask2 = Object.values(rt.computerLive().asks)[0]
  assert.equal(ask2.appName, 'Mail')
  await rt.computerEndpoint('app-answer', { id: ask2.id, answer: 'once' })
  assert.equal(await mail, 'allowed')
  const protectedCall = await call('click', { window_id: 9 })
  assert.equal(protectedCall.kind, 'deny')
  assert.match(protectedCall.reason, /protected/)

  // get_window_state: a window and its real element_token resolve to that window's app.
  await track({ name: 'cua_driver_native__get_window_state', arguments: { pid: 44, window_id: 11 }, agent: { id: 'w1' }, callId: 'state-1' },
    async () => mcpResult({ pid: 44, window_id: 11, app_name: 'Reminders', elements: [{ element_index: 0, role: 'button', element_token: 'el-9' }] }))
  const token = call('click', { element_token: 'el-9' })
  await new Promise(resolve => setImmediate(resolve))
  const ask3 = Object.values(rt.computerLive().asks)[0]
  assert.equal(ask3.appName, 'Reminders')
  await rt.computerEndpoint('app-answer', { id: ask3.id, answer: 'once' })
  assert.equal(await token, 'allowed')
})

test('cua-driver registers launch_app from structuredContent and leaves text-only results alone', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const call = (name, args = {}) => gate({ name: `cua_driver_native__${name}`, arguments: args, agent: { id: 'w1' }, callId: `c-${name}-${JSON.stringify(args)}` }, allow)

  // launch_app answers with the app and its windows under structuredContent.
  await track({ name: 'cua_driver_native__launch_app', arguments: { bundle_id: 'com.apple.Mail' }, agent: { id: 'w1' }, callId: 'launch-1' },
    async () => mcpResult({ pid: 43, bundle_id: 'com.apple.Mail', name: 'Mail', launch_state: 'window_ready', windows: [{ window_id: 9, pid: 43, app_name: 'Mail', title: 'Inbox' }] }, 'Launched Mail (pid 43)'))
  const launched = call('click', { pid: 43 })
  await new Promise(resolve => setImmediate(resolve))
  const ask = Object.values(rt.computerLive().asks)[0]
  assert.equal(ask.appName, 'Mail')
  await rt.computerEndpoint('app-answer', { id: ask.id, answer: 'once' })
  assert.equal(await launched, 'allowed')
  assert.equal(await call('click', { window_id: 9 }), 'allowed')

  // A provider that returns text only records nothing: no app is learned from prose.
  const textOnly = { isError: false, content: [{ type: 'text', text: 'windows: 55 Notes' }], value: { content: [{ type: 'text', text: 'windows: 55 Notes' }] } }
  await track({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'text-1' }, async () => textOnly)
  const blind = await call('click', { pid: 55 })
  assert.equal(blind.kind, 'deny')
  assert.match(blind.reason, /list/i)
})

test('cua-driver keeps the plain top-level array result', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const call = (args) => gate({ name: 'cua_driver_native__click', arguments: args, agent: { id: 'w1' }, callId: `c-${JSON.stringify(args)}` }, allow)
  // An older provider returns the window list as the value itself, not in an object.
  await track({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'array-1' },
    async () => [{ pid: 55, name: 'Notes', window_id: 55 }])
  const byPid = call({ pid: 55 })
  await new Promise(resolve => setImmediate(resolve))
  const ask = Object.values(rt.computerLive().asks)[0]
  assert.equal(ask.appName, 'Notes')
  await rt.computerEndpoint('app-answer', { id: ask.id, answer: 'once' })
  assert.equal(await byPid, 'allowed')
  assert.equal(await call({ window_id: 55 }), 'allowed')
})

test('cua-driver keeps the title-only window record', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const call = (args) => gate({ name: 'cua_driver_native__click', arguments: args, agent: { id: 'w1' }, callId: `c-${JSON.stringify(args)}` }, allow)
  // A window with no pid still names its app by title and resolves by window id.
  await track({ name: 'cua_driver_native__list_windows', arguments: {}, agent: { id: 'w1' }, callId: 'title-1' },
    async () => ({ windows: [{ title: 'Notes', window_id: 56 }] }))
  const pending = call({ window_id: 56 })
  await new Promise(resolve => setImmediate(resolve))
  const ask = Object.values(rt.computerLive().asks)[0]
  assert.equal(ask.appName, 'Notes')
  await rt.computerEndpoint('app-answer', { id: ask.id, answer: 'once' })
  assert.equal(await pending, 'allowed')
})

test('cua-driver keeps a numeric element token', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  await rt.computerEndpoint('set-enabled', { enabled: true })
  await rt.computerEndpoint('set-level', { botId: 'w1', level: 'background' })
  const gate = ctx.listeners.get('tools/pre-execute').find(fn => fn.name === 'computerGate')
  const track = ctx.listeners.get('tools/execute').find(fn => fn.name === 'computerTrack')
  const allow = async () => 'allowed'
  const call = (args) => gate({ name: 'cua_driver_native__click', arguments: args, agent: { id: 'w1' }, callId: `c-${JSON.stringify(args)}` }, allow)
  // Old get_window_state results carried a numeric token; the read side accepts it.
  await track({ name: 'cua_driver_native__get_window_state', arguments: { window_id: 57 }, agent: { id: 'w1' }, callId: 'num-1' },
    async () => ({ pid: 58, window_id: 57, name: 'Notes', elements: [{ token: 9001 }] }))
  const pending = call({ token: 9001 })
  await new Promise(resolve => setImmediate(resolve))
  const ask = Object.values(rt.computerLive().asks)[0]
  assert.equal(ask.appName, 'Notes')
  await rt.computerEndpoint('app-answer', { id: ask.id, answer: 'once' })
  assert.equal(await pending, 'allowed')
})
