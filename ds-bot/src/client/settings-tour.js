// Interactive step-by-step spotlight walkthrough for Settings.
// Highlights actual controls inside `.bt-settings` (`[data-tour="..."]`) and gives one
// concise action cue telling the user where to click. Runs once automatically on first
// open, can be replayed from About DS Bot, and every section has its own focused guide.
import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useEscape } from './overlay-hooks.js'
import { isImeComposing } from './enter-key.js'
import { t } from './i18n.js'
import { ownedPopups } from './popup-ownership.js'

export const TOUR_SEEN_KEY = 'ds-bot:settings-tour-v1'

export function canAutoStartTour() {
  if (typeof window === 'undefined') return false
  try {
    if (typeof window.localStorage?.getItem !== 'function') return false
    return window.localStorage.getItem(TOUR_SEEN_KEY) !== '1'
  } catch {
    return false
  }
}

export function markTourSeen() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage?.setItem?.(TOUR_SEEN_KEY, '1')
  } catch {
    // Storage unavailable in restricted browser contexts.
  }
}

const SECTION_TOURS = {
  general: [
    { target: 'default-model', title: 'Default model', cue: 'Pick the default model new Bots start with.' },
    { target: 'locations', title: 'Locations', cue: 'Click the folder menu to change the default team workspace.' },
    { target: 'advanced', title: 'Advanced', cue: 'Click here to expand memory limits and background timeouts.' },
  ],
  appearance: [
    { target: 'theme-grid', title: 'Theme', cue: 'Click a preview card to switch the visual theme.' },
    { target: 'accent', title: 'Accent', cue: 'Pick a preset color or click the last swatch for a custom color.' },
    { target: 'layout', title: 'Messages', cue: 'Switch between Bubble and Flat layout, or adjust width below.' },
    { target: 'motion', title: 'Motion', cue: 'Tune interface motion and Bot animation intensity here.' },
  ],
  models: [
    { target: 'provider-list', title: 'Providers', cue: 'Click any provider row to expand it and enter your API key.' },
    { target: 'provider-add', title: 'Add a provider', cue: 'Click here to add a custom OpenAI, Anthropic, or Gemini endpoint.' },
    { target: 'provider-advanced', title: 'Advanced settings', cue: 'Click here to tune context windows, thinking levels, and model order.', optional: true },
  ],
  'bot-models': [
    { target: 'bm-list', title: 'Select Bots', cue: 'Check the Bots whose model you want to switch together.' },
    { target: 'bm-bar', title: 'Choose a model', cue: 'Click "Select all" or pick a model here to apply it in one click.' },
  ],
  'local-agents': [
    { target: 'la-detected', title: 'Detected agents', cue: 'Click "Refresh" to scan local CLIs, or "Sign in" to copy the login command.' },
    { target: 'la-add', title: 'Custom agents', cue: 'Click "+ Add agent" to register an ACP-compatible command.' },
  ],
  'deepseek-services': [
    { target: 'svc-key', title: 'DeepSeek API', cue: 'Confirm the API key is ready, or click "Manage models" to set it up.' },
    { target: 'svc-ocr', title: 'Image and document reading', cue: 'Turn on this switch to read images and documents with DeepSeek.' },
    { target: 'svc-tts', title: 'Text to speech', cue: 'Switch to DeepSeek here for voice replies, or enable dictation below.' },
  ],
  bots: [
    { target: 'main-bot', title: 'Main Bot', cue: 'Pick your primary Main Bot from this dropdown.' },
    { target: 'new-bot', title: 'New Bot', cue: 'Click "+ New Bot" to create a new team member.' },
    { target: 'bot-list', title: 'Bots', cue: 'Click any Bot row to edit its role, model, folder, and permissions.' },
  ],
  groups: [
    { target: 'new-group', title: 'Create group chat', cue: 'Click "+ Create group chat" to put multiple Bots in one room.' },
    { target: 'group-list', title: 'Group chats', cue: 'Click a group row to change its members, admin, or shared folder.' },
  ],
  schedules: [
    {
      target: 'new-task',
      title: 'New task',
      cue: 'Click "+ New task" to pick a Bot, schedule, and prompt.',
      fallback: {
        target: 'open-plugins',
        title: 'Turn on Automation tasks in DSH',
        cue: 'Switch on Automation tasks on the Plugins page in Settings.',
      },
    },
  ],
  connectors: [
    { target: 'conn-search', title: 'Search connectors', cue: 'Search an app here, or click "+ Custom" to add your own MCP server.' },
    { target: 'conn-grid', title: 'Connectors', cue: 'Click "Connect" on any card to sign in or paste credentials.' },
  ],
  im: [
    { target: 'im-platforms', title: 'Add an IM bot', cue: 'Click a platform below and follow its steps to bind a Bot.' },
  ],
  phone: [
    { target: 'phone-pair', title: 'Pair a phone', cue: 'Click "Turn on & pair" to show a one-time QR code, then scan it on your phone.' },
    { target: 'phone-server', title: 'Server', cue: 'Click "Edit" here only if you host your own relay server.' },
  ],
  mcp: [
    { target: 'mcp-switch', title: 'MCP access', cue: 'Turn on this switch so other local agents can reach your Bots.' },
    { target: 'mcp-add', title: 'Add a client', cue: 'Enter a client name, click "Create token", then pick allowed Bots below.' },
  ],
  computer: [
    { target: 'comp-switch', title: 'Computer use', cue: 'Turn on this switch and grant system permissions when prompted.' },
    { target: 'comp-bots', title: 'Bots', cue: 'Pick how each Bot may control the computer from its dropdown.' },
  ],
  browser: [
    { target: 'browser-allow', title: 'Allowed actions', cue: 'Click "+ Allow action" to pre-approve posting, uploads, downloads, or deletes.' },
  ],
  capabilities: [
    { target: 'cap-add', title: 'Shared capabilities', cue: 'Click "+ Add capability" to add a shared MCP server, skill, or pack.' },
  ],
  secrets: [
    { target: 'secret-encrypt', title: 'Encryption at rest', cue: 'Click here to protect saved keys on disk with a passphrase.' },
    { target: 'secret-add', title: 'Secrets', cue: 'Click "+ Add a key" to save a key and choose which Bots can use it.' },
  ],
  usage: [
    { target: 'usage-tabs', title: 'Time range', cue: 'Switch time ranges here or pick custom dates from the calendar.' },
  ],
}

