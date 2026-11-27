import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { t } from './i18n.js'
import { CloseIcon, SearchIcon } from './icons.js'
import {
  SHORTCUT_DEFS,
  SHORTCUT_GROUPS,
  effectiveBinding,
  eventToBinding,
  formatBindingCaps,
  isCommandAvailable,
  isMacPlatform,
  isReservedZoomKeyEvent,
  setShortcutRecording,
  shortcutsStore,
} from './shortcuts-model.js'
import { isImeComposing, sendsOnEnter } from './enter-key.js'
import { ESCAPE_PRIORITY, useEscape } from './overlay-hooks.js'

/**
 * Subscribes a React component to a shortcut store using standard state/effect hooks.
 */
export function useShortcutOverrides(store = shortcutsStore) {
  const [overrides, setOverrides] = useState(() => store.getSnapshot())
  useEffect(() => {
    setOverrides(store.getSnapshot())
    return store.subscribe(() => setOverrides(store.getSnapshot()))
  }, [store])
  return overrides
}

/**
 * Renders individual keycaps for a binding or raw label list.
 */
export function KeyCaps({ caps, className = '' }) {
  if (!caps || caps.length === 0) return null
  return h('span', { className: `bt-kbd-group ${className}`.trim() },
    caps.map((cap, index) => h('kbd', { key: `${cap}-${index}`, className: 'bt-kbd' }, cap)))
}

function labelForDef(def, classic = false) {
  const key = classic && def.classicLabel ? def.classicLabel : def.label
  return def.labelVars ? t(key, def.labelVars) : t(key)
}

