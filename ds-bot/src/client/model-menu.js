import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { currentPart } from './text.js'
import { CheckIcon, SlidersIcon } from './icons.js'
import { BotMark } from './mark.js'
import { KeyIcon, MaskedInput } from './secret-card.js'
import { SPRING_POP, SPRING_SHAPE, SPRING_TAP, spring, stepMenuFocus, useLinger, useViewport, viewBottom } from './motion.js'
import { hostText, t } from './i18n.js'

const MENU_EXIT_MS = 120

// -------------------------------------------------------------------------
// A Bot's model: the picker in its details panel and settings, and the message its
// chat opens on while it has none. Models come from DeepSeek Harness, grouped by provider.

export function groupModels(models) {
  const groups = new Map()
  for (const model of models ?? []) {
    const provider = model.provider ?? model.providerName ?? model.ref.split('/')[0]
    if (!groups.has(provider)) groups.set(provider, [])
    groups.get(provider).push(model)
  }
  const names = new Map()
  for (const [provider, list] of groups) {
    const name = list[0].providerName ?? provider
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  return [...groups].map(([provider, list]) => {
    const name = list[0].providerName ?? provider
    return [names.get(name) > 1 ? `${name} (${provider})` : name, list]
  })
}

const servedOf = (roster, ref) => (roster.models ?? []).find(model => model.ref === ref)

// What a Bot runs on, for display: the chosen model, else the one it last ran on.
export function modelOf(bot, roster) {
  const ref = bot.model ?? bot.appliedModel
  if (!ref) return undefined
  const served = servedOf(roster, ref)
  const [provider, ...rest] = ref.split('/')
  return { ref, name: served?.name ?? rest.join('/'), provider: served?.providerName ?? provider, served: served !== undefined }
}

// The thinking levels of one model, `{efforts, defaultEffort?}` or undefined when it
// has none. The catalog carries them for models Bots use; any other ref asks the host.
const effortCache = new Map()
function useEfforts(served, ref, actions) {
  const [fetched, setFetched] = useState(undefined)
  useEffect(() => {
    setFetched(undefined)
    if (ref === undefined || served?.reasoning !== undefined || actions?.efforts === undefined) return undefined
    let live = true
    if (effortCache.has(ref)) setFetched(effortCache.get(ref))
    else void Promise.resolve(actions.efforts(ref)).then((value) => {
      const reasoning = value?.efforts ? value : null
      effortCache.set(ref, reasoning)
      if (live) setFetched(reasoning)
    }).catch(() => {})
    return () => { live = false }
  }, [ref, served?.reasoning !== undefined, actions])
  return served?.reasoning ?? fetched
}

// The rows of the Thinking section: a Default row that clears the Bot's pick, then every
// level the model serves.
export function effortRows(reasoning) {
  if (reasoning?.efforts === undefined || reasoning.efforts.length === 0) return []
  return [
    { effort: undefined, label: t('Default') },
    ...reasoning.efforts.map(effort => ({ effort: effort.id, label: effort.name })),
  ]
}

// The stops along the thinking-level slider: when the model names its default level,
// the stops are the levels themselves and the reset action clears back to Default;
// otherwise Default sits at the first stop.
export function effortStops(reasoning) {
  const efforts = reasoning?.efforts ?? []
  if (efforts.length === 0) return []
  const hasDefault = efforts.some(effort => effort.id === reasoning.defaultEffort)
  return hasDefault
    ? efforts.map(effort => ({ effort: effort.id, label: effort.name }))
    : [{ effort: undefined, label: t('Default') }, ...efforts.map(effort => ({ effort: effort.id, label: effort.name }))]
}

const ResetIcon = () => h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M2.8 6.5A5.5 5.5 0 1 1 4 11.8' }),
  h('path', { d: 'M2.5 3.2v3.4h3.4' }))

