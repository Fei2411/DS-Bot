// Lazy per-language syntax highlighting powered by highlight.js/lib/core.
// Keeps initial startup lightweight by dynamically loading both the core highlighter
// and each language grammar on demand, rendering with semantic `hljs-*` token classes
// themed via CSS variables.
import { createElement as h, useEffect, useMemo, useState } from 'react'

const MAX_HIGHLIGHT_CHARS = 200_000

let hljsCore = null
let hljsCorePromise = null

function loadCore() {
  if (hljsCore !== null) return Promise.resolve(hljsCore)
  if (hljsCorePromise !== null) return hljsCorePromise
  hljsCorePromise = import('highlight.js/lib/core')
    .then((mod) => {
      const api = typeof mod?.highlight === 'function'
        ? mod
        : (typeof mod?.default?.highlight === 'function' ? mod.default : null)
      hljsCore = api
      return hljsCore
    })
    .catch(() => {
      hljsCorePromise = null
      return null
    })
  return hljsCorePromise
}

const LANG_LOADERS = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  bash: () => import('highlight.js/lib/languages/bash'),
  json: () => import('highlight.js/lib/languages/json'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  less: () => import('highlight.js/lib/languages/less'),
  xml: () => import('highlight.js/lib/languages/xml'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  sql: () => import('highlight.js/lib/languages/sql'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  php: () => import('highlight.js/lib/languages/php'),
  swift: () => import('highlight.js/lib/languages/swift'),
  dart: () => import('highlight.js/lib/languages/dart'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  lua: () => import('highlight.js/lib/languages/lua'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  http: () => import('highlight.js/lib/languages/http'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  latex: () => import('highlight.js/lib/languages/latex'),
  r: () => import('highlight.js/lib/languages/r'),
  perl: () => import('highlight.js/lib/languages/perl'),
  scala: () => import('highlight.js/lib/languages/scala'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  nix: () => import('highlight.js/lib/languages/nix'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  plaintext: () => import('highlight.js/lib/languages/plaintext'),
}

const LANG_ALIASES = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  py3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  yml: 'yaml',
  toml: 'ini',
  conf: 'ini',
  cfg: 'ini',
  env: 'ini',
  dotenv: 'ini',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  vue: 'xml',
  svelte: 'xml',
  astro: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  h: 'c',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  'c++': 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  rb: 'ruby',
  patch: 'diff',
  docker: 'dockerfile',
  make: 'makefile',
  mk: 'makefile',
  gql: 'graphql',
  ps1: 'powershell',
  pwsh: 'powershell',
  tex: 'latex',
  pl: 'perl',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  objc: 'objectivec',
  proto: 'protobuf',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
}

const loadingPromises = new Map()
const loadedLangs = new Set()

/**
 * Normalizes a fence language identifier or filename language into a supported grammar key.
 */
export function normalizeLanguage(raw) {
  if (typeof raw !== 'string') return ''
  const cleaned = raw.trim().toLowerCase().replace(/^language-/, '').split(/[\s{,:]/)[0]
  if (cleaned === '') return ''
  const canonical = LANG_ALIASES[cleaned] ?? cleaned
  return Object.hasOwn(LANG_LOADERS, canonical) ? canonical : ''
}

export function isLanguageLoaded(lang) {
  const canonical = normalizeLanguage(lang)
  return canonical !== '' && hljsCore !== null && (loadedLangs.has(canonical) || Boolean(hljsCore.getLanguage(canonical)))
}

/**
 * Lazily imports and registers a highlight.js grammar once.
 */
export function ensureLanguage(raw) {
  const canonical = normalizeLanguage(raw)
  if (canonical === '') return Promise.resolve(false)
  if (hljsCore !== null && (loadedLangs.has(canonical) || hljsCore.getLanguage(canonical))) {
    loadedLangs.add(canonical)
    return Promise.resolve(true)
  }
  const existing = loadingPromises.get(canonical)
  if (existing) return existing
  const promise = Promise.all([loadCore(), LANG_LOADERS[canonical]()])
    .then(([core, mod]) => {
      if (core === null) return false
      const def = typeof mod === 'function' ? mod : (typeof mod?.default === 'function' ? mod.default : null)
      if (def === null) return false
      core.registerLanguage(canonical, def)
      loadedLangs.add(canonical)
      return true
    })
    .catch(() => false)
    .finally(() => {
      loadingPromises.delete(canonical)
    })
  loadingPromises.set(canonical, promise)
  return promise
}

/**
 * Highlights `code` synchronously if the grammar is already loaded; otherwise returns `null`.
 */
export function highlightSync(code, rawLang) {
  if (hljsCore === null || typeof code !== 'string' || code === '' || code.length > MAX_HIGHLIGHT_CHARS) return null
  const canonical = normalizeLanguage(rawLang)
  if (canonical === '' || canonical === 'plaintext') return null
  if (!loadedLangs.has(canonical) && !hljsCore.getLanguage(canonical)) return null
  try {
    return hljsCore.highlight(code, { language: canonical, ignoreIllegals: true }).value
  } catch {
    return null
  }
}

const HTML_ENTITY_MAP = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" }
const decodeHtml = value => value.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, match => HTML_ENTITY_MAP[match] ?? match)

/**
 * Parses highlight.js `.value` HTML (which only emits `<span class="...">`, `</span>`,
 * and escaped text) into flat `{ className, text }` token lists per line, avoiding
 * `dangerouslySetInnerHTML` completely.
 */
export function parseHighlightedTokensByLine(html) {
  if (typeof html !== 'string') return []
  const lines = [[]]
  const classStack = []
  const tagRe = /<span class="([^"]+)">|<\/span>/g
  let last = 0

  const pushText = (raw) => {
    if (raw === '') return
    const decoded = decodeHtml(raw)
    const cls = classStack.length > 0 ? classStack.join(' ') : ''
    const parts = decoded.split('\n')
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) lines.push([])
      if (parts[i] !== '') lines[lines.length - 1].push({ className: cls, text: parts[i] })
    }
  }

  let m
  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > last) pushText(html.slice(last, m.index))
    if (m[1] !== undefined) classStack.push(m[1])
    else classStack.pop()
    last = tagRe.lastIndex
  }
  if (last < html.length) pushText(html.slice(last))
  return lines
}

