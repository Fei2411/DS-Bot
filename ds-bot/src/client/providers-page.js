// The Models page of a window that has no DSH settings of its own: the model providers
// DSH serves, with their API keys and models, and the providers it can add. DSH keeps
// all of it; a key only ever travels from these inputs to the host.
import { createElement as h, useEffect, useState } from 'react'
import { BotAvatar } from './mark.js'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon } from './icons.js'
import { KeyIcon, MaskedInput } from './secret-card.js'
import { Segmented, SPRING_SHAPE } from './motion.js'
import { isLocalRoute } from './agent-routes.js'
import { ProviderLogo, matchProviderId } from './provider-logos.js'
import { SelectMenu } from './select-menu.js'
import { hostText, t } from './i18n.js'
import { ChatGPTSettings } from './chatgpt-settings.js'
import { ModelListEditor } from './model-list-editor.js'
import {
  normalizeModelDrafts,
  protocolNeedsKey,
  protocolReasoningLevels,
  validateBaseUrl,
  validateModelRows,
} from './provider-model-utils.js'

const PROTOCOL_NAMES = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Gemini',
}
// Anthropic's SDK appends /v1/messages itself, Gemini takes /v1beta, and OpenAI takes /v1.
const ENDPOINT_HINTS = {
  'anthropic-messages': 'https://gateway.example',
  'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
}
const SHOWN_MODELS = 8

// A failure in the interface language; the dialog's error line shows it.
export const translated = promise => Promise.resolve(promise).catch((failure) => { throw new Error(hostText(failure?.message ?? String(failure))) })

// A discovery result as a draft: what the endpoint returned is selected; entries the
// endpoint no longer returns stay visible and selected, so a smaller upstream list never
// drops a hand-declared id without the user unchecking it.
export function draftFrom(provider, discovered) {
  const existing = Array.isArray(provider.declaredModels) && provider.declaredModels.length > 0
    ? provider.declaredModels
    : (provider.models ?? [])
  const byId = new Map(existing.filter(model => typeof model?.id === 'string' && model.id !== '').map(model => [model.id, model]))
  const seen = new Set()
  const rows = []
  for (const model of Array.isArray(discovered) ? discovered : []) {
    const id = typeof model?.id === 'string' ? model.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    rows.push({ id, model, existing: byId.has(id), returned: true, selected: true })
  }
  for (const model of existing) {
    if (typeof model?.id !== 'string' || model.id === '' || seen.has(model.id)) continue
    seen.add(model.id)
    rows.push({ id: model.id, model, existing: true, returned: false, selected: true })
  }
  return { rows, existingIds: new Set(rows.filter(row => row.existing).map(row => row.id)) }
}

export function draftSummary(draft) {
  const selected = draft.rows.filter(row => row.selected)
  return {
    selected,
    added: selected.filter(row => !row.existing).length,
    removed: draft.rows.filter(row => row.existing && !row.selected).length,
  }
}

const isLocalBot = bot => bot.engine !== undefined || isLocalRoute(bot.model ?? bot.appliedModel)

function catalogAfterSave(provider, draft, roster) {
  const before = Array.isArray(roster?.models) ? roster.models : []
  const known = new Map(before.map(entry => [entry.ref, entry]))
  const replacement = draftSummary(draft).selected.map((row) => {
    const ref = `${provider.id}/${row.id}`
    const entry = known.get(ref)
    if (entry !== undefined) return { ...entry, name: row.returned ? row.model?.name ?? row.id : entry.name }
    return {
      ref, provider: provider.id, providerName: provider.name, id: row.id,
      name: row.model?.name ?? row.id,
      ...(provider.key?.configured === false ? { needsKey: true } : {}),
    }
  })
  const out = []
  let placed = false
  for (const entry of before) {
    if (entry.provider === provider.id) {
      if (!placed) { out.push(...replacement); placed = true }
      continue
    }
    out.push(entry)
  }
  if (!placed) out.push(...replacement)
  return out
}

const usableModel = entries => entries.filter(entry => entry.needsKey !== true && !isLocalRoute(entry.ref))

// The model desiredModel() gives this Bot once the draft is saved: its own model while
// the catalog still serves it, else its last applied model while usable, else the
// default model (or the first usable one when the default is gone).
function nextModel(bot, entries, roster) {
  if (!bot.model) return undefined
  const own = entries.find(entry => entry.ref === bot.model)
  if (own !== undefined) return own
  const usable = usableModel(entries)
  const applied = bot.appliedModel === undefined ? undefined : usable.find(entry => entry.ref === bot.appliedModel)
  if (applied !== undefined) return applied
  const configured = Object.hasOwn(roster ?? {}, 'profileDefaultModel') ? roster.profileDefaultModel : roster?.defaultModel
  return usable.find(entry => entry.ref === configured) ?? usable[0]
}

