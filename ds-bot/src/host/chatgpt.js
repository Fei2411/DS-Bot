import { randomUUID } from 'node:crypto'
import { serviceOf } from './services.js'

export const CHATGPT_PROVIDER = 'openai-chatgpt'
const KEY_REF = 'OPENAI_CHATGPT_API_KEY'
const unsupported = () => ({ state: 'unsupported' })
const unavailable = () => Object.assign(new Error('The desktop ChatGPT connection did not respond.'), { code: 'bot/refused' })

export function appChatGPTRequest(method, body, ipc = process) {
  if (typeof ipc.send !== 'function') return Promise.reject(unavailable())
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ipc.off('message', receive); reject(unavailable()) }, method === 'chatgpt:sign-in' ? 310_000 : 120_000)
    const receive = message => {
      if (message?.type !== 'ds-bot:chatgpt-response' || message.id !== id) return
      clearTimeout(timeout)
      ipc.off('message', receive)
      if (message.error) reject(Object.assign(new Error('ChatGPT request could not complete. Check the connection status.'), { code: 'bot/refused', state: message.error.state }))
      else resolve(message.result)
    }
    ipc.on('message', receive)
    try { ipc.send({ type: 'ds-bot:chatgpt', id, method, body }, error => { if (error) receive({ type: 'ds-bot:chatgpt-response', id, error: true }) }) }
    catch { receive({ type: 'ds-bot:chatgpt-response', id, error: true }) }
  })
}

export function install(rt, { env = process.env, request = appChatGPTRequest, ipc = process } = {}) {
  const enabled = env.DS_BOT_APP === '1'
  const call = (method, body) => enabled ? request(method, body) : Promise.resolve(unsupported())
  let pending = Promise.resolve()
  const section = settings => settings.describe({ redactSecrets: true }).find(item => item.ns === 'llm-pi-ai')
  const synchronize = (status, refreshModels = false) => {
    const work = async () => {
      const settings = serviceOf(rt.ctx, 'settings')
      const credentials = serviceOf(rt.ctx, 'credentials')
      if (!settings || !credentials) throw unavailable()
      const current = section(settings)
      const previous = current?.value?.providers?.[CHATGPT_PROVIDER]
      if (status.state === 'signed-out' && !status.account) {
        if (current?.user?.providers?.[CHATGPT_PROVIDER]) {
          await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', CHATGPT_PROVIDER] }], current.revision)
          await credentials.unset(KEY_REF)
          rt.dropCatalog()
        }
        return []
      }
      if (!previous && status.state !== 'connected' && !refreshModels) return []
      let models = previous?.models ?? []
      const route = await call('chatgpt:route')
      await credentials.set(KEY_REF, route.secret)
      const write = async list => {
        const profile = { displayName: 'ChatGPT (plan)', api: 'openai-responses', baseURL: route.baseURL,
          apiKeyEnv: KEY_REF, models: list, compat: { supportsDeveloperRole: true },
        }
        await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', CHATGPT_PROVIDER], value: profile }], section(settings)?.revision)
        rt.dropCatalog()
      }
      if (previous) await write(models)
      if (refreshModels || status.state === 'connected') models = await call('chatgpt:models')
      if (!previous && models.length) await write(models)
      if (models.length) await rt.saveProviderModels({ provider: CHATGPT_PROVIDER, models })
      return models
    }
    const result = pending.then(work)
    pending = result.catch(() => {})
    return result
  }
  const chatgpt = () => call('chatgpt:status')
  const chatgptSignIn = async body => {
    const status = await call('chatgpt:sign-in', { consent: body?.consent === true })
    if (enabled) await synchronize(status)
    return status
  }
  const chatgptModels = async () => {
    if (!enabled) return unsupported()
    return synchronize(await chatgpt(), true)
  }
  Object.assign(rt, { chatgpt, chatgptSignIn, chatgptModels,
    chatgptCancel: () => call('chatgpt:cancel'),
    chatgptSignOut: async () => {
      const status = await call('chatgpt:sign-out')
      if (enabled) await synchronize(status)
      return status
    },
  })
  if (enabled) rt.ctx.effect(() => {
    const changed = message => {
      if (message?.type === 'chatgpt:changed') rt.chatgptStatus = message.status
    }
    ipc.on('message', changed)
    void chatgpt().then(status => synchronize(status)).catch(() => rt.warn?.('ds-bot: ChatGPT route could not be refreshed.'))
    return () => ipc.off('message', changed)
  }, 'ds-bot: ChatGPT connection')
}
