// The ledger: what is said in a conversation between Bots, kept by DS Bot itself. Each
// conversation has one book, a file that is only ever appended to, one record per line,
// oldest first. A record is written to its book before anything reads or delivers it; a
// change to it (delivered, answered) is a record of its own, so no line is rewritten.
//
//   <home>/ledger/<book>.jsonl
//
// A book is read whole the first time it is used and then kept in memory, so the
// readers that draw a conversation can stay synchronous. Writes go out in order, one
// queue per book. A window that only reads the team follows the file another host
// writes: it reads a book again when the file has grown.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { replaceFile } from './files.js'
import { searchTextFor } from './search-text.js'

const SEARCH_MAX = 20

// A file name for a book: readable when the id is plain, hashed when it is not.
export const bookFile = (book) => {
  const safe = /^[\w-]{1,160}$/.test(book) ? book : createHash('sha256').update(String(book)).digest('hex').slice(0, 32)
  return `${safe}.jsonl`
}

// Records oldest first. A line cut by an interruption is not a record.
export const parseBook = (text) => {
  const records = []
  for (const row of String(text ?? '').split('\n')) {
    if (row === '') continue
    try {
      const record = JSON.parse(row)
      if (record !== null && typeof record === 'object') records.push(record)
    } catch { /* half-written */ }
  }
  return records
}

