// Canonical form & settings controls (`Switch`, `SwitchRow`, `InlineText`,
// `SettingSection`, `SettingCard`, `SettingRow`, `Choice`, `StatusAlert`, `EmptyState`,
// `SearchInput`). Re-exports `SelectMenu` and `Segmented` so business pages import all
// standard controls from one place.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { CloseIcon, SearchIcon } from '../icons.js'
import { t } from '../i18n.js'
import { Segmented } from '../motion.js'
import { SelectMenu } from '../select-menu.js'

export { Segmented, SelectMenu }

export function Switch({ on, label, disabled = false, onChange }) {
  return h('button', {
    type: 'button',
    role: 'switch',
    className: 'bt-switch',
    'aria-checked': on,
    'aria-label': label,
    disabled,
    onClick: () => onChange(!on),
  }, h('span', { className: 'bt-switch-knob', 'aria-hidden': true }))
}

export function SwitchRow({ label, hint = null, on, disabled = false, onChange, className = '', tour = null }) {
  return h('div', {
    className: className ? `bt-set-row bt-bs-row ${className}` : 'bt-set-row bt-bs-row',
    'data-tour': tour || undefined,
  },
  h('span', { className: 'bt-set-copy' },
    h('span', { className: 'bt-bs-label' }, label),
    hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
  h(Switch, { on, label, disabled, onChange }))
}

// Settings save on blur or Enter, with no Save button; Escape restores the saved value.
export function InlineText({ label, value, placeholder, required = false, maxLength, multiline = false, className, autoFocus = false, onSave, onDone }) {
  const [draft, setDraft] = useState(null)
  const reverting = useRef(false)
  const field = useRef(null)
  useEffect(() => {
    const node = field.current
    if (!autoFocus || !node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [])
  const commit = () => {
    const next = draft?.trim()
    if (reverting.current) { reverting.current = false; setDraft(null); onDone?.(); return }
    if (next === undefined || next === (value ?? '') || (required && next === '')) {
      setDraft(null)
      onDone?.()
      return
    }
    const finish = (ok) => {
      if (ok === false) return
      setDraft(null)
      onDone?.()
    }
    const outcome = onSave(next)
    if (outcome && typeof outcome.then === 'function') {
      void outcome.then(finish, () => {})
    } else {
      finish(outcome)
    }
  }
  return h(multiline ? 'textarea' : 'input', {
    ref: field,
    className: className ?? (multiline ? 'bt-bs-input bt-bs-area' : 'bt-bs-input'),
    value: draft ?? value ?? '',
    placeholder,
    maxLength,
    required,
    'aria-label': label,
    spellCheck: false,
    onChange: event => setDraft(event.target.value),
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === 'Escape' && !event.nativeEvent?.isComposing && event.keyCode !== 229) {
        event.preventDefault?.()
        event.stopPropagation?.()
        event.nativeEvent?.stopPropagation?.()
        reverting.current = true
        event.currentTarget.blur()
      }
      if (event.key === 'Enter' && !multiline && !event.nativeEvent?.isComposing && event.keyCode !== 229) event.currentTarget.blur()
    },
  })
}

export function SettingSection({ title = null, action = null, className = '', tour = null, children }) {
  return h('section', {
    className: className ? `bt-set-section ${className}` : 'bt-set-section',
    'data-tour': tour || undefined,
  },
  action ? h('div', { className: 'bt-la-sec-head' }, title ? h('h3', null, title) : null, action) : title ? h('h3', null, title) : null,
  h('div', { className: 'bt-set-card' }, children))
}

export function SettingCard({ title = null, children }) {
  return h(SettingSection, { title }, children)
}

export function SettingRow({ label, hint = null, stack = false, asLabel = false, className = '', tour = null, children = null }) {
  if (asLabel) {
    return h('label', {
      className: [stack ? 'bt-set-row bt-bs-row bt-bs-stack' : 'bt-set-row bt-bs-row', className].filter(Boolean).join(' '),
      'data-tour': tour || undefined,
    },
    h('span', { className: 'bt-set-copy' },
      h('span', { className: 'bt-bs-label' }, label),
      hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children)
  }
  return h('div', {
    className: [stack ? 'bt-set-row bt-bs-stack' : 'bt-set-row', className].filter(Boolean).join(' '),
    'data-tour': tour || undefined,
  },
  h('div', { className: 'bt-set-copy' },
    h('span', null, label),
    hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
  children ? h('div', { className: 'bt-set-control' }, children) : null)
}

export function Choice({ label, value, options, pick, className = 'bt-look-seg', translate = true }) {
  return h(Segmented, { label, value, className }, options.map(([id, text]) => h('button', {
    key: id,
    type: 'button',
    'aria-pressed': value === id,
    onClick: () => { if (value !== id) pick(id) },
  }, translate ? t(text) : text)))
}

export function StatusAlert({ error = '', notice = '', className = '' }) {
  if (!error && !notice) return null
  return h('div', {
    className: [error ? 'bt-error' : 'bt-set-hint', className].filter(Boolean).join(' '),
    role: error ? 'alert' : 'status',
  }, error || notice)
}

export function EmptyState({ children, className = '' }) {
  return h('div', { className: className ? `bt-empty ${className}` : 'bt-empty' }, children)
}

export function SearchInput({ value, onChange, placeholder = '', label = '', className = '', autoFocus = false }) {
  return h('label', { className: className ? `bt-ui-search ${className}` : 'bt-ui-search' },
    h('span', { className: 'bt-ui-search-ico', 'aria-hidden': true }, h(SearchIcon)),
    h('input', {
      type: 'search',
      className: 'bt-ui-search-input',
      value,
      placeholder: placeholder || t('Search'),
      'aria-label': label || placeholder || t('Search'),
      autoFocus,
      spellCheck: false,
      onChange: event => onChange(event.target.value),
    }),
    value ? h('button', {
      type: 'button',
      className: 'bt-ui-search-clear',
      'aria-label': t('Clear'),
      onClick: () => onChange(''),
    }, h(CloseIcon)) : null)
}

export const CONTROLS_CSS = `
.bt-ui-search{display:flex;align-items:center;gap:6px;height:32px;padding:0 8px 0 10px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);box-sizing:border-box;transition:border-color .12s ease}
.bt-ui-search:focus-within{border-color:var(--bt-accent)}
.bt-ui-search-ico{flex:none;display:inline-flex;color:var(--bt-ink-3)}
.bt-ui-search-ico svg{width:14px;height:14px}
.bt-ui-search-input{flex:1;min-width:0;border:0;background:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;outline:none}
.bt-ui-search-input::placeholder{color:var(--bt-ink-3)}
.bt-ui-search-input::-webkit-search-cancel-button{display:none}
.bt-ui-search-clear{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:50%;corner-shape:round;background:none;color:var(--bt-ink-3);cursor:pointer}
.bt-ui-search-clear:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ui-search-clear svg{width:12px;height:12px}
`
