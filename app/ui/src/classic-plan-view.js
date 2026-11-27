// Transcript Plan Card for DSH's `exit_plan_mode` tool call, registered into
// `tool.call.toolview` at BUILTIN priority (100) so user/plugin overrides still win.
import { createElement as h, useState } from 'react'
import { MarkdownText, writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon } from '../../../ds-bot/src/client/icons.js'
import { PlanModeIcon } from './classic-controls.js'
import { extractPlanHeading, stripPlanHeading } from './classic-questions.js'
import { TOOL_VIEW_SLOT, slots as defaultSlots } from './slots.js'

const PLAN_VIEW_PRIORITY = 100

// Real prose produced by `@deepseek-ai/dsh-plan-mode` (`exit_plan_mode`) and `@deepseek-ai/dsh-user-questions`
// (DSH's tool runner may also prepend `Error: ` when serializing `isError: true` results):
// - approved (isError: false):  "Plan approved — plan mode exited; carry out the plan starting with your next step."
// - dismissed (isError: false): "The user dismissed the plan review to reply in their own words; plan mode remains active."
// - keep planning (isError: true): "[Error: ]The user chose to keep planning; revise the plan and present it again."
//                               or "[Error: ]The user chose to keep planning; their feedback: <feedback>"
// - interrupted (isError: true, error.code === 'ASK_ABORTED'): "[Error: ]ask_user_question was aborted before the user answered"
const APPROVED_PROSE = /^Plan approved\b/i
const DISMISSED_PROSE = /^The user dismissed the plan review\b/i
const KEEP_PLANNING_PROSE = /^(?:Error:\s*)?The user chose to keep planning\b/i
const ABORTED_PROSE = /\baborted before the user answered\b/i

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
  const text = readResultText(block)
  const errorCode = block.error?.code
  if (block.isError === true) {
    if (KEEP_PLANNING_PROSE.test(text)) {
      return { tone: 'warn', label: t('Changes requested') }
    }
    if (errorCode === 'ASK_ABORTED' || ABORTED_PROSE.test(text)) {
      return { tone: 'muted', label: t('Interrupted') }
    }
    return { tone: 'error', label: t('Error') }
  }
  if (DISMISSED_PROSE.test(text)) {
    return { tone: 'muted', label: t('Dismissed') }
  }
  if (APPROVED_PROSE.test(text)) {
    return { tone: 'ok', label: t('Approved') }
  }
  return { tone: 'muted', label: t('Completed') }
}

export function ClassicPlanCard({ block }) {
  const planMarkdown = readPlanMarkdown(block)
  const title = extractPlanHeading(planMarkdown) || t('Plan')
  const bodyMarkdown = stripPlanHeading(planMarkdown, title)
  const status = planStatusOf(block)
  const pending = status.tone === 'pending'
  const [open, setOpen] = useState(() => pending || status.tone === 'ok')
  const [copied, setCopied] = useState(false)
  const rawResultText = block?.isError ? readResultText(block) : ''
  const resultText = status.tone === 'warn' || status.tone === 'muted'
    ? rawResultText.replace(/^Error:\s*/i, '')
    : rawResultText

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
    h('span', { className: 'dsb-plan-badge', 'data-tone': status.tone }, status.label)),
    h('div', { className: 'dsb-plan-card-tools' },
      planMarkdown ? h('button', {
        type: 'button',
        className: 'dsb-plan-card-tool',
        'aria-label': copied ? t('Copied') : t('Copy plan'),
        title: copied ? t('Copied') : t('Copy plan'),
        onClick: copyPlan,
      }, copied ? h(CheckIcon) : h(CopyIcon)) : null,
      h('button', {
        type: 'button',
        className: 'dsb-plan-card-tool',
        'aria-label': open ? t('Collapse plan') : t('Show full plan'),
        title: open ? t('Collapse plan') : t('Show full plan'),
        'aria-expanded': open,
        onClick: () => setOpen(value => !value),
      }, open ? h(ChevronUpIcon) : h(ChevronDownIcon)))),
  open && bodyMarkdown ? h('div', { className: 'dsb-plan-card-body' },
    h(MarkdownText, { text: bodyMarkdown })) : null,
  resultText ? h('div', { className: 'dsb-plan-card-note', 'data-tone': status.tone }, resultText) : null)
}

export function registerClassicPlanView(registry = defaultSlots) {
  return registry.register(
    { name: TOOL_VIEW_SLOT, key: 'exit_plan_mode', id: 'ds-bot.classic-plan-card', priority: PLAN_VIEW_PRIORITY },
    ClassicPlanCard,
  )
}
