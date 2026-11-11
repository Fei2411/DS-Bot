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
import { appendFile, mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

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
    if (!writes()) return record
    const line = `${entry.torn ? '\n' : ''}${JSON.stringify(record)}\n`
    entry.torn = false
    entry.size += Buffer.byteLength(line)
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      await mkdir(dir, { recursive: true })
      await appendFile(pathOf(book), line, 'utf8')
    })
    lastWrite.set(book, run)
    writing.set(book, run.catch((error) => {
      rt.warn('ds-bot: a record of %s was not written: %s', book, error?.message ?? error)
      // Memory holds only what the disk has, so a record that did not land is written again
      // when it is sent again. Part of its line may have landed: the next one starts anew.
      if (books.get(book) !== entry) return
      const at = entry.records.indexOf(record)
      if (at !== -1) entry.records.splice(at, 1)
      if (Number.isInteger(record.seq) && entry.bySeq.get(record.seq) === record) entry.bySeq.delete(record.seq)
      entry.torn = true
    }))
    return record
  }

  // Everything appended so far is on disk.
  const flush = async (book) => {
    if (book !== undefined) return writing.get(book)
    await Promise.all(writing.values())
  }

  function drop(book) {
    books.delete(book)
    if (!writes()) return
    const run = (writing.get(book) ?? Promise.resolve()).then(() => rm(pathOf(book), { force: true }))
    writing.set(book, run.catch(() => {}))
  }

  const ledger = {
    open,
    append,
    flush,
    // Rejects when the last record of the book did not reach the disk.
    written: book => lastWrite.get(book) ?? Promise.resolve(),
    drop,
    records: book => open(book).records,
    record: (book, seq) => open(book).bySeq.get(seq),
    after: (book, since) => open(book).records.filter(record => since === undefined || (Number.isInteger(record.seq) && record.seq > since)),
    range: (book, from, to) => open(book).records.filter(record => Number.isInteger(record.seq) && record.seq >= from && (to === undefined || record.seq <= to)),
    lastSeq: (book) => {
      let last = 0
      for (const record of open(book).records) if (Number.isInteger(record.seq) && record.seq > last) last = record.seq
      return last
    },
    // Newest first: every word has to be in the record's text.
    search: (book, query, pick = record => record.text) => {
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      if (words.length === 0) return []
      return open(book).records.filter((record) => {
        const text = pick(record)
        return typeof text === 'string' && words.every(word => text.toLowerCase().includes(word))
      }).slice(-SEARCH_MAX).reverse()
    },
    // How a kind of book is started from what was kept before the ledger: `prefix`
    // is the start of its name, up to and with the first "-".
    importer: (prefix, read) => { importers.set(prefix, read) },
  }
  rt.ledger = ledger
  // What is still on its way to disk lands before the plugin goes.
  rt.ctx?.effect?.(() => () => flush(), 'ds-bot: ledger')
}
