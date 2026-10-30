// Private Bots. A private Bot reads the team like any Bot, but no other Bot reads it, and
// what it sends out waits for the user. DSH does not fence reads, so this closes the
// tools DS Bot owns and checks the paths that the file tools and the shell are given;
// a shell can still reach any file the account can (see docs/plans).
import { join, resolve } from 'node:path'
import { within } from './folders.js'
import { unquote } from './text.js'

const FILE_TOOLS = { read: 'file_path', write: 'file_path', edit: 'file_path', read_image: 'file_path', str_replace_editor: 'path' }
const WRITE_TOOLS = ['write', 'edit', 'str_replace_editor']
const SEARCH_TOOLS = ['glob', 'grep']
const SHELL_TOOLS = ['bash', 'pwsh', 'terminal_open', 'terminal_send']
const SESSION_TOOLS = ['session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read']

// Windows and macOS file systems ignore case.
const fold = text => (process.platform === 'linux' ? text : text.toLowerCase())
const overlap = (a, b) => within(a, b) || within(b, a)
const strings = value => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [])
// The same path as a shell writes it: forward slashes, and on Windows both drive forms.
const asShell = (path) => {
  const slashed = path.replace(/\\/g, '/')
  const drive = /^([a-z]):\//i.exec(slashed)
  return drive ? [slashed, `/${drive[1]}${slashed.slice(2)}`] : [slashed]
}

