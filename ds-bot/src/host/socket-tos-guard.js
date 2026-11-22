import net from 'node:net'

// Node 24's bundled undici calls setTypeOfService(0) for Happy Eyeballs; dual-stack or
// scoped macOS sockets throw EINVAL and leave built-in fetch/HTTP connections failing (#2051).
const GUARDED = Symbol.for('ds-bot.socketTosGuarded')

export function installSocketTosGuard(target = net.Socket?.prototype) {
  if (!target || typeof target.setTypeOfService !== 'function') return false
  if (target.setTypeOfService[GUARDED] === true) return true
  const original = target.setTypeOfService
  function setTypeOfService(tos) {
    try {
      return original.call(this, tos)
    } catch (error) {
      if (error && (error.code === 'EINVAL' || error.syscall === 'setTypeOfService')) return this
      throw error
    }
  }
  Object.defineProperty(setTypeOfService, GUARDED, { value: true })
  target.setTypeOfService = setTypeOfService
  return true
}
