// The memory tidy. Once a day at most, for each memory that changed, a model reads all
// its entries and merges repeats, settles what contradicts, and moves details to topics.
// A merge loses words, so nothing is deleted: what leaves goes to retired.jsonl beside
// the entries, what a pass did is one batch the user can undo, a pinned entry is never
// offered, and one pass changes at most a fifth of the entries.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEADING, MAIN, addLink, cleanEntry, cleanTopic, entryId, formatEntry, insertEntry, isExpired, isPinned, joinLines, parseMemory, removeLink } from './memory-entries.js'
import { tidyRequest, tidySystem } from './memory-copy.js'

const EVERY_MS = 30 * 60_000
// Below this there is nothing a tidy would be worth a model call for.
const ENTRIES_MIN = 8
const SHARE_MAX = 5
const RETIRED = 'retired.jsonl'
const NOTE_MAX = 120
const ITEMS_SHOWN = 20

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
  const { TEAM, ownScope, groupScope, keeperOf, scopeKey, dirOf, today, queued, recoverPending, writable, settled, loadScope, publish, writeStep, removeStep, writeText, botShot, languageNow, allEntries, entryProblem, changedSince, USER } = memory
  // All of it sits in the memory's own folder: a private Bot's words stay in its own,
  // and an archive of a deleted Bot or group takes them along.
  const statePath = scope => join(dirOf(scope), 'tidied.json')
  const batchPath = (scope, batch) => join(dirOf(scope), 'tidy', `${batch}.json`)
  const doneOf = (scope) => {
    try {
      return JSON.parse(readFileSync(statePath(scope), 'utf8'))
    } catch {
      return undefined
    }
  }

  // Every memory with someone to read it for: a team tidy offers only its topics, since
  // what every Bot always reads is the user's to change.
  function jobs() {
    const bots = Object.values(state.bots).map(bot => ({ scope: ownScope(bot.id), keeper: bot, who: `one Bot, ${bot.name}` }))
    const rooms = Object.values(state.rooms).flatMap((room) => {
      const keeper = keeperOf(room)
      return keeper === undefined ? [] : [{ scope: groupScope(room.id), keeper, who: `one group chat, "${room.name}"` }]
    })
    const main = Object.values(state.bots).find(bot => rt.isMain(bot.id))
    return [...bots, ...rooms, ...(main === undefined ? [] : [{ scope: TEAM, keeper: main, who: 'the notes a team of Bots shares' }])]
  }
  const offeredOf = (job, files) => allEntries(job.scope.kind === 'team' ? files.slice(1) : files).filter(entry => !isPinned(entry))

  async function tidy(job) {
    const key = scopeKey(job.scope)
    const prior = doneOf(job.scope)
    const day = today()
    const files = await settled(() => loadScope(job.scope))
    const offered = offeredOf(job, files)
    const ended = offered.filter(entry => isExpired(entry, day))
    const open = offered.filter(entry => !isExpired(entry, day))
    let changes = []
    if (open.length >= ENTRIES_MIN) {
      const max = Math.max(1, Math.floor(offered.length / SHARE_MAX))
      const reply = await botShot(job.keeper, tidySystem({ who: job.who, max }), tidyRequest({ entries: open, language: languageNow() }), { sessionId: job.scope.kind === 'bot' ? rt.chatOf(job.keeper.id) : job.scope.kind === 'group' ? job.scope.roomId : rt.chatOf(job.keeper.id), kind: 'memory' })
      const parsed = parseTidy(reply)
      if (parsed === undefined) rt.warn('ds-bot: the memory tidy of %s got no list of changes from the model', key)
      else changes = parsed
    }
    await queued(async () => {
      await recoverPending()
      if (rt.botOf(job.keeper.id) === undefined) return
      writable(job.scope, USER)
      await applyTidy(job, key, day, changes, open, ended, prior)
    })
  }

  async function applyTidy(job, key, day, changes, numbered, ended, prior) {
    const files = loadScope(job.scope)
    const offered = offeredOf(job, files)
    const byId = new Map(offered.map(entry => [entryId(entry), entry]))
    const draft = new Map(files.map(file => [file.file, [...file.lines]]))
    const main = files[0]
    const budget = { left: Math.max(1, Math.floor(offered.length / SHARE_MAX)) }
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
        const title = lines.findIndex(line => HEADING.test(line))
        const kept = lines.filter(line => !/^>\s*\S/.test(line))
        kept.splice(title + 1, 0, '', `> ${text}`)
        draft.set(`${name}.md`, kept)
        continue
      }
      if (op === 'merge') {
        const entries = [...new Set((Array.isArray(change.entries) ? change.entries : []).map(pick))]
        if (entries.some(entry => entry === undefined || used.has(entry))) continue
        const text = cleanEntry(change.text)
        if (entries.length < 2 || entries.length > budget.left || entryProblem(text) !== undefined) continue
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
        const name = cleanTopic(change.topic)
        if (name === undefined) continue
        budget.left -= 1
        const line = entry.file.lines[entry.line]
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
      const emptied = file !== MAIN && lines.every(line => line.trim() === '' || HEADING.test(line) || /^>\s/.test(line))
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
      if (rt.readOnly() === undefined) await writeText(statePath(job.scope), JSON.stringify(stamp))
      return
    }
    for (const item of touched) steps.push(item.after === null ? removeStep(join(dir, item.file)) : writeStep(join(dir, item.file), item.after))
    const retiredPath = join(dir, RETIRED)
    let log = ''
    try { log = readFileSync(retiredPath, 'utf8') } catch { /* none yet */ }
    if (retired.length > 0) steps.push(writeStep(retiredPath, `${log}${retired.map(row => JSON.stringify(row)).join('\n')}\n`))
    steps.push(writeStep(batchPath(job.scope, batch), JSON.stringify({ batch, scope: key, files: touched, retiredBefore: log })))
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
      steps.push(saved.retiredBefore === '' ? removeStep(join(dir, RETIRED)) : writeStep(join(dir, RETIRED), saved.retiredBefore))
      const { batch: _gone, items: _items, ...rest } = last
      steps.push(writeStep(statePath(scope), JSON.stringify({ ...rest, undone: batch })))
      await publish({ op: 'tidy-undo', scope: key, steps, row: { op: 'tidy-undo', scope: key, batch, actor: 'user', actorName: 'user' } })
    })
  }

  const tidyView = (scopes) => {
    const latest = Object.entries(scopes).map(([tag, scope]) => ({ tag, ...doneOf(scope) })).filter(item => item.batch !== undefined).sort((a, b) => String(b.time).localeCompare(String(a.time)))[0]
    return latest === undefined ? null : { scope: latest.tag, batch: latest.batch, at: latest.time, merged: latest.merged, moved: latest.moved, retired: latest.retired, items: latest.items ?? [] }
  }

  // One memory at a time, and only one that changed since its last tidy, on a new day.
  const due = (job) => {
    const last = doneOf(job.scope)
    return last?.day !== today() && changedSince(scopeKey(job.scope), last?.time)
  }
  let running = false
  async function tick() {
    if (running || rt.readOnly() !== undefined) return
    running = true
    try {
      await rt.load()
      const job = jobs().find(due)
      if (job !== undefined) await tidy(job)
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
    if (job !== undefined && doneOf(job.scope)?.day !== today()) await tidy(job)
  }
  return { tidyView, undoTidy, tidyNow }
}
