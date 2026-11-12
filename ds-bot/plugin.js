// The host entry DSH loads. It imports the host itself inside `apply`, so a host module
// that fails to load (a dependency the host resolves to another version, #1237) fails
// this entry's activation instead of its import. DSH leaves the browser half out for an
// entry that never imported; with DSH's own settings shell turned off by the bundle
// patch, nothing would then open Settings or switch back to the classic view. After a
// failed activation the browser half still loads: it says the Bot team did not start,
// and Settings and its Mode switch keep working.
export { name, inject } from './src/host/entry.js'

export async function apply(ctx, config = {}) {
  const host = await import('./index.js')
  host.apply(ctx, config)
}
