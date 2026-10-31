import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { requestOf } from './schedules.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const inside = (root, path) => { const sub = relative(root, path); return sub !== '' && !sub.startsWith('..') && !isAbsolute(sub) }

export async function fileStamp(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 64 * 1024 * 1024) return null
  const canonical = await realpath(path)
  return { path: canonical, bytes: info.size, fileId: `${info.dev}:${info.ino}:${info.birthtimeMs}`, hash: hash(await readFile(path)) }
}

export function install(rt) {
  const { ctx, state } = rt
  const previews = new Map()
  const deletingBots = new Set()
  const deletionArchived = new Set()
  const versions = new Map()
  const sessionsOf = bot => [...new Set([bot.id, rt.chatOf(bot.id), ...(bot.segments ?? []).map(part => part.sessionId), ...rt.groupSessionsOf(bot.id), ...rt.monitorTasksOf(bot.id).map(task => task.sessionId)])]
  const progressOf = id => state.deletionJobs[id] ??= { tasks: {}, files: {}, history: [] }

  ctx.on('session/event', (session) => {
    if (rt.selfOf(session.id)) versions.set(session.id, (versions.get(session.id) ?? 0) + 1)
  })

  ctx.on('tools/execute', async (exec, next) => {
    const botId = rt.selfOf(exec.agent?.id)
    if (!botId) return next()
    if (deletingBots.has(botId)) throw invalid('This Bot is being deleted')
    const input = exec.arguments?.file_path ?? exec.arguments?.path
    if (!['write', 'edit', 'read', 'read_image', 'str_replace_editor'].includes(exec.name) || typeof input !== 'string') return next()
    const base = rt.sessionFolder(exec.agent?.session)
    if (!base) return next()
    const path = resolve(base, input)
    let absent = false
    let before
    try { before = await fileStamp(path) } catch (error) { if (error.code === 'ENOENT') absent = true }
    const result = await next()
    if (result?.isError) return result
    let stamp
    try { stamp = await fileStamp(path) } catch { return result }
    if (!stamp) return result
    const key = hash(stamp.path)
    const entry = rt.own(state.artifacts, key) ?? { id: key, path: stamp.path, bots: [], createdBy: null }
    if (!entry.bots.includes(botId)) entry.bots.push(botId)
    const writes = ['write', 'edit', 'str_replace_editor'].includes(exec.name)
    // 只认明确工具执行前不存在、执行后出现的普通文件，shell 和链接不猜归属。
    if (absent && writes && !entry.hash) entry.createdBy = botId
    if (entry.createdBy === botId && (writes || !entry.hash)) Object.assign(entry, stamp)
    else if (before && entry.hash && before.hash !== stamp.hash) entry.changed = true
    state.artifacts[key] = entry
    await rt.save()
    return result
  })

  async function snapshot(id) {
    const bot = rt.botOf(id)
    if (!bot) throw invalid('Unknown Bot')
    if (rt.isMain(id)) throw invalid('Remove the Main Bot role before deleting this Bot')
    const sessions = sessionsOf(bot)
    const tasks = (await rt.schedulesView()).tasks.filter(task => sessions.includes(task.sessionId))
    const files = []
    for (const entry of Object.values(state.artifacts).filter(item => item.bots.includes(id))) {
      let stamp = null
      try { stamp = await fileStamp(entry.path) } catch {}
      const root = bot.workDir ?? rt.teamFolder()
      const safeRoot = root ? await realpath(root).catch(() => null) : null
      const data = stamp && await rt.inData(stamp.path)
      const sharedFolder = stamp && Object.values(state.bots).some(other => other.id !== id && other.workDir && inside(other.workDir, stamp.path))
      const cleanable = Boolean(stamp && safeRoot && inside(safeRoot, stamp.path) && !data && !sharedFolder
        && entry.createdBy === id && entry.bots.length === 1 && !entry.changed && entry.hash === stamp.hash && entry.fileId === stamp.fileId && entry.path === stamp.path)
      files.push({ id: entry.id, path: entry.path, bytes: stamp?.bytes ?? null, fileId: stamp?.fileId ?? null, hash: stamp?.hash ?? null, cleanable,
        reason: cleanable ? 'Verified new file' : 'Shared, modified, missing or unverified file — kept' })
    }
    return { bot: { id, name: bot.name, private: bot.private === true, workDir: bot.workDir ?? rt.teamFolder(), permission: bot.permission ?? null },
      configuration: hash(JSON.stringify(bot)), activity: sessions.map(sessionId => [sessionId, versions.get(sessionId) ?? 0]),
      targets: Object.values(state.bots).filter(other => other.id !== id && !deletingBots.has(other.id))
        .map(other => ({ id: other.id, name: other.name, workDir: other.workDir ?? rt.teamFolder(), permission: other.permission ?? null, private: other.private === true })),
      tasks, files, sessions, groups: Object.values(state.rooms).filter(room => room.members.includes(id)).map(room => ({ id: room.id, name: room.name, admin: room.admin === id })),
      monitors: rt.monitorTasksOf(id).map(task => ({ id: task.id, scheduleId: task.scheduleId, baselined: task.baselined, seen: task.seen })),
      chats: 'archived', memory: 'archived', browser: 'deleted', sharedSecrets: 'kept' }
  }
  const fingerprint = value => hash(JSON.stringify(value))

  async function preview(id) {
    const view = await snapshot(id)
    const token = randomUUID()
    previews.set(token, { id, fingerprint: fingerprint(view), until: Date.now() + 10 * 60_000 })
    for (const [key, entry] of previews) if (entry.until < Date.now()) previews.delete(key)
    return { ...view, token, progress: state.deletionJobs[id] ?? null }
  }

  async function recycle(file, job) {
    const previous = job.files[file.id]
    if (previous?.status === 'recycled' || previous?.status === 'restored') return
    if (previous?.status === 'pending') {
      const saved = await fileStamp(previous.destination).catch(() => null)
      const source = await fileStamp(previous.original).catch(() => null)
      if (saved?.hash === previous.hash && !source) {
        previous.status = 'recycled'
        await rt.save({ required: true })
        return
      }
      if (saved && (!source || source.hash !== saved.hash)) throw invalid('An interrupted file cleanup needs inspection before retrying')
    }
    const current = await fileStamp(file.path)
    if (!current || current.path !== file.path || current.hash !== file.hash || current.fileId !== file.fileId) throw invalid('A file changed; refresh the deletion preview')
    const folder = join(rt.home, 'recycle', file.id)
    await mkdir(folder, { recursive: true })
    const destination = join(folder, randomUUID())
    job.files[file.id] = { original: file.path, destination, hash: file.hash, status: 'pending' }
    await rt.save({ required: true })
    try {
      await rename(file.path, destination)
    } catch (error) {
      if (error.code !== 'EXDEV') throw error
      await copyFile(file.path, destination, constants.COPYFILE_EXCL)
      const copied = await fileStamp(destination)
      const source = await fileStamp(file.path)
      if (copied?.hash !== file.hash || source?.hash !== file.hash || source?.fileId !== file.fileId) throw invalid('A file changed during recycling; its original was kept')
      await unlink(file.path)
    }
    job.files[file.id].status = 'recycled'
    await rt.save({ required: true })
  }

  async function execute(body) {
    const id = String(body.id ?? '')
    if (deletingBots.has(id)) throw invalid('This Bot is already being deleted')
    const approved = previews.get(body.token)
    if (!approved || approved.id !== id || approved.until < Date.now()) throw invalid('Refresh the deletion preview before confirming')
    if (!['delete', 'transfer'].includes(body.tasks)) throw invalid('Choose whether to delete or transfer automation tasks')
    const files = Array.isArray(body.files) ? [...new Set(body.files)] : []
    deletingBots.add(id)
    try {
      const view = await snapshot(id)
      if (fingerprint(view) !== approved.fingerprint) throw invalid('Resources changed; refresh the deletion preview')
      if (files.some(key => !view.files.some(file => file.id === key && file.cleanable))) throw invalid('Only verified new files from this preview can be recycled')
      const target = body.tasks === 'transfer' ? rt.botOf(body.target) : undefined
      if (body.tasks === 'transfer' && (!target || target.id === id || deletingBots.has(target.id))) throw invalid('Choose another Bot to receive the tasks')
      const job = progressOf(id)
      const service = rt.scheduleService()
      for (const task of view.tasks) {
        const key = `${task.sessionId}:${task.id}`
        const done = job.tasks[key]
        if (done?.status === 'done') continue
        if (done?.status === 'creating') throw invalid('A previous transfer has an unknown outcome; inspect the task lists before retrying')
        const records = done?.records ?? []
        if (!done && typeof service?.history === 'function') {
          let before
          const cursors = new Set()
          do {
            const page = await service.history({ sessionId: task.sessionId, id: task.id, limit: 100, ...(before ? { before } : {}) })
            if (!Array.isArray(page.records)) throw invalid('Task history could not be saved; refresh before deleting')
            records.push(...page.records)
            before = page.nextBefore
            if (before && cursors.has(before)) throw invalid('Task history cursor did not advance')
            cursors.add(before)
          } while (before)
        }
        if (done?.status === 'copied') {
          if (target?.id !== done.to) throw invalid('Finish the previous transfer to the same Bot before changing the target')
          await service.delete({ sessionId: task.sessionId, id: task.id })
          const monitor = rt.automationOwners.get(task.sessionId)
          if (monitor) monitor.disabled = true
          done.status = 'done'
        } else if (target && task.status === 'active') {
          const monitor = rt.automationOwners.get(task.sessionId)
          if (monitor?.interrupted) throw invalid('A monitor is running; stop it before transferring and refresh')
          const request = requestOf(task)
          if (!request) throw invalid('This task rule cannot be transferred')
          job.tasks[key] = { status: 'creating', to: target.id, original: task, records }
          await rt.save({ required: true })
          const copied = monitor
            ? await rt.createMonitor({ target: target.id, title: task.title, prompt: task.prompt }, { returnTask: true, scheduleRequest: request, previous: monitor })
            : await service.create(rt.chatOf(target.id), request)
          job.tasks[key] = { status: 'copied', to: target.id, newId: copied.scheduleId ?? copied.id, next: copied.scheduledAt, original: task, records }
          await rt.save({ required: true })
          await service.delete({ sessionId: task.sessionId, id: task.id })
          if (monitor) monitor.disabled = true
          job.tasks[key].status = 'done'
        } else {
          await service.delete({ sessionId: task.sessionId, id: task.id })
          job.tasks[key] = { status: 'done', action: 'deleted', original: task, records }
        }
        await rt.save({ required: true })
      }
      await rt.releaseBot(id, view.sessions)
      job.archived ??= []
      for (const sessionId of view.sessions) {
        const monitor = rt.automationOwners.get(sessionId)
        if (monitor && monitor.botId !== id) continue
        if (!job.archived.includes(sessionId)) {
          // A Bot that never ran has no stored Session; that is not a reason to stop the deletion.
          await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
            .catch(error => rt.warn('ds-bot: %s not archived while deleting %s: %s', sessionId, id, error?.message ?? error))
          job.archived.push(sessionId)
          await rt.save({ required: true })
        }
        deletionArchived.add(sessionId)
      }
      for (const file of view.files.filter(file => files.includes(file.id))) await recycle(file, job)
      await rt.deleteBot(id)
      job.finished = true
      job.history.push({ at: Date.now(), bot: view.bot, groups: view.groups })
      await rt.save({ required: true })
      previews.delete(body.token)
      return { deleted: true, progress: job }
    } catch (error) {
      const job = state.deletionJobs[id]
      if (job) { job.error = rt.redactSecrets?.(String(error.message)) ?? String(error.message); await rt.save().catch(() => {}) }
      throw error
    } finally { deletingBots.delete(id) }
  }

  async function restore(body) {
    const job = rt.own(state.deletionJobs, body.botId)
    const file = job && rt.own(job.files, body.fileId)
    if (!file || file.status !== 'recycled') throw invalid('No recycled file to restore')
    const saved = await fileStamp(file.destination)
    if (saved?.hash !== file.hash) throw invalid('The recycled file changed')
    if (await realpath(dirname(file.original)) !== dirname(file.original)) throw invalid('The original folder changed; inspect it before restoring')
    // EXCL 保证恢复不会覆盖用户后来创建的同名文件。
    await copyFile(file.destination, file.original, constants.COPYFILE_EXCL)
    file.status = 'restored'
    await rt.save({ required: true })
    return { restored: true, path: file.original }
  }

  ctx.on('agent/pre-step', (payload, next) => deletingBots.has(rt.selfOf(payload.agent.id)) ? { kind: 'reject' } : next(), { prepend: true })
  Object.assign(rt, { deletingBots, deletionArchived, deletionPreview: preview, deletionExecute: execute, restoreArtifact: restore })
}
