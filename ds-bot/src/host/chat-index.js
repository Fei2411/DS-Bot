// Reading a Bot's own chat: Session history pages, the SQLite FTS5 index, and the
// search, latest, and around reads behind read_own_chat.
//
// Chat index. read_own_chat searches a SQLite FTS5 table of every part of a Bot's own
// chat, ranked by BM25. The trigram tokenizer matches any run of three or more
// characters, so Chinese needs no word splitting; shorter words fall back to LIKE.
// The index is derived from the Session logs: a part catches up when it is read, an
// ended part is sealed once it is complete, and deleting the file only costs a
// rebuild. Without SQLite, read_own_chat scans the logs as before.
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ANCHOR_LINE_MAX, HISTORY_PAGE, HISTORY_PAGES_MAX, HISTORY_SCAN_PAGES, HISTORY_TIMEOUT_MS, OWN_CHAT_BRIEF, OWN_CHAT_LINE_MAX, OWN_CHAT_READ, OWN_CHAT_SEARCH } from './constants.js'
import { excerpt } from './text.js'

const INDEX_VERSION = 5
const AROUND_LINES = 6
const SEARCH_TERMS_MAX = 6
const ANY_TERM_HITS = 50
const INDEX_TIMEOUT_MS = 120_000
// A part still gets a few events (a title, a late reply) just after it ends.
const SEAL_AFTER_MS = 60_000

const likeOf = term => `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`
const HAN_RUN = /\p{Script=Han}{4,}/u

// Overlapping 2-char Han bigrams (plus any non-Han runs >= 2 chars) used only as a
// Tier-2 fallback when an unsegmented CJK phrase returns zero exact Tier-1 hits.
function cjkSubTerms(term) {
  if (!HAN_RUN.test(term)) return []
  const out = []
  const seen = new Set()
  const add = (piece) => {
    if (piece === '' || seen.has(piece) || out.length >= SEARCH_TERMS_MAX) return
    seen.add(piece)
    out.push(piece)
  }
  for (const match of term.matchAll(/\p{Script=Han}+|[^\p{Script=Han}]+/gu)) {
    const chunk = match[0]
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      const chars = [...chunk]
      if (chars.length <= 3) add(chunk)
      else {
        for (let i = 0; i <= chars.length - 2; i += 1) add(chars[i] + chars[i + 1])
      }
    } else if ([...chunk].length >= 2) {
      add(chunk)
    }
  }
  return out
}

// Each term is a quoted FTS5 phrase when trigrams can match it, else a LIKE filter.
// Queries with only short (<3 code-point) terms read directly from the indexed
// `messages` table instead of scanning the FTS5 virtual table across all Bots.
export function termQuery(terms, sessions, limit, hidden, bounds) {
  const long = terms.filter(term => [...term].length >= 3)
  const short = terms.filter(term => [...term].length < 3)
  const where = sessions.length === 1 ? ['session = ?'] : ['session IN (SELECT value FROM json_each(?))']
  const args = sessions.length === 1 ? [sessions[0]] : [JSON.stringify(sessions)]
  if (hidden !== undefined) {
    where.push('NOT (session = ? AND seq >= ?)')
    args.push(hidden.session, hidden.from)
  }
  if (Array.isArray(bounds)) {
    for (const bound of bounds) {
      if (typeof bound?.session !== 'string' || !Number.isInteger(bound?.throughSeq)) continue
      where.push('NOT (session = ? AND seq > ?)')
      args.push(bound.session, bound.throughSeq)
    }
  }
  if (long.length > 0) {
    where.unshift('lines MATCH ?')
    args.unshift(long.map(term => `"${term.replace(/"/g, '""')}"`).join(' '))
  }
  for (const term of short) {
    where.push("text LIKE ? ESCAPE '\\'")
    args.push(likeOf(term))
  }
  const table = long.length > 0 ? 'lines' : 'messages'
  return { sql: `SELECT text, session, seq, time, who FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${long.length > 0 ? 'rank' : 'time DESC'} LIMIT ${limit}`, args }
}

