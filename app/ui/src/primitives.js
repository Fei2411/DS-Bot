// The window's own versions of the DSH interface primitives the Bot views draw with (see
// ds-bot/src/client/dsh-primitives.js and vite.config.js).
import { Fragment, createContext, createElement as h, isValidElement, memo, useContext, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { splitMarkdownBlocks } from '../../../ds-bot/src/client/markdown-blocks.js'
import { MENTION_ORIGIN } from '../../../ds-bot/src/client/text.js'
import { ArchiveIcon, DownloadIcon, GearIcon, PersonIcon, SlidersIcon, SpinnerIcon, StackIcon } from '../../../ds-bot/src/client/icons.js'
import { renderHighlightedBlock, useHighlightedCode } from './code-highlight.js'
import { FileRefChip, isInlineCodeFilePath, matchFileMention, parseLocalFileHref, remarkFileReferences } from './file-references.js'
import { MathExpression, escapeCurrencyDollars, normalizeMathDelimiters, remarkGuardCurrencyMath } from './math-render.js'

// Official DeepSeek Harness FishLogo geometry (@deepseek-ai/dsh-client-ui-primitives).
export const FISH_LOGO_VIEWBOX = { width: 23.16, height: 17.04 }
export const FISH_LOGO_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'
const HERO_SWIM_UP_PATH = 'M22.403 0.567C22.145 0.477 22.068 0.718 21.939 0.85C21.895 0.893 21.86 0.947 21.824 0.997C21.515 1.421 21.13 1.721 20.591 1.77C19.829 1.867 19.221 2.244 18.712 2.958C18.535 2.227 18.116 1.839 17.516 1.626C17.203 1.506 16.887 1.379 16.663 1.064C16.508 0.839 16.462 0.581 16.383 0.329C16.332 0.176 16.283 0.02 16.121 -0.002C15.944 -0.029 15.875 0.133 15.805 0.269C15.52 0.822 15.408 1.43 15.42 2.046C15.449 3.432 16.031 4.532 17.202 5.274C17.337 5.356 17.374 5.445 17.335 5.582C17.261 5.862 17.169 6.134 17.086 6.413C17.032 6.59 16.952 6.63 16.764 6.558C16.118 6.301 15.562 5.909 15.074 5.433C14.248 4.633 13.5 3.751 12.568 3.06C12.349 2.898 12.13 2.748 11.903 2.605C10.952 1.682 12.028 0.923 12.277 0.833C12.537 0.739 12.367 0.416 11.526 0.42C10.684 0.424 9.914 0.706 8.933 1.081C8.789 1.138 8.638 1.179 8.484 1.213C7.593 1.044 6.668 1.006 5.702 1.115C3.883 1.318 2.43 2.178 1.362 3.646C0.079 5.41 -0.223 7.415 0.147 9.506C0.535 11.71 1.66 13.535 3.389 14.962C5.181 16.441 7.246 17.166 9.601 17.027C11.032 16.944 12.624 16.753 14.421 15.232C14.874 15.458 15.35 15.548 16.138 15.615C16.746 15.672 17.331 15.585 17.784 15.491C18.493 15.341 18.444 14.684 18.188 14.564C16.108 13.595 16.565 13.989 16.15 13.67C17.206 12.42 18.82 10.198 19.363 7.086C19.421 6.709 19.484 6.171 19.469 5.866C19.458 5.681 19.493 5.604 19.681 5.556C20.199 5.412 20.691 5.172 21.125 4.806C22.366 3.824 22.758 2.554 22.708 1.1C22.7 0.878 22.649 0.654 22.403 0.567ZM11.175 14.451C9.159 12.726 8.182 12.088 7.778 12.067C7.401 12.047 7.469 12.505 7.552 12.807C7.639 13.103 7.752 13.313 7.91 13.581C8.02 13.758 8.095 14.01 7.801 14.16C7.152 14.487 6.023 13.806 5.97 13.772C4.657 12.85 3.559 11.766 2.785 10.369C2.037 9.025 1.603 7.583 1.532 6.044C1.513 5.672 1.622 5.541 1.992 5.473C2.479 5.383 2.981 5.364 3.468 5.436C5.525 5.736 7.276 6.675 8.744 8.323C9.582 9.299 10.216 10.425 10.869 11.496C11.563 12.592 12.31 13.603 13.262 14.414C13.598 14.696 13.866 14.91 14.123 15.068C13.349 15.154 12.058 15.167 11.175 14.452L11.175 14.451ZM12.141 8.26C12.141 8.095 12.273 7.963 12.439 7.963C12.476 7.963 12.511 7.971 12.541 7.982C12.582 7.997 12.62 8.019 12.65 8.053C12.704 8.106 12.733 8.181 12.733 8.26C12.733 8.425 12.601 8.556 12.435 8.556C12.27 8.556 12.141 8.425 12.141 8.26ZM15.142 9.799C14.949 9.878 14.757 9.945 14.572 9.953C14.284 9.968 13.972 9.851 13.802 9.709C13.537 9.487 13.348 9.363 13.27 8.977C13.236 8.812 13.255 8.556 13.284 8.41C13.352 8.094 13.277 7.892 13.055 7.708C12.873 7.558 12.643 7.516 12.39 7.516C12.296 7.516 12.209 7.475 12.145 7.441C12.039 7.389 11.952 7.257 12.035 7.096C12.062 7.043 12.19 6.916 12.22 6.893C12.563 6.698 12.96 6.762 13.326 6.908C13.665 7.047 13.922 7.302 14.292 7.663C14.669 8.098 14.738 8.218 14.953 8.545C15.123 8.801 15.277 9.063 15.383 9.364C15.447 9.551 15.364 9.705 15.142 9.799Z'
const HERO_SWIM_DOWN_PATH = 'M23.271 2.216C23.039 2.071 22.91 2.287 22.755 2.388C22.703 2.42 22.656 2.464 22.61 2.505C22.214 2.848 21.771 3.054 21.225 2.956C20.412 2.784 19.68 2.919 19.005 3.435C18.92 2.663 18.493 2.157 17.808 1.798C17.446 1.621 17.08 1.449 16.83 1.111C16.656 0.872 16.611 0.612 16.524 0.354C16.469 0.198 16.414 0.039 16.223 0.009C16.017 -0.024 15.936 0.137 15.856 0.271C15.539 0.822 15.418 1.43 15.429 2.046C15.454 3.432 16.041 4.538 17.196 5.36C17.325 5.456 17.356 5.547 17.312 5.674C17.229 5.936 17.134 6.191 17.051 6.454C16.999 6.623 16.921 6.659 16.738 6.58C16.107 6.306 15.56 5.909 15.074 5.433C14.248 4.633 13.5 3.751 12.568 3.06C12.349 2.898 12.13 2.748 11.903 2.605C10.952 1.682 12.028 0.923 12.277 0.833C12.537 0.739 12.367 0.416 11.526 0.42C10.684 0.424 9.914 0.706 8.933 1.081C8.789 1.138 8.638 1.179 8.484 1.213C7.593 1.044 6.668 1.006 5.702 1.115C3.883 1.318 2.43 2.178 1.362 3.646C0.079 5.41 -0.223 7.415 0.147 9.506C0.535 11.71 1.66 13.535 3.389 14.962C5.181 16.441 7.246 17.166 9.601 17.027C11.032 16.944 12.624 16.753 14.421 15.232C14.874 15.458 15.35 15.548 16.138 15.615C16.746 15.672 17.331 15.585 17.784 15.491C18.493 15.341 18.444 14.684 18.188 14.564C16.108 13.595 16.565 13.989 16.15 13.67C17.206 12.42 18.82 10.198 19.278 7.246C19.318 6.948 19.375 6.534 19.371 6.293C19.371 6.145 19.411 6.092 19.597 6.098C20.113 6.109 20.619 6.051 21.096 5.891C22.503 5.375 23.169 4.232 23.448 2.804C23.49 2.586 23.491 2.356 23.271 2.216ZM11.175 14.49C9.159 13.005 8.182 12.567 7.778 12.621C7.401 12.673 7.469 13.087 7.552 13.354C7.639 13.619 7.752 13.797 7.91 14.024C8.02 14.175 8.095 14.406 7.801 14.609C7.152 15.063 6.023 14.63 5.97 14.609C4.657 13.941 3.559 12.965 2.785 11.569C2.037 10.225 1.603 8.783 1.532 7.244C1.513 6.872 1.622 6.741 1.992 6.673C2.479 6.583 2.981 6.564 3.468 6.636C5.525 6.936 7.276 7.843 8.744 9.163C9.582 9.888 10.216 10.783 10.869 11.679C11.563 12.659 12.31 13.617 13.262 14.415C13.598 14.696 13.866 14.91 14.123 15.068C13.349 15.155 12.058 15.177 11.175 14.491L11.175 14.49ZM12.141 8.26C12.141 8.095 12.273 7.963 12.439 7.963C12.476 7.963 12.511 7.971 12.541 7.982C12.582 7.997 12.62 8.019 12.65 8.053C12.704 8.106 12.733 8.181 12.733 8.26C12.733 8.425 12.601 8.556 12.435 8.556C12.27 8.556 12.141 8.425 12.141 8.26ZM15.142 9.799C14.949 9.878 14.757 9.945 14.572 9.953C14.284 9.968 13.972 9.851 13.802 9.709C13.537 9.487 13.348 9.363 13.27 8.977C13.236 8.812 13.255 8.556 13.284 8.41C13.352 8.094 13.277 7.892 13.055 7.708C12.873 7.558 12.643 7.516 12.39 7.516C12.296 7.516 12.209 7.475 12.145 7.441C12.039 7.389 11.952 7.257 12.035 7.096C12.062 7.043 12.19 6.916 12.22 6.893C12.563 6.698 12.96 6.762 13.326 6.908C13.665 7.047 13.922 7.302 14.292 7.663C14.669 8.098 14.738 8.218 14.953 8.545C15.123 8.801 15.277 9.063 15.383 9.364C15.447 9.551 15.364 9.705 15.142 9.799Z'

// The DSH Agent's official mark in the Bot sidebar, Classic Agent sidebar/header, and blank hero.
export function FishLogo({ size = 24, className, swim = false }) {
  return h('svg', {
    width: size,
    height: (size * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width,
    className,
    viewBox: `0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`,
    fill: 'none',
    'aria-hidden': true,
  },
  h('path', { d: FISH_LOGO_PATH, fill: 'currentColor' },
    swim ? h('animate', {
      attributeName: 'd',
      values: `${FISH_LOGO_PATH};${HERO_SWIM_UP_PATH};${FISH_LOGO_PATH};${HERO_SWIM_DOWN_PATH};${FISH_LOGO_PATH}`,
      keyTimes: '0;0.35;0.55;0.75;1',
      calcMode: 'spline',
      keySplines: '0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1',
      dur: '1.6s',
      repeatCount: 'indefinite',
    }) : null))
}

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

const BASE_PLUGINS = [remarkGfm, remarkMath, remarkGuardCurrencyMath]
const LINKED_PLUGINS = [remarkGfm, remarkMath, remarkGuardCurrencyMath, remarkFileReferences]

const InPreContext = createContext(false)
const InLinkContext = createContext(false)

function plainChildrenText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainChildrenText).join('')
  if (isValidElement(node)) return plainChildrenText(node.props?.children)
  return ''
}

