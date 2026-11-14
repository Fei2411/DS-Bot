// What the start window needs before the team view has loaded: the theme source and the motion
// tier the team view reported last. Kept in the app's own userData, never in DSH_HOME or ~/.dsh
// (docs/plans/2026-10-26-start-window.md §3, §10).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const THEMES = new Set(['light', 'dark', 'system'])
const MOTIONS = new Set(['quiet', 'normal', 'lively'])
const EFFECTS = new Set(['full', 'reduced', 'off'])
const DEFAULTS = { themeSource: 'system', motion: 'normal', effects: 'full' }

/** @returns {{ themeSource: 'light' | 'dark' | 'system', motion: 'quiet' | 'normal' | 'lively', effects: 'full' | 'reduced' | 'off' }} */
export function readStartFrame(file) {
  let saved
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ...DEFAULTS }
  }
  return {
    themeSource: THEMES.has(saved?.themeSource) ? saved.themeSource : DEFAULTS.themeSource,
    motion: MOTIONS.has(saved?.motion) ? saved.motion : DEFAULTS.motion,
    effects: EFFECTS.has(saved?.effects) ? saved.effects : DEFAULTS.effects,
  }
}

/** Keeps the values of `change` that are valid; returns whether the file changed. */
export function writeStartFrame(file, change) {
  const current = readStartFrame(file)
  const next = {
    themeSource: THEMES.has(change.themeSource) ? change.themeSource : current.themeSource,
    motion: MOTIONS.has(change.motion) ? change.motion : current.motion,
    effects: EFFECTS.has(change.effects) ? change.effects : current.effects,
  }
  if (next.themeSource === current.themeSource && next.motion === current.motion && next.effects === current.effects) return false
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, `${JSON.stringify(next)}\n`)
    renameSync(`${file}.tmp`, file)
    return true
  } catch (error) {
    console.error('DS Bot: the start window\'s theme was not saved:', error)
    return false
  }
}
