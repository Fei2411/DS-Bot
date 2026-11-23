import assert from 'node:assert/strict'
import { Socket } from 'node:net'
import { constants } from 'node:os'
import { test } from 'node:test'
import { startApp } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

test('the desktop main process installs the macOS TOS guard at startup', async () => {
  const original = Socket.prototype.setTypeOfService
  await installHooks()
  await startApp()
  if (process.platform !== 'darwin' || typeof original !== 'function') {
    assert.equal(Socket.prototype.setTypeOfService, original)
    return
  }
  const socket = new Socket()
  try {
    socket._handle = { setTypeOfService: () => -constants.errno.EINVAL }
    assert.equal(socket.setTypeOfService(1), socket)
    socket._handle.setTypeOfService = () => -constants.errno.EACCES
    assert.throws(() => socket.setTypeOfService(2), { code: 'EACCES', syscall: 'setTypeOfService' })
  } finally {
    socket._handle = null
    socket.destroy()
    Socket.prototype.setTypeOfService = original
  }
})
