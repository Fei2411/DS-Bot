// Which computer tools exist and how much each call can touch. `kind` maps onto the
// Bot levels: view allows observe, background adds background, foreground adds
// foreground. A call nothing recognizes counts as foreground: better refused than
// silently let through.
export const PROVIDERS = { cua: 'cua', driver: 'cua-driver' }
export const KINDS = ['observe', 'background', 'foreground']

// The macOS provider's single `cua` tool dispatches on params.method. Pure reads and
// consent-gated selection need no lease; activate and hover can raise an app or move
// the visible pointer, so they are foreground; permission UI opens on the user's
// screen. Everything else stays in the app's background.
const CUA_OBSERVE = new Set([
  'getCapabilities', 'listApps', 'findApps', 'getApp', 'listWindows', 'getState', 'screenshot',
  'permissionStatus', 'applicationIcons',
])
const CUA_FOREGROUND = new Set(['activate', 'hover', 'requestPermission', 'openPermissionSettings'])
const CUA_BACKGROUND = new Set([
  'click', 'scroll', 'drag', 'setValue', 'selectText', 'performSecondaryAction',
  'typeText', 'paste', 'pressKey', 'show', 'launchApp',
])

// The Cua Driver provider serves one tool per method as `cua_driver_native__<name>`.
export const DRIVER_PREFIX = 'cua_driver_native__'
const DRIVER_OBSERVE = new Set([
  'list_apps', 'list_windows', 'get_window_state', 'get_accessibility_tree', 'verify_state',
  'parse_visual_regions', 'get_desktop_state', 'get_screen_size', 'get_cursor_position', 'zoom',
  'debug_window_info', 'get_browser_state', 'get_session', 'list_sessions', 'get_session_state',
  'get_agent_cursor_state', 'get_recording_state', 'get_config', 'check_permissions', 'health_report',
])
// Tools that exist to bring a window to the user or to take over the visible pointer.
const DRIVER_FOREGROUND = new Set([
  'activate_window', 'activate_app', 'focus_window', 'focus_app', 'raise_window',
  'move_cursor', 'set_cursor_position', 'foreground_input',
])
// A foreground kind also when the caller asks for foreground delivery in its args.
const FOREGROUND_ARGS = /foreground|activate|focus/i

// Classify one call. Returns undefined for a tool computer use does not own.
// `args` is the parsed tool-call arguments object (cua: {method, params}).
export function classify(name, args = {}) {
  if (name === 'cua') {
    const method = typeof args?.method === 'string' ? args.method : ''
    const kind = CUA_OBSERVE.has(method) ? 'observe'
      : CUA_FOREGROUND.has(method) ? 'foreground'
        : CUA_BACKGROUND.has(method) ? 'background' : 'foreground'
    return { provider: PROVIDERS.cua, kind, method }
  }
  if (typeof name === 'string' && name.startsWith(DRIVER_PREFIX)) {
    const method = name.slice(DRIVER_PREFIX.length)
    const kind = DRIVER_OBSERVE.has(method) ? 'observe'
      : DRIVER_FOREGROUND.has(method)
        || (typeof args?.foreground === 'boolean' ? args.foreground : FOREGROUND_ARGS.test(method))
        ? 'foreground' : 'background'
    return { provider: PROVIDERS.driver, kind, method }
  }
  return undefined
}

// Whether a tool name belongs to a computer-use provider at all.
export const isComputerTool = name => classify(name, {}) !== undefined

// The kind a level admits. 'off' sees nothing.
export const LEVELS = ['off', 'view', 'background', 'foreground']
export function levelAllows(level, kind) {
  if (kind === 'observe') return LEVELS.indexOf(level) >= 1
  if (kind === 'background') return LEVELS.indexOf(level) >= 2
  return LEVELS.indexOf(level) >= 3
}
