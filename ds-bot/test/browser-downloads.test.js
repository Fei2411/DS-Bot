import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gateScope } from '../src/host/browser/gate.js'
import { createSession } from '../src/host/browser/session.js'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ds-bot-download-'))
  const timers = new Set()
  const later = (callback, ms) => {
    const timer = setTimeout(callback, ms)
    timers.add(timer)
  }
  function page() {
    const target = new EventEmitter()
    let closed = false
    Object.assign(target, {
      setDefaultTimeout() {},
      setDefaultNavigationTimeout() {},
      isClosed: () => closed,
      url: () => 'https://reports.example.test/export',
      title: async () => 'Reports',
      ariaSnapshot: async () => '- button "Export CSV" [ref=e1]',
      waitForLoadState: async () => {},
      goto: async () => options.open?.(target),
      locator: () => ({
        count: async () => 1,
        evaluate: async () => null,
        click: async () => options.click?.(target, later),
        fill: async () => {},
        press: async () => options.click?.(target, later),
        selectOption: async () => options.click?.(target, later),
      }),
      keyboard: { press: async () => options.click?.(target, later) },
      close: async () => { closed = true; target.emit('close') },
    })
    return target
  }
  const primary = page()
  const other = page()
  const context = new EventEmitter()
  context.pages = () => [primary, other]
  context.cookies = async () => []
  context.close = async () => { await primary.close(); await other.close() }
  const session = createSession({
    context, page: primary, botId: 'b1', userDataDir: directory,
    cookieFile: join(directory, 'cookies.json'), downloadDir: async () => directory,
    actionTimeout: options.actionTimeout ?? 400, getHold: options.getHold,
  })
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer)
    await session.close()
    await rm(directory, { recursive: true, force: true })
  })
  const files = async () => (await readdir(directory)).filter(name => name.endsWith('.csv')).sort()
  return { session, primary, other, directory, files }
}

function download({ filename = 'report.csv', saveError } = {}) {
  const canceled = deferred()
  const value = {
    saved: 0, deleted: 0, canceled: 0,
    whenCanceled: canceled.promise,
    suggestedFilename: () => filename,
    url: () => 'https://reports.example.test/report.csv',
    async saveAs(path) {
      if (saveError) throw saveError
      await writeFile(path, 'id,name\n1,fixture\n')
      value.saved += 1
    },
    async cancel() { value.canceled += 1; canceled.resolve() },
    async delete() { value.deleted += 1 },
  }
  return value
}

test('a click captures a download started asynchronously after 250 ms', async (t) => {
  const incoming = download()
  const { session, directory, files } = await fixture(t, {
    click: (page, later) => later(() => page.emit('download', incoming), 250),
  })
  const actions = []
  const result = await gateScope.run(async action => { actions.push(action) }, () => session.click('e1'))
  assert.match(result, /Downloaded "report.csv" to /)
  assert.deepEqual(await files(), ['report.csv'])
  assert.equal(await readFile(join(directory, 'report.csv'), 'utf8'), 'id,name\n1,fixture\n')
  assert.deepEqual(actions, [{ kind: 'download', label: 'report.csv', origin: 'https://reports.example.test', host: 'reports.example.test' }])
  assert.equal(incoming.canceled, 0)
})

test('an asynchronously started download still needs its original approval', async (t) => {
  const incoming = download()
  const { session, files } = await fixture(t, {
    click: (page, later) => later(() => page.emit('download', incoming), 250),
  })
  let approvals = 0
  const result = await gateScope.run(async () => {
    approvals += 1
    throw new Error('Download approval was refused. Nothing was saved.')
  }, () => session.click('e1'))
  assert.equal(approvals, 1)
  assert.match(result, /Download approval was refused/)
  assert.deepEqual(await files(), [])
  assert.equal(incoming.canceled, 1)
  assert.equal(incoming.deleted, 1)
})

// The observation window belongs to actions that can start a download from a click.
// A select and an ordinary key press are not clicks: they return without holding the
// action open for the whole actionTimeout.
test('a select does not wait for a download', async (t) => {
  const { session } = await fixture(t, { actionTimeout: 1_500 })
  const started = Date.now()
  await session.select('e1', ['a'])
  assert.ok(Date.now() - started < 1_000, 'select returned before the download window')
})

