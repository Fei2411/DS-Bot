// Workspace right-panel backend for the desktop app: read-only workspace file tree,
// multi-format file preview (Markdown, code, text, CSV/TSV tables, images, PDF, HTML,
// and Office via libreoffice-kit), turn change diffs (`workspace-changes` via
// `ctx.workspaceChanges`), and interactive local terminals (`ctx.subprocess.spawnTerminal`
// with process-group stdio fallback).
// Computer-local only: phone and remote links refuse `workspace-*` and `terminal-*`
// (phone.js, remote.js), and terminal output rides local SSE only (`publishLocalFeed`).
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { watch as fsWatch } from 'node:fs'
import { copyFile, mkdtemp, open, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { within } from './folders.js'
import { parseXlsxBuffer } from './xlsx-preview.js'

const MAX_LIST_ENTRIES = 500
const PARALLEL_LIST_INSPECTS = 8
const MAX_TEXT_BYTES = 512 * 1024
const MAX_BINARY_BYTES = 16 * 1024 * 1024
const MAX_OFFICE_INPUT_BYTES = 32 * 1024 * 1024
const MAX_OFFICE_OUTPUT_BYTES = 24 * 1024 * 1024
const MAX_OFFICE_CONVERSIONS = 2
const MAX_TERMINALS = 8
const MAX_WATCHES = 16
const MAX_WATCH_ROOTS = 8
const MAX_WATCH_DIRS = 32
const MAX_WATCH_PATHS_PER_EVENT = 64
const MAX_POLL_DIR_ENTRIES = MAX_LIST_ENTRIES
const WATCH_DEBOUNCE_MS = 180
const WATCH_MAX_WAIT_MS = 900
const WATCH_POLL_MS = 1_500
const ORPHAN_WATCH_GRACE_MS = 30_000
const OPEN_OS_STDERR_BYTES = 4 * 1024
const OPEN_OS_SETTLE_MS = 1_500
const OPEN_OS_EXIT_TIMEOUT_MS = 10_000
const TERMINAL_SCROLLBACK_CHARS = 64 * 1024
const TERMINAL_SCROLLBACK_PART_CHARS = 4096
const TERMINAL_BATCH_MS = 16
const TERMINAL_GRACE_MS = 3000
const DIFF_TIMEOUT_MS = 30_000

const DEFAULT_IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])
const XLSX_EXTS = new Set(['.xlsx', '.xlsm'])
const SENSITIVE_ENV_RE = /KEY|PASSWORD|SECRET|TOKEN/i
const STRIPPED_ENV_RE = /^(DS_BOT_|DSBOT_|DSH_|ELECTRON_RUN_AS_NODE$|ACP_BACKEND$|DEEPSEEK_|ANTIGRAVITY_|AGY_)/i

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

const withinRoot = (inner, outer) => (process.platform === 'win32'
  ? within(inner.toLowerCase(), outer.toLowerCase())
  : within(inner, outer))

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

// Explicit env layer for `ctx.subprocess.spawnTerminal`: lets DSH's `scrubbedParentEnv()`
// strip credentials and forward proxy settings, then adds `undefined` tombstones for
// DS Bot / Electron / agent harness prefixes that `scrubbedParentEnv()` does not strip.
function ptyEnvOverrides() {
  const overrides = { COLORTERM: 'truecolor' }
  for (const key of Object.keys(process.env)) {
    if (STRIPPED_ENV_RE.test(key)) overrides[key] = undefined
  }
  return overrides
}

