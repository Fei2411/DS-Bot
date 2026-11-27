import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ReactElement } from 'react'
import ts from 'typescript'

import type { MobileReleaseNotesEntry } from './release-notes.ts'

const requireHere = createRequire(import.meta.url)
const { renderToStaticMarkup } = requireHere('react-dom/server') as {
  renderToStaticMarkup: (element: ReactElement) => string
}

let hooks: ReturnType<typeof registerHooks> | undefined
let mod: typeof import('./release-notes.ts')
let modalMod: typeof import('../ui/ReleaseNotesModal.tsx')

const SAMPLE_RELEASES: MobileReleaseNotesEntry[] = [
  { version: '0.3.10', date: '2026-11-22', notes: { zh: { items: ['十'] }, en: { items: ['ten'] } } },
  { version: '0.3.9', date: '2026-11-21', notes: { zh: { items: ['九'] }, en: { items: ['nine'] } } },
  { version: '0.3.8', date: '2026-11-16', notes: { en: { items: ['eight'] } } },
]

function memoryStorage(initial: Record<string, string> = {}, { failWrite = false } = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async getItemAsync(key: string) { return map.get(key) ?? null },
    async setItemAsync(key: string, value: string) {
      if (failWrite) throw new Error('storage write failed')
      map.set(key, value)
    },
  }
}

