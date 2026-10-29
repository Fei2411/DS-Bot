import { createElement as h, useEffect, useRef, useState } from 'react'
import { MarkdownText as DshMarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './i18n.js'

function MathCard({ source, tex, labels, variant }) {
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source)
      setFailed(false)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      setFailed(true)
    }
  }
  return h('section', { className: 'bt-math-card', 'aria-label': t('Formula') },
    h('div', { className: 'bt-math-toolbar' },
      h('button', {
        type: 'button', 'aria-label': t('Show formula source'), 'aria-pressed': showSource,
        onClick: () => setShowSource(value => !value),
      }, showSource ? t('Preview') : t('Source code')),
      h('button', { type: 'button', onClick: copy, 'aria-live': 'polite' }, copied ? t('Copied') : t('Copy'))),
    showSource ? h('pre', { className: 'bt-math-source', tabIndex: 0 }, h('code', null, source))
      : h('div', { className: 'bt-math-preview' }, h(DshMarkdownText, { text: `$$\n${tex}\n$$`, labels, variant })),
    failed ? h('div', { className: 'bt-math-error', role: 'status' }, t('Could not copy. Try again.')) : null)
}

export function useMarkdown(props) {
  const { text = '', streaming } = props
  const [parsed, setParsed] = useState(null)
  useEffect(() => {
    if (streaming || !/\$\$|\\\[|^[ \t]*(`{3,}|~{3,})(?:latex|tex|math)\b/im.test(text)) return
    let active = true
    // The parser's browser entity decoder needs a document. Defer it until a
    // mounted, settled formula needs parsing, rather than at plugin registration.
    void import('./math-blocks.js').then(({ mathBlocks }) => {
      if (active) setParsed({ text, parts: mathBlocks(text) })
    }).catch(() => {
      if (active) setParsed({ text, parts: null })
    })
    return () => { active = false }
  }, [text, streaming])
  const parts = !streaming && parsed?.text === text ? parsed.parts : null
  if (!parts) return h(DshMarkdownText, props)
  return h('div', { className: 'bt-math-document' }, parts.map(part => part.type === 'math'
    ? h(MathCard, { key: part.key, source: part.source, tex: part.tex, labels: props.labels, variant: props.variant })
    : h(DshMarkdownText, { ...props, key: part.key, text: part.text })))
}
