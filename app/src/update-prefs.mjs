// Persists the desktop app's auto-update preference under userData so the main process knows
// whether to check and download updates before the DSH Host starts.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Whether automatic updates are enabled; missing or unreadable files default to true. */
export function readAutoUpdate(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed?.autoUpdate !== false
  } catch {
    return true
  }
}

/** Atomically persist the auto-update preference next to locations.json. */
export function writeAutoUpdate(file, enabled) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify({ autoUpdate: enabled === true }, null, 2)}\n`)
    renameSync(temporary, file)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* ignore cleanup failure */ }
    throw error
  }
}