// What saving this draft would do to each Bot that names a removed model. A model-backed
// Bot moves to the model desiredModel() picks; without a usable model it fails. A
// local-agent Bot keeps its own model and is listed only so it is not warned about.
export function fallbacksFor(provider, draft, roster) {
  const entries = catalogAfterSave(provider, draft, roster)
  const removed = new Set()
  for (const row of draft.rows) {
    if (row.existing && !row.selected) removed.add(row.model.ref ?? `${provider.id}/${row.id}`)
  }
  const seen = new Set()
  const switching = []
  const failed = []
  const local = []
  for (const bot of roster?.bots ?? []) {
    if (seen.has(bot.id) || (!removed.has(bot.model) && !removed.has(bot.appliedModel))) continue
    seen.add(bot.id)
    if (isLocalBot(bot)) { local.push(bot); continue }
    const target = nextModel(bot, entries, roster)
    if (target === undefined) failed.push(bot)
    else if (target.ref !== (bot.model ?? bot.appliedModel)) switching.push({ ...bot, target })
  }
  return { switching, failed, local }
}

function modelEditorImpact(provider, nextModels, resetModels, roster) {
  if (resetModels) return { switching: [], failed: [], local: [] }
  const nextIds = new Set(nextModels.map(m => (typeof m?.id === 'string' ? m.id.trim() : '')).filter(Boolean))
  const existing = Array.isArray(provider.models) ? provider.models : []
  const rows = [
    ...nextModels.map(m => {
      const id = typeof m?.id === 'string' ? m.id.trim() : ''
      return id ? { id, model: m, existing: existing.some(e => e.id === id), returned: true, selected: true } : null
    }).filter(Boolean),
    ...existing.filter(m => !nextIds.has(m.id)).map(m => ({ id: m.id, model: m, existing: true, returned: false, selected: false })),
  ]
  return fallbacksFor(provider, { rows }, roster)
}

export function ProvidersPage({ actions, run, roster, Section, advanced = null }) {
  const [view, setView] = useState(null)
  const [open, setOpen] = useState(null)
  const [adding, setAdding] = useState(false)
  // Resolves true when the host took it; the page then shows the host's new view.
  const apply = promise => run(translated(promise).then((next) => { if (next?.providers) setView(next) }))
  useEffect(() => { void apply(actions.providers()) }, [])
  if (view === null) return null
  if (!view.available) return h('p', { className: 'bt-set-hint' }, t('This DSH cannot set up model providers.'))
  const readOnly = view.writable === false || roster?.readOnly === true
  const addBtn = adding ? null : h('button', {
    type: 'button',
    className: 'bt-soft bt-soft-sm bt-with-icon',
    'data-tour': 'provider-add',
    disabled: readOnly,
    onClick: () => setAdding(true),
  }, h(PlusIcon), t('Add a provider'))
  return [
    readOnly ? h('div', { key: 'ro', className: 'bt-set-hint bt-provider-ro', role: 'status' }, t('Model provider settings are read-only in this window.')) : null,
    h(Section, { key: 'list', title: t('Model providers · {count}', { count: view.providers.length }), action: addBtn, tour: 'provider-list' },
      view.providers.map(provider => h(ProviderRow, {
        key: provider.id,
        provider,
        apply,
        actions,
        roster,
        revision: view.revision,
        protocols: view.protocols,
        reasoningLevels: view.reasoningLevels,
        readOnly,
        chatgptProvider: view.providers.find(entry => entry.auth === 'chatgpt'),
        open: open === provider.id,
        onToggle: () => setOpen(open === provider.id ? null : provider.id),
      })),
      adding && !readOnly ? h(AddProvider, { key: 'add', view, apply, actions, onDone: () => setAdding(false) }) : null),
    // DSH's own Models page: each model's context, output, inputs, thinking levels and order.
    advanced ? h('div', { key: 'advanced', className: 'bt-set-card', 'data-tour': 'provider-advanced' },
      h('button', { type: 'button', className: 'bt-set-row bt-bs-row bt-advanced', onClick: advanced },
        h('span', { className: 'bt-set-copy' }, h('span', null, t('Advanced settings'))), h(ChevronRightIcon))) : null,
  ]
}

function keyState(key) {
  if (key === null) return null
  if (!key.configured) return ['missing', t('Needs an API key')]
  return key.writable ? ['set', t('Key set')] : ['outside', t('Key set outside DS Bot')]
}

