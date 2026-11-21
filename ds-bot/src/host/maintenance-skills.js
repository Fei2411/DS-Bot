import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'ds-bot-maintenance'
const SKILLS = ['ds-bot-maintenance', 'ds-bot-plugin-dev']
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skills')

export function skillResourcePath(directory) {
  return directory.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`).split(sep).join('/')
}

function directoryFor(skill) {
  return join(SKILLS_DIR, skill)
}

function locatorFor(skill) {
  return join(directoryFor(skill), 'SKILL.md')
}

function resolveSkill(item) {
  if (item?.name) return SKILLS.includes(item.name) ? item.name : undefined
  if (typeof item?.locator === 'string' && item.locator) {
    const normalized = item.locator.replaceAll('/', sep)
    return SKILLS.find((skill) => locatorFor(skill) === item.locator || locatorFor(skill) === normalized)
  }
  return undefined
}

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

function candidate(skill, parsed) {
  return {
    name: parsed.name,
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    rank: 550,
    resourceBase: { kind: 'directory', path: skillResourcePath(directoryFor(skill)) },
    locator: locatorFor(skill),
  }
}

export function maintenanceProvider() {
  return {
    name: PROVIDER,
    async list() {
      return SKILLS.map((skill) => {
        const locator = locatorFor(skill)
        return candidate(skill, parseSkill(readFileSync(locator, 'utf8'), locator))
      })
    },
    async get(item) {
      const skill = resolveSkill(item)
      if (!skill) return undefined
      const locator = locatorFor(skill)
      const parsed = parseSkill(readFileSync(locator, 'utf8'), locator)
      const entry = candidate(skill, parsed)
      return {
        ...item,
        ...entry,
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