export const hasSectionTour = page => Object.hasOwn(SECTION_TOURS, page)

export function stepsForTour(mode, { hasProviders = true, hasAdvancedModels = false } = {}) {
  if (mode === 'full') {
    return [
      { page: 'overview', target: 'search', title: 'Search settings', cue: 'Click here to search any setting, Bot, or model.' },
      hasProviders
        ? { page: 'models', target: 'provider-list', title: 'Models', cue: 'Click a provider to enter your API key, or click "+ Add a provider".' }
        : { page: 'bot-models', target: 'bm-bar', title: 'Bot models', cue: 'Select Bots below and pick a model here to switch them together.' },
      { page: 'bots', target: 'new-bot', title: 'Team', cue: 'Click "+ New Bot" to add a member, or click any Bot row to edit it.' },
      { page: 'phone', target: 'phone-pair', title: 'Connect', cue: 'Click "Turn on & pair" to show a one-time QR code, then scan it on your phone.' },
      { page: 'appearance', target: 'theme-grid', title: 'Appearance', cue: 'Pick a theme, accent color, and layout here. Replay this guide anytime in About DS Bot.' },
    ]
  }
  const steps = SECTION_TOURS[mode] ?? []
  return steps.filter(step => !(step.optional && step.target === 'provider-advanced' && !hasAdvancedModels))
}

const PAD = 6
const EDGE = 16
const GAP = 14

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function sameSpot(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height && a.dialogW === b.dialogW && a.dialogH === b.dialogH
}

function findTourTarget(dialogEl, targetKey) {
  if (!dialogEl || !targetKey || typeof dialogEl.querySelector !== 'function') return null
  // The same target can sit in two places (the rail and, at phone width, Overview);
  // the one on screen wins.
  const all = typeof dialogEl.querySelectorAll === 'function' ? [...dialogEl.querySelectorAll(`[data-tour="${targetKey}"]`)] : [dialogEl.querySelector(`[data-tour="${targetKey}"]`)].filter(Boolean)
  return all.find((el) => {
    if (typeof el.getBoundingClientRect !== 'function') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }) ?? null
}

function resolveStep(dialogEl, step) {
  if (!step) return { step: null, targetEl: null }
  const primary = findTourTarget(dialogEl, step.target)
  if (primary || !step.fallback) return { step, targetEl: primary }
  const fallback = findTourTarget(dialogEl, step.fallback.target)
  return fallback ? { step: step.fallback, targetEl: fallback } : { step, targetEl: null }
}