export function install(rt) {
  const { ctx, home } = rt

  const indexPath = join(home, 'chat-index.sqlite')
  let chatIndex
  let indexOpening

  // A Session's events from newest to oldest, also for an archived part.
  // Uses non-hydrating live lookup or DSH's cold sessionController.page so archived
  // parts never wake live ReactLoopAgents and stay readable if their workDir is gone.
  async function* eventsBackwards(sessionId, signal, maxPages = HISTORY_PAGES_MAX, read, maxSeq) {
    if (read !== undefined) Object.assign(read, { complete: false, capped: false })
    const liveSession = ctx.get?.('agents')?.get(sessionId)?.session ?? ctx.get?.('sessions')?.get(sessionId)
    const liveThroughSeq = liveSession !== undefined && Number.isInteger(Number(liveSession.seq))
      ? Number(liveSession.seq) - 1
      : undefined
    const boundThroughSeq = Number.isInteger(maxSeq)
      ? maxSeq
      : (Number.isInteger(read?.throughSeq) ? read.throughSeq : undefined)
    let throughSeq = liveThroughSeq !== undefined && boundThroughSeq !== undefined
      ? Math.min(liveThroughSeq, boundThroughSeq)
      : (boundThroughSeq ?? liveThroughSeq)
    let beforeSeq
    if (throughSeq !== undefined && throughSeq < 0) {
      if (read !== undefined) read.complete = true
      return
    }
    for (let pages = 0; ; pages += 1) {
      if (pages >= maxPages) {
        if (read !== undefined) read.capped = true
        if (!read?.continue?.()) return
      }
      let page
      try {
        page = await ctx.sessionController.page({
          address: { kind: 'session', sessionId },
          ...(throughSeq === undefined ? {} : { throughSeq }),
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          maxMessages: HISTORY_PAGE,
        }, signal)
      } catch (error) {
        if (beforeSeq === undefined && (error?.code === 'session/not-found' || error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND')) {
          if (read !== undefined) read.complete = true
          return
        }
        throw error
      }
      const events = page.records.map(record => record.event)
      if (throughSeq === undefined) {
        const pinned = Number.isInteger(page.cursor) ? page.cursor : events.at(-1)?.seq
        if (pinned !== undefined) throughSeq = pinned
      }
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (boundThroughSeq !== undefined && Number.isInteger(event?.seq) && event.seq > boundThroughSeq) continue
        yield event
      }
      if (!page.hasMore) {
        if (read !== undefined) read.complete = true
        return
      }
      if (events.length === 0) return
      beforeSeq = events[0].seq
    }
  }

  function openIndex() {
    if (chatIndex !== undefined) return Promise.resolve(chatIndex)
    const opening = indexOpening ??= (async () => {
      let DatabaseSync
      try {
        ({ DatabaseSync } = await import('node:sqlite'))
        await mkdir(home, { recursive: true })
      } catch (error) {
        rt.warn('ds-bot: no chat index, read_own_chat scans the logs: %s', error)
        return null
      }
      // Only proven damage warrants a rebuild: Desktop and Web share this file,
      // and a busy lock must never read as corruption, or the other writer's
      // index would be deleted under it.
      const damaged = error => /malformed|not a database|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(String(error?.message ?? error))
      for (const fresh of [false, true]) {
        try {
          if (fresh) {
            await Promise.all([indexPath, `${indexPath}-wal`, `${indexPath}-shm`].map(file => unlink(file).catch(() => {})))
          }
          return createIndex(new DatabaseSync(indexPath))
        } catch (error) {
          if (fresh || !damaged(error)) {
            rt.warn('ds-bot: no chat index, read_own_chat scans the logs: %s', error)
            return null
          }
        }
      }
      return null
    })().then((index) => {
      // The plugin may have been disposed while the file opened.
      if (indexOpening !== opening) {
        index?.db.close()
        return null
      }
      return chatIndex = index
    })
    return opening
  }

  function createIndex(db) {
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA journal_mode = WAL')
      if (db.prepare('PRAGMA user_version').get().user_version !== INDEX_VERSION) {
        db.exec(`
          DROP TABLE IF EXISTS lines;
          DROP TABLE IF EXISTS messages;
          DROP TABLE IF EXISTS marks;
          CREATE TABLE messages (id INTEGER PRIMARY KEY, text, session, seq, time, who);
          CREATE INDEX messages_session_seq ON messages (session, seq);
          CREATE INDEX messages_session_time ON messages (session, time DESC);
          CREATE VIRTUAL TABLE lines USING fts5(text, session UNINDEXED, seq UNINDEXED, time UNINDEXED, who UNINDEXED, content = 'messages', content_rowid = 'id', tokenize = 'trigram');
          CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, keep INTEGER NOT NULL, sealed INTEGER NOT NULL, turn INTEGER NOT NULL);
          PRAGMA user_version = ${INDEX_VERSION};`)
      }
      db.exec('CREATE INDEX IF NOT EXISTS messages_session_time ON messages (session, time DESC)')
      const insertMessage = db.prepare('INSERT INTO messages (text, session, seq, time, who) VALUES (?, ?, ?, ?, ?)')
      const insertLine = db.prepare('INSERT INTO lines (rowid, text, session, seq, time, who) VALUES (?, ?, ?, ?, ?, ?)')
      return {
        db,
        mark: db.prepare('SELECT through, keep, sealed, turn FROM marks WHERE session = ?'),
        setMark: db.prepare('INSERT OR REPLACE INTO marks (session, through, keep, sealed, turn) VALUES (?, ?, ?, ?, ?)'),
        insert: (...values) => {
          const { lastInsertRowid } = insertMessage.run(...values)
          insertLine.run(lastInsertRowid, ...values)
        },
        before: db.prepare('SELECT text, session, seq, time, who FROM messages WHERE session = ? AND seq < ? ORDER BY seq DESC LIMIT ?'),
        from: db.prepare('SELECT text, session, seq, time, who FROM messages WHERE session = ? AND seq >= ? ORDER BY seq LIMIT ?'),
        between: db.prepare('SELECT text, session, seq, time, who FROM messages WHERE session = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?'),
      }
    } catch (error) {
      db.close()
      throw error
    }
  }
  ctx.effect(() => () => {
    chatIndex?.db.close()
    chatIndex = undefined
    indexOpening = undefined
  }, 'ds-bot: chat index')

  // Adds what a part said since its mark. Reads of one part wait for each other, so no
  // line is added twice.
  const catchingUp = new Map()
  function catchUp(index, part) {
    const running = catchingUp.get(part.sessionId)
    if (running) return running
    const job = (async () => {
      const mark = index.mark.get(part.sessionId)
      if (mark?.sealed) return
      const through = mark?.through ?? -1
      const events = []
      for await (const event of eventsBackwards(part.sessionId, AbortSignal.timeout(INDEX_TIMEOUT_MS), Infinity)) {
        if (event.seq <= through) break
        events.push(event)
      }
      if (events.length > 0 && events.at(-1).seq !== through + 1) throw new Error(`the history of ${part.sessionId} came back with a gap`)
      events.reverse()
      if (index !== chatIndex) return
      let keep = mark ? mark.keep === 1 : false
      let turn = mark?.turn ?? -1
      const seal = part.endedAt !== undefined
        && !Number.isInteger(part.throughSeq)
        && rt.isBotSession?.(part.sessionId) !== true
        && Date.now() - part.endedAt > SEAL_AFTER_MS
        && rt.isRetiring?.(part.sessionId) !== true
      index.db.exec('BEGIN')
      try {
        let last = through
        for (const event of events) {
          last = event.seq
          if (event.type === 'turn/start') turn = event.seq
          const entry = rt.historyEntry(event, false)
          if (entry === undefined) continue
          if (entry.answer) {
            if (keep) index.insert(entry.text, part.sessionId, event.seq, event.time ?? 0, 'you')
            continue
          }
          keep = entry.keepAnswers
          if (entry.text !== '') index.insert(entry.text, part.sessionId, event.seq, event.time ?? 0, entry.who)
        }
        index.setMark.run(part.sessionId, last, keep ? 1 : 0, seal ? 1 : 0, turn)
        index.db.exec('COMMIT')
      } catch (error) {
        index.db.exec('ROLLBACK')
        throw error
      }
    })().finally(() => catchingUp.delete(part.sessionId))
    catchingUp.set(part.sessionId, job)
    return job
  }

  // A message's anchor: its part (once there are several) and its seq in that part.
  const anchorOf = (parts, row) => {
    const part = parts.find(item => item.sessionId === row.session)
    return `${parts.length > 1 ? `part ${part?.number ?? '?'} ` : ''}#${row.seq}`
  }
  const rowLine = (parts, row, terms = [], max = OWN_CHAT_LINE_MAX) => {
    const lower = row.text.toLowerCase()
    const wanted = terms.find(term => lower.includes(term)) ?? ''
    const text = row.who === 'user' ? `User: ${row.text}` : row.who === 'you' ? `You: ${row.text}` : row.text
    return `[${anchorOf(parts, row)} · ${rt.clock(row.time)}] ${excerpt(text, wanted, max)}`
  }

  // Every part, caught up. Asked from the current part, the turn that asks is left out
  // (`hidden`): it is in context, and its own question would match.
  async function indexedParts(botId, askingId) {
    const index = await openIndex()
    if (index === null) return { index }
    const parts = askingId === undefined ? rt.partsOf(botId) : rt.partsOfThread(botId, askingId)
    // A part that cannot be read now is searched as far as it was indexed.
    for (const part of parts) await catchUp(index, part).catch(error => rt.warn('ds-bot: indexing %s failed: %s', part.sessionId, error))
    const turn = askingId !== undefined && askingId === parts.at(-1)?.sessionId ? index.mark.get(askingId)?.turn : undefined
    return { index, parts, hidden: turn === undefined || turn < 0 ? undefined : { session: askingId, from: turn } }
  }

  // Messages with all the words, best first; with none of them having all, those with
  // the most of them. Shown oldest first.
  async function searchOwnChat(botId, query, { askingId, limit = OWN_CHAT_SEARCH } = {}) {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, SEARCH_TERMS_MAX)
    const { index, parts, hidden } = await indexedParts(botId, askingId)
    if (index === null) return { lines: await scanOwnChat(botId, query, limit, askingId), every: true }
    const sessions = parts.map(part => part.sessionId)
    const bounds = parts
      .filter(part => Number.isInteger(part.throughSeq))
      .map(part => ({ session: part.sessionId, throughSeq: part.throughSeq }))
    const run = (wanted, max) => {
      const { sql, args } = termQuery(wanted, sessions, max, hidden, bounds)
      return index.db.prepare(sql).all(...args)
    }
    const byTime = (a, b) => (a.time - b.time) || (sessions.indexOf(a.session) - sessions.indexOf(b.session)) || (a.seq - b.seq)
    const anyOf = (wanted) => {
      const found = new Map()
      for (const term of wanted) {
        for (const row of run([term], ANY_TERM_HITS)) {
          const key = `${row.session}#${row.seq}`
          const hit = found.get(key) ?? { row, count: 0 }
          hit.count += 1
          found.set(key, hit)
        }
      }
      return [...found.values()].sort((a, b) => (b.count - a.count) || (b.row.time - a.row.time)).slice(0, limit).map(hit => hit.row)
    }
    let rows = run(terms, limit)
    let every = true
    let highlightTerms = terms
    if (rows.length === 0 && terms.length > 1) {
      every = false
      rows = anyOf(terms)
    }
    if (rows.length === 0) {
      const subTerms = []
      const seen = new Set()
      for (const term of terms) {
        for (const piece of cjkSubTerms(term)) {
          if (seen.has(piece) || subTerms.length >= SEARCH_TERMS_MAX) continue
          seen.add(piece)
          subTerms.push(piece)
        }
      }
      if (subTerms.length > 0 && (terms.length > 1 || subTerms.length > 1)) {
        every = false
        highlightTerms = subTerms
        rows = anyOf(subTerms)
      }
    }
    return { lines: rows.sort(byTime).map(row => rowLine(parts, row, highlightTerms)), every }
  }

  // The latest messages across all parts, oldest first.
  async function latestOwnChat(botId, { askingId, limit = OWN_CHAT_READ } = {}) {
    const { index, parts, hidden } = await indexedParts(botId, askingId)
    if (index === null) return scanOwnChat(botId, '', limit, askingId)
    const rows = []
    for (const part of [...parts].reverse()) {
      let below = hidden?.session === part.sessionId ? hidden.from : Number.MAX_SAFE_INTEGER
      if (Number.isInteger(part.throughSeq)) below = Math.min(below, part.throughSeq + 1)
      if (below <= 0) continue
      rows.push(...index.before.all(part.sessionId, below, limit - rows.length))
      if (rows.length >= limit) break
    }
    return rows.reverse().map(row => rowLine(parts, row))
  }

  // The messages around an anchor, in its part.
  async function aroundOwnChat(botId, anchor, askingId) {
    const { index, parts } = await indexedParts(botId, askingId)
    if (index === null) return { error: 'Anchors need the chat index, which is unavailable here. Search with words instead.' }
    const found = /(?:part\s*)?(\d+)?\s*#\s*(\d+)/i.exec(anchor)
    if (found === null) return { error: `"${anchor}" is not an anchor. Anchors look like "part 2 #1234", or "#1234" in the current part.` }
    const number = found[1] === undefined ? parts.length : Number(found[1])
    const part = parts[number - 1]
    if (part === undefined) return { error: `Your own chat has no part ${number}.` }
    const seq = Number(found[2])
    const maxSeq = Number.isInteger(part.throughSeq) ? part.throughSeq : undefined
    if (maxSeq !== undefined && maxSeq < 0) return { part, exact: false, lines: [] }
    const beforeLimit = maxSeq === undefined ? seq : Math.min(seq, maxSeq + 1)
    const beforeRows = beforeLimit <= 0 ? [] : index.before.all(part.sessionId, beforeLimit, AROUND_LINES).reverse()
    const fromRows = maxSeq === undefined
      ? index.from.all(part.sessionId, seq, AROUND_LINES + 1)
      : seq > maxSeq
        ? []
        : index.between.all(part.sessionId, seq, maxSeq, AROUND_LINES + 1)
    const rows = [...beforeRows, ...fromRows]
    return { part, exact: rows.some(row => row.seq === seq), lines: rows.map(row => rowLine(parts, row, [], row.seq === seq ? ANCHOR_LINE_MAX : OWN_CHAT_LINE_MAX)) }
  }

  // Without the index: what the user, other Bots, and the Bot itself said, across all
  // parts, oldest first, by reading the logs.
  async function scanOwnChat(botId, query, limit, askingId) {
    const wanted = query.toLowerCase()
    const parts = askingId === undefined ? rt.partsOf(botId) : rt.partsOfThread(botId, askingId)
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
    const lines = []
    let capped = false
    for (const part of [...parts].reverse()) {
      const read = {}
      for await (const line of rt.partLines(part.sessionId, signal, { pages: HISTORY_SCAN_PAGES, read, throughSeq: part.throughSeq })) {
        if (wanted !== '' && !line.text.toLowerCase().includes(wanted)) continue
        lines.push(`[${parts.length > 1 ? `part ${part.number} · ` : ''}${rt.clock(line.time)}] ${excerpt(line.text, wanted)}`)
        if (lines.length >= limit) break
      }
      capped ||= read.capped === true && read.complete !== true
      if (lines.length >= limit) break
    }
    return [...lines.reverse(), ...(capped ? ['(Older messages were not searched.)'] : [])]
  }

  // The parts of a Bot's own chat, for the model: when each ran.
  const partIndex = parts => parts.map(part => `part ${part.number} (${rt.clock(part.startedAt)} – ${part.endedAt === undefined ? 'now' : rt.clock(part.endedAt)})`).join(', ')

  async function ownChatBrief(member) {
    let lines = []
    try { lines = await latestOwnChat(member.id, { limit: OWN_CHAT_BRIEF }) } catch (error) { rt.warn('ds-bot: brief for %s failed: %s', member.name, error) }
    return [
      'Your own chat with the user so far (latest messages, oldest first; private, so share only what the group needs):',
      lines.length > 0 ? lines.join('\n') : 'Nothing yet.',
      'This brief does not change. Call read_own_chat when you need something newer or older from your own chat.',
    ].join('\n')
  }

  Object.assign(rt, { eventsBackwards, searchOwnChat, latestOwnChat, aroundOwnChat, partIndex, ownChatBrief })
}