export function EffortBar({ reasoning, current, onPick }) {
  const stops = effortStops(reasoning)
  const track = useRef(null)
  const drag = useRef(null)
  const [picked, setPicked] = useState(current)
  const [dragRatio, setDragRatio] = useState(null)
  useEffect(() => {
    if (!drag.current) setPicked(current)
  }, [current])
  if (stops.length === 0) return null
  const hasDefault = (reasoning?.efforts ?? []).some(effort => effort.id === reasoning?.defaultEffort)
  const activeEffort = picked ?? (hasDefault ? reasoning.defaultEffort : undefined)
  const activeIndex = Math.max(0, stops.findIndex(stop => (stop.effort ?? null) === (activeEffort ?? null)))
  const active = stops[activeIndex]
  const stopRatio = stops.length <= 1 ? 1 : activeIndex / (stops.length - 1)
  const ratio = dragRatio ?? stopRatio
  const commit = (effort) => {
    setPicked(effort)
    if ((effort ?? null) !== (current ?? null)) onPick(effort)
  }
  const ratioAt = (clientX) => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || stops.length <= 1) return 1
    const span = Math.max(1, rect.width - 22)
    return Math.max(0, Math.min(1, (clientX - rect.left - 11) / span))
  }
  const nearestStop = r => stops[Math.round(r * (stops.length - 1))] ?? stops[0]
  const onPointerDown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch {}
    const r = ratioAt(event.clientX)
    const next = nearestStop(r)
    drag.current = { id: event.pointerId, startX: event.clientX, moved: false, effort: next?.effort }
    if (next) setPicked(next.effort)
  }
  const onPointerMove = (event) => {
    const state = drag.current
    if (!state || state.id !== event.pointerId) return
    if (!state.moved && Math.abs(event.clientX - state.startX) > 2) state.moved = true
    const r = ratioAt(event.clientX)
    const next = nearestStop(r)
    if (state.moved) setDragRatio(r)
    if (next) {
      state.effort = next.effort
      setPicked(next.effort)
    }
  }
  const finishDrag = (event) => {
    const state = drag.current
    if (!state || (event && state.id !== event.pointerId)) return
    drag.current = null
    setDragRatio(null)
    commit(state.effort)
  }
  const onKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? stops.length - 1
        : (event.key === 'ArrowLeft' || event.key === 'ArrowDown') ? Math.max(0, activeIndex - 1)
          : Math.min(stops.length - 1, activeIndex + 1)
    const next = stops[nextIndex]
    if (next) commit(next.effort)
  }
  return h('div', { className: 'bt-effort-bar', role: 'group', 'aria-label': t('Thinking level') },
    h('div', { className: 'bt-effort-head' },
      h('span', { className: 'bt-effort-label' }, t('Thinking level')),
      h('span', { className: 'bt-effort-meta' },
        picked === undefined && hasDefault ? h('span', { className: 'bt-effort-tag' }, t('Default')) : null,
        h('span', { className: 'bt-effort-val' }, active.label),
        picked !== undefined || !hasDefault
          ? h('button', {
              type: 'button', className: 'bt-effort-reset', 'aria-label': t('Default'), title: t('Default'),
              disabled: picked === undefined, onClick: () => commit(undefined),
            }, h(ResetIcon))
          : null)),
    h('div', {
      ref: track, className: 'bt-effort-track', role: 'slider', tabIndex: 0,
      'aria-label': t('Thinking level'), 'aria-valuemin': 0, 'aria-valuemax': stops.length - 1,
      'aria-valuenow': activeIndex, 'aria-valuetext': active.label,
      'data-dragging': dragRatio !== null ? '' : undefined,
      style: { '--bt-effort-p': ratio },
      onPointerDown, onPointerMove,
      onPointerUp: finishDrag, onPointerCancel: finishDrag, onLostPointerCapture: finishDrag,
      onKeyDown,
    },
    h('span', { className: 'bt-effort-fill', 'aria-hidden': true }),
    stops.map((stop, index) => {
      const dotRatio = stops.length <= 1 ? 1 : index / (stops.length - 1)
      return h('span', {
        key: stop.effort ?? 'default',
        className: 'bt-effort-dot',
        'data-filled': dotRatio <= ratio + 0.001 || undefined,
        style: { '--bt-dot-p': dotRatio },
        title: stop.label,
        'aria-hidden': true,
      })
    }),
    h('span', { className: 'bt-effort-knob', 'aria-hidden': true })))
}

