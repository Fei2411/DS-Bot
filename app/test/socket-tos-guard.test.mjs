import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'node:test'
import { installSocketTosGuard } from '../src/socket-tos-guard.mjs'

test('installSocketTosGuard returns false when setTypeOfService is missing', () => {
  assert.equal(installSocketTosGuard(null), false)
  assert.equal(installSocketTosGuard({}), false)
  assert.equal(installSocketTosGuard({ setTypeOfService: 'nope' }), false)
})

test('installSocketTosGuard forwards calls and return value on success', () => {
  const seen = []
  const target = {
    setTypeOfService(tos) {
      seen.push([this, tos])
      return this
    },
  }
  assert.equal(installSocketTosGuard(target), true)
  const socket = { id: 1 }
  assert.equal(target.setTypeOfService.call(socket, 0), socket)
  assert.deepEqual(seen, [[socket, 0]])
})

test('installSocketTosGuard swallows EINVAL and setTypeOfService syscall errors', () => {
  const einval = Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
  const syscallErr = Object.assign(new Error('unsupported'), { code: 'ENOPROTOOPT', syscall: 'setTypeOfService' })
  let nextError = einval
  const target = {
    setTypeOfService() {
      throw nextError
    },
  }
  assert.equal(installSocketTosGuard(target), true)
  const socket = { id: 2 }
  assert.equal(target.setTypeOfService.call(socket, 0), socket)
  nextError = syscallErr
  assert.equal(target.setTypeOfService.call(socket, 0), socket)
})

test('installSocketTosGuard re-throws validation and unrelated errors', () => {
  let nextError = Object.assign(new TypeError('bad type'), { code: 'ERR_INVALID_ARG_TYPE' })
  const target = {
    setTypeOfService() {
      throw nextError
    },
  }
  assert.equal(installSocketTosGuard(target), true)
  assert.throws(() => target.setTypeOfService('bad'), { code: 'ERR_INVALID_ARG_TYPE' })
  nextError = Object.assign(new Error('denied'), { code: 'EACCES', syscall: 'other' })
  assert.throws(() => target.setTypeOfService(0), { code: 'EACCES' })
})

test('installSocketTosGuard is idempotent and guards net.Socket.prototype cleanly', () => {
  let calls = 0
  const target = {
    setTypeOfService() {
      calls += 1
      return 'ok'
    },
  }
  assert.equal(installSocketTosGuard(target), true)
  const wrapped = target.setTypeOfService
  assert.equal(installSocketTosGuard(target), true)
  assert.equal(target.setTypeOfService, wrapped)
  assert.equal(target.setTypeOfService(0), 'ok')
  assert.equal(calls, 1)

  if (typeof net.Socket.prototype.setTypeOfService === 'function') {
    const original = net.Socket.prototype.setTypeOfService
    try {
      assert.equal(installSocketTosGuard(), true)
      assert.equal(installSocketTosGuard(), true)
      const protoSocket = new net.Socket()
      assert.throws(() => protoSocket.setTypeOfService('bad'), { code: 'ERR_INVALID_ARG_TYPE' })
      protoSocket.destroy()
    } finally {
      net.Socket.prototype.setTypeOfService = original
    }
  }
})
