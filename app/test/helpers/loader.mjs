// The loader of the main process test: it puts the test doubles in place of the packages
// that would need a display, a DSH install or the network. This loader runs in a thread of
// its own (module.register), for the Node versions without module.registerHooks.
const here = new URL('./', import.meta.url)
const fake = (name) => ({ url: new URL(name, here).href, shortCircuit: true })

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return fake('fake-electron.mjs')
  if (specifier === 'electron-updater') return fake('fake-updater.mjs')
  if (specifier === '@deepseek-ai/dsh-app-boot') return fake('fake-app-boot.mjs')
  const resolved = await nextResolve(specifier, context)
  // The Host of the app is replaced, so that no DSH is booted.
  if (resolved.url.endsWith('/app/src/host-process.mjs')) return fake('fake-host-process.mjs')
  return resolved
}