// The stable id of a provider group: the models' provider, never the display name,
// which repeats when two providers carry the same name.
const groupIdOf = list => list[0]?.provider ?? (typeof list[0]?.ref === 'string' ? list[0].ref.split('/')[0] : '')

// The group that holds the Bot's model, by that id; undefined when the model is no
// longer served, or the Bot has none.
function currentGroupId(groups, current) {
  if (current === undefined || current === null) return undefined
  const found = groups.find(([, list]) => list.some(model => model.ref === current))
  return found === undefined ? undefined : groupIdOf(found[1])
}

// A group is open when the user opened or closed it during this opening of the menu.
// Otherwise the current model's provider is open, or the first provider when the model
// is not in the catalog. A search opens every group it matched, so a result is never
// hidden behind a heading, and the manual state applies again once the search clears.
export function groupOpen({ id, index, currentId, filtering, manual }) {
  if (filtering) return true
  const chosen = manual[id]
  if (chosen !== undefined) return chosen
  return currentId === undefined ? index === 0 : id === currentId
}

// The manual state after a heading is clicked, `open` being what the heading showed.
export const toggledGroup = (manual, id, open) => ({ ...manual, [id]: !open })

// The provider headings and the models under the open ones. A search shows the plain
// headings of every matched group, with nothing to collapse: every result is visible.
// Kept apart from the state so a test can open and close a group the way its heading does.
export function ModelGroupList({ groups, current, currentId, defaultModel, onPick, manual, onToggle, filtering = false }) {
  return groups.map(([provider, list], index) => {
    const id = groupIdOf(list)
    const open = groupOpen({ id, index, currentId, filtering, manual })
    return h(Fragment, { key: `group:${id || provider}` },
      filtering
        ? h('div', { className: 'bt-model-group', role: 'presentation' }, provider)
        : h('button', {
            type: 'button', role: 'menuitem', className: 'bt-model-group bt-model-group-toggle',
            'aria-expanded': open, 'data-open': open ? '' : undefined,
            onClick: () => onToggle(id, open),
          },
          h(Caret), h('span', { className: 'bt-menu-label' }, provider)),
      open ? list.map(model => h('button', {
        key: model.ref, type: 'button', role: 'menuitemradio', 'aria-checked': model.ref === current, title: model.ref,
        onClick: () => onPick(model.ref),
      },
      h('span', { className: 'bt-menu-label' }, model.name),
      model.ref === defaultModel ? h('span', { className: 'bt-menu-hint' }, t('Default')) : null,
      h('span', { className: 'bt-model-tick', 'aria-hidden': true }, model.ref === current ? h(CheckIcon) : null))) : null)
  })
}

const NO_MANUAL = {}
// The manual state belongs to one opening of the menu. The leaving menu lives through
// its 120ms exit animation, so a reopen can land on the same mounted rows; asking with
// the new opening number then reads the default again instead of the old choices.
export const manualFor = (state, opening) => (state.opening === opening ? state.manual : NO_MANUAL)

export function ModelRows({ roster, current, onPick, filtering = false, opening = 0 }) {
  const groups = groupModels(roster.models)
  const [state, setState] = useState({ opening, manual: NO_MANUAL })
  const manual = manualFor(state, opening)
  return h(ModelGroupList, {
    groups, current, currentId: currentGroupId(groups, current), defaultModel: roster.defaultModel, onPick, filtering, manual,
    onToggle: (id, open) => setState(previous => ({ opening, manual: toggledGroup(manualFor(previous, opening), id, open) })),
  })
}

