// The memory tidy. Once a day at most, for each memory that changed, a model reads all
// its entries and merges repeats, settles what contradicts, and moves details to topics.
// A merge loses words, so nothing is deleted: what leaves goes to retired.jsonl beside
// the entries, what a pass did is one batch the user can undo, a pinned entry is never
// offered, and one pass changes at most a fifth of the entries.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { HEADING, MAIN, MEMORY_LIMITS, addLink, cleanEntry, cleanTopic, entryId, formatEntry, insertEntry, isExpired, isPinned, joinLines, parseMemory, removeLink } from './memory-entries.js'
import { tidyRequest, tidySystem } from './memory-copy.js'
import { inlineUntrusted } from '../shared/quoted-text-fence.js'

const EVERY_MS = 30 * 60_000
// Below this there is nothing a tidy would be worth a model call for.
const ENTRIES_MIN = 8
const SHARE_MAX = 5
const RETIRED = 'retired.jsonl'
const NOTE_MAX = 120
const ITEMS_SHOWN = 20
// Bounded per-pass entry budget so large multi-topic memories never overflow context or pending.json.
const TIDY_CHARS_MIN = 4_000
const TIDY_CHARS_DEFAULT = 24_000
const TIDY_CHARS_MAX = 32_000
const PINNED_CONTEXT_MAX = 4_000
// Per-scope backoff schedule so one failing scope never starves the rest of the team.
const FAILURE_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 12 * 60 * 60_000]

const sha256 = data => createHash('sha256').update(data).digest('hex')
const isEmptyTopicLines = lines => lines.every(line => line.trim() === '' || HEADING.test(line) || /^>\s/.test(line))

function fileSizeOf(path) {
  try {
    return statSync(path, { throwIfNoEntry: false })?.size ?? 0
  } catch {
    return 0
  }
}

// Reads bytes [offset, size] from `path`. Returns undefined if the file shrank below `offset`
// or is missing when `offset > 0`.
function readTailBytes(path, offset) {
  let fd
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') return offset === 0 ? Buffer.alloc(0) : undefined
    throw error
  }
  try {
    const size = fstatSync(fd).size
    if (size < offset) return undefined
    const length = size - offset
    const buf = Buffer.alloc(length)
    let at = 0
    while (at < length) {
      const read = readSync(fd, buf, at, length - at, offset + at)
      if (read === 0) break
      at += read
    }
    return buf.subarray(0, at)
  } finally {
    closeSync(fd)
  }
}

// Prioritizes MEMORY.md first, then largest topics whole so duplicates and contradictions
// within the same topic stay visible together inside the pass budget.
function selectTidyEntries(open, budget) {
  const main = []
  const byTopic = new Map()
  for (const entry of open) {
    const topic = entry.file.topic
    if (topic === undefined) main.push(entry)
    else {
      let bucket = byTopic.get(topic)
      if (bucket === undefined) {
        bucket = []
        byTopic.set(topic, bucket)
      }
      bucket.push(entry)
    }
  }
  const orderedTopics = [...byTopic.values()].sort((a, b) => b.length - a.length)
  const ordered = [...main, ...orderedTopics.flat()]
  const selected = []
  let used = 0
  for (const entry of ordered) {
    const cost = entry.text.length
    if (selected.length > 0 && used + cost > budget) continue
    selected.push(entry)
    used += cost
  }
  return { selected, omitted: open.length - selected.length }
}

function selectPinnedContext(pinned, budget = PINNED_CONTEXT_MAX) {
  const main = pinned.filter(entry => entry.file.topic === undefined)
  const topics = pinned.filter(entry => entry.file.topic !== undefined)
  const kept = []
  let used = 0
  for (const entry of [...main, ...topics]) {
    if (used + entry.text.length > budget) continue
    kept.push(entry)
    used += entry.text.length
  }
  return kept
}

function roomInDraftTopic(draft, scope, topic, lineLength) {
  let topicCount = 0
  for (const [file, lines] of draft) {
    if (file !== MAIN && !isEmptyTopicLines(lines)) topicCount += 1
  }
  for (let at = 1; ; at += 1) {
    const name = at === 1 ? topic : `${topic}-${at}`
    const file = `${name}.md`
    const lines = draft.get(file)
    if (lines !== undefined && !isEmptyTopicLines(lines)) {
      if (joinLines(lines).length + lineLength + 1 <= MEMORY_LIMITS.topic) return name
      continue
    }
    if (scope.kind !== 'team' && topicCount >= MEMORY_LIMITS.topics) return undefined
    return name
  }
}

