// An update prompt belongs to a window: a hidden window has no box to show it in, so the
// prompt waits until the window is shown again.

/**
 * @param {{
 *   ask: (version: string) => Promise<boolean>,
 *   shown: () => boolean,
 *   onYes?: (version: string) => Promise<void>,
 *   log?: Pick<Console, 'info' | 'error'>,
 * }} options `ask` shows the prompt, `shown` tells whether the window is on the screen, and
 *   `onYes` does the work of an answer that comes after the window was shown again
 * @returns {{ prompt: (version: string) => Promise<boolean>, flush: () => Promise<void>, waiting: () => string | undefined }}
 */
export function createDeferredPrompt({ ask, shown, onYes, log = console }) {
  let waiting
  const prompt = async (version) => {
    if (!shown()) {
      waiting = version
      log.info(`DeepSeek Bot: the update ${version} waits for the window`)
      return false
    }
    return ask(version)
  }
  const flush = async () => {
    if (waiting === undefined || !shown()) return
    const version = waiting
    waiting = undefined
    try {
      // The updater heard "no" while the prompt waited, so the answer the user gives now has
      // to do the work itself.
      if (await ask(version)) await onYes?.(version)
    } catch (error) {
      log.error(`DeepSeek Bot: the update ${version} could not be asked: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { prompt, flush, waiting: () => waiting }
}
