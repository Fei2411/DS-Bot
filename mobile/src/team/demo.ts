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

  const DEMO_IMG_1 = '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'
const DEMO_IMG_2 = 'iVBORw0KGgoAAAANSUhEUgAAAPAAAADwCAYAAAA+VemSAAAACXBIWXMAAAsTAAALEwEAmpwYAAAMK0lEQVR4nO2dza+dVRXGe0tsY1vSFAZeVmOp7VaTOsAmbeMXTggWSDcWHfhBBwarWPuROFGnxBqF2CjIQDGCOFZoKE1QQwzhP0CNiR9DR2r8qBGVxG328Ya2l3vuPffc85717L1+gydpaIDmWc9vrdV3nXveTWapIDwgA6lJDzZ5/wEQHpCBBMCEgEZgAT1gAgsUAeGBATAhoBGkcB4wgQWKgPDAAJgQ0AhSOA+YwAJFQHhgAEwIaAQpnAdMYIEiIDwwACYENIIUzgMmsEAREB4YABMCGkEK5wETWKAICA8MgAkBjSCF84AJLFAEhAcGwISARpDCecAEFigCwgMDYEJAI0jhPGACCxQB4YEBMCGgEaRwHjCBBYqA8MAAmBDQCFI4D5jAAkVAeGAATAhoBCmcB0xggSIgPDAAJgQ0ghTOAyawQBEQHhgAE4IojeDt+/aVE0etPH5uV/nZw9vL736wpfz1mc3ltcsLI9Vf//apLeWnX99evn12Vzlxl43+He8/9xBiAgsUAa3twe7daQTipfM7yr+fXyjlhU3r0r8uLZTnvrKj3H/URv+tXjwHYIEioNU9+Oy9i+XX39+ybmjLGP3qe1vLybzYhe8ALFAEtLIH7z94a3n5m2+eGbhlmV66sK287923Nu0/AAsUAb3Rg8/cu1j+/uzmweAtS7pycXM5/ZG3NFsDABYoArrqQf376YVTNw0Oblmm+kCsxb8bA7BAEdBVeH/45Z1zh7cs6ekv7WwOYgAWKAL6vwf15OMFb1nSt87c1FQ9AFigCCiVzx1fdIe3LOnMR9v5OzEACxQhuurT5n9cHP6BVZlQ9eHZe29r4+k0AAsUIbqGPBWVDZyYvH2ZRAAsUITo5yJvWMsYffrYLe7+rCUAFihCVNUnvrP8hFWZseonttSfSgOwQBGiqn622RvSsoY++SFz92k1AbBAEaLq+fM73AEta+jiQzvcfVpNACxQhIh6x759U/1U0bz16qWFsn/vfne/xgmABYoQUfXneb3hLBPqE8JrNAALFCGi6mePvcEsE+qxs7vc/RonABYoQkTVb9LwBrNMqBe+tt3dr3ECYIEiRNTvn36TO5hlQtWv5/H2a5wAWKAIEfWXH9/gDmaZUH/+0Q3ufo0TAAsUIaL+c1n/CXRZUn1a7u3XOAGwQBEiCoATAHuHEE3vASt0AmAAareJ1O9y9l6Ny4T6zZM8xHIPDNLygDNSYgJ7hxC1/fU5ZUI9eoYPchB2gG/uJ5HKkj5+Jx+lBGAAvi4D9V1F9XUn3nCWNfTP5/hhBuAF3hUzUN9V5A1oWUPPPnSjdH65AwsUIarqi8a8AS0N/yRSFQALFCGq6tfVvPLdre6QljH65RN8pY57SJC2B/Utgd6gljE6feJud3/WEhNYoAjR9eIj29xhLcv00oUby9EH/uDuzVoCYIEiRFd9xWd9S6A3tOWaL3a/72MPl3z6v+7erCUAFigCSuXBD+us0l84cagc+/xrAEwwgXM9GaifePKG98Kpm8sd978ygpcJTIBpYut8Kl1f8ekF71Nf3FkOfvD86/ACMAAD8BQZ+OrJm+cO7+PndpW9+28v9zx4BYABF3BncV762zPDP9i6cnFzOXV8cfT/vP2+n1wHLxOYINPMNpCB+orPn39juBPTi49sK+9Zeo3ogUOn3gAvAAMwAM8gAw8cu2X0qahZgfuLJ7aWT91z9c2Db91z2+jmC8AAC7ADPuCqLxqr7yqqrztZL7SvXloY/WBC/Wzz8jcOHjn65IrwMoEBGqAHyEB9V1EF8bGzu0Zful6/8qZ+x1b9oryq+uv6z+rv1dNU/Xnece83SgeOv37zBWCABdiGMrB79zuvu/kCsEBREB7YhB4sv/kCMOGhgTSSgb0r3HwBWKAwCA9sAg9WuvkCMOGhgTSQgQNjbr4ALFAchAe2iger3XwBmPDQQMQzcGSVmy8ACxQI4YGN8WCtmy8AEx4aSMM338wnsfwLhfDAprz5AjDhoYE0fPPNTGD/YiE8sClvvgBMeGggDd98MxPYv2AID2zKmy8AEx4aSMM338wE9i8awgOb8uYLwISHBtLwzTczgf2Lh/Dg4JQ3XwAmPBtqIO86fK4cvvM7NCGnm29mAtP9pw3enr2Hy10n/zgKERD73HwzAAPwtMH7wPHL1wUIiOd/880ADMDTrs4rhQeI53vzzQAMwBtZnYHY9+abARiAN7o6A7HfzTcDMADPYnUGYp+bbwZgAJ7V6gzE87/5ZgAG4FmuzkA835tvBmAAnvXqDMTzu/lmAAbgIVZnIJ7PzTcDMAAPtToD8fA33wzAADzk6gzEw958MwAD8NCrc3SIh7z5ZgD2L3CE1TkqxEPffDMA+xc5yuocEeKhb74ZgP2LHGl1jgTxPG6+GYD9Cx1tdY4C8TxuvhmA/QsdcXXuHeJ53XwzAPsXO+rq3CvE87z5ZgD2L3jk1blHiOd5880A7F/w6KtzTxDP++abAdi/6N5SWJ17gNjj5psB2L/w3lJZnVuH2OPmmwE4ttRW51Yh9rr5ZgCOK9XVuUWIvW6+GYDjSnl1bgliz5tvBuCYamF1bgFi75tvBuB4aml1VofY++abATieWludVSFWuPlmAI6lVldnNYhVbr4ZgOOo9dVZCWKVm28G4DjqYXVWgFjp5psBOIZ6Wp29IVa6+WYA7l89rs5eEKvdfDMA969eV+d5Q6x4880A3Ld6X53nCbHizTcDcL+KsjrPA2LVm28G4H4VaXUeEmLlm28G4D4VcXUeCmLlm28G4P4UeXWeNcTqN98MwP0p+uo8S4jVb74ZgPsSq/PsIG7h5psBuB+xOs9uErdy880A3I9YnWcHcSs33wzAfYjVeXYQt3TzzQDsD99Gxeo8O4hbu/lmAG5frM6zg7i1m28G4LbF6jw7iFu8+WYAbld73nak3H3yT+6B6UGH7ni0yZtvBuB2xersD4uiTCCbq2mT9x9AQazO/qCoygTyCcCrmMBTZ39IlGUCkALwKiawOvtDoiwTgBSAWZ3dQWhVJgApALM6u4PQqkwAUgBmdXYHoVWZAKQAvMwEnjr7g9GKTABSAL7GBJ46+0PRkkwAUgC+xgSeOvtD0ZJMAFIAZnV2B6FVmQCkAMzq7A5CqzIBSAGY1dkdhFZlApCGB5inzv4gtCoTgDQ0wDx19oegZZlAhkMDzFNnfwhalglkOCzArM7+ALQuE8hxSIBZnf3D34NMIMshAWZ19g9/DzKBLIcDmNXZP/i9yATyHApgVmf/0PckE8h0KIBZnf1D35NMINNhAGZ19g98bzKBXIcAmNXZP+w9ygSyHQJgVmf/sPcoE8h29wCzOvsHvVeZQL67BpjV2T/kPcsEMt41wKzO/iHvWSaQ8W4BZnX2D3jvMoGcdwkwq7N/uCPIBLLeJcCszv7hjiATyHp3ALM6+wc7ikwg710BzOrsH+pIMoHMdwUwq7N/qCPJBDLfDcCszv6BjiYTyH0XALM6+4c5okwg+10AzOrsH+aIMoHsNw8wq7N/kKPKBPLfNMCszv4hjiwTYKBpgFmd/UMcWSbAQNMAIzwgAwmACQGNwDr0gAksUASEBwbAhIBGkMJ5wAQWKALCAwNgQkAjSOE8YAILFAHhgQEwIaARpHAeMIEFioDwwACYENAIUjgPmMACRUB4YABMCGgEKZwHTGCBIiA8MAAmBDSCFM4DJrBAERAeGAATAhpBCucBE1igCAgPDIAJAY0ghfOACSxQBIQHBsCEgEaQwnnABBYoAsIDA2BCQCNI4TxgAgsUAeGBATAhoBGkcB4wgQWKgPDAAJgQ0AhSOA+YwAJFQHhgAEwIaAQpnAdMYIEiIDwwACYENIIUzgMmsEAREB4YABMCGkEK5wETWKAICA8MgAkBjSCF84AJLFAEhAcGwISARpDCecAEFigCwgMDYEJAI0jhPGACCxQB4YEBMCGgEaRwHjCBBYqA8MAAmBDQCFI4D5jAAkVAeGAATAhoBCmcB0xggSIgPDAAJgQ0ghTOAyawQBEQHhgAEwIaQQrnARNYoAgIDwyACQGNIIXzgAksUASEBwbAhIBGkMJ5wAQWKALCAwNgQkAjSOE8YAILFAHhgQEwIaARpHAeMIEFioDwwACYENAIUjgPmMACRUB4YABMCGgEKZwH/wMZCNMbJU+MTgAAAABJRU5ErkJggg=='