export function install(rt) {
  const { ctx, state } = rt

  const isPrivate = id => rt.botOf(id)?.private === true
  const privateBots = () => Object.values(state.bots).filter(bot => bot.private === true)
  // Deleting a private Bot does not make the files and memory it leaves behind public.
  const protectedBots = () => [...new Map([...(state.privateArchives ?? []), ...privateBots()].map(bot => [bot.id, bot])).values()]
  const sessionsOf = bot => [...new Set([bot.id, ...(bot.sessionIds ?? [rt.chatOf(bot.id), ...(bot.segments ?? []).map(segment => segment.sessionId), ...rt.groupSessionsOf(bot.id)])])]
  const dataRoots = () => [rt.dshHome, rt.home, process.env.DS_BOT_USER_DSH_HOME?.trim()].filter(Boolean)

  // A path as it is and as the file system resolves it, folded for comparing. realBeyond
  // also resolves a link above a file that does not exist yet.
  const spellings = async (path) => [...new Set([fold(resolve(path)), fold(await rt.realBeyond(resolve(path)))])]

  // The Bot a call speaks for. A subagent speaks for the Bot at the root of its
  // parent chain, however many subagents sit between them.
  const callerOf = async (exec) => {
    const own = rt.selfOf(exec.agent?.id) ?? rt.selfOf(exec.agent?.session?.id)
    if (own !== undefined) return own
    let parent = exec.agent?.session?.header?.parentSession
    const seen = new Set()
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent)
      const owner = rt.selfOf(parent)
      if (owner !== undefined) return owner
      const agent = await rt.resolveAgent(parent).catch(() => undefined)
      parent = agent?.session?.header?.parentSession
    }
    return undefined
  }

  // Where a private Bot keeps what must stay closed: its folder and its memory. Its
  // Sessions and its id are in file names under DSH's and the team's data.
  const regionsOf = async bot => (await Promise.all([
    bot.workDir,
    join(rt.home, 'memory', 'bots', bot.id),
    join(rt.home, 'browser-profiles', bot.id),
    join(rt.home, 'browser-downloads', bot.id),
    join(rt.home, 'side', `${bot.id}.json`),
    join(rt.home, 'btw', bot.id),
    bot.archivePath,
  ].filter(Boolean).map(spellings))).flat()
  const sharedFiles = async () => (await Promise.all([
    rt.statePath,
    join(rt.home, 'chat-index.sqlite'),
    join(rt.home, 'chat-index.sqlite-wal'),
    join(rt.home, 'chat-index.sqlite-shm'),
    join(rt.home, 'usage.sqlite'),
    join(rt.home, 'usage.sqlite-wal'),
    join(rt.home, 'usage.sqlite-shm'),
    join(rt.home, 'inflight.json'),
    join(rt.home, 'learning', 'state.json'),
    join(rt.home, 'ocr.json'),
    join(rt.home, 'secrets.json'),
    join(rt.home, 'memory', 'journal.jsonl'),
    join(rt.home, 'memory', 'journal.torn'),
    join(rt.home, 'memory', 'pending.json'),
    join(rt.home, 'logs', 'diagnostics.jsonl'),
  ].filter(Boolean).map(spellings))).flat()

  const teamFolder = () => rt.teamFolder() ?? resolve(rt.defaultTeamFolder())
  const teamMemory = join(rt.home, 'memory', 'team')
  // The memory of deleted Bots and groups. What a private Bot left there is a region of
  // its own (archivePath) and is checked first; the rest was never closed, and the
  // memory of a Bot whose protection the user lifted is in it.
  const memoryArchive = join(rt.home, 'memory', 'archive')

  // The private Bot that `path` belongs to, other than `self`; undefined when it is open.
  // `search` is for tools that walk a folder: a folder that holds a closed one is closed
  // too, and so are the data folders, where the walk cannot be told which files to skip.
  async function ownerOfPath(path, { self, search = false, base } = {}) {
    const bots = protectedBots()
    if (bots.length === 0) return undefined
    const keys = await spellings(base === undefined ? path : resolve(base, path))
    for (const bot of bots) {
      if (bot.id === self) continue
      const needles = sessionsOf(bot).map(fold)
      const regions = await regionsOf(bot)
      for (const key of keys) {
        if (regions.some(region => within(key, region) || (search && within(region, key)))) return bot
        if (needles.some(needle => key.includes(needle))) return bot
      }
    }
    const other = bots.find(bot => bot.id !== self)
    for (const file of await sharedFiles()) if (other !== undefined && keys.some(key => key.startsWith(file))) return other
    if (other !== undefined) {
      const ownBot = rt.botOf(self)
      const ownIds = ownBot === undefined ? [] : sessionsOf(ownBot).map(fold)
      const ownRegions = ownBot === undefined ? [] : await regionsOf(ownBot)
      // A walk of the archive stays closed while a private Bot's memory is on its way
      // there: until the path is known, the walk cannot be told which folder to skip.
      const moving = search && bots.some(bot => bot.archiving === true)
      const open = [rt.workDirOf({ botId: self }), teamFolder(), teamMemory, moving ? undefined : memoryArchive, ...ownRegions].filter(Boolean)
      const folders = (await Promise.all(open.map(spellings))).flat()
      const roots = (await Promise.all(dataRoots().map(spellings))).flat()
      for (const key of keys) {
        if ((!search && ownIds.some(id => key.includes(id))) || folders.some(folder => within(key, folder))) continue
        // Direct reads are closed too, not only walks: an index, pending record or log
        // can hold the same private text without naming the Session in its file name.
        if (roots.some(root => within(key, root) || (search && within(root, key)))) return other
      }
    }
    return undefined
  }

  // Text a shell runs: a closed path anywhere in it closes the command. A path that the
  // command builds, or reaches by walking up from a folder, is not seen.
  async function ownerInText(text, self) {
    const flat = fold(text.replace(/\\/g, '/'))
    const bots = protectedBots()
    for (const bot of bots) {
      if (bot.id === self) continue
      const spelled = (await regionsOf(bot)).flatMap(asShell)
      if (spelled.some(region => flat.includes(region)) || sessionsOf(bot).some(id => flat.includes(fold(id)))) return bot
    }
    const other = bots.find(bot => bot.id !== self)
    for (const file of await sharedFiles()) if (other !== undefined && asShell(file).some(spelled => flat.includes(spelled))) return other
    return undefined
  }

  const closed = (bot, what) => new Error(`${bot.name} is a private Bot, and other Bots cannot reach its ${what}. Ask the user if ${bot.name} should share something.`)

  // What a private Bot sends out is shown to the user first, as the user sees it.
  async function approve(exec, { en, zh }) {
    const approval = ctx.get?.('approval')
    if (approval === undefined || exec.agent?.session === undefined) throw new Error('A private Bot needs the user\'s approval for this, and there is no way to ask for it here, so it was not done.')
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason: en,
      displayReason: { en, zh },
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    if (outcome === 'allowed-once') return
    throw new Error(outcome === 'rejected' ? 'The user did not allow it, so it was not done.'
      : outcome === 'cancelled' ? 'The approval was cancelled, so it was not done.'
        : 'The approval could not be answered, so it was not done.')
  }

  // The Bot a tool argument names, as the tools and the memory scopes read it.
  const botNamed = ref => (typeof ref === 'string' && ref !== '' ? rt.findBot(ref) ?? rt.findBot(unquote(ref)) : undefined)

  // Tools between Bots. Other Bots may not reach a private Bot; what a private Bot sends
  // to them is the user's to allow. A private Bot is no member of a group, which the
  // roster checks as the members are written.
  async function guardTeam(exec, self) {
    const args = exec.arguments ?? {}
    const target = (ref) => {
      const bot = botNamed(ref)
      return bot !== undefined && isPrivate(bot.id) && bot.id !== self ? bot : undefined
    }
    switch (exec.name) {
      case 'message_bot': {
        const bot = target(args.to)
        if (bot) throw new Error(`Not sent: ${bot.name} is a private Bot, and other Bots cannot message it. Ask the user to pass it on.`)
        const to = botNamed(args.to)
        if (isPrivate(self) && to !== undefined) await approve(exec, { en: `Let ${rt.botOf(self).name} send this to ${to.name}?\n\n${String(args.message ?? '')}`, zh: `允许 ${rt.botOf(self).name} 把下面的内容发给 ${to.name} 吗？\n\n${String(args.message ?? '')}` })
        return
      }
      // Every Bot reads the shared capabilities, so saving one shares what is in it.
      case 'save_capability': {
        if (!isPrivate(self)) return
        const shown = JSON.stringify(args, null, 2)
        await approve(exec, { en: `Let ${rt.botOf(self).name} share this with the team?\n\n${shown}`, zh: `允许 ${rt.botOf(self).name} 把下面的内容共享给团队吗？\n\n${shown}` })
        return
      }
      case 'stop_bot': {
        const bot = target(args.bot)
        if (bot) throw closed(bot, 'turns')
        return
      }
      case 'attach_capability':
      case 'detach_capability': {
        const bot = target(args.bot)
        if (bot) throw closed(bot, 'capabilities')
        return
      }
      case 'update_bot': {
        const bot = target(args.bot)
        if (bot) throw closed(bot, 'settings')
        return
      }
      case 'recall':
      case 'remember':
      case 'forget': {
        const bot = target(args.scope)
        if (bot) throw closed(bot, 'memory')
        return
      }
      default:
    }
  }

  // A Session started under a private Bot is closed too, even when its own id is not in
  // the Bot's chat history. Walk the same parent chain as the caller check.
  async function ownerOfSession(id, self) {
    const bots = protectedBots()
    const owns = (sessionId, bot) => bot.id !== self && sessionsOf(bot).includes(sessionId)
    const direct = bots.find(bot => owns(id, bot))
    if (direct) return direct
    const seen = new Set([id])
    let current = id
    for (;;) {
      const agent = await rt.resolveAgent(current).catch(() => undefined)
      const parent = agent?.session?.header?.parentSession
      if (parent === undefined || seen.has(parent)) return undefined
      const owner = bots.find(bot => owns(parent, bot))
      if (owner) return owner
      seen.add(parent)
      current = parent
    }
  }

  // The file tools, the shell and the session search: where the path or text names a
  // closed place, the call fails before it runs.
  async function guardFiles(exec, self) {
    const args = exec.arguments ?? {}
    const folder = () => rt.sessionFolder(exec.agent?.session ?? exec.agent)
    const refuse = (bot) => { throw closed(bot, 'files') }
    const name = exec.name
    if (name in FILE_TOOLS) {
      const path = args[FILE_TOOLS[name]]
      if (typeof path !== 'string' || path === '') return
      const bot = await ownerOfPath(path, { self, base: folder() })
      if (bot) refuse(bot)
      // A private Bot's file changes stay in its own folder unless the user allows them.
      if (isPrivate(self) && WRITE_TOOLS.includes(name)) {
        const own = await spellings(rt.botOf(self).workDir)
        const base = folder()
        const target = await spellings(base === undefined ? path : resolve(base, path))
        if (!target.every(key => own.some(root => within(key, root)))) await approve(exec, { en: `Let ${rt.botOf(self).name} change ${path}? It is outside its own folder.`, zh: `允许 ${rt.botOf(self).name} 修改 ${path} 吗？它在自己的文件夹之外。` })
      }
      return
    }
    if (SEARCH_TOOLS.includes(name)) {
      const where = typeof args.path === 'string' && args.path !== '' ? args.path : '.'
      const bot = await ownerOfPath(where, { self, search: true, base: folder() })
        ?? (typeof args.pattern === 'string' && /^([a-z]:|[\\/]|~)/i.test(args.pattern) ? await ownerOfPath(args.pattern.replace(/[*?[{].*$/, ''), { self, search: true, base: folder() }) : undefined)
      if (bot) refuse(bot)
      return
    }
    if (SHELL_TOOLS.includes(name)) {
      const bot = await ownerInText(strings(args).join('\n'), self)
      if (bot) refuse(bot)
      return
    }
    if ((name === 'subagent' || name === 'subagent_fork') && typeof args.cwd === 'string') {
      const bot = await ownerOfPath(args.cwd, { self, search: true, base: folder() })
      if (bot) refuse(bot)
      return
    }
    if (name === 'working_directory' && typeof args.cd === 'string') {
      const bot = await ownerOfPath(args.cd, { self, search: true, base: folder() })
      if (bot) refuse(bot)
      return
    }
    if (SESSION_TOOLS.includes(name)) {
      const asked = strings([args.session_id, args.session_ids, args.parent_session_ids])
      for (const id of asked) {
        const bot = await ownerOfSession(id, self)
        if (bot) refuse(bot)
      }
      // DSH scopes Session search to the caller's cwd. A subagent can have another cwd,
      // so an unfiltered search is closed too; explicit safe ids still narrow it.
      if (name === 'session_search' && args.session_ids === undefined && args.parent_session_ids === undefined) {
        const closedBot = protectedBots().find(found => found.id !== self)
        if (closedBot) throw closed(closedBot, 'Sessions')
      }
    }
  }

  // Before the tools' own hooks, so that a closed call never reaches a card they show.
  ctx.on('tools/execute', async (exec, next) => {
    if (protectedBots().length === 0) return next()
    const self = await callerOf(exec)
    await guardTeam(exec, self)
    await guardFiles(exec, self)
    return next()
  })

  // A folder that a private Bot's folder would overlap, or that overlaps one.
  async function privateClash(path, { except } = {}) {
    const keys = await spellings(path)
    for (const bot of protectedBots()) {
      if (bot.id === except || bot.workDir === undefined) continue
      const dirs = await spellings(bot.workDir)
      if (keys.some(key => dirs.some(dir => overlap(key, dir)))) return bot
    }
    return undefined
  }

  // Checks a change of `private` or of the folder of a Bot before it is written. A
  // private Bot's folder is no other Bot's, no group's and not the team workspace,
  // because DSH cannot be told which files of a shared folder to hide.
  async function checkChange(bot, { flag, moving, workDir }) {
    const makes = flag === undefined ? bot.private === true : flag
    const dir = moving ? workDir : bot.workDir
    if (!makes) {
      const clash = moving && dir !== undefined ? await privateClash(dir, { except: bot.id }) : undefined
      if (clash) throw new Error(`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${bot.name} cannot work there`)
      return
    }
    if (rt.isMain(bot.id)) throw new Error(`${bot.name} is a Main Bot, so it cannot be private`)
    if (dir === undefined) throw new Error(`${bot.name} needs a folder of its own to be private`)
    if (Object.values(state.rooms).some(room => room.members.includes(bot.id))) throw new Error(`${bot.name} is in a group chat, where every member reads what is said. Remove it from its groups first`)
    const clash = await privateClash(dir, { except: bot.id })
    if (clash) throw new Error(`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${bot.name} cannot work there`)
    const keys = await spellings(dir)
    const others = [
      ['the team workspace', teamFolder()],
      ...Object.values(state.bots).filter(other => other.id !== bot.id && other.workDir).map(other => [`the folder of ${other.name}`, other.workDir]),
      ...Object.values(state.rooms).filter(room => room.workDir).map(room => [`the folder of "${room.name}"`, room.workDir]),
    ]
    for (const [what, path] of others) {
      const spelled = await spellings(path)
      if (keys.some(key => spelled.some(other => overlap(key, other)))) throw new Error(`${dir} is in or around ${what}, so ${bot.name} cannot be private there. Give it a folder of its own`)
    }
  }

  const checkNoPrivate = (ids) => {
    const found = ids.map(id => rt.botOf(id)).find(bot => bot?.private === true)
    if (found) throw new Error(`${found.name} is a private Bot and cannot be in a group chat: what is said in a group is read by every member`)
  }

  // Deleting a private Bot keeps its places closed (see roster.js deleteBot); only the
  // user opens them again, one Bot at a time. The files stay where they are.
  async function releaseArchive(id) {
    const kept = state.privateArchives ?? []
    if (!kept.some(entry => entry.id === id)) throw new Error('Nothing kept closed for this Bot')
    state.privateArchives = kept.filter(entry => entry.id !== id)
    await rt.save()
  }

  // What the settings list shows. Session ids stay on the host.
  const archivesView = () => (state.privateArchives ?? []).map(({ id, name, workDir }) => ({ id, name, ...(workDir === undefined ? {} : { workDir }) }))

  Object.assign(rt, { isPrivate, privateClash, checkPrivacyChange: checkChange, checkNoPrivate, releaseArchive, archivesView })
}
