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
  ctx.on('session/event', (session, event) => {
    const botId = rt.chatOwners.get(session.id)
    if (!botId) return
    if (event.type === 'turn/start') turns.set(session.id, { text: '' })
    const turn = turns.get(session.id)
    if (!turn) return
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.kind === 'user' || source?.kind === 'schedule') {
        state.pendingCompletions ??= {}
        state.pendingCompletions[botId] = { id: `task:${session.id}:${event.seq ?? randomUUID()}`, sessionId: session.id }
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
    const pending = state.pendingCompletions?.[botId]
    if (!pending || (turn.internal && !turn.result)) return
    const waiting = Object.values(state.works).some(work => work.from === botId || (work.to === botId && work.open?.length))
    if (!completionReady({ reason: event.data?.reason, text: turn.text, waiting,
      question: state.questions[session.id], view: state.views[session.id], approval: rt.waitsForApproval(session.id) })) return
    delete state.pendingCompletions[botId]
    void completeTask({ ...pending, botId, sessionId: session.id }).catch(error => rt.warn('ds-bot: completion not saved: %s', error))
  })
  Object.assign(rt, { completeTask })
}
