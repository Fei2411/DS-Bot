// The OptChat memory plugin DSH loads. Nothing runs unless config.bots names a Bot:
// { root: '/abs/dir', route: { provider, model }, bots: { '<botId>': true } }.
import { install } from './plugin.js'

export const name = 'ds-bot-optchat'
export const inject = ['botSessionIdentity', 'tools', 'llm']

export function apply(ctx, config = {}) {
  if (Object.keys(config.bots ?? {}).length === 0) return
  ctx.effect(() => {
    const handle = install(ctx, config, { identity: ctx.botSessionIdentity })
    return () => handle.dispose()
  }, 'optchat')
}
