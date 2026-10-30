// A file the main window downloads asks where it should go first. Downloads from
// any other contents (the sign-in child, a Bot browser guest) keep their own
// session's rules.
import { join } from 'node:path'

export function downloadSaver({ window, dialog, downloads }) {
  return (event, item, source) => {
    // The window is asked for at the moment of the download: the app may build a new one.
    const owner = typeof window === 'function' ? window() : window
    if (owner === undefined || owner === null || source !== owner.webContents) return
    const file = dialog.showSaveDialogSync(owner, { defaultPath: join(downloads, item.getFilename()) })
    if (file === undefined) event.preventDefault()
    else item.setSavePath(file)
  }
}
