// DeepSeek services: independent OCR, TTS and dictation a DeepSeek API key can add
// to any main model. The key stays in DSH's own Models page; this page only reads the
// host's status (never the key itself) and saves which capabilities are on.
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
.bt-svc-state[data-state=warn] .bt-svc-dot{background:var(--bt-warn)}
.bt-svc-state[data-state=missing] .bt-svc-dot{background:var(--bt-danger)}
.bt-svc-line{padding:10px 16px}
.bt-svc-line .bt-svc-state{white-space:normal;align-items:flex-start}
.bt-svc-line .bt-svc-dot{margin-top:4.5px}
.bt-svc-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;min-width:0;max-width:100%}
@container (max-width:440px){.bt-svc-actions{justify-content:flex-start}}
.bt-svc-note{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-svc :focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
`

const DEFAULTS = { ocr: false, tts: 'system', voice: 'stella' }
const ASR_PROVIDER = 'deepseek-asr'
const voiceName = id => String(id).charAt(0).toUpperCase() + String(id).slice(1)

// A capability's state comes from the host, not from the preference. A missing
// credential wins over `enabled`: an enabled capability that cannot run shows the
// host reason, while an optional capability that is simply off stays quiet.
function capabilityState(cap) {
  if (!cap) return { state: 'off', text: t('Off') }
  const usable = cap.supported !== false && cap.configured !== false
  const reason = cap.reason ? hostText(String(cap.reason)) : ''
  if (!usable) {
    if (cap.enabled) return { state: 'missing', text: reason || t('Not ready') }
    return { state: 'off', text: t('Off') }
  }
  if (cap.enabled) return { state: 'ready', text: t('Ready') }
  return { state: 'off', text: t('Off') }
}

// The host reports no `enabled` for dictation; its real state is the existing
// speech Remote's selection plus registration and credentials.
function asrState(asr, selection, speechAvailable) {
  if (!asr) return { state: 'off', text: t('Off') }
  const selected = selection?.providerId === ASR_PROVIDER
  const reason = asr.reason ? hostText(String(asr.reason)) : ''
  const notReady = reason || (speechAvailable === false ? t('Set up voice input') : t('Not ready'))
  const usable = asr.registered === true && asr.configured !== false && speechAvailable !== false && asr.ready !== false
  if (!usable) {
    if (selected) return { state: 'missing', text: notReady }
    return { state: 'off', text: asr.registered === false && reason ? reason : t('Off') }
  }
  if (selected) return { state: 'ready', text: t('In use') }
  return { state: 'off', text: t('Off') }
}

function Pill({ state, text }) {
  return h('span', { className: 'bt-svc-state', 'data-state': state, role: 'status' },
    h('span', { className: 'bt-svc-dot', 'aria-hidden': 'true' }),
    h('span', null, text))
}

function Choice({ label, value, options, disabled, pick, Segmented }) {
  return h(Segmented, { label, value, className: 'bt-svc-seg' }, options.map(([id, text]) => h('button', {
    key: id, type: 'button', 'aria-pressed': value === id, disabled,
    onClick: () => { if (value !== id) pick(id) },
  }, text)))
}

// Pure rendering half, so a mock UI test can drive it with a fixed host status.
export function ServicesForm({ status, selection, busy, saved, asrBusy, speechAvailable, pluginsAvailable,
  save, selectAsr, onOpenModels, onOpenPlugins, onOpenWebSearch, Section, Row, Switch, Segmented }) {
  const prefs = { ...DEFAULTS, ...status?.preferences }
  const key = status?.key ?? {}
  const asr = status?.speech ?? null
  const selected = selection?.providerId === ASR_PROVIDER
  const ready = status !== null
  const ocrView = capabilityState(status?.ocr)
  const ttsView = capabilityState(status?.tts)
  const asrView = asrState(asr, selection, speechAvailable)
  const voices = [...new Set([...(status?.tts?.voices ?? []), prefs.voice])]
  const asrUsable = asr !== null && asr.registered === true && asr.configured !== false && asr.ready !== false && speechAvailable !== false
  const asrButton = asr === null
    ? null
    : !asr.registered
      ? (pluginsAvailable ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onOpenPlugins }, t('Set up voice input')) : null)
      : !asr.configured
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onOpenModels }, t('Providers'))
        : selected && asrUsable
          ? h(Pill, { state: 'ready', text: t('In use') })
          : h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: asrBusy || !asrUsable, onClick: selectAsr }, asrBusy ? t('Saving…') : t('Use DeepSeek for dictation'))
  const asrHint = asr !== null && !asr.registered && asr.reason && asrView.state !== 'missing'
    ? hostText(String(asr.reason))
    : undefined
  return h('div', { className: 'bt-svc' },
    h('style', { 'data-ds-bot': 'deepseek-services' }, SERVICES_CSS),
    h(Section, { key: 'key', tour: 'svc-key' },
      h(Row, { label: t('API key') },
        h('div', { className: 'bt-svc-actions' },
          ready ? h(Pill, { state: key.configured ? 'ready' : 'warn', text: key.configured ? t('Key set') : t('Needs an API key') }) : null,
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onOpenModels }, t('Providers')))),
      h(Row, { label: t('DeepSeek Web Search') },
        onOpenWebSearch
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onOpenWebSearch }, t('Configure'))
          : pluginsAvailable ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onOpenPlugins }, t('Open Plugins')) : null),
      saved || busy ? h('div', { className: 'bt-svc-line' },
        h('span', { className: 'bt-svc-note', role: 'status' }, saved ? t('Saved.') : t('Saving…'))) : null),
    h(Section, { key: 'caps' },
      h(Row, { label: t('Image and document reading'), tour: 'svc-ocr' },
        h('div', { className: 'bt-svc-actions' },
          ocrView.state !== 'off' ? h(Pill, { state: ocrView.state, text: ocrView.text }) : null,
          h(Switch, {
            label: t('Image and document reading'), on: prefs.ocr === true, disabled: busy || !ready,
            onChange: on => save({ ocr: on }),
          }))),
      h(Row, { label: t('Read replies aloud'), tour: 'svc-tts' },
        h('div', { className: 'bt-svc-actions' },
          ttsView.state !== 'off' ? h(Pill, { state: ttsView.state, text: ttsView.text }) : null,
          h(Choice, {
            label: t('Read replies aloud'), value: prefs.tts, disabled: busy || !ready, Segmented,
            options: [['system', t('System')], ['deepseek', t('DeepSeek')]], pick: id => save({ tts: id }),
          }))),
      prefs.tts === 'deepseek' ? h(Row, { label: t('Voice') },
        h(Choice, {
          label: t('Voice'), value: prefs.voice, disabled: busy || !ready, Segmented,
          options: voices.map(id => [id, voiceName(id)]), pick: id => save({ voice: id }),
        })) : null,
      h(Row, { label: t('Speech recognition'), hint: asrHint },
        h('div', { className: 'bt-svc-actions' },
          asrView.state === 'missing' ? h(Pill, { state: 'missing', text: asrView.text }) : null,
          asrButton,
          asr?.registered && pluginsAvailable ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onOpenPlugins }, t('Open Plugins')) : null))))
}

export function DeepSeekServicesPage({ actions, run, Section, Row, Switch, Segmented, onOpenWebSearch, openEnginePlugins = null }) {
  const [status, setStatus] = useState(null)
  const [selection, setSelection] = useState(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [asrBusy, setAsrBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    void Promise.resolve().then(() => actions.deepseekServices()).then(value => {
      if (alive.current && value) setStatus(value)
    }).catch(failure => { if (alive.current) setLoadError(hostText(failure?.message ?? String(failure))) })
    const speech = typeof actions.speech === 'function' ? actions.speech() : undefined
    if (speech) void Promise.resolve().then(() => speech.catalog()).then(result => {
      if (alive.current && result?.ok !== false) setSelection(result.value?.selection ?? null)
    }).catch(() => {})
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
  // The existing speech Remote owns the dictation selection; DS Bot stores no second
  // preference for it. A missing Remote leaves the browser's dictation path alone.
  const selectAsr = () => {
    const speech = typeof actions.speech === 'function' ? actions.speech() : undefined
    if (!speech || asrBusy) return
    setAsrBusy(true)
    void run(Promise.resolve()
      .then(() => speech.configure({ providerId: ASR_PROVIDER, language: 'auto' }))
      .then(result => {
        if (result?.ok === false) throw new Error(hostText(result?.error?.message ?? t('Could not save. Try again.')))
        return speech.catalog()
      })
      .then(result => { if (alive.current && result?.ok !== false) setSelection(result.value?.selection ?? null) }))
      .finally(() => { if (alive.current) setAsrBusy(false) })
  }
  const speechAvailable = typeof actions.speech === 'function' && actions.speech() !== undefined
  const pluginsAvailable = typeof actions.hasPlugins !== 'function' || actions.hasPlugins() !== false
  return h(Fragment, null,
    loadError ? h('div', { className: 'bt-error', role: 'alert' }, loadError) : null,
    h(ServicesForm, {
      status, selection, busy, saved, asrBusy, speechAvailable, pluginsAvailable,
      save, selectAsr, onOpenModels: () => actions.openModels?.(),
      // DSH's own Web Search API & engine plugin switches live in the nested
      // `plugins` → `dsh` view when available; otherwise fall back to closing
      // the dialog and calling the legacy `openPlugins` action.
      onOpenPlugins: () => {
        if (openEnginePlugins) { openEnginePlugins(); return }
        actions.closeSettings?.()
        actions.openPlugins?.()
      },
      onOpenWebSearch,
      Section, Row, Switch, Segmented,
    }))
}