export function ProviderConfigEditor({
  provider, protocols = [], reasoningLevels = [], readOnly, apply, actions, roster, onOpenRefresh, refreshing, canRefresh,
}) {
  const family = provider.family
  const ownsIdentity = family === 'pi-ai' && provider.custom === true
  const initialDisplayName = provider.displayName ?? ''
  const initialBaseURL = provider.baseURL ?? ''
  const initialApi = provider.api ?? ''
  const initialModels = normalizeModelDrafts(provider.editableModels)

  const [displayName, setDisplayName] = useState(initialDisplayName)
  const [baseURL, setBaseURL] = useState(initialBaseURL)
  const [api, setApi] = useState(initialApi)
  const [models, setModels] = useState(initialModels)
  const [modelsEdited, setModelsEdited] = useState(false)
  const [resetModels, setResetModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [confirmImpact, setConfirmImpact] = useState(false)

  // Reset local draft whenever the server revision advances (after save or external reload).
  useEffect(() => {
    setDisplayName(provider.displayName ?? '')
    setBaseURL(provider.baseURL ?? '')
    setApi(provider.api ?? '')
    setModels(normalizeModelDrafts(provider.editableModels))
    setModelsEdited(false)
    setResetModels(false)
    setSaveError('')
    setConfirmImpact(false)
  }, [provider.revision, provider.id])

  const effectiveApi = ownsIdentity ? (api || provider.api) : provider.api
  const allowReasoning = family === 'pi-ai' && (provider.custom === true || models.some(m => m?.reasoningEfforts !== undefined))
  const reasoning = allowReasoning
    ? protocolReasoningLevels(effectiveApi, reasoningLevels)
    : { levels: [], levelsOnly: false }

  const baseUrlError = validateBaseUrl(baseURL, { strictDeepSeek: family === 'deepseek' })
  const modelsToValidate = resetModels ? [] : models
  const modelError = (!resetModels && (modelsEdited || (reasoning.levelsOnly && models.length > 0)))
    ? validateModelRows(modelsToValidate, {
        reasoningLevels: reasoning.levels,
        reasoningLevelsOnly: reasoning.levelsOnly,
        requireNonEmpty: ownsIdentity,
      })
    : undefined
  const protocolKeyMissing = family === 'pi-ai' && protocolNeedsKey(effectiveApi) && !provider.apiKeyEnv

  const displayNameChanged = ownsIdentity && displayName.trim() !== initialDisplayName.trim()
  const baseURLChanged = baseURL.trim() !== initialBaseURL.trim()
  const apiChanged = ownsIdentity && api !== initialApi && api !== ''
  const modelsChanged = resetModels || (modelsEdited && JSON.stringify(models) !== JSON.stringify(initialModels))
  const dirty = displayNameChanged || baseURLChanged || apiChanged || modelsChanged
  const invalid = Boolean(baseUrlError || modelError || protocolKeyMissing)
  const disabled = readOnly || saving

  const impact = modelsChanged ? modelEditorImpact(provider, models, resetModels, roster) : { switching: [], failed: [], local: [] }
  const hasImpact = impact.switching.length > 0 || impact.failed.length > 0

  const discard = () => {
    setDisplayName(initialDisplayName)
    setBaseURL(initialBaseURL)
    setApi(initialApi)
    setModels(initialModels)
    setModelsEdited(false)
    setResetModels(false)
    setSaveError('')
    setSavedNotice(false)
    setConfirmImpact(false)
  }

  const save = () => {
    if (disabled || !dirty || invalid || typeof actions.saveProviderConfig !== 'function') return
    if (hasImpact && !confirmImpact) {
      setConfirmImpact(true)
      return
    }
    const payload = {
      provider: provider.id,
      ...(provider.revision !== undefined ? { revision: provider.revision } : {}),
    }
    if (displayNameChanged) payload.displayName = displayName.trim() === '' ? null : displayName.trim()
    if (baseURLChanged) payload.baseURL = baseURL.trim() === '' ? null : baseURL.trim()
    if (apiChanged) payload.api = api
    if (resetModels) payload.resetModels = true
    else if (modelsChanged) payload.models = models

    setSaving(true)
    setSaveError('')
    setSavedNotice(false)
    void translated(actions.saveProviderConfig(payload))
      .then((next) => {
        if (next?.providers) return apply(Promise.resolve(next))
        return true
      })
      .then((ok) => {
        if (ok === false) return
        setModelsEdited(false)
        setResetModels(false)
        setConfirmImpact(false)
        setSavedNotice(true)
        void actions.refreshModels?.()
      })
      .catch((error) => {
        setSaveError(error?.message ?? String(error))
      })
      .finally(() => setSaving(false))
  }

  const effectiveOverridden = resetModels ? false : (modelsEdited ? true : provider.modelsOverridden)
  const refreshBtn = canRefresh
    ? h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        disabled: disabled || refreshing,
        'aria-busy': refreshing ? true : undefined,
        onClick: onOpenRefresh,
      }, refreshing ? t('Refreshing…') : t('Refresh models'))
    : null

  return h('div', { className: 'bt-provider-config' },
    ownsIdentity ? h('div', { className: 'bt-provider-pair' },
      h('label', { className: 'bt-model-field' },
        h('span', { className: 'bt-model-field-label' }, t('Display name')),
        h('input', {
          className: 'bt-input',
          type: 'text',
          value: displayName,
          placeholder: provider.baseDisplayName ?? provider.id,
          'aria-label': t('Display name'),
          disabled,
          spellCheck: false,
          autoComplete: 'off',
          onChange: (event) => { setDisplayName(event.target.value); setSavedNotice(false) },
        })),
      h('div', { className: 'bt-model-field' },
        h('span', { className: 'bt-model-field-label' }, t('Protocol')),
        h(SelectMenu, {
          'aria-label': t('Protocol'),
          value: api,
          disabled,
          placeholder: t('Select protocol'),
          options: (protocols.length > 0 ? protocols : Object.keys(PROTOCOL_NAMES)).map(choice => ({
            value: choice,
            label: PROTOCOL_NAMES[choice] ?? choice,
          })),
          onChange: (value) => { setApi(value); setSavedNotice(false) },
        }))) : null,
    h('label', { className: 'bt-model-field' },
      h('span', { className: 'bt-model-field-label' }, t('Base URL')),
      h('input', {
        className: 'bt-input',
        type: 'text',
        value: baseURL,
        placeholder: provider.effectiveBaseURL ?? provider.defaultBaseURL ?? ENDPOINT_HINTS[effectiveApi] ?? 'https://api.deepseek.com/anthropic',
        'aria-label': t('Base URL'),
        'aria-invalid': baseUrlError ? true : undefined,
        disabled,
        spellCheck: false,
        autoComplete: 'off',
        onChange: (event) => { setBaseURL(event.target.value); setSavedNotice(false) },
      })),
    baseUrlError ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' }, t(baseUrlError)) : null,
    protocolKeyMissing ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' }, t('Google Gemini requires an API key')) : null,
    h(ModelListEditor, {
      models,
      family,
      overridden: effectiveOverridden,
      defaultContextWindow: provider.defaultContextWindow,
      defaultMaxTokens: provider.defaultMaxTokens,
      defaultInput: provider.defaultInput,
      reasoningLevels: reasoning.levels,
      reasoningLevelsOnly: reasoning.levelsOnly,
      disabled,
      onChange: (next) => {
        setResetModels(false)
        setModelsEdited(true)
        setModels(next)
        setConfirmImpact(false)
        setSavedNotice(false)
      },
      onReset: () => {
        setResetModels(true)
        setModels(normalizeModelDrafts(provider.defaultModels))
        setModelsEdited(false)
        setConfirmImpact(false)
        setSavedNotice(false)
      },
      extraActions: refreshBtn,
    }),
    modelError ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' },
      modelError.index >= 0
        ? t('Model {index}: {error}', { index: modelError.index + 1, error: t(modelError.key) })
        : t(modelError.key)) : null,
    impact.switching.map(bot => h('div', { key: `switch-${bot.id}`, className: 'bt-set-hint bt-provider-used', role: 'status' },
      t('{name} will switch to {model} on its next turn.', { name: bot.name, model: bot.target.name ?? bot.target.ref }))),
    impact.failed.map(bot => h('div', { key: `fail-${bot.id}`, className: 'bt-set-hint bt-provider-used', role: 'status' },
      t('{name} has no model to fall back to; its next turn will fail.', { name: bot.name }))),
    saveError ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' }, saveError) : null,
    h('div', { className: 'bt-secret-row-actions bt-provider-form-bar' },
      savedNotice && !dirty ? h('span', { className: 'bt-set-hint bt-secret-ok', role: 'status' }, h(CheckIcon), t('Saved.')) : null,
      h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        disabled: disabled || !dirty,
        onClick: discard,
      }, t('Discard')),
      h('button', {
        type: 'button',
        className: 'bt-send bt-soft-sm',
        disabled: disabled || !dirty || invalid,
        onClick: save,
      }, saving ? t('Saving…') : (confirmImpact && hasImpact ? t('Save anyway') : t('Save')))))
}

