// Workspace right-panel backend for the desktop app: read-only workspace file tree,
// multi-format file preview (Markdown, code, text, CSV/TSV tables, images, PDF, HTML,
// and Office via libreoffice-kit), turn change diffs (`ctx.workspaceChanges`), and
// interactive local terminals (`ctx.subprocess.spawnTerminal` with stdio fallback).
// Computer-local only: phone and remote links refuse `workspace-*`, `terminal-*`, and
// `changes-detail` (phone.js, remote.js).
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { within } from './folders.js'

const MAX_LIST_ENTRIES = 500
const MAX_TEXT_BYTES = 512 * 1024
const MAX_BINARY_BYTES = 16 * 1024 * 1024
const MAX_OFFICE_INPUT_BYTES = 32 * 1024 * 1024
const MAX_OFFICE_OUTPUT_BYTES = 24 * 1024 * 1024
const MAX_TERMINALS = 8
const TERMINAL_SCROLLBACK_CHARS = 64 * 1024
const TERMINAL_BATCH_MS = 16
const TERMINAL_GRACE_MS = 3000

const DEFAULT_IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

const IMAGE_MIMES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
])

const OFFICE_EXTS = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.rtf'])
const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown'])
const HTML_EXTS = new Set(['.html', '.htm'])
const TABLE_DELIMITERS = new Map([['.csv', ','], ['.tsv', '\t']])

const CODE_LANGUAGES = new Map([
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'], ['.jsx', 'jsx'],
  ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'], ['.tsx', 'tsx'],
  ['.json', 'json'], ['.jsonc', 'json'], ['.jsonl', 'json'],
  ['.css', 'css'], ['.scss', 'scss'], ['.less', 'less'],
  ['.yml', 'yaml'], ['.yaml', 'yaml'], ['.toml', 'toml'], ['.xml', 'xml'], ['.svg', 'xml'],
  ['.py', 'python'], ['.rb', 'ruby'], ['.go', 'go'], ['.rs', 'rust'], ['.java', 'java'],
  ['.kt', 'kotlin'], ['.swift', 'swift'], ['.c', 'c'], ['.h', 'c'], ['.cpp', 'cpp'], ['.hpp', 'cpp'],
  ['.cs', 'csharp'], ['.php', 'php'], ['.sh', 'bash'], ['.zsh', 'bash'], ['.bash', 'bash'],
  ['.ps1', 'powershell'], ['.sql', 'sql'], ['.graphql', 'graphql'], ['.gql', 'graphql'],
  ['.dockerfile', 'dockerfile'], ['.env', 'dotenv'], ['.ini', 'ini'], ['.conf', 'ini'],
])

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const notFound = message => Object.assign(new Error(message), { code: 'bot/not-found' })
const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })

const toPosixRel = (root, target) => {
  const rel = relative(root, target)
  if (!rel || rel === '.') return ''
  return sep === '/' ? rel : rel.split(sep).join('/')
}

async function readBoundedBytes(filePath, maxBytes) {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(maxBytes + 1)
    let total = 0
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total)
      if (bytesRead <= 0) break
      total += bytesRead
    }
    const truncated = total > maxBytes
    return { bytes: buf.subarray(0, truncated ? maxBytes : total), truncated }
  } finally {
    await handle.close()
  }
}

function hasNullByte(bytes) {
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192))
  return probe.includes(0)
}

function defaultShell() {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec?.trim()
    return [comspec || 'powershell.exe']
  }
  const sh = process.env.SHELL?.trim()
  if (sh && isAbsolute(sh)) return [sh, '-l']
  return ['/bin/sh']
}

function terminalEnv() {
  const out = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    if (/^(DS_BOT_|DSH_|ELECTRON_RUN_AS_NODE)/i.test(key)) continue
    out[key] = value
  }
  out.TERM = 'xterm-256color'
  out.COLORTERM = 'truecolor'
  return out
}

