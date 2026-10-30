import { randomUUID } from 'node:crypto'
import { textOf } from './text.js'

export function completionReady({ reason, text, waiting, question, view, approval }) {
  return reason?.kind === 'completed' && text.trim() !== '' && !waiting && !question && !view && !approval
}

export function install(rt) {
  const { ctx, state } = rt
  const turns = new Map()
  const completeTask = async ({ id = randomUUID(), botId, sessionId, kind = 'task' }) => {
    if (!rt.botOf(botId) || state.completions.some(entry => entry.id === id)) return
    const entry = { id, botId, sessionId, kind, time: Date.now() }
    state.completions.push(entry)
    state.completions = state.completions.slice(-500)
    await rt.save({ required: true })
    // 原生通知走 Host IPC，因此关闭或重建渲染窗口也不丢完成事件。
    if (process.env.DS_BOT_APP === '1' && process.connected && process.send && rt.botOf(botId).notifyCompletion !== false) {
      process.send({ type: 'ds-bot:completion', ...entry, name: rt.botOf(botId).name })
    }
  }
  // 桌面端注意力通知：卡片在等用户、或用户的任务失败。与完成通知同走 Host IPC，但不持久化，
  // 也不受 notifyCompletion 约束——那个开关只管完成，不管"需要你"。
  const attentionNotify = ({ kind, id, botId, sessionId, roomId }) => {
    if (process.env.DS_BOT_APP !== '1' || !process.connected || typeof process.send !== 'function') return
    const bot = rt.botOf(botId)
    if (!bot) return
    process.send({ type: 'ds-bot:attention', kind, id, botId, sessionId, ...(roomId ? { roomId } : {}), name: bot.name })
  }
  ctx.on('session/event', (session, event) => {
    const botId = rt.chatOwners.get(session.id)
    if (!botId) return
    if (event.type === 'turn/start') turns.set(session.id, { text: '', turn: event.data.turn })
    const turn = turns.get(session.id)
    if (!turn) return
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.kind === 'user' || source?.kind === 'schedule') {
        state.pendingCompletions ??= {}
        state.pendingCompletions[botId] = { id: `task:${session.id}:${event.seq ?? randomUUID()}`, sessionId: session.id }
        // 失败提醒只看本回合：回合由用户或定时器发起才提醒，不依赖跨回合的 pending——
        // 那会在上一回合刚报过完成时漏掉这一回合的失败。
        turn.user = true
      }
      if (source?.role === 'reply' || source?.role === 'report') turn.result = true
      else if (source?.kind === 'bot' && source?.handoff !== true && source?.role !== 'resume') turn.internal = true
    }
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (!content?.some(block => block.type === 'tool-call')) turn.text = textOf(content)
    }
    if (event.type !== 'turn/end') return
    turns.delete(session.id)
    if (event.data?.reason?.kind === 'error') {
      if (turn.user && !turn.internal) {
        attentionNotify({ kind: 'failure', id: `fail:${session.id}:${turn.turn}`, botId, sessionId: session.id })
      }
      return
    }
    const pending = state.pendingCompletions?.[botId]
    if (!pending || (turn.internal && !turn.result)) return
    // 密钥卡在等用户时不算完成：和问题卡、视图、审批一样，回合并没把事办完。
    const secretWaiting = Object.values(state.secretRequests ?? {})
      .some(list => list.some(request => request.status === 'pending' && request.sessionId === session.id))
    const waiting = Object.values(state.works).some(work => work.from === botId || (work.to === botId && work.open?.length)) || secretWaiting
    if (!completionReady({ reason: event.data?.reason, text: turn.text, waiting,
      question: state.questions[session.id], view: state.views[session.id], approval: rt.waitsForApproval(session.id) })) return
    delete state.pendingCompletions[botId]
    void completeTask({ ...pending, botId, sessionId: session.id }).catch(error => rt.warn('ds-bot: completion not saved: %s', error))
  })
  Object.assign(rt, { completeTask, attentionNotify })
}