export function ShortcutsPage({ roster, actions, surfaceMode = 'bot', Section, Row, store = shortcutsStore }) {
  const overrides = useShortcutOverrides(store)
  const mac = isMacPlatform()
  const classic = surfaceMode === 'agent'
  const enterToSend = sendsOnEnter(roster?.prefs)
  const hasSurface = typeof actions?.setSurface === 'function'
  const hasBrowser = typeof actions?.openBrowser === 'function' && roster?.browser !== false
  const hasInbox = !classic && typeof actions?.openInbox === 'function'
  const hasDetails = !classic
  const hasMemory = !classic
  const hasGroupSearch = !classic

  const [query, setQuery] = useState('')
  const [recordingId, setRecordingId] = useState(null)
  const [notice, setNotice] = useState(null) // { id, kind: 'conflict' | 'error', conflict?, binding?, fromReset?, message? }
  const recordingRef = useRef(null)
  recordingRef.current = recordingId
  const noticeRef = useRef(null)
  noticeRef.current = notice

  useEffect(() => {
    if (!recordingId) return undefined
    setShortcutRecording(true)
    const onKeyDown = (event) => {
      if (isImeComposing(event)) return
      const currentId = recordingRef.current
      if (!currentId) return
      // While a conflict resolution prompt is visible, let keyboard users Tab/Enter/Space
      // onto the Cancel / Replace buttons, and let plain Escape dismiss the prompt.
      if (noticeRef.current?.kind === 'conflict' && noticeRef.current.id === currentId) {
        if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          event.preventDefault()
          event.stopPropagation()
          setNotice(null)
          return
        }
        if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ') return
      }
      event.preventDefault()
      event.stopPropagation()
      // Plain Escape cancels recording without changing the binding.
      if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        setRecordingId(null)
        setNotice(null)
        return
      }
      // Plain Backspace or Delete clears (unbinds) the shortcut.
      if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        store.setBinding(currentId, null)
        setRecordingId(null)
        setNotice(null)
        return
      }
      const binding = eventToBinding(event, mac)
      if (!binding) return // modifier-only press or unsupported Meta on Windows/Linux
      if (isReservedZoomKeyEvent(event, mac)) {
        setNotice({
          id: currentId,
          kind: 'error',
          message: t('Reserved system shortcut'),
        })
        return
      }
      const result = store.setBinding(currentId, binding)
      if (result.ok) {
        setRecordingId(null)
        setNotice(null)
      } else if (result.reason === 'conflict') {
        setNotice({
          id: currentId,
          kind: 'conflict',
          conflict: result.conflict,
          binding,
        })
      } else if (result.reason === 'need-modifier') {
        setNotice({
          id: currentId,
          kind: 'error',
          message: t('Include a modifier key (or use F1–F12)'),
        })
      } else if (result.reason === 'reserved') {
        setNotice({
          id: currentId,
          kind: 'error',
          message: t('Reserved system shortcut'),
        })
      }
    }
    const onMouseDown = (event) => {
      const row = event.target instanceof Element ? event.target.closest('[data-shortcut-row]') : null
      if (row && row.getAttribute('data-shortcut-row') === recordingRef.current) return
      setRecordingId(null)
      setNotice(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mousedown', onMouseDown, true)
    return () => {
      setShortcutRecording(false)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [recordingId, mac, store])

  useEscape(() => setNotice(null), Boolean(notice && !recordingId), { priority: ESCAPE_PRIORITY.RECORDING })

  const wanted = query.trim().toLowerCase()
  const visibleDefs = useMemo(() => {
    const capabilities = { hasSurface, hasBrowser, hasInbox, hasDetails, hasMemory, hasGroupSearch }
    return SHORTCUT_DEFS.filter((def) => {
      if (!isCommandAvailable(def, capabilities)) return false
      if (!wanted) return true
      const label = labelForDef(def, classic).toLowerCase()
      const rawLabel = (classic && def.classicLabel ? def.classicLabel : def.label).toLowerCase()
      const caps = formatBindingCaps(effectiveBinding(def.id, overrides), mac).join(' ').toLowerCase()
      return label.includes(wanted) || rawLabel.includes(wanted) || caps.includes(wanted)
    })
  }, [hasSurface, hasBrowser, hasInbox, hasDetails, hasMemory, hasGroupSearch, classic, wanted, overrides, mac])

  const grouped = useMemo(() => {
    const byGroup = new Map()
    for (const group of SHORTCUT_GROUPS) byGroup.set(group.id, [])
    for (const def of visibleDefs) {
      byGroup.get(def.group)?.push(def)
    }
    return SHORTCUT_GROUPS
      .map(group => ({ ...group, items: byGroup.get(group.id) ?? [] }))
      .filter(group => group.items.length > 0)
  }, [visibleDefs])

  const hasCustom = Object.keys(overrides).length > 0
  const modCap = mac ? '⌘' : 'Ctrl'
  const shiftCap = mac ? '⇧' : 'Shift'
  const fixedRows = useMemo(() => {
    const all = [
      { id: 'fixed:send', label: t('Send message'), caps: enterToSend ? ['Enter'] : [modCap, 'Enter'] },
      { id: 'fixed:newline', label: t('New line'), caps: enterToSend ? [shiftCap, 'Enter'] : ['Enter'] },
      ...(classic ? [] : [{ id: 'fixed:mention', label: t('Mention a Bot'), caps: ['@'] }]),
      { id: 'fixed:commands', label: t('Commands'), caps: ['/'] },
      { id: 'fixed:stop-esc', label: t('Stop generating'), caps: ['Esc', 'Esc'] },
      { id: 'fixed:approval-allow', label: t('Allow approval (card focused)'), caps: ['Enter'] },
      { id: 'fixed:approval-reject', label: t('Reject approval (card focused)'), caps: ['Esc'] },
      { id: 'fixed:escape', label: t('Close dialog or menu'), caps: ['Esc'] },
    ]
    if (!wanted) return all
    return all.filter(row => row.label.toLowerCase().includes(wanted) || row.caps.join(' ').toLowerCase().includes(wanted))
  }, [enterToSend, modCap, shiftCap, classic, wanted])

  const startRecording = (id) => {
    if (recordingId === id) {
      setRecordingId(null)
      setNotice(null)
      return
    }
    setNotice(null)
    setRecordingId(id)
  }

  const resetOne = (id) => {
    setRecordingId(null)
    const result = store.resetBinding(id)
    if (result && !result.ok && result.reason === 'conflict') {
      setNotice({
        id,
        kind: 'conflict',
        conflict: result.conflict,
        binding: result.binding,
        fromReset: true,
      })
    } else {
      setNotice(null)
    }
  }

  const acceptConflict = () => {
    if (!notice || notice.kind !== 'conflict') return
    if (notice.fromReset) store.resetBinding(notice.id, { replaceConflict: true })
    else store.setBinding(notice.id, notice.binding, { replaceConflict: true })
    setRecordingId(null)
    setNotice(null)
  }

  return h('div', { className: 'bt-sc-page' },
    h('div', { className: 'bt-sc-bar' },
      h('div', { className: 'bt-sc-search-wrap' },
        h('span', { className: 'bt-sc-search-ico', 'aria-hidden': true }, h(SearchIcon)),
        h('input', {
          type: 'text',
          className: 'bt-input bt-sc-search',
          value: query,
          placeholder: t('Filter shortcuts…'),
          'aria-label': t('Filter shortcuts…'),
          onChange: event => setQuery(event.target.value),
        }),
        query
          ? h('button', {
            type: 'button',
            className: 'bt-icon-btn bt-sc-clear',
            'aria-label': t('Clear search'),
            onClick: () => setQuery(''),
          }, h(CloseIcon))
          : null),
      hasCustom
        ? h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          onClick: () => { setRecordingId(null); setNotice(null); store.resetAll() },
        }, t('Reset all'))
        : null),
    grouped.length === 0 && fixedRows.length === 0
      ? h('div', { className: 'bt-empty' }, t('No matching shortcuts'))
      : null,
    grouped.map(group => h(Section, { key: group.id, title: t(group.label) },
      group.items.map((def) => {
        const binding = effectiveBinding(def.id, overrides)
        const caps = formatBindingCaps(binding, mac)
        const customized = Object.prototype.hasOwnProperty.call(overrides, def.id)
        const isRecording = recordingId === def.id
        const rowNotice = notice?.id === def.id ? notice : null
        const label = labelForDef(def, classic)
        return h('div', { key: def.id, className: 'bt-sc-item', 'data-shortcut-row': def.id },
          h(Row, {
            label: h('span', { className: 'bt-sc-name' },
              label,
              customized ? h('span', { className: 'bt-sc-dot', 'aria-label': t('Customized') }) : null),
          },
          h('div', { className: 'bt-sc-controls' },
            customized
              ? h('button', {
                type: 'button',
                className: 'bt-mini bt-sc-reset',
                onClick: () => resetOne(def.id),
              }, t('Reset'))
              : null,
            h('button', {
              type: 'button',
              className: 'bt-sc-keybtn',
              'data-recording': isRecording ? '' : undefined,
              'data-empty': !isRecording && caps.length === 0 ? '' : undefined,
              'aria-label': isRecording
                ? t('Press keys for {name}', { name: label })
                : `${label}: ${caps.length > 0 ? caps.join(' ') : t('Not set')}`,
              onClick: () => startRecording(def.id),
            },
            isRecording
              ? h('span', { className: 'bt-sc-prompt' }, t('Press keys…'))
              : caps.length > 0
                ? h(KeyCaps, { caps })
                : h('span', { className: 'bt-sc-unset' }, t('Not set'))))),
          rowNotice?.kind === 'conflict'
            ? h('div', { className: 'bt-sc-alert', role: 'alert' },
              h('span', { className: 'bt-sc-alert-text' },
                t('Already used by {name}', { name: labelForDef(rowNotice.conflict, classic) })),
              h('div', { className: 'bt-sc-alert-actions' },
                h('button', { type: 'button', className: 'bt-mini', onClick: () => setNotice(null) }, t('Cancel')),
                h('button', { type: 'button', className: 'bt-mini bt-sc-replace', onClick: acceptConflict }, t('Replace'))))
            : null,
          rowNotice?.kind === 'error'
            ? h('div', { className: 'bt-sc-alert', role: 'alert' },
              h('span', { className: 'bt-sc-alert-text' }, rowNotice.message))
            : null)
      }))),
    fixedRows.length > 0
      ? h(Section, { key: 'fixed', title: t('Fixed') },
        fixedRows.map(row => h(Row, { key: row.id, label: row.label },
          h(KeyCaps, { caps: row.caps }))))
      : null)
}

