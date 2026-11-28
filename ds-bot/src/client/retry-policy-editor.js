// Schema-driven retry policy editor matching DSH's RetryPolicySchema:
// mode (default / normal / always), maxRetries, retryableCodes (schema presets + custom),
// and collapsible backoff (initialDelayMs, maxDelayMs, jitterRatio).
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon } from './icons.js'
import { SelectMenu } from './select-menu.js'
import { t } from './i18n.js'

const MODE_LABELS = {
  normal: 'Normal',
  always: 'Always',
}

const CODE_LABELS = {
  EMPTY_RESPONSE: 'Empty response',
  RATE_LIMIT: 'Rate limit',
  SERVER: 'Server error',
  TIMEOUT: 'Timeout',
  TRANSPORT: 'Connection error',
  STREAM_CLOSED: 'Stream closed',
  MALFORMED_RESPONSE: 'Malformed response',
  QUOTA: 'Quota exceeded',
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseNumberText(text, meta) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return undefined
  const num = Number(trimmed)
  if (!Number.isFinite(num)) return Number.NaN
  if ((meta?.integer === true || meta?.step === 1) && !Number.isInteger(num)) return Number.NaN
  return num
}

export function validateRetryPolicy(policy, retryDefaults) {
  if (policy === undefined || policy === null) return undefined
  if (!isRecord(policy)) return 'Invalid retry policy'
  const modes = retryDefaults?.modes ?? ['normal', 'always']
  if (typeof policy.mode !== 'string' || !modes.includes(policy.mode)) {
    return 'Choose a retry mode'
  }
  const branch = retryDefaults?.branches?.[policy.mode] ?? {}
  if (policy.mode === 'normal') {
    if (policy.maxRetries !== undefined) {
      const m = branch.maxRetries
      const min = m?.min ?? m?.minimum ?? 0
      const max = m?.max ?? m?.maximum
      const intOnly = m?.step === 1 || m?.integer === true || m === undefined
      if (typeof policy.maxRetries !== 'number' || !Number.isFinite(policy.maxRetries) || (intOnly && !Number.isInteger(policy.maxRetries)) || policy.maxRetries < 0) {
        return 'Max retries must be a non-negative whole number'
      }
      if (policy.maxRetries < min || (typeof max === 'number' && policy.maxRetries > max)) {
        return 'Value is out of range'
      }
    }
    if (policy.retryableCodes !== undefined) {
      if (!Array.isArray(policy.retryableCodes) || policy.retryableCodes.length === 0) {
        return 'Select at least one retryable error'
      }
      const seen = new Set()
      for (const code of policy.retryableCodes) {
        if (typeof code !== 'string' || code.trim() === '') return 'Retryable error code cannot be blank'
        if (seen.has(code)) return 'Duplicate retryable error code'
        seen.add(code)
      }
    }
  }
  if (policy.backoff !== undefined) {
    if (!isRecord(policy.backoff)) return 'Invalid backoff settings'
    const bFields = branch.backoff?.fields ?? {}
    const init = policy.backoff.initialDelayMs
    const max = policy.backoff.maxDelayMs
    const jitter = policy.backoff.jitterRatio
    if (init !== undefined) {
      const m = bFields.initialDelayMs
      const minBound = m?.min ?? m?.minimum
      const maxBound = m?.max ?? m?.maximum
      if (typeof init !== 'number' || !Number.isFinite(init) || init <= 0 || ((m?.step === 1 || m?.integer === true) && !Number.isInteger(init))) {
        return 'Initial delay must be a positive number'
      }
      if ((typeof minBound === 'number' && init < minBound) || (typeof maxBound === 'number' && init > maxBound)) {
        return 'Value is out of range'
      }
    }
    if (max !== undefined) {
      const m = bFields.maxDelayMs
      const minBound = m?.min ?? m?.minimum
      const maxBound = m?.max ?? m?.maximum
      if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0 || ((m?.step === 1 || m?.integer === true) && !Number.isInteger(max))) {
        return 'Max delay must be a positive number'
      }
      if ((typeof minBound === 'number' && max < minBound) || (typeof maxBound === 'number' && max > maxBound)) {
        return 'Value is out of range'
      }
    }
    const effInit = init ?? bFields.initialDelayMs?.default ?? 500
    const effMax = max ?? bFields.maxDelayMs?.default ?? 10000
    if (typeof effInit === 'number' && typeof effMax === 'number' && effInit > effMax) {
      return 'Initial delay cannot exceed max delay'
    }
    if (jitter !== undefined) {
      const m = bFields.jitterRatio
      const minBound = m?.min ?? m?.minimum ?? 0
      const maxBound = m?.max ?? m?.maximum ?? 1
      if (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
        return 'Jitter ratio must be between 0 and 1'
      }
      if (jitter < minBound || jitter > maxBound) {
        return 'Value is out of range'
      }
    }
  }
  return undefined
}

