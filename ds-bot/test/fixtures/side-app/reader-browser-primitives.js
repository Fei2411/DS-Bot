// Test stand-in for @deepseek-ai/dsh-client-ui-primitives in the browser harness.
// It implements only what the Reader/Canvas modules import, with enough Markdown to
// make real DOM structure: headings, paragraphs, emphasis/code and escaped raw HTML.
import { createElement as h } from 'react'

const inline = (text, keyPrefix = 'x') => {
  const nodes = []
  let rest = String(text ?? '')
  let key = 0
  const pushText = value => { if (value !== '') nodes.push(value) }
  while (rest.length > 0) {
    const code = rest.indexOf('`')
    const bold = rest.indexOf('**')
    const at = [code, bold].filter(index => index >= 0).sort((a, b) => a - b)[0]
    if (at === undefined) { pushText(rest); break }
    pushText(rest.slice(0, at))
    if (at === code) {
      const end = rest.indexOf('`', at + 1)
      if (end < 0) { pushText(rest.slice(at)); rest = ''; break }
      nodes.push(h('code', { key: `${keyPrefix}-${key++}` }, rest.slice(at + 1, end)))
      rest = rest.slice(end + 1)
    } else {
      const end = rest.indexOf('**', at + 2)
      if (end < 0) { pushText(rest.slice(at)); rest = ''; break }
      nodes.push(h('strong', { key: `${keyPrefix}-${key++}` }, rest.slice(at + 2, end)))
      rest = rest.slice(end + 2)
    }
  }
  return nodes
}

export function MarkdownText({ text }) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let paragraph = []
  let key = 0
  const flush = () => {
    if (paragraph.length === 0) return
    out.push(h('p', { key: `p-${key++}` }, inline(paragraph.join(' '), `i-${key}`)))
    paragraph = []
  }
  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1].length
      out.push(h(`h${level}`, { key: `h-${key++}` }, inline(heading[2], `h-i-${key}`)))
      continue
    }
    if (/^```/.test(line)) {
      flush()
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
  return h('div', { className: 'test-markdown' }, out)
}

export const writeClipboard = async text => {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false)
  return false
}

export const FishLogo = () => null
export const IconAgentPresetOutlineMedium = () => null
export const IconArchiveOutlineMedium = () => null
export const IconPersonalizationOutlineMedium = () => null
export const IconSettingsOutlineMedium = () => null
export const IconUserOutlineMedium = () => null
export const IconDownloadOutlineRegular = () => null
export const IconLoadingOutlineRegular = () => null
export const RiskConfirmation = () => null
export const Button = props => h('button', props, props?.children)
export const ConnectionIndicator = () => null
export const Modal = props => h('div', props, props?.children)
export const Tooltip = props => h('span', props, props?.children)
export const FileTypeIcon = () => null
export const JsonBlock = () => null
export const fileExtension = path => String(path ?? '').split('.').pop()
export const fileSizeText = size => `${size} B`
export const projectUserText = text => text
