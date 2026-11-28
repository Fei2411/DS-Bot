// Side Apps: the panel's mount point. Each App the panel can show is a plain entry
// here (its id doubles as `ui.view`), so the panel, the strip, the widths and the
// layout rules read one table instead of each spelling the views out. The Canvas and
// Reader Apps live on workspace files; their tabs are plain data kept per subject.
// Design: docs/plans/2026-11-25-side-app-workbench.md. Everything here is pure.
import { t } from './i18n.js'

// The window keeps this many chat columns' worth of room: the panel never takes it.
export const SIDE_MIN_CHAT = 420
export const FILE_TABS_MAX = 8
export const SOURCE_SHOW_MAX = 512 * 1024
export const REPORT_QUOTE_MAX = 2000

// order: where the App's tabs sit on the strip. width: { min, initial, max } where max
// is a cap or null for "whatever the window leaves".
export const SIDE_APPS = {
  details: { id: 'details', order: 0, width: { min: 320, initial: 320, max: 520 }, files: false },
  browser: { id: 'browser', order: 1, width: { min: 360, initial: 520, max: null }, files: false },
  side: { id: 'side', order: 2, width: { min: 320, initial: 320, max: 520 }, files: false },
  task: { id: 'task', order: 3, width: { min: 320, initial: 320, max: 520 }, files: false },
  canvas: { id: 'canvas', order: 4, width: { min: 400, initial: 560, max: null }, files: true, extensions: ['.html', '.htm'] },
  reader: { id: 'reader', order: 5, width: { min: 360, initial: 480, max: 720 }, files: true, extensions: ['.md', '.markdown', '.mdx'] },
}

export const isSideApp = id => Object.hasOwn(SIDE_APPS, id)
export const isFileApp = id => SIDE_APPS[id]?.files === true
// What each App needs besides the chat, as frame-layout.js asks for it.
export const PANEL_MINIMUMS = Object.fromEntries(Object.entries(SIDE_APPS).map(([id, app]) => [id, app.width.min]))

/**
 * The width range of an App in a window whose panel-and-chat room is `room`.
 * @returns {[number, number]} the low and high bound; high never drops below low
 */
export function widthRangeOf(view, room) {
  const { min, max } = (SIDE_APPS[view] ?? SIDE_APPS.details).width
  const fits = room - SIDE_MIN_CHAT
  return [min, Math.max(min, max === null ? fits : Math.min(max, fits))]
}
export const clampWidth = (width, [low, high]) => Math.round(Math.max(low, Math.min(width, high)))

// ---- file tabs ------------------------------------------------------------------

// A file tab names a file by what the host signed (app, workspace tag, path), never by
// an absolute path: the key is only an identity, not a credential.
export const fileTabKey = (app, workspaceTag, displayPath) => `${app}\u0000${workspaceTag}\u0000${displayPath}`

export const MODES = ['preview', 'source', 'diff']
export const modeOf = value => (MODES.includes(value) ? value : 'preview')

/** A card or tool-result descriptor, validated; undefined for anything else. */
export function parseDescriptor(value) {
  if (value === null || typeof value !== 'object') return undefined
  if (value.v !== 1 || !isFileApp(value.app)) return undefined
  if (typeof value.workspaceTag !== 'string' || value.workspaceTag === '') return undefined
  if (typeof value.displayPath !== 'string' || value.displayPath === '') return undefined
  const sessionId = typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : undefined
  return {
    v: 1, app: value.app, workspaceTag: value.workspaceTag, displayPath: value.displayPath,
    ...(sessionId ? { sessionId } : {}),
    ...(MODES.includes(value.tab) ? { tab: value.tab } : {}),
  }
}

// The first line of an open tool's result is its descriptor as JSON.
export function descriptorFromResult(text) {
  const first = String(text ?? '').split('\n', 1)[0]
  if (!first.startsWith('{')) return undefined
  try { return parseDescriptor(JSON.parse(first)) } catch { return undefined }
}

// `asked` is whether the card or tool named a view: an open that names none leaves an
// open tab where it is, one that names `preview` too is a request to go back to it.
export const tabFromDescriptor = (descriptor, sessionId) => ({
  key: fileTabKey(descriptor.app, descriptor.workspaceTag, descriptor.displayPath),
  app: descriptor.app,
  workspaceTag: descriptor.workspaceTag,
  displayPath: descriptor.displayPath,
  sessionId: descriptor.sessionId ?? sessionId,
  mode: modeOf(descriptor.tab),
  asked: MODES.includes(descriptor.tab),
})