export const SHORTCUTS_PAGE_CSS = `
.bt-sc-page{display:flex;flex-direction:column;gap:20px}
.bt-sc-bar{display:flex;align-items:center;gap:8px}
.bt-sc-search-wrap{position:relative;flex:1 1 auto;display:flex;align-items:center}
.bt-sc-search-ico{position:absolute;left:10px;display:inline-flex;color:var(--bt-ink-3);pointer-events:none}
.bt-sc-search{width:100%;padding-left:32px;padding-right:32px}
.bt-sc-clear{position:absolute;right:4px}
.bt-sc-item{display:flex;flex-direction:column}
.bt-sc-page .bt-set-row{flex-direction:row;align-items:center;justify-content:space-between;min-height:44px;padding:10px 14px;gap:12px}
.bt-sc-page .bt-set-row>.bt-set-copy{width:auto;flex:1 1 auto;min-width:0}
.bt-sc-item>.bt-set-row{border-top:0}
.bt-sc-name{display:inline-flex;align-items:center;gap:6px}
.bt-sc-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--bt-accent);flex:none}
.bt-sc-controls{display:inline-flex;align-items:center;gap:8px;flex:none}
.bt-sc-reset{color:var(--bt-ink-2)}
.bt-sc-keybtn{display:inline-flex;align-items:center;justify-content:center;min-width:68px;min-height:28px;padding:4px 8px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.bt-sc-keybtn:hover{background:var(--bt-hover);border-color:var(--bt-line-2)}
.bt-sc-keybtn:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-sc-keybtn[data-recording]{border-color:var(--bt-accent);background:color-mix(in srgb,var(--bt-accent) 10%,var(--bt-card))}
.bt-sc-keybtn[data-empty]{border-style:dashed}
.bt-sc-prompt{font-size:12px;line-height:16px;font-weight:500;color:var(--bt-accent);white-space:nowrap}
.bt-sc-unset{font-size:12px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap}
.bt-kbd-group{display:inline-flex;align-items:center;gap:4px;flex:none}
.bt-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:6px;background:var(--bt-hover);box-shadow:inset 0 0 0 1px var(--bt-line-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1;color:var(--bt-ink)}
.bt-sc-alert{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 12px 10px;padding:6px 10px;border-radius:8px;background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card));color:var(--bt-danger);font-size:12px;line-height:16px}
.bt-sc-alert-text{min-width:0}
.bt-sc-alert-actions{display:inline-flex;align-items:center;gap:6px;flex:none}
.bt-sc-replace{background:color-mix(in srgb,var(--bt-danger) 16%,var(--bt-card));color:var(--bt-danger);font-weight:600}
.bt-palette-kbd{margin-left:auto;padding-left:8px;flex:none}
`