// Full scrubbed env for the `child_process.spawn` fallback when `ctx.subprocess` is absent.
function fallbackTerminalEnv() {
  const out = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    if (SENSITIVE_ENV_RE.test(key) || STRIPPED_ENV_RE.test(key)) continue
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

let activeOfficeConversions = 0

async function convertOfficeToPdf(inputRealPath, ext, signal) {
  if (signal?.aborted) throw Object.assign(new Error('Conversion cancelled'), { code: 'bot/aborted' })
  if (activeOfficeConversions >= MAX_OFFICE_CONVERSIONS) {
    return { status: 'unavailable', error: 'Office preview is busy' }
  }
  let kit
  try {
    kit = await import('@deepseek-ai/libreoffice-kit')
  } catch {
    return { status: 'unavailable' }
  }
  if (typeof kit?.createConverter !== 'function') return { status: 'unavailable' }
  activeOfficeConversions += 1
  let workDir = null
  let converter = null
  try {
    if (signal?.aborted) throw Object.assign(new Error('Conversion cancelled'), { code: 'bot/aborted' })
    workDir = await mkdtemp(join(tmpdir(), 'dsb-office-'))
    const stagedInput = join(workDir, `source${ext}`)
    const outputPdf = join(workDir, 'preview.pdf')
    await copyFile(inputRealPath, stagedInput)
    if (signal?.aborted) throw Object.assign(new Error('Conversion cancelled'), { code: 'bot/aborted' })
    converter = await kit.createConverter({
      timeoutMs: 45_000,
      maxInputBytes: MAX_OFFICE_INPUT_BYTES,
      maxOutputBytes: MAX_OFFICE_OUTPUT_BYTES,
    })
    await converter.render({ inputPath: stagedInput, outputPath: outputPdf }, signal)
    const info = await stat(outputPdf)
    if (info.size > MAX_OFFICE_OUTPUT_BYTES) {
      return { status: 'too-large', size: info.size, maxBytes: MAX_OFFICE_OUTPUT_BYTES }
    }
    const { bytes, truncated } = await readBoundedBytes(outputPdf, MAX_OFFICE_OUTPUT_BYTES)
    if (truncated) return { status: 'too-large', size: info.size, maxBytes: MAX_OFFICE_OUTPUT_BYTES }
    return { status: 'ok', bytes }
  } finally {
    activeOfficeConversions = Math.max(0, activeOfficeConversions - 1)
    await converter?.dispose?.().catch(() => {})
    if (workDir !== null) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

function scrubbedOpenEnv(extra = {}) {
  const out = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    if (SENSITIVE_ENV_RE.test(key) || STRIPPED_ENV_RE.test(key)) continue
    out[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== 'string') continue
    const lower = key.toLowerCase()
    for (const existing of Object.keys(out)) {
      if (existing !== key && existing.toLowerCase() === lower) delete out[existing]
    }
    out[key] = value
  }
  return out
}

// Keep double quotes out of `-Command` so `powershell.exe` command-line parsing never strips them.
// Explicitly check existence, trap `Invoke-Item` errors, write a single readable line to Win32 stderr,
// and `exit 1` so Windows PowerShell 5.1 never silently exits 0 on open failures.
const WIN_OPEN_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  '$p = $env:DSB_OPEN_TARGET',
  "try { if ([string]::IsNullOrEmpty($p) -or -not (Test-Path -LiteralPath $p)) { [Console]::Error.WriteLine('Cannot find path: ' + $p); exit 1 }; Invoke-Item -LiteralPath $p -ErrorAction Stop; if (-not $?) { [Console]::Error.WriteLine('Failed to open path: ' + $p); exit 1 } } catch { $m = $null; if ($_.Exception -and $_.Exception.ErrorRecord -and $_.Exception.ErrorRecord.Exception) { $m = $_.Exception.ErrorRecord.Exception.Message } elseif ($_.Exception) { $m = $_.Exception.Message }; if ([string]::IsNullOrWhiteSpace($m)) { $m = $_.ToString() }; if ([string]::IsNullOrWhiteSpace($m)) { $m = 'Failed to open path: ' + $p }; [Console]::Error.WriteLine($m); exit 1 }",
].join('; ')

export function buildOpenOsCommand(target, action, isDirectory, platform = process.platform) {
  if (platform === 'darwin') {
    return {
      command: 'open',
      args: action === 'reveal' ? ['-R', target] : [target],
      options: { detached: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false, env: scrubbedOpenEnv() },
      waitForExit: true,
    }
  }
  if (platform === 'win32') {
    if (action === 'reveal') {
      if (isDirectory) {
        return {
          command: 'explorer.exe',
          args: [target],
          options: { detached: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false, env: scrubbedOpenEnv() },
          allowExit1: true,
        }
      }
      // Explorer expects `/select,"C:\path\with spaces,commas"` verbatim on its command line.
      const safe = target.replace(/"/g, '')
      return {
        command: 'explorer.exe',
        args: [`/select,"${safe}"`],
        options: { detached: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false, windowsVerbatimArguments: true, env: scrubbedOpenEnv() },
        allowExit1: true,
      }
    }
    // Pass path through an env var + `Invoke-Item -LiteralPath` so `%`, `#`, `[`, `]`,
    // commas, and spaces stay literal (`Start-Process` has no `-LiteralPath` parameter).
    // Omit `detached: true` here so libuv applies `CREATE_NO_WINDOW` with `windowsHide: true`
    // and reliably delivers stderr + exit status (`Invoke-Item` already hands off to the shell).
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', WIN_OPEN_COMMAND],
      options: {
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
        windowsHide: true,
        env: scrubbedOpenEnv({ DSB_OPEN_TARGET: target }),
      },
      waitForExit: true,
    }
  }
  return {
    command: 'xdg-open',
    args: [action === 'reveal' && !isDirectory ? dirname(target) : target],
    options: { detached: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false, env: scrubbedOpenEnv() },
    waitForExit: false,
  }
}

export function openOsPath(target, action, isDirectory, opts = {}) {
  const spec = buildOpenOsCommand(target, action, isDirectory, opts.platform ?? process.platform)
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn
  const settleMs = Number.isFinite(opts.settleMs) && opts.settleMs >= 0
    ? opts.settleMs
    : (spec.waitForExit ? OPEN_OS_EXIT_TIMEOUT_MS : OPEN_OS_SETTLE_MS)

  return new Promise((resolveOpen, rejectOpen) => {
    let settled = false
    let timer = null
    let stderrText = ''
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
    const finishOk = () => {
      if (settled) return
      settled = true
      cleanup()
      resolveOpen(true)
    }
    const finishErr = (error) => {
      if (settled) return
      settled = true
      cleanup()
      rejectOpen(error)
    }

    let child
    try {
      child = spawnFn(spec.command, spec.args, spec.options)
    } catch (error) {
      finishErr(error)
      return
    }

    child.stderr?.on?.('data', (chunk) => {
      if (stderrText.length >= OPEN_OS_STDERR_BYTES) return
      const piece = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      stderrText += piece.slice(0, OPEN_OS_STDERR_BYTES - stderrText.length)
    })

    child.once('error', (error) => {
      finishErr(error)
    })

    child.once('close', (code, signal) => {
      if (settled) return
      const trimmedErr = stderrText.trim()
      if (code === 0 || (spec.allowExit1 && code === 1 && trimmedErr === '')) {
        finishOk()
        return
      }
      const reason = code !== null && code !== undefined
        ? `exited with code ${code}`
        : (signal ? `terminated by ${signal}` : 'exited with code unknown')
      finishErr(new Error(trimmedErr || `Failed to open path (${spec.command} ${reason})`))
    })

    child.once('spawn', () => {
      if (settled) return
      timer = setTimeout(() => {
        timer = null
        if (settled) return
        child.stderr?.resume?.()
        child.stderr?.destroy?.()
        child.unref?.()
        finishOk()
      }, settleMs)
      timer.unref?.()
    })
  })
}

const isWatchLimitError = error => error?.code === 'ENOSPC' || error?.code === 'EMFILE' || error?.code === 'ENOSYS'

function isIgnoredWatchRel(rel) {
  if (!rel) return false
  const parts = rel.replace(/\\/g, '/').split('/')
  for (const part of parts) {
    if (DEFAULT_IGNORED_NAMES.has(part)) return true
  }
  return false
}

export function install(rt) {
  const { ctx } = rt
  /** @type {Map<string, { id: string, cwd: string, title: string, pty: boolean, exited: boolean, closed: boolean, exitCode: number | null, buffer: string, parts: { seq: number, text: string }[], startSeq: number, endSeq: number, write: (data: string) => Promise<void>, resize: (cols: number, rows: number) => Promise<void>, terminate: () => Promise<void> }>} */
  const terminals = new Map()
  const rootWatches = new Map()
  const watchSessions = new Map()
  const inFlightWatchOps = new Set()
  /** @type {Set<Promise<void>>} */
  const inFlightSpawns = new Set()
  let reservedSlots = 0
  let disposed = false
  let orphanWatchTimer = null

  const rootKeyOf = (root) => {
    const plat = typeof rt.watchPlatform === 'string' ? rt.watchPlatform : process.platform
    return plat === 'win32' ? root.toLowerCase() : root
  }

  const closeRootWatch = (rootWatch) => {
    if (!rootWatch || rootWatch.closed) return
    rootWatch.closed = true
    if (rootWatch.debounceTimer !== null) {
      clearTimeout(rootWatch.debounceTimer)
      rootWatch.debounceTimer = null
    }
    if (rootWatch.maxWaitTimer !== null) {
      clearTimeout(rootWatch.maxWaitTimer)
      rootWatch.maxWaitTimer = null
    }
    if (rootWatch.pollTimer !== null) {
      clearInterval(rootWatch.pollTimer)
      rootWatch.pollTimer = null
    }
    rootWatch.dirtyPaths.clear()
    rootWatch.pollSnapshot.clear()
    for (const watcher of rootWatch.watchers.values()) {
      try { watcher.close() } catch { /* ignore close errors */ }
    }
    rootWatch.watchers.clear()
    for (const session of [...rootWatch.sessions]) {
      session.closed = true
      watchSessions.delete(session.id)
    }
    rootWatch.sessions.clear()
    if (rootWatches.get(rootWatch.key) === rootWatch) rootWatches.delete(rootWatch.key)
  }

  const trackWatchOp = (promise) => {
    const tracked = Promise.resolve(promise).catch(() => {}).finally(() => {
      inFlightWatchOps.delete(tracked)
    })
    inFlightWatchOps.add(tracked)
    return tracked
  }

  const closeAllWatches = async () => {
    if (orphanWatchTimer !== null) {
      clearTimeout(orphanWatchTimer)
      orphanWatchTimer = null
    }
    for (const rootWatch of [...rootWatches.values()]) closeRootWatch(rootWatch)
    watchSessions.clear()
    if (inFlightWatchOps.size > 0) {
      await Promise.allSettled([...inFlightWatchOps])
    }
    for (const rootWatch of [...rootWatches.values()]) closeRootWatch(rootWatch)
    watchSessions.clear()
  }

  const offLocalClients = typeof rt.onLocalFeedClients === 'function'
    ? rt.onLocalFeedClients((count) => {
      if (count > 0) {
        if (orphanWatchTimer !== null) {
          clearTimeout(orphanWatchTimer)
          orphanWatchTimer = null
        }
        return
      }
      if (rootWatches.size === 0 || orphanWatchTimer !== null) return
      const graceMs = Number.isFinite(rt.workspaceWatchOrphanGraceMs) && rt.workspaceWatchOrphanGraceMs >= 0
        ? rt.workspaceWatchOrphanGraceMs
        : ORPHAN_WATCH_GRACE_MS
      orphanWatchTimer = setTimeout(() => {
        orphanWatchTimer = null
        if (typeof rt.localFeedClientCount === 'function' && rt.localFeedClientCount() > 0) return
        void closeAllWatches()
      }, graceMs)
      orphanWatchTimer.unref?.()
    })
    : null

  const emitLocal = (event, data) => {
    if (typeof rt.publishLocalFeed === 'function') rt.publishLocalFeed(event, data)
  }

  // Mirror folders.js's team-workspace exception strictly when `defaultTeamFolder()` is used
  // before `ensureWorkspace()` registers `state.workspaceId`: only a default workspace lying
  // strictly inside a data root is exempted; an ancestor containing a data root never opens it up.
  const isProtectedData = async (target) => {
    if (!(await rt.inData(target))) return false
    if (rt.teamFolder() !== undefined) return true
    const defaultWs = await rt.real(resolve(rt.defaultTeamFolder()))
    if (!withinRoot(target, defaultWs)) return true
    for (const root of [rt.dshHome, rt.home, process.env.DS_BOT_USER_DSH_HOME?.trim()].filter(Boolean)) {
      const data = await rt.real(root)
      if (withinRoot(target, data) && !(defaultWs !== data && withinRoot(defaultWs, data))) return true
    }
    return false
  }

  const resolveWorkspaceRoot = async (sessionId) => {
    await rt.load()
    let raw
    if (typeof sessionId === 'string' && sessionId !== '') {
      // Prefer the live session's active working directory (honors `working_directory` subfolder moves).
      const live = ctx.sessions?.get?.(sessionId)
      if (live !== undefined) raw = rt.sessionFolder?.(live)
      if (raw === undefined) {
        const room = rt.roomOf(sessionId)
        if (room !== undefined) {
          raw = rt.workDirOf({ roomId: room.id }) ?? rt.teamFolder()
        } else {
          // Check room-scoped owners before `selfOf` so non-live group/task sessions keep `roomId`.
          const owner = rt.groupOwners?.get(sessionId) ?? rt.taskOwners?.get(sessionId) ?? rt.pastOwners?.get(sessionId)
          if (owner?.roomId !== undefined || owner?.botId !== undefined) {
            raw = rt.workDirOf({ roomId: owner.roomId, botId: owner.botId ?? rt.selfOf?.(sessionId) }) ?? rt.teamFolder()
          } else {
            const selfBotId = rt.selfOf?.(sessionId)
            if (selfBotId !== undefined) {
              raw = rt.workDirOf({ botId: selfBotId }) ?? rt.teamFolder()
            } else {
              const bot = rt.botOf(sessionId)
              if (bot !== undefined) raw = rt.workDirOf({ botId: bot.id }) ?? rt.teamFolder()
            }
          }
        }
      }
    }
    const base = raw ?? rt.teamFolder() ?? resolve(rt.defaultTeamFolder())
    const realRoot = await rt.real(base)
    if (await isProtectedData(realRoot)) throw refused('Workspace folder is inside protected data')
    if (!(await rt.isFolder(realRoot))) throw notFound('Workspace folder does not exist')
    return realRoot
  }

  const resolveSafeTarget = async (realRoot, inputPath = '') => {
    const raw = typeof inputPath === 'string' ? inputPath : ''
    if (raw.includes('\0')) throw invalid('Invalid file path')
    const candidate = raw === '' ? realRoot : (isAbsolute(raw) ? resolve(raw) : resolve(realRoot, raw))
    let realTarget
    try {
      realTarget = await realpath(candidate)
    } catch {
      const beyond = await (rt.realBeyond ? rt.realBeyond(candidate) : rt.real(candidate))
      if (!withinRoot(beyond, realRoot) || await isProtectedData(beyond)) {
        throw refused('Path is outside the active workspace')
      }
      throw notFound('File or folder not found')
    }
    if (!withinRoot(realTarget, realRoot) || await isProtectedData(realTarget)) {
      throw refused('Path is outside the active workspace')
    }
    return realTarget
  }

  // One listing row for a folder entry, or undefined when the entry is gone, escapes the
  // workspace, is protected data, is neither a file nor a folder, or is a folder symlink.
  const listEntry = async (realRoot, dirPath, entry) => {
    const full = join(dirPath, entry.name)
    let realEntry
    try {
      realEntry = await realpath(full)
    } catch {
      return undefined
    }
    if (!withinRoot(realEntry, realRoot) || await isProtectedData(realEntry)) return undefined
    let info
    try {
      info = await stat(realEntry)
    } catch {
      return undefined
    }
    const kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
    if (kind === null) return undefined
    // Skip directory symlinks to prevent cyclic trees and duplicate branch identities.
    if (entry.isSymbolicLink() && kind === 'dir') return undefined
    return {
      name: entry.name,
      path: toPosixRel(realRoot, full),
      kind,
      size: kind === 'file' ? info.size : 0,
      mtimeMs: Math.round(info.mtimeMs),
      ext: kind === 'file' ? extname(entry.name).toLowerCase() : '',
    }
  }

  async function watchWorkspace(realRoot, body = {}) {
    if (disposed) throw refused('Host is shutting down')
    const requestedId = typeof body.watchId === 'string' && body.watchId.trim() !== '' ? body.watchId.trim() : null
    const extraDirs = Array.isArray(body.dirs)
      ? body.dirs.filter(d => typeof d === 'string' && d !== '' && !isIgnoredWatchRel(d)).slice(0, MAX_WATCH_DIRS)
      : []
    const watchFn = typeof rt.watchWorkspaceDir === 'function' ? rt.watchWorkspaceDir : fsWatch
    const platform = typeof rt.watchPlatform === 'string' ? rt.watchPlatform : process.platform
    const allowRecursive = platform === 'darwin' || platform === 'win32'
    const debounceMs = Number.isFinite(rt.workspaceWatchDebounceMs) && rt.workspaceWatchDebounceMs >= 0
      ? rt.workspaceWatchDebounceMs
      : WATCH_DEBOUNCE_MS
    const maxWaitMs = Number.isFinite(rt.workspaceWatchMaxWaitMs) && rt.workspaceWatchMaxWaitMs >= debounceMs
      ? rt.workspaceWatchMaxWaitMs
      : Math.max(debounceMs * 4, WATCH_MAX_WAIT_MS)
    const pollMs = Number.isFinite(rt.workspaceWatchPollMs) && rt.workspaceWatchPollMs >= 20
      ? rt.workspaceWatchPollMs
      : WATCH_POLL_MS

    const flushRoot = (rootWatch) => {
      if (rootWatch.debounceTimer !== null) {
        clearTimeout(rootWatch.debounceTimer)
        rootWatch.debounceTimer = null
      }
      if (rootWatch.maxWaitTimer !== null) {
        clearTimeout(rootWatch.maxWaitTimer)
        rootWatch.maxWaitTimer = null
      }
      if (rootWatch.closed || disposed || rootWatch.sessions.size === 0) {
        rootWatch.dirtyPaths.clear()
        rootWatch.overflow = false
        return
      }
      const paths = [...rootWatch.dirtyPaths]
      const overflow = rootWatch.overflow
      rootWatch.dirtyPaths.clear()
      rootWatch.overflow = false
      const watchIds = [...rootWatch.sessions].map(s => s.id)
      emitLocal('workspace-changed', {
        watchId: watchIds[0] ?? null,
        watchIds,
        root: rootWatch.root,
        paths,
        overflow,
      })
    }

    const queueChange = (rootWatch, rel) => {
      if (rootWatch.closed || disposed) return
      if (rel && isIgnoredWatchRel(rel)) return
      if (rel) {
        if (rootWatch.dirtyPaths.size < MAX_WATCH_PATHS_PER_EVENT) rootWatch.dirtyPaths.add(rel)
        else rootWatch.overflow = true
      }
      if (rootWatch.debounceTimer !== null) clearTimeout(rootWatch.debounceTimer)
      rootWatch.debounceTimer = setTimeout(() => { flushRoot(rootWatch) }, debounceMs)
      rootWatch.debounceTimer.unref?.()
      if (rootWatch.maxWaitTimer === null) {
        rootWatch.maxWaitTimer = setTimeout(() => { flushRoot(rootWatch) }, maxWaitMs)
        rootWatch.maxWaitTimer.unref?.()
      }
    }

    const unionDirsOf = (rootWatch) => {
      const merged = new Set()
      for (const session of rootWatch.sessions) {
        for (const d of session.dirs) {
          if (merged.size >= MAX_WATCH_DIRS) break
          merged.add(d)
        }
      }
      return [...merged]
    }

    const maxPollEntries = Number.isInteger(rt.workspaceWatchPollMaxEntries) && rt.workspaceWatchPollMaxEntries > 0
      ? rt.workspaceWatchPollMaxEntries
      : MAX_POLL_DIR_ENTRIES

    const dirFingerprint = async (dirAbs, rootWatch) => {
      const dirInfo = await stat(dirAbs)
      const entries = await readdir(dirAbs, { withFileTypes: true })
      const visibleNames = []
      for (const entry of entries) {
        if (DEFAULT_IGNORED_NAMES.has(entry.name)) continue
        visibleNames.push(entry.name)
      }
      visibleNames.sort()
      const overflow = visibleNames.length > maxPollEntries
      const bounded = overflow ? visibleNames.slice(0, maxPollEntries) : visibleNames
      const parts = Array.from({ length: bounded.length })
      let next = 0
      const inspect = async () => {
        while (next < bounded.length && !rootWatch.closed && !disposed) {
          const at = next++
          const name = bounded[at]
          try {
            const info = await stat(join(dirAbs, name))
            parts[at] = `${name}:${info.isDirectory() ? 'd' : 'f'}:${info.size}:${Math.round(info.mtimeMs)}`
          } catch { /* entry vanished mid-poll */ }
        }
      }
      await Promise.all(Array.from({ length: Math.min(PARALLEL_LIST_INSPECTS, bounded.length) }, inspect))
      const header = `${Math.round(dirInfo.mtimeMs)}:${visibleNames.length}`
      return {
        fingerprint: `${header}|${parts.filter(Boolean).join('|')}`,
        overflow,
      }
    }

    const switchToPoll = (rootWatch) => {
      if (rootWatch.closed || disposed) return
      for (const watcher of rootWatch.watchers.values()) {
        try { watcher.close() } catch { /* ignore */ }
      }
      rootWatch.watchers.clear()
      rootWatch.mode = 'poll'
      if (rootWatch.pollTimer !== null) return
      let polling = false
      const pollOnce = async () => {
        if (polling || rootWatch.closed || disposed) return
        polling = true
        try {
          const targets = [rootWatch.root]
          for (const relDir of unionDirsOf(rootWatch)) {
            if (rootWatch.closed || disposed) return
            try {
              const resolved = await resolveSafeTarget(rootWatch.root, relDir)
              if (rootWatch.closed || disposed) return
              const info = await stat(resolved)
              if (info.isDirectory()) targets.push(resolved)
            } catch { /* skip missing dir */ }
          }
          const keep = new Set(targets)
          for (const key of [...rootWatch.pollSnapshot.keys()]) {
            if (!keep.has(key)) rootWatch.pollSnapshot.delete(key)
          }
          for (const dirAbs of targets) {
            if (rootWatch.closed || disposed) return
            try {
              const { fingerprint: fp, overflow } = await dirFingerprint(dirAbs, rootWatch)
              if (rootWatch.closed || disposed) return
              const prev = rootWatch.pollSnapshot.get(dirAbs)
              rootWatch.pollSnapshot.set(dirAbs, fp)
              if (prev !== undefined && prev !== fp) {
                if (overflow) rootWatch.overflow = true
                queueChange(rootWatch, toPosixRel(rootWatch.root, dirAbs))
              }
            } catch { /* dir removed */ }
          }
        } finally {
          polling = false
        }
      }
      const initialPoll = trackWatchOp(pollOnce())
      rootWatch.pollTimer = setInterval(() => {
        void trackWatchOp(pollOnce())
      }, pollMs)
      rootWatch.pollTimer.unref?.()
      return initialPoll
    }

    const attachDirWatcher = (rootWatch, dirAbs, relPrefix, recursive) => {
      if (rootWatch.closed || disposed) return false
      if (rootWatch.watchers.has(dirAbs)) return true
      const onChange = (_eventType, filename) => {
        if (rootWatch.closed || disposed) return
        const name = typeof filename === 'string' ? filename : (filename ? String(filename) : '')
        const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
        const rel = relPrefix ? (normalized ? `${relPrefix}/${normalized}` : relPrefix) : normalized
        queueChange(rootWatch, rel)
      }
      const watcher = watchFn(dirAbs, { recursive, persistent: false }, onChange)
      if (rootWatch.closed || disposed) {
        try { watcher.close() } catch { /* ignore */ }
        return false
      }
      watcher.on?.('error', (error) => {
        try { watcher.close() } catch { /* ignore */ }
        rootWatch.watchers.delete(dirAbs)
        if (!rootWatch.closed && !disposed && isWatchLimitError(error)) {
          switchToPoll(rootWatch)
        }
      })
      rootWatch.watchers.set(dirAbs, watcher)
      return true
    }

    const syncDirsForRoot = async (rootWatch) => {
      if (rootWatch.closed || disposed || rootWatch.mode !== 'dirs') return
      const wanted = new Set([rootWatch.root])
      for (const relDir of unionDirsOf(rootWatch)) {
        if (rootWatch.closed || disposed || rootWatch.mode !== 'dirs') return
        if (wanted.size >= MAX_WATCH_DIRS + 1) break
        try {
          const resolved = await resolveSafeTarget(rootWatch.root, relDir)
          if (rootWatch.closed || disposed || rootWatch.mode !== 'dirs') return
          const info = await stat(resolved)
          if (rootWatch.closed || disposed || rootWatch.mode !== 'dirs') return
          if (!info.isDirectory()) continue
          wanted.add(resolved)
          try {
            attachDirWatcher(rootWatch, resolved, toPosixRel(rootWatch.root, resolved), false)
          } catch (error) {
            if (isWatchLimitError(error)) {
              switchToPoll(rootWatch)
              return
            }
            /* skip transient per-dir errors (e.g. ENOENT / EACCES) without downgrading healthy dirs */
          }
        } catch { /* skip missing/invalid dir */ }
      }
      if (rootWatch.closed || disposed || rootWatch.mode !== 'dirs') return
      for (const [watchedAbs, watcher] of [...rootWatch.watchers.entries()]) {
        if (!wanted.has(watchedAbs)) {
          try { watcher.close() } catch { /* ignore */ }
          rootWatch.watchers.delete(watchedAbs)
        }
      }
    }

    const rootKey = rootKeyOf(realRoot)

    // Reuse or replace an existing watch session id.
    const existingSession = requestedId ? watchSessions.get(requestedId) : undefined
    if (existingSession && existingSession.rootKey === rootKey && !existingSession.closed) {
      const rootWatch = rootWatches.get(rootKey)
      if (rootWatch && !rootWatch.closed) {
        existingSession.dirs = new Set(extraDirs)
        existingSession.lastActiveAt = Date.now()
        if (rootWatch.mode === 'dirs') {
          await trackWatchOp(syncDirsForRoot(rootWatch))
        }
        if (disposed || rootWatch.closed || existingSession.closed) {
          if (rootWatch.sessions.size === 0) closeRootWatch(rootWatch)
          return { watchId: null, root: realRoot, recursive: false, mode: 'closed' }
        }
        return {
          watchId: existingSession.id,
          root: rootWatch.root,
          recursive: rootWatch.mode === 'recursive',
          mode: rootWatch.mode,
        }
      }
    }
    if (existingSession) unwatchWorkspace({ watchId: existingSession.id })

    // Bound total watch sessions by evicting the oldest session.
    while (watchSessions.size >= MAX_WATCHES) {
      const oldest = watchSessions.values().next().value
      if (!oldest) break
      unwatchWorkspace({ watchId: oldest.id })
    }

    let rootWatch = rootWatches.get(rootKey)
    const createdRoot = !rootWatch || rootWatch.closed
    if (createdRoot) {
      while (rootWatches.size >= MAX_WATCH_ROOTS) {
        const oldestRoot = rootWatches.values().next().value
        if (!oldestRoot) break
        closeRootWatch(oldestRoot)
      }
      rootWatch = {
        key: rootKey,
        root: realRoot,
        mode: 'dirs',
        watchers: new Map(),
        pollTimer: null,
        pollSnapshot: new Map(),
        sessions: new Set(),
        dirtyPaths: new Set(),
        overflow: false,
        debounceTimer: null,
        maxWaitTimer: null,
        closed: false,
      }
      rootWatches.set(rootKey, rootWatch)
    }

    const id = requestedId ?? `watch-${randomUUID().slice(0, 8)}`
    const session = {
      id,
      rootKey,
      root: realRoot,
      dirs: new Set(extraDirs),
      closed: false,
      lastActiveAt: Date.now(),
    }
    watchSessions.set(id, session)
    rootWatch.sessions.add(session)

    let initialPoll = null
    if (createdRoot) {
      let attached = false
      if (allowRecursive) {
        try {
          attached = attachDirWatcher(rootWatch, realRoot, '', true)
          if (attached) rootWatch.mode = 'recursive'
        } catch {
          attached = false
        }
      }
      if (!attached && !rootWatch.closed && !disposed) {
        try {
          attached = attachDirWatcher(rootWatch, realRoot, '', false)
          if (attached) rootWatch.mode = 'dirs'
        } catch {
          initialPoll = switchToPoll(rootWatch)
        }
      }
    }

    if (initialPoll) await initialPoll
    if (!rootWatch.closed && !session.closed && !disposed && rootWatch.mode === 'dirs') {
      await trackWatchOp(syncDirsForRoot(rootWatch))
    }

    if (disposed || rootWatch.closed || session.closed) {
      if (rootWatch.sessions.size === 0) closeRootWatch(rootWatch)
      return { watchId: null, root: realRoot, recursive: false, mode: 'closed' }
    }

    return {
      watchId: id,
      root: rootWatch.root,
      recursive: rootWatch.mode === 'recursive',
      mode: rootWatch.mode,
    }
  }

  function unwatchWorkspace(body = {}) {
    const watchId = typeof body.watchId === 'string' ? body.watchId.trim() : ''
    if (watchId === '') return { ok: true, removed: false }
    const session = watchSessions.get(watchId)
    if (!session) return { ok: true, removed: false }
    session.closed = true
    watchSessions.delete(watchId)
    const rootWatch = rootWatches.get(session.rootKey)
    if (rootWatch) {
      rootWatch.sessions.delete(session)
      if (rootWatch.sessions.size === 0) {
        closeRootWatch(rootWatch)
      } else if (rootWatch.mode === 'dirs' && !rootWatch.closed && !disposed) {
        // Drop OS dir watches that were only held by the departing session.
        const wanted = new Set([rootWatch.root])
        for (const other of rootWatch.sessions) {
          for (const relDir of other.dirs) {
            wanted.add(resolve(rootWatch.root, relDir))
          }
        }
        for (const [watchedAbs, watcher] of [...rootWatch.watchers.entries()]) {
          if (!wanted.has(watchedAbs)) {
            try { watcher.close() } catch { /* ignore */ }
            rootWatch.watchers.delete(watchedAbs)
          }
        }
      }
    }
    return { ok: true, removed: true }
  }

  async function workspaceEndpoint(name, body = {}, signal) {
    if (name === 'changes') return changesDetail(body, signal)
    if (name === 'unwatch') return unwatchWorkspace(body)
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

    if (typeof body.expectedRoot === 'string' && body.expectedRoot !== '') {
      const expected = await rt.real(body.expectedRoot)
      const sameRoot = process.platform === 'win32'
        ? expected.toLowerCase() === realRoot.toLowerCase()
        : expected === realRoot
      if (!sameRoot) {
        throw Object.assign(new Error('Workspace folder changed'), { code: 'bot/stale' })
      }
    }

    if (name === 'list') {
      const dirPath = await resolveSafeTarget(realRoot, body.path ?? '')
      const dirInfo = await stat(dirPath)
      if (!dirInfo.isDirectory()) throw invalid('Path is not a folder')
      const includeHidden = body.includeHidden === true
      const rawEntries = await readdir(dirPath, { withFileTypes: true })
      const visible = includeHidden
        ? rawEntries
        : rawEntries.filter(entry => !entry.name.startsWith('.') && !DEFAULT_IGNORED_NAMES.has(entry.name))
      // Inspected in parallel but kept in readdir order, so the stable sort breaks name ties as before.
      const inspected = Array.from({ length: visible.length })
      let next = 0
      const inspector = async () => {
        while (next < visible.length) {
          const at = next++
          inspected[at] = await listEntry(realRoot, dirPath, visible[at])
        }
      }
      await Promise.all(Array.from({ length: Math.min(PARALLEL_LIST_INSPECTS, visible.length) }, inspector))
      const items = inspected.filter(item => item !== undefined)
      let truncated = false
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

    if (name === 'watch') {
      return await watchWorkspace(realRoot, body)
    }

    if (name === 'open') {
      if (body.action !== undefined && body.action !== 'open' && body.action !== 'reveal') {
        throw invalid(`Unsupported workspace open action: ${String(body.action)}`)
      }
      const action = body.action === 'open' ? 'open' : 'reveal'
      const target = await resolveSafeTarget(realRoot, body.path ?? '')
      const info = await stat(target)
      const isDirectory = info.isDirectory()
      if (!isDirectory && !info.isFile()) throw invalid('Path is neither a file nor a folder')
      if (typeof rt.openWorkspacePath === 'function') {
        await rt.openWorkspacePath({ target, root: realRoot, action, isDirectory })
      } else {
        await openOsPath(target, action, isDirectory)
      }
      return { ok: true, action, path: toPosixRel(realRoot, target) }
    }

    if (name === 'read') {
      if (typeof body.path !== 'string' || body.path === '') throw invalid('A file path is required')
      const target = await resolveSafeTarget(realRoot, body.path)
      const info = await stat(target)
      const fileName = basename(target) || basename(realRoot) || realRoot
      const relPath = toPosixRel(realRoot, target)
      if (info.isDirectory()) return { kind: 'dir', name: fileName, path: relPath, root: realRoot }
      if (!info.isFile()) throw invalid('Path is not a file')
      const ext = extname(fileName).toLowerCase()

      if (ext === '.pdf') {
        if (info.size > MAX_BINARY_BYTES) {
          return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_BINARY_BYTES }
        }
        const { bytes, truncated } = await readBoundedBytes(target, MAX_BINARY_BYTES)
        if (truncated) return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_BINARY_BYTES }
        return { kind: 'pdf', name: fileName, path: relPath, size: bytes.length, mime: 'application/pdf', base64: bytes.toString('base64') }
      }

      if (IMAGE_MIMES.has(ext) && ext !== '.svg') {
        if (info.size > MAX_BINARY_BYTES) {
          return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_BINARY_BYTES }
        }
        const { bytes, truncated } = await readBoundedBytes(target, MAX_BINARY_BYTES)
        if (truncated) return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_BINARY_BYTES }
        return { kind: 'image', name: fileName, path: relPath, size: bytes.length, mime: IMAGE_MIMES.get(ext), base64: bytes.toString('base64') }
      }

      if (OFFICE_EXTS.has(ext)) {
        if (info.size > MAX_OFFICE_INPUT_BYTES) {
          return { kind: 'too-large', name: fileName, path: relPath, size: info.size, maxBytes: MAX_OFFICE_INPUT_BYTES }
        }
        if (XLSX_EXTS.has(ext) && body.format !== 'pdf') {
          try {
            const { bytes, truncated } = await readBoundedBytes(target, MAX_OFFICE_INPUT_BYTES)
            if (!truncated) {
              const parsed = await parseXlsxBuffer(bytes)
              return {
                kind: 'spreadsheet',
                ext,
                name: fileName,
                path: relPath,
                size: info.size,
                ...parsed,
              }
            }
          } catch {
            // Fall through to LibreOffice PDF conversion for encrypted or non-standard workbooks.
          }
        }
        try {
          const converted = await convertOfficeToPdf(target, ext, signal)
          if (converted.status === 'ok') {
            return {
              kind: 'pdf',
              convertedFrom: ext,
              name: fileName,
              path: relPath,
              size: info.size,
              mime: 'application/pdf',
              base64: converted.bytes.toString('base64'),
            }
          }
          if (converted.status === 'too-large') {
            return { kind: 'too-large', convertedFrom: ext, name: fileName, path: relPath, size: converted.size, maxBytes: converted.maxBytes }
          }
          return { kind: 'office-unavailable', ext, name: fileName, path: relPath, size: info.size, ...(converted.error ? { error: converted.error } : {}) }
        } catch (error) {
          if (error?.code === 'bot/aborted') throw error
          return { kind: 'office-unavailable', ext, name: fileName, path: relPath, size: info.size, error: error?.message ?? String(error) }
        }
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
    const diff = await service.diff(sessionId, seq, index, signal ?? AbortSignal.timeout(DIFF_TIMEOUT_MS))
    if (diff === undefined) throw Object.assign(new Error('This file diff is no longer available'), { code: 'bot/stale' })
    return diff
  }

  // Output positions count scrollback parts, not bytes: a client that holds part N asks
  // for N + 1, and trimming drops whole parts so the position never lands inside one.
  const appendScrollback = (term, chunk) => {
    if (!chunk) return
    let at = 0
    while (at < chunk.length) {
      let end = Math.min(at + TERMINAL_SCROLLBACK_PART_CHARS, chunk.length)
      const code = chunk.charCodeAt(end - 1)
      if (end < chunk.length && end > at + 1 && code >= 0xd800 && code <= 0xdbff) end -= 1
      const text = chunk.slice(at, end)
      term.endSeq += 1
      term.parts.push({ seq: term.endSeq, text })
      term.buffer += text
      at = end
    }
  }

  // Trim only between batches: output already collected for the next event keeps its
  // part metadata until that event has been emitted, so positions never rewrite a batch.
  const trimScrollback = (term) => {
    while (term.buffer.length > TERMINAL_SCROLLBACK_CHARS && term.parts.length > 1) {
      const first = term.parts.shift()
      term.buffer = term.buffer.slice(first.text.length)
    }
    term.startSeq = term.parts[0]?.seq ?? term.endSeq + 1
  }

  const readScrollback = (term, after = 0) => {
    if (!Number.isSafeInteger(after) || after < 0) throw invalid('after must be a non-negative whole number')
    const truncated = after + 1 < term.startSeq
    const from = Math.max(after, term.startSeq - 1)
    const parts = term.parts.filter(part => part.seq > from).map(part => ({ seq: part.seq, text: part.text }))
    return {
      id: term.id,
      start: term.startSeq,
      end: term.endSeq,
      truncated,
      parts,
      chunk: parts.map(part => part.text).join(''),
      exited: term.exited,
      exitCode: term.exitCode,
    }
  }

  const terminalListEntry = (term, positions) => {
    const base = {
      id: term.id,
      cwd: term.cwd,
      title: term.title,
      pty: term.pty,
      exited: term.exited,
      exitCode: term.exitCode,
      start: term.startSeq,
      end: term.endSeq,
    }
    if (positions === undefined) return { ...base, snapshot: term.buffer }
    const after = Object.hasOwn(positions, term.id) ? positions[term.id] : undefined
    const { chunk, ...catchup } = readScrollback(term, after ?? 0)
    return { ...base, ...catchup, cwd: term.cwd, title: term.title, pty: term.pty }
  }

  async function openTerminal(body = {}, signal) {
    if (disposed) throw refused('Host is shutting down')
    if (signal?.aborted) throw Object.assign(new Error('Terminal launch cancelled'), { code: 'bot/aborted' })
    if (terminals.size + reservedSlots >= MAX_TERMINALS) {
      throw refused(`Too many open terminals (max ${MAX_TERMINALS})`)
    }
    reservedSlots += 1
    let releaseSpawn
    const spawnDone = new Promise((done) => { releaseSpawn = done })
    inFlightSpawns.add(spawnDone)
    try {
      const cwd = await resolveWorkspaceRoot(body.sessionId)
      if (disposed) throw refused('Host is shutting down')
      if (signal?.aborted) throw Object.assign(new Error('Terminal launch cancelled'), { code: 'bot/aborted' })
      const cols = clampDim(body.cols, 80, 20, 400)
      const rows = clampDim(body.rows, 24, 6, 120)
      const argv = defaultShell()
      const id = `term-${randomUUID().slice(0, 8)}`
      const title = basename(cwd) || cwd

      const subprocess = ctx.get?.('subprocess')
      let record
      let pendingOut = ''
      let pendingStart = 0
      let flushTimer = null
      const clearBatch = () => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        pendingOut = ''
        pendingStart = 0
      }
      const flush = () => {
        flushTimer = null
        if (record?.closed || pendingOut === '') {
          pendingOut = ''
          return
        }
        const chunk = pendingOut
        const start = pendingStart
        const end = record.endSeq
        const parts = record.parts.filter(part => part.seq >= start && part.seq <= end).map(part => ({ seq: part.seq, text: part.text }))
        pendingOut = ''
        pendingStart = 0
        emitLocal('terminal', { id, chunk, start, end, parts })
        trimScrollback(record)
      }
      const enqueueChunk = (text) => {
        if (!text || !record || record.closed) return
        const before = record.endSeq
        appendScrollback(record, text)
        if (pendingOut === '') pendingStart = before + 1
        pendingOut += text
        if (flushTimer === null) {
          flushTimer = setTimeout(flush, TERMINAL_BATCH_MS)
          flushTimer.unref?.()
        }
      }
      const onExit = (code) => {
        if (!record || record.exited) return
        record.exited = true
        record.exitCode = typeof code === 'number' ? code : null
        if (record.closed) {
          clearBatch()
          return
        }
        if (flushTimer !== null) { clearTimeout(flushTimer); flush() }
        emitLocal('terminal-exit', { id, code: record.exitCode, end: record.endSeq })
      }

      if (typeof subprocess?.spawnTerminal === 'function') {
        const handle = await subprocess.spawnTerminal({
          argv,
          cwd,
          env: ptyEnvOverrides(),
          rows,
          cols,
          terminalType: 'xterm-256color',
          graceMs: TERMINAL_GRACE_MS,
          signal,
        })
        if (disposed || signal?.aborted) {
          await handle.terminate().catch(() => {})
          throw disposed ? refused('Host is shutting down') : Object.assign(new Error('Terminal launch cancelled'), { code: 'bot/aborted' })
        }
        const decoder = new StringDecoder('utf8')
        record = {
          id,
          cwd,
          title,
          pty: true,
          exited: false,
          closed: false,
          exitCode: null,
          buffer: '',
          parts: [],
          startSeq: 1,
          endSeq: 0,
          write: data => handle.write(data),
          resize: (c, r) => handle.resize(c, r),
          terminate: async () => {
            record.closed = true
            clearBatch()
            await handle.terminate().catch(() => {})
          },
        }
        terminals.set(id, record)
        handle.output.on('data', (chunk) => {
          enqueueChunk(typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk)))
        })
        handle.output.on('end', () => {
          const tail = decoder.end()
          if (tail) enqueueChunk(tail)
        })
        handle.output.on('error', () => {
          onExit(null)
        })
        void handle.done.then(outcome => onExit(outcome?.exitCode ?? null), () => onExit(null))
      } else {
        const useProcessGroup = process.platform !== 'win32'
        const child = spawn(argv[0], argv.slice(1), {
          cwd,
          env: fallbackTerminalEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: useProcessGroup,
        })
        const outDecoder = new StringDecoder('utf8')
        const errDecoder = new StringDecoder('utf8')
        let resolveClose
        const closedPromise = new Promise((done) => { resolveClose = done })
        const signalGroup = (sig) => {
          if (useProcessGroup && Number.isInteger(child.pid) && child.pid > 0) {
            try { process.kill(-child.pid, sig); return true } catch { /* fall back to direct child */ }
          }
          try { child.kill(sig); return true } catch { return false }
        }
        record = {
          id,
          cwd,
          title,
          pty: false,
          exited: false,
          closed: false,
          exitCode: null,
          buffer: '',
          parts: [],
          startSeq: 1,
          endSeq: 0,
          write: async (data) => {
            if (record.exited || record.closed) return
            // Non-PTY fallback has no foreground job group, so Ctrl+C cannot interrupt a
            // command without killing the shell itself (UI disables Ctrl+C for non-PTY).
            if (data === '\x03') return
            if (data === '\x04') {
              try { child.stdin?.end() } catch { /* already closed */ }
              return
            }
            if (child.stdin?.destroyed || !child.stdin?.writable) return
            try { child.stdin.write(data) } catch { /* pipe closed */ }
          },
          resize: async () => {},
          terminate: async () => {
            record.closed = true
            clearBatch()
            if (record.exited) return
            signalGroup('SIGTERM')
            let killTimer
            await Promise.race([
              closedPromise,
              new Promise((done) => {
                killTimer = setTimeout(() => {
                  if (!record.exited) signalGroup('SIGKILL')
                  done()
                }, TERMINAL_GRACE_MS)
                killTimer.unref?.()
              }),
            ])
            if (killTimer) clearTimeout(killTimer)
          },
        }
        terminals.set(id, record)
        child.stdin?.on('error', () => { /* suppress EPIPE when child exits mid-write */ })
        child.stdout?.on('data', chunk => enqueueChunk(outDecoder.write(Buffer.from(chunk))))
        child.stderr?.on('data', chunk => enqueueChunk(errDecoder.write(Buffer.from(chunk))))
        child.on('close', (code) => {
          const outTail = outDecoder.end()
          const errTail = errDecoder.end()
          if (outTail) enqueueChunk(outTail)
          if (errTail) enqueueChunk(errTail)
          resolveClose()
          onExit(code)
        })
        child.on('error', (error) => {
          enqueueChunk(`\r\n[terminal error: ${error?.message ?? String(error)}]\r\n`)
          resolveClose()
          onExit(1)
        })
      }

      return { id, cwd, title, cols, rows, pty: record.pty }
    } finally {
      reservedSlots = Math.max(0, reservedSlots - 1)
      inFlightSpawns.delete(spawnDone)
      releaseSpawn()
    }
  }

  async function terminalEndpoint(name, body = {}, signal) {
    if (name === 'list') {
      const positions = body.positions !== null && typeof body.positions === 'object' && !Array.isArray(body.positions) ? body.positions : undefined
      if (positions !== undefined) {
        for (const value of Object.values(positions)) {
          if (!Number.isSafeInteger(value) || value < 0) throw invalid('Terminal positions must be non-negative whole numbers')
        }
      }
      return [...terminals.values()].map(term => terminalListEntry(term, positions))
    }
    if (name === 'open') return openTerminal(body, signal)
    const id = typeof body.id === 'string' ? body.id : ''
    const term = terminals.get(id)
    if (term === undefined) throw notFound('Unknown terminal')
    if (name === 'read') {
      return readScrollback(term, body.after ?? 0)
    }
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
    offLocalClients?.()
    await closeAllWatches()
    const pending = [...inFlightSpawns]
    const active = [...terminals.values()]
    terminals.clear()
    await Promise.all([
      ...active.map(term => term.terminate().catch(() => {})),
      ...pending.map(p => p.catch(() => {})),
    ])
    // Terminate anything that raced into `terminals` just before `disposed` took effect.
    const stragglers = [...terminals.values()]
    terminals.clear()
    if (stragglers.length > 0) {
      await Promise.all(stragglers.map(term => term.terminate().catch(() => {})))
    }
  }

  rt.workspaceEndpoint = workspaceEndpoint
  rt.terminalEndpoint = terminalEndpoint
  rt.terminalDispose = terminalDispose
}
