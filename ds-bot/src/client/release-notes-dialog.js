// Shared in-app "What's new" / release-notes dialog used by both the desktop app UI
// and the DSH plugin client. Reads offline release data generated from release-notes.json
// and CHANGELOG.md, follows --bt-* theme tokens, and supports both post-upgrade auto-pop
// (single or multi-version) and About-page replay with collapsible history.
import { createElement as h, useEffect, useId, useMemo, useRef, useState } from 'react'
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
  releasesUpTo,
  selectReleaseNotes,
} from '../shared/release-notes.js'

const DEFAULT_RELEASES_URL = 'https://github.com/Fei-Craft/DS-Bot/releases'

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

function ReleaseBlock({ entry, locale, showVersionHead }) {
  const block = useMemo(() => localizeBlock(entry, locale), [entry, locale])
  if (block === null) return null
  return h('section', { className: 'bt-rn-section', 'data-version': entry.version },
    showVersionHead
      ? h('div', { className: 'bt-rn-ver-head' },
          h('span', { className: 'bt-rn-ver-pill' }, `v${entry.version}`),
          entry.date ? h('span', { className: 'bt-rn-ver-date' }, entry.date) : null)
      : null,
    block.intro ? h('p', { className: 'bt-rn-intro' }, block.intro) : null,
    h('ul', { className: 'bt-rn-list' },
      block.items.map((item, idx) => h('li', { key: `${entry.version}-${idx}`, className: 'bt-rn-item' },
        h('span', { className: 'bt-rn-dot', 'aria-hidden': true }),
        h('span', { className: 'bt-rn-text' }, item)))),
    block.outro ? h('p', { className: 'bt-rn-outro' }, block.outro) : null)
}

export function ReleaseNotesDialog({
  mode = 'manual',
  current = null,
  versions = null,
  notesUrl = null,
  releases = RELEASE_NOTES,
  leaving = false,
  onClose,
}) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const [showEarlier, setShowEarlier] = useState(false)
  const locale = language()

  // Escape closes only this topmost layer (priority > Settings dialog).
  useEscape(() => { if (!leaving) onClose?.() }, !leaving, { priority: 20 })

  // Save prior focus on mount, move keyboard focus into the dialog container (without
  // drawing an unsolicited button focus ring on open), and restore focus on close.
  useEffect(() => {
    const previous = typeof document !== 'undefined' ? document.activeElement : null
    dialogRef.current?.focus?.({ preventScroll: true })
    return () => {
      if (previous && typeof previous.focus === 'function' && previous.isConnected !== false) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [])

  const cleanCurrent = cleanSemver(current)
  const allHistory = useMemo(() => releasesUpTo(cleanCurrent, releases), [cleanCurrent, releases])

  const primaryEntries = useMemo(() => {
    if (Array.isArray(versions) && versions.length > 0) {
      const resolved = versions.map(ver => getReleaseEntry(ver, releases)).filter(Boolean)
      if (resolved.length > 0) return resolved
    }
    if (cleanCurrent) {
      const exact = getReleaseEntry(cleanCurrent, releases)
      if (exact) return [exact]
    }
    return allHistory.length > 0 ? [allHistory[0]] : []
  }, [versions, cleanCurrent, releases, allHistory])

  const primarySet = useMemo(() => new Set(primaryEntries.map(entry => entry.version)), [primaryEntries])
  const earlierEntries = useMemo(
    () => (mode === 'manual' ? allHistory.filter(entry => !primarySet.has(entry.version)) : []),
    [mode, allHistory, primarySet],
  )

  const headlineVersion = cleanCurrent ?? primaryEntries[0]?.version ?? ''
  const multiPrimary = primaryEntries.length > 1
  const titleText = multiPrimary && headlineVersion
    ? t('Updated to v{version}', { version: headlineVersion })
    : headlineVersion
      ? t("What's new in v{version}", { version: headlineVersion })
      : t('Release notes')

  const subtitle = multiPrimary
    ? `v${primaryEntries[primaryEntries.length - 1].version} → v${primaryEntries[0].version}`
    : (primaryEntries[0]?.date || '')

  const changelogHref = typeof notesUrl === 'string' && notesUrl.startsWith('https://')
    ? notesUrl
    : DEFAULT_RELEASES_URL

  return h('div', { className: 'bt-rn-layer', 'data-leaving': leaving || undefined },
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
      primaryEntries.length > 0
        ? primaryEntries.map(entry => h(ReleaseBlock, {
            key: entry.version,
            entry,
            locale,
            showVersionHead: multiPrimary,
          }))
        : h('p', { className: 'bt-rn-empty' }, t('No release notes for this version yet.')),
      earlierEntries.length > 0
        ? h('div', { className: 'bt-rn-history' },
            h('button', {
              type: 'button',
              className: 'bt-rn-history-toggle',
              'aria-expanded': showEarlier,
              onClick: () => setShowEarlier(open => !open),
            }, showEarlier ? t('Hide earlier versions') : t('Earlier versions')),
            showEarlier
              ? h('div', { className: 'bt-rn-history-list' },
                  earlierEntries.map(entry => h(ReleaseBlock, {
                    key: entry.version,
                    entry,
                    locale,
                    showVersionHead: true,
                  })))
              : null)
        : null),
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
