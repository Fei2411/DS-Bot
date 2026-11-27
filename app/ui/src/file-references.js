// File and folder reference parsing, remark linkification, and compact clickable chip.
// Detects workspace-relative paths, explicit relative/absolute paths, `@path` / `@"quoted path"`
// references, and optional `:line` / `#Lline` suffixes without creating false positives on
// plain words, URLs, MIME types, JS property accesses, or fenced code blocks.
import { createElement as h } from 'react'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { FileIcon, FolderIcon } from '../../../ds-bot/src/client/icons.js'

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/
const LINE_ONLY_SUFFIX_RE = /^\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/
const DOMAIN_LIKE_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|org|net|io|dev|ai|cn|co|edu|gov|me|gg|tv|uk|de|fr|jp|kr|xyz|info|biz|tech|cloud|site|online)$/i
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const TRAILING_PUNCT_RE = /[.,;:!?，。；：！？)）\]】》〉」』"']+$/u

// Known file extensions recognized for bare filenames and workspace-relative paths.
// Excludes extensions that commonly collide with JS member access (like `.log`, `.get`, `.set`, `.map`)
// and single-letter extensions (`c`, `h`, `r`) unless preceded by a directory separator.
const BARE_FILE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'd.ts',
  'json', 'jsonc', 'json5', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock',
  'md', 'mdx', 'markdown', 'rst', 'txt', 'csv', 'tsv',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'xml',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'php', 'swift', 'dart', 'lua', 'zig', 'ex', 'exs', 'erl', 'hs', 'jl',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'prisma', 'proto', 'tf', 'hcl', 'nix', 'vue', 'svelte', 'astro',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
  'dockerfile', 'makefile', 'gitignore', 'npmrc', 'nvmrc', 'editorconfig',
])

const PATH_FILE_EXTS = new Set([...BARE_FILE_EXTS, 'c', 'h', 'r', 'log', 'map', 'out', 'err', 'pid', 'tmp', 'bak', 'patch', 'diff', 'pem', 'crt', 'key', 'wasm', 'bin', 'zip', 'tar', 'gz'])

const SPECIAL_BASENAMES = new Set([
  'README', 'LICENSE', 'NOTICE', 'CHANGELOG', 'Dockerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile', 'AGENTS.md',
  '.gitignore', '.env', '.env.local', '.env.example', '.npmrc', '.editorconfig', '.eslintrc', '.prettierrc',
])

const MIME_PREFIXES = new Set(['text', 'image', 'audio', 'video', 'application', 'multipart', 'font', 'model', 'message'])
const JS_GLOBALS = new Set([
  'console', 'window', 'document', 'globalThis', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'Math', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Error', 'JSON', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'URL', 'Buffer', 'process',
])

const FILE_SCHEME_PREFIX = 'dsb-file://'

