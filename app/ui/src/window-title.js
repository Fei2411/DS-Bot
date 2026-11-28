import { useEffect } from 'react'

export const APP_TITLE = 'DS Bot'
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/gu

export function formatWindowTitle(name) {
  const clean = typeof name === 'string' ? name.replace(CONTROL_CHARS, ' ').trim() : ''
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
