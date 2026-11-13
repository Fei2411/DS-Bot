import { createElement as h, useState } from 'react'
import { BotAvatar } from './mark.js'
import { AgentBadge } from './agent-badge.js'
import { ModelMenu, modelOf } from './model-menu.js'
import { isLocalRoute, routeOf } from './agent-routes.js'
import { SKIP_LOCAL_AGENT, modelRefOf, runModelChange, summarizeModelChange } from './bot-model-batch.js'
import { t } from './i18n.js'

// Settings → Bot models: every Bot with its model, and one pick that moves the selected
// Bots together. How a Bot runs belongs to the Bot, so a Bot on a local agent is listed
// but cannot be selected; it changes only in its own settings.

export const modelLine = (bot, roster) => {
  const shown = modelOf(bot, roster)
  if (shown === undefined) return t('No model picked yet')
  return shown.served ? shown.name : t('{model} (not available)', { model: shown.name })
}

export const resultLine = (entry) => {
  if (entry.status === 'updated') return t('Changed')
  if (entry.status === 'unchanged') return t('Already on this model')
  if (entry.status === 'skipped') return entry.reason === SKIP_LOCAL_AGENT ? t('Skipped: runs on a local agent') : t('Skipped: not available now')
  return t('Could not change: {error}', { error: entry.message })
}

export const summaryLine = (results) => {
  const counts = summarizeModelChange(results)
  const parts = [t('Changed {count} of {total} Bots.', { count: counts.updated, total: counts.total })]
  if (counts.unchanged > 0) parts.push(t('Already on this model: {count}', { count: counts.unchanged }))
  if (counts.skipped > 0) parts.push(t('Skipped: {count}', { count: counts.skipped }))
  if (counts.failed > 0) parts.push(t('Failed: {count}', { count: counts.failed }))
  return parts.join(' · ')
}

export function BotModelsPage({ roster, actions, run, Section }) {
  const bots = roster.bots ?? []
  const [selected, setSelected] = useState(() => new Set())
  const [target, setTarget] = useState(undefined)
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)
  const eligible = bots.filter(bot => !isLocalRoute(modelRefOf(bot)))
  const resultsById = new Map((results ?? []).map(entry => [entry.id, entry]))
  const toggle = (id) => {
    if (busy) return
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const apply = (ref) => {
    if (busy) return
    const chosen = bots.filter(bot => selected.has(bot.id))
    if (chosen.length === 0) return
    setTarget(ref)
    setBusy(true)
    void runModelChange({ bots: chosen, ref, models: roster.models, updateBot: actions.updateBot })
      .then((out) => { setResults(out); setSelected(new Set()) })
      .finally(() => setBusy(false))
  }
  const picker = h(ModelMenu, {
    bot: { id: 'selected-bots', name: t('Selected Bots'), model: target }, roster, actions, run,
    wide: true, withEfforts: false, onPick: apply,
  })
  return [
    h(Section, { key: 'change', title: t('Change several Bots') },
      h('div', { className: 'bt-set-row bt-bm-bar' },
        h('span', { className: 'bt-set-copy' },
          h('span', null, t('{selected} of {total} selected', { selected: selected.size, total: bots.length })),
          h('span', { className: 'bt-set-hint' }, t('Bots on a local agent keep their own model.'))),
        h('div', { className: 'bt-set-control bt-bm-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || eligible.length === 0 || selected.size === eligible.length, onClick: () => setSelected(new Set(eligible.map(bot => bot.id))) }, t('Select all')),
          selected.size > 0 ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => setSelected(new Set()) }, t('Clear')) : null,
          busy ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: true }, t('Changing…'))
            : selected.size === 0 ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: true }, t('Choose a model')) : picker)),
      results === null ? null : h('div', { className: 'bt-set-row bt-bm-summary', role: 'status' },
        h('span', { className: 'bt-set-copy' }, h('span', null, summaryLine(results))))),
    h(Section, { key: 'bots', title: t('Bots · {count}', { count: bots.length }) },
      bots.map((bot) => {
        const local = isLocalRoute(modelRefOf(bot))
        const entry = resultsById.get(bot.id)
        return h('label', { key: bot.id, className: 'bt-set-row bt-bm-row', 'data-selected': selected.has(bot.id) ? '' : undefined, 'data-local': local ? '' : undefined },
          h('span', { className: 'bt-bm-check' },
            h('input', {
              type: 'checkbox', checked: selected.has(bot.id), disabled: local || busy,
              'aria-label': t('Select {name}', { name: bot.name }),
              onChange: () => toggle(bot.id),
            })),
          h(BotAvatar, { bot, size: 28, badge: false, live: false }),
          h('span', { className: 'bt-set-copy bt-bm-copy' },
            h('span', { className: 'bt-bm-name' },
              h('span', null, bot.name),
              local ? h('span', { className: 'bt-tag bt-bm-agent' }, h(AgentBadge, { engine: routeOf(modelRefOf(bot)), size: 13 }), t('Local agent')) : null,
              entry === undefined ? null : h('span', { className: 'bt-bm-out', 'data-state': entry.status }, resultLine(entry))),
            h('span', { className: 'bt-set-hint bt-bm-model' }, modelLine(bot, roster)),
            local ? h('span', { className: 'bt-set-hint' }, t("Change it in the Bot's settings.")) : null))
      })),
  ]
}

// The list keeps the settings page's card look; only the selection row and the per-Bot
// result lines are this page's own.
export const BOT_MODELS_CSS = `
.bt-bm-bar{flex-wrap:wrap}
.bt-bm-actions{flex-wrap:wrap;justify-content:flex-end}
.bt-bm-row{cursor:pointer;gap:10px}
.bt-bm-row[data-local]{cursor:default}
.bt-bm-row[data-selected]{background:var(--bt-active)}
.bt-bm-check{flex:none;display:inline-flex;align-items:center}
.bt-bm-check input{width:15px;height:15px;margin:0;accent-color:var(--bt-accent);cursor:inherit}
.bt-bm-check input:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-bm-copy{gap:2px}
.bt-bm-name{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.bt-bm-agent{display:inline-flex;align-items:center;gap:4px}
.bt-bm-model{overflow-wrap:anywhere}
.bt-bm-out{font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bt-bm-out[data-state=updated]{color:var(--bt-green)}
.bt-bm-out[data-state=failed]{color:var(--bt-danger)}
.bt-bm-summary .bt-set-copy>span{font-size:12.5px;line-height:17px;color:var(--bt-ink-2)}
`
