#!/usr/bin/env node
// Scans a copy of the repository tree for secrets, personal data and private material.
//
//   git archive HEAD | tar -x -C /tmp/tree && node scripts/scan.mjs /tmp/tree [--json <file>] [--all]
//
// Findings are "must fix" (exit code 1) or "can stay" (read and accept). Matched secrets
// are never printed in full. --all prints every location instead of the first few per rule.
//
// Extra "must fix" patterns, one regular expression per line, come from the SCAN_EXTRA_PATTERNS
// environment variable and from a `.scan-extra` file at the root of the checkout (ignored by
// Git). They hold markers that must not appear in this repository and must not be named in it
// either, such as a maintainer's machine or account names.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const MUST = 'must fix'
const KEEP = 'can stay'

const SELF = 'scripts/scan.mjs'
const PLACEHOLDER = /mock|test|fake|dummy|example|placeholder|should-not|xxx|your|<|\$\{|redact|sample/i
const VENDORS = /\b(qwen|minimax|stepfun|kimi|moonshot|zhipu|glm|mimo|anthropic|claude|openai|gemini|mistral|xai|zai)\b/i
// Files that define the look (characters, inks, logos, themes). Vendor names there are
// brand references; elsewhere they name model routes and can stay.
const LOOK_FILES = /(^|\/)(src\/client\/(inks|characters|mark|themes|styles)\.js|dev\/(mascot-outlines|characters)\.mjs)$/
const NOT_PUBLIC = /(^|[\s(`'"]|\.\.\/)(spec|research|backup|shots|attachments|workspace)\/|\.dsh-home/
// Migration code and its tests must name the legacy ids (old package name, old theme and
// color keys) to move saved data over; there, and on lines that say "legacy" (旧版), old names stay.
const LEGACY_FILES = /(^|\/)(src\/client\/storage\.js|src\/legacy\.mjs|test\/legacy[\w-]*\.test\.(?:js|mjs))$/

const extra = extraPatterns()

const TEXT_RULES = [
  // Secrets.
  { id: 'secret-openai-style', level: MUST, re: /\bsk-[A-Za-z0-9_-]{20,}/g, secret: true },
  { id: 'secret-github', level: MUST, re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g, secret: true },
  { id: 'secret-aws', level: MUST, re: /\bAKIA[0-9A-Z]{16}\b/g, secret: true },
  { id: 'secret-google', level: MUST, re: /\bAIza[0-9A-Za-z_-]{35}\b/g, secret: true },
  { id: 'secret-slack', level: MUST, re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, secret: true },
  { id: 'secret-private-key', level: MUST, re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, secret: true },
  { id: 'secret-bearer', level: MUST, re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g, secret: true },
  {
    id: 'secret-assignment', level: MUST, secret: true,
    re: /\b(api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'][A-Za-z0-9_\-./+=]{16,}["']/gi,
  },
  // Personal data.
  { id: 'personal-path', level: MUST, re: /\/home\/(?!<|user\b|runner\b|node\b)[a-z_][a-z0-9_-]*\/|\/Users\/(?!<|Shared\b)[A-Za-z][\w.-]*\/|[A-Za-z]:\\Users\\(?!<|Public\b)[^\\\s`"'<>]+/g },
  { id: 'personal-email', level: MUST, re: /\b[\w.+-]+@(qq|163|126|gmail|outlook|hotmail|foxmail|icloud|yahoo)\.(com|cn)\b/gi },
  { id: 'other-email', level: KEEP, re: /\b[\w.+-]+@(?!(\d|example\.|users\.noreply\.github\.com|localhost|(qq|163|126|gmail|outlook|hotmail|foxmail|icloud|yahoo)\.))[\w-]+\.[a-z]{2,}\b/gi },
  ...(extra ? [{ id: 'extra-pattern', level: MUST, re: extra, legacyOk: true }] : []),
  // Only original material: no vendor brands in the look, no third-party logos.
  { id: 'vendor-look-identifier', level: MUST, re: /\b(KIMI|MINIMAX|STEPFUN|QWEN|MIMO|ZAI|ZHIPU|GLM|DEEPSEEK)_(BODY|WAVE|STAR|MARK|LOGO|INK|INKS|COLOR|COLORS)\b|\bLAB_(INKS|COLORS)\b/g, legacyOk: true },
  { id: 'vendor-in-look-file', level: MUST, re: new RegExp(VENDORS.source, 'gi'), files: LOOK_FILES, legacyOk: true },
  { id: 'vendor-brand', level: MUST, re: /brand[^\n]{0,40}\b(qwen|minimax|stepfun|kimi|zhipu|mimo|deepseek)\b|\b(qwen|minimax|stepfun|kimi|zhipu|mimo)\b[^\n]{0,40}brand/gi, legacyOk: true },
  // A test may name the logo to check that the look no longer uses it.
  { id: 'third-party-logo', level: MUST, re: /WhaleLogo|favicon\.svg/g, notFiles: /(^|\/)test\// },
  { id: 'vendor-name', level: KEEP, re: new RegExp(VENDORS.source, 'gi'), notFiles: LOOK_FILES, summary: true },
  // Former names of the project and the package.
  { id: 'retired-product-name', level: MUST, re: /deepseek[-_ ]?bot/gi, legacyOk: true, notFiles: /^CHANGELOG(?:\.[a-z]+)?\.md$/ },
  { id: 'old-project-name', level: MUST, re: /DSH Bot\b/g, legacyOk: true },
  { id: 'old-package-name', level: MUST, re: /\bdsh-bot\b/g, legacyOk: true },
  { id: 'legacy-name-in-migration', level: KEEP, re: /\bdsh-bot\b|DeepSeek Bot\b/gi, onlyLegacy: true, summary: true },
  // Drafts and local-only material.
  { id: 'draft-marker', level: MUST, re: /TBD\(|DRAFT for|草稿/g },
  { id: 'not-public-path-in-docs', level: MUST, re: new RegExp(NOT_PUBLIC.source, 'g'), files: /\.md$/ },
  { id: 'not-public-path-in-code', level: KEEP, re: new RegExp(NOT_PUBLIC.source, 'g'), notFiles: /\.md$/ },
  { id: 'public-ip', level: KEEP, re: /\b(?!(127|10|0)\.)(?!192\.168\.)(?!172\.(1[6-9]|2\d|3[01])\.)(?!192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|169\.254\.)(\d{1,3}\.){3}\d{1,3}\b/g, unless: /version|v\d|@\d/i },
]

const FORBIDDEN_FILES = [
  { re: /^(spec|research|backup|shots|attachments|workspace|deepseek-harness)\//, why: 'local-only folder' },
  { re: /(^|\/)\.dsh-(home|test)/, why: 'DSH data' },
  { re: /(^|\/)node_modules\//, why: 'installed packages' },
  { re: /\.(env|pem|key|p12|sqlite|db)$/, why: 'secret or data file' },
  { re: /^\.scan-extra$/, why: 'local scan patterns' },
]

const args = process.argv.slice(2)
const root = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--json')
if (!root) {
  console.error('usage: node scripts/scan.mjs <dir> [--json <file>] [--all]')
  process.exit(2)
}
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const showAll = args.includes('--all')

const findings = []
const files = walk(root).map(path => relative(root, path).split('\\').join('/')).sort()

for (const file of files) {
  for (const rule of FORBIDDEN_FILES) {
    if (rule.re.test(file)) add(MUST, 'forbidden-file', file, 0, rule.why)
  }
  // The scanner names the patterns it looks for.
  if (file === SELF) continue
  const data = readFileSync(join(root, file))
  if (data.includes(0)) continue
  const lines = data.toString('utf8').split('\n')
  lines.forEach((line, index) => {
    for (const rule of TEXT_RULES) {
      if (rule.files && !rule.files.test(file)) continue
      if (rule.notFiles && rule.notFiles.test(file)) continue
      if (rule.unless && rule.unless.test(line)) continue
      const legacy = LEGACY_FILES.test(file) || /legacy|旧版/i.test(line)
      if (rule.legacyOk && legacy) continue
      if (rule.onlyLegacy && !legacy) continue
      rule.re.lastIndex = 0
      for (const match of line.matchAll(rule.re)) {
        if (rule.secret && PLACEHOLDER.test(match[0])) continue
        const shown = rule.secret ? `${match[0].slice(0, 6)}… (${match[0].length} chars)` : snippet(line, match.index, match[0].length)
        add(rule.level, rule.id, file, index + 1, shown, rule.summary)
      }
    }
  })
}

// Package checks: the license and the fields that npm and DSH read.
if (!files.includes('LICENSE')) add(MUST, 'license', 'LICENSE', 0, 'no LICENSE at the root')
if (!files.includes('ds-bot/package.json')) add(MUST, 'plugin-folder', '.', 0, 'no ds-bot/package.json')
else {
  const pkg = JSON.parse(readFileSync(join(root, 'ds-bot/package.json'), 'utf8'))
  if (pkg.name !== 'ds-bot') add(MUST, 'package', 'ds-bot/package.json', 0, `name is "${pkg.name}", expected "ds-bot"`)
  if (!files.includes('ds-bot/LICENSE')) add(MUST, 'package', 'ds-bot/LICENSE', 0, 'the package has no LICENSE file')
  if (!(pkg.files ?? []).includes('LICENSE')) add(MUST, 'package', 'ds-bot/package.json', 0, '"files" does not list LICENSE')
  for (const field of ['repository', 'homepage', 'bugs']) {
    if (!pkg[field]) add(MUST, 'package', 'ds-bot/package.json', 0, `no "${field}" field`)
  }
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (range !== '*') add(KEEP, 'package', 'ds-bot/package.json', 0, `peer ${name} is "${range}", not "*"`)
  }
}
for (const name of ['README.md', 'README.zh.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'AGENTS.md', '.gitignore']) {
  if (!files.includes(name)) add(MUST, 'root-file', name, 0, 'missing at the root')
}

report()

function extraPatterns() {
  const local = join(dirname(fileURLToPath(import.meta.url)), '..', '.scan-extra')
  const lines = [process.env.SCAN_EXTRA_PATTERNS ?? '', existsSync(local) ? readFileSync(local, 'utf8') : '']
    .flatMap(text => text.split(/\r?\n/))
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
  return lines.length ? new RegExp(lines.map(line => `(?:${line})`).join('|'), 'gi') : null
}

function add(level, id, file, line, text, summary = false) {
  findings.push({ level, id, file, line, text, summary })
}

function report() {
  const byLevel = level => findings.filter(f => f.level === level)
  console.log(`scanned ${files.length} files in ${root}${extra ? ' (with extra patterns)' : ''}`)
  for (const level of [MUST, KEEP]) {
    const list = byLevel(level)
    console.log(`\n== ${level}: ${list.length}`)
    const rules = Map.groupBy(list, f => f.id)
    for (const [id, items] of rules) {
      const perFile = Map.groupBy(items, f => f.file)
      console.log(`- ${id}: ${items.length} in ${perFile.size} files`)
      if (items[0].summary) {
        for (const [file, hits] of perFile) console.log(`    ${file}: ${hits.length}`)
        continue
      }
      const shown = showAll ? items : items.slice(0, 6)
      for (const f of shown) console.log(`    ${f.file}${f.line ? `:${f.line}` : ''}  ${f.text}`)
      if (shown.length < items.length) console.log(`    … ${items.length - shown.length} more (--all or --json)`)
    }
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(findings, null, 2))
  process.exit(byLevel(MUST).length > 0 ? 1 : 0)
}

function snippet(line, at, length) {
  const start = Math.max(0, at - 40)
  const end = Math.min(line.length, at + length + 40)
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`
}

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}
