// The one-time confirmation before the window hides into the tray.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { BackgroundNotice } from '../src/background-notice.mjs'

const settle = () => new Promise(resolve => setImmediate(resolve))

function harness({ answer = 0, marker, show } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'ds-bot-notice-'))
  const asked = []
  const notice = new BackgroundNotice({
    marker: marker ?? join(folder, 'acknowledged'),
    show: show ?? (async options => { asked.push(options); return { response: answer } }),
    message: 'The app goes on.', confirm: 'OK',
    log: { warn: () => {} },
  })
  return { notice, asked, folder, cleanup: () => rmSync(folder, { recursive: true, force: true }) }
}

describe('the notice before the window hides', () => {
  test('an answered notice hides the window and is remembered', async (t) => {
    const app = harness()
    t.after(app.cleanup)
    let hidden = 0
    app.notice.close(() => { hidden += 1 })
    await settle()
    assert.equal(hidden, 1, 'the window is hidden')
    assert.equal(existsSync(join(app.folder, 'acknowledged')), true, 'the answer is kept')
  })

  test('a cancelled notice leaves the window where it is', async (t) => {
    const app = harness({ answer: -1 })
    t.after(app.cleanup)
    let hidden = 0
    app.notice.close(() => { hidden += 1 })
    await settle()
    assert.equal(hidden, 0, 'the window stays')
    assert.equal(existsSync(join(app.folder, 'acknowledged')), false, 'nothing is kept')
  })

  test('a notice that is answered once is not shown again', async (t) => {
    const app = harness()
    t.after(app.cleanup)
    let hidden = 0
    app.notice.close(() => { hidden += 1 })
    await settle()
    app.notice.close(() => { hidden += 1 })
    await settle()
    assert.equal(app.asked.length, 1, 'the notice is shown once')
    assert.equal(hidden, 2, 'the window hides every time')
  })

  test('a second close while the box is open joins it', async (t) => {
    const app = harness()
    t.after(app.cleanup)
    let focused = 0
    const notice = new BackgroundNotice({
      marker: join(app.folder, 'acknowledged'),
      show: async options => { app.asked.push(options); return { response: 0 } },
      focus: () => { focused += 1 },
      message: 'The app goes on.', confirm: 'OK',
      log: { warn: () => {} },
    })
    notice.close(() => {})
    notice.close(() => {})
    await settle()
    assert.equal(app.asked.length, 1, 'the notice is shown once')
    assert.equal(focused, 1, 'the open box is taken up again')
  })

  test('an answer that comes after the app left hides nothing', async (t) => {
    const app = harness()
    t.after(app.cleanup)
    let hidden = 0
    app.notice.close(() => { hidden += 1 })
    app.notice.dispose()
    await settle()
    assert.equal(hidden, 0, 'the window is not hidden')
  })

  test('a box that cannot be shown leaves the window where it is', async (t) => {
    const warnings = []
    const app = harness({ show: async () => { throw new Error('no box') } })
    t.after(app.cleanup)
    const notice = new BackgroundNotice({
      marker: join(app.folder, 'acknowledged'),
      show: async () => { throw new Error('no box') },
      message: 'The app goes on.', confirm: 'OK',
      log: { warn: message => warnings.push(message) },
    })
    let hidden = 0
    notice.close(() => { hidden += 1 })
    await settle()
    assert.equal(hidden, 0, 'the window stays')
    assert.equal(warnings.length, 1, 'the failure is logged')
  })
})
