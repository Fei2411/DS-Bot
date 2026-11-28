import { createContext, createElement as h, useContext, useEffect, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'

export const MarkdownImageSession = createContext(null)

export function isLocalMarkdownImage(src) {
  if (!src || /^(?:[/\\]{2}|[?#])/.test(src)) return false
  return /^(?:file:\/\/|[a-z]:[/\\])/i.test(src) || !/^[^/\\?#]*:/.test(src)
}

function WorkspaceImage({ sessionId, path, ...props }) {
  const [src, setSrc] = useState(undefined)
  useEffect(() => {
    const controller = new AbortController()
    void call('markdown-image', { sessionId, path }, controller.signal).then(result => {
      const { mime, bytes } = result ?? {}
      if (!controller.signal.aborted && /^image\/[a-z\d.+-]+$/i.test(mime) && typeof bytes === 'string' && bytes !== '') {
        setSrc(`data:${mime};base64,${bytes}`)
      }
    }).catch(() => {})
    return () => controller.abort()
  }, [sessionId, path])
  return h('img', { ...props, src })
}

export function MarkdownImage({ node: _node, src, ...props }) {
  const sessionId = useContext(MarkdownImageSession)
  return sessionId && isLocalMarkdownImage(src)
    ? h(WorkspaceImage, { key: JSON.stringify([sessionId, src]), sessionId, path: src, ...props })
    : h('img', { ...props, src: src || undefined })
}
