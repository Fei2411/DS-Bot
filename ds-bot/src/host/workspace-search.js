// Full-workspace file search with `.gitignore` support, batched/incremental streaming
// (no artificial match-count cap), cancellation, and explicit incomplete-result reporting.
import { randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

const MAX_SEARCH_SESSIONS = 8
const SEARCH_SESSION_TTL_MS = 30_000
const DEFAULT_BATCH_MS = 120
const MAX_BATCH_MS = 2_000
const DEFAULT_MAX_DEPTH = 64
const MAX_GITIGNORE_BYTES = 256 * 1024
const ALWAYS_IGNORED_DIRS = new Set(['.git'])

const toPosixRel = (root, target) => {
  const rel = relative(root, target)
  if (!rel || rel === '.') return ''
  return sep === '/' ? rel : rel.split(sep).join('/')
}

function escapeRegexChar(ch) {
  return /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch
}

function globToRegexSource(glob) {
  let out = ''
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === '\\' && i + 1 < glob.length) {
      out += escapeRegexChar(glob[i + 1])
      i += 2
      continue
    }
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const next = glob[i + 2]
        if (next === '/') {
          out += '(?:.*/)?'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
      } else {
        out += '[^/]*'
        i += 1
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (ch === '[') {
      let j = i + 1
      if (j < glob.length && (glob[j] === '!' || glob[j] === '^')) j += 1
      if (j < glob.length && glob[j] === ']') j += 1
      while (j < glob.length && glob[j] !== ']') {
        if (glob[j] === '\\' && j + 1 < glob.length) j += 2
        else j += 1
      }
      if (j < glob.length && glob[j] === ']') {
        let content = glob.slice(i + 1, j)
        if (content.startsWith('!')) content = `^${content.slice(1)}`
        out += `[${content}]`
        i = j + 1
        continue
      }
    }
    out += escapeRegexChar(ch)
    i += 1
  }
  return out
}

function stripUnescapedTrailingSpaces(line) {
  let end = line.length
  while (end > 0 && line[end - 1] === ' ') {
    let backslashes = 0
    for (let k = end - 2; k >= 0 && line[k] === '\\'; k -= 1) backslashes += 1
    if (backslashes % 2 === 1) break
    end -= 1
  }
  return line.slice(0, end)
}

/**
 * Parses `.gitignore` file contents into ordered matcher rules scoped to `baseRel` ('' for root).
 */
export function parseGitignore(text, baseRel = '') {
  if (typeof text !== 'string' || text === '') return []
  const rules = []
  const prefix = baseRel ? `${baseRel.replace(/^\/+|\/+$/g, '')}/` : ''
  for (const rawLine of text.split(/\r?\n/)) {
    const cleaned = stripUnescapedTrailingSpaces(rawLine)
    if (cleaned === '' || cleaned.startsWith('#')) continue
    let pattern = cleaned
    let negated = false
    if (pattern.startsWith('!')) {
      negated = true
      pattern = pattern.slice(1)
    } else if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
      pattern = pattern.slice(1)
    }
    if (pattern === '') continue
    let dirOnly = false
    if (pattern.endsWith('/')) {
      dirOnly = true
      pattern = pattern.replace(/\/+$/, '')
    }
    if (pattern === '') continue
    const leadingSlash = pattern.startsWith('/')
    if (leadingSlash) pattern = pattern.slice(1)
    const anchored = leadingSlash || pattern.includes('/')
    const globSrc = globToRegexSource(pattern)
    const matcher = anchored
      ? new RegExp(`^${globSrc}(?:$|/)`)
      : new RegExp(`(?:^|/)${globSrc}(?:$|/)`)
    const dirPrefixMatcher = dirOnly
      ? (anchored ? new RegExp(`^${globSrc}/`) : new RegExp(`(?:^|/)${globSrc}/`))
      : null
    rules.push({
      prefix,
      negated,
      dirOnly,
      anchored,
      matcher,
      dirPrefixMatcher,
    })
  }
  return rules
}

/**
 * Evaluates layered `.gitignore` rules against a workspace-relative POSIX path.
 */
