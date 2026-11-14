// Client channel: the team view the browser renders, and the POST /api/bot endpoints.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { install as installBtw } from './btw.js'
import { install as installSide } from './side.js'
import { handoffReply, questionReply, viewReply } from './parts.js'
import { validateViewAnswer } from 'deep-view/core'
import { COLORS, EXTRA_COLORS, ROUTE } from './constants.js'

const STAGED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const STAGED_MS = 30 * 60_000

const LANGUAGES = {
  zh: 'Chinese (简体中文)',
  'zh-tw': 'Traditional Chinese (繁體中文)',
  'zh-hk': 'Traditional Chinese (繁體中文)',
  'zh-mo': 'Traditional Chinese (繁體中文)',
  'zh-hant': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
}
const RUN_STATS = ['sessionStats', 'tokenUsage', 'contextPressure']

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
// Programming and file system errors are DS Bot's own faults, logged with their stack;
// any other error is a refusal whose message is meant for the user.
const isInternal = error => error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError
  || error instanceof SyntaxError || (typeof error?.code === 'string' && /^E[A-Z_]+$/.test(error.code))
const MEMORY_LIMIT_SCOPES = new Set(['group', 'bot', 'team'])
const MEMORY_LIMIT_MIN = 1_000
const MEMORY_LIMIT_MAX = 200_000

export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('bot/')) return error.code
  return isInternal(error) ? 'bot/internal' : 'bot/refused'
}