export const Caret = () => h('svg', { className: 'bt-model-caret', width: 12, height: 12, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M5.5 8l4.5 4.5L14.5 8' }))

// A menu that opens under its trigger, or above when the window has no room below. A
// click outside, Escape, or a scroll outside it closes it.
export function useAnchoredMenu() {
  const [anchor, setAnchor] = useState(null)
  const [place, setPlace] = useState(null)
  const [shownPlace, leaving] = useLinger(place, MENU_EXIT_MS)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  const close = () => { setAnchor(null); setPlace(null) }
  useEffect(() => {
    if (place === null) return undefined
    const onDown = (event) => {
      if (menu.current?.contains(event.target) || button.current?.contains(event.target)) return
      close()
    }
    const onKey = (event) => {
      if (stepMenuFocus(menu.current, event, button.current)) return
      if (event.key === 'Escape') { event.stopPropagation(); close(); button.current?.focus() }
    }
    const onScroll = (event) => { if (!menu.current?.contains(event.target)) close() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [place])
  const open = () => setAnchor({})
  // Re-reads the trigger's rect whenever the visible viewport moves: the menu
  // tracks its anchor through the on-screen keyboard, not past it.
  useLayoutEffect(() => {
    if (anchor === null || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const width = Math.max(240, rect.width)
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const below = viewBottom() - rect.bottom
    setPlace(below >= 260 || below >= rect.top
      ? { left, width, top: rect.bottom + 4, maxHeight: below - 16, '--bt-origin': 'top right' }
      : { left, width, bottom: viewBottom() - rect.top + 4, maxHeight: rect.top - 16, '--bt-origin': 'bottom right' })
  }, [anchor, tick])
  return { isOpen: place !== null, shownPlace, leaving, button, menu, open, close }
}

// The trigger shows the model name over its provider. A Thinking section lists the
// levels of the shown model when it has them.
// `onPick`/`onPickEffort` replace saving to the Bot, for a Bot that does not exist yet.
// `withEfforts: false` keeps the Thinking section out, for a pick that has no level of its own.
export function ModelMenu({ bot, roster, actions, run, wide = false, onPick, onPickEffort, withEfforts = true }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu()
  const shown = modelOf(bot, roster)
  const current = bot.model ?? bot.appliedModel
  const served = servedOf(roster, current)
  const reasoning = useEfforts(served, withEfforts ? current : undefined, actions)
  // The level the Bot runs on: its pick when the model serves it, else the model's own.
  const picked = reasoning?.efforts?.some(effort => effort.id === bot.effort) ? bot.effort : undefined
  const currentEffort = picked ?? reasoning?.defaultEffort
  const effortLabel = currentEffort === undefined
    ? (reasoning?.efforts?.length > 0 ? t('Default') : undefined)
    : reasoning.efforts.find(effort => effort.id === currentEffort)?.name ?? currentEffort
  // Each opening is a new number, so the rows start from the current model again even
  // when the previous menu is still playing its exit animation under a quick reopen.
  const [opening, setOpening] = useState(0)
  const toggle = () => {
    if (isOpen) { close(); return }
    // DSH settings can change the list at any time, so opening asks again.
    void actions?.refreshModels?.()
    setOpening(count => count + 1)
    open()
  }
  const pick = (ref) => {
    close()
    if (onPick) onPick(ref)
    else if (ref !== current || !bot.model) void run(actions.updateBot(bot.id, { model: ref }))
  }
  const pickEffort = (effort) => {
    if (onPickEffort) onPickEffort(effort)
    else if (effort !== bot.effort) void run(actions.updateBot(bot.id, { effort: effort ?? null }))
  }
  const models = roster.models ?? []
  const manage = manageModels(actions)
  const hasEfforts = withEfforts && effortStops(reasoning).length > 0
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-model-trigger', 'data-wide': wide || undefined,
      'aria-haspopup': 'menu', 'aria-expanded': isOpen, 'aria-label': t('Model: {model}', { model: shown?.name ?? t('none') }),
      'data-missing': shown !== undefined && !shown.served && models.length > 0 ? '' : undefined, onClick: toggle,
    },
    h('span', { className: 'bt-model-copy' },
      h('span', { className: 'bt-model-name' }, shown?.name ?? t('Choose a model')),
      shown ? h('span', { className: 'bt-model-provider' }, shown.served || models.length === 0
        ? (!withEfforts || effortLabel === undefined ? shown.provider : `${shown.provider} · ${effortLabel}`)
        : t('{provider} · not available', { provider: shown.provider })) : null),
    h(Caret)),
    shownPlace ? createPortal(h('div', { ref: menu, className: `bt-menu bt-model-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`, role: 'menu', 'aria-label': t('Model for {name}', { name: bot.name }), style: shownPlace, 'data-leaving': leaving || undefined },
      h('div', { className: 'bt-model-scroll' },
        models.length > 0 ? h(ModelRows, { roster, current, onPick: pick, opening })
          : h('div', { className: 'bt-model-none' }, t('No models are set up in DeepSeek Harness yet.'))),
      hasEfforts || manage ? h('div', { className: 'bt-model-foot' },
        hasEfforts ? h(EffortBar, { reasoning, current: picked, onPick: pickEffort }) : null,
        hasEfforts && manage ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
        manage ? h('button', { type: 'button', role: 'menuitem', onClick: () => { close(); manage() } }, h(SlidersIcon), h('span', { className: 'bt-menu-label' }, t('Models and providers…'))) : null) : null), document.body) : null)
}

// The card a Bot's chat opens on while the Bot has no model, or has one that is no
// longer served. The first Main Bot greets the user only after a pick.
export function ModelChoiceDock({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const bot = roster.byId[sessionId]
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const shown = Boolean(bot) && currentPart(bot) === sessionId && roster.ready
  useEffect(() => { if (shown) void actions.refreshModels?.() }, [shown, sessionId])
  if (!bot || currentPart(bot) !== sessionId || !roster.ready) return null
  const models = roster.models ?? []
  // A model whose provider has no API key fails every turn, so it is no choice.
  const usable = models.filter(model => !model.needsKey)
  const lost = bot.model ? !models.some(model => model.ref === bot.model) : false
  // An unknown catalog (none listed) cannot tell a lost model from a slow provider.
  if (bot.model && (!lost || models.length === 0)) return null
  // The missing key is taken here, through the host.
  const keyFor = usable.length === 0 && actions.setProviderKey ? models.find(model => model.needsKey) : undefined
  const manage = manageModels(actions)
  const pick = (ref) => {
    setBusy(ref)
    setError('')
    void Promise.resolve(actions.updateBot(bot.id, { model: ref }))
      .catch((failure) => { setError(failure?.message ?? String(failure)); void actions.refreshModels?.() })
      .finally(() => setBusy(''))
  }
  // The pick reads as the Bot's own first message, with the choices as replies under it.
  const text = lost
    ? t('{model} is not available anymore. Pick another model for me.', { model: bot.model.split('/').slice(1).join('/') })
    : keyFor
      ? t("Hi, I'm {name}. I need a {provider} API key before I can start.", { name: bot.name, provider: keyFor.providerName ?? keyFor.provider })
      : usable.length === 0
        ? t("Hi, I'm {name}. I don't have a model yet. How do you want to set one up?", { name: bot.name })
        : t("Hi, I'm {name}. Pick a model for me first. You can change it later in my details.", { name: bot.name })
  const choices = usable.length === 0
    ? setupChoices(actions).map(([label, run]) => h('button', { key: label, type: 'button', className: 'bt-model-chip', onClick: run }, label))
    : [
        ...groupModels(usable).map(([provider, list]) => h('div', { key: list[0].provider ?? provider, className: 'bt-model-choice-group', role: 'group', 'aria-label': provider },
          h('div', { className: 'bt-model-choice-provider', 'aria-hidden': true }, provider),
          h('div', { className: 'bt-model-choice-chips' }, list.map(model => h('button', {
            key: model.ref, type: 'button', className: 'bt-model-chip', disabled: busy !== '', 'aria-busy': busy === model.ref || undefined,
            'aria-label': `${model.name} · ${provider}`,
            title: model.ref === roster.defaultModel ? `${model.ref} · ${t('Harness default')}` : model.ref,
            onClick: () => pick(model.ref),
          }, model.name, busy === model.ref ? h('span', { className: 'bt-model-spin', 'aria-label': t('Saving…') }) : null))))),
        manage ? h('button', { key: 'manage', type: 'button', className: 'bt-model-chip bt-model-chip-quiet', onClick: manage }, h(SlidersIcon), t('Manage models')) : null,
      ]
  return h('div', { className: 'bt-model-dock' },
    h('div', { className: 'bt-astack', 'data-lead': '' },
      h('div', { className: 'bt-msg' },
        h('div', { className: 'bt-msg-line' },
          h(BotMark, { bot, size: 22 }),
          h('div', { className: 'bt-bubble' }, text)))),
    keyFor
      ? h(ModelKeyCard, { key: keyFor.provider, model: keyFor, actions })
      : h('div', { className: 'bt-model-chips', role: 'group', 'aria-label': t('Choose a model') }, choices),
    error ? h('div', { className: 'bt-secret-error bt-model-error', role: 'alert' }, error) : null)
}

const DEEPSEEK_KEYS_URL = 'https://platform.deepseek.com/api_keys'

// The provider's API key, saved through the host; once it is set, the provider's
// models become the choices. `onSaved` runs once the host took the key.
export function ModelKeyCard({ model, actions, onSaved }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const label = t('{provider} API key', { provider: model.providerName ?? model.provider })
  const ready = value.trim() !== '' && !busy
  const save = () => {
    if (!ready) return
    setBusy(true)
    setError('')
    void Promise.resolve(actions.setProviderKey(model.provider, value))
      .then(() => { setValue(''); onSaved?.() }, failure => setError(hostText(failure?.message ?? String(failure))))
      .finally(() => setBusy(false))
  }
  const official = model.provider === 'deepseek-official'
  return h('div', { className: 'bt-q bt-model-key', role: 'group', 'aria-label': label },
    h('div', { className: 'bt-model-key-title' }, h(KeyIcon), label),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange: setValue, onEnter: save, label, autoFocus: true })),
    official ? h('div', { className: 'bt-model-key-help' },
      h('a', { className: 'bt-model-key-link', href: DEEPSEEK_KEYS_URL, target: '_blank', rel: 'noopener noreferrer' }, t('Create a key on the DeepSeek platform ↗')),
      h('span', { className: 'bt-model-key-note' }, t('The API is billed by usage; the account needs a balance first.'))) : null,
    error ? h('div', { className: 'bt-secret-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-q-foot' },
      actions.openModels ? h('button', { type: 'button', className: 'bt-q-btn bt-model-key-other', onClick: actions.openModels }, t('Another provider')) : null,
      h('button', { type: 'button', className: 'bt-q-submit', disabled: !ready, onClick: save }, busy ? t('Saving…') : t('Save'))))
}