function extractFenceMeta(children) {
  const child = Array.isArray(children) ? children.find(isValidElement) : (isValidElement(children) ? children : null)
  if (!child) return { className: '', rawLang: '', isMath: false, codeText: plainChildrenText(children) }
  const className = typeof child.props?.className === 'string' ? child.props.className : ''
  const classes = className.split(/\s+/).filter(Boolean)
  const langClass = classes.find(cls => cls.startsWith('language-')) ?? ''
  const rawLang = langClass ? langClass.slice('language-'.length) : ''
  const isMath = classes.includes('math-display') || rawLang.toLowerCase() === 'math'
  const rawText = plainChildrenText(child.props?.children)
  const codeText = rawText.endsWith('\n') ? rawText.slice(0, -1) : rawText
  return { className, rawLang, isMath, codeText }
}

function CodeBlock({ children, labels }) {
  const [copied, setCopied] = useState(false)
  const block = useRef(null)
  const { className, rawLang, isMath, codeText } = extractFenceMeta(children)
  const highlighted = useHighlightedCode(isMath ? '' : codeText, isMath ? '' : rawLang)

  if (isMath) {
    return h(MathExpression, { tex: codeText.trim(), display: true })
  }

  const copy = () => {
    const text = codeText !== '' ? codeText : (block.current?.innerText ?? '')
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    })
  }
  const langLabel = rawLang ? rawLang.toLowerCase() : ''
  return h('div', { className: 'md-code', 'data-has-lang': langLabel ? '' : undefined },
    h('div', { className: 'md-code-bar' },
      langLabel ? h('span', { className: 'md-code-lang' }, langLabel) : null,
      h('button', { type: 'button', className: 'md-copy', onClick: copy }, copied ? labels?.code?.copiedLabel : labels?.code?.copyLabel)),
    h(InPreContext.Provider, { value: true },
      h('pre', { ref: block },
        highlighted !== null
          ? h('code', { className: className ? `${className} hljs` : 'hljs' }, renderHighlightedBlock(highlighted))
          : children)))
}

