// Settings → Privacy & first-run privacy notice card.
// Exposes clear controls for DS Bot's optional anonymous telemetry, an inspector for
// recently sent JSON payloads, and DSH upstream log/feedback controls.
import { createElement as h, useEffect, useState } from 'react'
import { Switch } from './bot-settings.js'
import { ShieldIcon } from './icons.js'
import { t } from './i18n.js'
import { SPRING_SHAPE } from './motion.js'
import { useEscape } from './overlay-hooks.js'

const linkProps = href => ({ className: 'bt-soft bt-soft-sm bt-about-link', href, target: '_blank', rel: 'noopener noreferrer' })

export function PrivacyPage({ actions, run, Section, Row }) {
  const [state, setState] = useState(null)
  const [showLog, setShowLog] = useState(false)
  const [note, setNote] = useState('')
  const load = () => (typeof actions.telemetryStatus === 'function' ? actions.telemetryStatus() : Promise.resolve(null)).then((next) => { setState(next); return next })
  useEffect(() => { void run(load()) }, [])

  const save = patch => run((typeof actions.telemetryUpdate === 'function' ? actions.telemetryUpdate(patch) : Promise.resolve(state)).then((next) => { setState(next); setNote('') }))
  const resetId = () => run((typeof actions.telemetryResetId === 'function' ? actions.telemetryResetId() : Promise.resolve(state)).then((next) => { setState(next); setNote(t('Anonymous ID rotated.')) }))
  const clearLog = () => run((typeof actions.telemetryClearLog === 'function' ? actions.telemetryClearLog() : Promise.resolve(state)).then((next) => { setState(next); setNote(t('Cleared sent telemetry history.')) }))

  const disabled = state?.envDisabled === true
  const recent = state?.recentSent ?? []
  const logText = recent.length === 0
    ? t('No telemetry data has been sent yet.')
    : JSON.stringify(recent, null, 2)

  return [
    disabled
      ? h('div', { key: 'env', className: 'bt-note bt-priv-banner', role: 'status' },
          t('Telemetry is disabled by {env}.', { env: state.envReason }))
      : null,
    h(Section, { key: 'dsbot', title: t('DS Bot telemetry') },
      h(Row, {
        label: t('Anonymous usage statistics'),
        hint: t('Daily active count, versions, OS, and built-in feature overview. Sent at most once per day.'),
      }, h(Switch, {
        label: t('Anonymous usage statistics'),
        on: !disabled && state?.usage === true && state?.noticeAccepted === true,
        disabled: state === null || disabled,
        onChange: usage => save(state?.noticeAccepted === true ? { usage } : { usage, errors: false, noticeAccepted: true }),
      })),
      h(Row, {
        label: t('Anonymous error reports'),
        hint: t('Error codes and DS Bot source frames only. No messages, file paths, or chats.'),
      }, h(Switch, {
        label: t('Anonymous error reports'),
        on: !disabled && state?.errors === true && state?.noticeAccepted === true,
        disabled: state === null || disabled,
        onChange: errors => save(state?.noticeAccepted === true ? { errors } : { usage: false, errors, noticeAccepted: true }),
      })),
      h(Row, {
        label: t('Anonymous ID'),
        hint: state ? `${state.anonId} · ${t('Rotates monthly on {month}', { month: state.anonMonth })}` : t('Loading…'),
      }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: state === null, onClick: resetId }, t('Reset'))),
      h(Row, {
        label: t('Recently sent data'),
        hint: t('Inspect the exact JSON sent from this computer (last 20 entries).'),
      },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: state === null, 'aria-expanded': showLog, onClick: () => setShowLog(v => !v) }, showLog ? t('Hide') : t('Show')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: state === null || recent.length === 0, onClick: clearLog }, t('Clear'))),
      showLog ? h('div', { className: 'bt-set-row bt-fb-preview' }, h('pre', { tabIndex: 0, 'aria-label': t('Recently sent data') }, logText)) : null,
      state?.privacyUrl
        ? h(Row, { label: t('Privacy policy') }, h('a', linkProps(state.privacyUrl), t('Open')))
        : null),
    note ? h('div', { key: 'note', className: 'bt-note bt-fb-note', role: 'status' }, note) : null,
    h(Section, { key: 'dsh', title: t('DeepSeek Harness (Engine)') },
      h(Row, {
        label: t('Upload Session Log to DeepSeek API'),
        hint: t('Sends incremental session logs to DeepSeek when using the official DeepSeek API. Private Bots are always excluded.'),
      }, h(Switch, {
        label: t('Upload Session Log to DeepSeek API'),
        on: state?.dshSessionLog === true,
        disabled: state === null,
        onChange: dshSessionLog => save({ dshSessionLog }),
      })),
      h(Row, {
        label: t('Send feedback sessions to DeepSeek'),
        hint: t('Only used when submitting feedback in Classic Agent mode. Private Bots and secrets are excluded. Restart to apply fully.'),
      }, h(Switch, {
        label: t('Send feedback sessions to DeepSeek'),
        on: state?.dshFeedbackTelemetry === true,
        disabled: state === null,
        onChange: dshFeedbackTelemetry => save({ dshFeedbackTelemetry }),
      }))),
  ]
}

