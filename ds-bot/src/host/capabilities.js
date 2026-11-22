import { createHash } from 'node:crypto'
import { encodeUrlComponent } from './secrets.js'
import { own } from './store.js'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SECRET_REFERENCE = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g
const ENSURE_TIMEOUT_MS = 15_000

// Connector ids are reserved: a capability named like one would collide with
// its mcp__<id>__* tool prefix. The connectors module registers its ids here.
export const CONNECTOR_IDS = new Set(['github', 'mail'])
export function validateCapabilityName(value, reserved = CONNECTOR_IDS) {
  const name = String(value ?? '').trim()
  if (name.length > 32 || !NAME.test(name) || name === 'github' || reserved.has(name)) {
    throw new Error('Use a capability name with lowercase letters, digits, and single hyphens; connector names are reserved.')
  }
  return name
}

export function expandCapabilityNames(capabilities, library) {
  const expanded = new Set()
  for (const name of capabilities ?? []) {
    const item = own(library, name)
    if (!item) throw new Error(`No capability named ${name}.`)
    if (item.kind === 'pack') {
      for (const childName of item.items ?? []) {
        const child = own(library, childName)
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Pack ${name} refers to an unavailable capability ${childName}.`)
        expanded.add(childName)
      }
    } else if (item.kind === 'mcp' || item.kind === 'skill') {
      expanded.add(name)
    } else {
      throw new Error(`Capability ${name} has an unknown kind.`)
    }
  }
  return expanded
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const strings = value => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Arguments must be a list of text values.')
  return [...value]
}
const stringMap = (value, label) => {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(item => typeof item !== 'string')) throw new Error(`${label} must contain text values.`)
  return Object.fromEntries(Object.entries(value))
}

export function install(rt) {
  const { ctx, state } = rt
  const agents = new Map()
  // Mounted fibers live in each Agent's own context, so they outlive this plugin unless
  // its cleanup disposes them; a strong map keeps them reachable for that.
  const mounts = new Map()
  // One reconcile chain per Agent: a slow MCP server holds up only its own Agent.
  const chains = new WeakMap()
  const queued = new WeakSet()
  const sessionStatuses = new Map()
  const loaded = new Map()
  const pendingDrops = new Map()
  const frozenCatalogs = new Map()
  const toolCounts = new Map()
  let statusesCache
  let statusesKey
  let pluginPromise
  let scheduled = null
  let loadingSecrets = 0
  let stopped = false

  const library = () => state.capabilities.items
  const ensureLibrary = () => {
    state.capabilities ??= { items: {} }
    state.capabilities.items ??= {}
    return library()
  }
  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  const allowedToEdit = (item, botId) => rt.isMain(botId) || item.createdBy === botId
  const usedByOthers = (name, botId) => Object.values(state.bots).some(bot => bot.id !== botId
    && [...(bot.capabilities ?? []), ...(bot.packs ?? [])].some((attached) => {
      const item = own(library(), attached)
      return attached === name || (item?.kind === 'pack' && (item.items ?? []).includes(name))
    }))
  // A creator that is not a Main Bot could otherwise rewrite what a Main Bot runs.
  const editCheck = (item, botId, verb) => {
    if (!allowedToEdit(item, botId)) throw new Error(`Only ${item.createdBy ? 'its creator or a Main Bot' : 'a Main Bot'} can ${verb} ${item.name}.`)
    if (!rt.isMain(botId) && usedByOthers(item.name, botId)) throw new Error(`Another Bot uses ${item.name}, so only a Main Bot can ${verb} it.`)
  }
  const itemInput = (body, { botId, ui }) => {
    const name = validateCapabilityName(body.name)
    const kind = body.kind
    if (!['mcp', 'skill', 'pack'].includes(kind)) throw new Error('Choose an MCP server, skill, or pack.')
    const items = ensureLibrary()
    const previous = own(items, name)
    if (previous && !ui) editCheck(previous, botId, 'change')
    if (previous && previous.kind !== kind) throw new Error('A capability cannot change its kind. Delete it and save a new one.')
    const now = Date.now()
    const item = {
      name,
      kind,
      description: String(body.description ?? '').trim().slice(0, 2000),
      createdBy: previous?.createdBy ?? (ui ? null : botId),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    if (kind === 'mcp') {
      const transport = body.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
      if (transport === 'stdio') {
        const command = String(body.command ?? '').trim()
        if (command === '') throw new Error('Enter a command for the MCP server.')
        const args = strings(body.args)
        const env = stringMap(body.env, 'Environment variables')
        const changed = !previous || previous.kind !== 'mcp' || previous.transport !== 'stdio'
          || previous.command !== command || !same(previous.args ?? [], args) || !same(previous.env ?? {}, env)
        Object.assign(item, { transport, command, args, env, approved: ui ? true : changed ? false : previous.approved === true })
      } else {
        const url = String(body.url ?? '').trim()
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error()
        } catch { throw new Error('Enter a valid HTTP or HTTPS URL.') }
        Object.assign(item, { transport, url, headers: stringMap(body.headers, 'Headers'), approved: true })
      }
    } else if (kind === 'skill') {
      item.content = String(body.content ?? '').trim()
    } else {
      const names = [...new Set(strings(body.items))]
      for (const childName of names) {
        const child = own(items, childName)
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Packs can include only saved MCP servers and skills. ${childName} is not one.`)
      }
      item.items = names
    }
    items[name] = item
    return item
  }
  const capabilitySave = async (body, options = {}) => {
    await rt.load()
    writeCheck()
    const item = itemInput(body ?? {}, options)
    await rt.save()
    return item
  }
  const capabilityDelete = async (name, { botId, ui } = {}) => {
    await rt.load()
    writeCheck()
    const items = ensureLibrary()
    const item = own(items, String(name ?? ''))
    if (!item) throw new Error(`No capability named ${name}.`)
    if (!ui) editCheck(item, botId, 'delete')
    delete items[item.name]
    for (const pack of Object.values(items)) if (pack.kind === 'pack') pack.items = (pack.items ?? []).filter(child => child !== item.name)
    for (const bot of Object.values(state.bots)) {
      bot.capabilities = (bot.capabilities ?? []).filter(attached => attached !== item.name)
      bot.packs = (bot.packs ?? []).filter(attached => attached !== item.name)
    }
    await rt.save()
    return true
  }
  // Called with the Bot being deleted, after it left the team. The shared list belongs to
  // the user, so only a local MCP this Bot added, nobody approved and no other Bot or pack
  // uses goes: no one is left to ask for it, and approving it would start a server for no one.
  // Anything a pack lists stays.
  const dropOrphanCapabilities = (bot) => {
    const items = library()
    const packed = name => Object.values(items).some(item => item.kind === 'pack' && (item.items ?? []).includes(name))
    for (const name of new Set([...(bot.capabilities ?? []), ...(bot.packs ?? [])])) {
      const item = own(items, name)
      if (item === undefined || item.kind !== 'mcp' || item.transport !== 'stdio' || item.approved === true) continue
      if (item.createdBy !== bot.id || usedByOthers(name, bot.id) || packed(name)) continue
      delete items[item.name]
    }
  }
  const changeAttachment = async (endpoint, { name, bot: targetRef, mode }, callerId) => {
    await rt.load()
    writeCheck()
    const caller = rt.botOf(callerId)
    if (!caller) throw new Error('Only Bots on the team can change capabilities.')
    const target = targetRef ? rt.findBot(targetRef) : caller
    if (!target) throw new Error(`No Bot named ${targetRef}.`)
    if (target.id !== caller.id && target.private === true) throw new Error('Other Bots cannot change a private Bot’s capabilities.')
    if (target.id !== caller.id && !rt.isMain(callerId)) throw new Error('Only a Main Bot can change another Bot’s capabilities.')
    const item = own(ensureLibrary(), String(name ?? ''))
    if (!item) throw new Error(`No capability named ${name}.`)
    await setAttached(target, item.name, endpoint === 'attach', mode)
    return { bot: target.name, attached: endpoint === 'attach' }
  }
  // Changes one name against the saved list, so two quick changes both land.
  const setAttached = async (bot, name, attached, mode = 'always') => {
    if (!['always', 'catalog'].includes(mode)) throw new Error('Capability mode must be always or catalog.')
    bot.capabilities ??= []
    bot.packs ??= []
    const wasEmpty = bot.capabilities.length === 0
    bot.capabilities = bot.capabilities.filter(entry => entry !== name)
    bot.packs = bot.packs.filter(entry => entry !== name)
    if (attached) bot[mode === 'catalog' ? 'packs' : 'capabilities'].push(name)
    await rt.save()
    if (wasEmpty && bot.capabilities.length > 0) {
      await trackBotAgents(bot)
      void scheduleReconcile()
    }
    return bot.capabilities
  }

  const statusSet = (botId, itemName, sessionId, status) => {
    statusesCache = undefined
    let byItem = sessionStatuses.get(botId)
    if (!byItem) sessionStatuses.set(botId, byItem = new Map())
    let bySession = byItem.get(itemName)
    if (!bySession) byItem.set(itemName, bySession = new Map())
    bySession.set(sessionId, status)
  }
  const clearStatus = (botId, itemName, sessionId) => {
    statusesCache = undefined
    const byItem = sessionStatuses.get(botId)
    const bySession = byItem?.get(itemName)
    bySession?.delete(sessionId)
    if (bySession?.size === 0) byItem.delete(itemName)
    if (byItem?.size === 0) sessionStatuses.delete(botId)
  }
  const clearSession = sessionId => {
    statusesCache = undefined
    for (const [botId, byItem] of sessionStatuses) {
      for (const [name, bySession] of byItem) {
        bySession.delete(sessionId)
        if (bySession.size === 0) byItem.delete(name)
      }
      if (byItem.size === 0) sessionStatuses.delete(botId)
    }
  }
  const statusFor = (botId, name) => {
    const values = [...(sessionStatuses.get(botId)?.get(name)?.values() ?? [])]
    if (values.some(status => status.state === 'error')) return values.find(status => status.state === 'error')
    if (values.some(status => status.state === 'needs-approval')) return { state: 'needs-approval' }
    if (values.some(status => status.state === 'connecting')) return { state: 'connecting' }
    return values.length > 0 ? { state: 'ready' } : undefined
  }
  const capabilityStatusesView = () => {
    // The returned view is shared and cached; callers must not mutate it.
    // Store adoption and in-place attachment/pack edits need no separate notification.
    const key = JSON.stringify(Object.values(state.bots).map(bot => [bot.id,
      (bot.capabilities ?? []).map(name => {
        const item = own(library(), name)
        return [name, item?.kind, item?.kind === 'pack' ? item.items : undefined]
      }),
    ]))
    if (statusesCache && statusesKey === key) return statusesCache
    const result = {}
    for (const bot of Object.values(state.bots)) {
      const statuses = {}
      for (const name of bot.capabilities ?? []) {
        const item = own(library(), name)
        if (!item) continue
        if (item.kind !== 'pack') {
          const status = statusFor(bot.id, name)
          if (status) statuses[name] = status
          continue
        }
        const children = (item.items ?? []).map(child => statusFor(bot.id, child)).filter(Boolean)
        const status = children.find(status => status.state === 'error')
          ?? children.find(status => status.state === 'needs-approval')
          ?? children.find(status => status.state === 'connecting')
          ?? children[0]
        if (status) statuses[name] = status
      }
      result[bot.id] = statuses
    }
    statusesKey = key
    statusesCache = result
    return result
  }
  const libraryView = () => Object.values(library()).map(item => ({
    ...item,
    ...(item.env ? { env: { ...item.env } } : {}),
    ...(item.headers ? { headers: { ...item.headers } } : {}),
    ...(item.items ? { items: [...item.items] } : {}),
  }))

  async function loadMcpPlugin() {
    if (!pluginPromise) {
      pluginPromise = (async () => {
        const loader = ctx.get?.('loader')
        if (typeof loader?.import !== 'function') throw new Error('This DSH cannot load MCP servers.')
        const exports = await loader.import(MCP_CLIENT)
        return loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      })()
    }
    return pluginPromise
  }
  function secretFor(name, botId) {
    const value = rt.canUseSecret(name, botId) ? rt.secretValue(name) : undefined
    if (value === undefined) throw new Error(`Secret ${name} is missing or unavailable for this Bot.`)
    return value
  }
  function resolveValues(values, botId) {
    const resolved = {}
    for (const [key, raw] of Object.entries(values ?? {})) {
      resolved[key] = String(raw).replace(SECRET_REFERENCE, (_match, name) => secretFor(name, botId))
    }
    return resolved
  }
  const resolveUrl = (url, botId) => String(url).replace(SECRET_REFERENCE, (_match, name) => encodeUrlComponent(secretFor(name, botId)))
  const resolveList = (list, botId) => (list ?? []).map(raw => String(raw).replace(SECRET_REFERENCE, (_match, name) => secretFor(name, botId)))
  const configFor = (item, botId) => {
    if (item.kind === 'skill') return { name: item.name, description: item.description, content: item.content }
    if (item.transport === 'stdio') return { transport: 'stdio', serverName: item.name, command: item.command, args: resolveList(item.args, botId), env: resolveValues(item.env, botId), failOnStartupError: true }
    return { transport: 'streamable-http', serverName: item.name, url: resolveUrl(item.url, botId), headers: resolveValues(item.headers, botId), failOnStartupError: true }
  }
  const disposeMount = async mount => {
    if (mount) {
      mount.active = false
      for (const unregister of mount.registrations) unregister()
    }
    if (mount?.fiber) await Promise.resolve().then(() => mount.fiber.dispose()).catch(() => {})
  }
  const mountOne = async (agent, bot, agentMounts, name) => {
    const sessionId = agent.session.id
    const item = own(library(), name)
    if (!item) return
    const drop = async () => {
      await disposeMount(agentMounts.get(name))
      agentMounts.delete(name)
    }
    if (item.kind === 'mcp' && item.transport === 'stdio' && item.approved !== true) {
      await drop()
      statusSet(bot.id, name, sessionId, { state: 'needs-approval' })
      return
    }
    let config
    try {
      config = configFor(item, bot.id)
    } catch (error) {
      await drop()
      statusSet(bot.id, name, sessionId, { state: 'error', error: rt.redactSecrets(error.message).slice(0, 300) })
      return
    }
    const key = `${name}:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`
    if (agentMounts.get(name)?.key === key) return
    await drop()
    if (stopped || agents.get(sessionId)?.deref() !== agent || !desiredFor(agent, botOfSession(sessionId)).has(name)) return
    statusSet(bot.id, name, sessionId, { state: 'connecting' })
    const mounted = { key, active: true, registrations: new Set() }
    agentMounts.set(name, mounted)
    try {
      const register = create => {
        if (!mounted.active) return () => {}
        const unregister = create()
        const remove = () => {
          mounted.registrations.delete(remove)
          return unregister()
        }
        mounted.registrations.add(remove)
        return remove
      }
      const plugin = item.kind === 'skill'
        ? {
          name: `ds-bot-capability-skill-${name}`,
          inject: ['skills'],
          apply(c) {
            c.effect(() => register(() => c.skills.register({ name: config.name, description: config.description, source: 'runtime', content: config.content })))
          },
        }
        : await loadMcpPlugin()
      if (stopped || agents.get(sessionId)?.deref() !== agent || agentMounts.get(name) !== mounted) return
      if (!desiredFor(agent, botOfSession(sessionId)).has(name)) {
        await drop()
        return
      }
      let mountContext = agent.ctx
      if (item.kind === 'mcp') {
        const tools = agent.ctx.tools
        const scopedTools = Object.create(tools ?? null)
        scopedTools.register = (...args) => register(() => tools.register(...args))
        mountContext = agent.ctx.extend({ tools: scopedTools })
      }
      const fiber = item.kind === 'skill' ? mountContext.plugin(plugin) : mountContext.plugin(plugin, config)
      mounted.fiber = fiber
      await fiber.await()
      if (stopped || agents.get(sessionId)?.deref() !== agent || agentMounts.get(name) !== mounted) return
      statusSet(bot.id, name, sessionId, { state: 'ready' })
      if (item.kind === 'skill') toolCounts.set(name, 0)
      const schemas = agent.ctx.tools?.schemas?.(agent)
      if (item.kind === 'mcp' && Array.isArray(schemas)) toolCounts.set(name, schemas.filter(tool => tool.name.startsWith(`mcp__${name}__`)).length)
    } catch (error) {
      if (agentMounts.get(name) !== mounted) return
      await drop()
      const message = rt.redactSecrets([error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ') || 'Connection failed').slice(0, 300)
      statusSet(bot.id, name, sessionId, { state: 'error', error: message })
    }
  }
  const desiredFor = (agent, bot) => {
    const sessionId = agent.session.id
    const desired = bot ? expandCapabilityNames(bot.capabilities, library()) : new Set()
    const entries = loaded.get(sessionId)
    if (agent.status !== 'running') {
      for (const root of entries?.keys() ?? []) {
        if (!bot?.packs?.includes(root) || !own(library(), root)) entries.delete(root)
        else entries.set(root, expandCapabilityNames([root], library()))
      }
      if (entries?.size === 0) loaded.delete(sessionId)
    }
    for (const [root, leaves] of entries ?? []) {
      if (bot?.packs?.includes(root) && own(library(), root)) {
        for (const name of expandCapabilityNames([root], library())) leaves.add(name)
      }
      for (const name of leaves) desired.add(name)
    }
    return desired
  }
  const pruneAgent = agent => {
    const sessionId = agent.session.id
    if (stopped || agents.get(sessionId)?.deref() !== agent) return
    const bot = botOfSession(sessionId)
    const desired = desiredFor(agent, bot)
    if (bot) {
      for (const name of sessionStatuses.get(bot.id)?.keys() ?? []) {
        if (!desired.has(name)) clearStatus(bot.id, name, sessionId)
      }
    } else {
      clearSession(sessionId)
    }
    const agentMounts = mounts.get(agent)
    for (const [name, mount] of agentMounts ?? []) {
      if (desired.has(name)) continue
      agentMounts.delete(name)
      void disposeMount(mount)
    }
  }
  const reconcileAgent = async (agent, bot) => {
    await pruneAgent(agent)
    const desired = desiredFor(agent, bot)
    const agentMounts = mounts.get(agent) ?? new Map()
    if (desired.size > 0) mounts.set(agent, agentMounts)
    await Promise.all([...desired].map(name => mountOne(agent, bot, agentMounts, name)))
    if (agentMounts.size === 0 && mounts.get(agent) === agentMounts) mounts.delete(agent)
  }
  const botOfSession = sessionId => (rt.isBotSession(sessionId) ? rt.botOf(rt.selfOf(sessionId)) : undefined)
  // At most one run waits behind the running one; it reads the latest state when it starts.
  const reconcileOne = async agent => {
    await pruneAgent(agent)
    if (queued.has(agent)) return chains.get(agent)
    queued.add(agent)
    const run = (chains.get(agent) ?? Promise.resolve()).then(async () => {
      queued.delete(agent)
      const sessionId = agent.session.id
      if (stopped || agents.get(sessionId)?.deref() !== agent) return
      await reconcileAgent(agent, botOfSession(sessionId))
    }).catch(error => rt.warn('ds-bot: capability reconcile for %s failed: %s', agent.session?.id, error))
    chains.set(agent, run)
    return run
  }
  const loadInputs = async () => {
    await rt.load()
    loadingSecrets += 1
    try {
      await rt.loadSecrets()
    } finally {
      loadingSecrets -= 1
    }
  }
  async function reconcile() {
    if (stopped) return
    await loadInputs()
    const runs = []
    for (const [sessionId, reference] of agents) {
      const agent = reference.deref()
      if (agent) {
        runs.push(reconcileOne(agent))
        continue
      }
      agents.delete(sessionId)
      clearSession(sessionId)
    }
    await Promise.all(runs)
  }
  const scheduleReconcile = () => {
    if (!scheduled) {
      scheduled = new Promise(resolve => queueMicrotask(() => {
        scheduled = null
        resolve(reconcile().catch(error => rt.warn('ds-bot: capability reconcile failed: %s', error)))
      }))
    }
    return scheduled
  }
  // A run that outlasts the limit goes on in the background, and later requests for the
  // same Agent do not wait for it again.
  const stalled = new WeakSet()
  const prepare = async (agent, sessionId) => {
    await pruneAgent(agent)
    const run = loadInputs().then(() => reconcileOne(agent)).then(() => true, error => {
      rt.warn('ds-bot: capability mount for %s failed: %s', sessionId, error)
      return true
    })
    if (stalled.has(agent)) return
    const timeoutMs = rt.capabilityEnsureTimeoutMs ?? ENSURE_TIMEOUT_MS
    let timer
    const completed = await Promise.race([run, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, false) })])
    clearTimeout(timer)
    if (completed) return
    stalled.add(agent)
    void run.then(() => stalled.delete(agent))
    rt.warn('ds-bot: capability mount for %s did not finish within %dms; continuing', sessionId, timeoutMs)
  }
  async function ensureCapabilities(sessionId) {
    await rt.load()
    const bot = botOfSession(sessionId)
    if (!bot) return
    if ((bot.capabilities ?? []).length === 0 && !loaded.get(sessionId)?.size && !mounts.get(agents.get(sessionId)?.deref())?.size) return
    let agent
    try {
      agent = await rt.resolveAgent(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, rt.redactSecrets(String(error)))
      return
    }
    trackAgent(agent)
    await prepare(agent, sessionId)
  }
  const trackAgent = agent => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !agent.ctx) return
    if (agents.get(sessionId)?.deref() === agent) return
    agents.set(sessionId, new WeakRef(agent))
    agent.ctx.effect(() => () => {
      if (agents.get(sessionId)?.deref() === agent) {
        agents.delete(sessionId)
        clearSession(sessionId)
        loaded.delete(sessionId)
        pendingDrops.delete(sessionId)
        frozenCatalogs.delete(sessionId)
      }
      for (const mount of mounts.get(agent)?.values() ?? []) void disposeMount(mount)
      mounts.delete(agent)
    }, `ds-bot: capabilities ${sessionId}`)
  }
  const trackBotAgents = async bot => {
    const sessionIds = new Set()
    try {
      const sessionId = rt.chatOf(bot.id)
      if (typeof sessionId === 'string') sessionIds.add(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability chat session for %s could not be read: %s', bot.id, error)
    }
    try {
      for (const sessionId of rt.groupSessionsOf(bot.id) ?? []) {
        if (typeof sessionId === 'string') sessionIds.add(sessionId)
      }
    } catch (error) {
      rt.warn('ds-bot: capability group sessions for %s could not be read: %s', bot.id, error)
    }
    for (const sessionId of sessionIds) {
      try {
        trackAgent(await rt.resolveAgent(sessionId))
      } catch (error) {
        rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, error)
      }
    }
  }

  async function capabilityEndpoint(endpoint, body = {}) {
    if (endpoint === 'capability-save') return capabilitySave(body, { ui: true })
    if (endpoint === 'capability-delete') return capabilityDelete(body.name, { ui: true })
    if (endpoint === 'capability-approve') {
      await rt.load()
      writeCheck()
      const item = own(library(), String(body.name ?? ''))
      if (!item || item.kind !== 'mcp' || item.transport !== 'stdio') throw new Error(`No unapproved stdio MCP named ${body.name}.`)
      item.approved = true
      item.updatedAt = Date.now()
      await rt.save()
      return item
    }
    if (endpoint === 'bot-capability') {
      await rt.load()
      writeCheck()
      const bot = rt.botOf(String(body.botId ?? ''))
      if (!bot) throw new Error('Unknown Bot')
      const name = String(body.name ?? '')
      if (!own(library(), name)) throw new Error(`No capability named ${name}.`)
      return setAttached(bot, name, body.attached === true, body.mode)
    }
    throw new Error('Unknown capability operation.')
  }
  const secretsChanged = rt.secretsChanged
  rt.secretsChanged = () => {
    secretsChanged?.()
    if (loadingSecrets === 0) void scheduleReconcile()
  }
  rt.capabilitiesStateSaved = () => { void scheduleReconcile() }
  const renderCatalog = sessionId => {
    const bot = botOfSession(sessionId)
    if (!bot) return ''
    const lines = [...(bot.packs ?? [])].sort().flatMap(name => {
      const item = own(library(), name)
      if (!item) return []
      const summary = String(item.description || (item.kind === 'mcp' ? 'MCP server' : item.kind === 'skill' ? 'Skill instructions' : `Includes ${(item.items ?? []).join(', ') || 'no items'}`)).replace(/\s+/g, ' ').trim().slice(0, 120)
      const members = item.kind === 'pack' ? item.items ?? [] : [name]
      const count = members.every(member => toolCounts.has(member)) ? members.reduce((sum, member) => sum + toolCounts.get(member), 0) : undefined
      return [`- ${name}: ${summary}${count === undefined ? '' : ` (${count} tools)`}`]
    })
    return lines.length ? ['# Feature packs', ...lines, 'Call use_pack when a task needs one of these packs.'].join('\n') : ''
  }
  const catalogFor = sessionId => {
    if (!botOfSession(sessionId)) return ''
    if (frozenCatalogs.has(sessionId)) return frozenCatalogs.get(sessionId)
    const text = renderCatalog(sessionId)
    frozenCatalogs.set(sessionId, text)
    return text
  }
  ctx.systemPrompt.section({ name: 'feature-packs', order: 646, text: ({ agent }) => {
    if (agent?.ctx) trackAgent(agent)
    return catalogFor(agent?.id)
  } })
  const usePack = async (sessionId, name) => {
    await rt.load()
    const bot = botOfSession(sessionId)
    if (!bot) throw new Error('Only Bots on the team can use feature packs.')
    writeCheck()
    if (bot.capabilities?.includes(name)) return `${name} is already always on.`
    if (!bot.packs?.includes(name)) throw new Error(`${name} is not in your feature pack catalog.`)
    const leaves = expandCapabilityNames([name], library())
    const agent = await rt.resolveAgent(sessionId)
    trackAgent(agent)
    let entries = loaded.get(sessionId)
    if (!entries) loaded.set(sessionId, entries = new Map())
    for (const child of entries.get(name) ?? []) leaves.add(child)
    entries.set(name, leaves)
    pendingDrops.get(sessionId)?.delete(name)
    let timer
    const completed = await Promise.race([
      reconcileOne(agent).then(() => true),
      new Promise(resolve => { timer = setTimeout(resolve, rt.capabilityEnsureTimeoutMs ?? ENSURE_TIMEOUT_MS, false) }),
    ]).finally(() => clearTimeout(timer))
    return [...leaves].map(child => {
      const status = sessionStatuses.get(bot.id)?.get(child)?.get(sessionId)
      if (!status || status.state === 'connecting') return `${child}: error (${completed ? 'mount did not publish a status' : 'mount did not finish within the time limit'})`
      return `${child}: ${status.state}${status.error ? ` (${status.error})` : ''}`
    }).join('\n') || `${name}: ready (empty pack)`
  }
  const dropPack = async (sessionId, name) => {
    await rt.load()
    if (!botOfSession(sessionId)) throw new Error('Only Bots on the team can use feature packs.')
    writeCheck()
    if (!loaded.get(sessionId)?.has(name)) return `${name} is not loaded in this session.`
    let drops = pendingDrops.get(sessionId)
    if (!drops) pendingDrops.set(sessionId, drops = new Set())
    drops.add(name)
    return `${name} will be dropped at the end of this turn.`
  }
  ctx.on('session/event', async function finishFeaturePacks(session, event) {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') return
    const sessionId = session?.id
    if (frozenCatalogs.has(sessionId) && frozenCatalogs.get(sessionId) !== renderCatalog(sessionId)) frozenCatalogs.delete(sessionId)
    if (event.type !== 'turn/end') return
    const entries = loaded.get(sessionId)
    if (!entries) return
    const bot = botOfSession(sessionId)
    for (const name of entries.keys()) {
      if (pendingDrops.get(sessionId)?.has(name) || !bot?.packs?.includes(name) || !own(library(), name)) entries.delete(name)
      else entries.set(name, expandCapabilityNames([name], library()))
    }
    pendingDrops.delete(sessionId)
    if (!entries.size) loaded.delete(sessionId)
    const agent = agents.get(sessionId)?.deref()
    if (agent) {
      await pruneAgent(agent)
      void reconcileOne(agent).catch(error => rt.warn('ds-bot: capability reconcile for %s failed: %s', sessionId, error))
    }
  })
  // Creation waits for these listeners, so a new Agent's first request already has its
  // tools and skill catalog. agent/pre-step is too late: a step assembles its tools first.
  ctx.on('agent/created', async function prepareCapabilities({ agent }) {
    trackAgent(agent)
    try {
      await rt.load()
      const bot = botOfSession(agent.session.id)
      if ((bot?.capabilities ?? []).length > 0) await prepare(agent, agent.session.id)
    } catch (error) {
      rt.warn('ds-bot: capability load failed: %s', error)
    }
  })
  ctx.effect(() => {
    void rt.load().then(async () => {
      for (const bot of Object.values(state.bots)) {
        if ((bot.capabilities ?? []).length > 0) await trackBotAgents(bot)
      }
      await scheduleReconcile()
    }).catch(error => rt.warn('ds-bot: capability startup failed: %s', error))
    return async () => {
      stopped = true
      const live = [...mounts.values()]
      mounts.clear()
      agents.clear()
      sessionStatuses.clear()
      loaded.clear()
      pendingDrops.clear()
      frozenCatalogs.clear()
      toolCounts.clear()
      statusesCache = undefined
      await Promise.all(live.flatMap(agentMounts => [...agentMounts.values()].map(disposeMount)))
    }
  }, 'ds-bot: capabilities')
  Object.assign(rt, {
    capabilitySave,
    capabilityDelete,
    dropOrphanCapabilities,
    capabilityEndpoint,
    capabilityLibraryView: libraryView,
    capabilityStatusesView,
    reconcileCapabilities: reconcile,
    scheduleCapabilitiesReconcile: scheduleReconcile,
    ensureCapabilities,
    expandCapabilities: names => expandCapabilityNames(names, library()),
    changeCapabilityAttachment: changeAttachment,
    usePack,
    dropPack,
  })
}
