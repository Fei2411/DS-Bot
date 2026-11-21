export interface SessionLocks {
  request(name: string, options: { signal: AbortSignal }, acquired: () => Promise<void>): Promise<void>
}

export function holdBrowserSession(locks: SessionLocks, acquired: () => void, failed: () => void): () => void {
  const controller = new AbortController()
  let release: (() => void) | undefined
  void locks.request('dsbot.link', { signal: controller.signal }, async () => {
    if (controller.signal.aborted) return
    const held = new Promise<void>(resolve => { release = resolve })
    acquired()
    await held
  }).catch(() => { if (!controller.signal.aborted) failed() })
  return () => { controller.abort(); release?.() }
}