function safeDecode(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

function stripLocation(raw) {
  let path = raw
  let line = null
  let endLine = null

  // Match `#L24`, `#L24-L30`, `#L24C5`, `#L24-30`
  const hashMatch = /#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(path)
  if (hashMatch) {
    line = Number.parseInt(hashMatch[1], 10)
    endLine = hashMatch[2] ? Number.parseInt(hashMatch[2], 10) : null
    path = path.slice(0, hashMatch.index)
  } else {
    // Match `:42`, `:42:10`, `:42-50`, `:42:10-45:2` (not Windows drive `C:`)
    const colonMatch = /:(\d+)(?::\d+)?(?:-(\d+)(?::\d+)?)?$/.exec(path)
    if (colonMatch && colonMatch.index > 1) {
      line = Number.parseInt(colonMatch[1], 10)
      endLine = colonMatch[2] ? Number.parseInt(colonMatch[2], 10) : null
      path = path.slice(0, colonMatch.index)
    }
  }

  return {
    path,
    line: Number.isInteger(line) && line > 0 ? line : null,
    endLine: Number.isInteger(endLine) && endLine > 0 ? endLine : null,
  }
}

function normalizeSlashPath(path) {
  let normalized = path.replace(/\\/g, '/')
  const isDir = normalized.endsWith('/') && normalized !== '/' && !/^[A-Za-z]:\/$/.test(normalized)
  if (isDir) normalized = normalized.replace(/\/+$/, '')
  return { path: normalized, isDir }
}

function extOf(name) {
  if (!name || name.startsWith('.') && name.indexOf('.', 1) === -1) return ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

function basenameOf(path) {
  const clean = path.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) || clean
}

function isDateLike(raw) {
  return /^\d{2,4}\/\d{1,2}(?:\/\d{1,4})?$/.test(raw)
}

function isMimeLike(raw) {
  const parts = raw.split('/')
  return parts.length === 2 && MIME_PREFIXES.has(parts[0].toLowerCase()) && /^[A-Za-z0-9.+-]+$/.test(parts[1])
}

function isDomainLike(segment) {
  return typeof segment === 'string' && DOMAIN_LIKE_RE.test(segment)
}

function isExternalUrlScheme(value) {
  if (WINDOWS_DRIVE_RE.test(value)) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return true
  const match = SCHEME_RE.exec(value)
  if (!match) return false
  const prefix = match[0].slice(0, -1)
  const rest = value.slice(match[0].length)
  // Recognize `filename:line` / `filename:line:col` on valid filenames without admitting URL schemes.
  if (LINE_ONLY_SUFFIX_RE.test(rest)) {
    const ext = extOf(prefix)
    if (SPECIAL_BASENAMES.has(prefix) || (ext !== '' && PATH_FILE_EXTS.has(ext))) return false
  }
  return true
}

/**
 * Parses a raw path string (optionally `file://...` or with `:line` / `#Lline`) into
 * `{ path, line, endLine, isDir, display }` or `null` if not a local path.
 */
export function parseFileTarget(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '' || CONTROL_RE.test(trimmed)) return null
  if (trimmed.startsWith('#') || trimmed.startsWith('?')) return null

  let candidate = trimmed
  if (/^file:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate)
      // Reject remote/UNC `file://server/share/...` authorities rather than dropping the host
      // and resolving a corrupted drive-local `/share/...` path.
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return null
      let pathname = safeDecode(url.pathname)
      if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1)
      candidate = pathname + (url.hash || '')
    } catch {
      return null
    }
  } else if (candidate.startsWith(FILE_SCHEME_PREFIX)) {
    const rest = safeDecode(candidate.slice(FILE_SCHEME_PREFIX.length))
    return parseFileTarget(rest)
  } else if (isExternalUrlScheme(candidate)) {
    return null
  }

  const { path: rawPath, line, endLine } = stripLocation(candidate)
  if (rawPath === '' || rawPath === '.' || rawPath === '..') return null
  if (/^\/\//.test(rawPath)) return null

  const { path, isDir } = normalizeSlashPath(rawPath)
  if (path === '') return null

  const display = line
    ? `${path}:${line}${endLine && endLine !== line ? `-${endLine}` : ''}`
    : (isDir ? `${path}/` : path)
  return { path, line, endLine, isDir, display }
}

/**
 * Parses a Markdown link `href` to check whether it targets a local file or folder.
 */
export function parseLocalFileHref(href) {
  if (typeof href !== 'string') return null
  const trimmed = href.trim()
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('?') || trimmed.startsWith('//')) return null
  if (trimmed.startsWith(FILE_SCHEME_PREFIX)) {
    return parseFileTarget(safeDecode(trimmed.slice(FILE_SCHEME_PREFIX.length)))
  }
  if (/^file:\/\//i.test(trimmed)) return parseFileTarget(trimmed)

  // Decode percent-encoded spaces, Unicode, and CommonMark-encoded Windows backslashes (`%5C`)
  // BEFORE scheme classification so `C:%5Crepo%5Cfile.js` is recognized as a Windows drive path
  // while `javascript%3A...` is still rejected by `isExternalUrlScheme`.
  const withoutQuery = trimmed.split('?')[0]
  const decoded = safeDecode(withoutQuery)
  if (isExternalUrlScheme(decoded)) return null
  return parseFileTarget(decoded)
}

