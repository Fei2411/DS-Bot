// The hooks of the main process test: they put the test doubles in place of the packages
// that would need a display, a DSH install or the network. These hooks run in the thread
// of the test (module.registerHooks).

const here = new URL('./', import.meta.url)

/**
 * @param {string} specifier the module the app asks for
 * @param {object} context what the loader knows about the request
 * @param {(specifier: string, context: object) => { url: string }} nextResolve the loader's own answer
 */
export function resolve(specifier, context, nextResolve) {
  const fake = (name) => ({ url: new URL(name, here).href, shortCircuit: true })
  if (specifier === 'electron') return fake('fake-electron.mjs')
  if (specifier === 'electron-updater') return fake('fake-updater.mjs')
  if (specifier === '@deepseek-ai/dsh-app-boot') return fake('fake-app-boot.mjs')
  const resolved = nextResolve(specifier, context)
  // The Host of the app is replaced, so that no DSH is booted.
  if (resolved.url.endsWith('/app/src/host-process.mjs')) return fake('fake-host-process.mjs')
  return resolved
}