/** The file descriptor the host endpoints take, from a tab. */
export const fileOf = tab => ({ app: tab.app, displayPath: tab.displayPath, workspaceTag: tab.workspaceTag })

/** What `side-app-open` is asked when a card is reopened: the card's own conversation and file. */
export const reopenBody = tab => ({ app: tab.app, sessionId: tab.sessionId, file: fileOf(tab) })

/**
 * Open or focus a tab. An open tab is focused and keeps its own mode unless the
 * descriptor names one. A full strip refuses instead of dropping a tab that may hold
 * an unreviewed diff.
 * @returns {{tabs: object[], active: string|null, full: boolean}}
 */
export function openFileTab(tabs, tab) {
  const at = tabs.findIndex(item => item.key === tab.key)
  const stored = ({ asked: _asked, ...rest }) => rest
  if (at >= 0) {
    const asked = tab.asked === true || tab.mode !== 'preview'
    const next = tabs.map((item, index) => (index === at ? { ...item, sessionId: tab.sessionId ?? item.sessionId, ...(asked ? { mode: tab.mode } : {}) } : item))
    return { tabs: next, active: tab.key, full: false }
  }
  if (tabs.length >= FILE_TABS_MAX) return { tabs, active: null, full: true }
  return { tabs: [...tabs, stored(tab)], active: tab.key, full: false }
}

export const closeFileTab = (tabs, key) => tabs.filter(item => item.key !== key)
export const setTabMode = (tabs, key, mode) => tabs.map(item => (item.key === key ? { ...item, mode: modeOf(mode) } : item))

/** Every subject's tabs as storage keeps them, and back (a damaged entry is skipped). */
export const persistAll = all => Object.fromEntries(Object.entries(all ?? {}).filter(([, tabs]) => tabs.length > 0).map(([subject, tabs]) => [subject, persistTabs(tabs)]))
export function restoreAll(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const all = {}
  for (const [subject, tabs] of Object.entries(value)) {
    const restored = restoreTabs(tabs)
    if (restored.length > 0) all[subject] = restored
  }
  return all
}

/** The shortest label that tells same-named files apart: the name, else parent/name. */
export function tabLabels(tabs) {
  const name = path => path.split('/').pop()
  const counts = new Map()
  for (const tab of tabs) counts.set(name(tab.displayPath), (counts.get(name(tab.displayPath)) ?? 0) + 1)
  return new Map(tabs.map((tab) => {
    const parts = tab.displayPath.split('/')
    const own = parts.pop()
    return [tab.key, counts.get(own) > 1 && parts.length > 0 ? `${parts.at(-1)}/${own}` : own]
  }))
}

// What storage keeps of a subject's tabs: identity and mode, never text or addresses.
export const persistTabs = tabs => tabs.map(({ key, app, workspaceTag, displayPath, sessionId, mode }) => ({ key, app, workspaceTag, displayPath, sessionId, mode }))
export function restoreTabs(value) {
  if (!Array.isArray(value)) return []
  const tabs = []
  for (const item of value) {
    const descriptor = parseDescriptor({ v: 1, ...item, tab: item?.mode })
    if (descriptor === undefined) continue
    const tab = tabFromDescriptor(descriptor, typeof item.sessionId === 'string' ? item.sessionId : undefined)
    if (tab.sessionId === undefined || tabs.some(known => known.key === tab.key)) continue
    tabs.push(tab)
    if (tabs.length >= FILE_TABS_MAX) break
  }
  return tabs
}

// ---- the reader's selection message ----------------------------------------------

/** Where `quote` sits in `source`: 1-based lines when it matches exactly once, else null. */
export function lineRangeOf(source, quote) {
  const needle = String(quote ?? '').trim()
  if (needle === '' || typeof source !== 'string') return null
  const first = source.indexOf(needle)
  if (first < 0 || source.indexOf(needle, first + 1) >= 0) return null
  const startLine = source.slice(0, first).split('\n').length
  return [startLine, startLine + needle.split('\n').length - 1]
}

/**
 * The message a selection in the Reader leaves for the Bot. The path, section and
 * quoted text let the Bot find the passage again; lines appear only when the quote is
 * unique in the file, so nothing is guessed.
 */
export function revisionMessage({ displayPath, section, quote, source, request }) {
  const clean = String(quote ?? '').replace(/\r\n?/g, '\n').trim()
  const clipped = clean.length > REPORT_QUOTE_MAX ? `${clean.slice(0, REPORT_QUOTE_MAX)}…` : clean
  const range = lineRangeOf(source, clean)
  const where = [section ? `§${JSON.stringify(section)}` : '', range ? `(lines ${range[0]}-${range[1]})` : ''].filter(Boolean).join(' ')
  const head = `[Reader revision] ${displayPath}${where ? ` ${where}` : ''}`
  const quoted = clipped.split('\n').map(line => `> ${line}`).join('\n')
  const ask = String(request ?? '').trim()
  return `${head}\n${quoted}${ask ? `\n\n${ask}` : ''}`
}

