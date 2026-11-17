import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/chat-index.js'

// #1548: read_own_chat runs in the part that asks. A part opened while the Bot was busy
// is its own thread: its history and anchors come from that thread's parts, not from the
// foreground chat. The index is unavailable here (its folder cannot be made), so these
// reads take the log-scanning path, which uses the same parts list.

function runtime() {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-thread-chat-'))
  // A file where the index folder would go: opening the index fails, the scan is used.
  const home = join(dir, 'home')
  writeFileSync(home, 'not a folder')
  const said = new Map([
    ['fg1', [{ seq: 1, time: 1000, who: 'user', text: 'foreground question' }]],
    ['fg2', [{ seq: 1, time: 2000, who: 'user', text: 'foreground latest' }]],
    ['bg1', [{ seq: 1, time: 1100, who: 'user', text: 'background thread beginning' }]],
    ['bg2', [{ seq: 1, time: 2100, who: 'user', text: 'background thread latest' }]],
  ])
  const rt = {
    ctx: { get: () => undefined, effect: () => {}, on: () => () => {} },
    home,
    partsOf: () => [
      { sessionId: 'fg1', number: 1, startedAt: 900, endedAt: 1500 },
      { sessionId: 'fg2', number: 2, startedAt: 1500 },
    ],
    partsOfThread: (botId, sessionId) => (sessionId === 'bg2'
      ? [
          { sessionId: 'bg1', number: 1, startedAt: 1000, endedAt: 2000 },
          { sessionId: 'bg2', number: 2, startedAt: 2000 },
        ]
      : rt.partsOf()),
    partLines: async function* (sessionId) { for (const line of said.get(sessionId) ?? []) yield line },
    clock: () => 'now',
    warn: () => {},
  }
  install(rt)
  return rt
}

test('a background part reads its own thread, not the foreground chat', async () => {
  const rt = runtime()
  const lines = await rt.latestOwnChat('b1', { askingId: 'bg2' })
  assert.deepEqual(lines, ['[part 1 · now] background thread beginning', '[part 2 · now] background thread latest'])
  const foreground = await rt.latestOwnChat('b1', { askingId: 'fg2' })
  assert.deepEqual(foreground, ['[part 1 · now] foreground question', '[part 2 · now] foreground latest'])
})

test('search in a background part only sees that thread', async () => {
  const rt = runtime()
  const found = await rt.searchOwnChat('b1', 'background', { askingId: 'bg2' })
  assert.deepEqual(found.lines, ['[part 1 · now] background thread beginning', '[part 2 · now] background thread latest'])
  const none = await rt.searchOwnChat('b1', 'foreground', { askingId: 'bg2' })
  assert.deepEqual(none.lines, [])
})
