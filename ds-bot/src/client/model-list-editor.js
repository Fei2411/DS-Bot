// Editable model catalog list for a provider card (DeepSeek and pi-ai routes):
// model ID, display name, add/remove/reorder, context window, max output tokens,
// input modalities (Text / Images), per-model reasoning levels, and Reset to default.
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { Switch } from './bot-settings.js'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, PlusIcon, TrashIcon } from './icons.js'
import { SelectMenu } from './select-menu.js'
import { t } from './i18n.js'
import {
  DEFAULT_CAPACITY_HINTS,
  INITIAL_REASONING_LEVELS,
  acceptedEffortValue,
  defaultEffortValue,
  formatCapacity,
  parseCapacity,
  readEfforts,
  withEfforts,
} from './provider-model-utils.js'

function createRowState(key) {
  return { key, expanded: false, editing: new Map() }
}

function useModelRows(models, onChange, disabled) {
  const nextKey = useRef(0)
  const [stored, setRows] = useState(() => models.map(() => createRowState(nextKey.current++)))
  const [dragged, setDragged] = useState(undefined)
  const [target, setTarget] = useState(undefined)

  const entries = models.map((model, index) => ({ model, state: stored[index] ?? createRowState(nextKey.current++) }))
  const rows = entries.map(entry => entry.state)
  if (stored.length !== models.length) setRows(rows)

  const endDrag = () => { setDragged(undefined); setTarget(undefined) }
  const move = (from, to) => {
    if (disabled || from === to || from < 0 || to < 0 || to >= models.length) return
    const order = [...entries]
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved)
    setRows(order.map(entry => entry.state))
    onChange(order.map(entry => entry.model))
  }

  return {
    rows: entries.map(({ model, state }, index) => ({
      ...state,
      model,
      order: {
        dragging: dragged === state.key,
        target: target?.key === state.key ? target.half : undefined,
        canDrop: !disabled && dragged !== undefined,
        onStart: () => setDragged(state.key),
        onEnd: endDrag,
        onOver: (half) => setTarget(cur => (cur?.key === state.key && cur.half === half ? cur : { key: state.key, half })),
        onLeave: () => setTarget(cur => (cur?.key === state.key ? undefined : cur)),
        onDrop: (half) => {
          const from = rows.findIndex(row => row.key === dragged)
          const insertion = index + (half === 'after' ? 1 : 0)
          move(from, insertion > from ? insertion - 1 : insertion)
          endDrag()
        },
        onMove: offset => move(index, index + offset),
      },
    })),
    toggle: (index) => setRows(rows.map((row, at) => (at === index ? { ...row, expanded: !row.expanded } : row))),
    edit: (index, field, text) => {
      setRows(rows.map((row, at) => {
        if (at !== index) return row
        const editing = new Map(row.editing)
        if (text === undefined) editing.delete(field)
        else editing.set(field, text)
        return { ...row, editing }
      }))
    },
    forget: (removed) => {
      setRows(rows.filter((_, index) => !removed.has(index)))
      endDrag()
    },
    reset: () => {
      setRows(models.map(() => createRowState(nextKey.current++)))
      endDrag()
    },
  }
}

