// Guards DS Bot's canonical UI carrier architecture across `ds-bot/src/client/` and `app/ui/src/`.
// Every product interaction family must compose from `ds-bot/src/client/ui/`:
//   - Top surfaces / notices   -> `ui/island.js`   (DynamicIsland, IslandNotice, IslandPod, IslandPanel, IslandPager)
//   - Interactive & tool cards -> `ui/card.js`     (ActionCard, SettledCard, CardShell, CardDock)
//   - Continuous & stepped     -> `ui/slider.js`   (Slider)
//   - Centered modals          -> `ui/dialog.js`   (Dialog)
//   - Anchored popovers/menus  -> `ui/popover.js`  (PopoverMenu, useAnchoredMenu, useInlineMenu, Collapse)
//   - Settings & form controls -> `ui/controls.js` (Switch, SwitchRow, SettingSection, SettingCard, SettingRow,
//                                                   Choice, SelectMenu, Segmented, InlineText, StatusAlert,
//                                                   EmptyState, SearchInput)
//
// `test/ui-architecture-debt.json` records legacy counts that predate the guard; the CI test
// fails when any file introduces a new violation, and when an existing one is removed without
// lowering the baseline:
//
//   node scripts/ui-architecture-guard.mjs          prints current findings
//   node scripts/ui-architecture-guard.mjs --write  lowers test/ui-architecture-debt.json
//
// --write only lowers counts. Adding a new baseline entry must be done by hand so it shows in review.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(import.meta.dirname, '..')
const REPO = resolve(PLUGIN, '..')
export const DEBT = join(PLUGIN, 'test', 'ui-architecture-debt.json')

const SCAN_ROOTS = [
  { prefix: 'ds-bot/src/client', dir: join(PLUGIN, 'src', 'client'), exts: ['.js'] },
  { prefix: 'app/ui/src', dir: join(REPO, 'app', 'ui', 'src'), exts: ['.js', '.css'] },
]

// Comments are not code. Strip JS/CSS line and block comments while preserving
// single-quoted, double-quoted, and template string literals (and URLs inside them).
export function stripComments(text) {
  let out = ''
  let i = 0
  const n = text.length
  let state = 'code' // 'code' | 'single' | 'double' | 'template' | 'line' | 'block'
  while (i < n) {
    const ch = text[i]
    const next = text[i + 1]
    if (state === 'line') {
      if (ch === '\n' || ch === '\r') {
        state = 'code'
        out += ch
      }
      i += 1
      continue
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code'
        out += ' '
        i += 2
      } else {
        if (ch === '\n') out += '\n'
        i += 1
      }
      continue
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      out += ch
      if (ch === '\\' && i + 1 < n) {
        out += next
        i += 2
        continue
      }
      if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) {
        state = 'code'
      }
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      state = 'line'
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      state = 'block'
      i += 2
      continue
    }
    if (ch === "'") state = 'single'
    else if (ch === '"') state = 'double'
    else if (ch === '`') state = 'template'
    out += ch
    i += 1
  }
  return out
}

const isUiCarrier = file => file.startsWith('ds-bot/src/client/ui/')

