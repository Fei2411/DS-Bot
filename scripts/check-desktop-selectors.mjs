#!/usr/bin/env node
// Guards the desktop UI import graph (starting from app/ui/src/main.js) against
// DSH-private DOM selectors, attributes, and CSS custom properties.
// Plugin-only files named `*-dsh.js` are exempt by filename; desktop code must
// rely only on DS Bot's own explicit `data-bt-*` / `--bt-*` contracts.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ENTRY = resolve(REPO_ROOT, 'app/ui/src/main.js')

export const PLUGIN_ONLY_RE = /(?:^|\/)[^/]*-dsh\.[cm]?js$/

export const FORBIDDEN_PATTERNS = [
  { id: 'dsh-class-fragment', label: '[class*="_…"]', re: /\[class[*^$]?=(?:\\?["'])?_/g },
  { id: 'dsh-centercol-shim', label: 'dsb_centerCol', re: /\bdsb_centerCol\b/g },
  { id: 'dsh-data-chat', label: 'data-chat-*', re: /data-chat-[\w-]*|dataset\.chat(?:Flow|Group|Running|Anchor|Call)\w*/g },
  { id: 'dsh-data-scroll', label: 'data-conversation-scroll', re: /data-conversation-scroll\b/g },
  { id: 'dsh-data-slot', label: 'data-slot', re: /data-slot\b/g },
  { id: 'dsh-data-composer', label: 'data-composer-*', re: /data-composer-[\w-]*/g },
  { id: 'dsh-data-step-process', label: 'data-step-process*', re: /data-step-process(?:-[\w-]*)?\b/g },
  { id: 'dsh-data-turn-tail', label: 'data-turn-tail', re: /data-turn-tail\b/g },
  { id: 'dsh-mobile-header', label: 'data-dsh-mobile-header / dsh-native-mobile-active', re: /data-dsh-mobile-header\b|\bdsh-native-mobile-active\b/g },
  { id: 'dsh-textbox-contenteditable', label: '[role=textbox][contenteditable…]', re: /\[role=(?:\\?["'])?textbox(?:\\?["'])?\]\[contenteditable/g },
  { id: 'dsh-css-var', label: '--dsh-*', re: /--dsh-[\w-]*/g },
]

const REGEX_PREV_KEYWORDS = new Set([
  'return', 'case', 'throw', 'in', 'of', 'typeof', 'void', 'delete', 'yield', 'await', 'else', 'do', 'new', 'instanceof',
])
const REGEX_PREV_PUNCT = new Set(['(', '[', '{', ',', ';', ':', '=', '!', '?', '&', '|', '^', '~', '+', '-', '*', '%', '<', '>'])

// Strip comments while keeping newlines so reported line numbers stay exact.
// For JS files, preserves string, template-literal, and regex-literal contents.
// For CSS files, removes /* ... */ comments.
export function stripComments(source, isCss) {
  let out = ''
  let i = 0
  const n = source.length
  const blank = text => text.replace(/[^\n]/g, ' ')

  if (isCss) {
    while (i < n) {
      if (source[i] === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2)
        const stop = end === -1 ? n : end + 2
        out += blank(source.slice(i, stop))
        i = stop
        continue
      }
      if (source[i] === '"' || source[i] === "'") {
        const q = source[i]
        let j = i + 1
        while (j < n && source[j] !== q) {
          if (source[j] === '\\') j += 2
          else j += 1
        }
        const stop = j < n ? j + 1 : n
        out += source.slice(i, stop)
        i = stop
        continue
      }
      out += source[i]
      i += 1
    }
    return out
  }

  // JS / MJS: strip // and /* ... */ outside strings, regex literals, and template literals.
  // Inside template literals, also strip CSS block comments /* ... */ so comment prose
  // inside embedded CSS strings does not trigger false positives.
  const stack = [] // 'tmpl' when inside `${...}` nested in a template literal
  let canStartRegex = true
  const scanTemplateBody = () => {
    while (i < n) {
      if (source[i] === '\\') {
        out += source.slice(i, i + 2)
        i += 2
        continue
      }
      if (source[i] === '`') {
        out += '`'
        i += 1
        canStartRegex = false
        return
      }
      if (source[i] === '$' && source[i + 1] === '{') {
        out += '${'
        i += 2
        stack.push('tmpl')
        canStartRegex = true
        return
      }
      if (source[i] === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2)
        const stop = end === -1 ? n : end + 2
        out += blank(source.slice(i, stop))
        i = stop
        continue
      }
      out += source[i]
      i += 1
    }
  }

  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2)
      const stop = end === -1 ? n : end
      out += blank(source.slice(i, stop))
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += blank(source.slice(i, stop))
      i = stop
      continue
    }
    if (ch === '/' && canStartRegex) {
      let j = i + 1
      let inClass = false
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === '[') { inClass = true; j += 1; continue }
        if (source[j] === ']') { inClass = false; j += 1; continue }
        if (source[j] === '/' && !inClass) break
        j += 1
      }
      if (j < n && source[j] === '/') {
        j += 1
        while (j < n && /[a-z]/i.test(source[j])) j += 1
        out += source.slice(i, j)
        i = j
        canStartRegex = false
        continue
      }
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < n && source[j] !== ch) {
        if (source[j] === '\\') j += 2
        else j += 1
      }
      const stop = j < n ? j + 1 : n
      out += source.slice(i, stop)
      i = stop
      canStartRegex = false
      continue
    }
    if (ch === '`') {
      out += ch
      i += 1
      scanTemplateBody()
      continue
    }
    if (ch === '{' && stack.length > 0) {
      stack.push('brace')
      out += ch
      i += 1
      canStartRegex = true
      continue
    }
    if (ch === '}' && stack.length > 0) {
      const top = stack.pop()
      out += ch
      i += 1
      if (top === 'tmpl') scanTemplateBody()
      else canStartRegex = true
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1
      while (j < n && /[\w$]/.test(source[j])) j += 1
      const word = source.slice(i, j)
      out += word
      i = j
      canStartRegex = REGEX_PREV_KEYWORDS.has(word)
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < n && /[\w.]/.test(source[j])) j += 1
      out += source.slice(i, j)
      i = j
      canStartRegex = false
      continue
    }
    if (!/\s/.test(ch)) {
      canStartRegex = REGEX_PREV_PUNCT.has(ch) || ch === '}'
    }
    out += ch
    i += 1
  }
  return out
}

