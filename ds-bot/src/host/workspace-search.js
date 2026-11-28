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

const OP_CHAR = 1
const OP_QMARK = 2
const OP_CLASS = 3
const OP_STAR = 4
const OP_GLOBSTAR = 5
const OP_ANY_DIRS_ENTER = 6
const OP_ANY_DIRS_LOOP = 7
const OP_ACCEPT = 8

function parseCharClass(glob, start) {
  let j = start + 1
  if (j >= glob.length) return null
  let negated = false
  if (glob[j] === '!' || glob[j] === '^') {
    negated = true
    j += 1
  }
  const singles = new Set()
  const ranges = []
  let first = true
  while (j < glob.length) {
    if (glob[j] === ']' && !first) {
      return { token: { negated, singles, ranges }, nextIndex: j + 1 }
    }
    first = false
    let ch = glob[j]
    if (ch === '\\' && j + 1 < glob.length) {
      ch = glob[j + 1]
      j += 2
    } else {
      j += 1
    }
    if (j + 1 < glob.length && glob[j] === '-' && glob[j + 1] !== ']') {
      j += 1
      let endCh = glob[j]
      if (endCh === '\\' && j + 1 < glob.length) {
        endCh = glob[j + 1]
        j += 2
      } else {
        j += 1
      }
      const lo = ch.charCodeAt(0)
      const hi = endCh.charCodeAt(0)
      // Match git wildmatch.c: reversed ranges like `[z-a]` still match the leading char `z`
      // while treating the range itself as empty.
      if (lo <= hi) ranges.push([lo, hi])
      else singles.add(ch)
    } else {
      singles.add(ch)
    }
  }
  return null
}

function matchCharClass(cls, ch) {
  let matched = cls.singles.has(ch)
  if (!matched && cls.ranges.length > 0) {
    const code = ch.charCodeAt(0)
    for (let i = 0; i < cls.ranges.length; i += 1) {
      const [lo, hi] = cls.ranges[i]
      if (code >= lo && code <= hi) {
        matched = true
        break
      }
    }
  }
  return cls.negated ? !matched : matched
}

// Compiles a `.gitignore` glob into a linear-time Thompson NFA so adversarial patterns
// (e.g. `a*a*a*...b`) evaluate in O(states * pathLength) with zero regex backtracking.
function compileGlobNfa(glob) {
  const ops = []
  const chars = []
  const classes = []
  const pushState = (op, ch = '', cls = null) => {
    ops.push(op)
    chars.push(ch)
    classes.push(cls)
  }
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === '\\' && i + 1 < glob.length) {
      pushState(OP_CHAR, glob[i + 1])
      i += 2
      continue
    }
    if (ch === '*') {
      let stars = 1
      while (i + stars < glob.length && glob[i + stars] === '*') stars += 1
      i += stars
      if (stars >= 2) {
        if (glob[i] === '/') {
          i += 1
          // Collapse redundant consecutive `**/` or `**/**/` segments.
          while (glob.startsWith('**/', i)) i += 3
          if (ops.at(-1) !== OP_GLOBSTAR && ops.at(-1) !== OP_ANY_DIRS_LOOP) {
            pushState(OP_ANY_DIRS_ENTER)
            pushState(OP_ANY_DIRS_LOOP)
          }
        } else if (ops.at(-1) !== OP_GLOBSTAR) {
          pushState(OP_GLOBSTAR)
        }
      } else if (ops.at(-1) !== OP_STAR && ops.at(-1) !== OP_GLOBSTAR) {
        pushState(OP_STAR)
      }
      continue
    }
    if (ch === '?') {
      pushState(OP_QMARK)
      i += 1
      continue
    }
    if (ch === '[') {
      const parsed = parseCharClass(glob, i)
      if (parsed) {
        pushState(OP_CLASS, '', parsed.token)
        i = parsed.nextIndex
        continue
      }
    }
    pushState(OP_CHAR, ch)
    i += 1
  }
  pushState(OP_ACCEPT)
  return { ops, chars, classes, acceptState: ops.length - 1 }
}

