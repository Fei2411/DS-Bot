// Shared accessible image lightbox and tool-card image thumbnail loader.
// Reuses `useEscape` from ds-bot's overlay stack so Esc closes only the lightbox
// without triggering approval or composer shortcuts underneath.
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fileSizeText } from '../../../ds-bot/src/client/dsh-primitives.js'
import { CloseIcon, ImageIcon } from '../../../ds-bot/src/client/icons.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ESCAPE_PRIORITY, useEscape } from '../../../ds-bot/src/client/overlay-hooks.js'

/**
 * Full-screen image viewer portaled to `document.body`, dismissed via Esc, backdrop click, or close button.
 */
export function ImageLightbox({ open, src, loadFull, alt, caption, onClose }) {
  const [fullSrc, setFullSrc] = useState(null)
  const closeBtn = useRef(null)
  const returnFocus = useRef(null)

  useEscape(() => onClose?.(), open, { priority: ESCAPE_PRIORITY.LIGHTBOX })

  useEffect(() => {
    if (open) {
      returnFocus.current = typeof document !== 'undefined' ? document.activeElement : null
      closeBtn.current?.focus?.()
      return undefined
    }
    setFullSrc(null)
    const prev = returnFocus.current
    returnFocus.current = null
    const active = typeof document !== 'undefined' ? document.activeElement : null
    if (prev && prev.isConnected !== false && typeof prev.focus === 'function'
      && (!active || active === document.body || active === document.documentElement)) {
      prev.focus()
    }
    return undefined
  }, [open])

  const loadFullRef = useRef(loadFull)
  loadFullRef.current = loadFull

  useEffect(() => {
    if (!open || typeof loadFullRef.current !== 'function') return undefined
    let alive = true
    void Promise.resolve(loadFullRef.current())
      .then((next) => { if (alive && typeof next === 'string' && next !== '') setFullSrc(next) })
      .catch(() => {})
    return () => { alive = false }
  }, [open])

  if (!open) return null
  const shown = fullSrc || src
  if (!shown) return null

  const label = alt || t('Image')
  const node = h('div', {
    className: 'dsb-lightbox',
    role: 'dialog',
    'aria-modal': true,
    'aria-label': label,
    onClick: (event) => { if (event.target === event.currentTarget) onClose?.() },
  },
  h('button', {
    ref: closeBtn,
    type: 'button',
    className: 'dsb-lightbox-close',
    'aria-label': t('Close'),
    title: t('Close'),
    onClick: () => onClose?.(),
  }, h(CloseIcon)),
  h('figure', { className: 'dsb-lightbox-fig' },
    h('img', { className: 'dsb-lightbox-img', src: shown, alt: label }),
    caption ? h('figcaption', { className: 'dsb-lightbox-cap' }, caption) : null))

  const target = typeof document !== 'undefined' && document?.body ? document.body : null
  return target ? createPortal(node, target) : node
}

export function imageMetaLabel(attachment) {
  if (!attachment || typeof attachment !== 'object') return ''
  const orig = attachment.originalDimensions
  const w = orig?.width ?? attachment.width
  const hgt = orig?.height ?? attachment.height
  const dims = Number.isFinite(w) && Number.isFinite(hgt) && w > 0 && hgt > 0 ? `${w}×${hgt}` : ''
  const size = Number.isFinite(attachment.bytes) && attachment.bytes > 0 ? fileSizeText(attachment.bytes) : ''
  return [dims, size].filter(Boolean).join(' · ')
}

/**
 * Loads and displays a tool-result image attachment as a clickable thumbnail that opens `ImageLightbox`.
 */
export function ToolImageThumb({
  attachment,
  loadImage,
  fallbackLoader,
  alt,
  label,
  compact = false,
  showMeta = true,
}) {
  const attachmentId = attachment?.attachmentId
  const direct = typeof attachment?.previewUrl === 'string' && attachment.previewUrl !== '' ? attachment.previewUrl : null
  const [src, setSrc] = useState(direct)
  const [state, setState] = useState(direct ? 'ready' : (attachmentId ? 'loading' : 'empty'))
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    if (direct) {
      setSrc(direct)
      setState('ready')
      return undefined
    }
    if (!attachmentId) {
      setSrc(null)
      setState('empty')
      return undefined
    }
    let alive = true
    setState('loading')
    const run = async () => {
      let resolved = null
      if (typeof loadImage === 'function') {
        try {
          const value = await loadImage(attachmentId, { preview: true })
          if (typeof value === 'string' && value !== '') resolved = value
        } catch { /* fall through to optional fallback loader */ }
      }
      if (!resolved && typeof fallbackLoader === 'function') {
        try {
          const value = await fallbackLoader(attachmentId)
          if (typeof value === 'string' && value !== '') resolved = value
        } catch { /* unavailable */ }
      }
      if (!alive) return
      if (resolved) {
        setSrc(resolved)
        setState('ready')
      } else {
        setSrc(null)
        setState('error')
      }
    }
    void run()
    return () => { alive = false }
  }, [direct, attachmentId, loadImage, fallbackLoader])

  const loadFull = useCallback(() => {
    if (!attachmentId || typeof loadImage !== 'function') return Promise.resolve(null)
    return loadImage(attachmentId, { preview: false })
  }, [attachmentId, loadImage])

  const meta = imageMetaLabel(attachment)
  const caption = [label || attachment?.name || alt, meta].filter(Boolean).join(' · ')
  const title = alt || label || attachment?.name || t('Image')

  if (state === 'loading') {
    return h('div', {
      className: compact ? 'dsb-timg-placeholder is-compact' : 'dsb-timg-placeholder',
      role: 'status',
      'aria-label': t('Loading image…'),
    },
    h('span', { className: 'dsb-timg-ph-ico', 'aria-hidden': true }, h(ImageIcon)),
    h('span', { className: 'dsb-timg-ph-text' }, t('Loading image…')))
  }

  if (!src) {
    return h('div', { className: compact ? 'dsb-timg-placeholder is-compact' : 'dsb-timg-placeholder' },
      h('span', { className: 'dsb-timg-ph-ico', 'aria-hidden': true }, h(ImageIcon)),
      h('span', { className: 'dsb-timg-ph-text' }, label || t('Image unavailable')),
      showMeta && meta ? h('span', { className: 'dsb-timg-ph-meta' }, meta) : null)
  }

  return h(Fragment, null,
    h('div', { className: compact ? 'dsb-timg-wrap is-compact' : 'dsb-timg-wrap' },
      h('button', {
        type: 'button',
        className: 'dsb-timg-btn',
        title: t('Click to enlarge'),
        'aria-label': `${title} · ${t('Click to enlarge')}`,
        onClick: () => setZoomed(true),
      },
      h('img', { className: 'dsb-timg', src, alt: title, loading: 'lazy' }),
      label ? h('span', { className: 'dsb-timg-label' }, label) : null),
      showMeta && meta && !compact ? h('div', { className: 'dsb-timg-meta' }, meta) : null),
    h(ImageLightbox, {
      open: zoomed,
      src,
      loadFull,
      alt: title,
      caption,
      onClose: () => setZoomed(false),
    }))
}
