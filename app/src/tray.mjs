// The system tray: the way back to a hidden window and the one ordinary way out.

/**
 * @param {{
 *   Tray: new (image: object) => object,
 *   Menu: { buildFromTemplate: (template: object[]) => object },
 *   platform: string,
 *   image: object,
 *   tooltip: string,
 *   open: { label: string, run: () => void },
 *   quit: { label: string, run: () => void },
 *   log?: Pick<Console, 'warn'>,
 * }} options the mark, the tooltip and the two entries of the menu
 * @returns {{ tray: object, relabel: () => void, dispose: () => void }}
 */
export function createTray({ Tray, Menu, platform, image, tooltip, open, quit, log = console }) {
  const tray = new Tray(image)
  let disposed = false
  const relabel = () => {
    tray.setToolTip(tooltip)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: open.label, click: () => { open.run() } },
      { type: 'separator' },
      { label: quit.label, click: () => { quit.run() } },
    ]))
  }
  // macOS opens the menu of the icon instead of a click of its own; there the menu is the
  // way back to the window.
  if (platform !== 'darwin') tray.on('click', () => { open.run() })
  relabel()
  return {
    tray,
    relabel,
    /** Take the icon away; the app leaves no dead icon behind. */
    dispose() {
      if (disposed) return
      disposed = true
      try { tray.destroy() } catch (error) { log.warn(`DeepSeek Bot: the tray icon did not go away: ${error instanceof Error ? error.message : String(error)}`) }
    },
  }
}
