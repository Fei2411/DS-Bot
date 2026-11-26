import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const locationsFile = userData => join(userData, 'locations.json')

export function readSavedLocations(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const saved = JSON.parse(text)
    return typeof saved?.dataDir === 'string' && saved.dataDir !== '' ? saved : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}