function InlineCode({ className, children, onOpenFile, onRevealFolder, fileMentions, ...rest }) {
  const inPre = useContext(InPreContext)
  const inLink = useContext(InLinkContext)
  const text = plainChildrenText(children)
  const cls = typeof className === 'string' ? className : ''
  if (!inPre && cls.split(/\s+/).includes('math-inline')) {
    return h(MathExpression, { tex: text, display: false })
  }
  if (!inPre && !inLink && (typeof onOpenFile === 'function' || typeof onRevealFolder === 'function')) {
    const mention = matchFileMention(text, fileMentions)
    if (mention) {
      return h(FileRefChip, {
        target: { path: mention.path, line: mention.line ?? null, isDir: mention.isDir === true, display: mention.display ?? mention.path },
        label: text,
        title: mention.path,
        onOpenFile: mention.open ? () => mention.open() : onOpenFile,
        onRevealFolder,
        className: 'dsb-file-ref-code',
      })
    }
    const parsed = isInlineCodeFilePath(text)
    if (parsed) {
      return h(FileRefChip, {
        target: parsed,
        label: text,
        title: parsed.display,
        onOpenFile,
        onRevealFolder,
        className: 'dsb-file-ref-code',
      })
    }
  }
  return h('code', { className, ...rest }, children)
}