function rowHalf(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

function ModelInputTypes({ model, field, position, fallback, disabled, onChange }) {
  const raw = model[field]
  const selected = Array.isArray(raw) && raw.length > 0 ? raw : (Array.isArray(fallback) && fallback.length > 0 ? fallback : ['text'])
  const toggle = (modality) => {
    if (disabled) return
    const has = selected.includes(modality)
    if (has && selected.length === 1) return
    const nextSelected = ['text', 'image'].filter(kind => (kind === modality ? !has : selected.includes(kind)))
    const next = { ...model, [field]: nextSelected }
    // DeepSeek rejects image request limits on a text-only model.
    if (field === 'inputModalities' && !nextSelected.includes('image')) {
      delete next.imagePixelBudget
      delete next.imageMaxBytes
    }
    onChange(next)
  }
  return h('div', { className: 'bt-model-field', role: 'group', 'aria-label': `${t('Input types')} ${position}` },
    h('span', { className: 'bt-model-field-label' }, t('Input types')),
    h('div', { className: 'bt-model-checks' },
      [['text', t('Text')], ['image', t('Images')]].map(([modality, label]) => {
        const checked = selected.includes(modality)
        const locked = disabled || (selected.length === 1 && checked)
        return h('button', {
          key: modality,
          type: 'button',
          className: 'bt-secret-bot bt-model-mod-btn',
          'aria-pressed': checked,
          disabled: locked,
          onClick: () => toggle(modality),
        }, label, checked ? h(CheckIcon) : null)
      })))
}

function ModelReasoningEfforts({ model, levels, levelsOnly, position, disabled, onChange }) {
  const entries = readEfforts(model)
  const [typing, setTyping] = useState(undefined)
  const used = entries?.map(([level]) => level) ?? []

  const write = next => onChange(withEfforts(model, next))
  const replaceAt = (current, index, entry) => current.map((existing, at) => (at === index ? entry : existing))

  const changeLevel = (current, index, from, wire, to) => {
    const carried = !levelsOnly && typeof wire === 'string' && wire.length > 0 && wire !== from && from !== 'off' && to !== 'off'
    write(replaceAt(current, index, [to, carried ? wire : defaultEffortValue(to)]))
  }

  const addLevel = (current) => {
    const highest = Math.max(-1, ...used.map(level => levels.indexOf(level)))
    const level = levels.find((candidate, index) => index > highest && !used.includes(candidate))
      ?? levels.find(candidate => !used.includes(candidate))
    if (level === undefined) return
    write([...current, [level, defaultEffortValue(level)]])
  }

  const editValue = (current, index, level, text) => {
    setTyping({ level, text })
    const trimmed = text.trim()
    write(replaceAt(current, index, [level, trimmed.length === 0 ? defaultEffortValue(level) : trimmed]))
  }

  const leaveValue = (current, index, level, wire) => {
    setTyping(undefined)
    if (!acceptedEffortValue(level, wire)) write(replaceAt(current, index, [level, defaultEffortValue(level)]))
  }

  const choicesFor = (level) => [
    ...(levels.includes(level) ? [] : [level]),
    ...levels.filter(choice => choice === level || !used.includes(choice)),
  ]
  const initialEntries = INITIAL_REASONING_LEVELS
    .filter(level => levels.includes(level))
    .map(level => [level, defaultEffortValue(level)])
  const fallbackEntries = initialEntries.length > 0
    ? initialEntries
    : levels.slice(0, 3).map(level => [level, defaultEffortValue(level)])

  const outside = levelsOnly && entries?.some(([level, wire]) => !levels.includes(level) || wire !== level) === true
  const refused = entries?.some(([level, wire]) => !acceptedEffortValue(level, wire)) === true
  const missingLevel = entries !== undefined && !used.some(level => level !== 'off')

  return h('div', { className: 'bt-model-reasoning', role: 'group', 'aria-label': `${t('Reasoning levels')} ${position}` },
    h('div', { className: 'bt-model-reasoning-head' },
      h('span', { className: 'bt-model-field-label' }, t('Reasoning levels')),
      h(Switch, {
        label: `${t('Reasoning levels')} ${position}`,
        on: entries !== undefined,
        disabled,
        onChange: on => write(on ? fallbackEntries : undefined),
      })),
    entries !== undefined ? h(Fragment, null,
      entries.length > 0 ? h('div', { className: 'bt-model-reasoning-row bt-model-reasoning-cols', 'aria-hidden': true },
        h('span', { className: 'bt-model-field-label' }, t('Level')),
        h('span', { className: 'bt-model-field-label' }, t('API value'))) : null,
      entries.map(([level, wire], index) => h('div', { key: index, className: 'bt-model-reasoning-row' },
        h(SelectMenu, {
          'aria-label': `${t('Level')} ${index + 1}`,
          value: level,
          disabled,
          variant: 'compact',
          options: choicesFor(level).map(choice => ({ value: choice, label: choice })),
          onChange: to => changeLevel(entries, index, level, wire, to),
        }),
        h('input', {
          className: 'bt-input bt-model-effort-val',
          type: 'text',
          value: typing?.level === level ? typing.text : (typeof wire === 'string' ? wire : ''),
          placeholder: level === 'off' ? t('None') : level,
          'aria-label': `${level} ${t('API value')}`,
          'aria-invalid': !acceptedEffortValue(level, wire) ? true : undefined,
          disabled: disabled || level === 'off' || levelsOnly,
          spellCheck: false,
          autoComplete: 'off',
          onChange: event => editValue(entries, index, level, event.target.value),
          onBlur: () => leaveValue(entries, index, level, wire),
        }),
        h('button', {
          type: 'button',
          className: 'bt-icon-btn bt-model-row-danger',
          'aria-label': `${t('Remove level')} ${level}`,
          title: t('Remove level'),
          disabled,
          onClick: () => write(entries.filter((_, at) => at !== index)),
        }, h(TrashIcon)))),
      outside
        ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' }, t('Gemini supports only minimal, low, medium, and high'))
        : refused
          ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' }, t('Enter an API value for each reasoning level'))
          : missingLevel
            ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' }, t('Add at least one reasoning level besides Off'))
            : null,
      h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm bt-with-icon bt-model-add-level',
        disabled: disabled || levels.every(level => used.includes(level)),
        onClick: () => addLevel(entries),
      }, h(PlusIcon), t('Add level'))) : null)
}