function parseTidy(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(value?.changes) ? value.changes : undefined
  } catch {
    return undefined
  }
}

export function installTidy(rt, memory) {
  const { ctx, config, state } = rt
  const { TEAM, ownScope, groupScope, keeperOf, scopeKey, dirOf, today, queued, recoverPending, writable, settled, loadScope, searchEntries, publish, writeStep, removeStep, appendStep, truncateStep, writeText, botShot, languageNow, allEntries, entryProblem, changedSince, noteWindow, windowUsable, USER, readdGuarded } = memory
  // All of it sits in the memory's own folder: a private Bot's words stay in its own,
  // and an archive of a deleted Bot or group takes them along.
  const statePath = scope => join(dirOf(scope), 'tidied.json')
  const tidyDir = scope => join(dirOf(scope), 'tidy')
  const batchPath = (scope, batch) => join(tidyDir(scope), `${batch}.json`)
  const doneOf = (scope) => {
    try {
      return JSON.parse(readFileSync(statePath(scope), 'utf8'))
    } catch {
      return undefined
    }
  }
  const staleBatchFiles = (scope, keepBatch) => {
    const dir = tidyDir(scope)
    try {
      return readdirSync(dir)
        .filter(name => name.endsWith('.json') && name !== `${keepBatch}.json`)
        .map(name => join(dir, name))
    } catch {
      return []
    }
  }

  // Every memory with someone to read it for: a team tidy offers only its topics, since
  // what every Bot always reads is the user's to change.
  function jobs() {
    const bots = Object.values(state.bots).map(bot => ({ scope: ownScope(bot.id), keeper: bot, who: `one Bot, ${inlineUntrusted(bot.name)}` }))
    const rooms = Object.values(state.rooms).flatMap((room) => {
      const keeper = keeperOf(room)
      return keeper === undefined ? [] : [{ scope: groupScope(room.id), keeper, who: `one group chat, "${inlineUntrusted(room.name)}"` }]
    })
    const main = Object.values(state.bots).find(bot => rt.isMain(bot.id))
    return [...bots, ...rooms, ...(main === undefined ? [] : [{ scope: TEAM, keeper: main, who: 'the notes a team of Bots shares' }])]
  }
  const scopeEntries = (job, files) => allEntries(job.scope.kind === 'team' ? files.slice(1) : files)
  const offeredOf = (job, files) => scopeEntries(job, files).filter(entry => !isPinned(entry))
  const pinnedOf = (job, files, day) => scopeEntries(job, files).filter(entry => isPinned(entry) && !isExpired(entry, day))
  const tidyBudget = (keeper) => {
    const usable = windowUsable?.(keeper)
    if (usable === undefined) return TIDY_CHARS_DEFAULT
    return Math.min(TIDY_CHARS_MAX, Math.max(TIDY_CHARS_MIN, Math.floor(usable * 0.25)))
  }

  async function tidy(job, { expiredOnly = false } = {}) {
    const key = scopeKey(job.scope)
    const prior = doneOf(job.scope)
    const day = today()
    if (!expiredOnly) await noteWindow?.(job.keeper)?.catch?.(() => {})
    const files = await settled(() => loadScope(job.scope))
    const offered = offeredOf(job, files)
    const pinned = pinnedOf(job, files, day)
    const ended = offered.filter(entry => isExpired(entry, day))
    const open = offered.filter(entry => !isExpired(entry, day))
    const { selected, omitted } = selectTidyEntries(open, tidyBudget(job.keeper))
    let changes = []
    if (!expiredOnly && selected.length >= ENTRIES_MIN) {
      const max = Math.max(1, Math.floor((selected.length + ended.length) / SHARE_MAX))
      const reply = await botShot(job.keeper, tidySystem({ who: job.who, max }), tidyRequest({ entries: selected, pinned: selectPinnedContext(pinned), omitted, language: languageNow() }), { sessionId: job.scope.kind === 'bot' ? rt.chatOf(job.keeper.id) : job.scope.kind === 'group' ? job.scope.roomId : rt.chatOf(job.keeper.id), kind: 'memory' })
      const parsed = parseTidy(reply)
      if (parsed === undefined) rt.warn('ds-bot: the memory tidy of %s got no list of changes from the model', key)
      else changes = parsed
    }
    await queued(async () => {
      await recoverPending()
      if (rt.botOf(job.keeper.id) === undefined) return
      writable(job.scope, USER)
      await applyTidy(job, key, day, changes, selected, ended, prior)
    })
  }

  async function applyTidy(job, key, day, changes, numbered, ended, prior) {
    const files = loadScope(job.scope)
    const offered = offeredOf(job, files)
    const byId = new Map(offered.map(entry => [entryId(entry), entry]))
    const draft = new Map(files.map(file => [file.file, [...file.lines]]))
    const main = files[0]
    const budget = { left: Math.max(1, Math.floor(Math.min(offered.length, numbered.length + ended.length) / SHARE_MAX)) }
    const retired = []
    const items = []
    const counts = { merged: 0, moved: 0, retired: 0 }
    const batch = randomUUID()
    const time = new Date().toISOString()
    const take = (entry) => { draft.set(entry.file.file, draft.get(entry.file.file).filter(line => line !== entry.file.lines[entry.line])) }
    const retire = (entry, why, extra = {}) => retired.push({ batch, time, file: entry.file.file, line: entry.file.lines[entry.line], why, ...extra })
    const unchanged = (expected) => {
      if (expected === undefined) return undefined
      const current = byId.get(entryId(expected))
      if (current?.file.file === expected.file.file && current.file.lines[current.line] === expected.file.lines[expected.line]) return current
      return undefined
    }
    const pick = at => unchanged(numbered[Number(at) - 1])
    const used = new Set()

    for (const expected of ended) {
      const entry = unchanged(expected)
      if (entry === undefined) continue
      take(entry)
      retire(entry, 'ended')
      used.add(entry)
      counts.retired += 1
      items.push({ op: 'retired', text: entry.text })
    }

    for (const change of changes) {
      const op = String(change?.op ?? '')
      if (op === 'about') {
        const name = cleanTopic(change.topic)
        const lines = draft.get(`${name}.md`)
        const text = cleanEntry(change.text).slice(0, NOTE_MAX)
        if (name === undefined || lines === undefined || text === '' || entryProblem(text) !== undefined) continue
        const kept = lines.filter(line => !/^>\s*\S/.test(line))
        const title = kept.findIndex(line => HEADING.test(line))
        while (title !== -1 && kept[title + 1] === '' && kept[title + 2] === '') kept.splice(title + 1, 1)
        kept.splice(title + 1, 0, ...(kept[title + 1] === '' ? [] : ['']), `> ${text}`)
        draft.set(`${name}.md`, kept)
        continue
      }
      if (op === 'merge') {
        const entries = [...new Set((Array.isArray(change.entries) ? change.entries : []).map(pick))]
        if (entries.some(entry => entry === undefined || used.has(entry))) continue
        const text = cleanEntry(change.text)
        // A merge writes new text too: it may not silently re-add what memory
        // dropped within the guard window, or a removed entry would come back
        // laundered through the tidy itself.
        if (entries.length < 2 || entries.length > budget.left || entryProblem(text) !== undefined) continue
        if (readdGuarded?.(job.scope, text, { liveInputs: entries.map(entry => ({ id: entryId(entry), text: entry.text })) }) !== undefined) continue
        budget.left -= entries.length
        const [first, ...rest] = entries
        const line = formatEntry(text, { ...first.meta, id: entryId(first), merged: entries.map(entryId).join(' ') })
        draft.set(first.file.file, draft.get(first.file.file).map(item => (item === first.file.lines[first.line] ? line : item)))
        rest.forEach(take)
        entries.forEach(entry => { retire(entry, 'merged', { into: entryId(first) }); used.add(entry) })
        counts.merged += entries.length
        items.push({ op: 'merged', text })
        continue
      }
      const entry = pick(change?.entry)
      if (entry === undefined || used.has(entry) || budget.left < 1) continue
      if (op === 'retire') {
        budget.left -= 1
        take(entry)
        retire(entry, String(change.why ?? '').slice(0, NOTE_MAX) || 'retired')
        used.add(entry)
        counts.retired += 1
        items.push({ op: 'retired', text: entry.text })
      } else if (op === 'move' && entry.file.topic === undefined) {
        const raw = cleanTopic(change.topic)
        if (raw === undefined) continue
        const line = entry.file.lines[entry.line]
        const name = roomInDraftTopic(draft, job.scope, raw, line.length)
        if (name === undefined) continue
        budget.left -= 1
        take(entry)
        const base = draft.get(`${name}.md`) ?? parseMemory(`# ${name}\n`).lines
        draft.set(`${name}.md`, insertEntry(base, line))
        if (!parseMemory(joinLines(draft.get(MAIN))).links.includes(name)) draft.set(MAIN, addLink(draft.get(MAIN), name))
        used.add(entry)
        counts.moved += 1
        items.push({ op: 'moved', text: entry.text, topic: name })
      }
    }

    const dir = dirOf(job.scope)
    const touched = []
    const steps = []
    const before = new Map(files.map(file => [file.file, file.content]))
    for (const [file, lines] of draft) {
      const emptied = file !== MAIN && isEmptyTopicLines(lines)
      const was = before.get(file) ?? null
      const now = emptied ? null : lines.length === 0 ? '' : joinLines(lines)
      if (was === now || (was === '' && lines.length === 0)) continue
      touched.push({ file, before: was, after: now })
    }
    for (const item of touched.filter(entry => entry.after === null)) {
      const name = item.file.slice(0, -3)
      const lines = removeLink(draft.get(MAIN), name)
      draft.set(MAIN, lines)
    }
    const mainNow = joinLines(draft.get(MAIN))
    const mainItem = touched.find(item => item.file === MAIN)
    if (mainItem !== undefined) mainItem.after = mainNow
    else if (main.content !== mainNow && main.lines.length > 0) touched.push({ file: MAIN, before: main.content, after: mainNow })
    const record = { time, day, ...(prior?.batch === undefined ? {} : { previous: prior.batch }) }
    const stamp = { ...record, ...counts, ...(touched.length === 0 ? {} : { batch, items: items.slice(0, ITEMS_SHOWN) }) }
    if (touched.length === 0) {
      if (rt.readOnly() === undefined) {
        await writeText(statePath(job.scope), JSON.stringify(stamp))
        for (const oldPath of staleBatchFiles(job.scope, '')) await unlink(oldPath).catch(() => {})
      }
      return
    }
    for (const item of touched) steps.push(item.after === null ? removeStep(join(dir, item.file)) : writeStep(join(dir, item.file), item.after))
    const retiredPath = join(dir, RETIRED)
    const retiredOffset = fileSizeOf(retiredPath)
    const retiredDelta = retired.length > 0 ? `${retired.map(row => JSON.stringify(row)).join('\n')}\n` : ''
    const retiredHash = retired.length > 0 ? sha256(retiredDelta) : ''
    if (retired.length > 0) steps.push(appendStep(retiredPath, retiredDelta, retiredOffset))
    steps.push(writeStep(batchPath(job.scope, batch), JSON.stringify({ batch, scope: key, files: touched, retiredOffset, retiredLines: retired.length, retiredHash })))
    for (const oldPath of staleBatchFiles(job.scope, batch)) steps.push(removeStep(oldPath))
    steps.push(writeStep(statePath(job.scope), JSON.stringify(stamp)))
    await publish({ op: 'tidy', scope: key, steps, row: { op: 'tidy', scope: key, batch, ...counts, actor: job.keeper.id, actorName: job.keeper.name, auto: true } })
  }

  // A batch comes back whole, or not at all: a file changed since is left as it reads.
  async function undoTidy(scope, batch) {
    const key = scopeKey(scope)
    await queued(async () => {
      await recoverPending()
      writable(scope, USER)
      const last = doneOf(scope)
      if (batch === '' || last?.batch !== batch) throw new Error('That tidy is not the latest one of this memory.')
      const saved = JSON.parse(readFileSync(batchPath(scope, batch), 'utf8'))
      const dir = dirOf(scope)
      const read = (file) => { try { return readFileSync(join(dir, file), 'utf8') } catch { return null } }
      if (saved.files.some(item => read(item.file) !== item.after)) throw new Error('This memory has changed since that tidy, so it cannot be undone as a whole.')
      const steps = saved.files.map(item => (item.before === null ? removeStep(join(dir, item.file)) : writeStep(join(dir, item.file), item.before)))
      const retiredPath = join(dir, RETIRED)
      if (typeof saved.retiredOffset === 'number') {
        const tail = readTailBytes(retiredPath, saved.retiredOffset)
        if (tail === undefined) throw new Error('This memory has changed since that tidy, so it cannot be undone as a whole.')
        if ((saved.retiredLines ?? 0) === 0) {
          if (tail.length !== 0) throw new Error('This memory has changed since that tidy, so it cannot be undone as a whole.')
        } else {
          if (sha256(tail) !== saved.retiredHash) throw new Error('This memory has changed since that tidy, so it cannot be undone as a whole.')
          steps.push(saved.retiredOffset === 0 ? removeStep(retiredPath) : truncateStep(retiredPath, saved.retiredOffset))
        }
      } else if (typeof saved.retiredBefore === 'string') {
        steps.push(saved.retiredBefore === '' ? removeStep(retiredPath) : writeStep(retiredPath, saved.retiredBefore))
      }
      steps.push(removeStep(batchPath(scope, batch)))
      const { batch: _gone, items: _items, ...rest } = last
      steps.push(writeStep(statePath(scope), JSON.stringify({ ...rest, undone: batch })))
      await publish({ op: 'tidy-undo', scope: key, steps, row: { op: 'tidy-undo', scope: key, batch, actor: 'user', actorName: 'user' } })
    })
  }

  const tidyView = (scopes) => {
    const latest = Object.entries(scopes).map(([tag, scope]) => ({ tag, ...doneOf(scope) })).filter(item => item.batch !== undefined).sort((a, b) => String(b.time).localeCompare(String(a.time)))[0]
    return latest === undefined ? null : { scope: latest.tag, batch: latest.batch, at: latest.time, merged: latest.merged, moved: latest.moved, retired: latest.retired, items: latest.items ?? [] }
  }

  const hasExpired = (job, day) => {
    try {
      return searchEntries(job.scope).some(entry => (job.scope.kind !== 'team' || entry.file.topic !== undefined) && !isPinned(entry) && isExpired(entry, day))
    } catch {
      return false
    }
  }

  // One memory at a time, and only one that changed since its last tidy (or holds expired
  // entries waiting to retire), on a new day.
  const dueReason = (job) => {
    const last = doneOf(job.scope)
    const day = today()
    if (last?.day === day) return undefined
    if (changedSince(scopeKey(job.scope), last?.time)) return 'changed'
    return hasExpired(job, day) ? 'expired' : undefined
  }
  /** @type {Map<string, {count: number, until: number}>} */
  const failures = new Map()
  let nextJobIndex = 0
  let running = false
  const backoffFor = (count) => {
    if (typeof config.memoryTidyBackoffMs === 'number' && config.memoryTidyBackoffMs >= 0) return config.memoryTidyBackoffMs
    return FAILURE_BACKOFF_MS[Math.min(count - 1, FAILURE_BACKOFF_MS.length - 1)]
  }
  async function tick() {
    if (running || rt.readOnly() !== undefined) return
    running = true
    try {
      await rt.load()
      const list = jobs()
      if (list.length === 0) return
      const now = Date.now()
      const start = nextJobIndex % list.length
      let picked
      for (let offset = 0; offset < list.length; offset += 1) {
        const idx = (start + offset) % list.length
        const job = list[idx]
        const key = scopeKey(job.scope)
        const priorFailure = failures.get(key)
        if (priorFailure !== undefined && now < priorFailure.until) continue
        const reason = dueReason(job)
        if (reason === undefined) continue
        picked = { job, key, reason, idx }
        break
      }
      if (picked === undefined) return
      nextJobIndex = (picked.idx + 1) % list.length
      try {
        await tidy(picked.job, { expiredOnly: picked.reason === 'expired' })
        failures.delete(picked.key)
      } catch (error) {
        const count = (failures.get(picked.key)?.count ?? 0) + 1
        failures.set(picked.key, { count, until: Date.now() + backoffFor(count) })
        rt.warn('ds-bot: the memory tidy of %s failed: %s', picked.key, error?.message ?? error)
      }
    } catch (error) {
      rt.warn('ds-bot: the memory tidy failed: %s', error?.message ?? error)
    } finally {
      running = false
    }
  }

  if (config.memoryTidy !== false) {
    ctx.effect(() => {
      const timer = setInterval(() => void tick(), config.memoryTidyEveryMs ?? EVERY_MS)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'ds-bot: memory tidy')
  }

  const tidyNow = async (key) => {
    await rt.load()
    const job = jobs().find(item => scopeKey(item.scope) === key)
    if (job !== undefined && doneOf(job.scope)?.day !== today()) {
      await tidy(job)
      failures.delete(key)
    }
  }
  const forgetScope = (key) => {
    if (typeof key === 'string') failures.delete(key)
  }
  return { tidyView, undoTidy, tidyNow, tidyTick: tick, forgetScope }
}
