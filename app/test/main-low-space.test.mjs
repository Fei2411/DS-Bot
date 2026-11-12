// A later start whose drive is down to a fifth of the free space it had when the data went there
// shows the place line (start-window §5), and its 〔换个位置…〕 moves the data as Settings does,
// asked on the start page's cards instead of message boxes: the folder picker, then 「这里放不了」
// or 「搬到这个文件夹？」 〔移动并重启〕; the start window becomes the move's, the Host stops, the
// data is copied and the app starts again on the new folder. The Electron parts are test
// doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { HostProcess, state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, startWindows, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

// The user makes the folder in the picker first, so a copy shows as what is in it.
const copied = path => existsSync(path) && readdirSync(path).length > 0

await installHooks()

test('a later start on a drive that runs low shows the place line, and its button moves the data on cards', async () => {
  const { home, workspace } = await startApp({ saved: { freeAtStart: Number.MAX_SAFE_INTEGER } })
  await waitFor(() => startWindows().length === 1, 'open the start window')
  const start = startWindows()[0]
  const last = () => start.webContents.sent.filter(([channel]) => channel === 'ds-bot:start-state').at(-1)?.[1]
  const act = async (name, value) => {
    // On a later task than the one that drew the card, as a click is: the pick that drew it
    // finishes first.
    await new Promise((resolve) => { setImmediate(resolve) })
    start.webContents.mainFrame.url = start.url
    return state.ipc.get('ds-bot:start-act')({ sender: start.webContents, senderFrame: start.webContents.mainFrame }, name, value === undefined ? undefined : { value })
  }
  const messageBoxes = () => state.dialogs.filter(options => 'message' in options)
  await waitFor(() => last()?.place !== undefined, 'show the place line')
  assert.equal(last().start, 'later')

  // A folder inside the data: 「这里放不了」 with the reason.
  state.openAnswer = { canceled: false, filePaths: [join(home, 'inside')] }
  assert.equal(await act('pick', 'changePlace'), true)
  await waitFor(() => last().card?.kind === 'rejected', 'say why the folder cannot be used')
  assert.deepEqual(last().card, { kind: 'rejected', reason: 'nested', path: join(home, 'inside') })
  // A folder the checks cannot read is refused for want of permission; the start goes on.
  const unreadable = 'C:\\System Volume Information'
  if (process.platform === 'win32' && existsSync(unreadable)) {
    state.openAnswer = { canceled: false, filePaths: [unreadable] }
    await act('pick')
    await waitFor(() => last().card?.reason === 'permission', 'refuse a folder it cannot read')
    assert.equal(last().view, 'card')
  }
  // 〔重新选…〕 and a cancelled picker: back to the start.
  state.openAnswer = { canceled: true, filePaths: [] }
  await act('pick')
  await waitFor(() => last().view === 'boot' && last().card === undefined, 'go back to the start')

  // A new folder: 「搬到这个文件夹？」, then 〔取消〕.
  const to = join(mkdtempSync(join(tmpdir(), 'ds-bot-move-')), 'data')
  state.openAnswer = { canceled: false, filePaths: [to] }
  await act('pick', 'changePlace')
  await waitFor(() => last().card?.kind === 'move', 'ask about the move')
  assert.deepEqual(last().card, { kind: 'move', path: to, dataDir: home })
  assert.equal(await act('answer', 'cancel'), true)
  await waitFor(() => last().view === 'boot' && last().card === undefined, 'go back to the start')
  assert.equal(state.relaunches.length, 0)
  // The boot goes on: the engine comes up and the team view loads (no ready(), so the start
  // window stays for the rest).
  hostState.release()
  await waitFor(() => window().loaded.some(url => url.startsWith('http://127.0.0.1:')), 'go on with the boot')

  // Whether the copy had begun when the Host stopped.
  const copiedAtStop = []
  const stop = HostProcess.prototype.stop
  HostProcess.prototype.stop = async function (...args) {
    copiedAtStop.push(copied(to))
    return stop.apply(this, args)
  }

  // Again, and 〔移动并重启〕.
  await act('pick', 'changePlace')
  await waitFor(() => last().card?.kind === 'move', 'ask about the move again')
  await act('answer', 'move')
  await waitFor(() => start.url.endsWith('?start=moving'), 'turn the start window into the move\'s')
  await waitFor(() => state.relaunches.length === 1, 'start again on the new folder')
  assert.equal(copiedAtStop[0], false, 'the Host stopped before the copy')
  assert.ok(copied(to), 'the data was copied')
  const saved = JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8'))
  assert.equal(saved.dataDir, to)
  assert.equal(saved.workspace, workspace)
  assert.ok(Number.isFinite(saved.freeAtStart) && saved.freeAtStart < Number.MAX_SAFE_INTEGER, 'the new folder keeps its own free space')
  assert.deepEqual(messageBoxes(), [], 'no message box on the way')
})
