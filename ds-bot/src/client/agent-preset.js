// The Agent preset a Bot runs on: the profile's preset directory, and the choice a
// Bot keeps. Plain helpers, kept free of React so tests can load them.
import { hostText, presetText, t } from './i18n.js'

const PRESET_COPY = new Map([['standard', 'Standard'], ['ptc', 'Ptc'], ['minimal', 'Minimal'], ['cordis', 'Cordis']])

function displayOf(row) {
  // Named declarations own their copy, even if they replace a shipped preset id.
  const key = row.name === undefined ? PRESET_COPY.get(row.id) : undefined
  return {
    name: (key ? presetText(`preset${key}Name`) : undefined) ?? row.name ?? row.id,
    description: (key ? presetText(`preset${key}Description`) : undefined) ?? row.description,
  }
}

// The default choice: no explicit preset, so the host's own rule stands.
export const DEFAULT_PRESET = null

// What the default is, by the profile's directory: the standard preset when the
// profile serves it, else the default DeepSeek Harness picks for new tasks. A
// directory that has not loaded yet promises neither.
export function defaultPreset(presets) {
  if (presets === null || presets === undefined) return { name: t('Default'), description: undefined }
  const standard = normalizePresets(presets).some(entry => entry.id === 'standard' && entry.broken === undefined)
  return standard
    ? { name: t('Default (Standard)'), description: t('The standard agent preset') }
    : { name: t('Default (DSH default)'), description: t('The default for new tasks in DeepSeek Harness.') }
}

// A preset the profile cannot start: the reason it gives, or none at all.
const brokenReason = value => {
  if (value === undefined || value === null || value === false) return undefined
  if (value === true) return ''
  return String(value)
}

// The host's answer: the preset directory of the profile DS Bot runs in.
export function normalizePresets(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.presets) ? value.presets : []
  return list
    .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
    .map(entry => ({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : undefined,
      description: typeof entry.description === 'string' && entry.description !== '' ? entry.description : undefined,
      broken: brokenReason(entry.broken),
    }))
}

// What a Bot shows for its saved preset: the preset's name, the default, or a
// missing marker for one the profile no longer serves. A missing preset is never
// swapped for another one on its own, and a directory that has not loaded yet says
// nothing about it.
export function presetState(saved, presets) {
  const id = typeof saved === 'string' && saved !== '' ? saved : DEFAULT_PRESET
  if (id === DEFAULT_PRESET) return { id: null, name: defaultPreset(presets).name, missing: false, broken: undefined, pending: false }
  if (presets === null || presets === undefined) return { id, name: id, missing: false, broken: undefined, pending: true }
  const found = normalizePresets(presets).find(entry => entry.id === id)
  if (found === undefined) return { id, name: t('Missing preset'), missing: true, broken: undefined, pending: false }
  return { id, ...displayOf(found), missing: false, broken: found.broken, pending: false }
}

// The rows the picker shows: the default first, then every preset the profile
// serves. A broken preset stays in the list, disabled, with its reason; a saved
// preset the profile no longer serves stays visible as missing.
export function presetRows(saved, presets) {
  const list = normalizePresets(presets)
  const state = presetState(saved, presets === null || presets === undefined ? null : list)
  const fallback = defaultPreset(presets)
  const rows = [{ id: null, name: fallback.name, description: fallback.description, broken: undefined, disabled: false, missing: false }]
  for (const entry of list) {
    const broken = entry.broken !== undefined
    const display = displayOf(entry)
    rows.push({
      ...entry,
      ...display,
      description: broken ? (entry.broken !== '' ? hostText(entry.broken) : t('This preset cannot start.')) : display.description,
      disabled: broken,
      missing: false,
    })
  }
  if (state.missing) rows.push({ id: state.id, name: t('Missing preset'), description: state.id, broken: undefined, disabled: true, missing: true })
  return rows
}

// What an update sends for the Agent preset: the chosen preset, or null to clear
// the Bot's choice so the default standard rules stand again. Nothing is sent when
// the choice did not change.
export function presetUpdate(id, saved) {
  const next = typeof id === 'string' && id !== '' ? id : DEFAULT_PRESET
  const current = typeof saved === 'string' && saved !== '' ? saved : DEFAULT_PRESET
  return next === current ? undefined : next
}

// What the Bot's Agent preset row says: a preset the profile no longer serves and
// one it cannot start both say so, a directory that could not be read says so, and
// a running Session keeps its own preset until the next conversation segment.
export function presetHint(bot, presets, error) {
  if (error) return t('The preset list could not be loaded.')
  if (presets === null || presets === undefined) return t('Loading…')
  const state = presetState(bot.agentPreset, presets)
  if (state.missing) return t('This preset is not in the profile anymore. Pick another one.')
  if (state.broken !== undefined) return state.broken === ''
    ? t('This preset cannot start. Pick another one.')
    : t('This preset cannot start ({reason}). Pick another one.', { reason: hostText(state.broken) })
  if (state.id === null) return defaultPreset(presets).description
  return t('Applies from the next conversation segment.')
}

// The directory reader: it asks the host and brings back the directory, or the
// failure that came with it. One reader per view; an answer that comes after a
// newer one is dropped, so an old request never overwrites a newer result.
export function createReader(ask) {
  let ticket = 0
  return async () => {
    const current = ++ticket
    let answer
    try {
      answer = { presets: normalizePresets(await ask()), error: '' }
    } catch (failure) {
      answer = { presets: null, error: failure?.message ?? String(failure) }
    }
    return current === ticket ? answer : undefined
  }
}