// Where the providers are set up: DS Bot's Models page, else DSH's own.
export const manageModels = actions => actions.openModels ?? actions.openHarnessModels ?? actions.openHarnessSettings

// Ways to get a first model. The DeepSeek sign-in exists only where the shell carries
// its account plugin; the API key uses the shell's own editor.
function setupChoices(actions) {
  const custom = manageModels(actions)
  return [
    actions.canSignIn?.() ? [t('Sign in to DeepSeek'), () => actions.signIn()] : null,
    actions.openHarnessOnboarding ? [t('Enter a DeepSeek API key'), () => actions.openHarnessOnboarding('deepseek-official')] : null,
    custom ? [t('Open settings to set up a custom model'), () => custom()] : null,
  ].filter(Boolean)
}

// The shell's own DeepSeek sign-in dialog, borrowed from its account plugin: the
// plugin's model sign-in entry renders here with the plugin's own operations.
export function DeepSeekSignIn({ useUi, actions }) {
  const open = useUi(state => state.signIn)
  const entry = open ? actions.signInEntry?.() : null
  if (!entry) return null
  return h(SignInHost, { key: open, entry, actions })
}

function SignInHost({ entry, actions }) {
  const [ops] = useState(() => entry.inject?.() ?? {})
  const close = () => actions.closeSignIn()
  const useHook = source => selector => useSyncExternalStore(source.subscribe, () => selector(source.getSnapshot()))
  const [hooks] = useState(() => ({ useAccount: useHook(ops.hooks.account), useTheme: useHook(ops.hooks.theme) }))
  return h(entry.component, {
    ...ops,
    ...hooks,
    t: actions.accountT(),
    complete: close,
    useApiKey: () => { close(); actions.openHarnessOnboarding('deepseek-official') },
  })
}

