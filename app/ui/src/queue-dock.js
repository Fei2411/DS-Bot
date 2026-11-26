// Queued message dock above the composer for both Bot chats and Classic sessions.
// Shows user-authored messages waiting in `inbox['next-turn']` with actions to
// withdraw back into the composer, edit inline, delete, or steer into the running turn now.
import { createElement as h, Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { isImeComposing } from '../../../ds-bot/src/client/enter-key.js'
import { fileSizeText } from '../../../ds-bot/src/client/dsh-primitives.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, CloseIcon, PaperclipIcon, PencilIcon, QueueIcon, TrashIcon } from '../../../ds-bot/src/client/icons.js'

const OWN_QUEUE_KINDS = new Set(['user', 'schedule', 'user-question-reply'])
const EMPTY_ROWS = Object.freeze([])

function WithdrawIcon() {
  return h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M7.5 6.5L4 10l3.5 3.5' }),
    h('path', { d: 'M4.5 10h7a4 4 0 0 1 0 8H9' }))
}

export function queueRowText(content) {
  const blocks = Array.isArray(content) ? content : []
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

function isPureText(content) {
  const blocks = Array.isArray(content) ? content : []
  return blocks.length > 0 && blocks.every(block => block?.type === 'text')
}

function queueAttachments(content) {
  const out = []
  for (const block of Array.isArray(content) ? content : []) {
    if ((block?.type === 'image' || block?.type === 'file') && block.attachment !== undefined) {
      out.push({ type: block.type, attachment: block.attachment })
    }
  }
  return out
}

function QueueFile({ attachment, label }) {
  const size = fileSizeText(attachment.bytes)
  return h('span', { className: 'bt-queue-file', 'aria-label': label, title: attachment.name },
    h('span', { className: 'bt-queue-fileicon', 'aria-hidden': true }, h(PaperclipIcon)),
    h('span', { className: 'bt-queue-filename' }, attachment.name),
    size !== '' ? h('span', { className: 'bt-queue-filesize' }, size) : null)
}

function QueueThumb({ sessionId, attachment, label }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    const id = attachment?.attachmentId
    if (!sessionId || !id) return undefined
    let alive = true
    void Promise.resolve(call('image', { sessionId, attachmentId: id, preview: true }))
      .then((res) => {
        if (alive && res?.mime && res?.data) setSrc(`data:${res.mime};base64,${res.data}`)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [sessionId, attachment?.attachmentId])
  return src === null
    ? h('span', { className: 'bt-queue-thumb', 'aria-hidden': true })
    : h('img', { className: 'bt-queue-thumb', src, alt: label })
}

function QueueInlineEdit({ text, onChange, onSave, onCancel }) {
  const field = useRef(null)
  useEffect(() => {
    const node = field.current
    if (!node) return
    node.focus()
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [text])
  return h('textarea', {
    ref: field,
    className: 'bt-queue-edit',
    value: text,
    rows: 1,
    'aria-label': t('Edit queued message'),
    onChange: event => onChange(event.target.value),
    onKeyDown: (event) => {
      if (isImeComposing(event)) return
      if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSave() }
    },
  })
}

function RowButton({ label, title, disabled, onClick, children }) {
  return h('button', {
    type: 'button',
    className: 'bt-queue-action',
    'aria-label': label,
    title: title ?? label,
    disabled,
    onClick,
  }, children)
}

export function DesktopQueueDock({ sessionId, running = false, readOnly = false, useSessionQueues, actions, onWithdraw, classic = false }) {
  const rawQueue = useSessionQueues?.(map => map?.[sessionId] ?? EMPTY_ROWS) ?? EMPTY_ROWS
  const queue = useMemo(
    () => rawQueue.filter(row => row && typeof row.id === 'string' && OWN_QUEUE_KINDS.has(row.source?.kind)),
    [rawQueue],
  )
  const [collapsed, setCollapsed] = useState(false)
  const [editing, setEditing] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const listId = useId()

  useEffect(() => {
    if (queue.length === 0) {
      setCollapsed(false)
      setEditing(null)
      return
    }
    if (editing !== null && (readOnly || !queue.some(row => row.id === editing.id))) setEditing(null)
  }, [queue, editing, readOnly])

  if (queue.length === 0) return null

  const interactionActive = !readOnly && (editing !== null || busyId !== null)
  const expanded = !collapsed || interactionActive
  const listVisible = queue.length === 1 || expanded

  const runAction = async (itemId, action, failureText) => {
    if (readOnly || busyId !== null) return null
    setBusyId(itemId)
    try {
      const res = await actions.updateSessionQueue(sessionId, itemId, action)
      return res
    } catch {
      actions?.reportError?.(new Error(failureText), 'queue')
      return null
    } finally {
      setBusyId(current => (current === itemId ? null : current))
    }
  }

  const withdrawRow = async (row) => {
    const text = queueRowText(row.content)
    const res = await runAction(row.id, { kind: 'remove' }, t('Couldn’t delete the queued message — it may have started already.'))
    if (res?.accepted === true && text !== '') {
      onWithdraw?.(text)
    }
  }

  const saveEdit = async () => {
    if (editing === null || editing.text.trim() === '') return
    const res = await runAction(
      editing.id,
      { kind: 'edit', text: editing.text },
      t('Couldn’t edit the queued message — it may have started already.'),
    )
    if (res !== null) setEditing(null)
  }

  return h('div', {
    className: classic ? 'bt-queue-dock dsb-queue-dock dsb-queue-classic' : 'bt-queue-dock dsb-queue-dock',
    'data-queue-dock': '',
  },
  h('div', { className: 'bt-queue-panel' },
    queue.length > 1 ? h('button', {
      type: 'button',
      className: 'bt-queue-head',
      'aria-controls': listId,
      'aria-expanded': expanded,
      disabled: interactionActive,
      onClick: () => setCollapsed(value => !value),
    },
    h('span', { className: 'bt-queue-lead', 'aria-hidden': true }, h(QueueIcon)),
    h('span', { className: 'bt-queue-count' }, t('{n} queued messages', { n: queue.length })),
    h('span', { className: 'bt-queue-chev', 'aria-hidden': true }, expanded ? h(ChevronDownIcon) : h(ChevronUpIcon))) : null,
    h('ul', { id: listId, className: 'bt-queue-list', hidden: !listVisible },
      listVisible ? queue.map((row) => {
        const attachments = queueAttachments(row.content)
        const text = queueRowText(row.content)
        const editable = isPureText(row.content)
        const canWithdraw = text.trim() !== '' && attachments.length === 0
        const isEditing = editing?.id === row.id
        const isBusy = busyId !== null
        return h('li', { key: row.id, className: 'bt-queue-row', 'data-queue-id': row.id },
          queue.length === 1 ? h('span', { className: 'bt-queue-lead', 'aria-hidden': true }, h(QueueIcon)) : null,
          isEditing
            ? h(QueueInlineEdit, {
              text: editing.text,
              onChange: value => setEditing({ id: row.id, text: value }),
              onSave: () => { void saveEdit() },
              onCancel: () => setEditing(null),
            })
            : h(Fragment, null,
              attachments.length > 0 ? h('span', { className: 'bt-queue-attachments' },
                attachments.map((item, idx) => (item.type === 'image'
                  ? h(QueueThumb, { key: `${item.attachment.attachmentId ?? idx}:${idx}`, sessionId, attachment: item.attachment, label: t('Queued image') })
                  : h(QueueFile, { key: `${item.attachment.attachmentId ?? item.attachment.name}:${idx}`, attachment: item.attachment, label: t('Queued file {name}', { name: item.attachment.name }) })))) : null,
              h('span', { className: 'bt-queue-preview', title: text || undefined }, text)),
          !readOnly ? h('div', { className: 'bt-queue-actions dsb-queue-actions' },
            isEditing
              ? h(Fragment, null,
                h(RowButton, { label: t('Save queued message'), disabled: isBusy || editing.text.trim() === '', onClick: () => { void saveEdit() } }, h(CheckIcon)),
                h(RowButton, { label: t('Cancel editing'), disabled: isBusy, onClick: () => setEditing(null) }, h(CloseIcon)))
              : h(Fragment, null,
                onWithdraw ? h(RowButton, {
                  label: t('Withdraw to input'),
                  title: canWithdraw ? t('Withdraw to input') : t('Contains non-text content'),
                  disabled: isBusy || !canWithdraw,
                  onClick: () => { void withdrawRow(row) },
                }, h(WithdrawIcon)) : null,
                h(RowButton, {
                  label: t('Edit queued message'),
                  title: editable ? t('Edit queued message') : t('Contains non-text content, so editing is not supported yet'),
                  disabled: isBusy || !editable,
                  onClick: () => { if (editable) setEditing({ id: row.id, text }) },
                }, h(PencilIcon)),
                h(RowButton, {
                  label: t('Delete queued message'),
                  disabled: isBusy,
                  onClick: () => { void runAction(row.id, { kind: 'remove' }, t('Couldn’t delete the queued message — it may have started already.')) },
                }, h(TrashIcon)),
                h(RowButton, {
                  label: t('Send now'),
                  title: running ? t('Send now') : t('Only while a turn is running'),
                  disabled: isBusy || !running,
                  onClick: () => { void runAction(row.id, { kind: 'steer' }, t('Couldn’t steer the queued message. Try again.')) },
                }, h(ArrowUpIcon)))) : null)
      }) : null)))
}
