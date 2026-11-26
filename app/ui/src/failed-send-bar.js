// Failed-send recovery bar shown above the composer when a message fails to send
// while the user is already typing the next message (or after switching back).
// Never overwrites the user's active draft; lets them Retry, Restore to input, or Dismiss.
import { createElement as h } from 'react'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { CloseIcon } from '../../../ds-bot/src/client/icons.js'

// Failed sends held per chat when a send rejects while the user is already typing
// or after switching away to another chat. Keeps their preview URLs alive until
// retried, restored into the composer, dismissed, or the owning chat is deleted.
export const pendingFailedByChat = new Map()
export const heldFailedUrls = new Set()
export const inFlightUrls = new Set()

export function revokeUrl(url) {
  if (url && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}

export function trackFailedUrls(items, hold) {
  for (const item of items ?? []) {
    if (!item?.previewUrl) continue
    if (hold) heldFailedUrls.add(item.previewUrl)
    else heldFailedUrls.delete(item.previewUrl)
  }
}

export function trackInFlightUrls(items, hold) {
  for (const item of items ?? []) {
    if (!item?.previewUrl) continue
    if (hold) inFlightUrls.add(item.previewUrl)
    else inFlightUrls.delete(item.previewUrl)
  }
}

export function pruneFailedSends(chatIds) {
  for (const chatId of chatIds ?? []) {
    const list = pendingFailedByChat.get(chatId)
    if (!list) continue
    pendingFailedByChat.delete(chatId)
    for (const entry of list) {
      for (const item of entry.items ?? []) {
        if (!item?.previewUrl) continue
        heldFailedUrls.delete(item.previewUrl)
        if (!inFlightUrls.has(item.previewUrl)) revokeUrl(item.previewUrl)
      }
    }
  }
}

export function clearFailedSends() {
  for (const list of pendingFailedByChat.values()) {
    for (const entry of list) {
      for (const item of entry.items ?? []) {
        if (item?.previewUrl) {
          heldFailedUrls.delete(item.previewUrl)
          revokeUrl(item.previewUrl)
        }
      }
    }
  }
  pendingFailedByChat.clear()
  heldFailedUrls.clear()
  inFlightUrls.clear()
}

function previewText(entry) {
  const flat = String(entry?.text ?? '').replace(/\s+/g, ' ').trim()
  if (flat !== '') return flat.length > 96 ? `${flat.slice(0, 95)}…` : flat
  const count = entry?.items?.length ?? 0
  if (count === 1) return t('1 attachment')
  if (count > 1) return t('{n} attachments', { n: count })
  return t('Message could not be sent')
}

export function FailedSendBar({ items, disabled = false, retryingId = null, onRetry, onRestore, onDismiss }) {
  if (!Array.isArray(items) || items.length === 0) return null
  return h('div', { className: 'dsb-failed-list', 'data-failed-sends': '', role: 'region', 'aria-label': t('Failed to send') },
    items.map((entry) => {
      const busy = retryingId === entry.id
      const attCount = entry.items?.length ?? 0
      const hasText = String(entry.text ?? '').trim() !== ''
      return h('div', { key: entry.id, className: 'dsb-failed-row', role: 'alert' },
        h('span', { className: 'dsb-failed-dot', 'aria-hidden': true }),
        h('div', { className: 'dsb-failed-copy' },
          h('div', { className: 'dsb-failed-top' },
            h('span', { className: 'dsb-failed-preview', title: entry.text || undefined }, previewText(entry)),
            hasText && attCount > 0 ? h('span', { className: 'dsb-failed-att' }, attCount === 1 ? t('1 attachment') : t('{n} attachments', { n: attCount })) : null),
          entry.error ? h('span', { className: 'dsb-failed-err' }, entry.error) : null),
        h('div', { className: 'dsb-failed-acts' },
          h('button', {
            type: 'button',
            className: 'dsb-failed-btn',
            disabled: disabled || busy,
            'aria-label': t('Retry send'),
            onClick: () => onRetry?.(entry),
          }, t('Retry')),
          h('button', {
            type: 'button',
            className: 'dsb-failed-btn',
            disabled: disabled || busy,
            'aria-label': t('Restore failed message to input'),
            onClick: () => onRestore?.(entry),
          }, t('Restore to input')),
          h('button', {
            type: 'button',
            className: 'dsb-failed-x',
            disabled: busy,
            'aria-label': t('Dismiss failed message'),
            title: t('Dismiss'),
            onClick: () => onDismiss?.(entry),
          }, h(CloseIcon))))
    }))
}