function matchGlobNfa(nfa, str, anchored) {
  const { ops, chars, classes, acceptState } = nfa
  const stateCount = acceptState + 1
  let cur = new Uint8Array(stateCount)
  let next = new Uint8Array(stateCount)
  cur[0] = 1

  const expandEpsilon = (arr) => {
    for (let s = 0; s < acceptState; s += 1) {
      if (!arr[s]) continue
      const op = ops[s]
      if (op === OP_STAR || op === OP_GLOBSTAR) {
        arr[s + 1] = 1
      } else if (op === OP_ANY_DIRS_ENTER) {
        arr[s + 1] = 1
        arr[s + 2] = 1
      }
    }
  }

  for (let i = 0; i < str.length; i += 1) {
    expandEpsilon(cur)
    const ch = str[i]
    next.fill(0)
    let anyNext = false
    for (let s = 0; s < acceptState; s += 1) {
      if (!cur[s]) continue
      const op = ops[s]
      if (op === OP_CHAR) {
        if (ch === chars[s]) { next[s + 1] = 1; anyNext = true }
      } else if (op === OP_QMARK) {
        if (ch !== '/') { next[s + 1] = 1; anyNext = true }
      } else if (op === OP_CLASS) {
        if (ch !== '/' && matchCharClass(classes[s], ch)) { next[s + 1] = 1; anyNext = true }
      } else if (op === OP_STAR) {
        if (ch !== '/') { next[s] = 1; anyNext = true }
      } else if (op === OP_GLOBSTAR) {
        next[s] = 1
        anyNext = true
      } else if (op === OP_ANY_DIRS_LOOP) {
        next[s] = 1
        anyNext = true
        if (ch === '/') next[s + 1] = 1
      }
    }
    if (!anchored && ch === '/') {
      next[0] = 1
      anyNext = true
    }
    if (!anyNext) {
      if (anchored) return false
      const nextSlash = str.indexOf('/', i + 1)
      if (nextSlash < 0) return false
      i = nextSlash
      cur.fill(0)
      cur[0] = 1
      continue
    }
    const tmp = cur
    cur = next
    next = tmp
  }

  expandEpsilon(cur)
  return cur[acceptState] === 1
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
    const nfa = compileGlobNfa(pattern)
    rules.push({
      prefix,
      negated,
      dirOnly,
      anchored,
      nfa,
    })
  }
  return rules
}

function isDirectlyGitignored(rules, relPath, isDir) {
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    let scoped = relPath
    if (rule.prefix !== '') {
      if (!relPath.startsWith(rule.prefix)) continue
      scoped = relPath.slice(rule.prefix.length)
      if (scoped === '') continue
    }
    if (matchGlobNfa(rule.nfa, scoped, rule.anchored)) {
      ignored = !rule.negated
    }
  }
  return ignored
}

/**
 * Evaluates layered `.gitignore` rules against a workspace-relative POSIX path,
 * matching Git semantics: if any parent directory is ignored, descendants cannot
 * be re-included, and a negated directory rule permits traversing that directory
 * without overriding ignore rules on descendant files.
 */
export function isGitignored(rules, relPath, isDir) {
  if (!Array.isArray(rules) || rules.length === 0 || !relPath) return false
  let slash = relPath.indexOf('/')
  while (slash !== -1) {
    if (isDirectlyGitignored(rules, relPath.slice(0, slash), true)) return true
    slash = relPath.indexOf('/', slash + 1)
  }
  return isDirectlyGitignored(rules, relPath, isDir)
}

async function readIgnoreFile(filePath, realRoot, withinRoot, isProtectedData) {
  try {
    const realFile = await realpath(filePath)
    if (!withinRoot(realFile, realRoot)) return ''
    if (typeof isProtectedData === 'function' && await isProtectedData(realFile)) return ''
    const info = await stat(realFile)
    if (!info.isFile() || info.size > MAX_GITIGNORE_BYTES) return ''
    return await readFile(realFile, 'utf8')
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
        const excludeText = await readIgnoreFile(join(realRoot, '.git', 'info', 'exclude'), realRoot, withinRoot, isProtectedData)
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
        // In-progress directory cursor so wide directories obey `batchMs` slicing without duplicates.
        activeDir: null,
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
    let processed = 0

    while (session.activeDir !== null || session.queue.length > 0) {
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
      if (processed > 0 && Date.now() >= deadline) break

      if (session.activeDir === null) {
        const current = session.queue.shift()
        session.scannedDirs += 1
        processed += 1

        let rules = current.rules
        if (session.respectGitignore) {
          const localIgnore = await readIgnoreFile(join(current.dirAbs, '.gitignore'), realRoot, withinRoot, isProtectedData)
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
        session.activeDir = {
          dirAbs: current.dirAbs,
          relDir: current.relDir,
          depth: current.depth,
          rules,
          entries: rawEntries,
          index: 0,
        }
      }

      const active = session.activeDir
      while (active.index < active.entries.length) {
        if (disposed || session.cancelled || signal?.aborted) break
        if (processed > 0 && Date.now() >= deadline) break
        const entry = active.entries[active.index]
        active.index += 1
        processed += 1

        const name = entry.name
        if (ALWAYS_IGNORED_DIRS.has(name)) continue
        if (!session.includeHidden && name.startsWith('.')) continue

        const full = join(active.dirAbs, name)
        const relPath = active.relDir ? `${active.relDir}/${name}` : name

        const isSymlink = entry.isSymbolicLink()
        if (!isSymlink && session.respectGitignore) {
          const quickDir = entry.isDirectory()
          if (quickDir || entry.isFile()) {
            if (isGitignored(active.rules, relPath, quickDir)) continue
          }
        }

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
        if (isSymlink && kind === 'dir') continue

        const isDir = kind === 'dir'
        if (isSymlink && session.respectGitignore && isGitignored(active.rules, relPath, isDir)) continue

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
          if (active.depth + 1 >= session.maxDepth) {
            session.incompleteReasons.add('depth')
          } else {
            session.queue.push({
              dirAbs: full,
              relDir: relPath,
              depth: active.depth + 1,
              rules: active.rules,
            })
          }
        }
      }

      if (active.index >= active.entries.length) {
        session.activeDir = null
      } else {
        break
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

    const done = session.activeDir === null && session.queue.length === 0
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
