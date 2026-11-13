// Changing several Bots to one model from Settings. Kept free of React so the rules
// are testable: how a Bot runs is its own property, so a Bot on a local agent keeps
// that and is reported as skipped instead of being moved onto a DS Bot model.
import { isLocalRoute } from './agent-routes.js'

export const SKIP_LOCAL_AGENT = 'local-agent'
export const SKIP_UNAVAILABLE = 'unavailable'

// What a Bot runs on: its pick, else the model it last ran on.
export const modelRefOf = bot => bot?.model ?? bot?.appliedModel

// One entry per Bot. `keep` means it already runs on the target, `skip` means a rule
// leaves it alone, and `change` is what the user asked for.
export function planModelChange(bots, ref, models) {
  const served = (models ?? []).some(model => model.ref === ref)
  return (bots ?? []).map((bot) => {
    const current = modelRefOf(bot)
    if (isLocalRoute(current)) return { bot, action: 'skip', reason: SKIP_LOCAL_AGENT }
    if (!served) return { bot, action: 'skip', reason: SKIP_UNAVAILABLE }
    if (current === ref) return { bot, action: 'keep' }
    return { bot, action: 'change' }
  })
}

// One Bot at a time, so two host calls cannot land at once, and one failure never stops
// the Bots after it. Returns one result per Bot, in the order given.
export async function runModelChange({ bots, ref, models, updateBot }) {
  const results = []
  for (const entry of planModelChange(bots, ref, models)) {
    const { bot } = entry
    if (entry.action === 'skip') {
      results.push({ id: bot.id, name: bot.name, status: 'skipped', reason: entry.reason })
      continue
    }
    if (entry.action === 'keep') {
      results.push({ id: bot.id, name: bot.name, status: 'unchanged' })
      continue
    }
    try {
      await updateBot(bot.id, { model: ref })
      results.push({ id: bot.id, name: bot.name, status: 'updated' })
    } catch (failure) {
      results.push({ id: bot.id, name: bot.name, status: 'failed', message: failure?.message ?? String(failure) })
    }
  }
  return results
}

export function summarizeModelChange(results) {
  const count = status => (results ?? []).filter(entry => entry.status === status).length
  return { total: (results ?? []).length, updated: count('updated'), unchanged: count('unchanged'), skipped: count('skipped'), failed: count('failed') }
}
