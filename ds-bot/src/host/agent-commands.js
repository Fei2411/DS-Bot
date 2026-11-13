// The DSH slash commands do not run in a Bot's chat or in a group chat.
//
// DSH's command registry has no "remove for this Session" call: it offers register,
// list, find and execute only. An agent-scoped registration, though, shadows the global
// definition of the same name for that agent alone (see the host `commands` package:
// "A command-producing plugin mounted beneath an agent's own context declares its
// commands injection and registers an exact agent-scoped command, which shadows the
// global definition of the same name for that agent only"). This module mounts one small
// plugin under each agent, reads the commands service through reflection, and — once the
// Session is known to be a Bot chat or a group's own Session — registers a same-name
// shadow for every command that agent currently sees. The set is kept current on
// `commands/change`, and a Bot whose agent arrives before its state entry is caught up on
// the next save. A typed `/name args` in those Sessions then reaches this error
// result instead of the DSH command.
//
// What it cannot do, by design of the documented API: take the rows out of the `/` menu.
// The menu rows remain (first-party rows keep their own localized copy; the shadow carries
// the host descriptor's identity and input hint so the client still claims them); only
// execution is stopped here. Skills are a separate `/` source and are not touched.
//
// The whole shield is one module and one switch: `config.commandShield: false` in the
// host config turns it off, and removing this module (and its MODULES entry in index.js)
// removes it entirely — expected when DSH enables session-scoped trigger sources upstream.
export function install(rt) {
  if (rt.config?.commandShield === false) return
  const { ctx } = rt
  // Which Sessions are a Bot's own chat or a group's own relay Session. A Bot's group
  // member Sessions are not either: the group's own Session is the one whose `/` menu
  // the user sees in a group chat.
  // A Bot created moments ago may not be indexed in chatOwners yet when its first agent
  // is created, so also match the Session in the saved state.
  const botChat = sessionId => Object.values(rt.state?.bots ?? {}).some(bot => rt.chatOf?.(bot.id) === sessionId)
  const roomChat = sessionId => rt.roomOf?.(sessionId) !== undefined
    || Object.values(rt.state?.rooms ?? {}).some(room => rt.sessionOfRoom?.(room) === sessionId)
  const covered = sessionId => rt.chatOwners?.has?.(sessionId) === true || roomChat(sessionId) || botChat(sessionId)
  const isGroup = sessionId => roomChat(sessionId)
  const refusal = (sessionId, name) => {
    const where = isGroup(sessionId) ? 'a group chat' : "a Bot's chat"
    const goal = name === 'goal' && isGroup(sessionId) ? ' Use the group Goal in the group details panel instead.' : ''
    return `The DSH /${name} command does not run in ${where}.${goal}`
  }
  const rowCopy = sessionId => isGroup(sessionId)
    ? 'Not available in a group chat — use the group’s own controls'
    : 'Not available in a Bot chat — use the Bot’s own controls'
  // Session id → the shield mounted under that Session's agent.
  const shields = new Map()
  // Our own registrations notify `commands/change` too; skip the echo while applying.
  let applying = false

  const sync = (shield) => {
    const commands = shield.commands
    if (commands === undefined) return
    for (const lift of shield.lifts) { try { lift() } catch { /* already lifted */ } }
    shield.lifts = []
    // The agent can arrive before its Bot or group is in the state (a Bot created a
    // moment ago); the shield mounts for every agent and waits for that Session to
    // become known, then registers its shadows on the next sync.
    if (!covered(shield.sessionId)) return
    // Lift first: `list(agent)` is the merged view, so only after our shadows are gone
    // does it answer what the host currently serves this agent.
    const definitions = commands.list(shield.agent)
    for (const definition of definitions) {
      try {
        // Keep the host descriptor's identity and input hint: the client uses them to
        // claim a typed line with arguments and to keep the row's first-party face.
        // Dropping them would leave `/name args` as a plain prompt.
        const lift = commands.register({
          name: definition.name,
          description: rowCopy(shield.sessionId),
          ...(definition.definitionId === undefined ? {} : { definitionId: definition.definitionId }),
          ...(definition.input === undefined ? {} : { input: definition.input }),
          handler: () => ({ kind: 'error', text: refusal(shield.sessionId, definition.name) }),
        })
        if (typeof lift === 'function') shield.lifts.push(lift)
      } catch (error) {
        // A same-name command already in this exact agent scope keeps its own handler.
        rt.warn?.('ds-bot: the DSH /%s command could not be shadowed for %s: %s', definition.name, shield.sessionId, error?.message ?? error)
      }
    }
  }
  const resync = () => {
    if (applying) return
    applying = true
    try { for (const shield of shields.values()) sync(shield) } finally { applying = false }
  }

  const mount = (agent) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || shields.has(sessionId)) return undefined
    // Test doubles and non-interactive hosts have no plugin seam; a Bot without it simply
    // keeps the DSH commands.
    if (typeof agent.ctx?.plugin !== 'function') return undefined
    const shield = { sessionId, agent, child: undefined, lifts: [] }
    shield.ready = new Promise((resolve) => { shield.resolveReady = resolve })
    shields.set(sessionId, shield)
    try {
      // The plugin must be mounted beneath the agent's context: reading
      // `agent.ctx.commands` directly throws "cannot get property commands without
      // inject", and only a registration from inside this plugin belongs to the agent's
      // scope (its fiber goes with the agent). It reads the service through reflection
      // rather than `inject: ['commands']`: in a spike the injection resolved under the
      // first agent but stayed undefined for the agents mounted after it, while `get`
      // answers on every child context.
      shield.fiber = agent.ctx.plugin({
        name: 'ds-bot-command-shield',
        inject: [],
        apply(child) {
          shield.child = child
          shield.commands = child.get?.('commands')
          applying = true
          try { if (shield.commands !== undefined) sync(shield) } finally {
            applying = false
            shield.resolveReady?.()
          }
        },
      })
    } catch (error) {
      shields.delete(sessionId)
      shield.resolveReady?.()
      rt.warn?.('ds-bot: the DSH command shield could not mount for %s: %s', sessionId, error?.message ?? error)
    }
    return shield
  }
  // `agent/created` is serial: wait for the injected plugin to register its shadows, so
  // the first command a fresh chat can send already meets the shield. The cap keeps a
  // host without the commands service from holding agent creation open.
  const mountReady = async (agent) => {
    const shield = mount(agent)
    if (shield === undefined) return
    let timer
    await Promise.race([
      shield.ready,
      new Promise((resolve) => { timer = setTimeout(resolve, 2_000); timer.unref?.() }),
    ])
    clearTimeout(timer)
  }
  const unmount = (sessionId) => {
    const shield = shields.get(sessionId)
    if (shield === undefined) return
    shields.delete(sessionId)
    for (const lift of shield.lifts) { try { lift() } catch { /* already lifted */ } }
    shield.lifts = []
    try { shield.fiber?.dispose?.() } catch { /* already gone */ }
  }

  ctx.on('agent/created', ({ agent }) => mountReady(agent))
  ctx.on('agent/disposed', ({ agent }) => { unmount(agent?.session?.id) })
  ctx.on('commands/change', resync)
  rt.onSaved?.(() => resync())
  // A reload can inherit live agents; agent/created will not fire for them again.
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) void mountReady(agent)
}
