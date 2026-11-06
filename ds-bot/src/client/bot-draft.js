// Plain helpers for the Create Bot form, kept free of React so tests can load them.
import { agentAvatar, isLocalRoute } from './agent-routes.js'

export function freshBotName(roster, base = 'New Bot') {
  const taken = new Set(roster.bots.map(bot => bot.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let index = 2
  while (taken.has(`${base.toLowerCase()} ${index}`)) index += 1
  return `${base} ${index}`
}

// The form starts on the team default model from settings when it is served, then
// the DSH default, else the first one.
export function startModel(roster) {
  const usable = (roster.models ?? []).filter(model => model.needsKey !== true)
  return (usable.find(model => model.ref === roster.prefs?.defaultBotModel) ?? usable.find(model => model.ref === roster.defaultModel) ?? usable[0])?.ref ?? ''
}

// A chosen model is always sent: the host fixes it on the Bot at creation.
export function createPayload({ name, look, image, model, effort, brief }) {
  // An abot with no character of its own starts with its engine's badge.
  const badge = image === undefined && isLocalRoute(model) ? agentAvatar(String(model).split('/')[0]) : undefined
  const payload = { name, color: look.color, avatar: image ? { shape: look.shape, image } : badge !== undefined ? { shape: look.shape, image: badge.image } : { shape: look.shape } }
  if (model) payload.model = model
  if (effort !== undefined) payload.effort = effort
  if (brief) payload.brief = brief
  return payload
}