/**
 * Strict check for whether an inline-code token (`...`) is an unambiguous file or folder reference.
 * Avoids false positives on plain identifiers, JS member access, flags, MIME types, URLs, and commands.
 */
export function isInlineCodeFilePath(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > 260 || /[\r\n]/.test(trimmed)) return null
  if (trimmed.startsWith('-') || trimmed.startsWith('--')) return null
  if (/[|&;$`<>(){}*?'"=]/.test(trimmed)) return null
  if (/\s/.test(trimmed)) return null
  if (isDateLike(trimmed) || isMimeLike(trimmed)) return null

  const parsed = parseFileTarget(trimmed)
  if (!parsed) return null
  const { path, line, isDir } = parsed

  // Reject scoped npm package names like `@scope/pkg` (no extension, no trailing slash, no line, single slash).
  if (path.startsWith('@') && !isDir && line === null && extOf(basenameOf(path)) === '' && path.split('/').length === 2) {
    return null
  }

  const hasSlash = path.includes('/')
  const base = basenameOf(path)
  const ext = extOf(base)

  if (WINDOWS_DRIVE_RE.test(raw)) return parsed
  if (path.startsWith('./') || path.startsWith('../')) return parsed
  if (path.startsWith('/')) {
    const segs = path.split('/').filter(Boolean)
    // Require at least two segments (`/dir/file`) or a file extension (`/foo.txt`) so `/help` never links.
    return (segs.length >= 2 || ext !== '') ? parsed : null
  }

  // Single-segment workspace folder with explicit trailing slash (e.g. `src/`, `subdir/`, `.github/`).
  if (isDir && line === null && !hasSlash) {
    return (/^[A-Za-z0-9._-]+$/.test(path) && !/^\d+$/.test(path) && !isDomainLike(path)) ? parsed : null
  }

  if (hasSlash) {
    const segs = path.split('/').filter(Boolean)
    if (segs.length < 2 && !isDir) return null
    if (isDomainLike(segs[0])) return null
    if (isDir) return parsed
    if (line !== null) return parsed
    if (ext !== '' && PATH_FILE_EXTS.has(ext)) return parsed
    if (SPECIAL_BASENAMES.has(base)) return parsed
    return null
  }

  // Bare filename without slash (`README.md`, `package.json`, `session-chat.js:385`):
  if (SPECIAL_BASENAMES.has(base)) return parsed
  if (ext !== '' && BARE_FILE_EXTS.has(ext)) {
    const stem = base.slice(0, base.length - ext.length - 1)
    if (stem === '' || JS_GLOBALS.has(stem)) return null
    if (/^v?\d+(?:\.\d+)*$/i.test(stem)) return null
    return parsed
  }
  return null
}

/**
 * Matches a candidate string inside a turn's `fileMentions` map (produced/delivered files).
 */
export function matchFileMention(raw, fileMentions) {
  if (!fileMentions || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const direct = typeof fileMentions.get === 'function' ? fileMentions.get(trimmed) : fileMentions[trimmed]
  if (direct) return direct
  const parsed = parseFileTarget(trimmed)
  if (!parsed) return null
  const byPath = typeof fileMentions.get === 'function' ? fileMentions.get(parsed.path) : fileMentions[parsed.path]
  if (byPath) return { ...byPath, line: parsed.line ?? byPath.line }
  const base = basenameOf(parsed.path)
  if (parsed.path !== base) return null
  const byBase = typeof fileMentions.get === 'function' ? fileMentions.get(base) : fileMentions[base]
  if (byBase) return { ...byBase, line: parsed.line ?? byBase.line }
  return null
}

function isTokenBoundaryBefore(text, index) {
  if (index <= 0) return true
  const ch = text[index - 1]
  return /[\s([{"'「『（【《〈,:;，。！？、]/u.test(ch)
}

function trimTrailing(raw) {
  let end = raw.length
  while (end > 0) {
    const ch = raw[end - 1]
    if (ch === ')' && (raw.slice(0, end).match(/\(/g)?.length ?? 0) >= (raw.slice(0, end).match(/\)/g)?.length ?? 0)) {
      break
    }
    if (TRAILING_PUNCT_RE.test(ch)) {
      end -= 1
      continue
    }
    break
  }
  return raw.slice(0, end)
}

function isExplicitPathCandidate(raw, { allowAt = false } = {}) {
  if (raw === '' || isDateLike(raw) || isMimeLike(raw)) return null
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('mailto:')) return null
  if (allowAt && raw.startsWith('@')) {
    const inner = raw.slice(1)
    if (inner === '') return null
    // Quoted `@"path with spaces"` is always an explicit file/folder reference.
    if (inner.startsWith('"') && inner.endsWith('"') && inner.length > 2) {
      return parseFileTarget(inner.slice(1, -1))
    }
    // Unquoted `@ref`: must contain a path separator, trailing slash, line suffix, special filename, or known extension.
    const parsed = parseFileTarget(inner)
    if (!parsed) return null
    const firstSeg = parsed.path.split('/').filter(Boolean)[0] ?? ''
    if (isDomainLike(firstSeg)) return null
    const base = basenameOf(parsed.path)
    const ext = extOf(base)
    if (parsed.isDir || parsed.line !== null || parsed.path.includes('/') || SPECIAL_BASENAMES.has(base) || (ext !== '' && PATH_FILE_EXTS.has(ext))) {
      return parsed
    }
    return null
  }
  // Standalone path (not `@`): require explicit `./`, `../`, Windows drive, Unix absolute with ≥2 segments,
  // or workspace-relative path containing `/` with extension / trailing `/` / `:line`.
  const parsed = parseFileTarget(raw)
  if (!parsed) return null
  if (WINDOWS_DRIVE_RE.test(raw)) return parsed
  if (raw.startsWith('./') || raw.startsWith('../')) return parsed
  if (raw.startsWith('/')) {
    const segs = parsed.path.split('/').filter(Boolean)
    return (segs.length >= 2 && (extOf(basenameOf(parsed.path)) !== '' || parsed.isDir || parsed.line !== null || segs.length >= 3)) ? parsed : null
  }
  if (parsed.path.includes('/')) {
    const segs = parsed.path.split('/').filter(Boolean)
    if (segs.length < 2 && !parsed.isDir) return null
    if (isDomainLike(segs[0])) return null
    const base = basenameOf(parsed.path)
    const ext = extOf(base)
    if (parsed.isDir || parsed.line !== null || (ext !== '' && PATH_FILE_EXTS.has(ext)) || SPECIAL_BASENAMES.has(base)) {
      return parsed
    }
  }
  return null
}

// Scanner matching `@"quoted"`, `@path`, Windows paths, `./`/`../` paths, `/abs/paths`, and `dir/file.ext`.
const USER_PATH_SCAN_RE = /@"([^"\r\n]+)"|@([^\s"'`<>]+)|([A-Za-z]:[\\/][^\s"'`<>]+)|(\.\.?\/[^\s"'`<>]+)|(\/[^\s"'`<>]+)|([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\/?(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|#L\d+(?:-L?\d+)?)?)/g

function scanFileRefs(text, { allowAt = false } = {}) {
  if (typeof text !== 'string' || text === '') return []
  const matches = []
  USER_PATH_SCAN_RE.lastIndex = 0
  let m
  while ((m = USER_PATH_SCAN_RE.exec(text)) !== null) {
    const start = m.index
    if (!isTokenBoundaryBefore(text, start)) continue
    let raw = m[0]
    if (m[1] !== undefined) {
      if (!allowAt) continue
      const target = parseFileTarget(m[1])
      if (!target) continue
      matches.push({ start, end: start + raw.length, raw, label: target.display, target })
      continue
    }
    if (raw.startsWith('@') && !allowAt) continue
    const trimmed = trimTrailing(raw)
    if (trimmed === '') continue
    const target = isExplicitPathCandidate(trimmed, { allowAt })
    if (!target) continue
    matches.push({
      start,
      end: start + trimmed.length,
      raw: trimmed,
      label: target.display,
      target,
    })
  }
  return matches
}

/**
 * Extracts explicit file and folder references from user message text (supporting `@path`,
 * `@"path with spaces"`, relative/absolute paths, and `path:line`).
 */
export function extractUserFileRefs(text) {
  return scanFileRefs(text, { allowAt: true })
}

/**
 * Extracts unambiguous file and folder references from plain assistant Markdown prose.
 */
export function extractProseFileRefs(text) {
  return scanFileRefs(text, { allowAt: false })
}

/**
 * Remark plugin that turns unambiguous file/folder paths in Markdown prose text nodes
 * into `dsb-file://` links so `MarkdownText` renders them as compact clickable references.
 * Skips code blocks, inline code, links, and math nodes completely.
 */
export function remarkFileReferences() {
  const SKIP_PARENTS = new Set(['link', 'linkReference', 'definition', 'code', 'inlineCode', 'html', 'math', 'inlineMath'])

  function visit(node) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return
    if (SKIP_PARENTS.has(node.type)) return
    const nextChildren = []
    let changed = false
    for (const child of node.children) {
      if (child.type === 'text' && typeof child.value === 'string' && child.value !== '') {
        const refs = extractProseFileRefs(child.value)
        if (refs.length === 0) {
          nextChildren.push(child)
          continue
        }
        changed = true
        let cursor = 0
        for (const ref of refs) {
          if (ref.start > cursor) {
            nextChildren.push({ type: 'text', value: child.value.slice(cursor, ref.start) })
          }
          const href = `${FILE_SCHEME_PREFIX}${encodeURIComponent(ref.target.display)}`
          nextChildren.push({
            type: 'link',
            url: href,
            title: ref.target.path,
            children: [{ type: 'text', value: ref.raw }],
          })
          cursor = ref.end
        }
        if (cursor < child.value.length) {
          nextChildren.push({ type: 'text', value: child.value.slice(cursor) })
        }
      } else {
        visit(child)
        nextChildren.push(child)
      }
    }
    if (changed) node.children = nextChildren
  }

  return tree => { visit(tree) }
}

function compactRefLabel(target, fallbackLabel) {
  if (typeof fallbackLabel === 'string' && fallbackLabel.trim() !== '') return fallbackLabel
  const name = basenameOf(target.path) || target.path
  if (target.line) {
    return `${name}:${target.line}${target.endLine && target.endLine !== target.line ? `-${target.endLine}` : ''}`
  }
  return target.isDir ? `${name}/` : name
}

/**
 * Compact clickable file/folder reference chip matching DS Bot's design system.
 */
export function FileRefChip({ target, label, title, onOpenFile, onRevealFolder, className = '' }) {
  if (!target) return null
  const isDir = target.isDir === true
  const shown = compactRefLabel(target, label)
  const fullTitle = title || target.display || target.path
  const handleClick = (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (isDir) {
      if (typeof onRevealFolder === 'function') onRevealFolder({ path: target.path })
      else if (typeof onOpenFile === 'function') onOpenFile({ path: target.path, isDir: true })
      return
    }
    onOpenFile?.({ path: target.path, ...(target.line ? { line: target.line } : {}) })
  }
  const ariaLabel = isDir
    ? t('Reveal folder {path}', { path: target.path })
    : t('Open file {path}', { path: fullTitle })
  return h('button', {
    type: 'button',
    className: `dsb-file-ref${isDir ? ' is-dir' : ''}${className ? ` ${className}` : ''}`,
    title: fullTitle,
    'aria-label': ariaLabel,
    'data-file-ref': target.path,
    'data-file-line': target.line ?? undefined,
    'data-file-dir': isDir ? '' : undefined,
    onClick: handleClick,
  },
  h('span', { className: 'dsb-file-ref-ico', 'aria-hidden': true }, isDir ? h(FolderIcon) : h(FileIcon)),
  h('span', { className: 'dsb-file-ref-label' }, shown))
}