export function isGitignored(rules, relPath, isDir) {
  if (!Array.isArray(rules) || rules.length === 0 || !relPath) return false
  let ignored = false
  for (const rule of rules) {
    let scoped = relPath
    if (rule.prefix !== '') {
      if (!relPath.startsWith(rule.prefix)) continue
      scoped = relPath.slice(rule.prefix.length)
      if (scoped === '') continue
    }
    if (rule.dirOnly && !isDir) {
      if (!scoped.includes('/')) continue
      if (rule.dirPrefixMatcher?.test(scoped)) ignored = !rule.negated
      continue
    }
    if (rule.matcher.test(scoped)) {
      ignored = !rule.negated
    }
  }
  return ignored
}

async function readIgnoreFile(filePath) {
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size > MAX_GITIGNORE_BYTES) return ''
    return await readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

function matchesQuery(name, relPath, tokens) {
  if (tokens.length === 0) return false
  const lowerName = name.toLowerCase()
  const lowerPath = relPath.toLowerCase()
  for (const token of tokens) {
    if (!lowerName.includes(token) && !lowerPath.includes(token)) return false
  }
  return true
}

/**
 * Creates a bounded manager of stateful, cancellable, batched workspace searches.
 */
export function createWorkspaceSearcher({ withinRoot, isProtectedData }) {
  const sessions = new Map()
  let disposed = false

  const sweep = (now = Date.now()) => {
    for (const [id, session] of sessions) {
      if (now - session.lastActiveAt > SEARCH_SESSION_TTL_MS || session.done || session.cancelled) {
        sessions.delete(id)
      }
    }
  }

  const cancel = (searchId) => {
    if (typeof searchId !== 'string' || searchId === '') return { ok: true, cancelled: false }
    const session = sessions.get(searchId)
    if (!session) return { ok: true, cancelled: false }
    session.cancelled = true
    sessions.delete(searchId)
    return { ok: true, cancelled: true }
  }

  const dispose = () => {
    disposed = true
    for (const session of sessions.values()) session.cancelled = true
    sessions.clear()
  }

  const search = async ({
    realRoot,
    query = '',
    includeHidden = false,
    respectGitignore = true,
    searchId = '',
    batchMs = DEFAULT_BATCH_MS,
    maxDepth = DEFAULT_MAX_DEPTH,
    signal = null,
  }) => {
    if (disposed) throw Object.assign(new Error('Host is shutting down'), { code: 'bot/refused' })
    sweep()

    const sliceMs = Number.isFinite(Number(batchMs))
      ? Math.max(10, Math.min(MAX_BATCH_MS, Math.round(Number(batchMs))))
      : DEFAULT_BATCH_MS
    const depthCap = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : DEFAULT_MAX_DEPTH

    let session
    if (typeof searchId === 'string' && searchId !== '') {
      session = sessions.get(searchId)
      if (!session || session.root !== realRoot) {
        throw Object.assign(new Error('Search session expired'), { code: 'bot/stale' })
      }
    } else {
      const normalized = String(query ?? '').trim().toLowerCase()
      const tokens = normalized.split(/\s+/).filter(Boolean)
      if (tokens.length === 0) {
        return {
          root: realRoot,
          searchId: null,
          entries: [],
          done: true,
          scannedDirs: 0,
          scannedFiles: 0,
          incomplete: false,
          incompleteReasons: [],
          truncated: false,
        }
      }
      while (sessions.size >= MAX_SEARCH_SESSIONS) {
        const oldestKey = sessions.keys().next().value
        if (oldestKey === undefined) break
        const oldest = sessions.get(oldestKey)
        if (oldest) oldest.cancelled = true
        sessions.delete(oldestKey)
      }
      const rootRules = []
      if (respectGitignore) {
        const excludeText = await readIgnoreFile(join(realRoot, '.git', 'info', 'exclude'))
        if (excludeText) rootRules.push(...parseGitignore(excludeText, ''))
      }
      const id = `search-${randomUUID().slice(0, 8)}`
      session = {
        id,
        root: realRoot,
        tokens,
        includeHidden: includeHidden === true,
        respectGitignore: respectGitignore !== false,
        maxDepth: depthCap,
        // Queue items: { dirAbs, relDir, depth, rules }
        queue: [{ dirAbs: realRoot, relDir: '', depth: 0, rules: rootRules }],
        scannedDirs: 0,
        scannedFiles: 0,
        incompleteReasons: new Set(),
        done: false,
        cancelled: false,
        lastActiveAt: Date.now(),
      }
      sessions.set(id, session)
    }

    session.lastActiveAt = Date.now()
    const batch = []
    const deadline = Date.now() + sliceMs
    let iterations = 0

    while (session.queue.length > 0) {
      if (disposed || session.cancelled || signal?.aborted) {
        session.cancelled = true
        session.incompleteReasons.add('cancelled')
        sessions.delete(session.id)
        return {
          root: realRoot,
          searchId: session.id,
          entries: batch,
          done: true,
          cancelled: true,
          scannedDirs: session.scannedDirs,
          scannedFiles: session.scannedFiles,
          incomplete: true,
          incompleteReasons: [...session.incompleteReasons],
          truncated: true,
        }
      }
      if (iterations > 0 && Date.now() >= deadline) break
      iterations += 1

      const current = session.queue.shift()
      session.scannedDirs += 1

      let rules = current.rules
      if (session.respectGitignore) {
        const localIgnore = await readIgnoreFile(join(current.dirAbs, '.gitignore'))
        if (localIgnore) {
          const parsed = parseGitignore(localIgnore, current.relDir)
          if (parsed.length > 0) rules = [...rules, ...parsed]
        }
      }

      let rawEntries
      try {
        rawEntries = await readdir(current.dirAbs, { withFileTypes: true })
      } catch (err) {
        if (err?.code === 'EACCES' || err?.code === 'EPERM') session.incompleteReasons.add('permission')
        else session.incompleteReasons.add('unreadable')
        continue
      }

      rawEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

      for (const entry of rawEntries) {
        if (disposed || session.cancelled || signal?.aborted) break
        const name = entry.name
        if (ALWAYS_IGNORED_DIRS.has(name)) continue
        if (!session.includeHidden && name.startsWith('.')) continue

        const full = join(current.dirAbs, name)
        const relPath = current.relDir ? `${current.relDir}/${name}` : name

        let realEntry
        try {
          realEntry = await realpath(full)
        } catch {
          continue
        }
        if (!withinRoot(realEntry, realRoot) || await isProtectedData(realEntry)) continue

        let info
        try {
          info = await stat(realEntry)
        } catch {
          continue
        }
        const kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
        if (kind === null) continue
        if (entry.isSymbolicLink() && kind === 'dir') continue

        const isDir = kind === 'dir'
        if (session.respectGitignore && isGitignored(rules, relPath, isDir)) continue

        if (!isDir) session.scannedFiles += 1

        if (matchesQuery(name, relPath, session.tokens)) {
          batch.push({
            name,
            path: toPosixRel(realRoot, full),
            kind,
            size: isDir ? 0 : info.size,
            mtimeMs: Math.round(info.mtimeMs),
            ext: isDir ? '' : extname(name).toLowerCase(),
          })
        }

        if (isDir) {
          if (current.depth + 1 >= session.maxDepth) {
            session.incompleteReasons.add('depth')
          } else {
            session.queue.push({
              dirAbs: full,
              relDir: relPath,
              depth: current.depth + 1,
              rules,
            })
          }
        }
      }
    }

    if (disposed || session.cancelled || signal?.aborted) {
      session.cancelled = true
      session.incompleteReasons.add('cancelled')
      sessions.delete(session.id)
      return {
        root: realRoot,
        searchId: session.id,
        entries: batch,
        done: true,
        cancelled: true,
        scannedDirs: session.scannedDirs,
        scannedFiles: session.scannedFiles,
        incomplete: true,
        incompleteReasons: [...session.incompleteReasons],
        truncated: true,
      }
    }

    const done = session.queue.length === 0
    if (done) {
      session.done = true
      sessions.delete(session.id)
    } else {
      session.lastActiveAt = Date.now()
    }

    const incompleteReasons = [...session.incompleteReasons]
    const incomplete = incompleteReasons.length > 0
    return {
      root: realRoot,
      searchId: done ? null : session.id,
      entries: batch,
      done,
      scannedDirs: session.scannedDirs,
      scannedFiles: session.scannedFiles,
      incomplete,
      incompleteReasons,
      truncated: incomplete,
    }
  }

  return { search, cancel, dispose }
}