const call = useMemo(() => async (endpoint: string, payload: unknown = {}): Promise<unknown> => {
    const body = payload as Record<string, unknown>
    const state = stateRef.current
    const bots = state.bots ?? []
    const sessionOf = (id: string) => bots.find(bot => bot.id === id)?.sessionId ?? id
    const chatOf = (id: string) => chatsRef.current[id] ?? chatsRef.current[bots.find(bot => bot.sessionId === id)?.id ?? '']
    const touch = () => { state.revision += 1; bump() }

    switch (endpoint) {
      case 'hello':
        return { api: 1, min: 1, capabilities: ['state', 'state-avatar-refs', 'avatar', 'chat', 'room-chat', 'send', 'feed', 'feed-room', 'notices', 'questions', 'views', 'approvals', 'stop-member-work', 'memory', 'memory-edit', 'usage-summary', 'stop-chat', 'row-meta', 'chat-steps', 'link-feed', 'images'], boot: 'demo', seq: 0 }
      case 'notices':
        return { boot: 'demo', seq: 0, notices: [], reset: false }
      case 'room-chat': {
        const pages = chatsRef.current[String(body.roomId ?? '')] ?? []
        const page = pages[0] ?? { items: [], cursor: null }
        return { roomId: String(body.roomId ?? ''), items: page.items, cursor: page.cursor, running: false, speaking: null }
      }
      case 'stop-chat': {
        const id = sessionOf(String(body.botId ?? ''))
        if (state.work?.bots?.[id] !== undefined) delete state.work.bots[id]
        touch()
        return true
      }
      case 'view-reply': {
        const sid = String(body.sessionId ?? '')
        if (state.views?.[sid] !== undefined) { delete state.views[sid]; touch() }
        return { ok: true }
      }
      case 'dismiss-view': {
        const sid = String(body.sessionId ?? '')
        if (state.views?.[sid] !== undefined) { delete state.views[sid]; touch() }
        return { ok: true }
      }
      case 'image': {
        const id = String(body.attachmentId ?? '')
        const data = id === 'demo-img-1' ? DEMO_IMG_1 : id === 'demo-img-2' ? DEMO_IMG_2 : undefined
        if (data === undefined) throw Object.assign(new Error('Unknown attachment'), { code: 'bot/not-found' })
        return { mime: 'image/png', data }
      }
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
