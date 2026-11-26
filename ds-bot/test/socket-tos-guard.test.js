import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { Socket } from 'node:net'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { installSocketTosGuard } from 'ds-bot/socket-tos-guard'
import { fakeContext } from './fake-ctx.js'

const native = Socket.prototype.setTypeOfService

test('a runtime without setTypeOfService needs no guard', () => {
  const target = {}
  installSocketTosGuard(target)()
  assert.equal(target.setTypeOfService, undefined)
})

// Node caches the last TOS value, so use a different value for each handle call.
test('the native socket method converts handle errno and only its own EINVAL is ignored', {
  skip: typeof native !== 'function' || process.platform === 'win32',
}, t => {
  const socket = new Socket()
  let errno = -constants.errno.EINVAL
  const handle = { setTypeOfService: () => errno }
  socket._handle = handle
  t.after(() => { socket._handle = null; socket.destroy() })
  assert.throws(() => socket.setTypeOfService(1), { code: 'EINVAL', syscall: 'setTypeOfService', errno })
  t.after(installSocketTosGuard(socket))
  assert.equal(socket.setTypeOfService(2), socket)
  errno = -constants.errno.EACCES
  assert.throws(() => socket.setTypeOfService(3), { code: 'EACCES', syscall: 'setTypeOfService', errno })
  errno = 0
  assert.equal(socket.setTypeOfService(4), socket)
  assert.throws(() => socket.setTypeOfService('bad'), { code: 'ERR_INVALID_ARG_TYPE' })
  const unrelated = Object.assign(new Error('write EINVAL'), { code: 'EINVAL', syscall: 'write' })
  handle.setTypeOfService = () => { throw unrelated }
  assert.throws(() => socket.setTypeOfService(5), error => error === unrelated)
})

test('two Cordis scopes share the guard until both are disposed', async () => {
  const original = () => 'ok'
  const target = { setTypeOfService: original }
  const first = new Context()
  const second = new Context()
  first.effect(() => installSocketTosGuard(target))
  const guarded = target.setTypeOfService
  second.effect(() => installSocketTosGuard(target))
  assert.notEqual(guarded, original)
  assert.equal(target.setTypeOfService, guarded)
  await first.fiber.dispose()
  assert.equal(target.setTypeOfService, guarded)
  assert.equal(target.setTypeOfService(0), 'ok')
  await second.fiber.dispose()
  assert.equal(target.setTypeOfService, original)
})

test('dispose leaves a later wrapper installed and makes the retained guard transparent', () => {
  const error = Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' })
  const target = { setTypeOfService() { throw error } }
  const release = installSocketTosGuard(target)
  const guarded = target.setTypeOfService
  function later(tos) { return guarded.call(this, tos) }
  target.setTypeOfService = later
  assert.equal(target.setTypeOfService(0), target)
  release()
  assert.equal(target.setTypeOfService, later)
  assert.throws(() => target.setTypeOfService(0), caught => caught === error)
})

test('plugin import preserves the socket prototype and activation owns the macOS guard', async t => {
  const plugin = await import('ds-bot')
  await import('../index.js')
  assert.equal(Socket.prototype.setTypeOfService, native)
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-tos-'))
  const ctx = fakeContext()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  try {
    await plugin.apply(ctx, { home })
    if (process.platform === 'darwin' && typeof native === 'function') {
      assert.notEqual(Socket.prototype.setTypeOfService, native)
    } else {
      assert.equal(Socket.prototype.setTypeOfService, native)
    }
  } finally {
    await ctx.dispose()
  }
  assert.equal(Socket.prototype.setTypeOfService, native)
})
