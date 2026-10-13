// Computer use for Bots. DSH's computer-use provider serves its tools to every Session;
// each Bot's `computerUse` mode decides which of them it sees and whether a call needs
// the user's approval first. A subagent works under the mode of the Bot that started
// it; other Sessions are left alone.
import { COMPUTER_MODES, COMPUTER_VIEW_TOOLS } from './constants.js'

// Tool name prefixes by provider name. DSH's registry names the provider but not its
// tools, so another provider's tools cannot be gated and Bots get no mode for it.
const PREFIXES = { 'cua-driver-native': 'cua_driver_native__', 'cua-driver-mcp': 'mcp__cua-driver-mcp__' }
const PREFIX = new RegExp(`^(?:${Object.values(PREFIXES).join('|')})(.+)$`)
const VIEW = new Set(COMPUTER_VIEW_TOOLS)
// Subagents of subagents, as far up as a Bot is looked for.
const LINEAGE_MAX = 8

export const computerToolOf = name => PREFIX.exec(name ?? '')?.[1]

export function install(rt) {
  const { ctx } = rt

  rt.computerModeOf = bot => (COMPUTER_MODES.includes(bot?.computerUse) ? bot.computerUse : 'off')
  let warned
  rt.computerAvailable = () => {
    const provider = ctx.get?.('computerUse')?.providerName
    if (provider === undefined) return false
    if (Object.hasOwn(PREFIXES, provider)) return true
    if (warned !== provider) {
      warned = provider
      rt.warn('ds-bot: computer-use provider %s is not supported; Bots get no computer-use mode', provider)
    }
    return false
  }

  // The Bot an agent works for: the Bot of its Session, or of the Session that
  // started it as a subagent.
  const ownerOf = (agent) => {
    let id = agent?.id
    let header = agent?.session?.header
    for (let depth = 0; id !== undefined && depth < LINEAGE_MAX; depth += 1) {
      if (rt.isBotSession(id)) return rt.botOf(rt.selfOf(id))
      id = header?.parentSession
      header = id === undefined ? undefined : ctx.get?.('agents')?.get(id)?.session?.header
    }
    return undefined
  }
  // An approval card shows only in the Bot's own chat. In a group Session or a
  // subagent, acting would wait on a card the user never sees, so there it only looks.
  const modeIn = (bot, agent) => {
    const mode = rt.computerModeOf(bot)
    return mode === 'act' && !rt.chatOwners.has(agent?.id) ? 'view' : mode
  }

  // The gate is what enforces the mode; hiding only keeps unusable tools out of the request.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = computerToolOf(exec.name)
    if (tool === undefined) return next()
    await rt.load()
    const bot = ownerOf(exec.agent)
    if (bot === undefined) return next()
    const mode = modeIn(bot, exec.agent)
    if (mode === 'off') return { kind: 'deny', reason: `${bot.name} may not use the computer. The user can turn it on in this Bot's details.` }
    if (VIEW.has(tool)) return next()
    if (mode === 'view') {
      return rt.computerModeOf(bot) === 'act'
        ? { kind: 'deny', reason: `${bot.name} acts on the computer only in its own chat, where the user approves each action. Here it can only look.` }
        : { kind: 'deny', reason: `${bot.name} may look at the computer but not act on it. The user can change this in this Bot's details.` }
    }
    // With approval prompts off, DSH answers every ask with "the user rejected".
    if (ctx.get?.('approval')?.effectivePolicy?.(exec.agent.session) === 'never') {
      return { kind: 'deny', reason: `${bot.name} acts on the computer only with the user's approval, and its permission turns approval prompts off. The user can pick another permission for this Bot.` }
    }
    return { kind: 'ask', reason: `${bot.name} wants to use the computer: ${tool}` }
  })

  /** @type {WeakMap<object, {mode: string, undo: () => void}>} */
  const hidden = new WeakMap()
  /** @type {Map<string, object>} Agents of Bots, so a mode change reaches them at once. */
  const live = new Map()
  const hide = (agent) => {
    const bot = ownerOf(agent)
    if (bot === undefined || typeof agent.ctx?.tools?.restrict !== 'function') return
    live.set(agent.id, agent)
    const mode = modeIn(bot, agent)
    const prev = hidden.get(agent)
    if (prev?.mode === mode) return
    prev?.undo()
    hidden.delete(agent)
    const deny = ctx.tools.schemas(agent).map(schema => schema.name)
      .filter((name) => {
        const tool = computerToolOf(name)
        return tool !== undefined && (mode === 'off' || (mode === 'view' && !VIEW.has(tool)))
      })
    // No match: computer use is not mounted, or the mode hides nothing.
    if (deny.length === 0) return
    try {
      hidden.set(agent, { mode, undo: agent.ctx.tools.restrict({ deny }) })
    } catch (error) {
      rt.warn('ds-bot: computer-use tools stay visible to %s: %s', agent.id, error)
    }
  }
  // A step's tool list is fixed before agent/pre-step runs, so the mode is applied
  // when the agent appears and when it changes; pre-step only catches the rest.
  rt.applyComputerUse = (agent) => {
    if (rt.computerAvailable()) hide(agent)
  }
  rt.refreshComputerUse = () => {
    for (const agent of live.values()) rt.applyComputerUse(agent)
  }
  ctx.on('agent/created', ({ agent }) => {
    if (!rt.computerAvailable()) return
    void rt.load()
      .then(() => hide(agent))
      .catch(error => rt.warn('ds-bot: computer-use restrict on agent/created failed: %s', error))
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (live.get(agent?.id) === agent) live.delete(agent.id)
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    if (rt.computerAvailable()) {
      await rt.load()
      hide(payload.agent)
    }
    return next()
  })
}
