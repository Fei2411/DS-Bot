// Shared in-app "What's new" / release-notes dialog used by both the desktop app UI
// and the DSH plugin client. Reads offline release data generated from release-notes.json
// and CHANGELOG.md, follows --bt-* theme tokens, and shows only the current version's
// highlights (with a footer link to the full GitHub changelog for earlier releases).
import { createElement as h, useEffect, useId, useMemo, useRef } from 'react'
import { MAIN_LOOK } from './characters.js'
import { language, t } from './i18n.js'
import { CloseIcon } from './icons.js'
import { toTraditional } from './locales/zh-tw.js'
import { BotMark } from './mark.js'
import { useEscape } from './overlay-hooks.js'
import {
  cleanSemver,
  getReleaseEntry,
  RELEASE_NOTES,
  selectReleaseNotes,
} from '../shared/release-notes.js'

const DEFAULT_RELEASES_URL = 'https://github.com/Fei-Craft/DS-Bot/releases'
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function focusablesIn(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return []
  return Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => {
    if (el.tabIndex < 0) return false
    if (typeof el.closest === 'function' && el.closest('[inert],[aria-hidden="true"]')) return false
    return true
  })
}

function localizeBlock(entry, loc) {
  const picked = selectReleaseNotes(entry, loc)
  if (picked === null) return null
  const wantsTraditional = /^zh-(tw|hk|mo|hant)/iu.test(String(loc ?? ''))
  if (wantsTraditional && picked.locale.toLowerCase() === 'zh') {
    return {
      ...picked,
      ...(picked.intro ? { intro: toTraditional(picked.intro) } : {}),
      items: picked.items.map(toTraditional),
      ...(picked.outro ? { outro: toTraditional(picked.outro) } : {}),
    }
  }
  return picked
}

export function ReleaseNotesDialog({
  current = null,
  notesUrl = null,
  releases = RELEASE_NOTES,
  leaving = false,
  onClose,
}) {
  const titleId = useId()
  const layerRef = useRef(null)
  const dialogRef = useRef(null)
  const locale = language()

  // Escape closes only this topmost layer (priority > Settings dialog).
  useEscape(() => { if (!leaving) onClose?.() }, !leaving, { priority: 20 })

  // Save prior focus, inert background siblings, trap Tab/Shift+Tab inside the dialog while
  // open (!leaving), and restore focus safely without stealing focus the user already moved.
  useEffect(() => {
    if (leaving || typeof document === 'undefined') return undefined
    const previous = document.activeElement
    const dialog = dialogRef.current
    const layer = layerRef.current
    dialog?.focus?.({ preventScroll: true })

    const savedInert = new Map()
    if (layer && document.body) {
      let ownRoot = layer
      while (ownRoot.parentElement && ownRoot.parentElement !== document.body) {
        ownRoot = ownRoot.parentElement
      }
      if (ownRoot.parentElement === document.body) {
        for (const sibling of Array.from(document.body.children)) {
          if (sibling === ownRoot) continue
          savedInert.set(sibling, sibling.inert)
          sibling.inert = true
        }
      }
    }

    const onKeyDown = (event) => {
      if (event.key !== 'Tab' || event.defaultPrevented || !dialog) return
      const list = focusablesIn(dialog)
      if (list.length === 0) {
        event.preventDefault()
        dialog.focus?.({ preventScroll: true })
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement
      const inside = active && typeof dialog.contains === 'function' && dialog.contains(active)
      if (event.shiftKey) {
        if (!inside || active === dialog || active === first) {
          event.preventDefault()
          last.focus?.({ preventScroll: true })
        }
      } else if (!inside || active === dialog || active === last) {
        event.preventDefault()
        first.focus?.({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      for (const [el, prev] of savedInert) el.inert = prev
      savedInert.clear()
      const active = document.activeElement
      const shouldRestore = active === null
        || active === document.body
        || active === document.documentElement
        || (dialog && typeof dialog.contains === 'function' && dialog.contains(active))
      if (shouldRestore && previous && typeof previous.focus === 'function' && previous.isConnected !== false) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [leaving])

  const cleanCurrent = cleanSemver(current)
  const entry = useMemo(
    () => (cleanCurrent ? getReleaseEntry(cleanCurrent, releases) : null),
    [cleanCurrent, releases],
  )
  const block = useMemo(
    () => (entry ? localizeBlock(entry, locale) : null),
    [entry, locale],
  )

  const titleText = cleanCurrent
    ? t("What's new in v{version}", { version: cleanCurrent })
    : t('Release notes')
  const subtitle = entry?.date || ''

  const changelogHref = typeof notesUrl === 'string' && notesUrl.startsWith('https://')
    ? notesUrl
    : DEFAULT_RELEASES_URL

  return h('div', { ref: layerRef, className: 'bt-rn-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onClick: () => { if (!leaving) onClose?.() } }),
    h('div', {
      ref: dialogRef,
      tabIndex: -1,
      className: 'bt-rn-dialog',
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': titleId,
    },
    h('div', { className: 'bt-rn-head' },
      h('span', { className: 'bt-rn-mark', 'aria-hidden': true },
        h(BotMark, { look: MAIN_LOOK, bot: { id: 'release-notes' }, size: 36, state: 'idle' })),
      h('div', { className: 'bt-rn-head-copy' },
        h('h2', { id: titleId, className: 'bt-rn-title' }, titleText),
        subtitle ? h('span', { className: 'bt-rn-sub' }, subtitle) : null),
      h('button', {
        type: 'button',
        className: 'bt-icon-btn bt-rn-close',
        'aria-label': t('Close'),
        onClick: () => { if (!leaving) onClose?.() },
      }, h(CloseIcon))),
    h('div', { className: 'bt-rn-body' },
      entry && block
        ? h('section', { className: 'bt-rn-section', 'data-version': entry.version },
            block.intro ? h('p', { className: 'bt-rn-intro' }, block.intro) : null,
            h('ul', { className: 'bt-rn-list' },
              block.items.map((item, idx) => h('li', { key: `${entry.version}-${idx}`, className: 'bt-rn-item' },
                h('span', { className: 'bt-rn-dot', 'aria-hidden': true }),
                h('span', { className: 'bt-rn-text' }, item)))),
            block.outro ? h('p', { className: 'bt-rn-outro' }, block.outro) : null)
        : h('p', { className: 'bt-rn-empty' }, t('No release notes for this version yet.'))),
    h('div', { className: 'bt-rn-foot' },
      h('a', {
        className: 'bt-rn-link',
        href: changelogHref,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, t('Full changelog')),
      h('button', {
        type: 'button',
        className: 'bt-send bt-rn-ok',
        onClick: () => { if (!leaving) onClose?.() },
      }, t('Got it')))))
}
