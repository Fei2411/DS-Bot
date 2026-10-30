// An update prompt waits for the window: a hidden window has no box to show it in.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createDeferredPrompt } from '../src/update-prompt.mjs'

function harness({ answer = true } = {}) {
  const state = { shown: true }
  const asked = []
  const installed = []
  const deferred = createDeferredPrompt({
    ask: async version => { asked.push(version); return answer },
    shown: () => state.shown,
    onYes: async version => { installed.push(version) },
    log: { info: () => {} },
  })
  return { deferred, asked, installed, state }
}

describe('the update prompt', () => {
  test('a prompt for a visible window is asked at once', async () => {
    const app = harness()
    assert.equal(await app.deferred.prompt('0.2.3'), true)
    assert.deepEqual(app.asked, ['0.2.3'])
    assert.deepEqual(app.installed, [], 'the updater does the work itself')
  })

  test('a prompt for a hidden window waits, and is asked when the window is shown', async () => {
    const app = harness()
    app.state.shown = false
    assert.equal(await app.deferred.prompt('0.2.3'), false, 'the updater hears no for now')
    assert.deepEqual(app.asked, [], 'the box is not shown')
    assert.equal(app.deferred.waiting(), '0.2.3', 'the update waits')

    app.state.shown = true
    await app.deferred.flush()
    assert.deepEqual(app.asked, ['0.2.3'], 'the box is shown now')
    assert.deepEqual(app.installed, ['0.2.3'], 'the answer does the work')
    assert.equal(app.deferred.waiting(), undefined, 'the update does not wait any more')
  })

  test('a second showing does not ask again', async () => {
    const app = harness()
    app.state.shown = false
    await app.deferred.prompt('0.2.3')
    app.state.shown = true
    await app.deferred.flush()
    await app.deferred.flush()
    assert.deepEqual(app.asked, ['0.2.3'], 'the box is shown once')
    assert.deepEqual(app.installed, ['0.2.3'], 'the update is installed once')
  })

  test('a later answer of no does not install anything', async () => {
    const app = harness({ answer: false })
    app.state.shown = false
    await app.deferred.prompt('0.2.3')
    app.state.shown = true
    await app.deferred.flush()
    assert.deepEqual(app.asked, ['0.2.3'])
    assert.deepEqual(app.installed, [], 'the update waits for the next quit')
  })

  test('a prompt that waits does nothing while the window is still hidden', async () => {
    const app = harness()
    app.state.shown = false
    await app.deferred.prompt('0.2.3')
    await app.deferred.flush()
    assert.deepEqual(app.asked, [])
    assert.deepEqual(app.installed, [])
  })
})
