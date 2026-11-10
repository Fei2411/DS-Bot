// The frameless window: the page reaches the window's top edge, and the system window controls
// stand in a band at its top, over the page (the caption buttons on Windows, the traffic lights
// on macOS), as in DeepSeek Harness apps/desktop (windows-layout.ts and main.ts; see NOTICE).
// Linux keeps the system title bar.

/** Height of the caption band in device-independent pixels. */
export const CAPTION_HEIGHT = 40

/** The traffic lights, 14 px high, centred in the band. */
export const TRAFFIC_LIGHTS = { x: 16, y: (CAPTION_HEIGHT - 14) / 2 }

/** Whether the window draws the page under its own window controls. */
export const framelessOn = platform => platform === 'win32' || platform === 'darwin'

/**
 * The system material behind the page, which material.css lets through the sidebar: Mica from
 * Windows 11 22H2 (build 22621), the sidebar vibrancy on macOS.
 */
export function materialOf(platform, release) {
  if (platform === 'darwin') return 'vibrancy'
  return platform === 'win32' && Number(String(release).split('.')[2] ?? 0) >= 22621 ? 'mica' : undefined
}

/** The BrowserWindow options of the frame; `caption` holds the colors of the Windows caption buttons. */
export function frameOptions(platform, material, caption) {
  if (platform === 'win32') {
    return { titleBarStyle: 'hidden', titleBarOverlay: { height: CAPTION_HEIGHT, ...caption }, ...(material === 'mica' ? { backgroundMaterial: 'mica' } : {}) }
  }
  // 'active' keeps the material when the window loses the focus; 'followWindow' washes it out.
  if (platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHTS, vibrancy: 'sidebar', visualEffectState: 'active' }
  return {}
}

/**
 * macOS puts the vibrancy back late after a window comes back from the Dock or from hiding
 * (electron/electron#25368), and the transparent window shows the desktop until then. While the
 * window is minimized or hidden it paints `fill()`; coming back, the change from no vibrancy to
 * 'sidebar' makes macOS put the material back.
 */
export function keepVibrancy(win, fill) {
  const apply = () => {
    if (win.isDestroyed()) return
    if (win.isMinimized() || !win.isVisible()) {
      win.setVibrancy(null)
      win.setBackgroundColor(fill())
    } else {
      win.setVibrancy('sidebar')
      win.setBackgroundColor('#00000000')
    }
  }
  for (const event of ['minimize', 'hide', 'restore', 'show']) win.on(event, apply)
}

const COLOR = /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu
/** Only plain CSS colors cross from the page to the caption buttons. */
export const cssColor = value => typeof value === 'string' && COLOR.test(value)

/** The theme sources that the native theme accepts; a theme id has no native counterpart. */
export const nativeThemeSource = value => (value === 'light' || value === 'dark' || value === 'system' ? value : undefined)
