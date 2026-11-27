// An update prompt belongs to a window: a hidden window has no box to show it in, so the
// prompt waits until the window is shown again.

/**
 * @param {{
 *   ask: (version: string, meta?: { notes?: string }) => Promise<boolean>,
 *   shown: () => boolean,
 *   onYes?: (version: string, meta?: { notes?: string }) => Promise<void>,
 *   log?: Pick<Console, 'info' | 'error'>,
 * }} options `ask` shows the prompt, `shown` tells whether the window is on the screen, and
 *   `onYes` does the work of an answer that comes after the window was shown again
 * @returns {{ prompt: (version: string, meta?: { notes?: string }) => Promise<boolean>, flush: () => Promise<void>, clear: () => void, waiting: () => string | undefined }}
 */
export function createDeferredPrompt({ ask, shown, onYes, log = console }) {
  let waiting
  const prompt = async (version, meta) => {
    if (!shown()) {
      waiting = { version, meta }
      log.info(`DS Bot: the update ${version} waits for the window`)
      return false
    }
    return meta === undefined ? ask(version) : ask(version, meta)
  }
  const flush = async () => {
    if (waiting === undefined || !shown()) return
    const { version, meta } = waiting
    waiting = undefined
    try {
      // The updater heard "no" while the prompt waited, so the answer the user gives now has
      // to do the work itself.
      const accepted = meta === undefined ? await ask(version) : await ask(version, meta)
      if (accepted) await (meta === undefined ? onYes?.(version) : onYes?.(version, meta))
    } catch (error) {
      log.error(`DS Bot: the update ${version} could not be asked: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const clear = () => { waiting = undefined }
  return { prompt, flush, clear, waiting: () => waiting?.version }
}
