import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'
import { requestOf } from './schedules.js'
import { splitRef } from './text.js'

const RUN_MS = 5 * 60_000
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export function monitorDecision(task, args) {
  if (!['no_change', 'match', 'failed'].includes(args.status)) throw invalid('Choose no_change, match or failed')
  if (args.status === 'failed') return { status: 'failed', error: String(args.error || 'The source could not be checked').slice(0, 2000) }
  if (!Array.isArray(args.items) || args.items.length > 200) throw invalid('Submit the checked items, at most 200 per check')
  const items = args.items.map(item => {
    if (typeof item?.id !== 'string' || !item.id.trim() || item.id.length > 1000) throw invalid('Every item needs a stable source message id')
    if (typeof item.text !== 'string' || item.text.length > 20_000) throw invalid('Every item needs text of at most 20000 characters')
    if (typeof item.matched !== 'boolean' || (item.matched && !item.text.trim())) throw invalid('Every item needs a matching decision and matching messages need readable text')
    return { id: item.id, text: item.text, matched: item.matched }
  })
  if (new Set(items.map(item => item.id)).size !== items.length) throw invalid('Duplicate source ids in one check')
  const seen = new Set(task.seen ?? [])
  const matches = task.baselined ? items.filter(item => item.matched && !seen.has(item.id)) : []
  if (args.status === 'no_change' && matches.length > 0) throw invalid('New matching items must be submitted as match')
  return { status: task.baselined ? matches.length ? 'match' : 'no_change' : 'baseline', items, matches }
}