export function install(rt) {
  const dir = join(rt.home, 'ledger')
  const pathOf = book => join(dir, bookFile(book))
  const writes = () => rt.readOnly?.() === undefined

  /** @type {Map<string, { records: object[], bySeq: Map<number, object>, size: number }>} */
  const books = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const writing = new Map()
  // The last write of each book as it went, failure included, for a caller that must not
  // go on when its record is not on disk.
  /** @type {Map<string, Promise<unknown>>} */
  const lastWrite = new Map()
  /** @type {Map<string, (book: string) => object[] | undefined>} */
  const importers = new Map()

  const index = (records) => {
    const bySeq = new Map()
    for (const record of records) if (Number.isInteger(record.seq)) bySeq.set(record.seq, record)
    return bySeq
  }
  // What range and anchorAt look up, built on first use. An append adds to it; anything
  // else that changes the records drops it.
  const note = (view, record, at) => {
    if (Number.isInteger(record.seq)) {
      if (record.seq <= view.last) view.ascending = false
      view.first = Math.min(view.first, record.seq)
      view.last = Math.max(view.last, record.seq)
    }
    if (record.event === 'anchor' && !view.anchors.has(record.id)) view.anchors.set(record.id, at)
  }
  const viewOf = (entry) => {
    if (entry.view !== undefined) return entry.view
    const view = { ascending: true, first: Infinity, last: -Infinity, anchors: new Map() }
    entry.records.forEach((record, at) => note(view, record, at))
    entry.view = view
    return view
  }
  const sizeOf = (book) => {
    try { return statSync(pathOf(book)).size } catch { return -1 }
  }

  // The first use of a book reads it. A book that does not exist yet starts from what
  // an importer finds of its conversation from before the ledger (writing hosts only).
  function open(book) {
    const known = books.get(book)
    // A copy read while another host wrote is stale once this host writes.
    if (known !== undefined && (writes() ? !known.readOnly : sizeOf(book) === known.size)) return known
    let text
    let size = -1
    try {
      text = readFileSync(pathOf(book), 'utf8')
      size = Buffer.byteLength(text)
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn('ds-bot: ledger %s could not be read: %s', book, error?.message ?? error)
    }
    let records = text === undefined ? [] : parseBook(text)
    if (text === undefined) {
      const prefix = book.slice(0, book.indexOf('-') + 1)
      const imported = importers.get(prefix)?.(book)
      if (imported !== undefined && imported.length > 0) {
        records = imported
        if (writes()) {
          try {
            mkdirSync(dir, { recursive: true })
            const temp = `${pathOf(book)}.${process.pid}.tmp`
            writeFileSync(temp, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8')
            renameSync(temp, pathOf(book))
            size = sizeOf(book)
          } catch (error) {
            rt.warn('ds-bot: ledger %s could not be started from earlier messages: %s', book, error?.message ?? error)
          }
        }
      }
    }
    // An interruption can leave the last line without its end; the next record starts on a
    // line of its own, or it would join the cut one and be lost with it.
    const entry = { records, bySeq: index(records), size, readOnly: !writes(), torn: text !== undefined && text !== '' && !text.endsWith('\n') }
    books.set(book, entry)
    return entry
  }

  // Appends a record: in memory at once, on disk in order.
  function append(book, record) {
    const entry = open(book)
    entry.records.push(record)
    if (Number.isInteger(record.seq)) entry.bySeq.set(record.seq, record)
    if (entry.view !== undefined) note(entry.view, record, entry.records.length - 1)
    if (!writes()) return record
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      // Construct the line inside the serialized queue so if a prior write failed
      // and set `entry.torn = true`, this write prepends `\n` instead of fusing lines.
      const line = `${entry.torn ? '\n' : ''}${JSON.stringify(record)}\n`
      entry.torn = false
      entry.size += Buffer.byteLength(line)
      await mkdir(dir, { recursive: true })
      await appendFile(pathOf(book), line, 'utf8')
    })
    lastWrite.set(book, run)
    writing.set(book, run.catch((error) => {
      rt.warn('ds-bot: a record of %s was not written: %s', book, error?.message ?? error)
      // Memory holds only what the disk has, so a record that did not land is written again
      // when it is sent again. Part of its line may have landed: the next one starts anew.
      if (books.get(book) !== entry) return
      // Replace the array reference on rollback so incremental readers (`delivery.js`) can
      // detect mutations in O(1) via reference identity.
      entry.records = entry.records.filter(item => item !== record)
      entry.view = undefined
      // An earlier record may hold the same seq; range walks bySeq, so it must find that one.
      if (Number.isInteger(record.seq) && entry.bySeq.get(record.seq) === record) entry.bySeq = index(entry.records)
      entry.torn = true
    }))
    return record
  }

  // Everything appended so far is on disk.
  const flush = async (book) => {
    if (book !== undefined) return writing.get(book)
    await Promise.all(writing.values())
  }

  // Prepends earlier records before what the book already holds, once, oldest first.
  function prepend(book, records) {
    const entry = open(book)
    const added = []
    const seen = new Set()
    for (const record of records) {
      if (!Number.isInteger(record?.seq) || entry.bySeq.has(record.seq) || seen.has(record.seq)) continue
      seen.add(record.seq)
      added.push(record)
    }
    if (added.length === 0) return 0
    added.sort((a, b) => a.seq - b.seq)
    entry.records = [...added, ...entry.records]
    entry.view = undefined
    for (const record of added) entry.bySeq.set(record.seq, record)
    if (!writes()) return added.length
    // Snapshot membership synchronously so later queued appends are NOT included twice,
    // while reading `entry.records` inside the serialized queue excludes any earlier
    // queued append that failed and rolled itself out of memory before this rewrite ran.
    const included = new Set(entry.records)
    let wasTorn = false
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      wasTorn = entry.torn
      const snapshot = entry.records.filter(record => included.has(record)).map(record => `${JSON.stringify(record)}\n`).join('')
      entry.torn = false
      entry.size = Buffer.byteLength(snapshot)
      await mkdir(dir, { recursive: true })
      const temp = `${pathOf(book)}.${process.pid}.tmp`
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, pathOf(book))
    })
    lastWrite.set(book, run)
    writing.set(book, run.catch((error) => {
      rt.warn('ds-bot: earlier records of %s were not written: %s', book, error?.message ?? error)
      if (books.get(book) !== entry) return
      const dropped = new Set(added)
      entry.records = entry.records.filter(record => !dropped.has(record))
      entry.view = undefined
      for (const record of added) if (entry.bySeq.get(record.seq) === record) entry.bySeq.delete(record.seq)
      if (wasTorn) entry.torn = true
    }))
    return added.length
  }

  // Durably merges legacy records (e.g. from state.exchanges) ahead of any newer records
  // in `book`, deduplicating by record.id. Returns true only when every incoming record
  // is confirmed on disk (either already present on an existing book file or atomically
  // written); returns false on write failure so callers keep unmigrated entries fail-closed.
  async function mergeRecords(book, incoming) {
    if (!writes()) return false
    const list = Array.isArray(incoming) ? incoming.filter(record => record !== null && typeof record === 'object') : []
    if (list.length === 0) return true
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      let diskText
      try {
        diskText = readFileSync(pathOf(book), 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const existingOnDisk = diskText !== undefined
      const known = books.get(book)
      const current = known !== undefined && !known.readOnly
        ? known.records.slice()
        : (diskText === undefined ? [] : parseBook(diskText))
      const existingIds = new Set()
      for (const record of current) {
        if (record?.event === undefined && typeof record?.id === 'string' && record.id !== '') {
          existingIds.add(record.id)
        }
      }
      const deduped = []
      const seenIncoming = new Map()
      for (const record of list) {
        if (typeof record.id === 'string' && record.id !== '') {
          if (existingIds.has(record.id)) continue
          const prevAt = seenIncoming.get(record.id)
          if (prevAt !== undefined) deduped[prevAt] = record
          else {
            seenIncoming.set(record.id, deduped.length)
            deduped.push(record)
          }
        } else {
          deduped.push(record)
        }
      }
      if (existingOnDisk && deduped.length === 0) return true
      const merged = deduped.length > 0 ? [...deduped, ...current] : [...current]
      if (merged.length === 0) return true
      const captured = new Set(current)
      const mergedIds = new Set(
        merged.filter(record => record?.event === undefined && typeof record?.id === 'string' && record.id !== '').map(record => record.id),
      )
      const snapshot = merged.map(record => `${JSON.stringify(record)}\n`).join('')
      await mkdir(dir, { recursive: true })
      const temp = `${pathOf(book)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      try {
        await writeFile(temp, snapshot, 'utf8')
        await replaceFile(temp, pathOf(book))
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
      // Preserve any synchronous appends queued after this run while disk I/O was in flight,
      // and keep the existing entry object (replacing only its array ref) so queued appends
      // still update size/rollback on the live entry while pairCache detects the new ref in O(1).
      const live = books.get(book)
      const tail = live !== undefined && !live.readOnly
        ? live.records.filter(record => !captured.has(record) && !(record?.event === undefined && typeof record?.id === 'string' && mergedIds.has(record.id)))
        : []
      const records = tail.length > 0 ? [...merged, ...tail] : merged
      if (live !== undefined && !live.readOnly) {
        live.records = records
        live.bySeq = index(records)
        live.view = undefined
        live.size = Buffer.byteLength(snapshot)
        live.torn = false
      } else {
        books.set(book, {
          records,
          bySeq: index(records),
          size: Buffer.byteLength(snapshot),
          readOnly: false,
          torn: false,
        })
      }
      return true
    })
    lastWrite.set(book, run)
    writing.set(book, run.catch((error) => {
      rt.warn('ds-bot: legacy records of %s were not migrated: %s', book, error?.message ?? error)
    }))
    try {
      return await run
    } catch {
      return false
    }
  }

  function drop(book) {
    books.delete(book)
    lastWrite.delete(book)
    if (!writes()) return
    const run = (writing.get(book) ?? Promise.resolve()).then(() => rm(pathOf(book), { force: true }))
    writing.set(book, run.catch(() => {}))
  }

  const ledger = {
    open,
    append,
    prepend,
    mergeRecords,
    flush,
    // Rejects when the last record of the book did not reach the disk.
    written: book => lastWrite.get(book) ?? Promise.resolve(),
    drop,
    records: book => open(book).records,
    record: (book, seq) => open(book).bySeq.get(seq),
    after: (book, since) => (since === undefined ? [...open(book).records] : ledger.range(book, Math.floor(since) + 1)),
    range: (book, from, to) => {
      const entry = open(book)
      const view = viewOf(entry)
      const start = Math.max(Math.ceil(from), view.first)
      const end = to === undefined ? view.last : Math.min(to, view.last)
      // Walking the seqs finds the same records in the same order only while each seq is
      // there once and in order; a sparse book is quicker to scan.
      if (!view.ascending || end - start > entry.records.length) {
        return entry.records.filter(record => Number.isInteger(record.seq) && record.seq >= from && (to === undefined || record.seq <= to))
      }
      const rows = []
      for (let seq = start; seq <= end; seq += 1) {
        const record = entry.bySeq.get(seq)
        if (record !== undefined) rows.push(record)
      }
      return rows
    },
    // Where the anchor record with this id is in records(book), or -1.
    anchorAt: (book, id) => viewOf(open(book)).anchors.get(id) ?? -1,
    lastSeq: (book) => {
      let last = 0
      for (const record of open(book).records) if (Number.isInteger(record.seq) && record.seq > last) last = record.seq
      return last
    },
    // Newest first: every word has to be in the record's text. Accepts either a `pick`
    // function or `{ pick, filter, limit }`; checks `filter` before lowercasing and stops
    // as soon as `limit` hits are collected from the tail.
    search: (book, query, pickOrOptions) => {
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      if (words.length === 0) return []
      const pick = typeof pickOrOptions === 'function' ? pickOrOptions : (pickOrOptions?.pick ?? (record => record.text))
      const filter = typeof pickOrOptions === 'object' && typeof pickOrOptions?.filter === 'function' ? pickOrOptions.filter : undefined
      const limit = typeof pickOrOptions === 'object' && Number.isInteger(pickOrOptions?.limit) && pickOrOptions.limit > 0 ? pickOrOptions.limit : SEARCH_MAX
      const records = open(book).records
      const lower = searchTextFor(records)
      const hits = []
      for (let at = records.length - 1; at >= 0; at -= 1) {
        const record = records[at]
        if (filter !== undefined && !filter(record)) continue
        const text = pick(record)
        if (typeof text !== 'string' || text === '') continue
        const value = lower(at, text)
        if (words.every(word => value.includes(word))) {
          hits.push(record)
          if (hits.length === limit) break
        }
      }
      return hits
    },
    // How a kind of book is started from what was kept before the ledger: `prefix`
    // is the start of its name, up to and with the first "-".
    importer: (prefix, read) => { importers.set(prefix, read) },
  }
  rt.ledger = ledger
  // What is still on its way to disk lands before the plugin goes.
  rt.ctx?.effect?.(() => () => flush(), 'ds-bot: ledger')
}
