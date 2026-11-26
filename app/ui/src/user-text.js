// User message text renderer for the desktop app's own window.
// Applies a deterministic, non-overlapping priority pipeline:
//   1. Credential masking (per-secret reveal toggle; masked by default)
//   2. Bot @mentions (when bots are provided)
//   3. File and folder references (`@path`, `@"quoted"`, explicit paths)
import { createElement as h, Fragment, useMemo } from 'react'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { EyeIcon, HideIcon } from '../../../ds-bot/src/client/icons.js'
import { BotMark } from '../../../ds-bot/src/client/mark.js'
import { userTextParts } from '../../../ds-bot/src/client/user-message.js'
import { detectSecrets, maskSecrets, projectSecretsToSlice } from '../../../ds-bot/src/shared/secret-mask.js'
import { extractUserFileRefs, FileRefChip } from './file-references.js'

const URL_HOST_TAIL_RE = /^@[^\s"'`<>()[\]{}]+/

/**
 * Splits `text` into ordered non-overlapping segments of kinds:
 * `'text' | 'secret' | 'mention' | 'file'`.
 * When `fullText` is provided (e.g. for folded messages), secret detection runs on `fullText`
 * and projects onto `text`, preventing fold cuts from unmasking credentials or changing keys.
 */
export function tokenizeUserText(text, { bots = [], detectFiles = true, fullText = null } = {}) {
  if (typeof text !== 'string' || text === '') return []
  const secrets = typeof fullText === 'string' && fullText !== text
    ? projectSecretsToSlice(fullText, text)
    : detectSecrets(text)
  const segments = []
  let cursor = 0

  const pushNonSecret = (chunk, { afterUrlPassword = false } = {}) => {
    if (chunk === '') return
    let rest = chunk
    if (afterUrlPassword && rest.startsWith('@')) {
      const tail = URL_HOST_TAIL_RE.exec(rest)
      if (tail) {
        segments.push({ kind: 'text', text: tail[0] })
        rest = rest.slice(tail[0].length)
        if (rest === '') return
      }
    }
    const mentionParts = bots.length > 0 ? userTextParts(rest, bots) : [{ text: rest }]
    for (const part of mentionParts) {
      if (part.bot) {
        segments.push({ kind: 'mention', bot: part.bot, label: part.label })
        continue
      }
      if (!detectFiles) {
        if (part.text !== '') segments.push({ kind: 'text', text: part.text })
        continue
      }
      const refs = extractUserFileRefs(part.text)
      if (refs.length === 0) {
        if (part.text !== '') segments.push({ kind: 'text', text: part.text })
        continue
      }
      let refCursor = 0
      for (const ref of refs) {
        if (ref.start > refCursor) {
          segments.push({ kind: 'text', text: part.text.slice(refCursor, ref.start) })
        }
        segments.push({ kind: 'file', raw: ref.raw, target: ref.target })
        refCursor = ref.end
      }
      if (refCursor < part.text.length) {
        segments.push({ kind: 'text', text: part.text.slice(refCursor) })
      }
    }
  }

  let prevKind = null
  for (const span of secrets) {
    if (span.start > cursor) {
      pushNonSecret(text.slice(cursor, span.start), { afterUrlPassword: prevKind === 'url-password' })
    }
    segments.push({ kind: 'secret', span })
    cursor = span.end
    prevKind = span.kind
  }
  if (cursor < text.length) {
    pushNonSecret(text.slice(cursor), { afterUrlPassword: prevKind === 'url-password' })
  }
  return segments
}

/**
 * Returns the text that Copy should put on the clipboard: keeps unrevealed credentials
 * masked and copies revealed credentials as raw text.
 */
export function copyableUserText(text, revealedKeys) {
  return maskSecrets(text ?? '', revealedKeys)
}

function SecretSpan({ span, revealed, interactive, onToggle }) {
  const toggleLabel = revealed ? t('Hide secret') : t('Reveal secret')
  const shown = revealed ? span.raw : span.masked
  return h('span', {
    className: `dsb-secret${revealed ? ' is-revealed' : ''}`,
    'data-secret-masked': revealed ? undefined : '',
    'data-secret-kind': span.kind,
  },
  h('span', { className: 'dsb-secret-val' }, shown),
  interactive
    ? h('button', {
      type: 'button',
      className: 'dsb-secret-toggle',
      'aria-pressed': revealed,
      'aria-label': toggleLabel,
      title: toggleLabel,
      onClick: (event) => {
        event.stopPropagation()
        onToggle?.(span.key)
      },
    }, revealed ? h(HideIcon) : h(EyeIcon))
    : null)
}

/**
 * Renders user message text with credential masking, per-secret reveal toggles,
 * Bot @mentions, and clickable file/folder references.
 */
export function UserMessageText({
  text,
  fullText = null,
  bots = [],
  revealedSecrets = null,
  onToggleSecret,
  onOpenBot,
  onOpenFile,
  onRevealFolder,
  interactive = true,
}) {
  const canOpenFiles = interactive && (typeof onOpenFile === 'function' || typeof onRevealFolder === 'function')
  const segments = useMemo(
    () => tokenizeUserText(text ?? '', { bots, detectFiles: canOpenFiles, fullText }),
    [text, fullText, bots, canOpenFiles],
  )
  return segments.map((seg, index) => {
    if (seg.kind === 'secret') {
      const revealed = interactive && revealedSecrets instanceof Set && revealedSecrets.has(seg.span.key)
      return h(SecretSpan, {
        key: `s:${seg.span.key}:${index}`,
        span: seg.span,
        revealed,
        interactive,
        onToggle: onToggleSecret,
      })
    }
    if (seg.kind === 'mention') {
      if (!interactive || typeof onOpenBot !== 'function') {
        return h('span', { key: `m:${index}`, className: 'bt-umention is-static' },
          h(BotMark, { bot: seg.bot, size: 16 }), seg.label)
      }
      return h('button', {
        key: `m:${index}`,
        type: 'button',
        className: 'bt-umention',
        title: `@${seg.bot.name}`,
        onClick: () => onOpenBot(seg.bot.id),
      }, h(BotMark, { bot: seg.bot, size: 16 }), seg.label)
    }
    if (seg.kind === 'file') {
      return h(FileRefChip, {
        key: `f:${index}`,
        target: seg.target,
        onOpenFile,
        onRevealFolder,
      })
    }
    return h(Fragment, { key: `t:${index}` }, seg.text)
  })
}
