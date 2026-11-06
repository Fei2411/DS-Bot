// Approvals. A member's group Session is hidden, so DSH's approval card never shows
// there and the turn would wait forever: DS Bot answers those requests itself, from
// the group chat. A Bot's own chat keeps DSH's card, but DS Bot can answer those too
// (IM chats, the phone app): the request is raced — whichever side answers first wins,
// and the other card withdraws.
import { randomUUID } from 'node:crypto'

const OUTCOMES = { allow: 'allowed-once', reject: 'rejected' }

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, {id:string, sessionId:string, botId:string, roomId?:string, tool:string, reason:string, detail:{text?:string, code?:string}, at:number, answer?:(outcome:string)=>void}>} */
  const pending = new Map()
  const approvalListeners = new Set()
  const onApproval = (listener) => {
    approvalListeners.add(listener)
    return () => approvalListeners.delete(listener)
  }
  const emit = (kind, data) => {
    for (const listener of approvalListeners) {
      try { listener(kind, data) } catch (error) { rt.warn('ds-bot: approval listener failed: %s', error) }
    }
  }

  // Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
  ctx.on('approval/request', (request, next) => {
    const sessionId = request.agent?.session?.id ?? request.agent?.id
    const owner = sessionId === undefined ? undefined : rt.groupOwners.get(sessionId)
    const botId = owner?.botId ?? (sessionId === undefined ? undefined : rt.chatOwners.get(sessionId))
    if (botId === undefined) return next()
    const id = randomUUID()
    const entry = {
      id,
      sessionId,
      botId,
      ...(owner ? { roomId: owner.roomId } : {}),
      tool: String(request.toolName ?? ''),
      reason: String(request.reason ?? '').slice(0, 500),
      detail: rt.callDetail?.(sessionId, request.callId) ?? {},
      at: Date.now(),
    }
    pending.set(id, entry)
    rt.noteApproval?.(sessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) })
    rt.approvalWaiting?.(entry)
    emit('open', { ...entry, answerable: true })
    const settle = (outcome) => {
      if (!pending.has(id)) return false
      pending.delete(id)
      rt.noteApproval?.(sessionId, undefined)
      emit('settled', { id, outcome })
      return true
    }
    if (owner === undefined) {
      // An own-chat approval races DSH's card. The card sees `linked`, our own
      // AbortSignal: answering here resolves the request, then withdraws the card;
      // an answer there settles `next()` first and is adopted. An abort of the
      // original signal cancels either way.
      const original = request.signal
      const linked = new AbortController()
      request.signal = linked.signal
      return new Promise((resolve, reject) => {
        const complete = (outcome) => {
          if (!settle(outcome)) return
          resolve(outcome)
          linked.abort()
          if (request.signal === linked.signal) request.signal = original
        }
        entry.answer = complete
        if (original?.aborted) entry.answer('cancelled')
        else original?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
        Promise.resolve(next()).then(
          (outcome) => {
            if (!pending.has(id)) return
            complete(outcome)
          },
          // DSH's answerer threw: close the entry and give the caller the error
          // the way the pre-race code did, instead of hanging forever.
          (error) => {
            if (!settle('cancelled')) return
            reject(error)
            linked.abort()
            if (request.signal === linked.signal) request.signal = original
          },
        )
      })
    }
    rt.yieldRoomTurn?.(sessionId)
    return new Promise((resolve) => {
      entry.answer = (outcome) => {
        if (!settle(outcome)) return
        resolve(outcome)
      }
      if (request.signal?.aborted) entry.answer('cancelled')
      request.signal?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
    })
  }, { prepend: true })

  const approvalsView = () => [...pending.values()].map(({ answer, ...entry }) => ({ ...entry, answerable: answer !== undefined }))
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId)

  function answerApproval(id, choice) {
    const entry = pending.get(String(id ?? ''))
    if (entry?.answer === undefined) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    const outcome = OUTCOMES[choice]
    if (outcome === undefined) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    entry.answer(outcome)
  }

  // A group Session that leaves its group has no card left to answer from.
  const cancelApprovals = (sessionId) => {
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId) entry.answer?.('cancelled')
    }
  }

  Object.assign(rt, { approvalsView, waitsForApproval, answerApproval, cancelApprovals, onApproval })
}
