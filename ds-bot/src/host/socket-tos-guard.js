import { Socket } from 'node:net'

// The desktop Host and its loaded plugin can have different copies of this package.
const ACQUIRE = Symbol.for('ds-bot.socketTosGuard.acquire')

export function installSocketTosGuard(target = process.platform === 'darwin' ? Socket.prototype : undefined) {
  const original = target?.setTypeOfService
  if (typeof original !== 'function') return () => {}
  if (original[ACQUIRE]) return original[ACQUIRE]()

  const owners = new Set()
  function acquire() {
    const release = () => {
      if (owners.delete(release) && owners.size === 0 && target.setTypeOfService === setTypeOfService) {
        target.setTypeOfService = original
      }
    }
    owners.add(release)
    return release
  }

  // Node 24's bundled Undici sets TOS while writing an HTTP/1.1 request. On macOS
  // the socket option can fail with EINVAL even though the request can proceed (#2051).
  function setTypeOfService(tos) {
    try {
      return original.call(this, tos)
    } catch (error) {
      // A later wrapper may still call this one after the last owner has unloaded.
      if (owners.size > 0 && error?.syscall === 'setTypeOfService' && error.code === 'EINVAL') return this
      throw error
    }
  }
  Object.defineProperty(setTypeOfService, ACQUIRE, { value: acquire })
  target.setTypeOfService = setTypeOfService
  return acquire()
}