function ModelRowItem({
  model, rowKey, position, total, order, inputField, inputFallback,
  reasoningLevels, reasoningLevelsOnly, expanded, disabled,
  contextWindow, maxTokens, onFieldChange, onIdBlur, onChange, onToggle, onRemove,
}) {
  const showReasoning = Array.isArray(reasoningLevels) && reasoningLevels.length > 0
  return h('div', {
    className: 'bt-model-row',
    'data-row-key': rowKey,
    'data-expanded': expanded ? '' : undefined,
    'data-dragging': order.dragging ? '' : undefined,
    'data-drop-target': order.dragging ? undefined : order.target,
    onDragOver: (event) => {
      if (!order.canDrop) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      order.onOver(rowHalf(event))
    },
    onDragLeave: (event) => {
      if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return
      order.onLeave()
    },
    onDrop: (event) => {
      if (!order.canDrop) return
      event.preventDefault()
      order.onDrop(rowHalf(event))
    },
  },
  h('div', { className: 'bt-model-row-main' },
    h('div', {
      className: 'bt-model-order',
      draggable: !disabled,
      onDragStart: (event) => {
        if (disabled) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', String(position))
        order.onStart()
      },
      onDragEnd: () => order.onEnd(),
      onKeyDown: (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        event.stopPropagation()
        order.onMove(event.key === 'ArrowUp' ? -1 : 1)
      },
    },
    h('button', {
      type: 'button',
      className: 'bt-icon-btn bt-model-step-btn',
      'aria-label': `${t('Move up')} ${position}`,
      title: t('Move up'),
      disabled: disabled || position === 1,
      onClick: () => order.onMove(-1),
    }, h(ChevronUpIcon)),
    h('button', {
      type: 'button',
      className: 'bt-icon-btn bt-model-step-btn',
      'aria-label': `${t('Move down')} ${position}`,
      title: t('Move down'),
      disabled: disabled || position === total,
      onClick: () => order.onMove(1),
    }, h(ChevronDownIcon))),
    h('input', {
      className: 'bt-input bt-model-id-input',
      type: 'text',
      value: typeof model.id === 'string' ? model.id : '',
      placeholder: t('Model ID'),
      'aria-label': `${t('Model ID')} ${position}`,
      disabled,
      spellCheck: false,
      autoComplete: 'off',
      onChange: event => onFieldChange('id', event.target.value),
      onBlur: event => onIdBlur?.(event.target.value),
    }),
    h('button', {
      type: 'button',
      className: 'bt-icon-btn',
      'aria-label': `${t('Model details')} ${position}`,
      'aria-expanded': expanded,
      title: t('Model details'),
      onClick: onToggle,
    }, expanded ? h(ChevronDownIcon) : h(ChevronRightIcon)),
    h('button', {
      type: 'button',
      className: 'bt-icon-btn bt-model-row-danger',
      'aria-label': `${t('Remove model')} ${position}`,
      title: t('Remove model'),
      disabled,
      onClick: onRemove,
    }, h(TrashIcon))),
  expanded ? h('div', { className: 'bt-model-row-detail' },
    h('label', { className: 'bt-model-field bt-model-field-wide' },
      h('span', { className: 'bt-model-field-label' }, t('Display name')),
      h('input', {
        className: 'bt-input',
        type: 'text',
        value: typeof model.name === 'string' ? model.name : '',
        placeholder: typeof model.id === 'string' && model.id.trim() !== '' ? model.id.trim() : t('Display name'),
        'aria-label': `${t('Display name')} ${position}`,
        disabled,
        spellCheck: false,
        autoComplete: 'off',
        onChange: event => onFieldChange('name', event.target.value === '' ? undefined : event.target.value),
      })),
    h('div', { className: 'bt-model-cap-grid' },
      [['contextWindow', t('Context window'), contextWindow], ['maxTokens', t('Max output'), maxTokens]].map(([field, label, cfg]) => h('label', { key: field, className: 'bt-model-field' },
        h('span', { className: 'bt-model-field-label' }, label),
        h('input', {
          className: 'bt-input',
          type: 'text',
          inputMode: 'numeric',
          value: cfg.value,
          placeholder: cfg.placeholder,
          'aria-label': `${label} ${position}`,
          disabled,
          spellCheck: false,
          autoComplete: 'off',
          onChange: event => cfg.onChange(event.target.value),
          onBlur: cfg.onBlur,
        })))),
    h(ModelInputTypes, {
      model,
      field: inputField,
      position,
      fallback: inputFallback,
      disabled,
      onChange,
    }),
    showReasoning ? h(ModelReasoningEfforts, {
      model,
      levels: reasoningLevels,
      levelsOnly: reasoningLevelsOnly === true,
      position,
      disabled,
      onChange,
    }) : null) : null)
}