/**
 * Converts a flat `{ className, text }[]` token list into React elements.
 */
export function renderTokenList(tokens, keyPrefix = 't') {
  if (!Array.isArray(tokens) || tokens.length === 0) return null
  return tokens.map((tok, index) => (tok.className
    ? h('span', { key: `${keyPrefix}:${index}`, className: tok.className }, tok.text)
    : tok.text))
}

/**
 * Renders highlighted tokens across newlines as flat React children for a fenced code block.
 */
export function renderHighlightedBlock(html) {
  const lines = parseHighlightedTokensByLine(html)
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) out.push('\n')
    const line = lines[i]
    for (let j = 0; j < line.length; j += 1) {
      const tok = line[j]
      out.push(tok.className
        ? h('span', { key: `${i}:${j}`, className: tok.className }, tok.text)
        : tok.text)
    }
  }
  return out
}

/**
 * React hook returning highlighted HTML for `code` in `lang` (or `null` until grammar loads).
 * Synchronous on first render whenever the language grammar is already cached.
 */
export function useHighlightedCode(code, rawLang) {
  const canonical = normalizeLanguage(rawLang)
  const [, setTick] = useState(0)
  const loaded = canonical !== '' && canonical !== 'plaintext' && hljsCore !== null && (loadedLangs.has(canonical) || Boolean(hljsCore.getLanguage(canonical)))

  useEffect(() => {
    if (canonical === '' || canonical === 'plaintext' || loaded) return undefined
    let alive = true
    void ensureLanguage(canonical).then((ok) => {
      if (alive && ok) setTick(n => n + 1)
    })
    return () => { alive = false }
  }, [canonical, loaded])

  return useMemo(() => (loaded ? highlightSync(code, canonical) : null), [loaded, code, canonical])
}

/**
 * React hook returning per-line `{ className, text }[]` token arrays for `code` in `lang`, or `null`.
 */
export function useHighlightedLines(code, rawLang) {
  const html = useHighlightedCode(code, rawLang)
  return useMemo(() => (html === null ? null : parseHighlightedTokensByLine(html)), [html])
}
