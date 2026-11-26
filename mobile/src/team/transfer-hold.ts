// Tracks active chunked file transfers so backgrounding in non-keepalive mode
// defers closing the relay link until in-flight transfers finish or fail.
let activeTransferHolds = 0
const transferIdleListeners = new Set<() => void>()

export function hasActiveTransferHolds(): boolean {
  return activeTransferHolds > 0
}

export function onTransferHoldsIdle(listener: () => void): () => void {
  transferIdleListeners.add(listener)
  return () => { transferIdleListeners.delete(listener) }
}

export function acquireTransferHold(): () => void {
  activeTransferHolds += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeTransferHolds = Math.max(0, activeTransferHolds - 1)
    if (activeTransferHolds === 0) {
      for (const listener of [...transferIdleListeners]) listener()
    }
  }
}
