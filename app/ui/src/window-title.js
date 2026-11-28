import { useEffect } from 'react'

export const APP_TITLE = 'DS Bot'

export function formatWindowTitle(name) {
  const clean = typeof name === 'string' ? name.trim() : ''
  return clean !== '' ? `${clean} — ${APP_TITLE}` : APP_TITLE
}

export function conversationTitleOf({ shown, chat, shownAgent, sessionTitle } = {}) {
  if (!shown) return ''
  if (typeof chat?.name === 'string' && chat.name.trim() !== '') return chat.name.trim()
  if (typeof sessionTitle === 'string' && sessionTitle.trim() !== '') return sessionTitle.trim()
  if (typeof shownAgent?.name === 'string' && shownAgent.name.trim() !== '') return shownAgent.name.trim()
  return ''
}

export function useWindowTitle(name) {
  const nextTitle = formatWindowTitle(name)
  useEffect(() => {
    if (typeof document !== 'undefined') document.title = nextTitle
  }, [nextTitle])
}
