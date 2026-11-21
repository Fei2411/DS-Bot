// The team's appearance (docs/plans/2026-11-21-appearance.md): its fields and the user themes
// in `state.prefs`, a chat's own background on its Bot or group (`background`), and the background
// pictures. A picture is kept in the data folder under the hash of its bytes, so the same
// picture is stored once and every device reads it by id. Pictures that nothing uses any
// more are removed after a while; a picture saved a moment ago stays until the change that
// names it has had time to arrive.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { IMAGE_ID, AppearanceError, MAX_BACKGROUND_BYTES, MAX_USER_THEMES, USER_THEME, cleanBackground, cleanTheme, backgroundImages, patchAppearance } from '../shared/appearance.js'
import { replaceFile } from './files.js'

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const FILE = /^([0-9a-f]{64})\.(png|jpg|webp|gif)$/
// How long an unused picture stays: long enough for the change that names it to arrive.
const UNUSED_KEEP_MS = 10 * 60_000

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to))
// The type is read from the bytes, not from what the data URL says.
export function pictureType(bytes) {
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'image/gif'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

export function install(rt) {
  const { state } = rt
  const root = typeof rt.home === 'string' ? join(rt.home, 'backgrounds') : undefined
  const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
  const checked = (task) => {
    try { return task() } catch (error) { throw error instanceof AppearanceError ? invalid(error.message) : error }
  }

  let queue = Promise.resolve()
  const serial = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => {}, () => {})
    return run
  }

  const fileOf = async (id) => {
    if (root === undefined || !IMAGE_ID.test(id)) return undefined
    const names = await readdir(root).catch(() => [])
    const name = names.find(entry => entry.startsWith(`${id}.`) && FILE.test(entry))
    return name === undefined ? undefined : join(root, name)
  }

  /** Save a background picture; the same bytes are kept once. */
  const addPicture = image => serial(async () => {
    if (root === undefined) throw invalid('This host keeps no data folder, so it cannot keep a background picture')
    const match = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(image ?? ''))
    if (match === null) throw invalid('Pick a PNG, JPEG, WebP or GIF picture')
    const bytes = Buffer.from(match[1], 'base64')
    if (bytes.length > MAX_BACKGROUND_BYTES) throw invalid(`The picture is too large: the limit is ${MAX_BACKGROUND_BYTES / 1024 / 1024} MB`)
    const mime = pictureType(bytes)
    if (mime === undefined) throw invalid('Pick a PNG, JPEG, WebP or GIF picture')
    const id = createHash('sha256').update(bytes).digest('hex')
    const path = join(root, `${id}.${EXTENSIONS[mime]}`)
    if (await stat(path).then(() => true, () => false)) {
      // Picked again: it counts as new, so the sweep keeps it until the change naming it arrives.
      const now = new Date()
      await utimes(path, now, now)
    } else {
      await mkdir(root, { recursive: true })
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, bytes)
      await replaceFile(temp, path)
    }
    return { id, mime, bytes: bytes.length }
  })

  const readPicture = async (id) => {
    const path = await fileOf(String(id ?? ''))
    if (path === undefined) return null
    const ext = FILE.exec(basename(path))[2]
    const mime = Object.entries(EXTENSIONS).find(([, known]) => known === ext)[0]
    const bytes = await readFile(path).catch(() => undefined)
    return bytes === undefined ? null : { id, mime, image: `data:${mime};base64,${bytes.toString('base64')}` }
  }

  const inUse = () => new Set(backgroundImages(state.prefs.appearance?.background, ...Object.values(state.bots).map(bot => bot.background), ...Object.values(state.rooms).map(room => room.background)))
  // A window that only reads the team leaves the pictures to the one that holds it; the team
  // is read first, so a picture in use is never taken for an unused one.
  const sweep = () => serial(async () => {
    await rt.load?.()
    if (root === undefined || rt.readOnly?.() !== undefined) return
    const used = inUse()
    const now = Date.now()
    for (const name of await readdir(root).catch(() => [])) {
      const match = FILE.exec(name)
      if (match === null || used.has(match[1])) continue
      const path = join(root, name)
      const info = await stat(path).catch(() => undefined)
      if (info !== undefined && now - info.mtimeMs > UNUSED_KEEP_MS) await rm(path, { force: true })
    }
  }).catch(error => rt.warn?.('ds-bot: unused background pictures not removed: %s', error))

  /** `set-prefs` fields: `appearance` (a change to its fields) and `themes` (id → theme or null). */
  const applyPrefs = body => checked(() => {
    let changed = false
    if (body.appearance !== undefined) {
      const next = patchAppearance(state.prefs.appearance, body.appearance)
      if (Object.keys(next).length === 0) delete state.prefs.appearance
      else state.prefs.appearance = next
      changed = true
    }
    if (body.themes !== undefined) {
      if (body.themes === null || typeof body.themes !== 'object' || Array.isArray(body.themes)) throw new AppearanceError('Themes are named by their ids')
      const themes = { ...state.prefs.themes }
      for (const [id, theme] of Object.entries(body.themes)) {
        if (!USER_THEME.test(id)) throw new AppearanceError('A theme of your own has an id that starts with my-')
        if (theme === null) delete themes[id]
        else themes[id] = cleanTheme(theme)
      }
      if (Object.keys(themes).length > MAX_USER_THEMES) throw new AppearanceError(`You can keep at most ${MAX_USER_THEMES} themes of your own`)
      if (Object.keys(themes).length === 0) delete state.prefs.themes
      else state.prefs.themes = themes
      // A theme removed while in use leaves the team on the default theme.
      if (USER_THEME.test(state.prefs.theme ?? '') && themes[state.prefs.theme] === undefined) delete state.prefs.theme
      changed = true
    }
    return changed
  })

  /** A Bot's or group's own chat background; `null` follows the team background again. */
  const setChatBackground = async (body) => {
    const owner = typeof body.roomId === 'string' ? rt.roomOf(body.roomId) : rt.botOf(String(body.botId ?? ''))
    if (owner === undefined) throw Object.assign(new Error(typeof body.roomId === 'string' ? 'Unknown group chat' : 'Unknown Bot'), { code: 'bot/not-found' })
    if (body.background === null) delete owner.background
    else owner.background = checked(() => cleanBackground(body.background))
    await rt.save()
    void sweep()
    return owner.background ?? null
  }

  // Unused pictures are looked for again every while, so one left a moment before a save,
  // or by a Bot or group that was removed, goes too.
  rt.ctx?.effect?.(() => {
    const timer = setInterval(() => { void sweep() }, UNUSED_KEEP_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: unused background pictures')

  Object.assign(rt, { appearancePrefs: applyPrefs, backgroundSweep: sweep, backgroundAdd: addPicture, backgroundPicture: readPicture, setChatBackground })
}