test('a key press other than Enter does not wait for a download', async (t) => {
  const { session } = await fixture(t, { actionTimeout: 1_500 })
  const started = Date.now()
  await session.press('ArrowDown')
  assert.ok(Date.now() - started < 1_000, 'a non-Enter press returned before the download window')
})

// The same fixture, a click and no download: that is the action the window is for,
// so it does hold until the deadline. This is what the two tests above do not do.
test('a click with no download holds until the action timeout', async (t) => {
  const { session } = await fixture(t, { actionTimeout: 1_500 })
  const started = Date.now()
  await session.click('e1')
  assert.ok(Date.now() - started >= 1_000, 'the click kept its download window')
})

// Enter can submit a form whose answer is a download, so it keeps the window.
test('an Enter press keeps the download window and captures a delayed download', async (t) => {
  const incoming = download()
  const { session, files } = await fixture(t, {
    click: (page, later) => later(() => page.emit('download', incoming), 150),
  })
  const result = await session.press('Enter')
  assert.match(result, /Downloaded "report.csv" to /)
  assert.deepEqual(await files(), ['report.csv'])
  assert.equal(incoming.canceled, 0)
})

test('a download from another tab is not included in the current action', async (t) => {
  const unrelated = download()
  const incoming = download({ filename: 'current.csv' })
  let other
  const fixtureValue = await fixture(t, {
    click: (page, later) => {
      other.emit('download', unrelated)
      later(() => page.emit('download', incoming), 250)
    },
  })
  other = fixtureValue.other
  const actions = []
  const result = await gateScope.run(async action => { actions.push(action.label) }, () => fixtureValue.session.click('e1'))
  assert.deepEqual(actions, ['current.csv'])
  assert.deepEqual(await fixtureValue.files(), ['current.csv'])
  assert.match(result, /Downloaded "current.csv"/)
  assert.equal(unrelated.saved, 0)
  assert.equal(unrelated.canceled, 1)
})

test('a popup opened by the action can deliver its download', async (t) => {
  const incoming = download()
  let popup
  const { session, other, files } = await fixture(t, {
    click: (page, later) => {
      page.emit('popup', popup)
      later(() => popup.emit('download', incoming), 250)
    },
  })
  popup = other
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.match(result, /Downloaded "report.csv"/)
  assert.deepEqual(await files(), ['report.csv'])
})

test('parallel script helpers return each action with its own download result', async (t) => {
  let count = 0
  const { session, files } = await fixture(t, {
    click: (page, later) => {
      const incoming = download({ filename: `report-${++count}.csv` })
      later(() => page.emit('download', incoming), 250)
    },
  })
  const answer = await gateScope.run(async () => {}, () => session.runScript(
    'done(JSON.stringify(await Promise.all([click("e1"), click("e1")])))',
  ))
  const results = JSON.parse(answer)
  assert.equal(results.length, 2)
  assert.match(results[0], /Downloaded "report-1.csv"/)
  assert.doesNotMatch(results[0], /Downloaded "report-2.csv"/)
  assert.match(results[1], /Downloaded "report-2.csv"/)
  assert.deepEqual(await files(), ['report-1.csv', 'report-2.csv'])
})

for (const ending of ['done("finished")', 'throw new Error("script failed")']) {
  test(`a script drains its active helper before returning from ${ending}`, async (t) => {
    let count = 0
    const { session, files } = await fixture(t, {
      click: (page, later) => {
        const incoming = download({ filename: `report-${++count}.csv` })
        later(() => page.emit('download', incoming), 250)
      },
    })
    const approvals = []
    const script = gateScope.run(async action => { approvals.push(['script', action.label]) }, () => session.runScript(`click("e1"); ${ending}`))
    if (ending.startsWith('throw')) await assert.rejects(script, /script failed/)
    else assert.equal(await script, 'finished')
    const next = await gateScope.run(async action => { approvals.push(['next', action.label]) }, () => session.click('e1'))
    assert.match(next, /Downloaded "report-2.csv"/)
    assert.deepEqual(approvals, [['script', 'report-1.csv'], ['next', 'report-2.csv']])
    assert.deepEqual(await files(), ['report-1.csv', 'report-2.csv'])
  })
}