export function install(rt) {
  installBtw(rt)
  installSide(rt)
  const { ctx, state } = rt

  // The DSH interface language of the last browser that asked for the team.
  let uiLocale
  rt.uiLanguage = () => {
    if (uiLocale === undefined) return undefined
    const lower = uiLocale.toLowerCase()
    return LANGUAGES[lower] ?? LANGUAGES[lower.split('-')[0]] ?? uiLocale
  }

  // Photos staged by `stage-image`, kept until the message that names them is sent.
  const staged = new Map()
  const ok = value => ({ ok: true, value })
  const fail = (message, code = 'bot/error') => ({ ok: false, error: { code, message, details: {} } })
  // Models come from DSH, not state.json, so a provider added on the Models pages of Settings
  // changes the view without a new revision.
  const modelsKey = () => `${rt.cachedCatalog().map(entry => `${entry.ref}${entry.needsKey ? '!' : ''}${entry.reasoning ? `:${JSON.stringify(entry.reasoning)}` : ''}`).join(',')}|${rt.cachedDefault() ?? ''}`
  const view = () => ({
    revision: state.revision,
    workspaceId: state.workspaceId ?? null,
    // `mainBotId` is the first Main Bot, which the sidebar shows as its tile.
    mainBotId: state.mainBotIds[0] ?? null,
    mainBotIds: state.mainBotIds,
    // `sessionId` is the Bot's current own-chat part; `parts` its earlier ones.
    // `waiting`: the Bot holds its greeting until the user picks its model or fixes
    // what failed it. `blocked`: the facts of a failure only the user can fix (turns.js).
    bots: Object.values(state.bots).map(({ segments, kickoff, ...bot }) => {
      const tail = rt.chatTail(rt.chatOf(bot.id))
      return {
        ...bot, sessionId: rt.chatOf(bot.id), parts: (segments ?? []).map(segment => segment.sessionId), ...(kickoff ? { waiting: true } : {}),
        // `engine` is the Bot's local-agent route, present only on abots.
        ...(rt.localAgentBadge?.(bot.model ?? bot.appliedModel) !== undefined ? { engine: rt.localAgentBadge(bot.model ?? bot.appliedModel) } : {}),
        ...(tail ? { lastAt: tail.lastAt, preview: tail.preview } : {}),
      }
    }),
    // `sessionId` is the group's own Session's current part, `ownParts` its earlier
    // ones; `parts` the members' hidden group Sessions and their earlier segments,
    // for usage.
    rooms: Object.values(state.rooms).map(({ log, seen, paused, sessions, segments, parts: ownParts, ...room }) => {
      const parts = [...Object.values(sessions ?? {}), ...Object.values(segments ?? {}).flat().map(segment => segment.sessionId), ...(ownParts ?? []).map(segment => segment.sessionId)]
      const last = (log ?? []).filter(line => line.kind === undefined).at(-1)
      return { ...room, sessionId: rt.sessionOfRoom(room), ownParts: (ownParts ?? []).map(segment => segment.sessionId), parts, ...(last ? { lastAt: last.time, preview: last.who === 'User' ? last.text : `${last.who}：${last.text}` } : {}) }
    }),
    // Deleted private Bots whose folder, memory and chats stay closed to the others.
    privateArchives: rt.archivesView(),
    exchangeTurns: state.exchangeTurns,
    questions: state.questions,
    views: state.views ?? {},
    closedCards: state.closedCards ?? {},
    // Aside answers of each Bot's current part, newest first. Not part of the
    // model-visible history; earlier parts send their cards on their own pages.
    btwCards: rt.btwView?.() ?? {},
    // Browser holds (handoffs and takeovers) per Bot, so the phone can show
    // the same cards the desktop toolbar shows.
    browserHolds: rt.browserChannel?.holdSnapshot?.() ?? {},
    // Each Bot's side chats, in creation order. The answers never join the
    // model-visible history; the side panel reads them here.
    sideChats: rt.sideView?.() ?? {},
    // The team's DSH Agent (at most one): plain dsh Sessions, not Bots.
    agents: Object.values(state.agents),
    // Sidebar sections that group Bots, group chats and the DSH Agent by workflow.
    sections: state.sections ?? [],
    // Key names and who may use them; values never leave the host.
    secrets: rt.secretsView(),
    // How the secrets file is stored and whether this process can read it now.
    secretStore: rt.secretStoreStatus(),
    capabilities: rt.capabilityLibraryView(),
    secretRequests: state.secretRequests ?? {},
    connectorRequests: state.connectorRequests ?? {},
    mailRequests: state.mailRequests ?? {},
    colors: [...COLORS, ...EXTRA_COLORS],
    models: rt.cachedCatalog(),
    defaultModel: rt.cachedDefault() ?? null,
    permissions: rt.permissionCatalog?.() ?? null,
    modelsKey: modelsKey(),
    prefs: state.prefs,
    // Whether a Desktop window should serve Bot browser reads (see browser.js).
    browser: rt.browserEnabled,
    // False when config.memory turns memory off: no Memory row or panel.
    memory: rt.memoryEnabled !== false,
    // Set while another dsh host holds the team (store.js): why this one cannot change it.
    readOnly: rt.readOnly() ?? null,
    // IM connections (settings → IM): one per chat-app bot the user added.
    im: rt.imView?.() ?? { connections: [], platforms: [] },
    // The computer-use switch, the provider it mounts, and each Bot's level and app grants.
    computer: rt.computerView?.() ?? { enabled: false },
  })
  // What changes without a new revision, sent with every state answer. `learning`:
  // each Bot's pending skill proposals; `learningSettled`: the answered ones of its
  // current chat part. `memoryNews`:
  // per Bot or group chat, its latest memory change; `memoryReviews`: memory reviews waiting or
  // running; `work`: per Bot, the turn it runs and its tool; per group, the members whose
  // turn there runs; the approvals waiting; per Bot, who it waits for to hand back work;
  // and per Session, when its running turn began.
  const live = () => ({
    secretStore: rt.secretStoreStatus(),
    secrets: rt.secretsView(),
    activity: rt.activityView(),
    work: { bots: rt.workView(), rooms: rt.roomWorkView(), approvals: rt.approvalsView(), waiting: rt.waitingView?.() ?? {}, turns: rt.turnsView?.() ?? {}, steered: rt.steeredView?.() ?? {} },
    memoryNews: rt.memoryNews(),
    memoryReviews: rt.memoryReviews(),
    learning: rt.learningView(),
    learningSettled: rt.learningSettledView(),
    connectors: rt.connectorsView(),
    capabilityStatuses: rt.capabilityStatusesView(),
    phone: rt.phoneView(),
    imStatus: rt.imStatusView?.() ?? {},
    imVia: rt.imViaView?.() ?? {},
    // Why this host cannot write the team, or null. It changes without a save — the
    // other dsh can quit while this window stays open and this host takes the lock
    // over — so a window learns that it may write again without a reload.
    readOnly: rt.readOnly() ?? null,
    // Computer use live state: per-Bot control, leases, pending app cards and holds.
    // Named apart from the state view's `computer`: the live answer merges into the
    // same object and would wipe its `enabled` and `provider` fields.
    computerLive: rt.computerLive?.() ?? {},
  })
  // The live fields' sources are spread across the host with no single change
  // counter, so the serialized answer itself is the detector: a poll whose `live`
  // still names it gets only the key back, not the fields again. The key carries
  // a per-run prefix: a window can outlive the host, and a counter that restarts
  // at 1 would let its stale key name a different answer.
  const liveRun = randomUUID()
  let liveSeq = 0
  let liveCache = null
  const liveAnswer = () => {
    const value = live()
    const json = JSON.stringify(value)
    if (liveCache?.json === json) return liveCache
    return liveCache = { key: `${liveRun}:${++liveSeq}`, value, json }
  }
  // What a host that only reads the team may still answer.
  // Updates change the dsh profile, not the team, so a reading host may run them too.
  const READS = new Set(['secret-store', 'secret-unlock', 'state', 'models', 'efforts', 'providers', 'provider-models', 'earlier', 'chat', 'run-stats', 'room-progress', 'group-rows', 'exchange', 'exchange-text', 'file-text', 'usage', 'schedules', 'memory-view', 'browser-wait', 'browser-result', 'diagnostics', 'diagnostics-log', 'diagnostics-clear', 'update-check', 'update-install', 'dsh-update-install', 'repo-stars', 'approval-answer', 'thinking', 'avatar-library', 'computer-system-status', 'computer-shot', 'local-agents', 'local-agent-models', 'browser-frame', 'hello', 'notices', 'avatar', 'room-chat', 'usage-summary', 'image', 'file-download', 'changes-check', 'changes-summary', 'changes-diff'])

  async function setPrefs(body) {
    if (body.theme !== undefined) {
      if (typeof body.theme !== 'string' || !/^[a-z][\w-]{0,31}$/.test(body.theme)) throw invalid('Unknown theme')
      state.prefs.theme = body.theme
    }
    if (body.accent !== undefined) {
      if (body.accent === null || body.accent === '') delete state.prefs.accent
      else if (/^#[0-9a-f]{6}$/i.test(body.accent)) state.prefs.accent = body.accent
      else throw invalid('Accent must be a #rrggbb color')
    }
    if (body.motion !== undefined) {
      if (body.motion === null || body.motion === 'normal') delete state.prefs.motion
      else if (body.motion === 'quiet' || body.motion === 'lively') state.prefs.motion = body.motion
      else throw invalid('Motion must be quiet, normal or lively')
    }
    if (body.effects !== undefined) {
      if (body.effects === null || body.effects === 'full') delete state.prefs.effects
      else if (body.effects === 'reduced' || body.effects === 'off') state.prefs.effects = body.effects
      else throw invalid('Effects must be full, reduced or off')
    }
    if (body.layout !== undefined) {
      if (body.layout === null || body.layout === 'bubble') delete state.prefs.layout
      else if (body.layout === 'flat') state.prefs.layout = body.layout
      else throw invalid('Layout must be bubble or flat')
    }
    if (body.width !== undefined) {
      if (body.width === null || body.width === 80) delete state.prefs.width
      else if (Number.isInteger(body.width) && body.width >= 50 && body.width <= 100) state.prefs.width = body.width
      else throw invalid('Width must be a whole percent from 50 to 100')
    }
    if (body.flatWidth !== undefined) {
      if (body.flatWidth === null || body.flatWidth === 100) delete state.prefs.flatWidth
      else if (Number.isInteger(body.flatWidth) && body.flatWidth >= 50 && body.flatWidth <= 100) state.prefs.flatWidth = body.flatWidth
      else throw invalid('Flat text width must be a whole percent from 50 to 100')
    }
    if (body.defaultBotModel !== undefined) {
      // The model new Bots start on when a create names none. It resolves now, so the
      // saved ref is one the catalog served at save time; a create still re-checks it.
      if (body.defaultBotModel === null || body.defaultBotModel === '') delete state.prefs.defaultBotModel
      else if (rt.isLocalAgentRef?.(body.defaultBotModel) === true) throw invalid('A local agent cannot be the default model: a new Bot chooses to run on one when it is created')
      else state.prefs.defaultBotModel = await rt.resolveModel(body.defaultBotModel)
    }
    if (body.thinking !== undefined) {
      // A value this version does not know is ignored, not refused: the toggle
      // may grow more states later.
      if (body.thinking === true) state.prefs.thinking = true
      else if (body.thinking === false || body.thinking === null) delete state.prefs.thinking
    }
    if (body.enterToSend !== undefined) {
      if (body.enterToSend === false) state.prefs.enterToSend = false
      else if (body.enterToSend === true || body.enterToSend === null) delete state.prefs.enterToSend
    }
    if (body.memoryAutoRecall !== undefined) {
      if (body.memoryAutoRecall === false) state.prefs.memoryAutoRecall = false
      else delete state.prefs.memoryAutoRecall
    }
    if (body.memoryLimits !== undefined) {
      const sizes = Object.entries(body.memoryLimits ?? {}).filter(([scope, size]) => MEMORY_LIMIT_SCOPES.has(scope) && Number.isInteger(size) && size >= MEMORY_LIMIT_MIN && size <= MEMORY_LIMIT_MAX)
      if (sizes.length === 0) delete state.prefs.memoryLimits
      else state.prefs.memoryLimits = { ...state.prefs.memoryLimits, ...Object.fromEntries(sizes) }
    }
    return rt.save()
  }

  const handle = async (endpoint, payload, signal) => {
    try {
      const body = payload ?? {}
      await rt.refresh()
      const readOnly = rt.readOnly()
      if (readOnly !== undefined && !READS.has(endpoint)) return fail(readOnly, 'bot/read-only')
      switch (endpoint) {
        case 'state': {
          if (typeof body.locale === 'string' && /^[a-z]{2,3}(-[\w-]+)?$/i.test(body.locale)) uiLocale = body.locale
          if (readOnly === undefined) await rt.bootstrap()
          await rt.catalog()
          await rt.loadSecrets()
          const answer = liveAnswer()
          if (body.since === state.revision && (body.models === undefined || body.models === modelsKey())) {
            if (body.live === answer.key) return ok({ revision: state.revision, unchanged: true, liveKey: answer.key })
            return ok({ revision: state.revision, unchanged: true, liveKey: answer.key, ...answer.value })
          }
          // A phone asks for photos by reference and fetches each once (`avatar`).
          const out = { ...view(), liveKey: answer.key, ...answer.value }
          return ok(body.avatars === 'ref' ? rt.slimAvatars(out) : out)
        }
        case 'models':
          await rt.catalog({ fresh: true })
          return ok({ modelsKey: modelsKey() })
        case 'efforts':
          return ok(await rt.reasoningOf(String(body.ref ?? '')) ?? { efforts: [] })
        // A Turn's exact thinking time, from the timed stream in its events; `ms`
        // omitted when the stream carries no reasoning records.
        case 'thinking': {
          const sessionId = String(body.sessionId ?? '')
          const turn = Number(body.turn)
          if (!Number.isFinite(turn) || rt.selfOf(sessionId) === undefined) return ok(null)
          await rt.load()
          const ms = await rt.thinkingOf(sessionId, turn)
          return ok(ms === undefined ? {} : { ms })
        }
        // Model providers and their keys, for a window without DSH's own Models page.
        case 'providers':
          return ok(await rt.providersView())
        case 'provider-key':
          if (body.value === null) await rt.clearProviderKey(String(body.provider ?? ''))
          else await rt.setProviderKey(String(body.provider ?? ''), body.value)
          return ok(await rt.providersView())
        case 'provider-add':
          return ok(await rt.addProvider(body))
        case 'provider-models':
          return ok(await rt.discoverModels(body))
        case 'provider-remove':
          return ok(await rt.removeProvider(String(body.provider ?? '')))
        case 'duplicate-bot':
          await rt.load()
          return ok(await rt.duplicateBot(body.id))
        case 'set-prefs':
          await rt.load()
          await setPrefs(body)
          return ok(state.prefs)
        case 'exchange': {
          await rt.load()
          return ok(rt.exchangesOf(body.a, body.b))
        }
        case 'exchange-text': {
          await rt.load()
          const entry = (body.a !== undefined && body.b !== undefined ? rt.exchangeOf(body.id, body.a, body.b) : undefined)
            ?? state.exchanges.find(item => item.id === body.id)
          if (entry === undefined) return fail('This message is no longer kept', 'bot/stale')
          return ok(await rt.exchangeText(entry))
        }
        // A long Bot post's file (attachLong), for the group chat's "Show all".
        case 'file-text': {
          if (typeof body.file?.attachmentId !== 'string') return fail('No file named', 'bot/invalid')
          const read = await rt.fileText(body.file)
          return read === undefined ? fail('This file cannot be read here', 'bot/unavailable') : ok(read)
        }
        case 'earlier':
          await rt.load()
          return ok(await rt.earlierPage(String(body.sessionId ?? ''), body.cursor ?? undefined))
        case 'chat':
          await rt.load()
          return ok(await rt.chatPage(String(body.botId ?? ''), body.cursor ?? undefined, body.steps === true))
        // DSH's own whole-log figures for the current part of a Bot's chat, the ones its
        // status bar shows; a window without that bar shows them in the Bot's details.
        case 'run-stats': {
          await rt.load()
          const bot = rt.botOf(String(body.botId ?? ''))
          if (bot === undefined) return fail('Unknown Bot', 'bot/not-found')
          const projections = ctx.get?.('sessionProjections')
          if (projections === undefined) return ok(null)
          const agent = await rt.resolveAgent(rt.chatOf(bot.id))
          return ok(projections.snapshot(agent.session, RUN_STATS).values)
        }
        case 'usage':
          await rt.load()
          return ok(await rt.usageView({ timeZone: typeof body.timeZone === 'string' ? body.timeZone.slice(0, 64) : undefined }))
        case 'room-progress': {
          // Any part id of the group's own Session means the group itself.
          const room = rt.roomOf(body.roomId) ?? rt.roomOf(rt.pastOwners.get(body.roomId)?.roomId)
          return ok([...rt.roomProgress.entries()].filter(([, entry]) => entry.roomId === (room?.id ?? body.roomId)).map(([callId, entry]) => ({ callId, replies: rt.groupRows(entry.roomId, entry.from), speaking: entry.slots.filter(slot => slot.status === 'speaking').map(slot => slot.id) })))
        }
        // Search a group's messages, newest first, each hit with its neighbours.
        // `before` (a seq) or `offset` continues into older hits.
        case 'group-search': {
          await rt.load()
          const room = rt.roomOf(body.roomId) ?? rt.roomOf(rt.pastOwners.get(body.roomId)?.roomId)
          if (room === undefined) return fail('Unknown group chat', 'bot/not-found')
          return ok(rt.groupSearch(room.id, body.query, { before: body.before, offset: body.offset }))
        }
        // The rows a settled round of a group chat shows, from its book.
        // Whether a turn's change review can still be opened: the Host serves a turn's
        // summary until its Session is disposed.
        case 'changes-summary':
          return ok(rt.changesSummary(String(body.sessionId ?? ''), Number(body.seq)))
        case 'changes-diff':
          return ok(await rt.changesDiff(String(body.sessionId ?? ''), Number(body.seq), body.index, signal))
        case 'changes-check':
          return ok(rt.changesAvailable?.(String(body.sessionId ?? ''), Number(body.seq)) === true)
        case 'group-rows': {
          await rt.load()
          const room = rt.roomOf(body.roomId) ?? rt.roomOf(rt.pastOwners.get(body.roomId)?.roomId)
          const from = Number(body.from)
          const to = body.to === undefined ? undefined : Number(body.to)
          if (room === undefined || !Number.isInteger(from) || (to !== undefined && !Number.isInteger(to))) return ok({ rows: [], open: false, speaking: [] })
          const view = rt.groupRowsView(room.id, from, to, typeof body.anchor === 'string' ? body.anchor : undefined)
          // The newest call's rows grow while the group works; who is answering shows under them.
          const active = view.open && rt.roomActive(room.id)
          const speaking = active ? [...rt.roomProgress.values()].filter(round => round.roomId === room.id).flatMap(round => round.slots.filter(slot => slot.status === 'speaking').map(slot => slot.id)) : []
          return ok({ ...view, active, speaking })
        }
        case 'create-bot': {
          await rt.bootstrap()
          const bot = await rt.createBot({ name: body.name, role: body.role, color: body.color, instructions: body.instructions, brief: body.brief, avatar: body.avatar, model: body.model, effort: body.effort, workDir: body.workDir, section: body.section, sectionId: body.sectionId })
          return ok(bot)
        }
        case 'update-bot':
          await rt.load()
          return ok(await rt.updateBot(body.id, body))
        // Give up one wait for a hand-off that will not come back: only that sub-work
        // closes, with an explicit result for the work above it.
        case 'abandon-work':
          await rt.load()
          if (rt.abandonWork?.(String(body.id ?? '')) !== true) return fail('That wait is no longer open', 'bot/stale')
          return ok(true)
        // The repair card's Retry, once the user fixed what failed the Bot's turn.
        case 'resume': {
          await rt.load()
          const bot = rt.botOf(String(body.botId ?? ''))
          if (bot === undefined) return fail('Unknown Bot', 'bot/not-found')
          await rt.resumeBot(bot)
          return ok(true)
        }
        // The avatar library: photos the user imported once, kept beside the team.
        case 'avatar-library':
          await rt.load()
          return ok(await rt.avatarLibraryView({ offset: body.offset, limit: body.limit }))
        case 'avatar-import':
          await rt.load()
          return ok(await rt.avatarLibraryImport(Array.isArray(body.items) ? body.items : []))
        case 'avatar-delete':
          await rt.load()
          return ok(await rt.avatarLibraryDelete(String(body.id ?? '')))
        case 'delete-bot':
          await rt.load()
          await rt.deleteBot(body.id)
          return ok(view())
        case 'private-release':
          await rt.load()
          await rt.releaseArchive(String(body.id ?? ''))
          return ok(view())
        case 'set-main':
          await rt.load()
          await rt.setMain(body.id, body.main !== false, {
            primary: body.primary === true,
            replace: typeof body.replace === 'string' ? body.replace : undefined,
          })
          return ok(view())
        case 'create-room': {
          await rt.load()
          const room = await rt.createRoom({ members: Array.isArray(body.members) ? body.members : [], name: body.name, section: body.section, sectionId: body.sectionId, ...(typeof body.admin === 'string' ? { admin: body.admin } : {}) })
          if (body.greet === true) await rt.greetRoom(room.id).catch(error => rt.warn('ds-bot: greeting in %s failed: %s', room.name, error))
          return ok(room)
        }
        case 'update-room': {
          await rt.load()
          const { room, changes } = await rt.updateRoom(body.id, {
            name: body.name,
            notice: body.notice,
            mode: body.mode,
            admin: body.admin,
            members: Array.isArray(body.members) ? body.members : undefined,
            add: Array.isArray(body.add) ? body.add : undefined,
            remove: Array.isArray(body.remove) ? body.remove : undefined,
            workDir: body.workDir,
            permission: body.permission,
            section: body.section,
            sectionId: body.sectionId,
          })
          return ok({ room: view().rooms.find(entry => entry.id === room.id), changes })
        }
        // The user ticks, removes, or clears completed shared to-dos in the group's
        // details; members read and change the same list with the group_todo tool.
        case 'room-todo': {
          await rt.load()
          const room = rt.roomOf(String(body.roomId ?? ''))
          if (room === undefined) return fail('Unknown group chat', 'room/not-found')
          if (body.action === 'clear') {
            const removed = await rt.clearDoneRoomTodos(room.id)
            return ok({ removed: removed.length, todos: room.todos ?? [] })
          }
          if (body.action === 'remove') {
            const item = await rt.removeRoomTodo(room.id, String(body.id ?? ''))
            return ok({ item, todos: room.todos ?? [] })
          }
          const item = await rt.setRoomTodoDone(room.id, String(body.id ?? ''), typeof body.done === 'boolean' ? body.done : undefined)
          return ok({ item, todos: room.todos ?? [] })
        }
        case 'folders':
        case 'folder-pick':
        case 'folder-list':
          await rt.load()
          return ok(await rt.folderEndpoint(endpoint, body, signal))
        case 'team-workspace':
          await rt.load()
          return ok({ team: await rt.setTeamWorkspace(String(body.path ?? '')) })
        case 'add-agent':
          await rt.load()
          return ok(await rt.addAgent())
        case 'agent-session':
          await rt.load()
          return ok({ sessionId: await rt.createAgentSession(body.agentId, body.workspaceId) })
        case 'agent-adopt':
          await rt.load()
          return ok({ sessionId: await rt.adoptAgentSession(body.agentId, body.sessionId) })
        case 'agent-archive':
          await rt.load()
          await rt.archiveAgentSession(body.agentId, body.sessionId)
          return ok(true)
        case 'agent-rename':
          await rt.load()
          await rt.renameAgentSession(body.agentId, body.sessionId, body.title)
          return ok(true)
        case 'remove-agent':
          await rt.load()
          await rt.removeAgent(body.agentId)
          return ok(view())
        case 'set-flags':
          await rt.load()
          return ok(await rt.setFlags(body.id, body))
        case 'section-save':
          await rt.load()
          return ok(await rt.saveSection(body))
        case 'section-order':
          await rt.load()
          await rt.reorderSections(body.ids)
          return ok(view())
        case 'section-delete':
          await rt.load()
          await rt.deleteSection(body.id)
          return ok(view())
        case 'delete-room':
          await rt.load()
          await rt.deleteRoom(body.id)
          return ok(view())
        case 'approval-answer':
          rt.answerApproval(body.id, body.choice)
          return ok(true)
        // A stop that fails partway still parks the goal, or it wakes the admin again.
        case 'stop-member-work':
          try {
            return ok(await rt.stopMemberWork(String(body.roomId ?? ''), String(body.botId ?? '')))
          } finally {
            rt.goalUserStopped?.(String(body.roomId ?? ''))
          }
        case 'stop-room-work':
          try {
            return ok(await rt.stopRoomWork(String(body.roomId ?? '')))
          } finally {
            rt.goalUserStopped?.(String(body.roomId ?? ''))
          }
        case 'goal-draft': {
          await rt.load()
          const result = await rt.goalDraft(String(body.roomId ?? ''), body.text)
          return result.error !== undefined ? fail(result.error, result.code ?? 'bot/refused') : ok(view())
        }
        case 'goal-control': {
          await rt.load()
          const result = await rt.goalControl(String(body.roomId ?? ''), body)
          return result.error !== undefined ? fail(result.error, result.code ?? 'bot/refused') : ok(view())
        }
        // The task board's two panel actions. A note the user adds is kept on the task
        // and posted into the group as the user's own message that calls its owner, so
        // the Bot acts on it where the work runs, as if the user had typed it there.
        case 'task-note': {
          await rt.load()
          const roomId = String(body.roomId ?? '')
          const result = rt.taskNote(roomId, String(body.id ?? ''), body.text)
          if (result.error !== undefined) return fail(result.error, 'bot/refused')
          const bot = rt.botOf(result.task.botId)
          await rt.save()
          if (bot !== undefined) {
            await rt.sendUser({
              sessionId: roomId,
              content: [{ type: 'text', text: `@${bot.name} ${result.task.notes.at(-1).text}` }],
            })
          }
          return ok(view())
        }
        case 'task-cancel': {
          await rt.load()
          const result = rt.taskCancel(String(body.roomId ?? ''), String(body.id ?? ''))
          if (result.error !== undefined) return fail(result.error, 'bot/refused')
          await rt.save()
          return ok(view())
        }
        case 'stop-chat':
          return ok(await rt.stopChat(String(body.botId ?? '')))
        case 'dismiss-question':
          await rt.load()
          if (rt.own(state.questions, body.sessionId) !== undefined) {
            rt.closeCard(body.sessionId, state.questions[body.sessionId], 'dismissed')
            delete state.questions[body.sessionId]
            await rt.save()
          }
          return ok(true)
        case 'dismiss-view':
          await rt.load()
          if (rt.own(state.views, body.sessionId) !== undefined) {
            rt.closeCard(body.sessionId, state.views[body.sessionId], 'dismissed')
            delete state.views[body.sessionId]
            await rt.save()
          }
          return ok(true)
        case 'secret-set':
        case 'secret-allow':
        case 'secret-cancel':
        case 'secret-update':
        case 'secret-delete':
        case 'secret-store':
        case 'secret-unlock':
        case 'secret-encrypt':
        case 'secret-decrypt':
          await rt.load()
          return ok(await rt.secretEndpoint(endpoint, body))
        case 'connector-connect':
        case 'connector-disconnect':
        case 'connector-retry':
        case 'connector-sign-in-code':
        case 'connector-cancel':
        case 'connector-client':
        case 'connector-set':
        case 'connector-add':
        case 'connector-remove':
        case 'connector-import-scan':
        case 'connector-import':
        case 'connector-request-cancel':
        case 'mail-account-add':
        case 'mail-account-remove':
        case 'mail-rule-set':
        case 'mail-send-answer':
        case 'mail-sign-in-code':
          await rt.load()
          return ok(await rt.connectorEndpoint(endpoint, body))
        case 'phone-set':
        case 'phone-pair':
        case 'phone-pair-cancel':
        case 'phone-remove':
          return ok(await rt.phoneEndpoint(endpoint, body))
        case 'capability-save':
        case 'capability-delete':
        case 'capability-approve':
        case 'bot-capability':
          await rt.load()
          return ok(await rt.capabilityEndpoint(endpoint, body))
        case 'schedules':
        case 'schedule-create':
        case 'schedule-delete':
          await rt.load()
          return ok(await rt.scheduleEndpoint(endpoint, body))
        case 'memory-view':
        case 'memory-ask':
        case 'memory-pin':
        case 'memory-tidy-undo':
        case 'memory-layer':
        case 'memory-move':
        case 'memory-forget':
        case 'memory-history':
        case 'memory-restore':
          await rt.load()
          return ok(await rt.memoryEndpoint(endpoint, body))
        case 'learning-answer':
          await rt.load()
          return ok(await rt.learningEndpoint(endpoint, body))
        // The mobile API (mobile.js).
        case 'hello':
        case 'notices':
        case 'avatar':
        case 'room-chat':
        case 'image':
        case 'file-download':
        case 'usage-summary':
        case 'memory-edit':
        case 'memory-add':
          await rt.load()
          return ok(await rt.mobileEndpoint(endpoint, body))
        case 'answer-question': {
          if (typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          await rt.load()
          return ok(await rt.answerQuestion(body.sessionId, body.questionId, body.answer))
        }
        case 'view-reply': {
          if (typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          await rt.load()
          const past = rt.pastOwners.get(body.sessionId)
          const sessionId = rt.botOf(body.sessionId) ? rt.chatOf(body.sessionId) : past && past.roomId === undefined ? rt.chatOf(past.botId) : body.sessionId
          const pending = rt.own(state.views, sessionId)
          if (pending === undefined || pending.id !== body.viewId) return fail('This view is no longer open', 'bot/stale')
          const checked = validateViewAnswer(pending.view, body.action, body.values)
          if (checked.error !== undefined) return fail(checked.error, 'bot/invalid')
          const reply = viewReply(pending, body.action, body.values)
          if (reply === undefined) return fail('Nothing to send', 'bot/invalid')
          // Claim the view before queueing so a second answer is refused.
          delete state.views[sessionId]
          try {
            await rt.ensureCapabilities(sessionId)
            const agent = await rt.resolveAgent(sessionId)
            agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: reply.source }))
            await ctx.sessions.flush(agent.session)
          } catch (error) {
            state.views[sessionId] ??= pending
            throw error
          }
          await rt.save()
          return ok(true)
        }
        // A photo for the next `send`, one per call: a phone's link carries a few MB per
        // message, so photos travel one by one and the message names them.
        case 'stage-image': {
          const mediaType = String(body.mediaType ?? '')
          const data = typeof body.data === 'string' ? body.data : ''
          if (!STAGED_TYPES.has(mediaType) || data === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return fail('This is not a photo DS Bot can send', 'bot/invalid')
          const now = Date.now()
          for (const [id, entry] of staged) if (entry.at < now - STAGED_MS) staged.delete(id)
          const id = randomUUID()
          staged.set(id, { mediaType, data, at: now })
          return ok({ id })
        }
        case 'send': {
          const text = String(body.text ?? '').trim()
          const ids = Array.isArray(body.images) ? body.images.map(String) : []
          if ((text === '' && ids.length === 0) || typeof body.sessionId !== 'string') return fail('Nothing to send', 'bot/invalid')
          const images = ids.map(id => staged.get(id))
          if (images.some(entry => entry === undefined)) return fail('A photo did not arrive. Send it again.', 'bot/stale')
          await rt.load()
          await rt.sendUser({
            sessionId: body.sessionId,
            content: [
              ...(text === '' ? [] : [{ type: 'text', text }]),
              ...images.map(({ mediaType, data }) => ({ type: 'image', mediaType, data })),
            ],
          })
          for (const id of ids) staged.delete(id)
          return ok(true)
        }
        case 'btw-delete': {
          if (typeof body.sessionId !== 'string' || body.sessionId === '' || typeof body.cardId !== 'string' || body.cardId === '') return fail('Nothing to delete', 'bot/invalid')
          await rt.load()
          return ok(await rt.btwDelete({ sessionId: body.sessionId, cardId: body.cardId }))
        }
        // Side chats in the Bot's panel: each question is an aside on a fresh
        // snapshot of this Bot's private chat; the earlier finished pairs of
        // that chat ride along. Nothing is written into the Session.
        case 'side-new': {
          if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('Nothing to open', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideNew({ sessionId: body.sessionId }))
        }
        case 'side-ask': {
          if (typeof body.sessionId !== 'string' || body.sessionId === '') return fail('Nothing to ask', 'bot/invalid')
          if (body.chatId !== undefined && typeof body.chatId !== 'string') return fail('Nothing to ask', 'bot/invalid')
          if (String(body.text ?? '').trim() === '') return fail('Write a question.', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideAsk({ sessionId: body.sessionId, chatId: body.chatId, recent: body.recent === true, text: String(body.text) }))
        }
        case 'side-cancel': {
          if (typeof body.chatId !== 'string' || body.chatId === '' || typeof body.entryId !== 'string' || body.entryId === '') return fail('Nothing to cancel', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideCancel({ chatId: body.chatId, entryId: body.entryId }))
        }
        case 'side-close': {
          if (typeof body.chatId !== 'string' || body.chatId === '') return fail('Nothing to close', 'bot/invalid')
          await rt.load()
          return ok(await rt.sideClose({ chatId: body.chatId }))
        }
        case 'update-check': {
          const fresh = body.fresh === true
          return ok({ ...(await rt.updateCheck({ fresh })), dsh: (await rt.dshUpdateCheck?.({ fresh })) ?? null })
        }
        case 'update-install':
          return ok(rt.updateStart())
        case 'dsh-update-install':
          return ok(rt.dshUpdateStart?.())
        case 'repo-stars':
          return ok(await rt.repoStars())
        case 'browser-frame': {
          if (rt.browserFrame === undefined && rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          const frame = typeof rt.browserFrame === 'function' ? await rt.browserFrame(String(body.botId ?? '')) : undefined
          if (frame === undefined) return fail('This Bot has no open browser', 'bot/not-found')
          return ok(frame)
        }
        // The Desktop window's long poll for read_browser, and its answers.
        case 'browser-wait': {
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 100) : ''
          if (clientId === '') return fail('A browser poll needs a clientId', 'bot/invalid')
          await rt.load()
          const requests = await rt.browserChannel.wait(clientId, rt.browserOpen(body.open))
          return ok({ requests, holds: rt.browserChannel.holdSnapshot() })
        }
        case 'browser-result':
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          return ok(rt.browserChannel.result(body))
        case 'browser-takeover': {
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          await rt.load()
          const botId = String(body.botId ?? '')
          if (!rt.botOf(botId)) return fail('Unknown Bot', 'bot/not-found')
          // Taking over a handoff keeps its reason, note, and call, so its card stays up.
          const asked = rt.browserChannel.holdOf(botId)
          rt.browserChannel.setHold(botId, asked?.callId !== undefined
            ? { by: 'user', reason: asked.reason, note: asked.note, callId: asked.callId }
            : { by: 'user', reason: 'takeover', note: 'The user is controlling this browser.' })
          return ok(true)
        }
        // A card's 'done' or 'skip' says how the handoff went. The panel's Give back
        // sends no outcome, so its reply only says that control returned to the Bot.
        case 'browser-give-back': {
          if (rt.browserChannel === undefined) return fail('Bot browsers are off on this host', 'bot/browser-off')
          await rt.load()
          const botId = String(body.botId ?? '')
          if (!rt.botOf(botId)) return fail('Unknown Bot', 'bot/not-found')
          if (body.outcome !== undefined && !['done', 'skip', 'returned'].includes(body.outcome)) return fail('Nothing to send', 'bot/invalid')
          const hold = rt.browserChannel.holdOf(botId)
          if (hold === null) return fail('This browser is not held', 'bot/forbidden')
          if (body.callId !== undefined && body.callId !== hold.callId) return fail('This handoff is no longer open', 'bot/stale')
          // Claim the hold before queueing so a second answer is refused.
          rt.browserChannel.setHold(botId, null)
          if (hold.callId === undefined) return ok(true)
          try {
            const sessionId = rt.chatOf(botId)
            const reply = handoffReply(hold, body.outcome)
            await rt.ensureCapabilities(sessionId)
            const agent = await rt.resolveAgent(sessionId)
            agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: reply.source }))
            await ctx.sessions.flush(agent.session)
          } catch (error) {
            if (rt.browserChannel.holdOf(botId) === null) rt.browserChannel.setHold(botId, hold)
            throw error
          }
          return ok(true)
        }
        case 'browser-stop': {
          await rt.load()
          const botId = String(body.botId ?? '')
          if (!rt.botOf(botId)) return fail('Unknown Bot', 'bot/not-found')
          const sessionId = rt.chatOf(botId)
          if (sessionId && rt.live.get(sessionId)?.turn !== undefined) {
            const agent = await rt.resolveAgent(sessionId)
            agent.cancel({ kind: 'user' })
          }
          for (const room of Object.values(rt.state.rooms ?? {})) {
            if (room.members?.includes(botId)) await rt.stopMemberWork?.(room.id, botId)
          }
          rt.browserChannel?.setHold(botId, { by: 'user', reason: 'stopped', note: 'The user is controlling this browser.' })
          return ok(true)
        }
        case 'im-add':
        case 'im-update':
        case 'im-remove':
        case 'im-pair':
        case 'im-unpair':
        case 'im-chat':
        case 'im-retry':
        case 'im-login-start':
        case 'im-login-wait':
          await rt.load()
          return ok(await rt.imEndpoint(endpoint, body))
        case 'local-agents':
        case 'local-agent-models':
        case 'local-agent-refresh':
        case 'local-agent-add':
        case 'local-agent-update':
        case 'local-agent-remove':
          await rt.load()
          return ok(await rt.localAgentsEndpoint(endpoint, body))
        // "New session" and "open an earlier session" on an abot's chat: ordinary
        // parts moves (parts.js), the same mechanism every Bot's chat uses.
        case 'bot-new-part': {
          await rt.load()
          const bot = rt.botOf(String(body.botId ?? ''))
          if (bot === undefined) return fail('Unknown Bot', 'bot/not-found')
          return ok(await rt.newPart(rt.chatOf(bot.id)))
        }
        case 'bot-open-part': {
          await rt.load()
          const bot = rt.botOf(String(body.botId ?? ''))
          if (bot === undefined) return fail('Unknown Bot', 'bot/not-found')
          return ok(await rt.switchPart(bot.id, String(body.sessionId ?? '')))
        }
        case 'diagnostics':
          await rt.load()
          return ok(await rt.diagnostics.report(body))
        case 'diagnostics-log':
          return ok(await rt.diagnostics.logText())
        case 'diagnostics-clear':
          await rt.diagnostics.clear()
          return ok(true)
        default:
          if (endpoint.startsWith('computer-')) {
            await rt.load()
            return ok(await rt.computerEndpoint(endpoint.slice('computer-'.length), body))
          }
          return fail(`Unknown endpoint ${endpoint}`, 'bot/not-found')
      }
    } catch (error) {
      const code = errorCode(error)
      const message = error?.message ?? String(error)
      if (code === 'bot/internal') rt.noteFailure({ source: 'api', text: `${endpoint}: ${message}`, code: error?.code ?? error?.name, stack: error?.stack })
      return fail(message, code)
    }
  }

  rt.channelCall = handle
  rt.phoneServe(handle)

  // How a user message reaches a Session: a Bot id, a group chat's id, or an earlier
  // part of either resolves to its current part. `content` is the prompt blocks DSH
  // takes (text, image, file receipts); `requestId` lands on the message's source.
  async function sendUser({ sessionId: ref, content, requestId = randomUUID() }) {
    const past = rt.pastOwners.get(ref)
    const room = rt.roomOf(ref)
    const sessionId = rt.botOf(ref) ? rt.chatOf(ref)
      : room !== undefined ? rt.sessionOfRoom(room)
        : past?.roomId === undefined && past !== undefined ? rt.chatOf(past.botId)
          : past !== undefined ? rt.sessionOfRoom(rt.roomOf(past.roomId)) : ref
    await rt.ensureCapabilities(sessionId)
    await ctx.sessionController.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content,
    }, AbortSignal.timeout(30_000))
  }

  // The user's answer to an ask_user card, from the web or an IM chat. A Bot id or an
  // earlier part of its own chat means the current one.
  async function answerQuestion(sessionRef, questionId, answer, requestId) {
    const past = rt.pastOwners.get(sessionRef)
    const sessionId = rt.botOf(sessionRef) ? rt.chatOf(sessionRef) : past && past.roomId === undefined ? rt.chatOf(past.botId) : sessionRef
    const question = rt.own(state.questions, sessionId)
    if (question === undefined || question.id !== questionId) throw Object.assign(new Error('This question is no longer open'), { code: 'bot/stale' })
    const reply = questionReply(question, answer)
    if (reply === undefined) throw Object.assign(new Error('Nothing to send'), { code: 'bot/invalid' })
    // Claim the question before queueing so a second answer is refused.
    delete state.questions[sessionId]
    try {
      await rt.ensureCapabilities(sessionId)
      const agent = await rt.resolveAgent(sessionId)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: reply.text }], source: { ...reply.source, ...(requestId === undefined ? {} : { rpcId: requestId }) } }))
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      state.questions[sessionId] ??= question
      throw error
    }
    await rt.save()
    return true
  }

  Object.assign(rt, { sendUser, answerQuestion })

  // An exact Fetch route on the shared /api channel; the browser authenticates with its session cookie.
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { body = {} }
      const result = await handle(String(body?.endpoint ?? ''), body?.payload, request.signal)
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }), 'ds-bot: api route')

  ctx.effect(() => {
    void rt.load()
    // Registered last, so this disposer runs before the state lock is released.
    // In-flight side questions abort here; their entries stay answering for the
    // next owner.
    return () => Promise.all([rt.btwDispose?.(), rt.sideDispose?.()])
  }, 'ds-bot: load state')
}