export function measureSpotlight(dialogEl, targetKey) {
  const el = findTourTarget(dialogEl, targetKey)
  if (!el || typeof dialogEl.getBoundingClientRect !== 'function') return null
  const dialogRect = dialogEl.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  if (dialogRect.width <= 0 || dialogRect.height <= 0) return null

  let left = rect.left - dialogRect.left - PAD
  let top = rect.top - dialogRect.top - PAD
  let right = rect.right - dialogRect.left + PAD
  let bottom = rect.bottom - dialogRect.top + PAD

  // Clip against the scroll viewport when the target lives inside `.bt-settings-scroll`
  // so a tall section never highlights over the header or sub-tabs.
  const scrollBox = typeof el.closest === 'function' ? el.closest('.bt-settings-scroll') : null
  if (scrollBox && typeof scrollBox.getBoundingClientRect === 'function') {
    const clip = scrollBox.getBoundingClientRect()
    const clipTop = clip.top - dialogRect.top
    const clipBottom = clip.bottom - dialogRect.top
    const clipLeft = clip.left - dialogRect.left
    const clipRight = clip.right - dialogRect.left
    top = Math.max(top, clipTop + 2)
    bottom = Math.min(bottom, clipBottom - 2)
    left = Math.max(left, clipLeft + 2)
    right = Math.min(right, clipRight - 2)
  } else {
    left = Math.max(left, 4)
    top = Math.max(top, 4)
    right = Math.min(right, dialogRect.width - 4)
    bottom = Math.min(bottom, dialogRect.height - 4)
  }

  const width = right - left
  const height = bottom - top
  if (width <= 8 || height <= 8) return null
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
    dialogW: Math.round(dialogRect.width),
    dialogH: Math.round(dialogRect.height),
  }
}

export function placeCard(spot, cardW, cardH) {
  if (!spot) return null
  const { left, top, width, height, dialogW, dialogH } = spot
  const right = left + width
  const bottom = top + height

  // Narrow / mobile viewport: dock cleanly at bottom (or top if spotlight covers bottom).
  if (dialogW <= 640) {
    const fitsBottom = bottom + GAP + cardH <= dialogH - EDGE
    return fitsBottom
      ? { left: 12, right: 12, bottom: 12 }
      : { left: 12, right: 12, top: 12 }
  }

  const maxLeft = Math.max(EDGE, dialogW - cardW - EDGE)
  const maxTop = Math.max(EDGE, dialogH - cardH - EDGE)

  // Left rail target: place to the right of the spotlight.
  if (left < 220 && right + GAP + cardW <= dialogW - EDGE) {
    return { left: Math.round(right + GAP), top: Math.round(clamp(top, EDGE, maxTop)) }
  }
  // Below spotlight.
  if (bottom + GAP + cardH <= dialogH - EDGE) {
    return { left: Math.round(clamp(left, EDGE, maxLeft)), top: Math.round(bottom + GAP) }
  }
  // Above spotlight.
  if (top - GAP - cardH >= EDGE) {
    return { left: Math.round(clamp(left, EDGE, maxLeft)), top: Math.round(top - GAP - cardH) }
  }
  // Left of spotlight.
  if (left - GAP - cardW >= EDGE) {
    return { left: Math.round(left - GAP - cardW), top: Math.round(clamp(top, EDGE, maxTop)) }
  }
  // Fallback inside dialog bottom-right.
  return { left: Math.round(maxLeft), top: Math.round(maxTop) }
}

