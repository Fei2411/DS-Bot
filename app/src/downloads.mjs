// A file the main window downloads asks where it should go first, on the app's own picker.
// Downloads from any other contents (the sign-in child, a Bot browser guest) keep their own
// session's rules.
//
// Electron needs the save path before will-download returns, and the picker answers later: the
// download starts into a staging folder of its own, and moves to the chosen file once both the
// answer and the download are in. A cancelled picker cancels the download.
import { randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

/**
 * @param {{
 *   window: any,
 *   ask: (name: string, folder: string | undefined) => Promise<string | null | undefined>,
 *   staging: () => string,
 *   getPath: (name: string) => string,
 *   homedir?: () => string,
 *   log?: Pick<Console, 'warn'>,
 * }} options `ask` shows the picker: the chosen file, null when cancelled, undefined when the
 *   page cannot show it (the file then goes into the start folder under a free name). `getPath`
 *   is Electron's app.getPath, asked again for every download.
 */
export function downloadSaver({ window, ask, staging, getPath, homedir = osHomedir, log = console }) {
  return (event, item, source) => {
    // The window is asked for at the moment of the download: the app may build a new one.
    const owner = typeof window === 'function' ? window() : window
    if (owner === undefined || owner === null || source !== owner.webContents) return
    const folder = startFolder(getPath, homedir)
    const name = safeName(item.getFilename())
    const holding = join(staging(), randomUUID())
    try {
      mkdirSync(holding, { recursive: true })
    } catch (error) {
      log.warn(`DS Bot: a download could not start: ${message(error)}`)
      event.preventDefault()
      return
    }
    const staged = join(holding, name)
    item.setSavePath(staged)
    const finished = new Promise((resolve) => { item.once('done', (_event, state) => { resolve(state) }) })
    void (async () => {
      let target
      try {
        target = await ask(name, folder)
      } catch (error) {
        log.warn(`DS Bot: the save picker failed: ${message(error)}`)
        target = null
      }
      if (target === null) item.cancel()
      const state = await finished
      if (state !== 'completed' || target === null) {
        rmSync(holding, { recursive: true, force: true })
        return
      }
      // A picker that cannot run means the start folder under a free name. The name is
      // picked only now, in the same breath as the move, so two downloads of one name
      // cannot take the same path.
      if (target === undefined && folder !== undefined) target = freePath(folder, name)
      if (typeof target !== 'string') {
        log.warn(`DS Bot: a finished download has nowhere to go; it stays at ${staged}`)
        return
      }
      try {
        move(staged, target)
      } catch (error) {
        if (folder === undefined) {
          log.warn(`DS Bot: a download could not be moved to ${target}; it stays at ${staged}: ${message(error)}`)
          return
        }
        try {
          const fallback = freePath(folder, name)
          move(staged, fallback)
          log.warn(`DS Bot: a download could not be moved to ${target}; it went to ${fallback} instead: ${message(error)}`)
        } catch (secondError) {
          log.warn(`DS Bot: a download could not be moved to ${target}; it stays at ${staged}: ${message(secondError)}`)
          return
        }
      }
      rmSync(holding, { recursive: true, force: true })
    })()
  }
}

const message = error => (error instanceof Error ? error.message : String(error))

// The name comes from the server; it names one file in the staging folder and nothing else.
function safeName(name) {
  const plain = basename(String(name ?? '').replace(/[\\/]+/gu, '_')).trim()
  return plain === '' || plain === '.' || plain === '..' ? 'download' : plain
}

// The picker asked before it replaced a file; a rename does not cross drives. The copy
// lands next to the target first and then takes its name, so a failed copy leaves the
// old file whole.
export function move(from, to, fs = { renameSync, copyFileSync, rmSync }) {
  try {
    fs.renameSync(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV' && error?.code !== 'EPERM' && error?.code !== 'EEXIST') throw error
    const part = join(dirname(to), `.${basename(to)}.${randomUUID()}.part`)
    try {
      fs.copyFileSync(from, part, constants.COPYFILE_EXCL)
      fs.renameSync(part, to)
    } catch (copyError) {
      fs.rmSync(part, { force: true })
      throw copyError
    }
  }
}

/** `name` in `folder`, or `name (2)`, `name (3)`… when it is taken. */
export function freePath(folder, name) {
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let count = 1; ; count += 1) {
    const path = join(folder, count === 1 ? name : `${stem} (${String(count)})${extension}`)
    if (!existsSync(path)) return path
  }
}

// getPath throws when a known folder does not resolve (Downloads deleted, or redirected to a
// drive that is not there). Without any folder the picker opens in the home folder.
function startFolder(getPath, homedir) {
  for (const find of [() => getPath('downloads'), () => getPath('home'), homedir]) {
    try {
      const folder = find()
      if (folder) return folder
    } catch {}
  }
  return undefined
}
