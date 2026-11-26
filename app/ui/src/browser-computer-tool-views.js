// Dedicated tool cards for every Browser and Computer Use tool call.
// Preserves live interactive handoff (`HandoffCall`, `ComputerHandoffCall`) and
// per-app consent (`AppAccessCall`) cards while giving every action a clear card
// with action, target, screenshot thumbnail (click to enlarge), status, and panel link.
import { createElement as h, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { classify } from '../../../ds-bot/src/host/computer/catalog.js'
import { AppAccessCall, ComputerHandoffCall } from '../../../ds-bot/src/client/computer.js'
import { HandoffCall } from '../../../ds-bot/src/client/handoff-card.js'
import { GlobeIcon, MonitorIcon } from '../../../ds-bot/src/client/icons.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { heldCardKey } from '../../../ds-bot/src/client/sources.js'
import { ToolImageThumb } from './image-lightbox.js'
import { CodeSection, formatArgs, formatResult, formatToolDuration } from './tool-card.js'
import { ToolCardShell, compact, errorLineOf, readArgText, readArgValue, safeWebHref, shortPath } from './tool-view-shared.js'

export const BROWSER_TOOL_NAMES = [
  'read_browser',
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_upload',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_tabs',
  'browser_back',
  'browser_screenshot',
  'browser_exec',
  'browser_task',
  'browser_handoff',
  'browser_resume',
]

const BROWSER_LABELS = {
  read_browser: 'Read page',
  browser_open: 'Open page',
  browser_snapshot: 'Page snapshot',
  browser_click: 'Click',
  browser_upload: 'Upload files',
  browser_type: 'Type text',
  browser_select: 'Select option',
  browser_press: 'Press key',
  browser_tabs: 'Browser tabs',
  browser_back: 'Go back',
  browser_screenshot: 'Screenshot',
  browser_exec: 'Browser script',
  browser_task: 'Browser task',
  browser_handoff: 'Browser handoff',
  browser_resume: 'Resume browser',
}

const HANDOFF_REASONS = {
  login: 'Sign-in',
  payment: 'Payment',
  captcha: 'Verification',
  confirm: 'Confirmation',
  other: 'Help needed',
}

const COMPUTER_ACTIONS = {
  click: 'Click',
  doubleClick: 'Double click',
  double_click: 'Double click',
  rightClick: 'Right click',
  right_click: 'Right click',
  drag: 'Drag',
  typeText: 'Type text',
  type_text: 'Type text',
  paste: 'Paste',
  pressKey: 'Press key',
  press_key: 'Press key',
  sendKeyEvent: 'Press key',
  hotkey: 'Hotkey',
  scroll: 'Scroll',
  screenshot: 'Screenshot',
  getScreenSize: 'Screen size',
  get_screen_size: 'Screen size',
  getCapabilities: 'Capabilities',
  listApps: 'List apps',
  list_apps: 'List apps',
  findApps: 'Find apps',
  getApp: 'Select app',
  listWindows: 'List windows',
  list_windows: 'List windows',
  getState: 'Read state',
  getWindowState: 'Window state',
  get_window_state: 'Window state',
  getAccessibilityTree: 'Accessibility tree',
  get_accessibility_tree: 'Accessibility tree',
  verifyState: 'Verify state',
  verify_state: 'Verify state',
  launchApp: 'Launch app',
  launch_app: 'Launch app',
  killApp: 'Close app',
  kill_app: 'Close app',
  bringToFront: 'Focus app',
  activate: 'Focus app',
  hover: 'Hover',
  mouseMove: 'Move pointer',
  invokeMenu: 'Invoke menu',
  invoke_menu: 'Invoke menu',
  invoke: 'Invoke',
  performAction: 'Action',
  performSecondaryAction: 'Secondary action',
  setValue: 'Set value',
  set_value: 'Set value',
  selectText: 'Select text',
  show: 'Show window',
  clipboard_read: 'Read clipboard',
  clipboard_write: 'Write clipboard',
  get_desktop_state: 'Desktop state',
  get_cursor_position: 'Cursor position',
}

const ACCESS_LABELS = {
  observe: 'View',
  background: 'Background',
  foreground: 'Foreground',
}

function parseRawArgsObject(block) {
  const raw = block?.call?.argsRaw ?? block?.argsRaw
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function extractUrlFromText(text) {
  if (typeof text !== 'string' || text === '') return ''
  const match = /(?:^|\n)\s*url:\s*(https?:\/\/\S+)/i.exec(text) ?? /\b(https?:\/\/[^\s"'<>)]+)/.exec(text)
  return match?.[1] ?? ''
}

function extractTitleFromText(text) {
  if (typeof text !== 'string' || text === '') return ''
  const match = /(?:^|\n)\s*title:\s*(.+)$/im.exec(text)
  return match?.[1]?.trim() ?? ''
}

function parseTaskSteps(text) {
  if (typeof text !== 'string' || text === '') return { answer: '', statusLine: '', steps: [] }
  const idx = text.search(/\n(?:Finished in \d+ steps\.|Stopped after \d+ steps\.)/)
  const answer = idx >= 0 ? text.slice(0, idx).trim() : text.trim()
  const tail = idx >= 0 ? text.slice(idx).trim() : ''
  const lines = tail.split('\n')
  const statusLine = lines[0] ?? ''
  const stepsIdx = lines.findIndex(line => line.trim() === 'Steps:')
  const steps = stepsIdx >= 0
    ? lines.slice(stepsIdx + 1).map(line => line.trim()).filter(line => line !== '' && line !== '(none)')
    : []
  return { answer, statusLine, steps }
}

function browserTargetOf(toolName, block, rawResult, cwd) {
  const urlArg = readArgText(block, 'url')
  const ref = readArgText(block, 'ref')
  const key = readArgText(block, 'key')
  const note = readArgText(block, 'note')
  const reason = readArgText(block, 'reason')
  const goal = readArgText(block, 'goal')
  const script = readArgText(block, 'script')
  const textArg = readArgText(block, 'text')
  const values = readArgValue(block, 'values')
  const paths = readArgValue(block, 'paths')
  const tabAction = readArgText(block, 'action')
  const tabIndex = readArgValue(block, 'index')

  const safeArgUrl = safeWebHref(urlArg)
  if (safeArgUrl) return { summary: compact(safeArgUrl.display), title: safeArgUrl.href, url: safeArgUrl }

  switch (toolName) {
    case 'browser_click':
      return { summary: ref ? `[${ref}]` : '' }
    case 'browser_type': {
      const preview = textArg ? compact(`"${textArg}"`, 48) : ''
      return { summary: [ref ? `[${ref}]` : '', preview].filter(Boolean).join(' ') }
    }
    case 'browser_select': {
      const vals = Array.isArray(values) ? values.join(', ') : ''
      return { summary: [ref ? `[${ref}]` : '', compact(vals, 48)].filter(Boolean).join(' ') }
    }
    case 'browser_upload': {
      const list = Array.isArray(paths) ? paths : []
      const first = list[0] ? shortPath(String(list[0]), cwd) : ''
      const label = list.length > 1 ? `${first} (+${list.length - 1})` : first
      return { summary: [ref ? `[${ref}]` : '', label].filter(Boolean).join(' ') }
    }
    case 'browser_press':
      return { summary: key }
    case 'browser_tabs':
      return { summary: [tabAction, Number.isInteger(tabIndex) ? `#${tabIndex}` : ''].filter(Boolean).join(' ') }
    case 'browser_exec': {
      const first = script.split('\n').map(line => line.trim()).find(line => line !== '' && !line.startsWith('//')) ?? ''
      return { summary: compact(first) }
    }
    case 'browser_task':
      return { summary: compact(goal) }
    case 'browser_handoff': {
      const reasonLabel = HANDOFF_REASONS[reason] ? t(HANDOFF_REASONS[reason]) : reason
      return { summary: compact([reasonLabel, note].filter(Boolean).join(' · ')) }
    }
    default: {
      const resultUrl = safeWebHref(extractUrlFromText(rawResult))
      if (resultUrl) return { summary: compact(resultUrl.display), title: resultUrl.href, url: resultUrl }
      const pageTitle = extractTitleFromText(rawResult)
      return { summary: compact(pageTitle) }
    }
  }
}

function useNoteInlineCard(actions, sessionId, callId, active) {
  useLayoutEffect(() => {
    if (!active || !sessionId || !callId || typeof actions?.noteCards !== 'function') return undefined
    actions.noteCards(sessionId, [callId], 1)
    return () => actions.noteCards(sessionId, [callId], -1)
  }, [actions, sessionId, callId, active])
}

/**
 * Tool card for all DS Bot browser tools (`read_browser`, `browser_*`).
 */
export function BrowserToolView({
  toolName,
  callId,
  block,
  cwd,
  phase,
  useDisclosure,
  loadImage,
  actions,
  botId,
  sessionId,
  roster,
  heldCards: heldCardsProp,
  hooks,
}) {
  const heldCards = hooks?.useHeldCards?.(state => state[sessionId]) ?? heldCardsProp
  const liveHold = hooks?.useBrowserHolds?.(map => (botId ? map[botId] : undefined))
  const isLiveHandoff = toolName === 'browser_handoff'
    && Boolean(botId)
    && Boolean(callId)
    && liveHold?.callId === callId
    && typeof actions?.browserGiveBack === 'function'
  useNoteInlineCard(actions, sessionId, callId, isLiveHandoff)

  const imageBlocks = useMemo(
    () => (Array.isArray(block?.content) ? block.content.filter(item => item?.type === 'image' && item.attachment) : []),
    [block?.content],
  )
  const disclosure = useDisclosure(imageBlocks.length > 0)
  const autoOpened = useRef(imageBlocks.length > 0)
  useEffect(() => {
    if (!autoOpened.current && imageBlocks.length > 0) {
      autoOpened.current = true
      disclosure.setExpanded(true)
    }
  }, [imageBlocks.length, disclosure])

  if (isLiveHandoff && roster && !(heldCards?.[heldCardKey('handoff', callId)] > 0)) {
    return h(HandoffCall, { sessionId, callId, roster, actions, heldCards, hooks })
  }

  const isError = phase === 'result' && block?.isError === true
  const rawResult = phase === 'result' ? formatResult(block) : ''
  const errLine = errorLineOf(block, isError)
  const target = browserTargetOf(toolName, block, rawResult, cwd)
  const scriptArg = toolName === 'browser_exec' ? readArgText(block, 'script') : ''
  const taskParsed = toolName === 'browser_task' && phase === 'result' ? parseTaskSteps(rawResult) : null
  const argsText = toolName === 'browser_exec' ? '' : formatArgs(block)

  const badges = []
  if (toolName === 'browser_click' && readArgValue(block, 'confirm') === true) {
    badges.push(h('span', { key: 'confirm', className: 'dsb-tool-pill', 'data-tone': 'warn' }, t('Confirmed')))
  }
  if (toolName === 'browser_type' && readArgValue(block, 'submit') === true) {
    badges.push(h('span', { key: 'submit', className: 'dsb-tool-pill' }, '↵'))
  }
  if (toolName === 'browser_press' && target.summary) {
    badges.push(h('span', { key: 'key', className: 'dsb-tool-pill' }, target.summary))
  }
  if (imageBlocks.length > 0) {
    badges.push(h('span', { key: 'shot', className: 'dsb-tool-pill' }, t('Screenshot')))
  }
  if (taskParsed && taskParsed.steps.length > 0) {
    badges.push(h('span', { key: 'steps', className: 'dsb-tool-pill' }, t('{count} steps', { count: taskParsed.steps.length })))
  }

  const canOpenBrowser = Boolean(botId) && typeof actions?.openBrowser === 'function' && roster?.browser !== false
  const headerAction = canOpenBrowser
    ? h('button', {
      type: 'button',
      className: 'dsb-tool-action',
      onClick: () => actions.openBrowser(botId),
    }, t('Browser'))
    : null

  const hasBody = imageBlocks.length > 0
    || Boolean(target.url)
    || scriptArg !== ''
    || argsText !== ''
    || rawResult !== ''
    || errLine !== ''

  return h(ToolCardShell, {
    icon: GlobeIcon,
    label: t(BROWSER_LABELS[toolName] ?? 'Browser'),
    summary: toolName === 'browser_press' ? '' : target.summary,
    summaryTitle: target.title || target.summary || undefined,
    badges,
    headerAction,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  target.url ? h('a', { className: 'dsb-web-url', href: target.url.href, target: '_blank', rel: 'noopener noreferrer' }, target.url.href) : null,
  imageBlocks.length > 0 ? h('div', { className: 'dsb-tool-shots' },
    imageBlocks.map((item, index) => h(ToolImageThumb, {
      key: item.attachment.attachmentId ?? index,
      attachment: item.attachment,
      loadImage,
      alt: `${t(BROWSER_LABELS[toolName] ?? 'Browser')}${target.summary ? ` · ${target.summary}` : ''}`,
    }))) : null,
  scriptArg !== '' ? h(CodeSection, { label: t('Script'), text: scriptArg }) : null,
  taskParsed && taskParsed.steps.length > 0 ? h('div', { className: 'dsb-tool-sec' },
    h('div', { className: 'dsb-tool-sec-head' },
      h('span', { className: 'dsb-tool-sec-label' }, taskParsed.statusLine || t('Steps'))),
    h('div', { className: 'dsb-search-list' },
      taskParsed.steps.map((step, index) => h('div', { key: index, className: 'dsb-search-path' }, step)))) : null,
  argsText !== '' && scriptArg === '' ? h(CodeSection, { label: t('Arguments'), text: argsText }) : null,
  rawResult !== '' ? h(CodeSection, {
    label: isError ? t('Error') : (toolName === 'browser_snapshot' ? t('Page snapshot') : t('Output')),
    text: taskParsed?.answer || rawResult,
    error: isError,
  }) : null)
}

function computerActionLabel(toolName, method) {
  if (toolName === 'computer_handoff') return t('Computer handoff')
  const known = COMPUTER_ACTIONS[method]
  if (known) return t(known)
  const words = String(method ?? '').replace(/^cua_driver_native__/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim()
  return words === '' ? t('Computer use') : words[0].toUpperCase() + words.slice(1)
}

function computerTargetDetail(toolName, method, args) {
  if (toolName === 'computer_handoff') {
    const reason = typeof args?.reason === 'string' && HANDOFF_REASONS[args.reason] ? t(HANDOFF_REASONS[args.reason]) : ''
    const note = typeof args?.note === 'string' ? args.note : ''
    return compact([reason, note].filter(Boolean).join(' · '))
  }
  const params = args?.params && typeof args.params === 'object' ? args.params : args ?? {}
  if (typeof params.text === 'string' && params.text !== '') return compact(`"${params.text}"`, 48)
  if (typeof params.value === 'string' && params.value !== '') return compact(`"${params.value}"`, 48)
  if (Array.isArray(params.keys) && params.keys.length > 0) return params.keys.join('+')
  if (typeof params.key === 'string' && params.key !== '') return params.key
  if (typeof params.element === 'string' && params.element !== '') return compact(params.element, 48)
  if (typeof params.menuPath === 'string' && params.menuPath !== '') return compact(params.menuPath, 48)
  if (Array.isArray(params.menuPath) && params.menuPath.length > 0) return compact(params.menuPath.join(' › '), 48)
  if (Number.isFinite(params.x) && Number.isFinite(params.y)) return `(${Math.round(params.x)}, ${Math.round(params.y)})`
  if (typeof params.direction === 'string' && params.direction !== '') return params.direction
  if (method === 'getApp' && typeof params.selector === 'string') return params.selector
  return ''
}

export const isComputerToolName = name => name === 'cua' || name === 'computer_handoff' || String(name ?? '').startsWith('cua_driver_native__')

/**
 * Tool card for Computer Use tools (`cua`, `cua_driver_native__*`, `computer_handoff`).
 */
export function ComputerToolView({
  toolName,
  callId,
  block,
  phase,
  useDisclosure,
  loadImage,
  actions,
  botId,
  sessionId,
  roster,
  heldCards: heldCardsProp,
  hooks,
}) {
  const heldCards = hooks?.useHeldCards?.(state => state[sessionId]) ?? heldCardsProp
  const liveHold = hooks?.useComputer?.(map => (botId ? map.holds?.[botId] : undefined))
  const liveAsk = hooks?.useComputer?.(map => Object.values(map.asks ?? {}).find(item => item.callId === callId))
  const stepApp = hooks?.useComputer?.(map => (botId ? (map.bots?.[botId]?.steps ?? []).find(step => step.callId === callId)?.app : undefined))

  const isLiveHandoff = toolName === 'computer_handoff'
    && Boolean(botId)
    && Boolean(callId)
    && liveHold?.callId === callId
    && typeof actions?.computerHoldAnswer === 'function'
  const isLiveAsk = Boolean(liveAsk && botId && callId && typeof actions?.computerAppAnswer === 'function')
  useNoteInlineCard(actions, sessionId, callId, isLiveHandoff || isLiveAsk)

  const parsedArgs = useMemo(() => parseRawArgsObject(block), [block])
  const info = useMemo(() => classify(toolName, parsedArgs), [toolName, parsedArgs])
  const method = info?.method || readArgText(block, 'method') || String(toolName ?? '').replace(/^cua_driver_native__/, '')
  const params = parsedArgs?.params && typeof parsedArgs.params === 'object' ? parsedArgs.params : parsedArgs
  const appName = stepApp
    || (typeof params?.app === 'string' && params.app !== '' ? params.app : '')
    || (typeof params?.appName === 'string' && params.appName !== '' ? params.appName : '')
    || (typeof params?.app_name === 'string' && params.app_name !== '' ? params.app_name : '')
    || (method === 'getApp' && typeof params?.selector === 'string' ? params.selector : '')
  const targetDetail = computerTargetDetail(toolName, method, parsedArgs)

  const shotBlocks = useMemo(
    () => (Array.isArray(block?.content)
      ? block.content.filter(item => (item?.type === 'image' || item?.type === 'file') && item.attachment?.attachmentId)
      : []),
    [block?.content],
  )
  const disclosure = useDisclosure(shotBlocks.length > 0)
  const autoOpened = useRef(shotBlocks.length > 0)
  useEffect(() => {
    if (!autoOpened.current && shotBlocks.length > 0) {
      autoOpened.current = true
      disclosure.setExpanded(true)
    }
  }, [shotBlocks.length, disclosure])

  const fallbackShotLoader = useCallback(async (attachmentId) => {
    if (typeof actions?.computerShot !== 'function') return null
    const value = await actions.computerShot(attachmentId)
    return value?.dataUrl ?? null
  }, [actions])

  if (isLiveHandoff && roster && !(heldCards?.[heldCardKey('handoff', callId)] > 0)) {
    return h(ComputerHandoffCall, { sessionId, callId, roster, actions, heldCards, hooks })
  }

  const isError = phase === 'result' && block?.isError === true
  const rawResult = phase === 'result' ? formatResult(block) : ''
  const errLine = errorLineOf(block, isError)
  const argsText = formatArgs(block)
  const actionLabel = computerActionLabel(toolName, method)
  const summary = [appName, targetDetail].filter(Boolean).join(' · ')

  const badges = []
  if (info?.kind && ACCESS_LABELS[info.kind]) {
    badges.push(h('span', {
      key: 'kind',
      className: 'dsb-tool-pill',
      'data-tone': info.kind === 'foreground' ? 'warn' : undefined,
    }, t(ACCESS_LABELS[info.kind])))
  }
  if (shotBlocks.length > 0) {
    badges.push(h('span', { key: 'shot', className: 'dsb-tool-pill' }, t('Screenshot')))
  }

  const canOpenComputer = Boolean(sessionId) && typeof actions?.showDetails === 'function' && roster?.computer?.enabled === true
  const headerAction = canOpenComputer
    ? h('button', {
      type: 'button',
      className: 'dsb-tool-action',
      onClick: () => actions.showDetails(sessionId, 'computer'),
    }, t('Computer'))
    : null

  const hasBody = shotBlocks.length > 0 || argsText !== '' || rawResult !== '' || errLine !== ''

  const card = h(ToolCardShell, {
    icon: MonitorIcon,
    label: actionLabel,
    summary,
    summaryTitle: summary || undefined,
    badges,
    headerAction,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  shotBlocks.length > 0 ? h('div', { className: 'dsb-tool-shots' },
    shotBlocks.map((item, index) => h(ToolImageThumb, {
      key: item.attachment.attachmentId ?? index,
      attachment: item.attachment,
      loadImage,
      fallbackLoader: fallbackShotLoader,
      alt: [appName, actionLabel].filter(Boolean).join(' · '),
    }))) : null,
  argsText !== '' ? h(CodeSection, { label: t('Arguments'), text: argsText }) : null,
  rawResult !== '' ? h(CodeSection, { label: isError ? t('Error') : t('Output'), text: rawResult, error: isError }) : null)

  if (isLiveAsk && roster) {
    return h(Fragment, null,
      card,
      h(AppAccessCall, { sessionId, callId, roster, actions, heldCards, hooks }))
  }
  return card
}
