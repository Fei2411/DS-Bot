// The main process of the app: the window hides instead of closing, the tray is the way
// back to it, and a window that is gone for good is built anew and talks to the Host that
// runs. The Electron parts are test doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { handOff, startApp, startState, startWindows, teamWindows, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => { await startApp() })

test('the app starts with a window and a tray', async () => {
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  assert.equal(state.tray.tooltip, 'DS Bot')
  assert.equal(state.quits, 0, 'the app goes on')
})

test('places saved before the free space at the start was kept keep it from this start on', async () => {
  const saved = () => JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8'))
  await waitFor(() => saved().freeAtStart > 0, 'keep the free space of the data\'s drive')
  // Kept from now on: this start shows no place line.
  assert.ok(startWindows()[0].webContents.sent.every(([channel, snapshot]) => channel !== 'ds-bot:start-state' || snapshot.place === undefined))
})

test('the first window trades the launch URL for the Host\'s cookie', async () => {
  const win = window()
  hostState.release()
  await waitFor(() => win.loaded.some(url => url.includes('token=')), 'reach the Host')
  assert.equal(win.loaded.filter(url => url.includes('token=')).length, 1, 'the token is used once')
  assert.equal(state.cookies.length, 1, 'the Host left a cookie for its address')
  // The team view is ready: the start window hands over to the team window.
  await handOff()
})

test('a window that is gone for good is built anew and talks to the same Host', async () => {
  const first = window()
  first.destroy()
  trayMenu()[0].click()
  await waitFor(() => teamWindows().length === 2, 'build a new window')
  const second = window()
  await waitFor(() => second.loaded.some(url => url.startsWith('http://127.0.0.1:')), 'reach the Host')
  assert.equal(second.loaded.filter(url => url.includes('token=')).length, 0, 'the token is not used again')
  assert.equal(hostState.starts, 1, 'no second Host was started')
})

test('closing the window hides it; the app goes on', async () => {
  const win = window()
  win.close()
  await waitFor(() => win.visible === false, 'hide the window')
  assert.equal(win.isDestroyed(), false, 'the window is there')
  assert.equal(state.quits, 0, 'the app goes on')
  assert.equal(hostState.stops, 0, 'the Host goes on')
  assert.equal(state.dialogs.length, 0, 'the notice was answered already')
})

test('the tray opens the window again', async () => {
  const win = window()
  trayMenu()[0].click()
  await waitFor(() => win.visible === true, 'show the window')
  assert.equal(win.focused > 0, true, 'the window has the focus')
})

