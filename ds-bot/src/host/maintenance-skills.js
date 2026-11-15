import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'ds-bot-maintenance'
const SKILL = 'ds-bot-maintenance'
const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'skills', SKILL)
const LOCATOR = join(DIRECTORY, 'SKILL.md')

function unquote(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseSkill(raw, path) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
  if (!match) throw new Error(`${path}: missing YAML frontmatter`)
  const metadata = Object.fromEntries(
    match[1]
      .split(/\r?\n/u)
      .map((line) => {
        const colon = line.indexOf(':')
        return colon <= 0 ? null : [line.slice(0, colon).trim(), unquote(line.slice(colon + 1))]
      })
      .filter(Boolean),
  )
  if (typeof metadata.name !== 'string' || metadata.name.length === 0) {
    throw new Error(`${path}: skill frontmatter must set a non-empty name`)
  }
  if (typeof metadata.description !== 'string' || metadata.description.length === 0) {
    throw new Error(`${path}: skill frontmatter must set a non-empty description`)
  }
  return {
    name: metadata.name,
    description: metadata.description,
    content: raw.slice(match[0].length).trim(),
    metadata,
  }
}

function candidate(parsed) {
  return {
    name: parsed.name,
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    rank: 550,
    resourceBase: { kind: 'directory', path: DIRECTORY.split(sep).join('/') },
    locator: LOCATOR,
  }
}

export function maintenanceProvider() {
  return {
    name: PROVIDER,
    async list() {
      return [candidate(parseSkill(readFileSync(LOCATOR, 'utf8'), LOCATOR))]
    },
    async get(item) {
      if (item?.name && item.name !== SKILL) return undefined
      const locator = typeof item?.locator === 'string' && item.locator ? item.locator : LOCATOR
      const parsed = parseSkill(readFileSync(locator, 'utf8'), locator)
      const entry = candidate(parsed)
      return {
        ...entry,
        ...item,
        name: entry.name,
        description: entry.description,
        content: parsed.content,
        path: locator,
        metadata: parsed.metadata,
      }
    },
  }
}

export function install(rt) {
  rt.ctx.inject?.({ skills: null }, ctx => ctx.skills.registerProvider(() => maintenanceProvider()))
}