// One-time privacy notice shown before any telemetry is ever sent.
// Usage statistics start checked; error reports start unchecked; "Turn all off" declines both.
export function TelemetryNotice({ actions, leaving = false, onDone }) {
  const [usage, setUsage] = useState(true)
  const [errors, setErrors] = useState(false)
  const [busy, setBusy] = useState(false)

  const finish = (nextUsage, nextErrors) => {
    if (busy) return
    setBusy(true)
    void Promise.resolve(actions.telemetryUpdate({ noticeAccepted: true, usage: nextUsage, errors: nextErrors }))
      .catch(() => {})
      .finally(() => {
        setBusy(false)
        onDone?.()
      })
  }

  useEscape(() => { if (!leaving) finish(false, false) })

  return h('div', { className: 'bt-priv-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim' }),
    h('div', { className: 'bt-priv-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'bt-priv-title' },
      h('div', { className: 'bt-priv-head' },
        h('span', { className: 'bt-priv-icon', 'aria-hidden': true }, h(ShieldIcon)),
        h('div', { className: 'bt-priv-head-copy' },
          h('h2', { id: 'bt-priv-title', className: 'bt-priv-title' }, t('Help improve DS Bot')),
          h('p', { className: 'bt-priv-sub' }, t('Chats, memories, secrets, file paths, Bot names, private Bots, and IP addresses are never sent.')))),
      h('div', { className: 'bt-set-card bt-priv-card' },
        h('div', { className: 'bt-set-row bt-priv-row' },
          h('div', { className: 'bt-set-copy' },
            h('span', null, t('Anonymous usage statistics')),
            h('span', { className: 'bt-set-hint' }, t('Daily active count, versions, OS, and built-in feature toggles. Random ID rotates monthly.'))),
          h('div', { className: 'bt-set-control' },
            h(Switch, { label: t('Anonymous usage statistics'), on: usage, disabled: busy, onChange: setUsage }))),
        h('div', { className: 'bt-set-row bt-priv-row' },
          h('div', { className: 'bt-set-copy' },
            h('span', null, t('Anonymous error reports')),
            h('span', { className: 'bt-set-hint' }, t('Error codes and DS Bot source line frames only — no messages, paths, or chats.'))),
          h('div', { className: 'bt-set-control' },
            h(Switch, { label: t('Anonymous error reports'), on: errors, disabled: busy, onChange: setErrors })))),
      h('p', { className: 'bt-priv-foot-note' },
        t('Change anytime in Settings → About DS Bot → Privacy.'),
        ' ',
        h('a', { className: 'bt-priv-link', href: 'https://dsbot.app/privacy', target: '_blank', rel: 'noopener noreferrer' }, t('Privacy policy'))),
      h('div', { className: 'bt-priv-actions' },
        h('button', { type: 'button', className: 'bt-soft', disabled: busy, onClick: () => finish(false, false) }, t('Turn all off')),
        h('button', { type: 'button', className: 'bt-send bt-priv-confirm', disabled: busy, onClick: () => finish(usage, errors) }, t('Continue')))))
}

export const PRIVACY_CSS = `
.bt-priv-banner{margin:0 4px 12px;color:var(--bt-warn)}
.bt-priv-layer{position:fixed;inset:0;z-index:65;display:flex;align-items:center;justify-content:center;padding:16px}
.bt-priv-layer[data-leaving] .bt-scrim{opacity:0;transition:opacity .16s ease-out}
.bt-priv-layer[data-leaving] .bt-priv-dialog{animation:bt-dialog-sink .16s ease-in forwards}
.bt-priv-dialog{position:relative;z-index:1;width:min(460px,100%);background:var(--bt-main);color:var(--bt-ink);border:.5px solid var(--bt-line-2);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.24);padding:20px;display:flex;flex-direction:column;gap:14px;animation:bt-dialog-rise ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-priv-head{display:flex;align-items:flex-start;gap:12px}
.bt-priv-icon{flex:none;width:36px;height:36px;border-radius:10px;background:var(--bt-hover);color:var(--bt-accent);display:inline-flex;align-items:center;justify-content:center}
.bt-priv-head-copy{min-width:0;display:flex;flex-direction:column;gap:4px}
.bt-priv-title{margin:0;font-size:15px;line-height:20px;font-weight:600;color:var(--bt-ink)}
.bt-priv-sub{margin:0;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-priv-card{overflow:hidden}
.bt-priv-row{cursor:default}
.bt-priv-row:hover{background:none}
.bt-priv-foot-note{margin:0 2px;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-priv-link{color:var(--bt-accent);text-decoration:none}
.bt-priv-link:hover{text-decoration:underline}
.bt-priv-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.bt-priv-confirm{height:36px;padding:0 18px}
`
