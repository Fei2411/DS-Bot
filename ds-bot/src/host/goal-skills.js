// The ds-bot goal skill `goal-grill`: how the admin aligns a group goal with the
// user before writing it. Registered when a `skills` service exists, like the
// Office skills, so the plugin runs the same everywhere.
import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'ds-bot-goal'
const SKILL = 'goal-grill'
const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'skills', SKILL)
const LOCATOR = join(DIRECTORY, 'SKILL.md')

function parseSkill(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const metadata = frontmatter?.[1] ? Object.fromEntries(
    frontmatter[1].split('\n').map(line => /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())?.slice(1) ?? []).filter(p => p.length === 2)) : {}
  if (typeof metadata.description !== 'string' || metadata.description.length === 0) {
    throw new Error(`${PROVIDER}: ${path} has no description`)
  }
  return { description: metadata.description, content: raw.slice(frontmatter[0].length).trim() }
}

function candidate() {
  const { description } = parseSkill(readFileSync(LOCATOR, 'utf8'), LOCATOR)
  return {
    name: SKILL, description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER, source: 'bundled', rank: 550,
    resourceBase: { kind: 'directory', path: DIRECTORY.split(sep).join('/') },
    locator: LOCATOR,
  }
}

export function goalProvider() {
  const all = [candidate()]
  return {
    name: PROVIDER,
    list: () => Promise.resolve(all),
    async get(item) {
      const { description, content } = parseSkill(readFileSync(item.locator, 'utf8'), item.locator)
      return { ...item, description, content }
    },
  }
}

export function install(rt) {
  rt.ctx.inject?.({ skills: null }, ctx => ctx.skills.registerProvider(() => goalProvider()))
}
