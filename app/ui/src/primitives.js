// The window's own versions of the DSH interface primitives the Bot views draw with (see
// ds-bot/src/client/dsh-primitives.js and vite.config.js).
import { createElement as h, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MENTION_ORIGIN } from '../../../ds-bot/src/client/text.js'

// The DSH Agent's mark. The app has no DSH Agent, so nothing asks for it.
export const FishLogo = () => null

const plugins = [remarkGfm]

function CodeBlock({ children, labels }) {
  const [copied, setCopied] = useState(false)
  const block = useRef(null)
  const copy = () => {
    void navigator.clipboard?.writeText(block.current?.innerText ?? '').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    })
  }
  return h('div', { className: 'md-code' },
    h('button', { type: 'button', className: 'md-copy', onClick: copy }, copied ? labels?.code?.copiedLabel : labels?.code?.copyLabel),
    h('pre', { ref: block }, children))
}

// Links open outside the window; mention links stay for the chat's own click handler.
const elements = labels => ({
  a: ({ node: _node, ...props }) => h('a', props.href?.startsWith(MENTION_ORIGIN) ? props : { ...props, target: '_blank', rel: 'noreferrer' }),
  pre: ({ children }) => h(CodeBlock, { labels }, children),
})

// The class keeps the `_markdown` stem that the Bot views' styles give DSH's Markdown.
export function MarkdownText({ text, labels, variant }) {
  // New element types on every render would remount each code block as a reply streams in.
  const components = useMemo(() => elements(labels), [labels?.code?.copyLabel, labels?.code?.copiedLabel])
  return h('div', { className: variant === 'compact' ? 'md_markdown md-compact' : 'md_markdown' },
    h(Markdown, { remarkPlugins: plugins, components }, text ?? ''))
}

export function useMarkdown(props) {
  return h(MarkdownText, props)
}
