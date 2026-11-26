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
  if (config.codeMode?.enabled === true) {
    const [codeMode, { installBotCodeMode }] = await Promise.all([
      import('./code-mode.js'),
      import('./src/host/bot-code-mode.js'),
    ])
    const { enabled: _enabled, ...options } = config.codeMode
    const codeConfig = codeMode.Config(options)
    // Always keep the Bot team runtime on the parent ctx so a missing, late-starting,
    // or reloading ptcRuntime never blocks or tears down the team.
    const rt = host.apply(ctx, config)
    let active = false
    const pending = ctx.plugin({
      name: 'ds-bot-code-mode-scopes',
      inject: codeMode.inject,
      apply(child) {
        active = true
        installBotCodeMode(rt, { ctx: child, plugin: codeMode, config: codeConfig })
      },
    })
    if (ctx.get('ptcRuntime') === undefined) {
      await Promise.resolve()
      if (!active) {
        rt.warn('ds-bot: code mode needs the PTC runtime (ctx.ptcRuntime); enable ptc-runtime (@deepseek-ai/dsh-ptc-runtime-node) or turn off bot.config.codeMode.enabled, then restart the engine. Using the normal executor.')
      }
      return
    }
    await pending
    return
  }
  host.apply(ctx, config)
}
