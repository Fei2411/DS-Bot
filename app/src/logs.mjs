// main.log: the main process's console output and the Host's, in the app's own userData
// (%APPDATA%\DS Bot\logs on Windows), redacted before it is written and kept to three
// files of 2 MB (docs/plans/2026-10-26-windows-onboarding.md §3).
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LOG_LIMIT = 2 * 1024 * 1024
export const LOG_FILES = 3
// A line without its end (a progress line redrawn with \r) is written once it gets this long.
const PARTIAL_MAX = 8 * 1024
const TAIL_BLOCK = 16 * 1024

/** main.log, then main.1.log and main.2.log, newest first. */
export const logNames = (count = LOG_FILES) => Array.from({ length: count }, (_, index) => (index === 0 ? 'main.log' : `main.${String(index)}.log`))

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Removes what must not reach a log or a copied report: the launch token, API keys, the query of
 * a sign-in callback and the user's home folder, which names the user.
 * @param {{ home?: string, platform?: string }} [options]
 * @returns {(text: string) => string}
 */
export function redactor({ home = homedir(), platform = process.platform } = {}) {
  const parts = home.split(/[\\/]+/u).filter(Boolean)
  // Any separator, doubled as in JSON, and on Windows any case: the same folder. A home of '/'
  // or '' names nobody.
  const lead = /^[\\/]/u.test(home) ? '[\\\\/]' : ''
  const homePattern = parts.length > 0 ? new RegExp(`${lead}${parts.map(escape).join('[\\\\/]+')}(?=[\\\\/\\s"'\`<>|:;,)\\]}]|$)`, platform === 'win32' ? 'giu' : 'gu') : undefined
  const label = platform === 'win32' ? '%USERPROFILE%' : '~'
  return (text) => {
    let out = text
    if (out.includes('=')) out = out.replace(/(token=)[^&\s"'<>]+/giu, '$1<hidden>')
    if (out.includes('/oauth/callback?')) out = out.replace(/(\/oauth\/callback)\?[^\s"'<>]+/gu, '$1?<hidden>')
    if (out.includes('sk-')) out = out.replace(/\bsk-[A-Za-z0-9][\w-]*/gu, 'sk-<hidden>')
    if (out.includes('Bearer')) out = out.replace(/\b(Bearer\s+)[\w.~+/=-]+/gu, '$1<hidden>')
    if (homePattern !== undefined) out = out.replace(homePattern, label)
    return out
  }
}

/**
 * Splits a chunk of output into whole lines; the rest waits for the next chunk.
 * @returns {{ lines: string[], rest: string }}
 */
export function splitLines(rest, chunk) {
  const pieces = (rest + chunk).split(/\r?\n/u)
  let tail = pieces.pop() ?? ''
  const lines = pieces.map(line => line.replace(/\r/gu, ''))
  if (tail.length > PARTIAL_MAX) {
    lines.push(tail.replace(/\r/gu, ''))
    tail = ''
  }
  return { lines, rest: tail }
}

/** Whether a write of `add` bytes goes into a fresh file. */
export const shouldRotate = (size, add, limit = LOG_LIMIT) => size > 0 && size + add > limit

/** Shifts main.log to main.1.log and so on; the oldest is overwritten. */
export function rotate(dir, count = LOG_FILES) {
  const names = logNames(count)
  for (let index = names.length - 1; index > 0; index -= 1) {
    try {
      renameSync(join(dir, names[index - 1]), join(dir, names[index]))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

/** The last `count` lines of a text. */
export function tailLines(text, count) {
  if (count <= 0) return []
  const lines = text.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-count)
}

function readTail(file, count) {
  const fd = openSync(file, 'r')
  try {
    // After a truncate, retry from the new EOF once; a second truncate must not hide rotations.
    return readTailSnapshot(fd, count) ?? readTailSnapshot(fd, count) ?? ''
  } finally {
    closeSync(fd)
  }
}

function readTailSnapshot(fd, count) {
  const stat = fstatSync(fd)
  if (!stat.isFile()) throw new Error('log is not a file')
  const chunks = []
  let remaining = Math.trunc(count) || Infinity
  for (let end = stat.size; end > 0;) {
    const start = Math.max(0, end - TAIL_BLOCK)
    const chunk = Buffer.allocUnsafe(end - start)
    for (let offset = 0; offset < chunk.length;) {
      const read = readSync(fd, chunk, offset, chunk.length - offset, start + offset)
      if (read === 0) return undefined
      offset += read
    }
    if (end === stat.size && chunk.at(-1) === 10) remaining += 1
    let newline = chunk.length
    while (newline > 0) {
      newline = chunk.lastIndexOf(10, newline - 1)
      if (newline < 0) break
      remaining -= 1
      if (remaining === 0) break
    }
    chunks.push(remaining === 0 ? chunk.subarray(newline + 1) : chunk)
    if (remaining === 0) break
    end = start
  }
  // A UTF-8 code point can span blocks, but cannot contain the LF delimiter.
  return (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks.reverse())).toString('utf8')
}

export class LogFile {
  #dir
  #file
  #fd
  #size = 0
  #limit
  #redact
  #now
  #rests = new Map()
  #broken = false

  /** @param {{ dir: string, limit?: number, redact?: (text: string) => string, now?: () => Date }} options */
  constructor({ dir, limit = LOG_LIMIT, redact = redactor(), now = () => new Date() }) {
    this.#dir = dir
    this.#file = join(dir, logNames()[0])
    this.#limit = limit
    this.#redact = redact
    this.#now = now
  }

  get dir() { return this.#dir }

  /** Redacts sensitive tokens, keys and home paths using this log's redactor. */
  redact(text) { return this.#redact(String(text)) }

  /** Writes the whole lines of a chunk of output, each with the time and its source. */
  write(source, chunk, { redacted = false } = {}) {
    const previous = this.#rests.get(source) ?? ''
    const { lines, rest } = splitLines(previous, String(chunk))
    this.#rests.set(source, rest)
    this.#lines(source, lines, redacted && previous === '')
  }

  /** Writes the lines still waiting for their end. */
  flush() {
    for (const [source, rest] of this.#rests) if (rest !== '') this.#lines(source, [rest], false)
    this.#rests.clear()
  }

  /** The last `count` lines across the files, oldest first, redacted. */
  tail(count) {
    this.flush()
    if (count <= 0) return []
    const chunks = []
    let total = 0
    for (const name of logNames()) {
      let content
      try {
        content = readTail(join(this.#dir, name), count - total)
      } catch {
        break
      }
      const lines = tailLines(content, count - total)
      if (lines.length > 0) {
        chunks.push(lines)
        total += lines.length
      }
      if (total >= count) break
    }
    return chunks.reverse().flat().slice(-count).map(this.#redact)
  }

  close() {
    this.flush()
    if (this.#fd !== undefined) closeSync(this.#fd)
    this.#fd = undefined
  }

  // One write for the lines of a chunk: a chatty Host must not cost a disk write per line on the
  // main (UI) thread. The batch is cut where the file must rotate, so the limit still holds.
  #lines(source, lines, redacted = false) {
    if (this.#broken || lines.length === 0) return
    try {
      if (this.#fd === undefined) this.#open()
      let text = ''
      let bytes = 0
      for (const line of lines) {
        const body = redacted ? line : this.#redact(line)
        const entry = `${this.#now().toISOString()} [${source}] ${body}\n`
        const size = Buffer.byteLength(entry)
        if (shouldRotate(this.#size + bytes, size, this.#limit)) {
          this.#put(text, bytes)
          text = ''
          bytes = 0
          this.#rotate()
        }
        text += entry
        bytes += size
      }
      this.#put(text, bytes)
    } catch {
      // A log that cannot be written must not stop the app.
      this.#broken = true
    }
  }

  #put(text, bytes) {
    if (text === '') return
    // writeSync may take only part of a buffer; the rest of the batch must still reach the file.
    const buffer = Buffer.from(text)
    for (let done = 0; done < buffer.length;) {
      const wrote = writeSync(this.#fd, buffer, done, buffer.length - done)
      if (wrote <= 0) throw new Error('log write made no progress')
      done += wrote
    }
    this.#size += bytes
  }

  #rotate() {
    closeSync(this.#fd)
    this.#fd = undefined
    // Another process can still hold main.log open (the one that relaunched this one);
    // then the file grows past the limit until the next start.
    try { rotate(this.#dir) } catch { /* kept */ }
    this.#open()
  }

  #open() {
    mkdirSync(this.#dir, { recursive: true })
    this.#fd = openSync(this.#file, 'a')
    this.#size = statSync(this.#file).size
  }
}

/**
 * Copies everything the main process writes to stdout and stderr into the log.
 * @returns {{ stdout: (text: string) => void, stderr: (text: string) => void }} writers that bypass the log
 */
export function captureStdio(log, streams = { stdout: process.stdout, stderr: process.stderr }) {
  const raw = {}
  for (const [name, stream] of Object.entries(streams)) {
    // A pipe whose reader went away fails a write later, as an 'error' event; unheard, it
    // would be an uncaught exception, whose own logging fails the same way again (#2171).
    stream.on?.('error', () => { /* no console */ })
    const write = stream.write.bind(stream)
    raw[name] = (text) => { try { write(text) } catch { /* no console */ } }
    stream.write = (chunk, encoding, callback) => {
      log.write('main', typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8'))
      try {
        return write(chunk, encoding, callback)
      } catch {
        // A packaged app on Windows can have no console behind stdout.
        return true
      }
    }
  }
  return raw
}
