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
  for (const method of ['getCapabilities', 'listApps', 'findApps', 'getApp', 'listWindows', 'getState', 'screenshot', 'permissionStatus', 'applicationIcons']) {
    assert.deepEqual(classify('cua', { method }), { provider: 'cua', kind: 'observe', method })
  }
  // cua foreground: activate, hover and the permission UI
  for (const method of ['activate', 'hover', 'requestPermission', 'openPermissionSettings']) {
    assert.equal(classify('cua', { method }).kind, 'foreground')
  }
  // cua background input
  for (const method of ['click', 'scroll', 'drag', 'setValue', 'selectText', 'performSecondaryAction', 'typeText', 'paste', 'pressKey', 'show', 'launchApp']) {
    assert.equal(classify('cua', { method }).kind, 'background')
  }
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
    { id: 'com.apple.systempreferences' },
    { id: 'com.apple.keychainaccess' },
    { name: 'DS Bot' },
    { name: 'DSH Computer Use' },
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
  // a non-Bot Session is refused
  assert.equal((await call('plain', 'cua', { method: 'click', params: {} })).kind, 'deny')
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
  await track({ name: 'cua', arguments: { method: 'getApp', params: { selector: 'Notes' } }, agent: { id: 'w1' }, callId: 'get-1' },
    async () => ({ appHandle: 'h1', pid: 42, authorization: { id: 'com.apple.Notes', name: 'Notes' } }))
  // m1 never saw h1; it takes a lease on the raw handle, w1's is on the app id
  assert.equal(await call('w1', 'cua', { method: 'click', params: { appHandle: 'h1' } }), 'allowed')
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
  const [id, ask] = Object.entries(asks)[0]
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
  const [id, shown] = Object.entries(rt.computerLive().asks)[0]
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
})
