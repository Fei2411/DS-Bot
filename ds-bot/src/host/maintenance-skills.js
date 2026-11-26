import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'ds-bot-maintenance'
const SKILLS = ['ds-bot-maintenance', 'ds-bot-plugin-dev']
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skills')

export function unpackedPath(path) {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

export function skillResourcePath(directory) {
  return unpackedPath(directory).split(sep).join('/')
}

function directoryFor(skill, skillsDir = SKILLS_DIR) {
  return unpackedPath(join(skillsDir, skill))
}

function locatorFor(skill, skillsDir = SKILLS_DIR) {
  return join(directoryFor(skill, skillsDir), 'SKILL.md')
}

function resolveSkill(item, skillsDir = SKILLS_DIR) {
  if (item?.name) return SKILLS.includes(item.name) ? item.name : undefined
  if (typeof item?.locator === 'string' && item.locator) {
    const normalized = unpackedPath(item.locator.replaceAll('/', sep))
    return SKILLS.find((skill) => locatorFor(skill, skillsDir) === item.locator || locatorFor(skill, skillsDir) === normalized)
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

function candidate(skill, parsed, skillsDir = SKILLS_DIR) {
  return {
    name: parsed.name,
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    rank: 550,
    resourceBase: { kind: 'directory', path: skillResourcePath(directoryFor(skill, skillsDir)) },
    locator: locatorFor(skill, skillsDir),
  }
}

export function maintenanceProvider(skillsDir = SKILLS_DIR) {
  return {
    name: PROVIDER,
    async list() {
      return SKILLS.map((skill) => {
        const locator = locatorFor(skill, skillsDir)
        return candidate(skill, parseSkill(readFileSync(locator, 'utf8'), locator), skillsDir)
      })
    },
    async get(item) {
      const skill = resolveSkill(item, skillsDir)
      if (!skill) return undefined
      const locator = locatorFor(skill, skillsDir)
      const parsed = parseSkill(readFileSync(locator, 'utf8'), locator)
      const entry = candidate(skill, parsed, skillsDir)
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
