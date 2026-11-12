// The memory review. When a conversation goes idle, a model reads what is new there
// and keeps, changes, or removes entries, as a person would after a talk. A Bot's own
// chat goes to its own memory, read by its model; a group chat goes to the group's
// memory, read once for all its members by its keeper's model, so what is said in a
// group stays there. Reviews run one at a time, and a conversation that goes on
// before its review starts is read in one go.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GONE, REVIEW_MEMORY_MAX, ROUTED, TEAM_SHARED, bodySize, cleanDay, cleanEntry, cleanTopic, isPinned, parseReview, reviewEntries } from './memory-entries.js'
import { REVIEW_CHANGES_MAX, reviewRequest, reviewSystem, writtenIn } from './memory-copy.js'
import { speakerOf } from '../shared/mentions.js'

// The memory review reads at most this much of what is new, newest kept first.
const REVIEW_DELAY_MS = 2_000
const REVIEW_READ_MS = 15_000
const REVIEW_FIRST_LINES = 6
const REVIEW_CONTEXT_LINES = 4
const REVIEW_TEXT_MAX = 16_000
const REVIEW_USER_LINE_MAX = 3_000
const REVIEW_OTHER_LINE_MAX = 800
const REVIEW_PASSES_MAX = 4

export function installReview(rt, memory) {
  const { ctx, config } = rt
  const { root, reviewOn, mainLimit, TEAM, ownScope, groupScope, keeperOf, writesTeam, labelOf, fileName, today, writeText, settled, loadScope, addEntry, replaceEntry, removeEntry, entryProblem, secretEntry, botShot, languageNow } = memory

  const cursorsPath = join(root, 'reviewed.json')
  /** @type {Record<string, number> | undefined} */
  let cursors
  const cursorsNow = () => {
    if (cursors === undefined) {
      try {
        const value = JSON.parse(readFileSync(cursorsPath, 'utf8'))
        cursors = value !== null && typeof value === 'object' ? value : {}
      } catch {
        cursors = {}
      }
    }
    return cursors
  }
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max)} …(cut)` : text)
  // A long message often ends with what the user wants of it, so both ends stay.
  const ends = (text, max) => (text.length > max ? `${text.slice(0, Math.ceil(max * 2 / 3))} …(middle cut)… ${text.slice(-Math.floor(max / 3))}` : text)

  // Lines say who spoke. The user's lines are kept longest: what they say is what
  // the review keeps; the rest is there to make it understood.
  const reviewLine = (who, text, bot) => (who === 'user'
    ? ends(text, REVIEW_USER_LINE_MAX)
    : clip(who === 'you' ? `${bot.name}: ${text.replace(/^You: /, '')}` : text, REVIEW_OTHER_LINE_MAX))

  // What is new in a Bot's own chat, read newest first from the Session.
  async function chatBatch(sessionId, bot, since) {
    const fresh = []
    const earlier = []
    let through
    // Reading goes back as far as it takes: to the cursor, or for a first review to
    // the user's latest line.
    for await (const line of rt.partLines(sessionId, AbortSignal.timeout(REVIEW_READ_MS), { pages: Infinity })) {
      through ??= line.seq
      // A first review reads back at least to the user's latest line.
      if (since === undefined ? fresh.length < REVIEW_FIRST_LINES || !fresh.some(seen => seen.who === 'user') : line.seq > since) fresh.push(line)
      else if (earlier.push(line) >= REVIEW_CONTEXT_LINES) break
    }
    const parts = rt.partsOf(bot.id)
    const at = parts.findIndex(part => part.sessionId === sessionId)
    return {
      through,
      fresh: fresh.reverse(),
      earlier: earlier.reverse(),
      where: 'its own chat with the user',
      // The user's latest line among those the review read.
      source: (lines) => {
        const said = lines.findLast(line => line.who === 'user')
        return said === undefined ? undefined : `part ${at === -1 ? Math.max(parts.length, 1) : at + 1} #${said.seq}`
      },
    }
  }

  // What is new in a group, from its log: the members' Sessions hold the same
  // messages wrapped in turn prompts.
  function groupBatch(room, since) {
    const log = (room.log ?? []).filter(line => line.kind === undefined && typeof line.text === 'string' && line.text.trim() !== '')
    // A first review reads back at least to the user's latest line, which a round of
    // replies from many members can push out of the last few.
    const lastUser = log.findLastIndex(line => line.who === 'User' && line.botId === undefined)
    let start = since === undefined ? Math.max(0, Math.min(log.length - REVIEW_FIRST_LINES, lastUser === -1 ? log.length : lastUser)) : log.findIndex(line => line.seq > since)
    if (start === -1) start = log.length
    const line = (entry) => {
      const who = entry.botId === undefined && entry.who === 'User' ? 'user' : 'bot'
      return { who, text: `${who === 'user' ? 'User' : speakerOf(entry)}: ${entry.text}`, seq: entry.seq }
    }
    return {
      through: log.at(-1)?.seq,
      fresh: log.slice(start).map(line),
      earlier: log.slice(Math.max(0, start - REVIEW_CONTEXT_LINES), start).map(line),
      where: `the group chat "${room.name}"`,
      // The user's latest line among those the review read, which read_group_chat opens.
      source: (lines) => {
        const said = lines.findLast(item => item.who === 'user') ?? lines.at(-1)
        return said === undefined ? `group "${room.name}"` : `group "${room.name}" #${said.seq}`
      },
    }
  }

  // The oldest new lines that fit; the rest waits for the next pass.
  function fitted(lines, bot) {
    const kept = []
    let used = 0
    for (const line of lines) {
      const text = reviewLine(line.who, line.text, bot)
      if (kept.length > 0 && used + text.length > REVIEW_TEXT_MAX) break
      kept.push(text)
      used += text.length
    }
    return { texts: kept, count: kept.length }
  }

  // Where an add goes: the review's own memory, or the audience it names.
  function routeOf(change, keeper, home, team) {
    if (home.kind === 'group') return { scope: home }
    if (change.team === true && team) return { scope: TEAM }
    if (typeof change.for === 'string' && change.for.trim() !== '') {
      const bot = rt.findBot(change.for)
      if (!rt.isMain(keeper.id)) return { scope: home, error: 'only a Main Bot keeps notes for another Bot' }
      if (bot === undefined) return { scope: home, error: `there is no Bot named "${clip(change.for, 60)}"` }
      if (rt.isPrivate(bot.id)) return { scope: home, error: 'a private Bot keeps its own memory' }
      return { scope: ownScope(bot.id) }
    }
    if (typeof change.group === 'string' && change.group.trim() !== '') {
      const room = roomsOf(keeper).find(item => item.name === change.group.trim())
      return room === undefined ? { scope: home, error: `the keeper is in no group named "${clip(change.group, 60)}"` } : { scope: groupScope(room.id) }
    }
    return { scope: home }
  }
  const roomsOf = keeper => Object.values(rt.state.rooms).filter(room => room.members.includes(keeper.id))

  // `home` is the memory the review keeps what it finds in: the keeper's own, or its
  // group's. `teamWrites` says whether the keeper may also write the team's.
  async function applyReview({ keeper, name, home, numbered, changes, source, teamWrites }) {
    const actor = { id: keeper.id, name: keeper.name, auto: true }
    const done = []
    const counts = () => ({ kept: done.length, changed: done.filter(result => result.changed).length })
    let failed
    // A removal frees room and an edit names an entry as it reads now, so both go
    // before what is new.
    const order = change => ({ remove: 0, edit: 1 })[String(change?.op)] ?? 2
    for (const change of changes.toSorted((a, b) => order(a) - order(b))) {
      // A keeper deleted mid-review keeps no more changes, its team ones included.
      if (rt.botOf(keeper.id) === undefined) return counts()
      // Its role may change mid-review too, so each change asks again.
      const team = teamWrites()
      const op = String(change?.op ?? '')
      const target = numbered[Number(change?.entry) - 1]
      const route = op === 'add' ? routeOf(change, keeper, home, team) : undefined
      const scope = op === 'add' ? route.scope : target?.scope === 'team' ? TEAM : home
      // What the review keeps for the team waits in a topic: it does not get in front of every Bot by itself.
      const topic = op === 'add' && scope.kind === 'team' ? cleanTopic(String(change?.topic ?? TEAM_SHARED)) : op === 'add' && change?.topic !== undefined ? cleanTopic(String(change.topic)) : undefined
      const label = labelOf(scope, keeper.id)
      const text = cleanEntry(change?.text)
      const until = cleanDay(change?.until)
      const meta = { source, ...(scope.kind === 'team' ? { by: keeper.name } : {}), added: today(), ...(until === undefined ? {} : { until }) }
      // A change memory cannot keep is set aside and said, so what was not saved
      // shows in the diagnostics; the rest of the answer is kept all the same —
      // the same lines read again would meet the same limit. A secret's text is
      // not repeated into the log.
      const badTopic = op === 'add' && change?.topic !== undefined && String(change.topic).trim() !== '' && topic === undefined
      const problem = op === 'add' || op === 'edit' ? entryProblem(text) : undefined
      const leftOut =
        op !== 'add' && target === undefined ? `it names entry ${change?.entry}, which is not listed` :
        op !== 'add' && isPinned(target) ? 'it changes an entry the user pinned' :
        op !== 'add' && target.scope === 'team' && target.file.topic === undefined ? 'it changes what every Bot always reads, which only the user does' :
        route?.error !== undefined ? route.error :
        scope.kind === 'team' && !team ? 'it is for the team memory, which the review may not write' :
        badTopic ? `it names the topic "${clip(String(change.topic), 60)}", which cannot be a topic name` :
        problem !== undefined ? (secretEntry(text) ? 'the entry looks like a key, token, password, or ID number, which memory never keeps' : `the entry "${clip(text, 160)}": ${problem}`) :
        undefined
      if (leftOut !== undefined) {
        rt.warn('ds-bot: memory review of %s left out a change: %s', name, leftOut)
        continue
      }
      try {
        if (op === 'add') done.push(await addEntry({ scope, topic, text, meta, actor, label }))
        else if (op === 'edit') done.push(await replaceEntry({ scope, topic: target.file.topic, match: target.text, text, meta, actor, label }))
        else if (op === 'remove') done.push(await removeEntry({ scope, topic: target.file.topic, match: target.text, actor, label }))
      } catch (failure) {
        if (failure?.code === GONE) return counts()
        // The change is named by its text and where it was headed, so the
        // diagnostics say what was not kept, not only why.
        const held = op === 'remove' ? `the removal of "${clip(target.text, 160)}"` : `the entry "${clip(text, 160)}"`
        const aimed = `${fileName(op === 'add' ? { topic } : target.file)} of ${label}`
        rt.warn('ds-bot: memory review of %s left out a change: %s for %s: %s', name, held, aimed, failure?.message ?? failure)
        if (!ROUTED.has(failure?.code)) failed ??= failure
      }
    }
    // A write that broke keeps the review's place: it may work when the lines are
    // next read. What memory could not keep was set aside above, said already.
    if (failed !== undefined) throw failed
    return counts()
  }

  const roomCopy = room => ({ id: room.id, name: room.name, seq: room.seq, log: [...room.log ?? []] })
  // The log as of `now`, with the lines of an earlier copy that have left it since.
  const joinLogs = (kept, now) => {
    if (kept === undefined || kept.id !== now.id) return roomCopy(now)
    const oldest = now.log?.[0]?.seq ?? Infinity
    return { ...roomCopy(now), log: [...kept.log.filter(line => line.seq < oldest), ...now.log ?? []] }
  }

  // A line that has left the room's log comes from the group's own, whole. So does one
  // the room's log holds cut.
  const withKeptLines = (room, kept) => {
    if (kept.length === 0) return room
    const bySeq = new Map((room.log ?? []).map(line => [line.seq, line]))
    for (const line of kept) bySeq.set(line.seq, line)
    return { ...room, log: [...bySeq.values()].sort((a, b) => a.seq - b.seq) }
  }

  // What a Session's turn gives the review: its Bot's own chat, or its group with a
  // copy of the group's log as of now. `key` is where the review keeps its place.
  const reviewOf = (sessionId) => {
    const chat = rt.chatOwners.get(sessionId)
    if (chat !== undefined) return { key: `chat:${sessionId}`, sessionId, botId: chat }
    const owner = rt.groupOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)
    if (owner === undefined) return undefined
    if (owner.roomId === undefined) return { key: `chat:${sessionId}`, sessionId, botId: owner.botId }
    const room = rt.roomOf(owner.roomId)
    return room === undefined ? undefined : { key: `group:${room.id}`, roomId: room.id, room: roomCopy(room) }
  }

  // A Bot's own chat, kept in its own memory. A context switch during the wait leaves
  // the Session an earlier part, still the Bot's.
  async function reviewChat(seen) {
    const bot = rt.botOf(reviewOf(seen.sessionId)?.botId ?? seen.botId)
    if (bot === undefined) return
    const since = cursorsNow()[seen.key]
    await reviewBatch({
      key: seen.key, since, batch: await chatBatch(seen.sessionId, bot, since),
      keeper: bot, name: bot.name, home: ownScope(bot.id), teamWrites: () => writesTeam(bot.id),
      who: `The Bot: ${bot.name}${bot.role ? `, ${bot.role}` : ''}.`,
      tag: { sessionId: rt.chatOf(bot.id), kind: 'memory' },
      alive: () => rt.botOf(bot.id) !== undefined,
      next: () => queueReview(seen),
    })
  }

  // A group chat, kept in the group's memory and read once for all its members.
  // `seen.room` holds the lines that left the log while the review waited, so who
  // has joined or left since changes nothing. A deleted group's memory is archived
  // with it, so nothing more is kept of it.
  async function reviewGroup(seen) {
    const live = rt.roomOf(seen.roomId)
    const keeper = live === undefined ? undefined : keeperOf(live)
    if (keeper === undefined) return
    const since = cursorsNow()[seen.key]
    const room = withKeptLines(joinLogs(seen.room, live), await rt.groupLinesAfter(live.id, since).catch((error) => {
      rt.warn('ds-bot: the log of group "%s" could not be read: %s', live.name, error?.message ?? error)
      return []
    }))
    const members = live.members.map(id => rt.botOf(id)).filter(Boolean).map(bot => `${bot.name}${live.admin === bot.id ? ' (admin)' : ''}`)
    await reviewBatch({
      key: seen.key, since, batch: groupBatch(room, since),
      keeper, name: `group "${live.name}"`, home: groupScope(live.id), teamWrites: () => false, group: true,
      who: `The group chat: "${live.name}", with the user and ${members.join(', ')}.`,
      tag: { sessionId: live.id, kind: 'memory' },
      alive: () => rt.botOf(keeper.id) !== undefined && rt.roomOf(live.id)?.members.includes(keeper.id) === true,
      next: () => queueReview({ ...seen, room }),
    })
  }

  // One review from the conversation's place `since`: `home` is where it keeps what it
  // finds, `keeper` the Bot whose model reads, `who` whose memory it is. `alive` says
  // whether the keeper, and the group, are still there to keep it.
  async function reviewBatch({ key, since, batch, keeper, name, home, teamWrites, group = false, who, tag, alive, next }) {
    // The cursor only moves forward.
    if (batch.through === undefined || (since !== undefined && batch.through <= since)) return
    // A backlog past the text limit is read in passes, oldest first, so the cursor
    // only passes lines the model has seen.
    const fresh = fitted(batch.fresh, keeper)
    const read = batch.fresh.slice(0, fresh.count)
    const more = fresh.count < batch.fresh.length
    let through = more ? read.at(-1).seq : batch.through
    let again = more
    // A first review fixes where it starts before the model call, so a failure
    // leaves a cursor that the next review goes on from.
    if (since === undefined && read.length > 0) {
      cursorsNow()[key] = read[0].seq - 1
      await writeText(cursorsPath, JSON.stringify(cursors))
    }
    // Only the user's words are kept, so lines without any need no model call.
    if (read.some(line => line.who === 'user')) {
      const { homeFiles, teamFiles } = await settled(() => ({ homeFiles: loadScope(home), teamFiles: loadScope(TEAM) }))
      const said = read.filter(line => line.who === 'user').map(line => line.text).join('\n')
      const tagged = group ? 'group' : 'own'
      const { numbered, left } = reviewEntries(homeFiles, teamFiles, REVIEW_MEMORY_MAX, said, tagged)
      const sizes = { home: bodySize(homeFiles[0]), homeLimit: mainLimit(home), team: bodySize(teamFiles[0]), teamLimit: mainLimit(TEAM) }
      const earlier = batch.earlier.map(line => reviewLine(line.who, line.text, keeper))
      const language = writtenIn(read.filter(line => line.who === 'user').map(line => line.text.replace(/^User: /, '')), languageNow())
      const reply = await botShot(keeper, reviewSystem({ teamWrites: teamWrites(), group, routes: !group && rt.isMain(keeper.id), rooms: group || !teamWrites() ? [] : roomsOf(keeper).map(room => room.name) }), reviewRequest({ who, tag: tagged, numbered, left, sizes, where: batch.where, earlier, fresh: fresh.texts, more, language }), tag)
      if (!alive()) return
      const parsed = parseReview(reply)
      // An answer that is no list of changes keeps nothing of the batch; the miss
      // is said, and the place moves on — the same lines are not read again. A
      // change that is not well formed is set aside and said, one by one.
      if (parsed === undefined) {
        rt.warn('ds-bot: memory review of %s got no list of changes from the model: %s', name, clip(reply.replace(/\s+/g, ' '), 120))
      } else {
        const { changes, leftOut } = parsed
        for (const change of leftOut) {
          const whole = JSON.stringify(change)
          rt.warn('ds-bot: memory review of %s left out a change: %s', name, secretEntry(whole) ? 'it looks like a key, token, password, or ID number, which memory never keeps' : `it is not a well-formed change: ${clip(whole, 160)}`)
        }
        // The limit is what one answer may hold, not a cut of the one the model
        // gave: every change in it is kept or set aside, none is dropped.
        const { kept, changed } = await applyReview({ keeper, name, home, numbered, changes, source: batch.source(read), teamWrites })
        if (!alive()) return
        // An answer that kept all one answer may hold may have left some out, so
        // the same lines are read again, a few times at most, while each pass
        // still changes something. What was set aside is no part of the limit: it
        // was handled, and the same lines read again would meet it the same way.
        const prior = overflowed.get(key)
        const passes = prior !== undefined && prior.since === since ? prior.passes : 0
        if (kept >= REVIEW_CHANGES_MAX && changed > 0 && passes < REVIEW_PASSES_MAX) {
          overflowed.set(key, { since, passes: passes + 1 })
          through = since
          again = true
        } else {
          overflowed.delete(key)
        }
      }
    }
    const now = cursorsNow()[key]
    if (through !== undefined && (now === undefined || through > now)) {
      cursorsNow()[key] = through
      await writeText(cursorsPath, JSON.stringify(cursors))
    }
    if (again) next()
  }
  /** @type {Map<string, {since: number | undefined, passes: number}>} */
  const overflowed = new Map()

  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const reviewTimers = new Map()
  /** @type {Map<string, ReturnType<typeof reviewOf>>} */
  const reviewQueue = new Map()
  let reviewChain = Promise.resolve()
  let reviewsRunning = 0
  const memoryReviews = () => reviewTimers.size + reviewQueue.size + reviewsRunning
  // A conversation waits in the line once: a later turn's copy of a group log joins
  // the one that already waits.
  function queueReview(seen) {
    const prior = reviewQueue.get(seen.key)
    if (prior !== undefined) {
      if (seen.room !== undefined) reviewQueue.set(seen.key, { ...seen, room: joinLogs(prior.room, seen.room) })
      return
    }
    reviewQueue.set(seen.key, seen)
    reviewChain = reviewChain.then(async () => {
      const waited = reviewQueue.get(seen.key)
      reviewQueue.delete(seen.key)
      reviewsRunning += 1
      try {
        if (rt.readOnly() === undefined) await (waited.roomId === undefined ? reviewChat(waited) : reviewGroup(waited))
      } catch (error) {
        rt.warn('ds-bot: memory review of %s failed: %s', waited.key, error?.message ?? error)
      } finally {
        reviewsRunning -= 1
      }
    })
  }

  if (reviewOn) {
    const delay = config.memoryReviewDelayMs ?? REVIEW_DELAY_MS
    // What each running turn gave when it began: a member removed from its group
    // mid-turn leaves a Session that no longer has one when it ends.
    /** @type {Map<string, ReturnType<typeof reviewOf>>} */
    const turnOwners = new Map()
    // A turn that starts again before the delay is over is reviewed when it ends.
    ctx.on('agent/status', ({ agent, status }) => {
      const id = agent?.id
      if (id === undefined || (!rt.isBotSession(id) && !turnOwners.has(id))) return
      clearTimeout(reviewTimers.get(id))
      reviewTimers.delete(id)
      if (status !== 'idle') {
        if (!turnOwners.has(id)) turnOwners.set(id, reviewOf(id))
        return
      }
      const started = turnOwners.get(id)
      turnOwners.delete(id)
      const seen = reviewOf(id) ?? started
      if (seen === undefined) return
      const timer = setTimeout(() => {
        reviewTimers.delete(id)
        queueReview(seen)
      }, delay)
      timer.unref?.()
      reviewTimers.set(id, timer)
    })
    ctx.effect(() => () => {
      for (const timer of reviewTimers.values()) clearTimeout(timer)
      reviewTimers.clear()
      turnOwners.clear()
    }, 'ds-bot: memory review')
  }

  return { memoryReviews }
}
