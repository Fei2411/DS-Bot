import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { forgetKeptFiles, keepDraft } from '../src/client/draft-keep.js'
import {
  hasUnsentReloadRisk,
  registerReloadConfirmHost,
  registerReloadGuard,
  requestWindowReload,
} from '../src/client/reload-action.js'

beforeEach(() => {
  forgetKeptFiles()
})

test('registerReloadGuard composes external checks with hasKeptDraftFiles and supports unregistration', () => {
  let externalRisk = false
  const off = registerReloadGuard(() => externalRisk)
  const offNoop = registerReloadGuard(null)
  try {
    assert.equal(hasUnsentReloadRisk(), false)

    externalRisk = true
    assert.equal(hasUnsentReloadRisk(), true)

    let reloaded = 0
    let confirmReq = null
    const offHost = registerReloadConfirmHost((req) => { confirmReq = req })
    try {
      assert.equal(requestWindowReload({ reload: () => { reloaded += 1 } }), 'confirming')
      assert.equal(reloaded, 0)
      assert.ok(confirmReq && typeof confirmReq.confirm === 'function')

      confirmReq.confirm()
      assert.equal(reloaded, 1)
    } finally {
      offHost()
    }

    // Without host or globalThis.confirm, blocks without reloading and reports warning.
    const prevConfirm = globalThis.confirm
    globalThis.confirm = undefined
    try {
      let blockedReason = null
      assert.equal(
        requestWindowReload({
          reload: () => { reloaded += 1 },
          onBlocked: (reason) => { blockedReason = reason },
        }),
        'blocked',
      )
      assert.equal(reloaded, 1)
      assert.match(String(blockedReason), /Unsent attachments will be removed/)
    } finally {
      if (prevConfirm === undefined) delete globalThis.confirm
      else globalThis.confirm = prevConfirm
    }

    // Unregistering clears the guard and allows direct reload again.
    off()
    offNoop()
    assert.equal(hasUnsentReloadRisk(), false)
    assert.equal(requestWindowReload({ reload: () => { reloaded += 1 } }), 'reloaded')
    assert.equal(reloaded, 2)
  } finally {
    off()
  }
})

test('hasUnsentReloadRisk isolates throwing guards and still honors subsequent guards and kept draft files', () => {
  let secondRisk = false
  const offThrow = registerReloadGuard(() => { throw new Error('boom') })
  const offSecond = registerReloadGuard(() => secondRisk)
  try {
    assert.equal(hasUnsentReloadRisk(), false)

    secondRisk = true
    assert.equal(hasUnsentReloadRisk(), true)

    secondRisk = false
    assert.equal(hasUnsentReloadRisk(), false)

    keepDraft({
      chatId: 'bot-1',
      part: 'p1',
      text: '',
      files: [{ kind: 'file', file: { name: 'a.txt' } }],
    }, { getItem: () => null, setItem() {}, removeItem() {} })
    assert.equal(hasUnsentReloadRisk(), true)
  } finally {
    offThrow()
    offSecond()
  }
})
