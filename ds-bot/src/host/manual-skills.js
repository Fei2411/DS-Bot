import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'ds-bot-manual'
const SKILL = 'ds-bot-manual'
const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'skills', SKILL)

export function manualDirectory(path = DIRECTORY) {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

function readSkill(locator) {
  const raw = readFileSync(locator, 'utf8')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const description = /^description:\s*(.+)$/mu.exec(frontmatter?.[1] ?? '')?.[1]?.trim()
  if (!description) throw new Error(`${PROVIDER}: ${locator} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

export function manualProvider() {
  const directory = manualDirectory()
  const locator = join(directory, 'SKILL.md')
  const { description } = readSkill(locator)
  const item = {
    name: SKILL, description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER, source: 'bundled', rank: 550,
    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
    locator,
  }
  return {
    name: PROVIDER,
    list: () => Promise.resolve([item]),
    async get(candidate) {
      return { ...candidate, ...readSkill(candidate.locator) }
    },
  }
}

export function install(rt) {
  rt.ctx.inject?.({ skills: null }, ctx => ctx.skills.registerProvider(() => manualProvider()))
}
