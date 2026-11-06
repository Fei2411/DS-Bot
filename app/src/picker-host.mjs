// The main process's half of the app's own picker: one open picker per id, tied to the page that
// shows it. The page asks for listings, new folders and the answer over IPC; a request from any
// other page, or for a picker that is no longer open, gets nothing.
import { chosen, list, makeFolder, roots, saveTarget, startIn, typed } from './folder-picker.mjs'

export const PICKER_IPC = {
  open: 'ds-bot:app-picker', shown: 'ds-bot:app-picker-shown', cancel: 'ds-bot:app-picker-cancel',
  roots: 'ds-bot:app-picker-roots', list: 'ds-bot:app-picker-list', folder: 'ds-bot:app-picker-folder', choose: 'ds-bot:app-picker-choose',
}

// A page that has not drawn the picker by then cannot (not loaded, gone, or hung).
export const PICKER_SHOWN_MS = 2000

export class Pickers {
  #open = new Map()
  #count = 0
  #getPath
  #platform
  #shownMs

  /**
   * @param {{ ipcMain: any, getPath: (name: string) => string, platform?: string, shownMs?: number }} options
   */
  constructor({ ipcMain, getPath, platform = process.platform, shownMs = PICKER_SHOWN_MS }) {
    this.#getPath = getPath
    this.#platform = platform
    this.#shownMs = shownMs
    const from = (event, id) => {
      const open = this.#open.get(id)
      return open !== undefined && event.sender === open.contents ? open : undefined
    }
    ipcMain.on(PICKER_IPC.shown, (event, id) => { from(event, id)?.shown() })
    ipcMain.on(PICKER_IPC.cancel, (event, id) => { from(event, id)?.settle(null) })
    ipcMain.handle(PICKER_IPC.roots, (event, id) => (from(event, id) === undefined ? undefined : roots({ getPath: this.#getPath, platform: this.#platform })))
    ipcMain.handle(PICKER_IPC.list, async (event, id, path, at) => {
      const open = from(event, id)
      if (open === undefined) return undefined
      return await list(typed(path, typeof at === 'string' ? at : open.start, this.#home()), { files: open.mode !== 'folder', extensions: open.extensions })
    })
    ipcMain.handle(PICKER_IPC.folder, async (event, id, parent, name) => {
      if (from(event, id) === undefined) return undefined
      return await makeFolder(String(parent), String(name), this.#platform)
    })
    ipcMain.handle(PICKER_IPC.choose, async (event, id, path, options) => {
      const open = from(event, id)
      if (open === undefined) return undefined
      const answer = open.mode === 'save'
        ? await saveTarget(String(path), String(options?.name ?? ''), this.#platform)
        : await chosen(String(path), open.mode)
      if ('error' in answer) return answer
      // A file of that name is there: the page asks first, and asks again with `replace`.
      if (answer.exists && options?.replace !== true) return answer
      open.settle(answer.path)
      return { path: answer.path }
    })
  }

  #home() {
    try { return this.#getPath('home') } catch { return undefined }
  }

  /**
   * Shows a picker on `contents`' page: the chosen path, null when the user cancels, undefined
   * when the page cannot show it or goes away first.
   * @param {any} contents the webContents whose page shows the picker
   * @param {{ mode: 'folder' | 'file' | 'save', title: string, start?: string, name?: string, extensions?: string[], labels: object }} request
   * @returns {Promise<string | null | undefined>}
   */
  async ask(contents, request) {
    if (contents === undefined || contents === null || contents.isDestroyed() || contents.isLoading()) return undefined
    const id = (this.#count += 1)
    const start = await startIn(request.start, this.#home())
    return await new Promise((resolve) => {
      let seen = false
      const away = () => { settle(undefined) }
      const settle = (value) => {
        if (!this.#open.has(id)) return
        this.#open.delete(id)
        clearTimeout(timer)
        contents.off?.('did-start-loading', away)
        contents.off?.('destroyed', away)
        resolve(value)
      }
      const timer = setTimeout(() => { if (!seen) away() }, this.#shownMs)
      this.#open.set(id, { contents, mode: request.mode, extensions: request.extensions, start, settle, shown: () => { seen = true } })
      contents.once('did-start-loading', away)
      contents.once('destroyed', away)
      contents.send(PICKER_IPC.open, { id, mode: request.mode, title: request.title, start, name: request.name, labels: request.labels })
    })
  }

}