function clampDim(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

async function convertOfficeToPdf(inputRealPath, ext, signal) {
  let kit
  try {
    kit = await import('@deepseek-ai/libreoffice-kit')
  } catch {
    return null
  }
  if (typeof kit?.createConverter !== 'function') return null
  const workDir = await mkdtemp(join(tmpdir(), 'dsb-office-'))
  let converter = null
  try {
    const stagedInput = join(workDir, `source${ext}`)
    const outputPdf = join(workDir, 'preview.pdf')
    await copyFile(inputRealPath, stagedInput)
    converter = await kit.createConverter({
      timeoutMs: 45_000,
      maxInputBytes: MAX_OFFICE_INPUT_BYTES,
      maxOutputBytes: MAX_OFFICE_OUTPUT_BYTES,
    })
    await converter.render({ inputPath: stagedInput, outputPath: outputPdf }, signal)
    const info = await stat(outputPdf)
    if (info.size > MAX_OFFICE_OUTPUT_BYTES) throw invalid('Converted PDF is too large to preview')
    return await readFile(outputPdf)
  } finally {
    await converter?.dispose?.().catch(() => {})
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, { id: string, cwd: string, title: string, pty: boolean, exited: boolean, exitCode: number | null, buffer: string, write: (data: string) => Promise<void>, resize: (cols: number, rows: number) => Promise<void>, terminate: () => Promise<void> }>} */
  const terminals = new Map()
  let disposed = false

  const resolveWorkspaceRoot = async (sessionId) => {
    await rt.load()
    let raw
    if (typeof sessionId === 'string' && sessionId !== '') {
      const room = rt.roomOf(sessionId) ?? rt.roomOf(rt.pastOwners?.get(sessionId)?.roomId)
      if (room !== undefined) {
        raw = rt.workDirOf({ roomId: room.id }) ?? rt.teamFolder()
      } else {
        const bot = rt.botOf(sessionId) ?? rt.botOf(rt.pastOwners?.get(sessionId)?.botId)
        if (bot !== undefined) {
          raw = rt.workDirOf({ botId: bot.id }) ?? rt.teamFolder()
        } else {
          const live = ctx.sessions?.get?.(sessionId)
          if (live !== undefined) raw = rt.sessionFolder(live)
        }
      }
    }
    const base = raw ?? rt.teamFolder() ?? resolve(rt.defaultTeamFolder())
    const realRoot = await rt.real(base)
    if (!(await rt.isFolder(realRoot))) throw notFound('Workspace folder does not exist')
    return realRoot
  }

  const resolveSafeTarget = async (realRoot, inputPath = '') => {
    const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
    if (raw.includes('\0')) throw invalid('Invalid file path')
    const candidate = raw === '' ? realRoot : (isAbsolute(raw) ? resolve(raw) : resolve(realRoot, raw))
    let realTarget
    try {
      realTarget = await realpath(candidate)
    } catch {
      const beyond = await (rt.realBeyond ? rt.realBeyond(candidate) : rt.real(candidate))
      if (!within(beyond, realRoot) || await rt.inData(beyond)) {
        throw refused('Path is outside the active workspace')
      }
      throw notFound('File or folder not found')
    }
    if (!within(realTarget, realRoot) || await rt.inData(realTarget)) {
      throw refused('Path is outside the active workspace')
    }
    return realTarget
  }

  async function workspaceEndpoint(name, body = {}, signal) {
    if (name === 'changes') return changesDetail(body, signal)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    let realRoot
    try {
      realRoot = await resolveWorkspaceRoot(sessionId)
    } catch (error) {
      if (name === 'list' && (body.path ?? '') === '' && error?.code === 'bot/not-found') {
        const fallback = rt.teamFolder() ?? resolve(rt.defaultTeamFolder())
        return { root: fallback, rootName: basename(fallback) || fallback, path: '', entries: [], truncated: false, missing: true }
      }
      throw error
    }

    if (name === 'list') {
      const dirPath = await resolveSafeTarget(realRoot, body.path ?? '')
      const dirInfo = await stat(dirPath)
      if (!dirInfo.isDirectory()) throw invalid('Path is not a folder')
      const includeHidden = body.includeHidden === true
      const rawEntries = await readdir(dirPath, { withFileTypes: true })
      const items = []
      let truncated = false
      for (const entry of rawEntries) {
        if (!includeHidden && (entry.name.startsWith('.') || DEFAULT_IGNORED_NAMES.has(entry.name))) continue
        const full = join(dirPath, entry.name)
        let realEntry
        try {
          realEntry = await realpath(full)
        } catch {
          continue
        }
        if (!within(realEntry, realRoot) || await rt.inData(realEntry)) continue
        let info
        try {
          info = await stat(realEntry)
        } catch {
          continue
        }
        const kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
        if (kind === null) continue
        items.push({
          name: entry.name,
          path: toPosixRel(realRoot, realEntry),
          kind,
          size: kind === 'file' ? info.size : 0,
          mtimeMs: Math.round(info.mtimeMs),
          ext: kind === 'file' ? extname(entry.name).toLowerCase() : '',
        })
      }
      items.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      if (items.length > MAX_LIST_ENTRIES) {
        items.length = MAX_LIST_ENTRIES
        truncated = true
      }
      return {
        root: realRoot,
        rootName: basename(realRoot) || realRoot,
        path: toPosixRel(realRoot, dirPath),
        entries: items,
        truncated,
      }
    }

    if (name === 'read') {
      if (typeof body.path !== 'string' || body.path.trim() === '') throw invalid('A file path is required')
      const target = await resolveSafeTarget(realRoot, body.path)
      const info = await stat(target)
      if (!info.isFile()) throw invalid('Path is not a file')
      const fileName = basename(target)
      const relPath = toPosixRel(realRoot, target)
      const ext = extname(fileName).toLowerCase()

      if (ext === '.pdf') {
        if (info.size > MAX_BINARY_BYTES) {
          return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_BINARY_BYTES }
        }
        const bytes = await readFile(target)
        return { kind: 'pdf', name: fileName, path: relPath, size: info.size, mime: 'application/pdf', base64: bytes.toString('base64') }
      }

      if (IMAGE_MIMES.has(ext) && ext !== '.svg') {
        if (info.size > MAX_BINARY_BYTES) {
          return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_BINARY_BYTES }
        }
        const bytes = await readFile(target)
        return { kind: 'image', name: fileName, path: relPath, size: info.size, mime: IMAGE_MIMES.get(ext), base64: bytes.toString('base64') }
      }

      if (OFFICE_EXTS.has(ext)) {
        if (info.size > MAX_OFFICE_INPUT_BYTES) {
          return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_OFFICE_INPUT_BYTES }
        }
        try {
          const pdfBytes = await convertOfficeToPdf(target, ext, signal)
          if (pdfBytes !== null) {
            return {
              kind: 'pdf',
              convertedFrom: ext,
              name: fileName,
              path: relPath,
              size: info.size,
              mime: 'application/pdf',
              base64: pdfBytes.toString('base64'),
            }
          }
        } catch (error) {
          return { kind: 'office-unavailable', ext, name: fileName, path: relPath, size: info.size, error: error?.message ?? String(error) }
        }
        return { kind: 'office-unavailable', ext, name: fileName, path: relPath, size: info.size }
      }

      const { bytes, truncated } = await readBoundedBytes(target, MAX_TEXT_BYTES)
      if (hasNullByte(bytes)) {
        return { kind: 'binary', name: fileName, path: relPath, size: info.size, ext }
      }
      const text = bytes.toString('utf8')
      if (ext === '.svg') {
        const base64 = info.size <= MAX_BINARY_BYTES && !truncated ? bytes.toString('base64') : null
        return { kind: 'svg', name: fileName, path: relPath, size: info.size, text, truncated, base64, mime: 'image/svg+xml' }
      }
      if (MARKDOWN_EXTS.has(ext)) {
        return { kind: 'markdown', name: fileName, path: relPath, size: info.size, text, truncated }
      }
      if (HTML_EXTS.has(ext)) {
        return { kind: 'html', name: fileName, path: relPath, size: info.size, text, truncated }
      }
      if (TABLE_DELIMITERS.has(ext)) {
        return { kind: 'table', name: fileName, path: relPath, size: info.size, delimiter: TABLE_DELIMITERS.get(ext), text, truncated }
      }
      const language = CODE_LANGUAGES.get(ext) ?? (fileName.toLowerCase() === 'dockerfile' ? 'dockerfile' : fileName.toLowerCase() === 'makefile' ? 'makefile' : null)
      return {
        kind: language ? 'code' : 'text',
        language: language ?? 'text',
        name: fileName,
        path: relPath,
        size: info.size,
        text,
        truncated,
      }
    }

    throw notFound(`Unknown endpoint workspace-${name}`)
  }

  async function changesDetail(body = {}, signal) {
    const service = ctx.get?.('workspaceChanges')
    if (service === undefined) throw notFound('Change review is not available on this host')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const seq = Number(body.seq)
    if (sessionId === '' || !Number.isInteger(seq)) throw invalid('Valid sessionId and seq are required')
    const summary = service.summary(sessionId, seq)
    if (summary === undefined) throw Object.assign(new Error('These changes are no longer available'), { code: 'bot/stale' })
    if (body.index === undefined) {
      return {
        sessionId,
        seq,
        turn: summary.turn,
        cwd: summary.cwd,
        total: summary.total,
        added: summary.added,
        deleted: summary.deleted,
        files: (summary.files ?? []).map((file, index) => ({
          index,
          path: file.path,
          display: file.display ?? file.path,
          added: file.added ?? 0,
          deleted: file.deleted ?? 0,
          ...(file.binary === true ? { binary: true } : {}),
          ...(file.oversized === true ? { oversized: true } : {}),
        })),
      }
    }
    const index = Number(body.index)
    if (!Number.isInteger(index) || index < 0) throw invalid('Valid file index is required')
    const diff = await service.diff(sessionId, seq, index, signal)
    if (diff === undefined) throw Object.assign(new Error('This file diff is no longer available'), { code: 'bot/stale' })
    return diff
  }

  const appendScrollback = (term, chunk) => {
    if (!chunk) return
    const next = term.buffer + chunk
    term.buffer = next.length > TERMINAL_SCROLLBACK_CHARS ? next.slice(next.length - TERMINAL_SCROLLBACK_CHARS) : next
  }

  async function openTerminal(body = {}, signal) {
    if (disposed) throw refused('Host is shutting down')
    if (terminals.size >= MAX_TERMINALS) {
      throw refused(`Too many open terminals (max ${MAX_TERMINALS})`)
    }
    const cwd = await resolveWorkspaceRoot(body.sessionId)
    if (disposed) throw refused('Host is shutting down')
    const cols = clampDim(body.cols, 80, 20, 400)
    const rows = clampDim(body.rows, 24, 6, 120)
    const argv = defaultShell()
    const env = terminalEnv()
    const id = `term-${randomUUID().slice(0, 8)}`
    const title = basename(cwd) || cwd

    const subprocess = ctx.get?.('subprocess')
    let record
    let pendingOut = ''
    let flushTimer = null
    const flush = () => {
      flushTimer = null
      if (pendingOut === '') return
      const chunk = pendingOut
      pendingOut = ''
      rt.publishFeed?.('terminal', { id, chunk })
    }
    const enqueueChunk = (text) => {
      if (!text) return
      appendScrollback(record, text)
      pendingOut += text
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, TERMINAL_BATCH_MS)
        flushTimer.unref?.()
      }
    }
    const onExit = (code) => {
      if (flushTimer !== null) { clearTimeout(flushTimer); flush() }
      record.exited = true
      record.exitCode = typeof code === 'number' ? code : null
      rt.publishFeed?.('terminal-exit', { id, code: record.exitCode })
    }

    if (typeof subprocess?.spawnTerminal === 'function') {
      const handle = await subprocess.spawnTerminal({
        argv,
        cwd,
        env,
        rows,
        cols,
        terminalType: 'xterm-256color',
        graceMs: TERMINAL_GRACE_MS,
        signal,
      })
      if (disposed) {
        await handle.terminate().catch(() => {})
        throw refused('Host is shutting down')
      }
      record = {
        id,
        cwd,
        title,
        pty: true,
        exited: false,
        exitCode: null,
        buffer: '',
        write: data => handle.write(data),
        resize: (c, r) => handle.resize(c, r),
        terminate: async () => {
          if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null }
          await handle.terminate().catch(() => {})
        },
      }
      terminals.set(id, record)
      handle.output.on('data', (chunk) => { enqueueChunk(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')) })
      void handle.done.then(outcome => onExit(outcome?.exitCode ?? null), () => onExit(null))
    } else {
      const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      record = {
        id,
        cwd,
        title,
        pty: false,
        exited: false,
        exitCode: null,
        buffer: '',
        write: async (data) => {
          if (child.stdin?.destroyed || record.exited) return
          child.stdin.write(data)
        },
        resize: async () => {},
        terminate: async () => {
          if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null }
          if (!record.exited) {
            try { child.kill('SIGTERM') } catch { /* already dead */ }
          }
        },
      }
      terminals.set(id, record)
      child.stdout?.on('data', chunk => enqueueChunk(Buffer.from(chunk).toString('utf8')))
      child.stderr?.on('data', chunk => enqueueChunk(Buffer.from(chunk).toString('utf8')))
      child.on('exit', code => onExit(code))
      child.on('error', (error) => {
        enqueueChunk(`\r\n[terminal error: ${error?.message ?? String(error)}]\r\n`)
        onExit(1)
      })
    }

    return { id, cwd, title, cols, rows, pty: record.pty }
  }

  async function terminalEndpoint(name, body = {}, signal) {
    if (name === 'list') {
      return [...terminals.values()].map(term => ({
        id: term.id,
        cwd: term.cwd,
        title: term.title,
        pty: term.pty,
        exited: term.exited,
        exitCode: term.exitCode,
        snapshot: term.buffer,
      }))
    }
    if (name === 'open') return openTerminal(body, signal)
    const id = typeof body.id === 'string' ? body.id : ''
    const term = terminals.get(id)
    if (term === undefined) throw notFound('Unknown terminal')
    if (name === 'input') {
      if (typeof body.data !== 'string') throw invalid('Input data must be a string')
      if (body.data.length > 64 * 1024) throw invalid('Input chunk is too large')
      await term.write(body.data)
      return true
    }
    if (name === 'resize') {
      await term.resize(clampDim(body.cols, 80, 20, 400), clampDim(body.rows, 24, 6, 120))
      return true
    }
    if (name === 'close') {
      terminals.delete(id)
      await term.terminate()
      return true
    }
    throw notFound(`Unknown endpoint terminal-${name}`)
  }

  async function terminalDispose() {
    disposed = true
    const active = [...terminals.values()]
    terminals.clear()
    await Promise.all(active.map(term => term.terminate().catch(() => {})))
  }

  Object.assign(rt, { workspaceEndpoint, changesDetail, terminalEndpoint, terminalDispose })
}
