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

// Raising windows and moving the visible cursor are foreground; so is session
// escalation. Anything the driver adds that DS Bot does not know fails closed to
// foreground — never silently allowed.
const DRIVER_BACKGROUND = new Set([
  'launch_app', 'kill_app', 'set_window_frame', 'invoke_menu', 'click', 'double_click',
  'right_click', 'drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll',
  'clipboard_read', 'clipboard_write', 'page', 'browser_prepare', 'browser_navigate',
  'browser_click', 'browser_type', 'browser_dialog', 'browser_set_input_files',
  'browser_download', 'browser_pointer', 'start_recording', 'stop_recording',
  'replay_trajectory', 'install_ffmpeg', 'start_session', 'end_session', 'set_config',
])

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
      : args?.foreground === true || !DRIVER_BACKGROUND.has(method) ? 'foreground' : 'background'
    return { provider: PROVIDERS.driver, kind, method }
  }
  return undefined
}

// Whether a tool name belongs to a computer-use provider at all.
export const isComputerTool = name => classify(name, {}) !== undefined

// Driver calls these without an app target: lists and the agent's own
// session/config. Everything else must resolve the app it acts on; a call that
// cannot is refused before it can reach the desktop.
export const DRIVER_GLOBAL = new Set([
  'list_apps', 'list_windows', 'get_screen_size', 'get_cursor_position',
  'get_config', 'set_config', 'check_permissions', 'health_report',
  'get_session', 'list_sessions', 'get_session_state', 'get_recording_state',
  'get_agent_cursor_state',
  'start_session', 'end_session',
])

// Refused at every level: a Bot must not reconfigure the driver, and whole-screen
// capture/replay bypasses per-app consent and the protected list. The session
// lifecycle and the list/permission/health tools stay.
export const DRIVER_REFUSED = new Set([
  'set_config', 'start_recording', 'stop_recording', 'replay_trajectory', 'install_ffmpeg',
  'set_agent_cursor_enabled', 'set_agent_cursor_motion', 'set_agent_cursor_theme',
])

// The kind a level admits. 'off' sees nothing.
export const LEVELS = ['off', 'view', 'background', 'foreground']
export function levelAllows(level, kind) {
  if (kind === 'observe') return LEVELS.indexOf(level) >= 1
  if (kind === 'background') return LEVELS.indexOf(level) >= 2
  return LEVELS.indexOf(level) >= 3
}
