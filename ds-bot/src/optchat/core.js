// OptChat memory for one Bot: an append-only transcript, a binary summary tree over it,
// a historical view that fits a byte budget, and exact search/zoom back to the transcript.
// A JavaScript port of the design in TropMaid's Python OptChat (same node coordinates,
// zoom addresses and free-node rule); written fresh, not copied.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const KINDS = new Set(['user', 'talk', 'tool', 'echo', 'note', 'ai'])
export const DEFAULTS = Object.freeze({
  nodeBytes: 512,
  viewBytes: 64_000,
  toolResultChars: 30_000,
  sizeAttempts: 3,
  retryMs: 10_000,
  // History replacement starts once the replaceable part of a Session's surface is this big.
  replaceAfterBytes: 96_000,
  // The newest user turns that always stay verbatim on the surface.
  keepTurns: 2,
})
// Routing identity shown with a message: context for the reader, never a memory partition.
const TAGS = ['room_id', 'chat_id', 'topic_id', 'sender_id']

export const utf8 = text => Buffer.byteLength(text, 'utf8')

/** Keep head and tail; the same lossy value goes to the transcript and the model. */
export function capResult(text, limit = DEFAULTS.toolResultChars) {
  if (text.length <= limit) return text
  let marker = ''
  for (let round = 0; round < 4; round += 1) marker = `\n[... ${text.length - (limit - marker.length)} characters omitted; head/tail retained ...]\n`
  const kept = limit - marker.length
  return text.slice(0, Math.ceil(kept / 2)) + marker + text.slice(text.length - Math.floor(kept / 2))
}

export const part = (l, i) => ({ l, i, n: 2 ** l, start: i * 2 ** l, end: (i + 1) * 2 ** l })
const keyOf = (l, i) => `${l}:${i}`

export function contextSource(event) {
  const tags = TAGS.filter(key => event.metadata?.[key]).map(key => [key, event.metadata[key]])
  if (tags.length === 0) return `${event.kind}: ${event.text}`
  return `${event.kind}: [source ${JSON.stringify(Object.fromEntries(tags))}] ${event.text}`
}

function validEvent(row) {
  return Number.isInteger(row?.i) && row.i >= 0 && KINDS.has(row.kind) && typeof row.text === 'string'
    && typeof row.date === 'string' && row.size === utf8(`${row.kind}: ${row.text}`)
    && row.metadata !== null && typeof row.metadata === 'object'
    && Object.values(row.metadata).every(value => typeof value === 'string')
}

function validNode(row) {
  return Number.isInteger(row?.l) && Number.isInteger(row?.i) && row.l >= 0 && row.i >= 0
    && typeof row.text === 'string' && row.text.trim() !== '' && row.size === utf8(row.text)
}

const today = () => new Date().toISOString().slice(0, 10)