export const MODEL_CSS = `
.bt-model-trigger{display:inline-flex;align-items:center;gap:8px;max-width:100%;min-width:0;height:auto;min-height:32px;padding:4px 8px 4px 10px;border:0;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease}
.bt-model-trigger:hover,.bt-model-trigger[aria-expanded=true]{background:var(--bt-active)}
.bt-model-trigger:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-model-trigger[data-missing] .bt-model-provider{color:var(--bt-danger)}
.bt-model-trigger[data-wide]{display:flex;width:100%;min-height:48px;padding:7px 12px;justify-content:space-between;border-radius:12px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-model-trigger[data-wide]:hover,.bt-model-trigger[data-wide][aria-expanded=true]{background:var(--bt-hover)}
.bt-model-copy{display:flex;flex-direction:column;min-width:0}
.bt-model-name{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-model-provider{font-size:11px;line-height:14px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-model-caret{flex:none;color:var(--bt-ink-3);transition:${spring(SPRING_SHAPE, 'transform')}}
.bt-model-trigger[aria-expanded=true] .bt-model-caret{transform:rotate(180deg)}
.bt-model-menu{overflow-y:auto;scrollbar-width:thin}
.bt-model-menu:not(.bt-folder-menu){padding:0;overflow:hidden;display:flex;flex-direction:column;gap:0}
.bt-model-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;scrollbar-width:thin;overscroll-behavior:contain;padding:6px;display:flex;flex-direction:column;gap:2px}
.bt-model-foot{flex:none;display:flex;flex-direction:column;gap:2px;padding:4px 6px 6px;border-top:.5px solid var(--bt-line-2)}
.bt-effort-bar{display:flex;flex-direction:column;gap:6px;padding:4px 6px 5px}
.bt-effort-head{display:flex;align-items:center;justify-content:space-between;gap:8px;height:18px;padding:0 2px}
.bt-effort-label{font-size:11px;line-height:14px;font-weight:500;color:var(--bt-ink-3)}
.bt-effort-meta{display:inline-flex;align-items:center;gap:5px;min-width:0}
.bt-effort-tag{font-size:11px;line-height:14px;color:var(--bt-ink-3)}
.bt-effort-val{font-size:12px;line-height:16px;font-weight:600;color:var(--bt-accent);white-space:nowrap}
.bt-menu button.bt-effort-reset{flex:none;position:relative;width:28px;height:28px;min-height:0;margin:-5px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing};transition:color .12s ease}
.bt-menu button.bt-effort-reset::before{content:"";position:absolute;inset:5px;border-radius:50%;background:var(--bt-hover);transition:background-color .12s ease}
.bt-menu button.bt-effort-reset svg{position:relative;width:11px;height:11px;margin:0}
.bt-menu button.bt-effort-reset:hover:not(:disabled){color:var(--bt-ink)}
.bt-menu button.bt-effort-reset:hover:not(:disabled)::before{background:var(--bt-active)}
.bt-menu button.bt-effort-reset:disabled{opacity:.35;cursor:default}
.bt-menu button.bt-effort-reset:disabled::before{background:none}
.bt-menu button.bt-effort-reset:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-effort-track{position:relative;height:28px;margin:-3px 0;border-radius:999px;cursor:pointer;user-select:none;touch-action:none}
.bt-effort-track::before{content:"";position:absolute;left:0;right:0;top:3px;bottom:3px;border-radius:999px;background:var(--bt-hover);box-shadow:inset 0 0 0 .5px var(--bt-line)}
.bt-effort-track:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-effort-fill{position:absolute;left:0;top:3px;bottom:3px;width:calc(22px + (100% - 22px) * var(--bt-effort-p,0));border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--bt-accent) 76%,var(--bt-main)),var(--bt-accent));transition:${spring(SPRING_TAP, 'width')}}
.bt-effort-dot{position:absolute;top:50%;left:calc(11px + (100% - 22px) * var(--bt-dot-p,0));width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%;background:color-mix(in srgb,var(--bt-ink-3) 45%,transparent);pointer-events:none;transition:background-color .12s ease}
.bt-effort-dot[data-filled]{background:color-mix(in srgb,var(--bt-accent-ink) 65%,transparent)}
.bt-effort-knob{position:absolute;top:5px;left:calc(11px + (100% - 22px) * var(--bt-effort-p,0) - 9px);width:18px;height:18px;border-radius:50%;background:var(--bt-accent-ink);box-shadow:0 1px 3px rgba(0,0,0,.2),0 0 0 .5px rgba(0,0,0,.06);pointer-events:none;transition:${spring(SPRING_TAP, 'left')},${spring(SPRING_TAP, 'scale')}}
.bt-effort-track[data-dragging] .bt-effort-fill,.bt-effort-track[data-dragging] .bt-effort-knob{transition:none}
.bt-effort-track:hover .bt-effort-knob,.bt-effort-track[data-dragging] .bt-effort-knob{scale:1.08}
.bt-model-group{flex:none;padding:8px 8px 2px;font-size:11px;line-height:14px;font-weight:500;color:var(--bt-ink-3);text-transform:none}
.bt-model-group:first-child{padding-top:2px}
/* A heading that opens and closes its group: the same type as the plain headings other
menus use, with the menu item's hover, focus ring and a caret that points at the state. */
.bt-model-group-toggle{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;margin:0;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-3);font:inherit;font-size:11px;line-height:14px;font-weight:500;text-align:left;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-model-group-toggle:hover{background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-model-group-toggle:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-model-group-toggle .bt-model-caret{color:inherit}
.bt-model-group-toggle[aria-expanded=false] .bt-model-caret{transform:rotate(-90deg)}
.bt-model-tick{flex:none;width:16px;height:16px;display:inline-flex;color:var(--bt-ink-2)}
.bt-model-tick svg{animation:bt-check-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing} 60ms backwards}
.bt-model-none{padding:8px;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
/* DSH centers the message column inside its scroll padding, which can sit a few px off this dock's center; the side shadows keep the band over the column's edges. */
.bt-model-dock{width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:0 0 10px;box-sizing:border-box;background:var(--bt-main);box-shadow:-12px 0 0 var(--bt-main),12px 0 0 var(--bt-main);animation:bt-model-in ${SPRING_POP.duration}ms ${SPRING_POP.easing} backwards}
/* The scroll box clips at its padding edge, so 3px of padding keeps the chips' focus rings visible; the negative margins cancel it so the chips stay in place. */
.bt-model-chips{display:flex;flex-wrap:wrap;gap:6px;box-sizing:border-box;padding:3px;margin:-3px 0 -3px 27px;max-width:min(566px,calc(100% - 27px));max-height:min(246px,calc(36vh + 6px));max-height:min(246px,calc(36dvh + 6px));overflow-y:auto;scrollbar-width:thin}
.bt-model-choice-group{display:flex;flex-direction:column;gap:6px;width:100%;min-width:0}
.bt-model-choice-provider{padding-top:4px;font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-model-choice-chips{display:flex;flex-wrap:wrap;gap:6px}
.bt-model-chip{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:5px 12px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-surface,transparent);color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.bt-model-chip:hover:not(:disabled){background:var(--bt-hover)}
.bt-model-chip:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-model-chip-quiet{color:var(--bt-ink-2)}
.bt-model-chip svg{width:14px;height:14px}
.bt-model-chip:disabled{cursor:default}
.bt-model-chip:disabled:not([aria-busy]){opacity:.5}
.bt-model-error{margin-left:30px}
.bt-q.bt-model-key{margin:0 0 0 30px;width:min(480px,calc(100% - 30px));gap:10px}
.bt-model-key-title{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink-2)}
.bt-model-key-title svg{flex:none;width:16px;height:16px}
.bt-model-key .bt-q-foot{margin-top:2px}
.bt-model-key-help{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-model-key-link{align-self:flex-start;color:var(--bt-ink);text-decoration:underline;text-decoration-color:var(--bt-line-2);text-underline-offset:2px}
.bt-model-key-link:hover{text-decoration-color:currentColor}
.bt-model-key-link:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px;border-radius:4px}
.bt-model-key-other{margin-right:auto}
@keyframes bt-model-in{from{opacity:0;transform:translateY(6px)}}
.bt-model-spin{flex:none;width:14px;height:14px;border-radius:50%;border:1.5px solid var(--bt-line-2);border-top-color:var(--bt-ink-2);animation:bt-model-spin .7s linear infinite}
@keyframes bt-model-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.bt-model-dock{animation:none}.bt-model-spin{animation-duration:2s}.bt-model-caret,.bt-effort-fill,.bt-effort-knob{transition:none}.bt-model-tick svg{animation:none}}
`