export function ProviderRow({
  provider, apply, actions, roster, revision, protocols, reasoningLevels, readOnly = false, open, onToggle, chatgptProvider,
}) {
  const [confirm, setConfirm] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [draft, setDraft] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  useEffect(() => {
    if (open) return
    setConfirm(false)
    setDraft(null)
    setRefreshError('')
    setConfirmRemove(false)
  }, [open])
  const isChatGPT = provider.auth === 'chatgpt'
  const state = isChatGPT ? null : keyState(provider.key)
  const shown = provider.models.slice(0, SHOWN_MODELS)
  const hint = provider.error ?? (provider.models.length === 0 ? t('No models') : t('{count} models', { count: provider.models.length }))
  const canRefresh = provider.refreshable === true && !isChatGPT && !readOnly
  const hasFullEditor = !isChatGPT && provider.editable === true && (provider.family === 'deepseek' || provider.family === 'pi-ai') && typeof actions.saveProviderConfig === 'function'
  const refresh = () => {
    if (!canRefresh || refreshing) return
    setRefreshing(true)
    setRefreshError('')
    setDraft(null)
    setConfirmRemove(false)
    void translated((async () => {
      const view = await actions.providers()
      const fresh = view.providers.find(entry => entry.id === provider.id)
      if (fresh === undefined) throw new Error('The provider is no longer available')
      const list = await actions.providerModels({ provider: provider.id })
      await apply(Promise.resolve(view))
      setDraft({ ...draftFrom(fresh, list), revision: view.revision, provider: fresh })
    })())
      .catch(error => setRefreshError(error?.message ?? String(error)))
      .finally(() => setRefreshing(false))
  }
  const toggle = (id) => {
    setConfirmRemove(false)
    setDraft(current => current === null ? current : ({
      ...current,
      rows: current.rows.map(row => (row.id === id ? { ...row, selected: !row.selected } : row)),
    }))
  }
  const save = () => {
    if (draft === null) return
    const { selected } = draftSummary(draft)
    if (selected.length === 0) return
    const impact = fallbacksFor(provider, draft, roster)
    if ((impact.switching.length > 0 || impact.failed.length > 0) && !confirmRemove) {
      setConfirmRemove(true)
      return
    }
    const models = selected.map(row => (row.returned ? row.model : { id: row.id }))
    void apply(actions.saveProviderModels({ provider: provider.id, models, revision: draft.revision ?? revision })).then((ok) => {
      if (!ok) return
      setDraft(null)
      setConfirmRemove(false)
      void actions.refreshModels?.()
    })
  }
  const modelsBlock = hasFullEditor && draft === null
    ? h(ProviderConfigEditor, {
        provider,
        protocols,
        reasoningLevels,
        readOnly,
        apply,
        actions,
        roster,
        canRefresh,
        refreshing,
        onOpenRefresh: refresh,
      })
    : (provider.models.length > 0 || canRefresh)
      ? h('div', { className: 'bt-secret-edit-block' },
          h('div', { className: 'bt-provider-models-head' },
            h('span', { className: 'bt-secret-edit-label' }, t('Models')),
            canRefresh
              ? h('button', {
                  type: 'button', className: 'bt-soft bt-soft-sm', disabled: refreshing,
                  'aria-busy': refreshing ? true : undefined, onClick: refresh,
                }, refreshing ? t('Refreshing…') : t('Refresh models'))
              : null),
          draft !== null
            ? h(ModelDraft, { provider, draft, roster, onToggle: toggle, onSave: save, onCancel: () => { setDraft(null); setConfirmRemove(false) }, confirmRemove })
            : [
                provider.models.length > 0
                  ? h('div', { className: 'bt-provider-models' },
                      shown.map(model => h('span', { key: model.ref, className: 'bt-tag', title: model.ref }, model.name)),
                      provider.models.length > shown.length ? h('span', { className: 'bt-set-hint' }, t('and {count} more', { count: provider.models.length - shown.length })) : null)
                  : h('div', { className: 'bt-set-hint' }, t('No models')),
                refreshError ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' }, refreshError) : null,
              ])
      : null
  const logoId = matchProviderId({ provider: provider.id, providerName: provider.name, model: provider.models?.[0]?.ref, name: provider.models?.[0]?.name })
  const logo = logoId ? h(ProviderLogo, { provider: provider.id, providerName: provider.name, model: provider.models?.[0]?.ref, name: provider.models?.[0]?.name, size: 18 }) : null
  const monogram = (String(provider.name || provider.id).match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
  return h('div', { className: 'bt-secret-item bt-provider', 'data-open': open ? '' : undefined },
    h('button', { type: 'button', className: 'bt-set-row bt-secret-summary', 'aria-expanded': open, onClick: onToggle },
      h('span', { className: 'bt-provider-logo', 'data-provider': logoId ?? undefined, 'aria-hidden': true }, logo ?? monogram),
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-secret-title' }, provider.name, provider.removable && provider.name !== provider.id ? h('span', { className: 'bt-provider-id' }, provider.id) : null),
        h('span', { className: 'bt-set-hint', 'data-error': provider.error ? '' : undefined }, hint)),
      h('span', { className: 'bt-set-control' },
        h(UsedBy, { bots: usersOf(provider, roster) }),
        state ? h('span', { className: 'bt-provider-state', 'data-state': state[0] }, state[1]) : null,
        h('span', { className: 'bt-chevron bt-collapse-chevron', 'data-open': open || undefined }, h(ChevronDownIcon)))),
    open ? h('div', { className: 'bt-secret-edit' },
      !isChatGPT && provider.key?.writable ? h(KeyEditor, { provider, apply, actions, disabled: readOnly }) : null,
      !isChatGPT && provider.key && !provider.key.writable ? h('div', { className: 'bt-set-hint' }, t('This key comes from outside DS Bot, such as an environment variable, and cannot be changed here.')) : null,
      (provider.id === 'openai' || isChatGPT) && actions.chatgpt
        ? h(ChatGPTSettings, { actions, apply, provider: isChatGPT ? provider : chatgptProvider }) : null,
      isChatGPT ? null : modelsBlock,
      refreshError && hasFullEditor && draft === null ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'alert' }, refreshError) : null,
      !isChatGPT && provider.removable ? h('div', { className: 'bt-secret-row-actions' },
        confirm
          ? [
              h('span', { key: 'q', className: 'bt-set-hint' }, t('Remove {name}? Bots on its models need another model.', { name: provider.name })),
              h('button', { key: 'no', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setConfirm(false) }, t('Keep')),
              h('button', { key: 'yes', type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', disabled: readOnly, onClick: () => apply(actions.removeProvider(provider.id)) }, t('Remove')),
            ]
          : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', disabled: readOnly, onClick: () => setConfirm(true) }, h(TrashIcon), t('Remove provider'))) : null) : null)
}

function ModelDraft({ provider, draft, roster, onToggle, onSave, onCancel, confirmRemove }) {
  const { selected, added, removed } = draftSummary(draft)
  const { switching, failed, local } = fallbacksFor(provider, draft, roster)
  const localNames = [...new Set(local.map(bot => bot.name))]
  const returned = draft.rows.filter(row => row.returned)
  const unreturned = draft.rows.filter(row => !row.returned)
  const modelButton = row => h('button', {
    key: row.id, type: 'button', className: 'bt-secret-bot', 'aria-pressed': row.selected,
    title: row.model.name && row.model.name !== row.id ? row.model.name : undefined,
    onClick: () => onToggle(row.id),
  }, h('code', null, row.id), row.selected ? h(CheckIcon) : null)
  return h('div', { className: 'bt-provider-draft' },
    h('div', { className: 'bt-provider-models-head' },
      h('span', { className: 'bt-set-hint' }, t('{added} added · {removed} removed · {count} selected', { added, removed, count: selected.length }))),
    returned.length > 0
      ? h('div', { className: 'bt-provider-draft-group' },
          h('div', { className: 'bt-secret-edit-label' }, t('Models from the endpoint')),
          h('div', { className: 'bt-secret-bots bt-provider-found' }, returned.map(modelButton)))
      : h('div', { className: 'bt-set-hint' }, t('The endpoint lists no models.')),
    unreturned.length > 0
      ? h('div', { className: 'bt-provider-draft-group' },
          h('div', { className: 'bt-secret-edit-label' }, t("Upstream didn't return")),
          h('div', { className: 'bt-set-hint' }, t('Keep the ids you still want by hand.')),
          h('div', { className: 'bt-secret-bots bt-provider-found' }, unreturned.map(modelButton)))
      : null,
    selected.length === 0 ? h('div', { className: 'bt-set-hint', 'data-error': '', role: 'status' }, t('Select at least one model')) : null,
    switching.map(bot => h('div', { key: `switch-${bot.id}`, className: 'bt-set-hint bt-provider-used', role: 'status' },
      t('{name} will switch to {model} on its next turn.', { name: bot.name, model: bot.target.name ?? bot.target.ref }))),
    failed.map(bot => h('div', { key: `fail-${bot.id}`, className: 'bt-set-hint bt-provider-used', role: 'status' },
      t('{name} has no model to fall back to; its next turn will fail.', { name: bot.name }))),
    localNames.length > 0
      ? h('div', { className: 'bt-set-hint', role: 'status' }, t('Local agent, not affected: {names}', { names: localNames.join(t(', ')) }))
      : null,
    h('div', { className: 'bt-secret-row-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
      h('button', {
        type: 'button', className: 'bt-send bt-soft-sm', disabled: selected.length === 0, onClick: onSave,
      }, confirmRemove && (switching.length > 0 || failed.length > 0) ? t('Save anyway') : t('Save'))))
}

// The Bots whose model this provider serves, a few faces deep.
export const usersOf = (provider, roster) => {
  const refs = new Set(provider.models.map(model => model.ref))
  return (roster?.bots ?? []).filter(bot => refs.has(bot.model ?? bot.appliedModel))
}
export function UsedBy({ bots, size = 20, max = 4 }) {
  if (bots.length === 0) return null
  const names = bots.map(bot => bot.name).join(t(', '))
  return h('span', { className: 'bt-used-by', role: 'img', 'aria-label': t('Used by {names}', { names }), title: names },
    bots.slice(0, max).map(bot => h('span', { key: bot.id, className: 'bt-used-by-face' }, h(BotAvatar, { bot, size, badge: false, live: false }))),
    bots.length > max ? h('span', { className: 'bt-used-by-more' }, `+${bots.length - max}`) : null)
}

// `compact`: the one-line form Overview shows, without the heading or the remove button.
export function KeyEditor({ provider, apply, actions, compact = false, disabled = false }) {
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  const ready = !disabled && value.trim() !== ''
  const save = () => {
    if (!ready) return
    void apply(actions.setProviderKey(provider.id, value)).then((ok) => { if (ok) { setValue(''); setSaved(true) } })
  }
  const edit = (next) => { setValue(next); setSaved(false) }
  const label = t('{provider} API key', { provider: provider.name })
  if (compact) {
    return h('div', { className: 'bt-secret-inline bt-key-compact' },
      h('label', { className: 'bt-q-field bt-secret-field' }, h(KeyIcon), h(MaskedInput, { value, onChange: edit, onEnter: save, label, disabled })),
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: !ready, onClick: save }, t('Save')))
  }
  return h('div', { className: 'bt-secret-edit-block' },
    h('div', { className: 'bt-secret-edit-label' }, provider.key.configured ? t('Replace the API key') : t('API key')),
    h('div', { className: 'bt-secret-inline' },
      h('label', { className: 'bt-q-field bt-secret-field' }, h(KeyIcon), h(MaskedInput, { value, onChange: edit, onEnter: save, label, disabled })),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: !ready, onClick: save }, t('Save')),
      provider.key.configured ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', disabled, onClick: () => apply(actions.setProviderKey(provider.id, null)) }, t('Remove key')) : null),
    saved ? h('div', { className: 'bt-set-hint bt-secret-ok', role: 'status' }, h(CheckIcon), t('Saved.')) : null)
}

function AddProvider({ view, apply, actions, onDone }) {
  const [mode, setMode] = useState(view.addable.length > 0 ? 'known' : 'custom')
  return h('div', { className: 'bt-set-row bt-set-paste bt-provider-add' },
    h(Segmented, { label: t('Kind of provider'), value: mode },
      [['known', t('Known provider')], ['custom', t('Custom API')]].map(([id, label]) => h('button', {
        key: id, type: 'button', 'aria-pressed': mode === id, disabled: id === 'known' && view.addable.length === 0, onClick: () => setMode(id),
      }, label))),
    // Both forms stay mounted, so switching keeps what is typed in the other.
    h('div', { hidden: mode !== 'known' }, h(KnownForm, { view, apply, actions, onDone })),
    h('div', { hidden: mode !== 'custom' }, h(CustomForm, { view, apply, actions, onDone })))
}

function KnownForm({ view, apply, actions, onDone }) {
  const [provider, setProvider] = useState('')
  const [key, setKey] = useState('')
  const options = [...view.addable].sort((a, b) => a.name.localeCompare(b.name))
  const add = () => {
    if (provider === '') return
    void apply(actions.addProvider({ provider, key })).then((ok) => { if (ok) onDone() })
  }
  return h('div', { className: 'bt-provider-form' },
    h(SelectMenu, {
      'aria-label': t('Provider'),
      value: provider,
      placeholder: t('Choose a provider'),
      options: options.map(option => ({ value: option.id, label: option.name })),
      onChange: setProvider,
    }),
    provider === 'openai' && actions.chatgpt
      ? h(ChatGPTSettings, { actions, apply, provider: view.providers.find(entry => entry.auth === 'chatgpt') }) : null,
    h('label', { className: 'bt-q-field bt-secret-field' }, h(KeyIcon), h(MaskedInput, { value: key, onChange: setKey, onEnter: add, label: t('API key') })),
    h(FormActions, { onCancel: onDone, onAdd: add, ready: provider !== '' }))
}

// Exported so the Add form's readiness and missing-field hint can be driven without a
// whole settings page: the hint is what tells the user why Add stays disabled.
export function CustomForm({ view, apply, actions, onDone }) {
  const [draft, setDraft] = useState({ provider: '', name: '', baseURL: '', api: view.protocols[0], key: '', typed: '' })
  const [found, setFound] = useState(null)
  const [picked, setPicked] = useState([])
  const [asking, setAsking] = useState(false)
  const set = (field, value) => setDraft(current => ({ ...current, [field]: value }))
  const typed = draft.typed.split(/[\s,]+/).map(id => id.trim()).filter(Boolean)
  const models = [...(found ?? []).filter(model => picked.includes(model.id)), ...typed.filter(id => !picked.includes(id)).map(id => ({ id }))]
  const missing = []
  if (draft.provider.trim() === '') missing.push(t('Provider ID'))
  if (draft.baseURL.trim() === '') missing.push(t('Endpoint'))
  if (models.length === 0) missing.push(t('At least one model'))
  const ready = missing.length === 0
  const missingHint = ready ? null : h('div', { className: 'bt-set-hint bt-provider-missing', role: 'status' },
    t('Please enter: {fields}', {
      fields: missing.join(t(', ')),
    }))
  const fetchModels = () => {
    setAsking(true)
    void apply(Promise.resolve(actions.providerModels({ baseURL: draft.baseURL, api: draft.api, key: draft.key })).then((list) => { setFound(list); setPicked([]) }))
      .finally(() => setAsking(false))
  }
  const toggle = id => setPicked(list => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]))
  const add = () => {
    if (!ready) return
    void apply(actions.addProvider({ custom: true, provider: draft.provider.trim(), name: draft.name, baseURL: draft.baseURL, api: draft.api, key: draft.key, models }))
      .then((ok) => { if (ok) onDone() })
  }
  const input = (field, label, placeholder) => h('input', {
    className: 'bt-input', 'aria-label': label, placeholder, value: draft[field], spellCheck: false, autoComplete: 'off', onChange: event => set(field, event.target.value),
  })
  return h('div', { className: 'bt-provider-form' },
    h('div', { className: 'bt-provider-pair' },
      input('provider', t('Provider ID'), t('Provider ID, e.g. my-gateway')),
      input('name', t('Name'), t('Name (optional)'))),
    h('div', { className: 'bt-provider-pair' },
      input('baseURL', t('Endpoint'), ENDPOINT_HINTS[draft.api] ?? 'https://gateway.example/v1'),
      h(SelectMenu, {
        'aria-label': t('Protocol'),
        value: draft.api,
        options: view.protocols.map(api => ({ value: api, label: PROTOCOL_NAMES[api] ?? api })),
        onChange: value => set('api', value),
      })),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(KeyIcon), h(MaskedInput, { value: draft.key, onChange: value => set('key', value), label: t('API key') })),
    h('div', { className: 'bt-secret-edit-block' },
      h('div', { className: 'bt-provider-models-head' },
        h('span', { className: 'bt-secret-edit-label' }, t('Models')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: asking || draft.baseURL.trim() === '', onClick: fetchModels }, asking ? t('Asking…') : t('Fetch models'))),
      found !== null && found.length === 0 ? h('div', { className: 'bt-set-hint' }, t('The endpoint lists no models. Enter their ids below.')) : null,
      found !== null && found.length > 0 ? h('div', { className: 'bt-secret-bots bt-provider-found' }, found.map(model => h('button', {
        key: model.id, type: 'button', className: 'bt-secret-bot', 'aria-pressed': picked.includes(model.id), title: model.name && model.name !== model.id ? model.name : undefined, onClick: () => toggle(model.id),
      }, h('code', null, model.id), picked.includes(model.id) ? h(CheckIcon) : null))) : null,
      input('typed', t('Model ids'), t('Model ids, separated by commas'))),
    missingHint,
    h(FormActions, { onCancel: onDone, onAdd: add, ready }))
}

