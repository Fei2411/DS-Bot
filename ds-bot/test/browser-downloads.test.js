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

// Every fake page has the same main frame; a request names it to come from the page itself.
const MAIN_FRAME = {}

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
      mainFrame: () => MAIN_FRAME,
      title: async () => 'Reports',
      ariaSnapshot: async () => '- button "Export CSV" [ref=e1]',
      waitForLoadState: async () => {},
      goto: async () => options.open?.(target),
      locator: () => ({
        count: async () => 1,
        evaluate: async () => options.write ?? null,
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
    actionTimeout: options.actionTimeout ?? 400, downloadGraceMs: options.downloadGraceMs, getHold: options.getHold,
  })
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer)
    await session.close()
    await rm(directory, { recursive: true, force: true })
  })
  const files = async () => (await readdir(directory)).filter(name => name.endsWith('.csv')).sort()
  return { session, context, primary, other, directory, files }
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

// DSH ends the whole process on a rejection that nobody handles, so the Bot's browser must
// leave none behind, whatever order the page's events come in.
function watchUnhandled(t) {
  const seen = []
  const record = reason => { seen.push(reason) }
  process.on('unhandledRejection', record)
  t.after(() => { process.off('unhandledRejection', record) })
  return seen
}

const PUBLISH = { kind: 'post', label: 'Publish', origin: 'https://reports.example.test', host: 'reports.example.test' }
const publishRequest = (errorText, { navigation = false, path = '/publish', frame = MAIN_FRAME } = {}) => ({
  url: () => `https://reports.example.test${path}`,
  method: () => 'POST',
  isNavigationRequest: () => navigation,
  frame: () => frame,
  failure: () => (errorText === undefined ? null : { errorText }),
})
const unknownResult = detail => new RegExp(`"Publish" action on reports\\.example\\.test was sent, but its result is unknown \\(${detail}\\)`)

test('a write request that fails while its click still runs is reported, not left unhandled', async (t) => {
  const unhandled = watchUnhandled(t)
  const request = publishRequest('net::ERR_CONNECTION_RESET')
  const { session } = await fixture(t, {
    write: PUBLISH,
    click: (page, later) => new Promise(resolve => {
      page.emit('request', request)
      page.emit('requestfailed', request)
      later(resolve, 50)
    }),
  })
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.match(result, unknownResult('net::ERR_CONNECTION_RESET'))
  assert.deepEqual(unhandled, [])
})

test('a click that fails after its request failed is reported, not left unhandled', async (t) => {
  const unhandled = watchUnhandled(t)
  const request = publishRequest('net::ERR_CONNECTION_RESET')
  const { session } = await fixture(t, {
    write: PUBLISH,
    click: (page, later) => new Promise((resolve, reject) => {
      page.emit('request', request)
      page.emit('requestfailed', request)
      later(() => reject(new Error('locator.click: Timeout 400ms exceeded')), 50)
    }),
  })
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.match(result, unknownResult('locator.click: Timeout 400ms exceeded'))
  assert.deepEqual(unhandled, [])
})

// A button's script can post after the click itself returned, while the page settles. That
// post is the action's own, so its outcome decides the result as much as an earlier one.
test('a POST the page sends after the click returned is waited for, and its failure reported', async (t) => {
  const unhandled = watchUnhandled(t)
  const request = publishRequest('net::ERR_CONNECTION_RESET')
  const { session } = await fixture(t, {
    write: PUBLISH,
    click: (page, later) => later(() => {
      page.emit('request', request)
      page.emit('requestfailed', request)
    }, 30),
  })
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.match(result, unknownResult('net::ERR_CONNECTION_RESET'))
  assert.deepEqual(unhandled, [])
})

test('a POST sent after the click returned that never answers leaves the result unknown', async (t) => {
  const { session } = await fixture(t, {
    write: PUBLISH,
    click: (page, later) => later(() => page.emit('request', publishRequest()), 30),
  })
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.match(result, unknownResult('the browser request did not finish'))
})

test('a POST sent after the click returned that finishes gives the page as usual', async (t) => {
  const request = publishRequest()
  const { session } = await fixture(t, {
    write: PUBLISH,
    click: (page, later) => later(() => {
      page.emit('request', request)
      page.emit('requestfinished', request)
    }, 30),
  })
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.doesNotMatch(result, /result is unknown/)
  assert.match(result, /Export CSV/)
})

// After a form post loads its result page, that page's own requests (polling its server, say)
// are not the action's: an unanswered one must not hold the action or make its result unknown
// (waited for, it would time out and read "the browser request did not finish").
test('a POST the result page sends after the form navigated is not waited for', async (t) => {
  const submit = publishRequest(undefined, { navigation: true })
  const poll = publishRequest(undefined, { path: '/poll' })
  const { session } = await fixture(t, {
    write: PUBLISH,
    click: (page, later) => {
      page.emit('request', submit)
      later(() => {
        page.emit('requestfinished', submit)
        page.emit('request', poll)
      }, 30)
    },
  })
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.doesNotMatch(result, /result is unknown/)
  assert.match(result, /Export CSV/)
})

// The same for a form inside a frame: what that frame's result page sends is not the action's,
// while the page around it still counts.
const INNER_FRAME = { parentFrame: () => MAIN_FRAME }

test('a POST from a frame whose form navigated is not waited for', async (t) => {
  const submit = publishRequest(undefined, { navigation: true, frame: INNER_FRAME })
  const poll = publishRequest(undefined, { path: '/poll', frame: INNER_FRAME })
  const { session } = await fixture(t, {
    write: PUBLISH,
    click: (page, later) => {
      page.emit('request', submit)
      later(() => {
        page.emit('requestfinished', submit)
        page.emit('request', poll)
      }, 30)
    },
  })
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.doesNotMatch(result, /result is unknown/)
})

