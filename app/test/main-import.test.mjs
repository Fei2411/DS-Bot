// The first start of an app whose user has a team in their own DSH: the start page offers it on
// the import card instead of message boxes, the copy shows its steps on the copying card, and the
// engine starts on the copied team. The home and the DSH home are throwaway folders, so the test
// never sees the user's own; the Electron parts and the Host are test doubles.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { app, paths, state } from './helpers/fake-electron.mjs'
import { hold, state as hostState } from './helpers/fake-host-process.mjs'
import { handOff, messageBoxes, startAct, startState, startWindows, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

const home = mkdtempSync(join(tmpdir(), 'ds-bot-import-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
delete process.env.DS_BOT_HOME
delete process.env.DS_BOT_WORKSPACE

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const dsh = process.env.DSH_HOME
write(join(dsh, 'bot', 'state.json'), JSON.stringify({ bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's1' }, b2: { id: 'b2', name: 'Writer', sessionId: 's2' } }, rooms: {} }))
write(join(dsh, 'sessions', 'g', 's1', 'notes.txt'), 'one')
write(join(dsh, 'sessions', 'g', 's2', 'notes.txt'), 'two')
write(join(dsh, 'bot', 'workspace', 'draft.md'), 'work')
write(join(dsh, 'bot', 'workspace', 'node_modules', 'x', 'index.js'), 'regenerable')

await installHooks()

const cards = () => startWindows()[0].webContents.sent.filter(([channel, snapshot]) => channel === 'ds-bot:start-state' && snapshot.card).map(([, snapshot]) => snapshot.card)

test('the first start offers the DSH team on the import card, copies it on cards and starts on it', async () => {
  mkdirSync(paths.userData, { recursive: true })
  writeFileSync(join(paths.userData, 'tray-close-acknowledged'), '')
  hold()
  await import('../src/main.mjs')
  await waitFor(() => startState()?.card?.kind === 'import', 'offer the team on the import card')
  const offer = startState().card
  // The ring has three arcs while the card asks; the copy brings a fourth (checked below).
  assert.deepEqual(startState().phases, ['data', 'engine', 'team'])
  assert.deepEqual([offer.bots, offer.groups, offer.sessions, offer.names], [2, 0, 2, 'Chief, Writer'])
  assert.equal(offer.path, dsh)
  assert.equal(existsSync(join(paths.userData, 'locations.json')), false, 'the places wait for the answer')
  // The engine warms up on the new data location while the card is up.
  hostState.release()
  await waitFor(() => startState().done.includes('engine'), 'warm the engine up')
  assert.equal(startState().view, 'card', 'the card stays up')

  // 「不复制可以重新生成的文件夹」, ticked on the card.
  const start = startWindows()[0]
  start.webContents.mainFrame.url = start.url
  state.ipc.get('ds-bot:start-act')({ sender: start.webContents, senderFrame: start.webContents.mainFrame }, 'importOption', { option: 'regen', value: true })
  await waitFor(() => startState().card.options.regen === true, 'tick the option on the card')
  await startAct('answer', 'copy')
  await waitFor(() => existsSync(join(home, '.ds-bot', 'bot', 'imported.json')), 'copy the team')
  await waitFor(() => window()?.loaded.some(url => url.includes('token=')), 'start the copied team')
  const steps = cards().filter(card => card.kind === 'copying').map(card => card.step)
  assert.ok(steps.includes(1) && steps.includes(2) && steps.at(-1) === 3, `the copy shows its three steps (${steps.join(',')})`)
  assert.equal(startState().card, undefined, 'the copying card goes once the team\'s engine is up')
  assert.deepEqual(startState().done, ['data', 'import', 'engine'], 'the import\'s stage is done, and the engine\'s again')
  assert.ok(existsSync(join(home, 'DS Bot', 'draft.md')), 'the work files came along')
  assert.equal(existsSync(join(home, 'DS Bot', 'node_modules')), false, 'the regenerable folders did not')
  assert.equal(JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8')).dataDir, join(home, '.ds-bot'))
  assert.deepEqual(messageBoxes(), [], 'no message box on the way')
  assert.equal(hostState.starts, 3, 'the warm engine, the chats\' check and the team\'s engine')
  await handOff()
  app.quit()
  await waitFor(() => state.tray?.destroyed === true, 'end the app')
})