export function cleanRetryPolicyForSave(policy) {
  if (policy === undefined || policy === null) return undefined
  if (!isRecord(policy) || typeof policy.mode !== 'string') return undefined
  const out = { mode: policy.mode }
  if (policy.mode === 'normal') {
    if (typeof policy.maxRetries === 'number') out.maxRetries = policy.maxRetries
    if (Array.isArray(policy.retryableCodes) && policy.retryableCodes.length > 0) {
      out.retryableCodes = [...policy.retryableCodes]
    }
  }
  if (isRecord(policy.backoff)) {
    const backoff = {}
    if (typeof policy.backoff.initialDelayMs === 'number') backoff.initialDelayMs = policy.backoff.initialDelayMs
    if (typeof policy.backoff.maxDelayMs === 'number') backoff.maxDelayMs = policy.backoff.maxDelayMs
    if (typeof policy.backoff.jitterRatio === 'number') backoff.jitterRatio = policy.backoff.jitterRatio
    if (Object.keys(backoff).length > 0) out.backoff = backoff
  }
  return out
}

export function RetryPolicyEditor({ policy, retryDefaults, disabled = false, resetEpoch = 0, onChange }) {
  const [openBackoff, setOpenBackoff] = useState(() => isRecord(policy?.backoff) && Object.keys(policy.backoff).length > 0)
  const [customCode, setCustomCode] = useState('')
  const [editing, setEditing] = useState(() => ({}))
  const lastReset = useRef(resetEpoch)

  useEffect(() => {
    if (lastReset.current === resetEpoch) return
    lastReset.current = resetEpoch
    setEditing({})
    setCustomCode('')
    setOpenBackoff(isRecord(policy?.backoff) && Object.keys(policy.backoff).length > 0)
  }, [resetEpoch])

  if (!retryDefaults || !Array.isArray(retryDefaults.modes) || retryDefaults.modes.length === 0) {
    return null
  }

  const modeValue = isRecord(policy) && typeof policy.mode === 'string' ? policy.mode : ''
  const defaultModeLabel = MODE_LABELS[retryDefaults.defaultMode] ? t(MODE_LABELS[retryDefaults.defaultMode]) : retryDefaults.defaultMode
  const branch = modeValue !== '' ? retryDefaults.branches?.[modeValue] : undefined
  const backoffFields = branch?.backoff?.fields ?? {}

  const updatePolicy = (updater) => {
    const next = updater(isRecord(policy) ? { ...policy, ...(isRecord(policy.backoff) ? { backoff: { ...policy.backoff } } : {}) } : undefined)
    onChange(next)
  }

  const changeMode = (nextMode) => {
    setEditing({})
    if (nextMode === '') {
      onChange(undefined)
      return
    }
    const base = isRecord(policy) ? policy : {}
    const next = { mode: nextMode }
    if (isRecord(base.backoff) && Object.keys(base.backoff).length > 0) {
      next.backoff = { ...base.backoff }
    }
    if (nextMode === 'normal') {
      if (base.maxRetries !== undefined) next.maxRetries = base.maxRetries
      if (Array.isArray(base.retryableCodes)) next.retryableCodes = [...base.retryableCodes]
    }
    onChange(next)
  }

  const setNumField = (key, text, meta, isBackoff) => {
    setEditing(cur => ({ ...cur, [key]: text }))
    const parsed = parseNumberText(text, meta)
    updatePolicy((cur) => {
      if (!cur) return cur
      if (isBackoff) {
        const nextBackoff = { ...(cur.backoff ?? {}) }
        if (parsed === undefined) delete nextBackoff[key]
        else nextBackoff[key] = parsed
        if (Object.keys(nextBackoff).length === 0) delete cur.backoff
        else cur.backoff = nextBackoff
      } else if (parsed === undefined) {
        delete cur[key]
      } else {
        cur[key] = parsed
      }
      return cur
    })
  }

  const blurNumField = (key, rawValue) => {
    if (typeof rawValue === 'number' && Number.isNaN(rawValue)) return
    setEditing((cur) => {
      if (!(key in cur)) return cur
      const next = { ...cur }
      delete next[key]
      return next
    })
  }

  const numText = (key, value) => (key in editing ? editing[key] : (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''))

  const codesMeta = branch?.retryableCodes
  const activeCodes = Array.isArray(policy?.retryableCodes)
    ? policy.retryableCodes
    : (codesMeta?.default ?? [])
  const knownChoices = codesMeta?.choices ?? []
  const customCodes = activeCodes.filter(code => !knownChoices.includes(code))

  const toggleCode = (code) => {
    if (disabled) return
    const has = activeCodes.includes(code)
    const nextCodes = has ? activeCodes.filter(c => c !== code) : [...activeCodes, code]
    updatePolicy((cur) => {
      if (!cur) return cur
      cur.retryableCodes = nextCodes
      return cur
    })
  }

  const addCustomCode = () => {
    const trimmed = customCode.trim()
    if (disabled || trimmed === '' || activeCodes.includes(trimmed)) {
      setCustomCode('')
      return
    }
    updatePolicy((cur) => {
      if (!cur) return cur
      cur.retryableCodes = [...activeCodes, trimmed]
      return cur
    })
    setCustomCode('')
  }

  const modeOptions = [
    { value: '', label: t('Default ({mode})', { mode: defaultModeLabel }) },
    ...retryDefaults.modes.map(m => ({ value: m, label: MODE_LABELS[m] ? t(MODE_LABELS[m]) : m })),
  ]

  return h('div', { className: 'bt-retry-editor' },
    h('div', { className: 'bt-retry-head' },
      h('span', { className: 'bt-secret-edit-label' }, t('Retry policy')),
      modeValue !== ''
        ? h('button', { type: 'button', className: 'bt-mini', disabled, onClick: () => changeMode('') }, t('Reset to default'))
        : null),
    h('div', { className: 'bt-provider-pair' },
      h('div', { className: 'bt-model-field' },
        h('span', { className: 'bt-model-field-label' }, t('Retry mode')),
        h(SelectMenu, {
          'aria-label': t('Retry mode'),
          value: modeValue,
          disabled,
          options: modeOptions,
          onChange: changeMode,
        })),
      modeValue === 'normal' && branch?.maxRetries
        ? h('label', { className: 'bt-model-field' },
            h('span', { className: 'bt-model-field-label' }, t('Max retries')),
            h('input', {
              className: 'bt-input',
              type: 'text',
              inputMode: 'numeric',
              value: numText('maxRetries', policy?.maxRetries),
              placeholder: branch.maxRetries.default !== undefined ? String(branch.maxRetries.default) : '5',
              'aria-label': t('Max retries'),
              disabled,
              spellCheck: false,
              autoComplete: 'off',
              onChange: event => setNumField('maxRetries', event.target.value, branch.maxRetries, false),
              onBlur: () => blurNumField('maxRetries', policy?.maxRetries),
            }))
        : null),
    modeValue === 'normal' && codesMeta
      ? h('div', { className: 'bt-model-field' },
          h('span', { className: 'bt-model-field-label' }, t('Retryable errors')),
          h('div', { className: 'bt-model-checks' },
            knownChoices.map((code) => {
              const checked = activeCodes.includes(code)
              return h('button', {
                key: code,
                type: 'button',
                className: 'bt-secret-bot bt-model-mod-btn',
                'aria-pressed': checked,
                title: code,
                disabled,
                onClick: () => toggleCode(code),
              }, CODE_LABELS[code] ? t(CODE_LABELS[code]) : code, checked ? h(CheckIcon) : null)
            }),
            customCodes.map(code => h('button', {
              key: `custom-${code}`,
              type: 'button',
              className: 'bt-secret-bot bt-model-mod-btn',
              'aria-pressed': true,
              disabled,
              onClick: () => toggleCode(code),
            }, h('code', null, code), h(CloseIcon)))),
          h('div', { className: 'bt-retry-custom-row' },
            h('input', {
              className: 'bt-input bt-model-effort-val',
              type: 'text',
              value: customCode,
              placeholder: t('Custom error code'),
              'aria-label': t('Custom error code'),
              disabled,
              spellCheck: false,
              autoComplete: 'off',
              onChange: event => setCustomCode(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); addCustomCode() } },
            }),
            h('button', {
              type: 'button',
              className: 'bt-soft bt-soft-sm',
              disabled: disabled || customCode.trim() === '',
              onClick: addCustomCode,
            }, t('Add'))))
      : null,
    modeValue !== '' && Object.keys(backoffFields).length > 0
      ? h(Fragment, null,
          h('button', {
            type: 'button',
            className: 'bt-retry-fold-btn',
            'aria-expanded': openBackoff,
            onClick: () => setOpenBackoff(open => !open),
          }, openBackoff ? h(ChevronDownIcon) : h(ChevronRightIcon), t('Backoff')),
          openBackoff
            ? h('div', { className: 'bt-retry-backoff-grid' },
                [
                  ['initialDelayMs', t('Initial delay (ms)'), backoffFields.initialDelayMs],
                  ['maxDelayMs', t('Max delay (ms)'), backoffFields.maxDelayMs],
                  ['jitterRatio', t('Jitter ratio'), backoffFields.jitterRatio],
                ].filter(([, , meta]) => meta !== undefined).map(([field, label, meta]) => h('label', { key: field, className: 'bt-model-field' },
                  h('span', { className: 'bt-model-field-label' }, label),
                  h('input', {
                    className: 'bt-input',
                    type: 'text',
                    inputMode: 'decimal',
                    value: numText(field, policy?.backoff?.[field]),
                    placeholder: meta.default !== undefined ? String(meta.default) : '',
                    'aria-label': label,
                    disabled,
                    spellCheck: false,
                    autoComplete: 'off',
                    onChange: event => setNumField(field, event.target.value, meta, true),
                    onBlur: () => blurNumField(field, policy?.backoff?.[field]),
                  }))))
            : null)
      : null)
}