// Links open outside the window; mention links stay for the chat's own click handler;
// local file/folder links open in the workspace right panel.
const elements = ({ labels, onOpenFile, onRevealFolder, fileMentions }) => ({
  a: ({ node: _node, children, ...props }) => {
    if (props.href?.startsWith(MENTION_ORIGIN)) {
      return h(InLinkContext.Provider, { value: true }, h('a', props, children))
    }
    if (typeof onOpenFile === 'function' || typeof onRevealFolder === 'function') {
      const local = parseLocalFileHref(props.href)
      if (local) {
        const label = plainChildrenText(children).trim()
        return h(FileRefChip, {
          target: local,
          label: label || undefined,
          title: props.title || local.display,
          onOpenFile,
          onRevealFolder,
        })
      }
    }
    return h(InLinkContext.Provider, { value: true }, h('a', { ...props, target: '_blank', rel: 'noreferrer' }, children))
  },
  pre: ({ children }) => h(CodeBlock, { labels }, children),
  code: ({ node: _node, ...props }) => h(InlineCode, { ...props, onOpenFile, onRevealFolder, fileMentions }),
})

const SAFE_URL_PROTOCOL_RE = /^(https?|ircs?|mailto|xmpp)$/i

// Matches react-markdown's `defaultUrlTransform` without requiring a named import
// (test harnesses replace `react-markdown` with a default-export-only stub).
function defaultSafeUrlTransform(value) {
  if (typeof value !== 'string') return ''
  const colon = value.indexOf(':')
  const questionMark = value.indexOf('?')
  const numberSign = value.indexOf('#')
  const slash = value.indexOf('/')
  if (
    colon === -1
    || (slash !== -1 && colon > slash)
    || (questionMark !== -1 && colon > questionMark)
    || (numberSign !== -1 && colon > numberSign)
    || SAFE_URL_PROTOCOL_RE.test(value.slice(0, colon))
  ) {
    return value
  }
  return ''
}