export function ModelListEditor({
  models,
  family,
  overridden,
  inheritedCount = 0,
  resetEpoch = 0,
  defaultContextWindow,
  defaultMaxTokens,
  defaultInput,
  reasoningLevels,
  reasoningLevelsOnly,
  disabled = false,
  onChange,
  onReset,
  extraActions = null,
}) {
  const rowState = useModelRows(models, onChange, disabled)
  const lastEpoch = useRef(resetEpoch)
  useEffect(() => {
    if (lastEpoch.current === resetEpoch) return
    lastEpoch.current = resetEpoch
    rowState.reset()
  }, [resetEpoch])
  const inputField = family === 'deepseek' ? 'inputModalities' : 'input'

  const updateField = (index, field, value) => {
    const next = models.map((model, at) => {
      if (at !== index) return model
      const copy = { ...model }
      if (value === undefined || (field !== 'id' && value === '')) delete copy[field]
      else copy[field] = value
      return copy
    })
    onChange(next)
  }

  const remove = (index) => {
    rowState.forget(new Set([index]))
    onChange(models.filter((_, at) => at !== index))
  }

  const reset = () => {
    rowState.reset()
    onReset?.()
  }

  const capacityText = (model, index, field) => {
    const typed = rowState.rows[index]?.editing.get(field)
    if (typed !== undefined) return typed
    const value = model[field]
    return typeof value === 'number' ? formatCapacity(value) : ''
  }

  const settleCapacity = (index, field) => {
    const typed = rowState.rows[index]?.editing.get(field)
    if (typed === undefined) return
    const parsed = parseCapacity(typed)
    if (parsed !== undefined && Number.isNaN(parsed)) return
    rowState.edit(index, field, undefined)
  }

  const capInput = (model, index, field, fallback) => ({
    value: capacityText(model, index, field),
    placeholder: typeof fallback === 'number' ? formatCapacity(fallback) : DEFAULT_CAPACITY_HINTS[field],
    onChange: (text) => {
      rowState.edit(index, field, text)
      updateField(index, field, parseCapacity(text))
    },
    onBlur: () => settleCapacity(index, field),
  })

  return h('div', { className: 'bt-secret-edit-block bt-model-editor' },
    h('div', { className: 'bt-provider-models-head' },
      h('span', { className: 'bt-model-editor-title' },
        h('span', { className: 'bt-secret-edit-label' }, t('Models')),
        overridden !== undefined
          ? h('span', { className: 'bt-tag' }, overridden ? t('Customized') : t('Default'))
          : null),
      h('div', { className: 'bt-model-editor-actions' },
        overridden === true && onReset
          ? h('button', { type: 'button', className: 'bt-mini', disabled, onClick: reset }, t('Reset to default'))
          : null,
        extraActions)),
    models.length === 0
      ? h('div', { className: 'bt-set-hint' },
          overridden === false && family === 'pi-ai' && inheritedCount > 0
            ? t('Using built-in catalog ({count} models)', { count: inheritedCount })
            : t('No models configured.'))
      : h('div', { className: 'bt-model-list' },
          rowState.rows.map(({ model, key, expanded, order }, index) => h(ModelRowItem, {
            key,
            rowKey: key,
            model,
            position: index + 1,
            total: models.length,
            order,
            inputField,
            inputFallback: defaultInput,
            reasoningLevels,
            reasoningLevelsOnly,
            expanded,
            disabled,
            contextWindow: capInput(model, index, 'contextWindow', defaultContextWindow),
            maxTokens: capInput(model, index, 'maxTokens', defaultMaxTokens),
            onFieldChange: (field, value) => updateField(index, field, value),
            onIdBlur: (value) => {
              const trimmed = value.trim()
              if (trimmed !== value) updateField(index, 'id', trimmed)
            },
            onChange: next => onChange(models.map((row, at) => (at === index ? next : row))),
            onToggle: () => rowState.toggle(index),
            onRemove: () => remove(index),
          }))),
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm bt-with-icon bt-model-add-btn',
      disabled,
      onClick: () => onChange([...models.map(m => ({ ...m })), { id: '' }]),
    }, h(PlusIcon), t('Add model')))
}
