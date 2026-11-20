// DeepSeek services: independent OCR a DeepSeek API key can add to any main model.
// The key stays in DSH's own Models page; this page only reads the host's status
// (never the key itself) and saves which capabilities are on. Speech controls
// stay on their own change.
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { hostText, t } from './i18n.js'

// The page brings its own sheet: it is mounted only while the page is shown, so the
// client's compiled-style entry (index.js) needs no change for this page.
export const SERVICES_CSS = `
.bt-svc{display:grid;gap:20px}
.bt-svc-state{display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--bt-ink-2);white-space:nowrap}
.bt-svc-state[data-state=missing]{color:var(--bt-danger)}
.bt-svc-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--bt-ink-3);corner-shape:round}
.bt-svc-state[data-state=ready] .bt-svc-dot{background:var(--bt-green)}
.bt-svc-state[data-state=missing] .bt-svc-dot{background:var(--bt-danger)}
.bt-svc-line{padding:0 12px 10px}
.bt-svc-line .bt-svc-state{white-space:normal}
.bt-svc-key{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-svc-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-svc-note{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-svc .bt-svc-seg button{white-space:nowrap}
.bt-svc :focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
`

const DEFAULTS = { ocr: false }

// A capability's state comes from the host, not from the preference. A missing
// credential wins over `enabled`: the preference can be on while the service is
// not configured, and that must never read as ready.
function capabilityState(cap) {
  if (!cap) return { state: 'off', text: t('Off') }
  const usable = cap.supported !== false && cap.configured !== false
  const reason = cap.reason ? hostText(String(cap.reason)) : ''
  if (!usable) return { state: 'missing', text: reason || t('Not ready') }
  if (cap.enabled) return { state: 'ready', text: t('Ready') }
  return { state: 'off', text: reason || t('Off') }
}

function StateLine({ view }) {
  return h('div', { className: 'bt-svc-line' },
    h('div', { className: 'bt-svc-state', 'data-state': view.state, role: 'status' },
      h('span', { className: 'bt-svc-dot', 'aria-hidden': true }),
      h('span', null, view.text)))
}

function Pill({ state, text }) {
  return h('span', { className: 'bt-svc-state', 'data-state': state },
    h('span', { className: 'bt-svc-dot', 'aria-hidden': true }),
    h('span', null, text))
}

// Pure rendering half, so a mock UI test can drive it with a fixed host status.
export function ServicesForm({ status, busy, saved, pluginsAvailable,
  save, onOpenModels, onOpenPlugins, Section, Row, Switch }) {
  const prefs = { ...DEFAULTS, ...status?.preferences }
  const key = status?.key ?? {}
  const ready = status !== null
  const ocrView = capabilityState(status?.ocr)
  return h('div', { className: 'bt-svc' },
    h('style', { 'data-ds-bot': 'deepseek-services' }, SERVICES_CSS),
    h(Section, { key: 'key', title: t('DeepSeek API') },
      h(Row, { label: t('API key') },
        h('div', { className: 'bt-svc-actions' },
          h(Pill, { state: key.configured ? 'ready' : 'missing', text: key.configured ? t('Key set') : t('Needs an API key') }),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onOpenModels }, t('Manage models')))),
      status?.endpoint ? h('div', { className: 'bt-svc-line' }, h('span', { className: 'bt-svc-key' }, status.endpoint)) : null,
      // DSH's Web search switch is a Plugins page item, not a settings section:
      // Plugins → Web search turns on the new API for search and fetch.
      h(Row, { label: t('DeepSeek Web Search API'), hint: t('Find it in Plugins → Web search.') },
        pluginsAvailable ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onOpenPlugins }, t('Open Plugins')) : null),
      h('div', { className: 'bt-svc-line' },
        h('span', { className: 'bt-svc-note', role: 'status' }, saved ? t('Saved.') : busy ? t('Saving…') : ''))),
    h(Section, { key: 'ocr', title: t('Image and document reading') },
      h(Row, {
        label: t('Use DeepSeek to read images and documents'),
        hint: t('Bots upload selected files to DeepSeek for text recognition; local Office editing is unchanged.'),
      }, h(Switch, {
        label: t('Use DeepSeek to read images and documents'), on: prefs.ocr === true, disabled: busy || !ready,
        onChange: on => save({ ocr: on }),
      })),
      h(StateLine, { view: ocrView })))
}

export function DeepSeekServicesPage({ actions, run, Section, Row, Switch }) {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loadError, setLoadError] = useState('')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    void Promise.resolve().then(() => actions.deepseekServices()).then(value => {
      if (alive.current && value) setStatus(value)
    }).catch(failure => { if (alive.current) setLoadError(hostText(failure?.message ?? String(failure))) })
  }, [])
  useEffect(() => {
    if (!saved) return undefined
    const timer = setTimeout(() => { if (alive.current) setSaved(false) }, 2600)
    return () => clearTimeout(timer)
  }, [saved])
  const save = patch => {
    if (busy || status === null) return
    setBusy(true)
    setSaved(false)
    let next = null
    void run(Promise.resolve().then(() => actions.setDeepseekServices(patch)).then(value => { next = value }))
      .then(ok => {
        if (!alive.current) return
        if (ok && next) { setStatus(next); setSaved(true) }
      })
      .finally(() => { if (alive.current) setBusy(false) })
  }
  const pluginsAvailable = typeof actions.hasPlugins !== 'function' || actions.hasPlugins() !== false
  return h(Fragment, null,
    loadError ? h('div', { className: 'bt-error', role: 'alert' }, loadError) : null,
    h(ServicesForm, {
      status, busy, saved, pluginsAvailable,
      save, onOpenModels: () => actions.openModels?.(),
      // DSH's Plugins page opens behind this dialog; close it first or the user
      // cannot see or reach what openPlugins() navigated to.
      onOpenPlugins: () => { actions.closeSettings?.(); actions.openPlugins?.() },
      Section, Row, Switch,
    }))
}
