// Private Bots. A private Bot reads the team like any Bot, but no other Bot reads it, and
// what it sends out waits for the user. DSH does not fence reads, so this closes the
// tools DS Bot owns and checks the paths that the file tools and the shell are given;
// a shell can still reach any file the account can (see docs/plans).
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { manualDirectory } from './manual-skills.js'
import { within } from './folders.js'
import { unquote } from './text.js'
import { openSessions, retiredTaskSessionIds } from './threads.js'

// Older DSH releases lack @deepseek-ai/dsh-fs-patch; patchPathsOf also scans headers directly.
const { parsePatch } = await import('@deepseek-ai/dsh-fs-patch').catch(() => ({}))

const FILE_TOOLS = { read: 'file_path', write: 'file_path', edit: 'file_path', read_image: 'file_path', str_replace_editor: 'path', read_document: 'path' }
const WRITE_TOOLS = ['write', 'edit', 'str_replace_editor']
const SEARCH_TOOLS = ['glob', 'grep']
const SHELL_TOOLS = ['bash', 'pwsh', 'terminal_open', 'terminal_send', 'run_code']
const SESSION_TOOLS = ['session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read']
const SECRET_GUARDED_TOOLS = new Set([
  ...Object.keys(FILE_TOOLS),
  'apply_patch',
  'present',
  ...SEARCH_TOOLS,
  ...SHELL_TOOLS,
  'subagent',
  'subagent_fork',
  'working_directory',
])
const SEARCH_SHELL_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'select-string', 'sls'])
const GREP_PATTERN_FLAGS = new Set(['-e', '--regexp'])
const GREP_VALUE_FLAGS = new Set([
  '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '--context',
  '--after-context', '--before-context', '--glob', '--iglob',
  '--type', '--type-not', '--include', '--exclude',
  '--exclude-dir', '--exclude-from', '--ignore-file', '--color', '--colour',
  '-d', '--directories', '-D', '--devices', '--max-depth', '--max-filesize',
  '--threads', '--encoding', '--label', '--replace',
  '--max-columns', '--path-separator', '--sort', '--sortr',
])
const RG_ONLY_VALUE_FLAGS = new Set(['-g', '-t', '-T', '-r', '-M', '-j'])

// Windows and macOS file systems ignore case.
const fold = text => (process.platform === 'linux' ? text : text.toLowerCase())
const overlap = (a, b) => within(a, b) || within(b, a)
const expandHome = (path) => (path === '~' ? homedir() : /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path)
const strings = value => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [])
// The same path as a shell writes it: collapsed forward slashes, and on Windows both drive forms.
const normalizeSlashes = text => text.replace(/[\\/]+/g, '/')
const asShell = (path) => {
  const slashed = normalizeSlashes(path)
  const drive = /^([a-z]):\//i.exec(slashed)
  return drive ? [slashed, `/${drive[1]}${slashed.slice(2)}`] : [slashed]
}

// Extract every source and destination path from an apply_patch input.
function patchPathsOf(args) {
  const input = args?.input
  if (typeof input !== 'string' || input === '') return []
  const paths = new Set()
  if (typeof parsePatch === 'function') {
    try {
      for (const op of parsePatch(input)) {
        if (typeof op.path === 'string' && op.path !== '') paths.add(expandHome(op.path))
        if (typeof op.moveTo === 'string' && op.moveTo !== '') paths.add(expandHome(op.moveTo))
      }
      return [...paths]
    } catch {
      // Fall through to header scan so malformed or partial patches still cannot bypass fences.
    }
  }
  for (const line of input.split(/\r?\n/)) {
    const match = /^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/.exec(line)
    if (match !== null && match[1] !== '') paths.add(expandHome(match[1]))
  }
  return [...paths]
}

const DIRECT_HOST_MODULES = new Set([
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'child_process', 'node:child_process',
])
const DIRECT_HOST_EXPLICIT_MODULES = new Set([
  'node:fs', 'node:fs/promises', 'node:child_process',
])
const PROCESS_ESCAPE_PROPS = new Set(['binding', 'dlopen', 'getBuiltinModule'])

// Tokenize JS/TS code enough to detect direct host escape imports/calls (node:fs,
// child_process, process.binding/dlopen/getBuiltinModule) while ignoring comments and
// code embedded inside string/template payloads passed to tools.write/edit.
function hasDirectHostModuleAccess(code) {
  const tokens = []
  const templateBraceStack = []
  let i = 0
  const len = code.length
  const prevCanEndExpr = () => {
    const prev = tokens.at(-1)
    if (prev === undefined) return false
    if (prev.kind === 'id') return !['return', 'throw', 'case', 'in', 'of', 'typeof', 'void', 'delete', 'new', 'await', 'yield', 'else', 'do'].includes(prev.value)
    return prev.kind === 'str' || prev.kind === 'num' || prev.value === ')' || prev.value === ']' || prev.value === '}'
  }
  const readTemplateChunk = () => {
    let val = ''
    let hasExpr = false
    while (i < len) {
      const ch = code[i]
      if (ch === '\\' && i + 1 < len) {
        val += code[i + 1]
        i += 2
        continue
      }
      if (ch === '`') {
        i += 1
        return { val, closed: true, hasExpr }
      }
      if (ch === '$' && code[i + 1] === '{') {
        i += 2
        templateBraceStack.push(0)
        hasExpr = true
        return { val, closed: false, hasExpr }
      }
      val += ch
      i += 1
    }
    return { val, closed: true, hasExpr }
  }

  while (i < len) {
    const ch = code[i]
    if (/\s/.test(ch)) { i += 1; continue }
    if (ch === '/' && code[i + 1] === '/') {
      i += 2
      while (i < len && code[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      i += 2
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === '/' && !prevCanEndExpr()) {
      i += 1
      let inClass = false
      while (i < len) {
        const rc = code[i]
        if (rc === '\\' && i + 1 < len) { i += 2; continue }
        if (rc === '[') inClass = true
        else if (rc === ']') inClass = false
        else if (rc === '/' && !inClass) { i += 1; break }
        else if (rc === '\n' || rc === '\r') break
        i += 1
      }
      tokens.push({ kind: 'regex', value: '' })
      continue
    }
    if (ch === '\'' || ch === '"') {
      const quote = ch
      i += 1
      let val = ''
      while (i < len && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < len) {
          val += code[i + 1]
          i += 2
          continue
        }
        if (code[i] === '\n' || code[i] === '\r') break
        val += code[i]
        i += 1
      }
      if (code[i] === quote) i += 1
      tokens.push({ kind: 'str', value: val })
      continue
    }
    if (ch === '`') {
      i += 1
      const chunk = readTemplateChunk()
      tokens.push({ kind: chunk.closed && !chunk.hasExpr ? 'str' : 'tpl', value: chunk.val })
      continue
    }
    if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1] += 1
      tokens.push({ kind: 'punct', value: '{' })
      i += 1
      continue
    }
    if (ch === '}' && templateBraceStack.length > 0) {
      if (templateBraceStack[templateBraceStack.length - 1] === 0) {
        templateBraceStack.pop()
        i += 1
        readTemplateChunk()
        tokens.push({ kind: 'tpl', value: '' })
        continue
      }
      templateBraceStack[templateBraceStack.length - 1] -= 1
      tokens.push({ kind: 'punct', value: '}' })
      i += 1
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i
      i += 1
      while (i < len && /[\w$]/.test(code[i])) i += 1
      tokens.push({ kind: 'id', value: code.slice(start, i) })
      continue
    }
    if (/[0-9]/.test(ch)) {
      const start = i
      i += 1
      while (i < len && /[\w.]/.test(code[i])) i += 1
      tokens.push({ kind: 'num', value: code.slice(start, i) })
      continue
    }
    tokens.push({ kind: 'punct', value: ch })
    i += 1
  }

  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t]
    const next = tokens[t + 1]
    const next2 = tokens[t + 2]
    if (tok.kind === 'str' && DIRECT_HOST_EXPLICIT_MODULES.has(tok.value)) return true
    if (tok.kind === 'id' && tok.value === 'from' && next?.kind === 'str' && DIRECT_HOST_MODULES.has(next.value)) return true
    if (tok.kind === 'id' && tok.value === 'import' && next?.kind === 'str' && DIRECT_HOST_MODULES.has(next.value)) return true
    if (tok.kind === 'id' && (tok.value === 'import' || tok.value === 'require' || tok.value === 'getBuiltinModule')
      && next?.kind === 'punct' && next.value === '('
      && next2?.kind === 'str' && DIRECT_HOST_MODULES.has(next2.value)) return true
    if (tok.kind === 'id' && tok.value === 'process') {
      if (next?.kind === 'punct' && next.value === '.' && next2?.kind === 'id' && PROCESS_ESCAPE_PROPS.has(next2.value)) return true
      if (next?.kind === 'punct' && next.value === '?' && next2?.kind === 'punct' && next2.value === '.'
        && tokens[t + 3]?.kind === 'id' && PROCESS_ESCAPE_PROPS.has(tokens[t + 3].value)) return true
      if (next?.kind === 'punct' && next.value === '[' && next2?.kind === 'str' && PROCESS_ESCAPE_PROPS.has(next2.value)) return true
      if (next?.kind === 'punct' && next.value === '?' && next2?.kind === 'punct' && next2.value === '.'
        && tokens[t + 3]?.kind === 'punct' && tokens[t + 3].value === '['
        && tokens[t + 4]?.kind === 'str' && PROCESS_ESCAPE_PROPS.has(tokens[t + 4].value)) return true
    }
  }
  return false
}