// ---- text safety for the reader ----------------------------------------------------

// A fence line as CommonMark reads it: the run may be longer than three, and a line
// closes the block only when it is the same character, at least as long as the
// opening run, and carries nothing after the run but whitespace.
function fenceMark(line) {
  const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
  if (open === null) return null
  const bare = new RegExp(`^\\s{0,3}${open[1][0]}{${open[1].length},}\\s*$`).test(line)
  return { closes: fence => fence.ch === open[1][0] && open[1].length >= fence.len && bare, ch: open[1][0], len: open[1].length }
}

/**
 * Markdown text the reader may hand to the renderer: raw HTML tags are shown as text
 * and images become their labels, so reading a file never loads a page, a pixel
 * or a remote address. Fenced and inline code stay as written.
 */
export function readableMarkdown(text) {
  const lines = String(text ?? '').split('\n')
  let fence = null
  return lines.map((line) => {
    const mark = fenceMark(line)
    if (mark !== null) {
      if (fence === null) fence = mark
      else if (mark.closes(fence)) fence = null
      return line
    }
    if (fence !== null) return line
    return line.split(/(`+[^`]*`+)/).map((part, index) => {
      if (index % 2 === 1) return part
      return part
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt.trim() ? `[${t('Image')}: ${alt.trim()}]` : `[${t('Image')}]`))
        .replace(/!\[/g, '!\\[')
        .replace(/<(?=[/!a-zA-Z])/g, '&lt;')
    }).join('')
  }).join('\n')
}

// ---- images next to the article ----------------------------------------------------

// What an article may show: these types, from its own folder or one below it.
export const READER_IMAGE_TYPES = /\.(png|jpe?g|gif|webp|svg|avif)$/i
// Past this many pictures an article keeps the rest as their labels.
export const READER_IMAGES_MAX = 24

/** The workspace path of a relative image in the article's folder subtree, or null. */
export function siblingImagePath(displayPath, src) {
  const raw = String(src ?? '').trim().split('#', 1)[0].split('?', 1)[0]
  if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('\\') || raw.startsWith('//')) return null
  let decoded
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (decoded.includes('\\') || decoded.includes('\0') || !READER_IMAGE_TYPES.test(decoded)) return null
  const parts = String(displayPath).split('/')
  parts.pop()
  const segments = decoded.split('/').filter(part => part !== '' && part !== '.')
  if (segments.some(part => part === '..')) return null
  if (segments.length === 0) return null
  return parts.concat(segments).join('/')
}

/**
 * The article as parts in reading order: `text` runs the Markdown renderer draws, and
 * `image` entries for a picture that stands alone on its line and points into the
 * article's folder. Any other picture, and any past the cap, stays its label in the text.
 */
export function readerParts(text, displayPath) {
  const lines = String(text ?? '').split('\n')
  const parts = []
  let run = []
  let fence = null
  let images = 0
  const flush = () => { if (run.length > 0) parts.push({ kind: 'text', text: readableMarkdown(run.join('\n')) }); run = [] }
  for (const line of lines) {
    const mark = fenceMark(line)
    if (mark !== null) {
      if (fence === null) fence = mark
      else if (mark.closes(fence)) fence = null
      run.push(line)
      continue
    }
    const alone = fence === null ? /^\s{0,3}!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)\s*$/.exec(line) : null
    const path = alone && images < READER_IMAGES_MAX ? siblingImagePath(displayPath, alone[2]) : null
    if (path === null) { run.push(line); continue }
    flush()
    images += 1
    parts.push({ kind: 'image', path, alt: alone[1].trim() })
  }
  flush()
  return parts
}

/** A Reader link that stays inside the panel: a relative Markdown file next to this one. */
export function siblingPath(displayPath, href) {
  const raw = String(href ?? '').split('#', 1)[0].split('?', 1)[0]
  if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return null
  let decoded
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (decoded.includes('\\')) return null
  if (!/\.(md|markdown|mdx)$/i.test(decoded)) return null
  const parts = displayPath.split('/')
  parts.pop()
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { if (parts.length === 0) return null; parts.pop() } else parts.push(part)
  }
  return parts.length === 0 ? null : parts.join('/')
}