// Each append reaches the disk (fsync) before it counts: an acknowledged message is never lost.
function appendDurable(path, line) {
  const fd = openSync(path, 'a', 0o600)
  try {
    const data = Buffer.from(line)
    if (writeSync(fd, data) !== data.length) throw new Error('optchat: short append')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function loadStream(dir, check, warn) {
  const files = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort() : []
  const rows = []
  files.forEach((name, fileIndex) => {
    const path = join(dir, name)
    const content = readFileSync(path, 'utf8')
    const lines = content.split('\n')
    lines.forEach((line, number) => {
      if (line.trim() === '') return
      let row
      try { row = JSON.parse(line) } catch {}
      if (row !== undefined && check(row)) { rows.push(row); return }
      // Only the last file's unterminated last line can be a crash-torn append: it is kept
      // as written, skipped, and closed with a newline so later appends start clean.
      const torn = fileIndex === files.length - 1 && number === lines.length - 1 && !content.endsWith('\n')
      if (!torn) throw new Error(`optchat: corrupt record at ${path}:${number + 1}`)
      warn(`optchat: torn final record kept and skipped: ${path}:${number + 1}`)
      appendDurable(path, '\n')
    })
  })
  return rows
}

const owners = new Map()

function lock(dir) {
  const path = join(dir, 'lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => { try { unlinkSync(path) } catch {} }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const pid = Number(readFileSync(path, 'utf8'))
      let alive = false
      try { process.kill(pid, 0); alive = true } catch (probe) { alive = probe?.code === 'EPERM' }
      if (alive && pid !== process.pid) throw new Error(`optchat: another writer (pid ${pid}) owns ${dir}`)
      if (alive) throw new Error(`optchat: ${dir} is already open in this process`)
      unlinkSync(path)
    }
  }
  throw new Error(`optchat: cannot lock ${dir}`)
}

/** One Bot's memory directory. Only one writer may own a directory at a time. */
export class Namespace {
  constructor(dir, { warn = () => {} } = {}) {
    this.dir = dir
    mkdirSync(join(dir, 'main'), { recursive: true })
    mkdirSync(join(dir, 'tree'), { recursive: true })
    this.unlock = lock(dir)
    try {
      this.events = loadStream(join(dir, 'main'), validEvent, warn).sort((a, b) => a.i - b.i)
      if (this.events.some((event, index) => event.i !== index)) throw new Error('optchat: transcript IDs are duplicated, missing or out of order')
      this.keys = new Map()
      for (const event of this.events) if (event.metadata.key) this.keys.set(event.metadata.key, event.i)
      this.nodes = new Map()
      for (const node of loadStream(join(dir, 'tree'), validNode, warn).sort((a, b) => a.l - b.l || a.i - b.i)) this.publish(node)
    } catch (error) {
      this.unlock()
      throw error
    }
  }

  close() { this.unlock() }

  /**
   * Append one message. A `key` makes the append idempotent: a key already present returns
   * the earlier event and writes nothing.
   */
  append(kind, text, { metadata = {}, date, key } = {}) {
    if (key !== undefined && this.keys.has(key)) return { event: this.events[this.keys.get(key)], added: false }
    const meta = { ...metadata, ...(key === undefined ? {} : { key }) }
    const event = { i: this.events.length, kind, text, size: utf8(`${kind}: ${text}`), date: date ?? new Date().toISOString(), metadata: meta }
    if (!validEvent(event)) throw new Error('optchat: invalid event')
    appendDurable(join(this.dir, 'main', `${today()}.jsonl`), `${JSON.stringify(event)}\n`)
    this.events.push(event)
    if (key !== undefined) this.keys.set(key, event.i)
    return { event, added: true }
  }

  publish(node) {
    const p = part(node.l, node.i)
    if (p.end > this.events.length || this.nodes.has(keyOf(node.l, node.i))) throw new Error('optchat: summary range missing or duplicate')
    if (node.l > 0 && !this.children(p).every(child => this.has(child))) throw new Error('optchat: parent saved before its children')
    this.nodes.set(keyOf(node.l, node.i), node)
  }

  saveNode(node) {
    const row = { l: node.l, i: node.i, text: node.text, size: utf8(node.text) }
    if (!validNode(row)) throw new Error('optchat: empty summary')
    this.publish(row)
    try {
      appendDurable(join(this.dir, 'tree', `${today()}.jsonl`), `${JSON.stringify(row)}\n`)
    } catch (error) {
      this.nodes.delete(keyOf(row.l, row.i))
      throw error
    }
  }

  has(p) { return this.nodes.has(keyOf(p.l, p.i)) }
  node(p) { return this.nodes.get(keyOf(p.l, p.i)) }
  children(p) { return [part(p.l - 1, 2 * p.i), part(p.l - 1, 2 * p.i + 1)] }

  /** What a node summarizes: the message itself for a leaf, its children's summaries above. */
  source(p) {
    if (p.end > this.events.length) return undefined
    if (p.l === 0) return contextSource(this.events[p.i])
    const children = this.children(p)
    if (!children.every(child => this.has(child))) return undefined
    return children.map(child => this.node(child).text).join('\n')
  }

  /** `zoom(id, 1)` is the original message; a wider aligned range opens its two halves. */
  zoom(id, n) {
    if (!Number.isInteger(id) || !Number.isInteger(n) || id < 0 || n < 1 || (n & (n - 1)) !== 0 || id % n !== 0 || id + n > this.events.length) {
      throw new Error(`No aligned binary range ${id}+${n} (transcript has ${this.events.length} messages)`)
    }
    if (n === 1) return `${id}+0|${contextSource(this.events[id])}`
    const p = part(Math.log2(n), id / n)
    const children = this.children(p)
    if (!children.every(child => this.has(child))) throw new Error('That range has not been summarized yet; zoom into a smaller range')
    return children.map(child => `${child.start}+${child.n}|${this.node(child).text.replaceAll('\n', ' ')}`).join('\n')
  }

  date(id) {
    const event = this.events[id]
    if (!Number.isInteger(id) || event === undefined) throw new Error('No message with that ID')
    return event.metadata.date_unknown === 'true' ? `Original date unknown; imported at ${event.date}` : event.date
  }

  /** Messages containing every term, newest first. */
  search(query, limit = 10) {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    const hits = []
    for (let i = this.events.length - 1; i >= 0 && hits.length < limit; i -= 1) {
      const event = this.events[i]
      const text = event.text.toLowerCase()
      if (!terms.every(term => text.includes(term))) continue
      const at = Math.max(0, text.indexOf(terms[0]) - 80)
      hits.push({ id: i, kind: event.kind, date: this.date(i), snippet: event.text.slice(at, at + 240).replaceAll('\n', ' ') })
    }
    return hits
  }

  /**
   * The settled historical view of messages [0, limit): built leaves up to the first unbuilt
   * one, with the oldest sibling pairs merged into their parents until the view fits.
   */
  view(limit = this.events.length, budget = DEFAULTS.viewBytes) {
    const parts = []
    for (let i = 0; i < Math.min(limit, this.events.length) && this.has(part(0, i)); i += 1) parts.push(part(0, i))
    const covered = parts.length
    const sizeOf = p => this.node(p).size
    let size = parts.reduce((total, p) => total + sizeOf(p), 0)
    while (size > budget) {
      let merged = false
      for (let k = 0; k + 1 < parts.length; k += 1) {
        const [a, b] = [parts[k], parts[k + 1]]
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue
        const parent = part(a.l + 1, a.i / 2)
        if (parent.end > covered || !this.has(parent)) continue
        size += sizeOf(parent) - sizeOf(a) - sizeOf(b)
        parts.splice(k, 2, parent)
        merged = true
        break
      }
      if (!merged) break
    }
    return { parts, covered, size, fits: size <= budget }
  }

  render(view) {
    return view.parts.map(p => `${p.start}+${p.n}|${this.node(p).text.replaceAll('\n', ' ')}`).join('\n')
  }
}

/** Open a directory once per process; later calls share it. */
export function openNamespace(dir, options) {
  let ns = owners.get(dir)
  if (ns === undefined) {
    ns = new Namespace(dir, options)
    owners.set(dir, ns)
  }
  return ns
}

export function closeNamespace(dir) {
  owners.get(dir)?.close()
  owners.delete(dir)
}