test('open-in-app and start-drag delegate containment to the Host IPC even after renderer spoofs team-workspace to /', async () => {
  const win = window()
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  // Renderer spoofs `places.workspace` to root `/`.
  state.ipc.get('ds-bot:team-workspace')(event, '/')

  const hostRequests = []
  hostState.onSend = (msg, reply) => {
    if (msg?.type !== 'ds-bot:workspace-resolve-target') return
    hostRequests.push(msg)
    if (msg.path === 'ok.txt') {
      reply({
        type: 'ds-bot:workspace-resolve-target-response',
        id: msg.id,
        result: { root: '/real-ws', target: '/real-ws/ok.txt', dir: '/real-ws', isDirectory: false },
      })
      return
    }
    reply({
      type: 'ds-bot:workspace-resolve-target-response',
      id: msg.id,
      error: { message: 'Path is outside the active workspace', code: 'bot/refused' },
    })
  }
  try {
    // 1. Spoofed open-in-app-open to `/etc/hosts` MUST route to Host and reject.
    const listRes = await state.ipc.get('ds-bot:open-in-app-list')(event, { sessionId: 'b1', path: '' })
    const anyAppId = listRes.apps[0]?.id ?? 'finder'
    await assert.rejects(
      () => state.ipc.get('ds-bot:open-in-app-open')(event, anyAppId, { sessionId: '', path: '/etc/hosts', dirPath: '/' }),
      /outside the active workspace/i,
    )
    assert.ok(hostRequests.some(r => r.path === '/etc/hosts'), 'open-in-app-open must ask Host over private IPC')

    // 2. Spoofed start-drag to `/etc/hosts` MUST NOT start native drag; Host-approved target DOES start drag with Host canonical path.
    win.webContents.drags.length = 0
    state.ipc.get('ds-bot:start-drag')(event, { sessionId: '', path: '/etc/hosts' })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(win.webContents.drags.length, 0, 'start-drag must refuse Host-rejected path even after team-workspace spoof')

    state.ipc.get('ds-bot:start-drag')(event, { sessionId: 'b1', path: 'ok.txt' })
    await waitFor(() => win.webContents.drags.length === 1, 'start-drag invokes webContents.startDrag with Host canonical path')
    assert.equal(win.webContents.drags[0].file, '/real-ws/ok.txt')

    // 3. When workspace is an ancestor of `userData` (e.g. `$HOME`), files outside `userData` MUST be allowed,
    //    while files inside `userData` and directory targets enclosing `userData` MUST still be rejected.
    const ancestorRoot = paths.root // parent of `paths.userData`
    const siblingFile = join(ancestorRoot, 'home-note.txt')
    const insideUserData = join(paths.userData, 'locations.json')
    hostState.onSend = (msg, reply) => {
      if (msg?.type !== 'ds-bot:workspace-resolve-target') return
      if (msg.path === 'home-note.txt') {
        reply({
          type: 'ds-bot:workspace-resolve-target-response',
          id: msg.id,
          result: { root: ancestorRoot, target: siblingFile, dir: ancestorRoot, isDirectory: false },
        })
        return
      }
      if (msg.path === 'inside-ud') {
        reply({
          type: 'ds-bot:workspace-resolve-target-response',
          id: msg.id,
          result: { root: ancestorRoot, target: insideUserData, dir: paths.userData, isDirectory: false },
        })
        return
      }
      if (msg.path === '') {
        reply({
          type: 'ds-bot:workspace-resolve-target-response',
          id: msg.id,
          result: { root: ancestorRoot, target: ancestorRoot, dir: ancestorRoot, isDirectory: true },
        })
      }
    }
    win.webContents.drags.length = 0
    state.ipc.get('ds-bot:start-drag')(event, { sessionId: 'b1', path: 'home-note.txt' })
    await waitFor(() => win.webContents.drags.length === 1, 'file in ancestor of userData ($HOME) must be allowed for drag/open')
    assert.equal(win.webContents.drags[0].file, siblingFile)

    await assert.rejects(
      () => state.ipc.get('ds-bot:open-in-app-open')(event, anyAppId, { sessionId: 'b1', path: 'inside-ud' }),
      /protected data/i,
    )
    await assert.rejects(
      () => state.ipc.get('ds-bot:open-in-app-open')(event, anyAppId, { sessionId: 'b1', path: '' }),
      /protected data/i,
    )
  } finally {
    hostState.onSend = null
  }
})

test('a runtime Host crash forgets the dead host before Retry so tray Open does not reconnect to it', async () => {
  const current = window()
  const beforeCount = teamWindows().length
  hostState.crash(new Error('The DSH Host stopped (exit null, signal SIGKILL)'))
  await waitFor(() => startState()?.view === 'failed', 'show the runtime failure page')
  assert.equal(startState().failure.reason, 'engine')
  assert.equal(startState().failure.running, true)
  assert.equal(startState().phase, 'engine')
  assert.deepEqual(startState().done, ['data'])
  assert.equal(current.visible, false, 'the team window hides on runtime stop')
  // Destroy the hidden team window and click tray Open before clicking Retry:
  // forgetHost() cleared bootstrap/hostReady immediately in fail(), so no new
  // team window is rebuilt or connected against the dead Host.
  current.destroy()
  trayMenu()[0].click()
  await new Promise(resolve => { setTimeout(resolve, 50) })
  assert.equal(teamWindows().length, beforeCount, 'must not rebuild a team window against a dead Host')
})

test('the tray quit ends the app and stops the Host', async () => {
  trayMenu().at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
  await waitFor(() => hostState.stops === 1, 'stop the Host')
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