before(async () => {
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === '../storage'
        || specifier === 'react-native'
        || specifier === '../team/app-version.ts'
        || specifier === './i18n.ts'
        || specifier === './tokens.ts'
      ) {
        return { url: `mock:rn:${specifier}`, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'mock:rn:../storage') {
        return {
          format: 'module',
          shortCircuit: true,
          source: 'export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1; export async function getItemAsync() { return null }; export async function setItemAsync() {}',
        }
      }
      if (url === 'mock:rn:react-native') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const Linking = { openURL: async () => {} }
            export const Modal = ({ children, visible }) => (visible ? children : null)
            export const Pressable = ({ children, ...props }) => ({ type: 'Pressable', props, children })
            export const ScrollView = ({ children, ...props }) => ({ type: 'ScrollView', props, children })
            export const Text = ({ children, ...props }) => ({ type: 'Text', props, children })
            export const View = ({ children, ...props }) => ({ type: 'View', props, children })
            export const StyleSheet = { create: s => s, absoluteFill: {}, hairlineWidth: 1 }
          `,
        }
      }
      if (url === 'mock:rn:../team/app-version.ts') {
        return { format: 'module', shortCircuit: true, source: 'export const currentAppVersion = () => "0.3.10"' }
      }
      if (url === 'mock:rn:./i18n.ts') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const getLang = () => 'en'
            export const t = (key, vars = {}) => key.replace(/\\{(\\w+)\\}/g, (_, k) => String(vars[k] ?? ''))
          `,
        }
      }
      if (url === 'mock:rn:./tokens.ts') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const radius = { dialog: 16, pill: 999 }
            export const shadow = () => ({})
            export const type = { headerTitle: {}, caption: {}, small: {} }
            export const useTheme = () => ({ dark: false, p: { main: '#fff', line: '#eee', line2: '#ddd', ink: '#111', ink2: '#444', ink3: '#888', hover: '#f5f5f5', accent: '#06f', accentInk: '#fff' } })
          `,
        }
      }
      if (url.endsWith('.tsx')) {
        const raw = readFileSync(fileURLToPath(url), 'utf8')
        const out = ts.transpileModule(raw, {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
          fileName: fileURLToPath(url),
        })
        return { format: 'module', shortCircuit: true, source: out.outputText }
      }
      return nextLoad(url, context)
    },
  })
  mod = await import('./release-notes.ts')
  modalMod = await import('../ui/ReleaseNotesModal.tsx')
})

after(() => { hooks?.deregister() })

test('fresh install records current version silently without showing modal', async () => {
  const storage = memoryStorage()
  const result = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.10',
    hadExistingIdentity: false,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(result, { show: false, current: '0.3.10', versions: [] })
  assert.equal(storage.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.10')
})

test('seedFreshInstallReleaseNotes records version when empty and never overwrites an existing seen version', async () => {
  const empty = memoryStorage()
  await mod.seedFreshInstallReleaseNotes({ currentVersion: '0.3.10', storage: empty })
  assert.equal(empty.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.10')

  const existing = memoryStorage({ [mod.RELEASE_NOTES_SEEN_KEY]: '0.3.8' })
  await mod.seedFreshInstallReleaseNotes({ currentVersion: '0.3.10', storage: existing })
  assert.equal(existing.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.8')
})

test('existing user upgrading from build without seen key sees only current release once', async () => {
  const storage = memoryStorage()
  const first = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.10',
    hadExistingIdentity: true,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(first, { show: true, current: '0.3.10', versions: ['0.3.10'] })
  assert.equal(storage.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.10')

  const second = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.10',
    hadExistingIdentity: true,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(second, { show: false, current: '0.3.10', versions: [] })
})

test('multi-version upgrade shows only current version (never older ones) and downgrade stays silent without rolling back', async () => {
  const storage = memoryStorage({ [mod.RELEASE_NOTES_SEEN_KEY]: '0.3.8' })
  const multi = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.10',
    hadExistingIdentity: true,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(multi, { show: true, current: '0.3.10', versions: ['0.3.10'] })
  assert.equal(storage.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.10')

  const downgrade = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.8',
    hadExistingIdentity: true,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(downgrade, { show: false, current: '0.3.8', versions: [] })
  assert.equal(storage.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.10')
})

test('storage write failure suppresses popup and keeps unseen for retry', async () => {
  const storage = memoryStorage({ [mod.RELEASE_NOTES_SEEN_KEY]: '0.3.9' }, { failWrite: true })
  const failed = await mod.checkMobileReleaseNotes({
    currentVersion: '0.3.10',
    hadExistingIdentity: true,
    storage,
    releases: SAMPLE_RELEASES,
  })
  assert.deepEqual(failed, { show: false, current: '0.3.10', versions: [] })
  assert.equal(storage.map.get(mod.RELEASE_NOTES_SEEN_KEY), '0.3.9')
})

test('useMobileReleaseNotes uses useSyncExternalStore and catches updates opened before commit', async () => {
  const React = await import('react')
  mod.closeMobileReleaseNotes()

  // Simulate openMobileReleaseNotes firing before the modal renders: snapshot is immediately visible.
  mod.openMobileReleaseNotes({ mode: 'auto', current: '0.3.10' })
  let observed: unknown = null
  function Probe() {
    observed = mod.useMobileReleaseNotes()
    return null
  }
  renderToStaticMarkup(React.createElement(Probe))
  assert.deepEqual(observed, { open: true, mode: 'auto', current: '0.3.10' })

  mod.closeMobileReleaseNotes()
  renderToStaticMarkup(React.createElement(Probe))
  assert.deepEqual(observed, { open: false, mode: 'auto', current: '0.3.10' })
})

test('ReleaseNotesModal renders only current version, never earlier versions, and shows empty state when current has no entry', async () => {
  const React = await import('react')

  // Render helper that inspects the element tree produced by React components.
  const collectText = (node: unknown): string[] => {
    if (node === null || node === undefined || typeof node === 'boolean') return []
    if (typeof node === 'string' || typeof node === 'number') return [String(node)]
    if (Array.isArray(node)) return node.flatMap(collectText)
    if (typeof node === 'object') {
      const el = node as { type?: unknown; props?: { children?: unknown }; children?: unknown }
      if (typeof el.type === 'function') {
        const rendered = (el.type as (p: unknown) => unknown)(el.props ?? {})
        return collectText(rendered)
      }
      return [...collectText(el.props?.children), ...collectText(el.children)]
    }
    return []
  }

  // Case 1: exact match for 0.3.10 renders only 0.3.10, never 0.3.9 or 0.3.8 or Earlier versions.
  mod.openMobileReleaseNotes({ mode: 'manual', current: '0.3.10' })
  let captured: unknown = null
  function CaptureMatched() {
    captured = modalMod.ReleaseNotesModal({ releases: SAMPLE_RELEASES })
    return null
  }
  renderToStaticMarkup(React.createElement(CaptureMatched))
  const matchedText = collectText(captured).join(' ')
  assert.match(matchedText, /What's new in v0\.3\.10/)
  assert.match(matchedText, /\bten\b/)
  assert.doesNotMatch(matchedText, /\bnine\b|\beight\b|Earlier versions|Hide earlier/)
  assert.match(matchedText, /Full changelog/)

  // Case 2: current version 0.3.11 has no exact entry -> shows empty state, never falls back to 0.3.10.
  mod.openMobileReleaseNotes({ mode: 'manual', current: '0.3.11' })
  function CaptureMissing() {
    captured = modalMod.ReleaseNotesModal({ releases: SAMPLE_RELEASES })
    return null
  }
  renderToStaticMarkup(React.createElement(CaptureMissing))
  const missingText = collectText(captured).join(' ')
  assert.match(missingText, /What's new in v0\.3\.11/)
  assert.match(missingText, /No release notes for this version yet\./)
  assert.doesNotMatch(missingText, /\bten\b|\bnine\b|2026-11-22/)
  assert.match(missingText, /Full changelog/)

  mod.closeMobileReleaseNotes()
})