test('a finished script does not start helpers queued behind its active helper', async (t) => {
  let clicks = 0
  const { session } = await fixture(t, { click: () => { clicks += 1 } })
  await session.runScript('click("e1"); click("e1"); done("finished")')
  assert.equal(clicks, 1)
})

for (const action of ['click', 'submit']) {
  test(`a delayed ${action} download returns the current page snapshot`, async (t) => {
    const incoming = download()
    const { session } = await fixture(t, {
      click: (page, later) => later(() => {
        page.ariaSnapshot = async () => '- status "Export ready"'
        page.emit('download', incoming)
      }, 250),
    })
    const result = await gateScope.run(async () => {}, () => action === 'click'
      ? session.click('e1')
      : session.type('e1', 'report', true))
    assert.match(result, /Export ready/)
    assert.match(result, /Downloaded "report.csv"/)
  })
}

test('downloads arriving during approval stay in the same action and avoid overwrites', async (t) => {
  const first = download()
  const second = download()
  const approving = deferred()
  const release = deferred()
  const { session, primary, files } = await fixture(t, {
    click: page => page.emit('download', first),
  })
  let approvals = 0
  const running = gateScope.run(async () => {
    approvals += 1
    if (approvals === 1) { approving.resolve(); await release.promise }
  }, () => session.click('e1'))
  await approving.promise
  primary.emit('download', second)
  release.resolve()
  const result = await running
  assert.equal(approvals, 2)
  assert.deepEqual(await files(), ['report (2).csv', 'report.csv'])
  assert.equal((result.match(/Downloaded "report.csv"/g) ?? []).length, 2)
  assert.equal(second.canceled, 0)
})

test('a late download is canceled and reported by the next snapshot', async (t) => {
  const { session, primary, files } = await fixture(t)
  await session.click('e1')
  const incoming = download()
  primary.emit('download', incoming)
  await incoming.whenCanceled
  const snapshot = await session.snapshotText()
  assert.match(snapshot, /Download "report.csv".*after.*action.*canceled/i)
  assert.deepEqual(await files(), [])
})

test('a download failure is reported and its reserved file is removed', async (t) => {
  const incoming = download({ saveError: new Error('fixture write failed') })
  const { session, files } = await fixture(t, { click: page => page.emit('download', incoming) })
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.match(result, /Download "report.csv" failed: fixture write failed/)
  assert.deepEqual(await files(), [])
  assert.equal(incoming.canceled, 1)
})

test('opening an attachment keeps the Download is starting path working', async (t) => {
  const incoming = download()
  const { session, files } = await fixture(t, {
    open: page => {
      setTimeout(() => page.emit('download', incoming), 20)
      throw new Error('page.goto: Download is starting')
    },
  })
  const result = await gateScope.run(async () => {}, () => session.open('https://reports.example.test/report.csv'))
  assert.match(result, /Downloaded "report.csv"/)
  assert.deepEqual(await files(), ['report.csv'])
})

test('user takeover during approval cancels the download before saving', async (t) => {
  const incoming = download()
  let hold
  const { session, files } = await fixture(t, {
    click: page => page.emit('download', incoming),
    getHold: () => hold,
  })
  const result = await gateScope.run(async () => { hold = { by: 'user' } }, () => session.click('e1'))
  assert.match(result, /user has taken over/i)
  assert.equal(incoming.saved, 0)
  assert.equal(incoming.canceled, 1)
  assert.deepEqual(await files(), [])
})

test('closing a session releases its download wait and cancels later events', async (t) => {
  const clicked = deferred()
  const { session, primary, files } = await fixture(t, { click: () => { clicked.resolve() } })
  const running = session.click('e1')
  await clicked.promise
  await session.close()
  const incoming = download()
  primary.emit('download', incoming)
  await running.catch(() => {})
  assert.equal(incoming.saved, 0)
  assert.equal(incoming.canceled, 1)
  assert.deepEqual(await files(), [])
})