// Extract quoted path-like literals from run_code text so relative traversals and symlinks
// into closed folders are caught alongside literal absolute paths.
function codePathCandidates(text) {
  const found = new Set()
  for (const match of text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g)) {
    const raw = match[2]
    if (raw === '' || raw.includes('${')) continue
    const unescaped = raw.replace(/\\([\\'"`])/g, '$1')
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(unescaped)) continue
    if (/(?:^|[\\/])\.\.(?:$|[\\/])/.test(unescaped) || /^([a-z]:|[\\/]|~)/i.test(unescaped) || /[\\/]/.test(unescaped)) {
      found.add(expandHome(unescaped))
    }
  }
  return [...found]
}

// Splits shell command text into simple-command token arrays. Breaks on unquoted
// `;`, `\n`, `|`, `&`, `(`, `)`, `` ` ``, and `$(` (even inside double quotes) so
// subshells and command substitutions are inspected independently.
function splitShellCommands(text) {
  const segments = []
  let current = []
  let buf = ''
  let hasToken = false
  let tokenRedir = false
  let tokenQuoted = false
  let tokenUnquotedHash = false
  let nextRedir = false
  let quote = null
  const subshellQuotes = []

  const flushToken = () => {
    if (!hasToken) return
    current.push({ value: buf, redir: tokenRedir, quoted: tokenQuoted, unquotedHash: tokenUnquotedHash })
    buf = ''
    hasToken = false
    tokenRedir = false
    tokenQuoted = false
    tokenUnquotedHash = false
  }
  const flushSegment = () => {
    flushToken()
    if (current.length > 0) {
      segments.push(current)
      current = []
    }
    nextRedir = false
  }
  const startToken = () => {
    if (!hasToken) {
      hasToken = true
      tokenRedir = nextRedir
      tokenQuoted = false
      tokenUnquotedHash = false
      nextRedir = false
    }
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        startToken()
        buf += ch
      }
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (ch === '\\' && i + 1 < text.length && (text[i + 1] === '"' || text[i + 1] === '\\' || text[i + 1] === '$' || text[i + 1] === '`')) {
        startToken()
        buf += text[i + 1]
        i += 1
      } else if (ch === '$' && text[i + 1] === '(') {
        subshellQuotes.push('"')
        quote = null
        flushSegment()
        i += 1
      } else if (ch === '`') {
        quote = null
        flushSegment()
      } else {
        startToken()
        buf += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      startToken()
      tokenQuoted = true
      quote = ch
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      subshellQuotes.push(null)
      flushSegment()
      i += 1
      continue
    }
    if (ch === ')' && subshellQuotes.length > 0) {
      flushSegment()
      quote = subshellQuotes.pop()
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '\r' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') {
      flushSegment()
      continue
    }
    if (ch === '<' || ch === '>') {
      if (hasToken && /^\d+$/.test(buf)) {
        buf = ''
        hasToken = false
        tokenRedir = false
      } else {
        flushToken()
      }
      if (text[i + 1] === ch || text[i + 1] === '&') i += 1
      nextRedir = true
      continue
    }
    if (/\s/.test(ch)) {
      flushToken()
      continue
    }
    startToken()
    if (ch === '#') tokenUnquotedHash = true
    buf += ch
  }
  flushSegment()
  return segments
}

// Returns token indices that hold content-search pattern arguments (not file paths)
// for standard read-only text search commands (`grep`, `rg`, `git grep`, `Select-String`).
function searchPatternTokenIndices(tokens) {
  const exempt = new Set()
  let idx = 0
  while (idx < tokens.length) {
    const tok = tokens[idx]
    if (tok.redir) return exempt
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.value)) {
      idx += 1
      continue
    }
    const base = tok.value.replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.exe$/i, '').toLowerCase()
    if (base === 'command' || base === 'env' || base === 'time' || base === 'nice' || base === 'nohup') {
      idx += 1
      continue
    }
    break
  }
  if (idx >= tokens.length) return exempt
  let cmd = tokens[idx].value.replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.exe$/i, '').toLowerCase()
  idx += 1
  if (cmd === 'git') {
    if (idx < tokens.length && !tokens[idx].redir && tokens[idx].value.toLowerCase() === 'grep') {
      cmd = 'grep'
      idx += 1
    } else {
      return exempt
    }
  }
  if (!SEARCH_SHELL_COMMANDS.has(cmd)) return exempt

  if (cmd === 'select-string' || cmd === 'sls') {
    let explicit = false
    let gotPositional = false
    for (let i = idx; i < tokens.length; i += 1) {
      const tok = tokens[i]
      if (tok.redir) continue
      const lower = tok.value.toLowerCase()
      if (lower === '-pattern') {
        explicit = true
        if (i + 1 < tokens.length && !tokens[i + 1].redir) {
          exempt.add(i + 1)
          i += 1
        }
        continue
      }
      if (lower.startsWith('-pattern:')) {
        explicit = true
        exempt.add(i)
        continue
      }
      if (lower.startsWith('-')) {
        if (lower === '-path' || lower === '-literalpath' || lower === '-exclude' || lower === '-include' || lower === '-encoding' || lower === '-context') {
          i += 1
        }
        continue
      }
      if (!explicit && !gotPositional) {
        gotPositional = true
        exempt.add(i)
      }
    }
    return exempt
  }

  const isRg = cmd === 'rg'
  let sawDoubleDash = false
  let sawExplicitPattern = false
  let gotPositional = false
  for (let i = idx; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (tok.redir) continue
    const value = tok.value
    if (!sawDoubleDash && value === '--') {
      sawDoubleDash = true
      continue
    }
    if (!sawDoubleDash && value.startsWith('-') && value.length > 1) {
      if (GREP_PATTERN_FLAGS.has(value)) {
        sawExplicitPattern = true
        if (i + 1 < tokens.length && !tokens[i + 1].redir) {
          exempt.add(i + 1)
          i += 1
        }
        continue
      }
      if (value.startsWith('--regexp=') || (value.startsWith('-e') && value.length > 2 && !value.startsWith('--'))) {
        sawExplicitPattern = true
        exempt.add(i)
        continue
      }
      if (value === '-f' || value === '--file' || value.startsWith('--file=') || (value.startsWith('-f') && value.length > 2 && !value.startsWith('--'))) {
        sawExplicitPattern = true
        if (value === '-f' || value === '--file') i += 1
        continue
      }
      if (GREP_VALUE_FLAGS.has(value) || (isRg && RG_ONLY_VALUE_FLAGS.has(value))) {
        i += 1
        continue
      }
      continue
    }
    if (!sawExplicitPattern && !gotPositional) {
      gotPositional = true
      exempt.add(i)
    }
  }
  return exempt
}