const SWITCH_RE = /\brole\s*:\s*['"]switch['"]|(?<!\[)\brole=["']switch["']/g
const SLIDER_RE = /\btype\s*:\s*['"]range['"]|(?<!\[)\btype=["']range["']|\brole\s*:\s*['"]slider['"]|(?<!\[)\brole=["']slider["']/g
const SELECT_RE = /\b(?:h|createElement)\(\s*['"]select['"]/g
const DIALOG_RE = /\brole\s*:\s*['"](?:dialog|alertdialog)['"]|(?<!\[)\brole=["'](?:dialog|alertdialog)["']/g
// Match JS className expressions (string literals, template literals, or ternaries) that build a bare raised/dock/settled card shell outside ui/card.js & deep-view.js.
const CARD_SHELL_RE = /\bclassName\s*:[^\n;]*\b(bt-q-raised|bt-q-dock|bt-q-settled)\b/g
const TOP_BANNER_RE = /\bdsb-conn-banner\b|\bbt-top-banner\b/g
const CURVE_RE = /\bcubic-bezier\([^)]*\)/g

export const checks = {
  switches: (file, text) => (
    file === 'ds-bot/src/client/ui/controls.js' ? [] : [...text.matchAll(SWITCH_RE)].map(m => m[0].replace(/\s+/g, ''))
  ),
  sliders: (file, text) => (
    file === 'ds-bot/src/client/ui/slider.js' ? [] : [...text.matchAll(SLIDER_RE)].map(m => m[0].replace(/\s+/g, ''))
  ),
  selects: (file, text) => (
    file === 'ds-bot/src/client/ui/controls.js' ? [] : [...text.matchAll(SELECT_RE)].map(() => "h('select')")
  ),
  dialogs: (file, text) => (
    file === 'ds-bot/src/client/ui/dialog.js' ? [] : [...text.matchAll(DIALOG_RE)].map(m => (
      m[0].includes('alertdialog') ? "role:'alertdialog'" : "role:'dialog'"
    ))
  ),
  cards: (file, text) => {
    if (!file.endsWith('.js')) return []
    if (file === 'ds-bot/src/client/ui/card.js' || file === 'ds-bot/src/client/deep-view.js' || file === 'ds-bot/src/client/widget-cell.js') return []
    return [...text.matchAll(CARD_SHELL_RE)].map(m => m[1])
  },
  topBanners: (file, text) => (
    file === 'ds-bot/src/client/ui/island.js' ? [] : [...text.matchAll(TOP_BANNER_RE)].map(m => m[0])
  ),
  curves: (file, text) => {
    if (isUiCarrier(file) || file === 'ds-bot/src/client/motion.js' || file.startsWith('ds-bot/src/client/avatar/')) return []
    return [...text.matchAll(CURVE_RE)].map(m => m[0].replace(/\s+/g, ''))
  },
}

export function findViolations(roots = SCAN_ROOTS) {
  const found = Object.fromEntries(Object.keys(checks).map(kind => [kind, {}]))
  for (const root of roots) {
    if (!existsSync(root.dir)) continue
    const files = readdirSync(root.dir, { recursive: true })
      .map(name => String(name).replaceAll('\\', '/'))
      .filter(name => root.exts.some(ext => name.endsWith(ext)))
    for (const rel of files) {
      const file = `${root.prefix}/${rel}`
      const text = stripComments(readFileSync(join(root.dir, rel), 'utf8'))
      for (const [kind, check] of Object.entries(checks)) {
        for (const value of check(file, text)) {
          const counts = (found[kind][file] ??= {})
          counts[value] = (counts[value] ?? 0) + 1
        }
      }
    }
  }
  return found
}

export const readDebt = () => JSON.parse(readFileSync(DEBT, 'utf8'))

export function lowered(debt, found) {
  return Object.fromEntries(Object.keys(checks).map(kind => [kind, Object.fromEntries(Object.entries(debt[kind] ?? {})
    .map(([file, values]) => [file, Object.fromEntries(Object.entries(values)
      .map(([value, count]) => [value, Math.min(count, found[kind]?.[file]?.[value] ?? 0)])
      .filter(([, count]) => count > 0))])
    .filter(([, values]) => Object.keys(values).length > 0))]))
}

const sorted = item => (typeof item === 'object' && item !== null
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => [key, sorted(value)]))
  : item)
export const formatDebt = debt => `${JSON.stringify(sorted(debt), null, 2)}\n`

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findViolations()
  if (process.argv.includes('--init')) writeFileSync(DEBT, formatDebt(found))
  else if (process.argv.includes('--write')) writeFileSync(DEBT, formatDebt(lowered(readDebt(), found)))
  else process.stdout.write(formatDebt(found))
}