const JS_IMPORT_RE = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?/g

export function extractSpecifiers(code, isCss) {
  const specs = []
  const re = isCss ? CSS_IMPORT_RE : JS_IMPORT_RE
  re.lastIndex = 0
  let m
  while ((m = re.exec(code)) !== null) {
    const spec = m[1] || m[2]
    if (spec) specs.push(spec)
  }
  return specs
}

function resolveRelative(importer, spec, rootDir) {
  if (!spec.startsWith('.')) return null
  const norm = spec.replaceAll('\\', '/')
  const normImporter = importer.replaceAll('\\', '/')
  // Mirror app/vite.config.js alias: desktop resolves dsh-primitives.js to app/ui/src/primitives.js
  if ((norm === './dsh-primitives.js' && normImporter.includes('/ds-bot/src/client/'))
    || norm.endsWith('/ds-bot/src/client/dsh-primitives.js')) {
    const aliased = resolve(rootDir, 'app/ui/src/primitives.js')
    if (existsSync(aliased)) return aliased
  }
  const base = resolve(dirname(importer), spec)
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.css`, resolve(base, 'index.js')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

export function collectImportGraph(entry, rootDir = REPO_ROOT) {
  const visited = new Set()
  const queue = [resolve(entry)]
  while (queue.length > 0) {
    const file = queue.shift()
    if (visited.has(file) || !existsSync(file)) continue
    visited.add(file)
    const isCss = extname(file) === '.css'
    const raw = readFileSync(file, 'utf8')
    const stripped = stripComments(raw, isCss)
    for (const spec of extractSpecifiers(stripped, isCss)) {
      const target = resolveRelative(file, spec, rootDir)
      if (target && !visited.has(target)) queue.push(target)
    }
  }
  return [...visited].sort()
}

export function scanFile(file, rootDir = REPO_ROOT) {
  const rel = relative(rootDir, file).replaceAll('\\', '/')
  const hits = []
  if (PLUGIN_ONLY_RE.test(rel)) {
    hits.push({
      file: rel,
      line: 1,
      rule: 'plugin-only-in-desktop',
      match: rel,
      snippet: 'Plugin-only *-dsh.* module is reachable from the desktop UI entry',
    })
    return hits
  }
  const isCss = extname(file) === '.css'
  const raw = readFileSync(file, 'utf8')
  const stripped = stripComments(raw, isCss)
  const lines = stripped.split('\n')
  const rawLines = raw.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    for (const rule of FORBIDDEN_PATTERNS) {
      rule.re.lastIndex = 0
      let match
      while ((match = rule.re.exec(line)) !== null) {
        hits.push({
          file: rel,
          line: i + 1,
          rule: rule.id,
          match: match[0],
          snippet: rawLines[i].trim().slice(0, 140),
        })
      }
    }
  }
  return hits
}

export function checkDesktopSelectors({ entry = DEFAULT_ENTRY, rootDir = REPO_ROOT } = {}) {
  const files = collectImportGraph(entry, rootDir)
  const violations = []
  for (const file of files) {
    violations.push(...scanFile(file, rootDir))
  }
  return { files, violations }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const entryIndex = args.indexOf('--entry')
  const entry = entryIndex >= 0 && args[entryIndex + 1] ? resolve(args[entryIndex + 1]) : DEFAULT_ENTRY
  const rootIndex = args.indexOf('--root')
  const rootDir = rootIndex >= 0 && args[rootIndex + 1] ? resolve(args[rootIndex + 1]) : REPO_ROOT

  const { files, violations } = checkDesktopSelectors({ entry, rootDir })
  if (json) {
    console.log(JSON.stringify({ checkedFiles: files.length, violationCount: violations.length, violations }, null, 2))
  } else if (violations.length === 0) {
    console.log(`OK: checked ${files.length} desktop-loaded files, 0 DSH-private DOM/CSS references found.`)
  } else {
    const byFile = new Map()
    for (const hit of violations) {
      if (!byFile.has(hit.file)) byFile.set(hit.file, [])
      byFile.get(hit.file).push(hit)
    }
    console.error(`FAIL: found ${violations.length} DSH-private DOM/CSS reference(s) across ${byFile.size} desktop-loaded file(s) (checked ${files.length} files):`)
    for (const [file, hits] of byFile) {
      console.error(`\n  ${file} (${hits.length})`)
      for (const hit of hits) {
        console.error(`    L${hit.line} [${hit.rule}] ${hit.match}  →  ${hit.snippet}`)
      }
    }
  }
  if (violations.length > 0) process.exitCode = 1
}
