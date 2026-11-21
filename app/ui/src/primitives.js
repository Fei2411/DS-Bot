// The window's own versions of the DSH interface primitives the Bot views draw with (see
// ds-bot/src/client/dsh-primitives.js and vite.config.js).
import { createElement as h, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MENTION_ORIGIN } from '../../../ds-bot/src/client/text.js'
import { ArchiveIcon, DownloadIcon, GearIcon, PersonIcon, SlidersIcon, SpinnerIcon, StackIcon } from '../../../ds-bot/src/client/icons.js'

// The DSH Agent's mark. The app has no DSH Agent, so nothing asks for it.
export const FishLogo = () => null

function fallbackCopy(text) {
  if (typeof document === 'undefined' || !document.body) return false
  const area = document.createElement('textarea')
  area.value = String(text ?? '')
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-9999px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  const previous = document.activeElement
  area.focus()
  area.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  area.remove()
  if (previous instanceof HTMLElement) previous.focus()
  return ok
}

// writeClipboard in the plugin is DSH's (navigator.clipboard with an execCommand
// fallback off-HTTPS); the window keeps the same contract.
export const writeClipboard = text => (navigator.clipboard === undefined
  ? Promise.resolve(fallbackCopy(text))
  : navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text)))

const plugins = [remarkGfm]

function CodeBlock({ children, labels }) {
  const [copied, setCopied] = useState(false)
  const block = useRef(null)
  const copy = () => {
    void writeClipboard(block.current?.innerText ?? '').then((ok) => {
      if (!ok) return
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

// Settings icons, drawn by DS Bot (ds-bot/src/client/icons.js). DSH's take a `size`.
const sized = Icon => function SizedIcon({ size, className }) {
  return h('span', { className, style: size ? { display: 'inline-flex', width: size, height: size } : undefined }, h(Icon))
}
export const IconSettingsOutlineMedium = sized(GearIcon)
export const IconUserOutlineMedium = sized(PersonIcon)
export const IconArchiveOutlineMedium = sized(ArchiveIcon)
export const IconPersonalizationOutlineMedium = sized(SlidersIcon)
export const IconAgentPresetOutlineMedium = sized(StackIcon)
export const IconDownloadOutlineRegular = sized(DownloadIcon)
export const IconLoadingOutlineRegular = sized(SpinnerIcon)

// Only DSH's own settings rows use these (settings-preferences.js, settings-shell.js); the
// window has none of them, so nothing asks for them here. They stay so the names resolve.
export const RiskConfirmation = () => null
export const Button = () => null
export const ConnectionIndicator = () => null
export const Modal = () => null
export const Tooltip = () => null

// A user message's files: the extension and the size, written out. The file and JSON views
// and DSH's reference projection are left out; user-message.js draws its own then.
export const fileExtension = name => /\.([^./\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
const UNITS = ['B', 'KB', 'MB', 'GB']
export function fileSizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1 }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`
}