test('after a frame navigated, a POST from the page around it still counts', async (t) => {
  const submit = publishRequest(undefined, { navigation: true, frame: INNER_FRAME })
  const outer = publishRequest('net::ERR_CONNECTION_RESET', { path: '/outer' })
  const { session } = await fixture(t, {
    write: PUBLISH,
    click: (page, later) => {
      page.emit('request', submit)
      later(() => {
        page.emit('requestfinished', submit)
        page.emit('request', outer)
        page.emit('requestfailed', outer)
      }, 30)
    },
  })
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.match(result, unknownResult('net::ERR_CONNECTION_RESET'))
})

test('a form post that fails while its page navigates is still reported', async (t) => {
  const submit = publishRequest('net::ERR_CONNECTION_RESET', { navigation: true })
  const { session } = await fixture(t, {
    write: PUBLISH,
    click: (page, later) => {
      page.emit('request', submit)
      later(() => page.emit('requestfailed', submit), 30)
    },
  })
  const result = await gateScope.run(async () => {}, () => session.click('e1'))
  assert.match(result, unknownResult('net::ERR_CONNECTION_RESET'))
})

// A tab the page opens is made current once it has loaded. One that crashes first stays out
// of the way: the Bot keeps working in the tab it had.
test('a new tab that crashes while loading leaves no failure behind', async (t) => {
  const unhandled = watchUnhandled(t)
  const { session, context } = await fixture(t)
  const crashing = new EventEmitter()
  Object.assign(crashing, {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    isClosed: () => false,
    url: () => 'https://reports.example.test/popup',
    waitForLoadState: async () => { throw new Error('page.waitForLoadState: Navigation failed because page crashed!') },
  })
  context.emit('page', crashing)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.match(await session.snapshotText(), /Export CSV/)
  assert.match(await session.snapshotText(), /Export CSV/)
  assert.deepEqual(unhandled, [])
})

test('a click captures a download started asynchronously after 120 ms', async (t) => {
  const incoming = download()
  const { session, directory, files } = await fixture(t, {
    click: (page, later) => later(() => page.emit('download', incoming), 120),
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
    click: (page, later) => later(() => page.emit('download', incoming), 120),
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

// A click waits for a download, but only for its own grace window: a large
// actionTimeout must not make an ordinary click slower. The clock starts at the
// click, so the assertion is about the wait the session schedules rather than how
// long the runner took to get there.
test('a click with no download returns after the download grace, not the action timeout', async (t) => {
  let markClicked
  const clicked = new Promise(resolve => { markClicked = resolve })
  let clockStarted = false
  const { session } = await fixture(t, {
    actionTimeout: 5_000,
    click: () => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
      clockStarted = true
      markClicked()
    },
  })
  let finished = false
  const pending = session.click('e1').then(value => {
    finished = true
    return value
  })
  pending.catch(() => {})
  try {
    await clicked
    await new Promise(resolve => setImmediate(resolve))
    // The settle that follows the click is a fixed 150 ms, and it counts against
    // the 300 ms grace: the click must not have returned yet.
    t.mock.timers.tick(150)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false, 'the click is still inside its 300 ms download grace after the settle')

    t.mock.timers.tick(149)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false, 'the click holds until the full 300 ms download grace elapses')

    t.mock.timers.tick(1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, true, 'the click returns at its 300 ms download grace instead of waiting for the 5 s actionTimeout')
    await pending
  } finally {
    if (clockStarted) t.mock.timers.reset()
  }
})

// A download that starts after the grace window is not captured: it is canceled and
// named in the next snapshot, never silently dropped.
test('a download that starts after the grace window is canceled and reported', async (t) => {
  const incoming = download()
  const { session, files } = await fixture(t, {
    downloadGraceMs: 100,
    click: (page, later) => later(() => page.emit('download', incoming), 400),
  })
  await session.click('e1')
  await incoming.whenCanceled
  const snapshot = await session.snapshotText()
  assert.match(snapshot, /Download "report.csv".*after.*action.*canceled/i)
  assert.equal(incoming.canceled, 1)
  assert.deepEqual(await files(), [])
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
      later(() => page.emit('download', incoming), 120)
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
      later(() => popup.emit('download', incoming), 120)
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
      later(() => page.emit('download', incoming), 120)
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
        later(() => page.emit('download', incoming), 120)
      },
    })
    const approvals = []
    const script = gateScope.run(async action => { approvals.push(['script', action.label]) }, () => session.runScript(`click("e1"); ${ending}`))
    if (ending.startsWith('throw')) await assert.rejects(script, /script failed/)
    else assert.equal(await script, 'finished')
    const next = await gateScope.run(async action => { approvals.push(['next', action.label]) }, () => session.click('e1'))
    assert.match(next, /Downloaded "report-2.csv"/)
    assert.deepEqual(approvals, [['next', 'report-2.csv']])
    assert.deepEqual(await files(), ['report-2.csv'])
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
      }, 120),
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


test('a script ending during download approval releases its helper and cannot save later', { timeout: 5000 }, async (t) => {
  const incoming = download()
  const asked = deferred()
  const answer = deferred()
  const { session, files } = await fixture(t, { click: page => page.emit('download', incoming) })
  const running = gateScope.run(async () => { asked.resolve(); await answer.promise }, () =>
    session.runScript('void click("e1"); await new Promise(resolve => setTimeout(resolve, 600)); done("finished");'))
  await asked.promise
  assert.equal(await running, 'finished')
  answer.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(incoming.saved, 0)
  assert.deepEqual(await files(), [])
  assert.equal(incoming.canceled, 1)
})