export function install(rt) {
  const { ctx, state } = rt

  const isPrivate = id => rt.botOf(id)?.private === true
  const privateBots = () => Object.values(state.bots).filter(bot => bot.private === true)
  // Deleting a private Bot does not make the files and memory it leaves behind public.
  const protectedBots = () => [...new Map([...(state.privateArchives ?? []), ...privateBots()].map(bot => [bot.id, bot])).values()]
  // Every Session a private Bot speaks from: its own chat, the parts it opened while it
  // was busy (a background part reads and writes in that Bot's name), its earlier parts
  // and its groups. A deleted Bot's archive lists them itself.
  const sessionsOf = bot => [...new Set([bot.id, ...(bot.sessionIds ?? [
    rt.chatOf(bot.id), ...(bot.segments ?? []).map(segment => segment.sessionId),
    ...openSessions(bot), ...retiredTaskSessionIds(bot), ...rt.groupSessionsOf(bot.id),
  ])])]
  const dataRoots = () => [rt.dshHome, rt.home, process.env.DS_BOT_USER_DSH_HOME?.trim()].filter(Boolean)

  // A path as it is and as the file system resolves it, folded for comparing. realBeyond
  // also resolves a link above a file that does not exist yet. A per-call memo deduplicates
  // repeated paths within one guard check without caching symlink targets across calls.
  const spellings = (path, memo) => {
    const resolved = resolve(path)
    if (memo?.has(resolved)) return memo.get(resolved)
    const pending = rt.realBeyond(resolved).then(
      real => [...new Set([fold(resolved), fold(real)])],
      (error) => {
        if (memo?.get(resolved) === pending) memo.delete(resolved)
        throw error
      },
    )
    memo?.set(resolved, pending)
    return pending
  }

  // The Bot a call speaks for. A subagent speaks for the Bot at the root of its
  // parent chain, however many subagents sit between them.
  const callerOf = async (exec) => {
    const own = rt.selfOf(exec.agent?.id) ?? rt.selfOf(exec.agent?.session?.id)
    if (own !== undefined) return own
    let parent = exec.agent?.session?.header?.parentSession
    const seen = new Set()
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent)
      const owner = rt.selfOf(parent)
      if (owner !== undefined) return owner
      const agent = await rt.resolveAgent(parent).catch(() => undefined)
      parent = agent?.session?.header?.parentSession
    }
    return undefined
  }

  const teamFolder = () => rt.teamFolder() ?? resolve(rt.defaultTeamFolder())
  const teamMemory = join(rt.home, 'memory', 'team')
  // The memory of deleted Bots and groups. What a private Bot left there is a region of
  // its own (archivePath) and is checked first; the rest was never closed, and the
  // memory of a Bot whose protection the user lifted is in it.
  const memoryArchive = join(rt.home, 'memory', 'archive')

  const DATA_ROOTS_TTL_MS = 1_000
  let dataRootsMemo
  let secretRootsMemo
  const clearDataRootsMemo = () => {
    dataRootsMemo = undefined
    secretRootsMemo = undefined
  }
  const offAdopted = rt.onAdopted?.(clearDataRootsMemo)
  ctx.effect?.(() => () => {
    offAdopted?.()
    clearDataRootsMemo()
  }, 'ds-bot: privacy cache')

  const spelledSecretRoots = (memo) => {
    const now = Date.now()
    if (secretRootsMemo !== undefined && now - secretRootsMemo.at < DATA_ROOTS_TTL_MS) {
      return secretRootsMemo.value
    }
    const pending = Promise.all([
      spellings(join(rt.home, 'secret-refs'), memo),
      spellings(join(rt.home, 'secret-files'), memo),
    ]).then(([refsRoot, filesRoot]) => ({ refsRoot, filesRoot }), (error) => {
      if (secretRootsMemo?.value === pending) secretRootsMemo = undefined
      throw error
    })
    secretRootsMemo = { at: now, value: pending }
    return pending
  }

  // Where a private Bot keeps what must stay closed: its folder and its memory. Its
  // Sessions and its id are in file names under DSH's and the team's data.
  const regionsOf = (bot, memo) => Promise.all([
    bot.workDir,
    join(rt.home, 'memory', 'bots', bot.id),
    join(rt.home, 'browser-profiles', bot.id),
    join(rt.home, 'browser-downloads', bot.id),
    join(rt.home, 'side', `${bot.id}.json`),
    join(rt.home, 'btw', bot.id),
    bot.archivePath,
  ].filter(Boolean).map(dir => spellings(dir, memo))).then(list => list.flat())

  const sharedFiles = memo => Promise.all([
    rt.statePath,
    join(rt.home, 'chat-index.sqlite'),
    join(rt.home, 'chat-index.sqlite-wal'),
    join(rt.home, 'chat-index.sqlite-shm'),
    join(rt.home, 'usage.sqlite'),
    join(rt.home, 'usage.sqlite-wal'),
    join(rt.home, 'usage.sqlite-shm'),
    join(rt.home, 'coordination.sqlite'),
    join(rt.home, 'coordination.sqlite-wal'),
    join(rt.home, 'coordination.sqlite-shm'),
    join(rt.home, 'coordination.sqlite-journal'),
    join(rt.home, 'inflight.json'),
    join(rt.home, 'learning', 'state.json'),
    join(rt.home, 'ocr.json'),
    join(rt.home, 'secrets.json'),
    join(rt.home, 'api-tokens.json'),
    join(rt.home, 'mcp.json'),
    join(rt.home, 'api-config.json'),
    join(rt.home, 'api-audit.jsonl'),
    join(rt.home, 'api-runs.json'),
    join(rt.home, 'api-endpoint.json'),
    join(rt.home, 'api-uploads'),
    join(rt.home, 'task-reports'),
    join(rt.home, 'memory', 'journal.jsonl'),
    join(rt.home, 'memory', 'journal.torn'),
    join(rt.home, 'memory', 'pending.json'),
    join(rt.home, 'logs', 'diagnostics.jsonl'),
    join(rt.home, 'telemetry.json'),
  ].filter(Boolean).map(file => spellings(file, memo))).then(list => list.flat())

  const spelledDataRoots = (memo) => {
    const roots = dataRoots()
    const key = `${state.revision ?? 0}\0${roots.join('\0')}`
    const now = Date.now()
    if (dataRootsMemo !== undefined && dataRootsMemo.key === key && now - dataRootsMemo.at < DATA_ROOTS_TTL_MS) {
      return dataRootsMemo.value
    }
    const pending = Promise.all(roots.map(root => spellings(root, memo))).then(list => list.flat(), (error) => {
      if (dataRootsMemo?.value === pending) dataRootsMemo = undefined
      throw error
    })
    dataRootsMemo = { key, at: now, value: pending }
    return pending
  }

  const openFoldersOf = async (self, ownBot, moving, memo) => {
    const ownRegions = ownBot === undefined ? [] : await regionsOf(ownBot, memo)
    const ownSecretFiles = typeof self === 'string' && self !== '' ? join(rt.home, 'secret-files', self) : undefined
    const open = [rt.workDirOf({ botId: self }), teamFolder(), teamMemory, moving ? undefined : memoryArchive, dirname(manualDirectory()), ownSecretFiles].filter(Boolean)
    return [...(await Promise.all(open.map(dir => spellings(dir, memo)))).flat(), ...ownRegions]
  }

  // The private Bot that `path` belongs to, other than `self`; undefined when it is open.
  // `search` is for tools that walk a folder: a folder that holds a closed one is closed
  // too, and so are the data folders, where the walk cannot be told which files to skip.
  async function ownerOfPath(path, { self, search = false, base, memo = new Map() } = {}) {
    const bots = protectedBots()
    if (bots.length === 0) return undefined
    const keys = await spellings(base === undefined ? path : resolve(base, path), memo)
    for (const bot of bots) {
      if (bot.id === self) continue
      const needles = sessionsOf(bot).map(fold)
      const regions = await regionsOf(bot, memo)
      for (const key of keys) {
        if (regions.some(region => within(key, region) || (search && within(region, key)))) return bot
        if (needles.some(needle => key.includes(needle))) return bot
      }
    }
    const other = bots.find(bot => bot.id !== self)
    for (const file of await sharedFiles(memo)) if (other !== undefined && keys.some(key => key.startsWith(file))) return other
    if (other !== undefined) {
      const ownBot = rt.botOf(self)
      const ownIds = ownBot === undefined ? [] : sessionsOf(ownBot).map(fold)
      // A walk of the archive stays closed while a private Bot's memory is on its way
      // there: until the path is known, the walk cannot be told which folder to skip.
      const moving = search && bots.some(bot => bot.archiving === true)
      const folders = await openFoldersOf(self, ownBot, moving, memo)
      const roots = await spelledDataRoots(memo)
      for (const key of keys) {
        if ((!search && ownIds.some(id => key.includes(id))) || folders.some(folder => within(key, folder))) continue
        // Direct reads are closed too, not only walks: an index, pending record or log
        // can hold the same private text without naming the Session in its file name.
        if (roots.some(root => within(key, root) || (search && within(root, key)))) return other
      }
    }
    return undefined
  }

  // Text a shell runs: a closed path anywhere in it closes the command. A path that the
  // command builds, or reaches by walking up from a folder, is not seen.
  async function ownerInText(text, self, memo = new Map()) {
    const flat = fold(normalizeSlashes(text))
    const bots = protectedBots()
    for (const bot of bots) {
      if (bot.id === self) continue
      const spelled = (await regionsOf(bot, memo)).flatMap(asShell)
      if (spelled.some(region => flat.includes(region)) || sessionsOf(bot).some(id => flat.includes(fold(id)))) return bot
    }
    const other = bots.find(bot => bot.id !== self)
    for (const file of await sharedFiles(memo)) if (other !== undefined && asShell(file).some(spelled => flat.includes(spelled))) return other
    return undefined
  }

  const closed = (bot, what) => new Error(`${bot.name} is a private Bot, and other Bots cannot reach its ${what}. Ask the user if ${bot.name} should share something.`)

  // What a private Bot sends out is shown to the user first, as the user sees it.
  async function approve(exec, { en, zh }, evidence = {}) {
    const approval = ctx.get?.('approval')
    if (approval === undefined || exec.agent?.session === undefined) throw new Error('A private Bot needs the user\'s approval for this, and there is no way to ask for it here, so it was not done.')
    const outcome = await (rt.requestActionApproval ?? (request => approval.request(request)))({
      agent: exec.agent,
      toolName: exec.name,
      privacy: true,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason: en,
      displayReason: { en, zh },
      ...(exec.signal ? { signal: exec.signal } : {}),
    }, { kind: 'privacy', arguments: exec.arguments, ...evidence })
    if (outcome === 'allowed-once') return
    throw new Error(outcome === 'rejected' ? 'The user did not allow it, so it was not done.'
      : outcome === 'cancelled' ? 'The approval was cancelled, so it was not done.'
        : 'The approval could not be answered, so it was not done.')
  }

  // The Bot a tool argument names, as the tools and the memory scopes read it.
  const botNamed = ref => (typeof ref === 'string' && ref !== '' ? rt.findBot(ref) ?? rt.findBot(unquote(ref)) : undefined)

  // Tools between Bots. Other Bots may not reach a private Bot; what a private Bot sends
  // to them is the user's to allow. A private Bot is no member of a group, which the
  // roster checks as the members are written.
  async function guardTeam(exec, self) {
    const args = exec.arguments ?? {}
    const target = (ref) => {
      const bot = botNamed(ref)
      return bot !== undefined && isPrivate(bot.id) && bot.id !== self ? bot : undefined
    }
    switch (exec.name) {
      case 'delegate_work':
      case 'message_bot': {
        const body = String(args.goal ?? args.message ?? '')
        const bot = target(args.to)
        if (bot) throw new Error(`Not sent: ${bot.name} is a private Bot, and other Bots cannot delegate work to it. Ask the user to pass it on.`)
        const to = botNamed(args.to)
        if (isPrivate(self) && to !== undefined) await approve(exec, { en: `Let ${rt.botOf(self).name} send this to ${to.name}?\n\n${body}`, zh: `允许 ${rt.botOf(self).name} 把下面的内容发给 ${to.name} 吗？\n\n${body}` })
        return
      }
      case 'note_bot': {
        const body = String(args.note ?? '')
        const bot = target(args.to)
        if (bot) throw new Error(`Not sent: ${bot.name} is a private Bot, and other Bots cannot leave notes for it. Ask the user to pass it on.`)
        const to = botNamed(args.to)
        if (isPrivate(self) && to !== undefined) await approve(exec, { en: `Let ${rt.botOf(self).name} leave this note for ${to.name}?\n\n${body}`, zh: `允许 ${rt.botOf(self).name} 给 ${to.name} 留这条静默留言吗？\n\n${body}` })
        return
      }
      case 'ask_back': {
        const body = String(args.question ?? '')
        const explicit = typeof args.work_id === 'string' && args.work_id.trim() !== '' ? args.work_id.trim() : undefined
        const activeId = explicit ?? rt.workOf?.(rt.live?.get(exec.agent?.id)?.info)
        const active = activeId !== undefined ? rt.resolveWork?.(activeId)?.work : undefined
        const to = active?.from ? rt.botOf(active.from) : undefined
        if (to !== undefined && isPrivate(to.id) && to.id !== self) throw new Error(`Not sent: ${to.name} is a private Bot, and other Bots cannot message it.`)
        if (isPrivate(self) && to !== undefined) await approve(exec, { en: `Let ${rt.botOf(self).name} ask ${to.name} this?\n\n${body}`, zh: `允许 ${rt.botOf(self).name} 向 ${to.name} 追问下面的问题吗？\n\n${body}` })
        return
      }
      case 'answer_work': {
        const body = String(args.answer ?? '')
        const explicit = typeof args.work_id === 'string' && args.work_id.trim() !== '' ? args.work_id.trim() : undefined
        const turnAskWork = rt.live?.get(exec.agent?.id)?.info?.askWork
        const active = explicit !== undefined
          ? rt.resolveWork?.(explicit)?.work
          : turnAskWork !== undefined
            ? rt.resolveWork?.(turnAskWork)?.work
            : rt.needInputWorksFor?.(self)?.[0]?.work
        const to = active?.to ? rt.botOf(active.to) : undefined
        if (to !== undefined && isPrivate(to.id) && to.id !== self) throw new Error(`Not sent: ${to.name} is a private Bot, and other Bots cannot message it.`)
        if (isPrivate(self) && to !== undefined) await approve(exec, { en: `Let ${rt.botOf(self).name} send this answer to ${to.name}?\n\n${body}`, zh: `允许 ${rt.botOf(self).name} 把下面的答复发给 ${to.name} 吗？\n\n${body}` })
        return
      }
      case 'cancel_work': {
        const ref = typeof args.target === 'string' ? args.target.trim() : ''
        const byRef = ref !== '' ? rt.resolveWork?.(ref)?.work : undefined
        const byName = botNamed(ref)
        const touched = [byRef?.to ? rt.botOf(byRef.to) : undefined, byRef?.from ? rt.botOf(byRef.from) : undefined, byName].filter(Boolean)
        const locked = touched.find(bot => isPrivate(bot.id) && bot.id !== self)
        if (locked !== undefined) throw new Error(`Not cancelled: ${locked.name} is a private Bot, and other Bots cannot touch its work.`)
        const to = byRef?.to ? rt.botOf(byRef.to) : byName
        const reason = String(args.reason ?? '').trim()
        if (isPrivate(self) && to !== undefined && to.id !== self) {
          const detail = reason !== '' ? `\n\n${reason}` : ''
          await approve(exec, { en: `Let ${rt.botOf(self).name} cancel work on ${to.name}?${detail}`, zh: `允许 ${rt.botOf(self).name} 取消发给 ${to.name} 的工单吗？${detail}` })
        }
        return
      }
      // Every Bot reads the shared capabilities, so saving one shares what is in it.
      case 'save_capability': {
        if (!isPrivate(self)) return
        const shown = JSON.stringify(args, null, 2)
        await approve(exec, { en: `Let ${rt.botOf(self).name} share this with the team?\n\n${shown}`, zh: `允许 ${rt.botOf(self).name} 把下面的内容共享给团队吗？\n\n${shown}` })
        return
      }
      case 'stop_bot': {
        const bot = target(args.bot)
        if (bot) throw closed(bot, 'turns')
        return
      }
      case 'attach_capability':
      case 'detach_capability': {
        const bot = target(args.bot)
        if (bot) throw closed(bot, 'capabilities')
        return
      }
      case 'update_bot': {
        const bot = target(args.bot)
        if (bot) throw closed(bot, 'settings')
        return
      }
      case 'bot_recall':
      case 'bot_remember':
      case 'bot_forget': {
        const bot = target(args.scope)
        if (bot) throw closed(bot, 'memory')
        return
      }
      default:
    }
  }

  // A Session started under a private Bot is closed too, even when its own id is not in
  // the Bot's chat history. Walk the same parent chain as the caller check.
  async function ownerOfSession(id, self) {
    const bots = protectedBots()
    const owns = (sessionId, bot) => bot.id !== self && sessionsOf(bot).includes(sessionId)
    const direct = bots.find(bot => owns(id, bot))
    if (direct) return direct
    const seen = new Set([id])
    let current = id
    for (;;) {
      const agent = await rt.resolveAgent(current).catch(() => undefined)
      const parent = agent?.session?.header?.parentSession
      if (parent === undefined || seen.has(parent)) return undefined
      const owner = bots.find(bot => owns(parent, bot))
      if (owner) return owner
      seen.add(parent)
      current = parent
    }
  }

  const presentPathsOf = (args) => (Array.isArray(args?.files) ? args.files : [])
    .map(file => (typeof file?.path === 'string' && file.path.trim() !== '' ? expandHome(file.path) : ''))
    .filter(Boolean)

  // The file tools, the shell and the session search: where the path or text names a
  // closed place, the call fails before it runs.
  async function guardFiles(exec, self) {
    const args = exec.arguments ?? {}
    const folder = () => rt.sessionFolder(exec.agent?.session ?? exec.agent)
    const refuse = (bot) => { throw closed(bot, 'files') }
    const name = exec.name
    const memo = new Map()
    if (name === 'present') {
      const base = folder()
      for (const path of presentPathsOf(args)) {
        const bot = await ownerOfPath(path, { self, base, memo })
        if (bot) refuse(bot)
      }
      return
    }
    if (name in FILE_TOOLS) {
      const path = args[FILE_TOOLS[name]]
      if (typeof path !== 'string' || path === '') return
      const bot = await ownerOfPath(path, { self, base: folder(), memo })
      if (bot) refuse(bot)
      // A private Bot's file changes stay in its own folder unless the user allows them.
      if (isPrivate(self) && WRITE_TOOLS.includes(name)) {
        const own = await spellings(rt.botOf(self).workDir, memo)
        const base = folder()
        if (!isAbsolute(path) && (typeof base !== 'string' || !isAbsolute(base))) throw new Error('The file destination cannot be determined, so it was not changed.')
        const absolute = resolve(base ?? '.', path)
        const real = await rt.realBeyond(absolute)
        const target = [fold(absolute), fold(real)]
        if (!target.every(key => own.some(root => within(key, root)))) {
          await approve(exec, { en: `Let ${rt.botOf(self).name} change ${absolute}? It is outside its own folder.`, zh: `允许 ${rt.botOf(self).name} 修改 ${absolute} 吗？它在自己的文件夹之外。` }, { cwd: base, path: absolute, resolvedPath: real })
          const current = resolve(folder() ?? '.', path)
          if (current !== absolute || await rt.realBeyond(current) !== real || resolve(folder() ?? '.', path) !== absolute) {
            throw new Error('The file destination changed during approval, so it was not changed.')
          }
        }
      }
      return
    }
    if (name === 'apply_patch') {
      const paths = patchPathsOf(args)
      if (paths.length === 0) return
      const base = folder()
      for (const path of paths) {
        const bot = await ownerOfPath(path, { self, base, memo })
        if (bot) refuse(bot)
      }
      if (isPrivate(self)) {
        const own = await spellings(rt.botOf(self).workDir, memo)
        const outside = []
        for (const path of paths) {
          if (!isAbsolute(path) && (typeof base !== 'string' || !isAbsolute(base))) {
            throw new Error('The file destination cannot be determined, so it was not changed.')
          }
          const absolute = resolve(base ?? '.', path)
          const real = await rt.realBeyond(absolute)
          const target = [fold(absolute), fold(real)]
          if (!target.every(key => own.some(root => within(key, root)))) {
            outside.push({ path, absolute, real })
          }
        }
        if (outside.length > 0) {
          const list = outside.map(item => item.absolute).join(', ')
          const botName = rt.botOf(self).name
          await approve(exec, {
            en: `Let ${botName} change ${list}? It is outside its own folder.`,
            zh: `允许 ${botName} 修改 ${list} 吗？它在自己的文件夹之外。`,
          }, {
            cwd: base,
            path: outside[0].absolute,
            resolvedPath: outside[0].real,
            ...(outside.length > 1 ? { paths: outside.map(item => item.absolute), resolvedPaths: outside.map(item => item.real) } : {}),
          })
          for (const item of outside) {
            const current = resolve(folder() ?? '.', item.path)
            if (current !== item.absolute || await rt.realBeyond(current) !== item.real || resolve(folder() ?? '.', item.path) !== item.absolute) {
              throw new Error('The file destination changed during approval, so it was not changed.')
            }
          }
        }
      }
      return
    }
    if (SEARCH_TOOLS.includes(name)) {
      const where = typeof args.path === 'string' && args.path !== '' ? args.path : '.'
      const bot = await ownerOfPath(where, { self, search: true, base: folder(), memo })
        ?? (typeof args.pattern === 'string' && /^([a-z]:|[\\/]|~)/i.test(args.pattern) ? await ownerOfPath(args.pattern.replace(/[*?[{].*$/, ''), { self, search: true, base: folder(), memo }) : undefined)
      if (bot) refuse(bot)
      return
    }
    if (SHELL_TOOLS.includes(name)) {
      const text = strings(args).join('\n')
      const bot = await ownerInText(text, self, memo)
      if (bot) refuse(bot)
      if (name === 'run_code') {
        const base = folder()
        for (const candidate of codePathCandidates(text)) {
          const targetBot = await ownerOfPath(candidate, { self, base, memo })
          if (targetBot) refuse(targetBot)
        }
        const otherPrivate = protectedBots().find(found => found.id !== self)
        if (otherPrivate !== undefined && typeof args.code === 'string' && hasDirectHostModuleAccess(args.code)) {
          throw new Error(`${otherPrivate.name} is a private Bot, and other Bots cannot import or invoke direct host filesystem or process modules in run_code. Use tools.* instead.`)
        }
        if (isPrivate(self)) {
          const own = await spellings(rt.botOf(self).workDir, memo)
          const policyMode = args.sandbox_permissions ?? ctx.get?.('sandboxPolicy')?.resolve?.({ session: exec.agent?.session })?.mode
          const baseOutside = typeof base !== 'string' || !isAbsolute(base)
            || !(await spellings(base, memo)).every(key => own.some(root => within(key, root)))
          if (baseOutside || policyMode === 'danger-full-access') {
            const botName = rt.botOf(self).name
            const summary = typeof args.description === 'string' && args.description.trim() !== '' ? args.description.trim() : 'run_code'
            await approve(exec, {
              en: `Let ${botName} run code (${summary}) outside its own folder fence?`,
              zh: `允许 ${botName} 在自己的文件夹围栏之外运行代码（${summary}）吗？`,
            }, { cwd: base, ...(policyMode === undefined ? {} : { sandboxMode: policyMode }) })
          }
        }
      }
      return
    }
    if ((name === 'subagent' || name === 'subagent_fork') && typeof args.cwd === 'string') {
      const bot = await ownerOfPath(args.cwd, { self, search: true, base: folder(), memo })
      if (bot) refuse(bot)
      return
    }
    if (name === 'working_directory' && typeof args.cd === 'string') {
      const bot = await ownerOfPath(args.cd, { self, search: true, base: folder(), memo })
      if (bot) refuse(bot)
      return
    }
    if (SESSION_TOOLS.includes(name)) {
      const asked = strings([args.session_id, args.session_ids, args.parent_session_ids])
      for (const id of asked) {
        const bot = await ownerOfSession(id, self)
        if (bot) refuse(bot)
      }
      // DSH scopes Session search to the caller's cwd. A subagent can have another cwd,
      // so an unfiltered search is closed too; explicit safe ids still narrow it.
      if (name === 'session_search' && args.session_ids === undefined && args.parent_session_ids === undefined) {
        const closedBot = protectedBots().find(found => found.id !== self)
        if (closedBot) throw closed(closedBot, 'Sessions')
      }
    }
  }

  // Host-owned API credential/audit and telemetry consent files are always off-limits
  // to every Bot, even in teams with no private Bots.
  const apiProtectedFiles = async (memo = new Map()) => (await Promise.all([
    join(rt.home, 'api-'),
    join(rt.home, 'api-endpoint.json'),
    join(rt.home, 'api-tokens.json'),
    join(rt.home, 'mcp.json'),
    join(rt.home, 'api-audit.jsonl'),
    join(rt.home, 'api-config.json'),
    join(rt.home, 'api-runs.json'),
    join(rt.home, 'telemetry.json'),
  ].map(file => spellings(file, memo)))).flat()

  async function guardApiFiles(exec, memo = new Map()) {
    const args = exec.arguments ?? {}
    const name = exec.name
    const folder = () => rt.sessionFolder(exec.agent?.session ?? exec.agent)
    const closedApi = () => new Error('Bots cannot read or modify DS Bot API token, audit, or telemetry consent files.')
    if (name in FILE_TOOLS) {
      const path = args[FILE_TOOLS[name]]
      if (typeof path !== 'string' || path === '') return
      const base = folder()
      const [keys, protectedPaths] = await Promise.all([
        spellings(base === undefined ? path : resolve(base, path), memo),
        apiProtectedFiles(memo),
      ])
      if (keys.some(key => protectedPaths.some(file => key === file || key.startsWith(file.endsWith('api-') ? file : `${file}.`)))) throw closedApi()
      return
    }
    if (name === 'present') {
      const paths = presentPathsOf(args)
      if (paths.length === 0) return
      const base = folder()
      const protectedPaths = await apiProtectedFiles(memo)
      for (const path of paths) {
        const keys = await spellings(base === undefined ? path : resolve(base, path), memo)
        if (keys.some(key => protectedPaths.some(file => key === file || key.startsWith(file.endsWith('api-') ? file : `${file}.`)))) throw closedApi()
      }
      return
    }
    if (name === 'apply_patch') {
      const paths = patchPathsOf(args)
      if (paths.length === 0) return
      const base = folder()
      const protectedPaths = await apiProtectedFiles(memo)
      for (const path of paths) {
        const keys = await spellings(base === undefined ? path : resolve(base, path), memo)
        if (keys.some(key => protectedPaths.some(file => key === file || key.startsWith(file.endsWith('api-') ? file : `${file}.`)))) throw closedApi()
      }
      return
    }
    if (SEARCH_TOOLS.includes(name)) {
      const where = typeof args.path === 'string' && args.path !== '' ? args.path : '.'
      const pattern = typeof args.pattern === 'string' ? fold(args.pattern) : ''
      if (pattern.includes('api-') || pattern.includes('mcp.json')) throw closedApi()
      const base = folder()
      const [keys, protectedPaths] = await Promise.all([
        spellings(base === undefined ? where : resolve(base, where), memo),
        apiProtectedFiles(memo),
      ])
      if (keys.some(key => protectedPaths.some(file => within(file, key) || key.startsWith(file.endsWith('api-') ? file : `${file}.`)))) throw closedApi()
      return
    }
    if (SHELL_TOOLS.includes(name)) {
      const rawText = strings(args).join('\n')
      const flat = fold(normalizeSlashes(rawText))
      if (name !== 'run_code' && (flat.includes('api-') || flat.includes('mcp.json'))) throw closedApi()
      const protectedPaths = await apiProtectedFiles(memo)
      for (const file of protectedPaths) {
        if (asShell(file).some(spelled => flat.includes(spelled))) throw closedApi()
      }
      if (name === 'run_code') {
        const base = folder()
        for (const candidate of codePathCandidates(rawText)) {
          const keys = await spellings(base === undefined ? candidate : resolve(base, candidate), memo)
          if (keys.some(key => protectedPaths.some(file => key === file || key.startsWith(file.endsWith('api-') ? file : `${file}.`)))) throw closedApi()
        }
        if (flat.includes('api-') || flat.includes('mcp.json') || flat.includes('telemetry.json')) {
          const homeKeys = await spellings(rt.home, memo)
          const baseKeys = base === undefined ? [] : await spellings(base, memo)
          if (base === undefined || baseKeys.some(k => homeKeys.some(h => within(h, k)))) throw closedApi()
        }
        return
      }
      if (flat.includes('telemetry.json')) {
        const base = folder()
        const homeKeys = await spellings(rt.home, memo)
        const baseKeys = base === undefined ? [] : await spellings(base, memo)
        if (base === undefined || baseKeys.some(k => homeKeys.some(h => overlap(k, h)))) throw closedApi()
      }
    }
  }

  // Per-Bot temporary secret files (`<home>/secret-files/<botId>/`) and host-only secret
  // storage (`<home>/secret-refs/`, `<home>/secret-files/_op/`) are fenced for every Bot,
  // regardless of whether any Bot is marked `private: true`.
  function guardSecretFiles(exec, self, memo = new Map()) {
    const name = exec.name
    if (!SECRET_GUARDED_TOOLS.has(name)) return
    const args = exec.arguments ?? {}
    if (name in FILE_TOOLS) {
      const path = args[FILE_TOOLS[name]]
      if (typeof path !== 'string' || path === '') return
    } else if (name === 'apply_patch') {
      if (typeof args.input !== 'string' || args.input === '') return
    } else if (name === 'present') {
      if (presentPathsOf(args).length === 0) return
    } else if (name === 'subagent' || name === 'subagent_fork') {
      if (typeof args.cwd !== 'string' || args.cwd === '') return
    } else if (name === 'working_directory') {
      if (typeof args.cd !== 'string' || args.cd === '') return
    }
    return guardSecretFilesAsync(exec, self, memo)
  }

  async function guardSecretFilesAsync(exec, self, memo) {
    const args = exec.arguments ?? {}
    const name = exec.name
    const folder = () => rt.sessionFolder(exec.agent?.session ?? exec.agent)
    const closedSecret = () => new Error('Bots cannot access secret reference files or another Bot\'s temporary secret files.')
    let ownDirPromise
    const getOwnDir = () => (ownDirPromise ??= (typeof self === 'string' && self !== ''
      ? spellings(join(rt.home, 'secret-files', self), memo)
      : Promise.resolve([])))
    const rootsOf = ({ refsRoot, filesRoot }) => ({
      refsRoot,
      filesRoot,
      inRefs: keys => keys.some(key => refsRoot.some(root => within(key, root))),
      overlapsRefs: keys => keys.some(key => refsRoot.some(root => overlap(key, root))),
      inFiles: keys => keys.some(key => filesRoot.some(root => within(key, root))),
      overlapsFiles: keys => keys.some(key => filesRoot.some(root => overlap(key, root))),
    })
    const allOwnSecretFiles = (keys, ownDir) => keys.every(key => ownDir.some(dir => within(key, dir) && key !== dir))
    const allInOwnSecretDir = (keys, ownDir) => keys.every(key => ownDir.some(dir => within(key, dir)))

    if (name in FILE_TOOLS) {
      const path = args[FILE_TOOLS[name]]
      const base = folder()
      const [roots, keys] = await Promise.all([
        spelledSecretRoots(memo),
        spellings(base === undefined ? path : resolve(base, path), memo),
      ])
      const { inRefs, inFiles } = rootsOf(roots)
      if (inRefs(keys)) throw closedSecret()
      if (inFiles(keys)) {
        if (WRITE_TOOLS.includes(name)) throw closedSecret()
        const ownDir = await getOwnDir()
        if (!allOwnSecretFiles(keys, ownDir)) throw closedSecret()
      }
      return
    }
    if (name === 'present') {
      const paths = presentPathsOf(args)
      if (paths.length === 0) return
      const base = folder()
      const roots = await spelledSecretRoots(memo)
      const { inRefs, inFiles } = rootsOf(roots)
      for (const path of paths) {
        const keys = await spellings(base === undefined ? path : resolve(base, path), memo)
        if (inRefs(keys) || inFiles(keys)) throw closedSecret()
      }
      return
    }
    if (name === 'apply_patch') {
      const paths = patchPathsOf(args)
      if (paths.length === 0) return
      const base = folder()
      const roots = await spelledSecretRoots(memo)
      const { inRefs, inFiles } = rootsOf(roots)
      for (const path of paths) {
        const keys = await spellings(base === undefined ? path : resolve(base, path), memo)
        if (inRefs(keys) || inFiles(keys)) throw closedSecret()
      }
      return
    }
    if (SEARCH_TOOLS.includes(name)) {
      const where = typeof args.path === 'string' && args.path !== '' ? args.path : '.'
      const base = folder()
      const searchBase = base === undefined ? where : resolve(base, where)
      const [roots, keys] = await Promise.all([
        spelledSecretRoots(memo),
        spellings(searchBase, memo),
      ])
      const { overlapsRefs, overlapsFiles } = rootsOf(roots)
      const checkKeys = async (targetKeys) => {
        if (overlapsRefs(targetKeys)) throw closedSecret()
        if (overlapsFiles(targetKeys)) {
          const ownDir = await getOwnDir()
          if (!allInOwnSecretDir(targetKeys, ownDir)) throw closedSecret()
        }
      }
      await checkKeys(keys)

      // `grep`'s `pattern` searches file contents, not file paths; only validate
      // path-like globs (`glob.pattern` or `grep.glob`).
      const pathPattern = name === 'glob' ? args.pattern : args.glob
      if (typeof pathPattern === 'string' && pathPattern !== '') {
        const normalizedPat = pathPattern.replace(/\\/g, '/')
        const expandedPat = expandHome(normalizedPat)
        const prefix = expandedPat.replace(/[*?[{].*$/, '')
        const hasTraversal = /(?:^|\/)\.\.(?:$|\/)/.test(normalizedPat)
        const isRooted = /^([a-z]:|\/|~)/i.test(normalizedPat)
        if (prefix !== '') {
          const patTarget = isAbsolute(prefix) ? prefix : resolve(searchBase, prefix)
          const patKeys = await spellings(patTarget, memo)
          await checkKeys(patKeys)
        }
        // Catch wildcards placed before `..` (e.g. `*/../secret-refs/*`) where the
        // static prefix before the first wildcard is empty and cannot be resolved.
        if (hasTraversal && (prefix === '' || /[*?[{].*\.\./.test(normalizedPat))) {
          const foldedPat = fold(normalizedPat)
          if (/(?:^|[^a-z0-9_.-])secret-(?:refs|files)(?:$|[^a-z0-9_.-])/i.test(foldedPat) || isRooted) {
            throw closedSecret()
          }
          const parentKeys = await spellings(resolve(searchBase, '..'), memo)
          await checkKeys(parentKeys)
        }
      }
      return
    }
    if (name === 'subagent' || name === 'subagent_fork') {
      const base = folder()
      const [roots, keys] = await Promise.all([
        spelledSecretRoots(memo),
        spellings(base === undefined ? args.cwd : resolve(base, args.cwd), memo),
      ])
      const { inRefs, inFiles } = rootsOf(roots)
      if (inRefs(keys) || inFiles(keys)) throw closedSecret()
      return
    }
    if (name === 'working_directory') {
      const base = folder()
      const [roots, keys] = await Promise.all([
        spelledSecretRoots(memo),
        spellings(base === undefined ? args.cd : resolve(base, args.cd), memo),
      ])
      const { inRefs, inFiles } = rootsOf(roots)
      if (inRefs(keys) || inFiles(keys)) throw closedSecret()
      return
    }
    if (SHELL_TOOLS.includes(name)) {
      const base = folder()
      const dirArgs = [args.workdir, args.cwd].filter(value => typeof value === 'string' && value !== '')
      const effectiveDir = dirArgs.at(-1) ?? base
      const dirsToCheck = [...dirArgs, ...(effectiveDir !== undefined ? [effectiveDir] : [])]
      const [roots, ...dirKeyList] = await Promise.all([
        spelledSecretRoots(memo),
        ...dirsToCheck.map(dirArg => spellings(base === undefined ? dirArg : resolve(base, dirArg), memo)),
      ])
      const { refsRoot, filesRoot, inRefs, overlapsRefs, inFiles, overlapsFiles } = rootsOf(roots)
      for (let i = 0; i < dirArgs.length; i += 1) {
        if (inRefs(dirKeyList[i]) || inFiles(dirKeyList[i])) throw closedSecret()
      }
      const effectiveKeys = effectiveDir !== undefined ? dirKeyList.at(-1) : undefined
      let cwdOverlapsProtected = false
      if (effectiveKeys !== undefined) {
        if (overlapsRefs(effectiveKeys)) {
          cwdOverlapsProtected = true
        } else if (overlapsFiles(effectiveKeys)) {
          const ownDir = await getOwnDir()
          if (!allInOwnSecretDir(effectiveKeys, ownDir)) cwdOverlapsProtected = true
        }
      }
      const rawText = strings(args).join('\n')
      const flat = fold(normalizeSlashes(rawText))
      const hasRootBoundary = (text, at, len) => {
        const before = at === 0 ? '' : text[at - 1]
        if (before !== '' && /[a-z0-9_.-]/i.test(before)) return false
        const after = at + len >= text.length ? '' : text[at + len]
        return after === '' || !/[a-z0-9_.-]/i.test(after)
      }
      for (const spelled of refsRoot.flatMap(asShell)) {
        for (let at = flat.indexOf(spelled); at !== -1; at = flat.indexOf(spelled, at + 1)) {
          if (hasRootBoundary(flat, at, spelled.length)) throw closedSecret()
        }
      }
      if (/dsh_secret_file_/i.test(flat)
        && (/\bdirname\b/i.test(flat) || /(?:^|[/\\])\.\.(?:$|[/\\\s"'`;|&)])/.test(flat))) {
        throw closedSecret()
      }
      const isSafeSplitPathLeaf = (segment) => {
        // Allow only unambiguous filename-only `Split-Path -Leaf` / `-LeafBase` calls;
        // reject PowerShell line/block comments (`#`, `<# ... #>`), ignore redirection
        // targets, quoted literals, and `-Path` argument values so default `Split-Path`
        // (parent), `-Parent`, `-Resolve`, `-Qualifier`, etc. stay blocked.
        let sawLeaf = false
        let sawDoubleDash = false
        let expectPathValue = false
        for (const tok of segment) {
          if (tok.unquotedHash) return false
          if (tok.redir) continue
          if (expectPathValue) {
            expectPathValue = false
            continue
          }
          const lower = tok.value.toLowerCase()
          if (!tok.quoted && lower === 'split-path') continue
          if (!tok.quoted && lower === '--') {
            sawDoubleDash = true
            continue
          }
          if (!sawDoubleDash && !tok.quoted && (lower === '-leaf' || lower === '-leafbase')) {
            sawLeaf = true
            continue
          }
          if (!sawDoubleDash && !tok.quoted && lower.startsWith('-')) {
            if (lower === '-path' || lower === '-literalpath') {
              expectPathValue = true
              continue
            }
            if (lower.startsWith('-path:') || lower.startsWith('-literalpath:')) continue
            return false
          }
        }
        return sawLeaf && !expectPathValue
      }
      const ownPrefix = `/${fold(self)}/`
      const checkRestAfterFilesRoot = (rest) => {
        if (!rest.startsWith(ownPrefix)) throw closedSecret()
        const afterOwn = rest.slice(ownPrefix.length)
        const token = afterOwn.match(/^[^\s"'`;|&)><]*/)?.[0] ?? ''
        if (token === '' || token.includes('/') || token === '.' || token === '..' || token.includes('..') || /[$*?[{`~]/.test(token)) {
          throw closedSecret()
        }
      }
      for (const spelled of filesRoot.flatMap(asShell)) {
        for (let at = flat.indexOf(spelled); at !== -1; at = flat.indexOf(spelled, at + 1)) {
          if (!hasRootBoundary(flat, at, spelled.length)) continue
          checkRestAfterFilesRoot(flat.slice(at + spelled.length))
        }
      }
      const markerFiles = 'secret-files'
      const isPlainSearchPattern = (tok, idx, exempt) => {
        if (cwdOverlapsProtected || tok.redir || !exempt.has(idx)) return false
        let val = tok.value
        if (val.startsWith('--regexp=')) val = val.slice('--regexp='.length)
        else if (/^-pattern:/i.test(val)) val = val.slice('-pattern:'.length)
        else if (val.startsWith('-e') && val.length > 2 && !val.startsWith('--')) val = val.slice(2)
        return !/[/\\]|\.\.|[*?[]/.test(val)
      }
      const segments = splitShellCommands(rawText)
      if (/dsh_secret_file_/i.test(flat) && /\bsplit-path\b/i.test(flat)) {
        for (const segment of segments) {
          const hasSplitPath = segment.some(tok => !tok.redir && /\bsplit-path\b/i.test(tok.value))
          if (hasSplitPath && !isSafeSplitPathLeaf(segment)) {
            throw closedSecret()
          }
        }
      }
      for (const segment of segments) {
        const exempt = searchPatternTokenIndices(segment)
        for (let i = 0; i < segment.length; i += 1) {
          const tok = segment[i]
          if (isPlainSearchPattern(tok, i, exempt)) continue
          const tokFlat = fold(normalizeSlashes(tok.value))
          if (/(?:^|[^a-z0-9_.-])secret-refs(?:$|[^a-z0-9_.-])/i.test(tokFlat)) {
            throw closedSecret()
          }
          for (let at = tokFlat.indexOf(markerFiles); at !== -1; at = tokFlat.indexOf(markerFiles, at + markerFiles.length)) {
            const before = at === 0 ? '' : tokFlat[at - 1]
            if (/[a-z0-9_.-]/i.test(before)) continue
            const rest = tokFlat.slice(at + markerFiles.length)
            const first = rest[0] ?? ''
            if (first !== '' && /[a-z0-9_.-]/i.test(first)) continue
            checkRestAfterFilesRoot(rest)
          }
        }
      }
      if (name === 'run_code') {
        for (const candidate of codePathCandidates(rawText)) {
          const keys = await spellings(base === undefined ? candidate : resolve(base, candidate), memo)
          if (inRefs(keys)) throw closedSecret()
          if (inFiles(keys)) {
            const ownDir = await getOwnDir()
            if (!allOwnSecretFiles(keys, ownDir)) throw closedSecret()
          }
        }
      }
    }
  }

  async function guardPresentData(exec) {
    if (exec.name !== 'present' || typeof rt.inData !== 'function') return
    const paths = presentPathsOf(exec.arguments ?? {})
    if (paths.length === 0) return
    const base = exec.agent?.session?.header?.cwd
    for (const path of paths) {
      const full = base === undefined ? resolve(path) : resolve(base, path)
      const candidates = new Set([full])
      const realPath = await (rt.realBeyond ?? rt.real)?.(full)
      if (realPath) candidates.add(realPath)
      for (const candidate of candidates) {
        if (await rt.inData(candidate)) throw new Error('Files inside DeepSeek Harness data cannot be presented')
      }
    }
  }

  // Before the tools' own hooks, so that a closed call never reaches a card they show.
  ctx.on('tools/execute', async (exec, next) => {
    const self = await callerOf(exec)
    if (protectedBots().length > 0) {
      await guardTeam(exec, self)
      await guardFiles(exec, self)
    }
    if (self !== undefined) {
      const memo = new Map()
      await guardApiFiles(exec, memo)
      await guardSecretFiles(exec, self, memo)
      await guardPresentData(exec)
    }
    return next()
  })

  // A folder that a private Bot's folder would overlap, or that overlaps one.
  async function privateClash(path, { except, memo = new Map() } = {}) {
    const keys = await spellings(path, memo)
    for (const bot of protectedBots()) {
      if (bot.id === except || bot.workDir === undefined) continue
      const dirs = await spellings(bot.workDir, memo)
      if (keys.some(key => dirs.some(dir => overlap(key, dir)))) return bot
    }
    return undefined
  }

  // Checks a change of `private` or of the folder of a Bot before it is written. A
  // private Bot's folder is no other Bot's, no group's and not the team workspace —
  // a member's own pick in a group counts as that member's folder — because DSH
  // cannot be told which files of a shared folder to hide.
  // `extraDirs` is the new list of extra folders, or undefined when it stays.
  async function checkChange(bot, { flag, moving, workDir, extraDirs }) {
    const memo = new Map()
    const makes = flag === undefined ? bot.private === true : flag
    const dir = moving ? workDir : bot.workDir
    const extras = extraDirs ?? bot.extraDirs ?? []
    if (!makes) {
      const asked = [...(moving && dir !== undefined ? [dir] : []), ...(extraDirs ?? [])]
      for (const path of asked) {
        const clash = await privateClash(path, { except: bot.id, memo })
        if (clash) throw new Error(`${path} is in or around the folder of ${clash.name}, a private Bot, so ${bot.name} cannot work there`)
      }
      return
    }
    if (rt.isMain(bot.id)) throw new Error(`${bot.name} is a Main Bot, so it cannot be private`)
    if (dir === undefined) throw new Error(`${bot.name} needs a folder of its own to be private`)
    if (extras.length > 0) throw new Error(`${bot.name} works in extra folders, and a private Bot works in its own folder only. Remove its extra folders first`)
    if (Object.values(state.rooms).some(room => room.members.includes(bot.id))) throw new Error(`${bot.name} is in a group chat, where every member reads what is said. Remove it from its groups first`)
    const clash = await privateClash(dir, { except: bot.id, memo })
    if (clash) throw new Error(`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${bot.name} cannot work there`)
    const keys = await spellings(dir, memo)
    const others = [
      ['the team workspace', teamFolder()],
      ...Object.values(state.bots).filter(other => other.id !== bot.id).flatMap(other => [other.workDir, ...(other.extraDirs ?? [])].filter(Boolean).map(path => [`the folder of ${other.name}`, path])),
      ...Object.values(state.rooms).flatMap(room => [room.workDir, ...(room.extraDirs ?? [])].filter(Boolean).map(path => [`the folder of "${room.name}"`, path])),
      ...Object.values(state.rooms).flatMap(room => Object.entries(room.memberDirs ?? {})
        .filter(([member, dir]) => room.members.includes(member) && dir !== null)
        .map(([member, dir]) => [`the folder of ${rt.botOf(member)?.name ?? 'a member'} in "${room.name}"`, dir])),
    ]
    for (const [what, path] of others) {
      const spelled = await spellings(path, memo)
      if (keys.some(key => spelled.some(other => overlap(key, other)))) throw new Error(`${dir} is in or around ${what}, so ${bot.name} cannot be private there. Give it a folder of its own`)
    }
  }

  const checkNoPrivate = (ids) => {
    const found = ids.map(id => rt.botOf(id)).find(bot => bot?.private === true)
    if (found) throw new Error(`${found.name} is a private Bot and cannot be in a group chat: what is said in a group is read by every member`)
  }

  // Deleting a private Bot keeps its places closed (see roster.js deleteBot); only the
  // user opens them again, one Bot at a time. The files stay where they are.
  async function releaseArchive(id) {
    const kept = state.privateArchives ?? []
    if (!kept.some(entry => entry.id === id)) throw new Error('Nothing kept closed for this Bot')
    state.privateArchives = kept.filter(entry => entry.id !== id)
    await rt.save()
  }

  // What the settings list shows. Session ids stay on the host.
  const archivesView = () => (state.privateArchives ?? []).map(({ id, name, workDir }) => ({ id, name, ...(workDir === undefined ? {} : { workDir }) }))

  const isPrivatePathBlocked = async (path, self, base) => (typeof path === 'string' && path !== ''
    ? (await ownerOfPath(expandHome(path), { self, base })) !== undefined
    : false)

  Object.assign(rt, {
    isPrivate, isPrivatePathBlocked, privateClash, checkPrivacyChange: checkChange, checkNoPrivate, releaseArchive, archivesView,
    // The private Bot a real path belongs to, for callers outside the file tools that read
    // a file the user names: a photo must not come out of a folder that is closed.
    privateOwnerOf: (path, options) => ownerOfPath(path, options),
  })
}
