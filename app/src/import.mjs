// The first-run import: a copy of the Bot team in the user's own DSH home. It only reads there.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { parse, stringify } from 'yaml'
import { copyTree, within } from './copy-tree.mjs'

export { within }

// The rows of a profile patch that hold model settings: DeepSeek's API and account, other
// providers, the default model and the agent presets. Rows of other plugins may name plugins
// that the app does not have.
export const MODEL_ROWS = ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'agent-default-model', 'agent-preset-registry']
// The team's lock, its turns in flight and its workspace belong to the old home.
const LEFT_BEHIND = new Set(['state.lock', 'inflight.json', 'workspace'])
const LOCK_STALE_MS = 60_000
// Folders that a project makes again from its own files (windows-onboarding §4): the import card
// offers to leave them out of the work files, and does so by default from 200 MB on.
export const REGENERABLE = new Set(['node_modules', '.venv', '__pycache__', '.pnpm-store', '.next'])
export const REGENERABLE_DEFAULT_BYTES = 200e6

/** The DSH home of the user's own DSH, read as DSH reads DSH_HOME. */
export function userDshHome(env = process.env) {
  const value = env.DSH_HOME?.trim()
  if (!value) return join(homedir(), '.dsh')
  return resolve(value === '~' ? homedir() : /^~[\\/]/u.test(value) ? join(homedir(), value.slice(2)) : value)
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** Every Session the team names: each Bot's and group's parts, the group conversations and each group's own Session. */
export function sessionIdsOf(team) {
  const ids = segments => segments.map(part => part?.sessionId)
  return [...new Set([
    ...Object.values(team.bots ?? {}).flatMap(bot => [bot.id, bot.sessionId, ...ids(bot.segments ?? [])]),
    // A group keeps the earlier parts per member: { [botId]: segments }. The group's own
    // Session, the one it relays in, has the group's id.
    ...Object.values(team.rooms ?? {}).flatMap(room => [room.id, ...Object.values(room.sessions ?? {}), ...ids(Object.values(room.segments ?? {}).flat())]),
  ].filter(id => typeof id === 'string' && id !== ''))]
}

/**
 * The team in a DSH home, with the profiles that hold model settings.
 * @returns {{ from: string, team: any, bots: number, rooms: number, profiles: { name: string, rows: any[] }[] } | undefined}
 */
export function findTeam(from) {
  const statePath = join(from, 'bot', 'state.json')
  if (!existsSync(statePath)) return undefined
  const team = readJson(statePath)
  const bots = Object.keys(team.bots ?? {}).length
  if (bots === 0) return undefined
  return { from, team, bots, rooms: Object.keys(team.rooms ?? {}).length, profiles: modelProfiles(from) }
}

function modelProfiles(from) {
  const dir = join(from, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap((entry) => {
    const file = join(dir, entry.name, 'cordis.patch.yml')
    if (!existsSync(file)) return []
    let patch
    try {
      patch = parse(readFileSync(file, 'utf8'))
    } catch (error) {
      // An unreadable profile has no model settings to copy; the team is still there.
      console.warn(`DS Bot: skipped the model settings in ${file}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    const rows = Array.isArray(patch) ? patch.filter(row => MODEL_ROWS.includes(row?.id)) : []
    return rows.length > 0 ? [{ name: entry.name, rows }] : []
  })
}

/**
 * Whether a running DSH holds the team, by the rule of ds-bot's own lock (src/host/home-lock.js):
 * the holder bumps the lock's mtime, so a stale lock is a holder that is gone, even when its pid
 * now belongs to another process.
 */
export function teamInUse(from, { host = hostname(), now = Date.now(), isAlive = pidAlive } = {}) {
  const path = join(from, 'bot', 'state.lock')
  const lock = statSync(path, { throwIfNoEntry: false })
  if (lock === undefined || now - lock.mtimeMs >= LOCK_STALE_MS) return false
  let holder
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Being written right now.
    return true
  }
  return holder?.host !== host || isAlive(holder.pid)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

// sessions/<group>/<id>/: the group is the folder the Session works in.
function sessionDirs(from, ids) {
  const root = join(from, 'sessions')
  const groups = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : []
  const found = []
  const missing = []
  for (const id of ids) {
    const group = groups.find(name => existsSync(join(root, name, id)))
    if (group === undefined) missing.push(id)
    else found.push({ id, group })
  }
  return { found, missing }
}

// fs.cp that tells `seen` the size of each file it is about to copy.
function cpSeen(source, target, { filter = () => true, seen, ...options }) {
  return cp(source, target, {
    ...options,
    filter: async (path) => {
      if (!await filter(path)) return false
      if (seen !== undefined) {
        const info = await lstat(path).catch(() => undefined)
        if (info?.isFile()) seen(info.size)
      }
      return true
    },
  })
}

async function copySessionDirs(from, to, sessions, signal, seen, each = () => {}) {
  for (const [index, { id, group }] of sessions.entries()) {
    signal?.throwIfAborted()
    await cpSeen(join(from, 'sessions', group, id), join(to, 'sessions', group, id), { recursive: true, seen })
    each(index + 1, sessions.length)
  }
}

async function moveSessionDirs(stage, to, sessions, signal) {
  for (const { id, group } of sessions) {
    signal?.throwIfAborted()
    await mkdir(join(to, 'sessions', group), { recursive: true })
    // A copy that stopped can have moved the Session in already.
    await rm(join(to, 'sessions', group, id), { recursive: true, force: true })
    await rename(join(stage, 'sessions', group, id), join(to, 'sessions', group, id))
  }
}

/**
 * Copy the team's Sessions into the DSH home `to`, as they lie in `from`; an abort stops it between Sessions.
 * @param {string} from @param {any} team @param {string} to @param {AbortSignal} [signal]
 * @param {(done: number, total: number) => void} [onProgress] after each Session
 * @returns {Promise<string[]>} their ids
 */
export async function copySessions(from, team, to, signal, onProgress) {
  const { found } = sessionDirs(from, sessionIdsOf(team))
  await copySessionDirs(from, to, found, signal, undefined, onProgress)
  return found.map(({ id }) => id)
}

// Thrown when measuring runs out of time.
const OVER = Symbol('over budget')

// The bytes under `path` into `tally`, links counted as themselves and what cannot be read as
// nothing; `tally.regen` takes the bytes inside the folders that REGENERABLE names.
async function measure(path, clock, tally, regen = false) {
  if (clock.now() > clock.until) throw OVER
  const entry = await lstat(path).catch(() => undefined)
  if (entry === undefined) return
  if (!entry.isDirectory()) {
    tally.bytes += entry.size
    if (regen) tally.regen += entry.size
    return
  }
  for (const name of await readdir(path).catch(() => [])) await measure(join(path, name), clock, tally, regen || REGENERABLE.has(name))
}

/**
 * What the import card says about the team (windows-onboarding §4): how many of its Sessions are
 * there, the bytes of its chats (the team's own files but its workspace, its Sessions and the
 * attachments), of its work files (the team workspace) and of the regenerable folders among
 * them. The sizes are left out when measuring takes longer than `budget` ms: a team workspace can
 * hold many a node_modules.
 * @returns {Promise<{ sessions: number, chats?: number, work?: number, regen?: number }>}
 */
export async function teamSizes(from, team, { budget = 2000, now = Date.now } = {}) {
  const { found } = sessionDirs(from, sessionIdsOf(team))
  const clock = { until: now() + budget, now }
  const chats = { bytes: 0, regen: 0 }
  const work = { bytes: 0, regen: 0 }
  try {
    const bot = join(from, 'bot')
    for (const name of await readdir(bot).catch(() => [])) {
      if (!LEFT_BEHIND.has(name)) await measure(join(bot, name), clock, chats)
    }
    for (const { id, group } of found) await measure(join(from, 'sessions', group, id), clock, chats)
    await measure(join(from, 'attachments'), clock, chats)
    await measure(join(bot, 'workspace'), clock, work)
  } catch (error) {
    if (error === OVER) return { sessions: found.length }
    throw error
  }
  return { sessions: found.length, chats: chats.bytes, work: work.bytes, regen: work.regen }
}

const logVersion = name => parseSessionFormatLogFilename(name.replace(/\.(zstd|zst|gz|br)$/u, ''))
const isNewer = (from, { id, group }) => readdirSync(join(from, 'sessions', group, id))
  .some(name => (logVersion(name) ?? 0) > sessionFormatCatalog.currentVersion)

/** The Sessions whose log is in a newer format than the pinned DSH reads. */
export function newerSessions(from, team) {
  const { found } = sessionDirs(from, sessionIdsOf(team))
  return found.filter(session => isNewer(from, session)).map(({ id }) => id)
}

/**
 * Copy into the data location `to` the Sessions its team names that are not there, from the DSH
 * home the team was imported from. Imports before 0.2.3 left out each group's own Session, and
 * such a group does not open (#551). Each Session is put together beside the data and moved in
 * whole; one this DSH cannot read stays where it is. Nothing in the old home changes.
 * @param {string} to @param {AbortSignal} [signal]
 * @returns {Promise<{ copied: string[], newer: string[] }>} the ids copied, and those left for their newer format
 */
export async function restoreSessions(to, signal) {
  const record = join(to, 'bot', 'imported.json')
  const statePath = join(to, 'bot', 'state.json')
  const none = { copied: [], newer: [] }
  if (!existsSync(record) || !existsSync(statePath)) return none
  const { from } = readJson(record)
  if (typeof from !== 'string' || resolve(from) === resolve(to)) return none
  for (const name of readdirSync(to).filter(entry => /^\.restore-\d+$/u.test(entry))) {
    await rm(join(to, name), { recursive: true, force: true })
  }
  const { missing } = sessionDirs(to, sessionIdsOf(readJson(statePath)))
  const { found } = sessionDirs(from, missing)
  const newer = found.filter(session => isNewer(from, session))
  const sessions = found.filter(session => !newer.includes(session))
  if (sessions.length > 0) {
    const stage = join(to, `.restore-${String(Date.now())}`)
    await copySessionDirs(from, stage, sessions, signal)
    await moveSessionDirs(stage, to, sessions, signal)
    await rm(stage, { recursive: true, force: true })
  }
  return { copied: sessions.map(({ id }) => id), newer: newer.map(({ id }) => id) }
}

// The Host's first start on the data location writes a .credentials.yaml of its own: the browser
// session grant of the connection plugin, under client-connection/. A file with nothing else in
// it holds no key of the user's.
async function onlyHostRecords(file) {
  let document
  try {
    document = parse(await readFile(file, 'utf8')) ?? {}
  } catch {
    // A file that does not read as DSH's is the user's to fix, not ours to replace.
    return false
  }
  if (typeof document !== 'object' || Array.isArray(document)) return false
  const { version, refs, records, ...other } = document
  return (version === undefined || version === 1) && Object.keys(other).length === 0
    && Object.keys(refs ?? {}).length === 0
    && Object.keys(records ?? {}).every(key => key.startsWith('client-connection/'))
}

// A key file the data location has already is the user's own, saved there since, and stays;
// a .credentials.yaml that only the Host wrote is not.
// Returns 'copied', 'kept', or undefined when the old home has none.
async function copyKey(from, to, name) {
  const source = join(from, name)
  if (!existsSync(source)) return undefined
  const target = join(to, name)
  const replace = name === '.credentials.yaml' && existsSync(target) && await onlyHostRecords(target)
  try {
    await cp(source, target, { force: replace, errorOnExist: !replace })
  } catch (error) {
    if (error?.code === 'ERR_FS_CP_EEXIST') return 'kept'
    throw error
  }
  if (process.platform !== 'win32') await chmod(target, 0o600)
  return 'copied'
}

async function writeModelRows(to, rows) {
  const file = join(to, 'profiles', 'ds-bot', 'cordis.patch.yml')
  const current = existsSync(file) ? parse(await readFile(file, 'utf8')) : undefined
  const ids = new Set(rows.map(row => row.id))
  const kept = Array.isArray(current) ? current.filter(row => !ids.has(row?.id)) : []
  await mkdir(join(to, 'profiles', 'ds-bot'), { recursive: true })
  await writeFile(file, stringify([...kept, ...rows]))
}

/**
 * Copy the team of `from` into the data location `to`, which the Host has started on once,
 * so that DSH does not take the copied Sessions' folders for its own projects. The old team's
 * workspace files go into `workspace`, without replacing a file that is there, and the key
 * files only where the data location has none of the user's own. `leaveRegenerable` leaves the
 * REGENERABLE folders out of the workspace files, `skipWork` all of them; `onProgress` hears the
 * bytes copied so far as each file is about to be copied.
 * Everything but the keys, the model settings and the workspace files is put together in a
 * folder beside the data and moved in at the end. A copy that stops or fails removes that
 * folder; one that was killed leaves it behind, and the next copy removes it.
 * @param {{ from: string, to: string, workspace: string, profile?: string, dsh?: string, signal?: AbortSignal,
 *   leaveRegenerable?: boolean, skipWork?: boolean, onProgress?: (bytes: number) => void }} options
 */
export async function importTeam({ from, to, workspace, profile, dsh, signal, leaveRegenerable = false, skipWork = false, onProgress }) {
  const found = findTeam(from)
  if (found === undefined) throw new Error(`There is no Bot team in ${from}`)
  const present = existsSync(join(to, 'bot', 'state.json')) ? readJson(join(to, 'bot', 'state.json')) : undefined
  if (Object.keys(present?.bots ?? {}).length > 0) throw new Error(`${to} already has a Bot team`)
  for (const name of (existsSync(to) ? readdirSync(to) : []).filter(entry => /^\.import-\d+$/u.test(entry))) {
    await rm(join(to, name), { recursive: true, force: true })
  }
  const stage = join(to, `.import-${String(Date.now())}`)
  try {
    let bytes = 0
    const seen = (size) => { bytes += size; onProgress?.(bytes) }
    return await copyThroughStage({ found, from, to, workspace, profile, dsh, signal, stage, leaveRegenerable, skipWork, seen })
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  }
}

async function copyThroughStage({ found, from, to, workspace, profile, dsh, signal, stage, leaveRegenerable, skipWork, seen }) {
  const oldBot = join(from, 'bot')
  signal?.throwIfAborted()
  await cpSeen(oldBot, join(stage, 'bot'), { recursive: true, seen, filter: path => !LEFT_BEHIND.has(relative(oldBot, path).split(/[\\/]/u)[0]) })
  const team = readJson(join(stage, 'bot', 'state.json'))
  // The new data location registers its own team workspace. A DSH Agent's Sessions do not move
  // to a fresh part, so they would go on working in the old team folder in the user's DSH home.
  delete team.workspaceId
  team.agents = {}
  await writeFile(join(stage, 'bot', 'state.json'), JSON.stringify(team, null, 2))
  const { found: sessions, missing } = sessionDirs(from, sessionIdsOf(found.team))
  signal?.throwIfAborted()
  await copySessionDirs(from, stage, sessions, signal, seen)
  signal?.throwIfAborted()
  if (existsSync(join(from, 'attachments'))) await cpSeen(join(from, 'attachments'), join(stage, 'attachments'), { recursive: true, seen })

  signal?.throwIfAborted()
  await mkdir(workspace, { recursive: true })
  if (!skipWork && existsSync(join(oldBot, 'workspace'))) {
    const leave = leaveRegenerable ? path => path.split(/[\\/]/u).some(name => REGENERABLE.has(name)) : undefined
    // Bots that ran npm or pnpm there leave links, some of them to nothing.
    const skipped = await copyTree(join(oldBot, 'workspace'), workspace, { force: false, skip: true, signal, leave, seen })
    if (skipped.length > 0) console.warn('DS Bot: the import skipped what it could not read in the old team workspace:', skipped)
  }
  signal?.throwIfAborted()
  const keys = []
  const keptKeys = []
  for (const name of ['.credentials.yaml', '.env']) {
    const done = await copyKey(from, to, name)
    if (done === 'copied') keys.push(name)
    if (done === 'kept') keptKeys.push(name)
  }
  if (keptKeys.length > 0) console.warn(`DS Bot: the import kept the ${keptKeys.join(' and ')} that the data location has`)
  const rows = found.profiles.find(entry => entry.name === profile)?.rows ?? []
  if (rows.length > 0) await writeModelRows(to, rows)

  await moveSessionDirs(stage, to, sessions, signal)
  signal?.throwIfAborted()
  if (existsSync(join(stage, 'attachments'))) await cp(join(stage, 'attachments'), join(to, 'attachments'), { recursive: true, force: false })
  const summary = {
    from, at: new Date().toISOString(), ...(dsh ? { dsh } : {}),
    bots: found.bots, rooms: found.rooms, sessions: sessions.length, missingSessions: missing,
    keys, keptKeys, modelSettings: rows.length > 0 ? profile : null,
    ...(skipWork ? { workFiles: 'skipped' } : leaveRegenerable ? { workFiles: 'regenerable left out' } : {}),
  }
  signal?.throwIfAborted()
  await writeFile(join(stage, 'bot', 'imported.json'), `${JSON.stringify(summary, null, 2)}\n`)
  // Until this rename the data has no Bot team, so a copy that stopped can run again.
  await rm(join(to, 'bot'), { recursive: true, force: true })
  await rename(join(stage, 'bot'), join(to, 'bot'))
  return summary
}
