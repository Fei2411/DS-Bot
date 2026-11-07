// The center's conversation sync: one Bot's current chat part as a revisioned snapshot
// that paired machines pull, and a user message they push back. The hub lives in the
// DSH plugin process, so this module is the single writer of the conversation: a node
// keeps a read replica and never runs a second team.
//
// A revision is a counter of this hub run. `epoch` names the run, so a node that kept a
// cursor from before a hub restart is told to take a full snapshot instead of waiting
// for a revision the new hub will never reach.
import { createHash, randomBytes } from 'node:crypto'

export const MAX_MESSAGE_CHARS = 32 * 1024
export const MAX_ITEMS = 200
export const MAX_SNAPSHOT_BYTES = 1.5 * 1024 * 1024
export const MAX_WAIT_MS = 25_000
export const DEFAULT_WAIT_MS = 20_000
const APPLIED_LIMIT = 500

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const notFound = message => fail(message, 404)

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// A snapshot is the tail of the current part, capped both by item count and by bytes so
// one long Bot post cannot turn every poll into a multi-megabyte transfer.
function capItems(all) {
  const kept = all.slice(-MAX_ITEMS)
  let bytes = 0
  let start = kept.length
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(kept[start - 1]))
    if (bytes + size > MAX_SNAPSHOT_BYTES) break
    bytes += size
    start -= 1
  }
  return { items: kept.slice(start), hidden: all.length - (kept.length - start) }
}

