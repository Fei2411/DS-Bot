import { useMemo, useRef, useState } from 'react'
import type { TeamState } from '../connection.ts'
import { demoData } from './demo-team.ts'
import type { ChatItem } from '../screens/chat/items.tsx'

// Demo mode (EXPO_PUBLIC_DSB_DEMO=1): no computer, no link. The fixture answers
// with exactly the shapes the real host returns (channel.js `state` view + live(),
// parts.js `chat` pages). Only compiled in when the env var is set at bundle time.
export function demoLink() {
  const data = useMemo(demoData, [])
  const [, setTick] = useState(0)
  const stateRef = useRef(data.state)
  const chatsRef = useRef(data.chats)
  const bump = () => setTick(value => value + 1)

  const call = useMemo(() => async (endpoint: string, payload: unknown = {}): Promise<unknown> => {
    const body = payload as Record<string, unknown>
    const state = stateRef.current
    const bots = state.bots ?? []
    const sessionOf = (id: string) => bots.find(bot => bot.id === id)?.sessionId ?? id
    const chatOf = (id: string) => chatsRef.current[id] ?? chatsRef.current[bots.find(bot => bot.sessionId === id)?.id ?? '']
    const touch = () => { state.revision += 1; bump() }

    switch (endpoint) {
      case 'state':
        if (body.since === state.revision) return { revision: state.revision, unchanged: true, work: state.work, activity: state.activity }
        return state
      case 'chat': {
        const pages = chatOf(String(body.botId ?? ''))
        if (pages === undefined || pages.length === 0) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
        const part = typeof (body.cursor as { part?: number })?.part === 'number' ? (body.cursor as { part: number }).part : 0
        const page = pages[part] ?? { sessionId: pages[0].sessionId, items: [], cursor: null }
        return { sessionId: pages[0].sessionId, items: page.items, cursor: page.cursor }
      }
      case 'send': {
        const id = String(body.sessionId ?? '')
        const pages = chatOf(id) ?? chatsRef.current[id]
        if (pages === undefined || pages.length === 0) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
        const item: ChatItem = { kind: 'user', text: String(body.text ?? ''), time: Date.now(), seq: (pages[0].items.at(-1)?.seq ?? 0) + 1 }
        pages[0] = { ...pages[0], items: [...pages[0].items, item] }
        touch()
        return true
      }
      case 'answer-question': {
        const sid = sessionOf(String(body.sessionId ?? ''))
        const question = state.questions?.[sid]
        if (question === undefined || question.id !== body.questionId) throw Object.assign(new Error('This question is no longer open'), { code: 'bot/stale' })
        delete state.questions![sid]
        const pages = chatOf(sid)
        const answer = (body.answer ?? {}) as { selected?: string[]; custom?: string }
        if (pages !== undefined) {
          const item: ChatItem = { kind: 'answer', questions: [{ question: question.question }], answers: [{ selected: answer.selected ?? [], custom: answer.custom ?? '' }], time: Date.now(), seq: (pages[0].items.at(-1)?.seq ?? 0) + 1 }
          pages[0] = { ...pages[0], items: [...pages[0].items, item] }
        }
        touch()
        return true
      }
      case 'approval-answer': {
        const list = state.work?.approvals ?? []
        const index = list.findIndex(entry => entry.id === body.id)
        if (index === -1) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
        if (body.choice !== 'allow' && body.choice !== 'reject') throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
        list.splice(index, 1)
        touch()
        return true
      }
      case 'stop-room-work': {
        const roomId = String(body.roomId ?? '')
        if (state.work?.rooms?.[roomId] !== undefined) delete state.work.rooms[roomId]
        touch()
        return true
      }
      case 'stop-member-work': {
        const roomId = String(body.roomId ?? '')
        const list = state.work?.rooms?.[roomId]
        if (list !== undefined) state.work!.rooms![roomId] = list.filter(entry => entry.botId !== body.botId)
        touch()
        return true
      }
      default:
        throw Object.assign(new Error(`Demo cannot answer ${endpoint}`), { code: 'bot/not-found' })
    }
  }, [data])

  return { team: stateRef.current, online: true, error: null, call }
}