function FormActions({ onCancel, onAdd, ready }) {
  return h('div', { className: 'bt-secret-row-actions' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onCancel }, t('Cancel')),
    h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: !ready, onClick: onAdd }, t('Add')))
}

export const PROVIDERS_CSS = `
.bt-provider .bt-secret-summary{gap:12px}
.bt-provider-ro{margin:0 0 10px}
.bt-provider-logo{flex:none;width:32px;height:32px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-hover);color:var(--bt-ink);font-size:13px;font-weight:600;line-height:1}
.bt-provider-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--bt-ink-3)}
.bt-chatgpt{padding:12px;border:1px solid var(--bt-line);border-radius:12px;min-width:0}
.bt-chatgpt-account{display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}
.bt-chatgpt .bt-set-hint{margin:0}
.bt-chatgpt [data-error]{color:var(--bt-danger)}
.bt-chatgpt .bt-secret-row-actions{flex-wrap:wrap}
.bt-chatgpt button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-provider .bt-set-hint[data-error]{color:var(--bt-danger)}
.bt-provider-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--bt-ink-2);white-space:nowrap}
.bt-provider-state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--bt-ink-3)}
.bt-provider-state[data-state=set]::before{background:var(--bt-green)}
.bt-provider-state[data-state=missing]{color:var(--bt-danger)}
.bt-provider-state[data-state=missing]::before{background:var(--bt-danger)}
.bt-provider .bt-secret-field{align-items:center;gap:8px}
.bt-provider .bt-secret-field>svg,.bt-provider-form .bt-secret-field>svg{flex:none;color:var(--bt-ink-3)}
.bt-provider-models{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.bt-provider-models .bt-tag{max-width:220px}
.bt-provider-add{gap:12px;animation:bt-q-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,bt-veil-in .2s ease-out backwards}
.bt-provider-add .bt-seg:not([data-layout]){align-self:flex-start}
.bt-provider-add .bt-seg:not([data-layout]) button{padding:0 14px}
.bt-provider-add .bt-seg button:disabled{opacity:.45;cursor:default}
.bt-provider-form{display:flex;flex-direction:column;gap:10px}
.bt-provider-form .bt-secret-field{min-height:36px;align-items:center;gap:8px}
.bt-provider-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bt-provider-pair .bt-sel{height:36px}
.bt-provider-models-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.bt-provider-missing{color:var(--bt-ink-3)}
.bt-provider-draft{display:flex;flex-direction:column;gap:8px}
.bt-provider-draft-group{display:flex;flex-direction:column;gap:6px}
.bt-provider-draft>.bt-set-hint,.bt-provider-draft-group>.bt-set-hint{margin:0}
.bt-provider-used{color:var(--bt-danger)}
.bt-provider-draft .bt-secret-row-actions{margin-top:2px}
/* Room for the pills' focus rings inside the scroll box; the margin keeps them in line with the fields. */
.bt-provider-found{max-height:180px;overflow-y:auto;scrollbar-width:thin;padding:3px;margin:-3px}
.bt-provider-found code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.bt-provider-found .bt-secret-bot{padding:0 10px}
.bt-provider-config{display:flex;flex-direction:column;gap:12px;padding-top:4px;border-top:.5px solid var(--bt-line)}
.bt-provider-form-bar{justify-content:flex-end;align-items:center;gap:8px;padding-top:4px}
.bt-model-editor{display:flex;flex-direction:column;gap:8px}
.bt-model-editor-title{display:inline-flex;align-items:center;gap:8px}
.bt-model-editor-actions{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.bt-model-list{display:flex;flex-direction:column;gap:6px}
.bt-model-row{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-main);transition:border-color .12s ease,opacity .12s ease}
.bt-model-row[data-dragging]{opacity:.5}
.bt-model-row[data-drop-target=before]{border-top:2px solid var(--bt-accent)}
.bt-model-row[data-drop-target=after]{border-bottom:2px solid var(--bt-accent)}
.bt-model-row-main{display:flex;align-items:center;gap:6px}
.bt-model-order{display:inline-flex;align-items:center;gap:2px;flex:none;cursor:grab}
.bt-model-step-btn{width:28px;height:28px}
.bt-model-id-input{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;height:32px}
.bt-model-row-danger{color:var(--bt-ink-2)}
.bt-model-row-danger:hover:not(:disabled){color:var(--bt-danger);background:color-mix(in srgb,var(--bt-danger) 10%,transparent)}
.bt-model-row-detail{display:flex;flex-direction:column;gap:10px;padding:8px 4px 2px;border-top:.5px solid var(--bt-line)}
.bt-model-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.bt-model-field-label{font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2)}
.bt-model-cap-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bt-model-checks{display:flex;flex-wrap:wrap;gap:6px}
.bt-model-mod-btn{padding:0 10px}
.bt-model-reasoning{display:flex;flex-direction:column;gap:8px;padding-top:6px;border-top:.5px solid var(--bt-line)}
.bt-model-reasoning-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-model-reasoning-row{display:grid;grid-template-columns:minmax(96px,130px) 1fr 28px;gap:6px;align-items:center}
.bt-model-reasoning-cols{margin-bottom:-2px}
.bt-model-effort-val{height:32px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.bt-model-add-level,.bt-model-add-btn{align-self:flex-start}
@container (max-width:440px){.bt-provider .bt-secret-summary{flex-direction:row;align-items:center;flex-wrap:wrap}.bt-provider .bt-secret-summary>.bt-set-copy{width:auto;flex:1 1 120px;min-width:0}.bt-provider-pair,.bt-model-cap-grid{grid-template-columns:1fr}}
@media (max-width:768px){.bt-provider .bt-secret-summary{flex-direction:row;align-items:center;flex-wrap:wrap}.bt-provider .bt-secret-summary>.bt-set-copy{width:auto;flex:1 1 120px;min-width:0}.bt-provider-pair,.bt-model-cap-grid{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.bt-provider-add{animation:none}}
`
