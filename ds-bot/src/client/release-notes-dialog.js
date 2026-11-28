// Shared in-app "What's new" / release-notes dialog used by both the desktop app UI
// and the DSH plugin client. Reads offline release data generated from release-notes.json
// and CHANGELOG.md, follows --bt-* theme tokens, and shows only the current version's
// highlights (with a footer link to the full GitHub changelog for earlier releases).
import { createElement as h, useId, useMemo, useRef } from 'react'
import { MAIN_LOOK } from './characters.js'
import { language, t } from './i18n.js'
import { CloseIcon } from './icons.js'
import { toTraditional } from './locales/zh-tw.js'
import { BotMark } from './mark.js'
import { Dialog } from './ui/dialog.js'
import {
  cleanSemver,
  getReleaseEntry,
  RELEASE_NOTES,
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

export function ReleaseNotesDialog({
  current = null,
  notesUrl = null,
  releases = RELEASE_NOTES,
  leaving = false,
  onClose,
}) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const locale = language()

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

  return h(Dialog, {
    open: true,
    leaving,
    dialogRef,
    initialFocusRef: dialogRef,
    ariaLabelledBy: titleId,
    escapePriority: 20,
    focusTrap: true,
    maskClassName: 'bt-rn-layer',
    scrimClassName: 'bt-scrim',
    className: 'bt-rn-dialog',
    onClose,
    header: h('div', { className: 'bt-rn-head' },
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
  },
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
    }, t('Got it'))))
}
