// Non-interrupting mid-work updates: a correction belongs to an open work or group
// assignment, not to whichever Session its worker happens to have open. Stored durably
// in `coordination.sqlite` (`scope = 'work'`) and injected at the worker's next step
// boundary without cancelling running commands or starting a duplicate work.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SOURCE_KIND } from './constants.js'

export function workNotes(rt) {
  const MAX_OBSERVED = 500
  const observedIds = new Set()
  const confirmingIds = new Set()
  const rememberObserved = (id) => {
    observedIds.add(id)
    if (observedIds.size > MAX_OBSERVED) observedIds.delete(observedIds.values().next().value)
  }

  const listNotes = (workId, work) => {
    const dbNotes = rt.coordination?.listWorkNotes?.(workId) ?? []
    const legacyNotes = Array.isArray(work?.pendingNotes) ? work.pendingNotes : []
    if (legacyNotes.length === 0) return dbNotes
    const seen = new Set(dbNotes.map(item => item.exchangeId).filter(Boolean))
    const merged = [...dbNotes]
    for (const entry of legacyNotes) {
      const exId = entry?.message?.source?.exchangeId
      if (exId !== undefined && seen.has(exId)) continue
      if (exId !== undefined) seen.add(exId)
      merged.push({ exchangeId: exId, message: entry.message, ...(entry.ledger ? { ledger: entry.ledger } : {}) })
    }
    return merged
  }

  async function enqueue(ref, sender, target, long, room) {
    if (rt.readOnly?.() !== undefined) throw new Error('This window cannot save a work update.')
    if (room && (!room.members.includes(sender.id) || !room.members.includes(target.id))) {
      throw new Error('Both Bots must be members of this group.')
    }
    let work
    let current
    if (room) {
      if (ref) {
        const resolveByRef = () => {
          const found = rt.resolveGroupBatch?.(room.id, target.id, ref)
          return found !== undefined && found.by === sender.id ? found : undefined
        }
        work = resolveByRef()
        if (work === undefined) {
          throw new Error('That reference does not name your open group assignment to this member.')
        }
        const resolvedKey = work.key
        current = () => {
          const found = rt.resolveGroupBatch?.(room.id, target.id, resolvedKey)
          return found !== undefined && found.by === sender.id ? found : undefined
        }
      } else {
        const matches = rt.pendingGroupAssignments?.(room.id, target.id, sender.id) ?? []
        if (matches.length > 1) {
          throw new Error(`Multiple open group assignments to ${target.name} match (${matches.map(item => item.key).join(', ')}); pass work_id to specify which one.`)
        }
        work = matches[0]
        const resolvedKey = work?.key
        current = () => {
          if (resolvedKey === undefined) return undefined
          const found = rt.resolveGroupBatch?.(room.id, target.id, resolvedKey)
          return found !== undefined && found.by === sender.id ? found : undefined
        }
      }
      await rt.recordGroupNote?.(room, sender, target, long)
      if (!work || current() !== work) {
        return 'Posted as a group note. No open assignment received it; nobody was woken.'
      }
    } else {
      current = () => rt.resolveWork?.(ref)?.work
      work = current()
      if (!work || work.from !== sender.id || work.to !== target.id) {
        throw new Error('No open work with that reference from you to this Bot. Nothing was sent.')
      }
    }
    const id = room ? work.key : rt.resolveWork(ref).id
    const exchangeId = randomUUID()
    const book = `pair-${[sender.id, target.id].sort().join('-')}`
    const message = createUserMessage({
      content: [
        { type: 'text', text: `[Update from ${sender.name} on work #${work.ref ?? id}; no acknowledgement needed]\n${long.text}` },
        ...long.files.map(attachment => ({ type: 'file', attachment })),
      ],
      source: {
        kind: SOURCE_KIND,
        role: 'note',
        form: 'relay',
        silent: true,
        workNote: id,
        exchangeId,
        senderName: sender.name,
        ...(room ? { roomId: room.id, noteFor: target.id } : {}),
      },
    })
    if (!room) {
      rt.ledger.append(book, {
        id: exchangeId,
        from: sender.id,
        to: target.id,
        role: 'note',
        text: long.text,
        time: Date.now(),
        workRef: work.ref ?? id,
        ...(long.length ? { length: long.length, files: long.files } : {}),
      })
      await rt.ledger.written(book)
      if (current() !== work) throw new Error('That work closed before the update was queued.')
    }
    const entry = { message, ...(room ? {} : { ledger: { book, id: exchangeId } }) }
    const saved = rt.coordination?.addWorkNote?.(id, entry) === true
    if (!saved) {
      ;(work.pendingNotes ??= []).push(entry)
      try {
        await rt.save({ required: true })
      } catch (error) {
        work.pendingNotes = work.pendingNotes?.filter(note => note !== entry)
        throw error
      }
    }
    return `Update recorded for ${target.name} on #${work.ref ?? id}. It can read it at its next step on this work; no command was stopped and no reply is requested.`
  }

  function atStep(agent, step, decision) {
    if (rt.readOnly?.() !== undefined || !rt.isBotSession?.(agent.id)) return decision
    const primary = step === 1
      ? decision.messages.find(msg => msg?.source?.kind === 'user'
        || (msg?.source?.kind === SOURCE_KIND && !msg.source.silent && msg.source.form === 'relay'))?.source
      : rt.live.get(agent.id)?.info
    if (step === 1 && primary === undefined) return decision
    const task = rt.taskBySession?.(agent.id)?.task
    const member = rt.groupOwners.get(agent.id)
    let group
    if (member && primary?.roomId === member.roomId) {
      if (primary.batchKey !== undefined) {
        // When a turn names a batch, resolve only that exact batch (or its same-parent successor);
        // never fall back to another open assignment between the same caller and worker.
        group = rt.resolveGroupBatch?.(member.roomId, member.botId, primary.batchKey)
      } else if (primary.askedBy !== undefined) {
        const matches = rt.pendingGroupAssignments?.(member.roomId, member.botId, primary.askedBy) ?? []
        if (matches.length === 1) group = matches[0]
      }
    }
    const id = group?.key
      ?? rt.workOf?.(primary)
      ?? (task?.origin === 'bot-handoff' && primary?.kind !== 'user' ? task.exchangeId : undefined)
    if (id === undefined) return decision
    const work = group ?? rt.resolveWork?.(id)?.work
    if (work === undefined || (!group && (work.to !== rt.selfOf(agent.id) || (work.state ?? 'open') !== 'open'))) return decision
    const pending = listNotes(id, work)
    if (pending.length === 0) return decision
    const messages = []
    let logged
    for (const entry of pending) {
      if (group && entry.message.source.noteFor !== member.botId) continue
      const exId = entry.exchangeId ?? entry.message.source.exchangeId
      if (!observedIds.has(exId)) {
        logged ??= new Set((agent.session?.snapshotEvents?.() ?? [])
          .filter(e => e.type === 'user/message' && e.data?.source?.workNote === id)
          .map(e => e.data.source.exchangeId))
        if (!logged.has(exId)) {
          messages.push(entry.message)
          continue
        }
      }
      taken(agent.session, entry.message.source)
    }
    return messages.length > 0 ? { ...decision, messages: [...decision.messages, ...messages] } : decision
  }

  function taken(session, source) {
    if (source?.kind !== SOURCE_KIND || source.role !== 'note' || !source.workNote) return
    const workId = source.workNote
    const current = () => source.roomId ? rt.state.roomBatches?.[workId] : rt.resolveWork?.(workId)?.work
    const work = current()
    if (!work || rt.selfOf(session.id) !== (source.noteFor ?? work.to)) return
    if (source.roomId && rt.groupOwners.get(session.id)?.roomId !== source.roomId) return
    const exId = source.exchangeId
    if (typeof exId !== 'string' || exId === '') return
    const found = listNotes(workId, work).find(entry => (entry.exchangeId ?? entry.message?.source?.exchangeId) === exId)
    if (found === undefined) return
    rememberObserved(exId)
    if (confirmingIds.has(exId)) return
    confirmingIds.add(exId)
    // session/event fires inside Session.append. Checkpoint outside that call
    // and retain the note if no persistence listener confirmed the read.
    queueMicrotask(async () => {
      try {
        if (await rt.ctx.sessions.flush(session) !== true) return
        if (found.ledger) await rt.markSilentDelivered?.([found], session.id)
        rt.coordination?.removeWorkNote?.(workId, exId)
        if (current() === work && Array.isArray(work.pendingNotes)) {
          work.pendingNotes = work.pendingNotes.filter(entry => entry?.message?.source?.exchangeId !== exId)
          if (work.pendingNotes.length === 0) delete work.pendingNotes
          await rt.save()
        }
      } catch (error) {
        rt.warn('ds-bot: recording consumption of a work update failed: %s', error)
      } finally {
        confirmingIds.delete(exId)
      }
    })
  }

  function unreadCount(workId, work) {
    if (workId === undefined && work === undefined) return 0
    const notes = workId !== undefined ? listNotes(workId, work) : (Array.isArray(work?.pendingNotes) ? work.pendingNotes : [])
    return notes.filter(entry => !observedIds.has(entry.exchangeId ?? entry.message?.source?.exchangeId)).length
  }

  function clear(workId) {
    if (typeof workId !== 'string' || workId === '') return
    rt.coordination?.clearWorkNotes?.(workId)
  }

  return { enqueue, atStep, taken, unreadCount, clear }
}
