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
 *   computer?: { onAction: (kind: string, botId: string | null) => void },
 *   log?: Pick<Console, 'warn'>,
 * }} options the mark, the tooltip and the two entries of the menu
 * @returns {{ tray: object, relabel: () => void, setComputer: (entries: object[]) => void, dispose: () => void }}
 */
export function createTray({ Tray, Menu, platform, image, tooltip, open, quit, computer, log = console }) {
  const tray = new Tray(image)
  let disposed = false
  let entries = []
  const relabel = () => {
    tray.setToolTip(tooltip)
    const rows = entries.map(entry => ({
      label: entry.label,
      click: () => { computer?.onAction('stop', entry.botId ?? null) },
    }))
    if (entries.length > 1) rows.push({
      label: computer?.stopAll?.() ?? 'Stop all', click: () => { computer?.onAction('stopall', null) },
    })
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: open.label, click: () => { open.run() } },
      ...(rows.length > 0 ? [{ type: 'separator' }, ...rows] : []),
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
    /** The same entries the floating indicator shows, while any Bot is on the computer. */
    setComputer(next) {
      entries = Array.isArray(next) ? next.filter(entry => entry && typeof entry.label === 'string') : []
      if (!disposed) relabel()
    },
    /** Take the icon away; the app leaves no dead icon behind. */
    dispose() {
      if (disposed) return
      disposed = true
      try { tray.destroy() } catch (error) { log.warn(`DS Bot: the tray icon did not go away: ${error instanceof Error ? error.message : String(error)}`) }
    },
  }
}