export function install(rt) {
  const { ctx, state } = rt
  const running = new Map()
  const taskOf = sessionId => rt.automationOwners.get(sessionId)
  const tasksOf = botId => Object.values(state.automations).filter(task => task.botId === botId)
  const writable = () => {
    const reason = rt.readOnly()
    if (reason) throw new Error(reason)
  }
  const persist = () => rt.save({ required: true })

  async function createMonitor(body, { returnTask = false, scheduleRequest, previous } = {}) {
    writable()
    const service = rt.scheduleService()
    if (!service) throw invalid('Automation tasks are off in DSH')
    const bot = rt.botOf(body.target)
    if (!bot || rt.deletingBots?.has(bot.id)) throw invalid('Choose an available Bot for the monitor')
    const title = String(body.title ?? '').trim()
    const prompt = String(body.prompt ?? '').trim()
    if (!title || title.length > 120 || !prompt) throw invalid('Give the task a name and an instruction')
    const selector = scheduleRequest ?? rt.scheduleSelector(body.when)
    const id = randomUUID()
    const sessionId = await rt.createSession(`${bot.name} · ${title}`, { dir: rt.workDirOf({ botId: bot.id }) })
    const task = { id, botId: bot.id, sessionId, title, prompt, seen: [], runs: [], createdAt: Date.now() }
    if (previous) Object.assign(task, { seen: [...previous.seen], baselined: previous.baselined,
      runs: [...previous.runs], transferredFrom: previous.id })
    state.automations[id] = task
    try {
      await persist()
      const agent = await rt.resolveAgent(sessionId)
      const model = await rt.desiredModel(bot)
      if (model) await rt.selectSessionModel(sessionId, { ...splitRef(model), reasoningEffort: await rt.desiredEffort(bot, model) })
      await rt.applyPermission(bot, sessionId)
      await rt.ensureCapabilities(sessionId)
      // 建立所有权后重新解析，才会安装 Bot 的会话级工具。
      rt.hideBotUnusedTools(agent)
      const record = await service.create(sessionId, { title, prompt, ...selector })
      task.scheduleId = record.id
      await persist()
    } catch (error) {
      if (task.scheduleId) await service.delete({ sessionId, id: task.scheduleId }).catch(() => {})
      delete state.automations[id]
      await rt.save().catch(() => {})
      await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
      throw error
    }
    return returnTask ? task : rt.schedulesView()
  }

  async function dropMonitor(sessionId) {
    const task = taskOf(sessionId)
    if (!task) return
    const active = running.get(sessionId)
    if (active) { clearTimeout(active.timer); active.agent?.cancel({ kind: 'user' }); running.delete(sessionId) }
    if (!rt.deletionArchived?.has(sessionId)) await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
    task.disabled = true
    await persist()
  }

  async function report(args, exec) {
    writable()
    const task = taskOf(exec.agent?.id)
    const run = running.get(exec.agent?.id)
    if (!task || task.disabled || !run || run.report) throw invalid('Report once during an active monitor check')
    const decision = monitorDecision(task, args)
    // 在 turn/end 成功前不推进基线，也不向聊天发布。
    run.report = decision
    return 'Check recorded. End this turn. Only new matching items are published by DS Bot.'
  }

  async function finish(task, run, reason) {
    if (task.disabled || !state.automations[task.id] || rt.deletingBots?.has(task.botId)) return
    const decision = reason?.kind === 'completed' && run.report
      ? run.report : { status: 'failed', error: run.timedOut ? 'Check timed out' : 'Check ended without a successful structured result' }
    const record = { id: run.id, at: run.at, endedAt: Date.now(), status: decision.status, sessionId: task.sessionId, turn: run.turn,
      ...(decision.error ? { error: rt.redactSecrets(decision.error) } : {}) }
    if (decision.items) {
      // 不淘汰已见 id；淘汰会让旧消息重新变成“新消息”。
      task.seen = [...new Set([...task.seen, ...decision.items.map(item => item.id)])]
      task.baselined = true
    }
    if (decision.matches?.length) {
      const sessionId = rt.chatOf(task.botId)
      let anchorTurn = null
      try {
        for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(10_000))) {
          if (event.type === 'turn/end') { anchorTurn = event.data.turn ?? null; break }
        }
      } catch (error) { rt.warn('ds-bot: monitor chat anchor not read: %s', error) }
      // 转换或删除可能发生在读取锚点期间：任务已不属于任何监视时不要再发布。
      if (task.disabled || !state.automations[task.id]) return
      state.monitorResults.push({ id: run.id, botId: task.botId, taskId: task.id, title: task.title, time: record.endedAt,
        sessionId, anchorTurn, text: rt.redactSecrets(decision.matches.map(item => item.text).join('\n\n')), itemIds: decision.matches.map(item => item.id) })
    }
    task.runs.push(record)
    await persist()
    if (decision.matches?.length) await rt.completeTask?.({ id: `monitor:${run.id}`, botId: task.botId, sessionId: rt.chatOf(task.botId), kind: 'monitor' })
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'bot-monitor', order: 650, interpolate: false,
    text: context => {
      const task = taskOf(context?.agent?.id)
      return task ? [
        '## Background monitor check', task.prompt,
        'Read the source with your tools, then call report_monitor once and end your turn. Your ordinary replies stay in this check\'s run log and are never posted to chat; only report_monitor reaches the user.',
        'Submit the checked items with stable source message ids, exact useful text, and whether each matches the user condition. Never invent ids or infer that a failed query means no changes.',
        task.baselined ? 'Report only newly observed matches. Previously seen source ids remain known by DS Bot.' : 'This is the first successful check: establish a baseline of existing messages; do not announce existing matches.',
        'Use status failed with the reason when the source is unavailable or has no reliable message identities. Do not message other Bots or post to a group.',
      ].join('\n') : ''
    },
  }), 'ds-bot: monitor prompt')

  ctx.tools.register(defineTool({ name: 'report_monitor', description: 'Finish a background monitor check. Ordinary chat cannot call this.',
    parameters: { status: { type: 'string', required: true, enum: ['no_change', 'match', 'failed'] },
      items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, text: { type: 'string', required: true }, matched: { type: 'boolean', required: true } } } },
      error: { type: 'string' } }, output, execute: report }))
  ctx.tools.register(defineTool({ name: 'create_automation', description: 'Create a normal scheduled task or a silent monitor for yourself. Use mode monitor when the user wants notification only about new matching messages. The first successful check establishes a baseline.',
    parameters: { title: { type: 'string', required: true }, prompt: { type: 'string', required: true }, mode: { type: 'string', enum: ['normal', 'monitor'], required: true },
      when: { type: 'object', additionalProperties: false, required: true, properties: { kind: { type: 'string', required: true, enum: ['at', 'daily', 'weekly', 'every'] }, at: { type: 'string' }, time: { type: 'string' }, timeZone: { type: 'string' }, minutes: { type: 'number' }, weekdays: { type: 'array', items: { type: 'number' } } } } }, output,
    async execute(args, exec) {
      await rt.load()
      const botId = rt.selfOf(exec.agent?.id)
      if (!botId || taskOf(exec.agent?.id)) throw invalid('Only a Bot chat can create automation tasks')
      await rt.scheduleEndpoint('schedule-create', { ...args, target: rt.groupOwners.get(exec.agent.id)?.roomId ?? botId })
      return 'Automation created. Monitoring continues while this Host is running.'
    } }))

  ctx.on('agent/pre-step', async (payload, next) => {
    const task = taskOf(payload.agent.id)
    if (!task) return next()
    if (task.disabled || rt.deletingBots?.has(task.botId)) return { kind: 'reject' }
    for (const message of [...(payload.agent.inbox?.nextTurn ?? []), ...(payload.agent.inbox?.nextStep ?? [])]) {
      if (message.source?.kind === 'schedule') payload.agent.inbox.remove(message.id)
    }
    const bot = rt.botOf(task.botId)
    await rt.applyPermission(bot, task.sessionId)
    await rt.ensureCapabilities(task.sessionId)
    const model = await rt.desiredModel(bot)
    const route = payload.agent.session.requestHeader?.()?.config
    const effort = model ? await rt.desiredEffort(bot, model) : undefined
    if (model && (`${route?.provider}/${route?.model}` !== model || route?.reasoningEffort !== effort)) {
      await rt.selectSessionModel(task.sessionId, { ...splitRef(model), ...(effort ? { reasoningEffort: effort } : {}) })
    }
    const folder = rt.workDirOf({ botId: bot.id }) ?? rt.teamFolder()
    const directories = ctx.get?.('workingDirectory')
    if (folder && directories?.get?.(payload.agent.session) !== folder && directories?.set) await directories.set(payload.agent, folder, payload.signal)
    return next()
  }, { prepend: true })
  ctx.on('tools/execute', (exec, next) => {
    if (rt.deletingBots?.has(rt.selfOf(exec.agent?.id))) throw invalid('This Bot is being deleted')
    if (taskOf(exec.agent?.id) && ['message_bot', 'post_to_group', 'create_bot', 'create_group', 'ask_user', 'show_view', 'create_automation', 'schedule_create', 'schedule_update', 'schedule_delete'].includes(exec.name)) throw invalid('A monitor publishes only through report_monitor')
    return next()
  })
  ctx.on('session/event', (session, event) => {
    const task = taskOf(session.id)
    if (!task || task.disabled) return
    if (event.type === 'turn/start') {
      const run = { id: randomUUID(), at: Date.now(), turn: event.data.turn }
      running.set(session.id, run)
      run.timer = setTimeout(() => {
        run.timedOut = true
        void rt.resolveAgent(session.id).then(agent => agent.cancel({ kind: 'user' })).catch(() => {})
      }, rt.config.monitorTimeoutMs ?? RUN_MS)
      run.timer.unref?.()
      task.interrupted = { ...run, timer: undefined }
      void rt.save().catch(() => {})
    } else if (event.type === 'turn/end') {
      const run = running.get(session.id)
      if (!run) return
      clearTimeout(run.timer)
      running.delete(session.id)
      delete task.interrupted
      void finish(task, run, event.data.reason).catch(error => rt.warn('ds-bot: monitor result not saved: %s', error))
    }
  })
  ctx.on('agent/created', async ({ agent }) => {
    await rt.load()
    const task = taskOf(agent.id)
    if (!task) return
    if (task.interrupted) {
      task.runs.push({ ...task.interrupted, status: 'failed', error: 'Host restarted before the check completed', endedAt: Date.now() })
      delete task.interrupted
      await persist()
    }
  })
  ctx.effect(() => () => { for (const run of running.values()) clearTimeout(run.timer) }, 'ds-bot: monitor timers')
  // The timing of an existing task, in the shape createMonitor and schedule-create take.
  const whenOf = entry => entry.kind === 'every' ? { kind: 'every', minutes: entry.everySeconds / 60 }
    : entry.kind === 'at' || entry.kind === 'after' ? { kind: 'at', at: entry.scheduledAt }
      : { kind: entry.kind, time: entry.time?.slice(0, 5), timeZone: entry.timeZone, weekdays: entry.weekdays }

  Object.assign(rt, { createMonitor, dropMonitor, monitorTasksOf: tasksOf,
    async monitorRuns(id) {
      const task = rt.own(state.automations, id)
      if (!task) throw invalid('Unknown monitor')
      return task.runs
    },
    async monitorRunLog(id, runId) {
      const task = rt.own(state.automations, id)
      const run = task?.runs.find(entry => entry.id === runId)
      if (!run) throw invalid('Unknown monitor run')
      const events = []
      for await (const event of rt.eventsBackwards(run.sessionId, AbortSignal.timeout(10_000))) {
        if (event.data?.turn === run.turn || (event.time >= run.at && event.time <= run.endedAt)) events.push(event)
        if (event.time < run.at || events.length >= 200) break
      }
      return rt.redactSecrets(JSON.stringify(events.reverse(), null, 2))
    },
    async convertMonitor(body) {
      const entry = (await rt.schedulesView()).tasks.find(task => task.id === body.id && task.sessionId === body.sessionId)
      if (!entry || entry.mode === 'monitor' || !entry.botId || entry.roomId) throw invalid('Choose a normal Bot task')
      const request = requestOf(entry)
      if (!request || entry.status !== 'active') throw invalid('Only active tasks can be converted')
      const monitor = await createMonitor({ target: entry.botId, title: entry.title, prompt: entry.prompt, when: whenOf(entry) }, { returnTask: true })
      try {
        await rt.scheduleService().delete({ sessionId: entry.sessionId, id: entry.id })
      } catch (error) {
        try {
          await rt.scheduleService().delete({ sessionId: monitor.sessionId, id: monitor.scheduleId })
          await dropMonitor(monitor.sessionId)
        } catch (cleanup) {
          throw invalid(`Conversion failed: ${error.message}. The new monitor could not be removed: ${cleanup.message}. Inspect both task lists before retrying.`)
        }
        throw error
      }
      return rt.schedulesView()
    },
    // 监视转回普通任务：先在 Bot 聊天建好新任务，再移除监视任务和它的独立会话。
    // 基线、已见 id 和运行记录不随转换保留，历史命中卡片留在聊天里。
    async convertNormal(body) {
      writable()
      const service = rt.scheduleService()
      if (!service) throw invalid('Automation tasks are off in DSH')
      const entry = (await rt.schedulesView()).tasks.find(task => task.id === body.id && task.sessionId === body.sessionId)
      if (!entry || entry.mode !== 'monitor' || !entry.botId || entry.roomId) throw invalid('Choose a silent monitor')
      const request = requestOf(entry)
      if (!request || entry.status !== 'active') throw invalid('Only active tasks can be converted')
      const bot = rt.botOf(entry.botId)
      const task = taskOf(entry.sessionId)
      if (!bot || !task || rt.deletingBots?.has(bot.id)) throw invalid('Choose an available Bot for the task')
      const chat = rt.chatOf(bot.id)
      const record = await service.create(chat, { title: entry.title, prompt: entry.prompt, ...rt.scheduleSelector(whenOf(entry)) })
      try {
        await service.delete({ sessionId: entry.sessionId, id: entry.id })
      } catch (error) {
        try {
          await service.delete({ sessionId: chat, id: record.id })
        } catch (cleanup) {
          throw invalid(`Conversion failed: ${error.message}. The new task could not be removed: ${cleanup.message}. Inspect both task lists before retrying.`)
        }
        throw error
      }
      delete state.automations[task.id]
      task.disabled = true
      rt.indexSessions()
      await persist()
      if (!rt.deletionArchived?.has(entry.sessionId)) {
        try { await ctx.workspaceRegistry.archiveSession(entry.sessionId, { stopActivity: true }) } catch (error) { rt.warn('ds-bot: monitor session not archived: %s', error) }
      }
      return rt.schedulesView()
    },
    async removeBotMonitors(botId) {
      for (const task of tasksOf(botId)) if (!task.disabled) await dropMonitor(task.sessionId)
    },
  })
}
