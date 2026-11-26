// Transcript Plan Card for DSH's `exit_plan_mode` tool call, registered into
// `tool.call.toolview` at BUILTIN priority (100) so user/plugin overrides still win.
import { createElement as h, useState } from 'react'
import { MarkdownText, writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { CheckIcon, ChevronRightIcon, CopyIcon } from '../../../ds-bot/src/client/icons.js'
import { PlanModeIcon } from './classic-controls.js'
import { extractPlanHeading } from './classic-questions.js'
import { TOOL_VIEW_SLOT, slots as defaultSlots } from './slots.js'

const PLAN_VIEW_PRIORITY = 100

function readPlanMarkdown(block) {
  const fromArgs = block?.args?.text?.('plan')
  if (typeof fromArgs === 'string' && fromArgs.trim() !== '') return fromArgs
  const raw = block?.call?.argsRaw ?? block?.argsRaw
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed?.plan === 'string') return parsed.plan
    } catch { /* partial/malformed args */ }
  }
  return ''
}

function readResultText(block) {
  const parts = Array.isArray(block?.content) ? block.content : []
  return parts
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n')
    .trim()
}

export function planStatusOf(block) {
  if (!block || block.phase === 'preparing' || block.phase === 'start') {
    return { tone: 'pending', label: t('Pending review') }
  }
  if (block.isError === true) {
    return { tone: 'warn', label: t('Changes requested') }
  }
  const text = readResultText(block)
  try {
    const parsed = JSON.parse(text)
    if (parsed?.approved === true) return { tone: 'ok', label: t('Approved') }
    if (parsed?.approved === false) return { tone: 'muted', label: t('Dismissed') }
  } catch { /* non-JSON text result */ }
  return { tone: 'ok', label: t('Approved') }
}

export function ClassicPlanCard({ block }) {
  const planMarkdown = readPlanMarkdown(block)
  const title = extractPlanHeading(planMarkdown) || t('Plan')
  const status = planStatusOf(block)
  const pending = status.tone === 'pending'
  const [open, setOpen] = useState(() => pending || status.tone === 'ok')
  const [copied, setCopied] = useState(false)
  const resultText = block?.isError ? readResultText(block) : ''

  const copyPlan = async (event) => {
    event.stopPropagation()
    if (!planMarkdown) return
    const ok = await writeClipboard(planMarkdown)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }
  }

  return h('div', {
    className: 'dsb-plan-card',
    'data-plan-card': '',
    'data-open': open ? '' : undefined,
    'data-tone': status.tone,
  },
  h('div', { className: 'dsb-plan-card-bar' },
    h('button', {
      type: 'button',
      className: 'dsb-plan-card-head',
      'aria-expanded': open,
      onClick: () => setOpen(value => !value),
    },
    h('span', { className: 'dsb-plan-card-ico', 'aria-hidden': true }, h(PlanModeIcon)),
    h('span', { className: 'dsb-plan-card-title' }, title),
    h('span', { className: 'dsb-plan-badge', 'data-tone': status.tone }, status.label),
    h('span', { className: 'dsb-plan-card-chev', 'aria-hidden': true }, h(ChevronRightIcon))),
    planMarkdown ? h('button', {
      type: 'button',
      className: 'dsb-plan-card-copy',
      'aria-label': copied ? t('Copied') : t('Copy plan'),
      title: copied ? t('Copied') : t('Copy plan'),
      onClick: copyPlan,
    }, copied ? h(CheckIcon) : h(CopyIcon)) : null),
  open && planMarkdown ? h('div', { className: 'dsb-plan-card-body' },
    h(MarkdownText, { text: planMarkdown })) : null,
  resultText ? h('div', { className: 'dsb-plan-card-note' }, resultText) : null)
}

export function registerClassicPlanView(registry = defaultSlots) {
  return registry.register(
    { name: TOOL_VIEW_SLOT, key: 'exit_plan_mode', id: 'ds-bot.classic-plan-card', priority: PLAN_VIEW_PRIORITY },
    ClassicPlanCard,
  )
}