// Preserves recognized local file/folder destinations (prose `dsb-file://`, `file://`,
// Windows drive links including percent-encoded backslashes, and `README.md:42`) ONLY on
// anchor `href` attributes consumed by our custom `a` renderer; delegates every other URL
// (including `javascript:`, `data:`, and non-anchor elements like `<img>`) to the safe allowlist.
export function markdownUrlTransform(url, key, node) {
  if (typeof url === 'string' && key === 'href' && (!node || node.tagName === 'a') && parseLocalFileHref(url) !== null) {
    return url
  }
  return defaultSafeUrlTransform(url)
}

// A closed block of a streaming reply. Once the splitter has closed it, later chunks
// cannot change what it means, so the memo holds for the rest of the stream and the
// block never re-parses. The Fragment keeps the block's elements flat inside the one
// outer `.md_markdown` wrapper: the DOM a settled full parse would produce is the same,
// so nothing jumps when streaming completes.
const StaticMarkdownBlock = memo(function StaticMarkdownBlock({ text, components, remarkPlugins, urlTransform }) {
  return h(Fragment, null, h(Markdown, { remarkPlugins, components, urlTransform }, text))
})

// Short replies cost little enough that splitting them is not worth the extra elements.
const STREAM_SPLIT_MIN = 512

// The class keeps the `_markdown` stem that the Bot views' styles give DSH's Markdown.
export function MarkdownText({ text, labels, variant, streaming = false, onOpenFile, onRevealFolder, fileMentions }) {
  const linkFiles = typeof onOpenFile === 'function' || typeof onRevealFolder === 'function'
  const remarkPlugins = linkFiles ? LINKED_PLUGINS : BASE_PLUGINS
  const urlTransform = linkFiles ? markdownUrlTransform : defaultSafeUrlTransform
  // New element types on every render would remount each code block as a reply streams in.
  const components = useMemo(
    () => elements({ labels, onOpenFile, onRevealFolder, fileMentions }),
    [labels?.code?.copyLabel, labels?.code?.copiedLabel, onOpenFile, onRevealFolder, fileMentions],
  )
  const source = useMemo(() => escapeCurrencyDollars(normalizeMathDelimiters(text ?? '')), [text])
  // While streaming, closed blocks parse once and only the live trailing piece re-parses
  // per chunk, instead of the whole message (which re-parses quadratically over a reply).
  // `null` from the splitter means the text holds document-wide syntax and stays whole.
  const blocks = streaming && source.length > STREAM_SPLIT_MIN ? splitMarkdownBlocks(source) : null
  const split = blocks !== null && blocks.length >= 2
  return h('div', { className: variant === 'compact' ? 'md_markdown md-compact' : 'md_markdown' },
    split
      ? [
        ...blocks.slice(0, -1).map((block, index) => h(StaticMarkdownBlock, { key: index, text: block, components, remarkPlugins, urlTransform })),
        h(Markdown, { key: blocks.length - 1, remarkPlugins, components, urlTransform }, blocks.at(-1)),
      ]
      : h(Markdown, { remarkPlugins, components, urlTransform }, source))
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

// A user message's files: the extension and the size, written out. Exported as undefined
// so shared `user-message.js` cleanly takes its own fallback paths with zero Vite warnings.
export const projectUserText = undefined
export const FileTypeIcon = undefined
export const JsonBlock = undefined
export const fileExtension = name => /\.([^./\\]+)$/.exec(String(name ?? ''))?.[1] ?? ''
const UNITS = ['B', 'KB', 'MB', 'GB']
export function fileSizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1 }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`
}