export function createSessionSync({ rt, now = Date.now, refreshMs = 1_000, maxItems = MAX_ITEMS } = {}) {
  if (rt === undefined || typeof rt.chatPage !== 'function' || typeof rt.sendUser !== 'function') {
    throw new Error('createSessionSync needs the plugin runtime')
  }
  const epoch = randomBytes(8).toString('hex')
  let revision = 0
  const entries = new Map()
  const waiters = new Map()
  const rendering = new Map()
  const applied = new Map()

  const ready = async () => {
    if (typeof rt.load === 'function') await rt.load()
  }

  function botNamed(reference) {
    const wanted = String(reference ?? '')
    if (wanted === '') throw fail('no Bot was named')
    const direct = rt.botOf(wanted)
    if (direct !== undefined) return direct
    const byName = Object.values(rt.state?.bots ?? {}).find(bot => bot.name === wanted)
    if (byName === undefined) throw notFound(`no Bot named ${wanted}`)
    return byName
  }

  async function bots() {
    await ready()
    const list = Object.values(rt.state?.bots ?? {}).map(bot => ({
      id: bot.id,
      name: bot.name,
      role: bot.role ?? null,
      main: (rt.state?.mainBotIds ?? []).includes(bot.id),
    }))
    return { epoch, revision, bots: list }
  }

  async function render(botId) {
    const bot = botNamed(botId)
    const page = await rt.chatPage(bot.id)
    const all = Array.isArray(page.items) ? page.items : []
    const capped = capItems(all.slice(-maxItems))
    return {
      key: digest({ sessionId: page.sessionId ?? null, items: capped.items }),
      botId: bot.id,
      botName: bot.name,
      sessionId: page.sessionId ?? null,
      items: capped.items,
      hidden: capped.hidden,
      cursor: page.cursor ?? null,
    }
  }

  function wake(botId) {
    const set = waiters.get(botId)
    if (set === undefined) return
    waiters.delete(botId)
    for (const done of set) done()
  }

  function publish(rendered) {
    const previous = entries.get(rendered.botId)
    if (previous !== undefined && previous.key === rendered.key) {
      previous.checkedAt = now()
      return previous
    }
    // One counter for every Bot: a node's cursor only has to order this hub's answers.
    revision += 1
    const entry = {
      ...rendered,
      revision,
      updatedAt: new Date(now()).toISOString(),
      checkedAt: now(),
    }
    entries.set(rendered.botId, entry)
    wake(rendered.botId)
    return entry
  }

  // A burst of polls must not render the same Bot twice and bump the revision twice.
  function refresh(botId) {
    const pending = rendering.get(botId)
    if (pending !== undefined) return pending
    const run = ready()
      .then(() => render(botId))
      .then(publish)
      .finally(() => rendering.delete(botId))
    rendering.set(botId, run)
    return run
  }

  function viewOf(entry) {
    return {
      epoch,
      revision: entry.revision,
      botId: entry.botId,
      botName: entry.botName,
      sessionId: entry.sessionId,
      items: entry.items,
      hidden: entry.hidden,
      cursor: entry.cursor,
      updatedAt: entry.updatedAt,
    }
  }

  function waitForChange(botId, timeoutMs) {
    return new Promise(resolve => {
      const set = waiters.get(botId) ?? new Set()
      waiters.set(botId, set)
      const done = () => {
        clearTimeout(timer)
        set.delete(done)
        if (set.size === 0 && waiters.get(botId) === set) waiters.delete(botId)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      timer.unref?.()
      set.add(done)
    })
  }

  // `since` is the revision a node already holds. It is answered at once when it is
  // behind or ahead; when it is current the call waits for a change, which is what makes
  // a paired screen show a message within about a second rather than on a blind timer.
  async function snapshot(reference, { since, epoch: fromEpoch, waitMs } = {}) {
    await ready()
    const bot = botNamed(reference)
    let entry = await refresh(bot.id)
    const wanted = Math.min(Math.max(Number.isInteger(waitMs) ? waitMs : 0, 0), MAX_WAIT_MS)
    const reset = typeof fromEpoch === 'string' && fromEpoch !== '' && fromEpoch !== epoch
    const current = Number.isInteger(since) ? since : undefined
    const upToDate = current !== undefined && current === entry.revision
    if (reset || wanted === 0 || current === undefined || !upToDate) {
      return { ...viewOf(entry), reset, unchanged: !reset && upToDate }
    }
    const started = now()
    while (!reset && now() - started < wanted) {
      const left = wanted - (now() - started)
      await waitForChange(bot.id, Math.min(left, refreshMs))
      entry = await refresh(bot.id)
      if (entry.revision !== current) return { ...viewOf(entry), reset: false, unchanged: false }
    }
    return { ...viewOf(entry), reset: false, unchanged: true }
  }

  // A node's message is applied through the same path as the browser's composer, so the
  // Bot, the group log and the search index see one ordinary user message. `messageId`
  // makes a retry on a flaky link land once.
  async function send({ botId, text, messageId } = {}) {
    await ready()
    const bot = botNamed(botId)
    const value = typeof text === 'string' ? text.trim() : ''
    if (value === '') throw fail('the message is empty')
    if (value.length > MAX_MESSAGE_CHARS) throw fail(`the message is longer than ${MAX_MESSAGE_CHARS} characters`)
    const id = typeof messageId === 'string' && messageId.trim() !== '' ? messageId.trim().slice(0, 80) : undefined
    const seen = id === undefined ? undefined : applied.get(id)
    if (seen !== undefined) {
      return { ok: true, duplicate: true, botId: bot.id, epoch, revision: entries.get(bot.id)?.revision ?? revision, messageId: id, acceptedAt: seen }
    }
    if (typeof rt.readOnly === 'function' && rt.readOnly() !== undefined) {
      throw fail('this computer is only reading the Bot team, so it cannot add a message', 409)
    }
    await rt.sendUser({ sessionId: bot.id, content: [{ type: 'text', text: value }] })
    const acceptedAt = new Date(now()).toISOString()
    if (id !== undefined) {
      applied.set(id, acceptedAt)
      while (applied.size > APPLIED_LIMIT) applied.delete(applied.keys().next().value)
    }
    const entry = await refresh(bot.id).catch(() => undefined)
    return { ok: true, botId: bot.id, epoch, revision: entry?.revision ?? revision, messageId: id, acceptedAt }
  }

  return {
    epoch,
    get revision() {
      return revision
    },
    bots,
    snapshot,
    send,
    // The Devices page and tests read this without touching a node.
    status: () => ({
      epoch,
      revision,
      synced: entries.size,
      waiting: [...waiters.values()].reduce((total, set) => total + set.size, 0),
    }),
  }
}
