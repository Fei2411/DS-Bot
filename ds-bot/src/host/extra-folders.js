// Extra folders: a Bot, or every member of a group, works in more folders than the one
// its Session was made in. DSH fences workspace-write to that one folder and names extra
// writable folders only for the whole deployment, so when a file tool asks to escalate a
// change that lands in the Session's folder or one of its extra folders, DS Bot answers
// the approval itself. The paths of a shell command cannot be read reliably, so a shell
// command still asks the user.
import { within } from './folders.js'
import { unquote } from './text.js'

// Older DSH releases have no public patch parser; those calls keep the user's approval.
const { parsePatch } = await import('@deepseek-ai/dsh-fs-patch').catch(() => ({}))

export const MAX_EXTRA_DIRS = 8

// The file tools that change files, and how each names what it changes.
const PATH_ARGS = { write: 'file_path', edit: 'file_path' }
// The reason dsh-sandbox gives an escalation, up to the model's justification.
const ESCALATION = 'escalate sandbox to danger-full-access:'

const targetsOf = (name, args) => {
  if (Object.hasOwn(PATH_ARGS, name)) {
    const path = args?.[PATH_ARGS[name]]
    return typeof path === 'string' && path.trim() !== '' ? [path] : []
  }
  if (name === 'apply_patch' && typeof args?.input === 'string' && typeof parsePatch === 'function') {
    // Match DSH's syntax exactly: indented headers can name more files too.
    try {
      return parsePatch(args.input).flatMap(operation => operation.moveTo === undefined ? [operation.path] : [operation.path, operation.moveTo])
    } catch {
      return []
    }
  }
  return []
}

export function install(rt) {
  const { ctx } = rt

  // A group with a folder of its own holds every member to the group's folders; in one
  // without, a member keeps its own extra folders and adds the group's.
  const extraDirsOf = ({ botId, roomId } = {}) => {
    const room = rt.roomOf(roomId)
    const own = room?.workDir !== undefined ? [] : rt.botOf(botId)?.extraDirs ?? []
    return [...new Set([...own, ...(room?.extraDirs ?? [])])]
  }
  // A Bot on a local agent CLI changes files through the CLI, which keeps its own
  // permissions and never asks DSH to escalate, so extra folders do nothing there.
  const onLocalAgent = bot => !['model', undefined].includes(rt.engineOfBot?.(bot))
  // A group's own Session only relays and has none.
  const extraDirsOfSession = (sessionId) => {
    const botId = sessionId === undefined ? undefined : rt.selfOf(sessionId)
    if (botId === undefined || onLocalAgent(rt.botOf(botId))) return []
    return extraDirsOf({ botId, roomId: rt.groupOwners.get(sessionId)?.roomId })
  }

  // Saved as real paths, in the order given, without repeats. The team workspace may be one.
  async function cleanExtraDirs(input) {
    const items = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/) : []
    const paths = []
    for (const item of items) {
      const text = unquote(String(item ?? ''))
      if (text === '') continue
      const team = rt.teamFolder()
      const path = await rt.cleanWorkDir(text) ?? (team === undefined ? undefined : await rt.real(team))
      if (path !== undefined && !paths.includes(path)) paths.push(path)
    }
    if (paths.length > MAX_EXTRA_DIRS) throw new Error(`A Bot or a group can have at most ${MAX_EXTRA_DIRS} extra folders`)
    return paths
  }

  // A Bot that adds folders asks for each new one, as it does for a working folder.
  async function approveExtraDirs(exec, { paths, before = [], sessions, presets, who }) {
    for (const path of paths) {
      if (!before.includes(path)) await rt.approveFolder(exec, { path, sessions, presets, who })
    }
  }

  // The file tool calls that ask for an escalation, while they run, by Session and call.
  const escalating = new Map()
  const callKey = (sessionId, callId) => `${sessionId}\n${callId}`
  ctx.on('tools/execute', async (exec, next) => {
    const sessionId = exec.agent?.session?.id ?? exec.agent?.id
    if (exec.arguments?.sandbox_permissions === undefined || exec.callId === undefined || sessionId === undefined) return next()
    const targets = targetsOf(exec.name, exec.arguments)
    if (targets.length === 0) return next()
    const key = callKey(sessionId, exec.callId)
    escalating.set(key, { targets, session: exec.agent.session })
    try {
      return await next()
    } finally {
      escalating.delete(key)
    }
  })

  // Whether every path the call changes lies in the Session's own folder or in one of its
  // extra folders. Only a Session that may write its own folder writes the others too.
  async function covered(call, sessionId) {
    const extras = extraDirsOfSession(sessionId)
    const policy = ctx.get?.('sandboxPolicy')?.resolve?.({ session: call.session })
    const base = rt.sessionFolder(call.session)
    const fs = ctx.get?.('fs')
    if (extras.length === 0 || policy?.mode !== 'workspace-write' || base === undefined) return false
    if (typeof fs?.resolve !== 'function' || typeof fs.processPath !== 'function' || typeof fs.processPathFromHostPath !== 'function') return false
    const dirs = [policy.workspaceRoot ?? call.session?.header?.cwd, ...extras].filter(Boolean)
    const roots = (await Promise.all(dirs.map(async dir => (await rt.isFolder(dir) ? rt.real(dir) : undefined)))).filter(Boolean)
    for (const target of call.targets) {
      // Resolve as the file tool does, including ~ and physical symlink/.. traversal.
      const path = fs.processPath(await fs.resolve(target, { cwd: base }))
      if (fs.processPathFromHostPath(path) !== path || !roots.some(root => within(path, root)) || await rt.guarded(path)) return false
    }
    return true
  }

  // Ahead of approvals.js, which would show the user a card for it.
  ctx.on('approval/request', async (request, next) => {
    const sessionId = request.agent?.session?.id ?? request.agent?.id
    const call = request.callId === undefined ? undefined : escalating.get(callKey(sessionId, request.callId))
    if (call === undefined || !String(request.reason ?? '').startsWith(ESCALATION)) return next()
    await rt.load()
    return (await covered(call, sessionId)) ? 'allowed-once' : next()
  }, { prepend: true })

  const sectionFor = (sessionId) => {
    const extras = extraDirsOfSession(sessionId)
    if (extras.length === 0) return ''
    const fileTools = typeof parsePatch === 'function' ? 'write, edit or apply_patch' : 'write or edit'
    return [
      '## Your extra folders',
      `Besides your working folder, you also work in ${extras.length === 1 ? 'this folder' : 'these folders'}:`,
      ...extras.map(dir => `- ${dir}`),
      `Use full paths for files there. When the sandbox denies a ${fileTools} there, retry that exact call once with sandbox_permissions "danger-full-access" and a justification: DS Bot approves it for these folders without asking the user. A shell command that changes files there asks the user, so change those files with the file tools. working_directory can take this conversation into one of these folders.`,
      ...(typeof parsePatch === 'function' ? [] : ['This DSH version has no public patch parser, so apply_patch escalations still ask the user.']),
    ].join('\n')
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'bot-extra-folders',
    order: 642,
    interpolate: false,
    text: context => sectionFor(context?.agent?.id),
  }), 'ds-bot: extra folders section')

  Object.assign(rt, { extraDirsOf, extraDirsOfSession, cleanExtraDirs, approveExtraDirs, onLocalAgent })
}