export function SettingsTour({ tour, currentPage, dialogRef, hasProviders, hasAdvancedModels, onNavigate, onDismiss }) {
  const steps = useMemo(
    () => (tour ? stepsForTour(tour.mode, { hasProviders, hasAdvancedModels }) : []),
    [tour?.mode, hasProviders, hasAdvancedModels],
  )
  const tourKey = tour ? `${tour.mode}:${tour.nonce}` : ''
  const [stepState, setStepState] = useState({ key: tourKey, index: 0 })
  if (tourKey === '' && stepState.key !== '') setStepState({ key: '', index: 0 })
  const index = stepState.key === tourKey ? stepState.index : 0
  const [spot, setSpot] = useState(null)
  const [resolvedStep, setResolvedStep] = useState(null)
  const [cardSize, setCardSize] = useState({ width: 304, height: 140 })
  const layerRef = useRef(null)
  const cardRef = useRef(null)
  const scrolledRef = useRef('')
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate

  const active = Boolean(tour && steps.length > 0)
  const step = active ? steps[Math.min(index, steps.length - 1)] : null
  const isLast = active && index >= steps.length - 1

  const dismiss = useCallback(() => {
    if (tour?.mode === 'full') markTourSeen()
    onDismiss()
  }, [tour?.mode, onDismiss])

  const next = useCallback(() => {
    if (!active) return
    if (isLast) dismiss()
    else setStepState(prev => ({ key: tourKey, index: Math.min((prev.key === tourKey ? prev.index : 0) + 1, steps.length - 1) }))
  }, [active, isLast, dismiss, tourKey, steps.length])

  const prev = useCallback(() => {
    if (!active) return
    setStepState(prev => ({ key: tourKey, index: Math.max(0, (prev.key === tourKey ? prev.index : 0) - 1) }))
  }, [active, tourKey])

  // Priority 1 catches Escape before SettingsDialog closes.
  useEscape(dismiss, active, { priority: 1 })

  useLayoutEffect(() => {
    if (!active) return undefined
    const dialog = dialogRef?.current ?? layerRef.current?.closest?.('.bt-settings')
    const doc = dialog?.ownerDocument
    const card = cardRef.current
    const layer = layerRef.current
    if (!doc?.body || !card || !layer) return undefined
    const inert = new Map()
    let interactive = [card]
    let disposed = false
    const restore = () => {
      for (const [element, previous] of inert) element.inert = previous
      inert.clear()
    }
    const allowed = element => interactive.some(root => root.contains(element))
    const sync = () => {
      restore()
      const target = !step.page || step.page === currentPage ? resolveStep(dialog, step).targetEl : null
      interactive = [target, card].filter(Boolean)
      interactive.push(...ownedPopups(interactive))
      const roots = [layer, ...interactive]
      const isolate = element => {
        if (roots.includes(element)) return
        if (roots.some(root => element.contains(root))) {
          for (const child of element.children) isolate(child)
        } else {
          inert.set(element, element.inert)
          element.inert = true
        }
      }
      isolate(doc.body)
      if (!allowed(doc.activeElement)) card.focus({ preventScroll: true })
    }
    const onFocus = () => {
      // React autofocus runs before the enclosing portal's ref has been attached.
      queueMicrotask(() => { if (!disposed) sync() })
    }
    const onTab = event => {
      if (event.key !== 'Tab') return
      sync()
      const selector = 'button,input,select,textarea,a[href],[tabindex],[contenteditable],summary,audio[controls],video[controls]'
      const controls = interactive.flatMap(root => [root, ...root.querySelectorAll(selector)])
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && element.getClientRects().length > 0 && doc.defaultView.getComputedStyle(element).visibility === 'visible')
      event.preventDefault()
      event.stopPropagation()
      const current = controls.indexOf(doc.activeElement)
      const nextIndex = current < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
      ;(controls[nextIndex] ?? card).focus({ preventScroll: true })
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-leaving'] })
    doc.addEventListener('focusin', onFocus, true)
    doc.addEventListener('keydown', onTab, true)
    return () => {
      disposed = true
      observer.disconnect()
      doc.removeEventListener('focusin', onFocus, true)
      doc.removeEventListener('keydown', onTab, true)
      restore()
    }
  }, [active, tourKey, step, currentPage, dialogRef])

  useEffect(() => {
    if (!active || typeof window === 'undefined') return undefined
    const onKeyDown = (event) => {
      if (event.defaultPrevented || isImeComposing(event) || event.metaKey || event.ctrlKey || event.altKey) return
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return
      if (event.key === 'ArrowRight') { event.preventDefault(); next() }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); prev() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, next, prev])

  // Cross-page tour steps switch pages only when entering a step.
  useEffect(() => {
    if (!active || !step?.page || step.page === currentPageRef.current) return
    onNavigateRef.current(step.page)
  }, [active, tourKey, index, step?.page])

  // Measure target element & keep spotlight glued on scroll, resize, animations, and async page mounts.
  useEffect(() => {
    if (!active || !step) { scrolledRef.current = ''; setSpot(null); setResolvedStep(null); return undefined }
    if (step.page && step.page !== currentPage) { setSpot(null); setResolvedStep(null); return undefined }
    const dialogEl = dialogRef?.current ?? layerRef.current?.closest?.('.bt-settings')
    if (!dialogEl) { setSpot(null); return undefined }

    let raf = 0
    const stepKey = `${tourKey}:${index}`
    const sync = () => {
      const box = cardRef.current
      if (box && box.offsetWidth > 0 && box.offsetHeight > 0) {
        setCardSize(prev => (prev.width === box.offsetWidth && prev.height === box.offsetHeight ? prev : { width: box.offsetWidth, height: box.offsetHeight }))
      }
      // Scroll off-screen targets into view BEFORE clipping against `.bt-settings-scroll`.
      const resolved = resolveStep(dialogEl, step)
      const shown = resolved.step ?? step
      setResolvedStep(prev => (prev?.key === stepKey && prev.step === shown ? prev : { key: stepKey, step: shown }))
      const targetKey = `${stepKey}:${shown.target}`
      if (resolved.targetEl && scrolledRef.current !== targetKey) {
        scrolledRef.current = targetKey
        resolved.targetEl.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      }
      const measured = measureSpotlight(dialogEl, shown.target)
      setSpot(prev => (sameSpot(prev, measured) ? prev : measured))
    }
    const schedule = () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(sync)
      else sync()
    }
    const onMutate = (records) => {
      const layer = layerRef.current
      if (layer && Array.isArray(records) && records.every(record => layer.contains?.(record.target))) return
      schedule()
    }

    sync()
    // Re-measure after dialog/page entrance transforms finish (SPRING_SHAPE + stagger).
    const settleTimer = setTimeout(sync, 580)
    window.addEventListener?.('resize', schedule)
    dialogEl.addEventListener?.('scroll', schedule, true)
    dialogEl.addEventListener?.('animationend', schedule, true)
    let observer = null
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(onMutate)
      observer.observe(dialogEl, { childList: true, subtree: true, attributes: false })
    }
    return () => {
      clearTimeout(settleTimer)
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      window.removeEventListener?.('resize', schedule)
      dialogEl.removeEventListener?.('scroll', schedule, true)
      dialogEl.removeEventListener?.('animationend', schedule, true)
      observer?.disconnect()
    }
  }, [active, step, currentPage, dialogRef, tourKey, index])

  if (!active || !step) return null

  const stepKey = `${tourKey}:${index}`
  const shownStep = resolvedStep?.key === stepKey ? resolvedStep.step : step
  const activeSpot = step.page && step.page !== currentPage ? null : spot
  const narrowViewport = typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth <= 640
  const fallbackStyle = narrowViewport ? { left: 12, right: 12, bottom: 12 } : { right: 20, bottom: 20 }
  const cardStyle = placeCard(activeSpot, cardSize.width, cardSize.height) ?? fallbackStyle
  const backdropStyle = activeSpot ? {
    clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${activeSpot.left}px ${activeSpot.top}px, ${activeSpot.left}px ${activeSpot.top + activeSpot.height}px, ${activeSpot.left + activeSpot.width}px ${activeSpot.top + activeSpot.height}px, ${activeSpot.left + activeSpot.width}px ${activeSpot.top}px, ${activeSpot.left}px ${activeSpot.top}px, 0 0)`,
  } : undefined

  return h('div', {
    ref: layerRef,
    className: 'bt-tour-layer',
    role: 'dialog',
    'aria-modal': false,
    'aria-label': t(shownStep.title),
    'data-tour-mode': tour.mode,
    'data-tour-step': shownStep.target,
  },
  h('div', {
    className: activeSpot ? 'bt-tour-backdrop' : 'bt-tour-backdrop bt-tour-backdrop-dim',
    style: backdropStyle,
    onMouseDown: event => event.stopPropagation(),
  }),
  activeSpot ? h('div', {
    className: 'bt-tour-spot',
    'aria-hidden': true,
    style: { left: activeSpot.left, top: activeSpot.top, width: activeSpot.width, height: activeSpot.height },
  }) : null,
  h('div', {
    ref: cardRef,
    tabIndex: -1,
    className: 'bt-tour-card',
    style: cardStyle,
    onMouseDown: event => event.stopPropagation(),
  },
  h('div', { className: 'bt-tour-head' },
    h('span', { className: 'bt-tour-title' }, t(shownStep.title)),
    steps.length > 1 ? h('span', { className: 'bt-tour-count' }, `${index + 1} / ${steps.length}`) : null),
  h('p', { className: 'bt-tour-cue' }, t(shownStep.cue)),
  h('div', { className: 'bt-tour-foot' },
    h('button', { type: 'button', className: 'bt-tour-skip', onClick: dismiss }, t('Skip')),
    h('div', { className: 'bt-tour-nav' },
      index > 0 ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: prev }, t('Back')) : null,
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', onClick: next }, isLast ? t('Done') : t('Next'))))))
}
