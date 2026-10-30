// The loader of the main process test: it puts the test doubles in place of the packages
// that would need a display, a DSH install or the network. It is installed by the test
// files that need it, so that the other tests keep the real packages.
import { register, registerHooks } from 'node:module'

/** Put the test doubles in place of the packages the app cannot run here. */
export const installHooks = async () => {
  if (typeof registerHooks === 'function') {
    const { resolve } = await import('./hooks.mjs')
    registerHooks({ resolve })
    return
  }
  // The hooks of the older Node versions run in a thread of their own.
  register('./loader.mjs', import.meta.url)
  await new Promise(done => { setImmediate(done) })
}
