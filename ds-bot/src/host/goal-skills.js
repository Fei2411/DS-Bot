// Registers the bundled goal-grill and report-ds-bot-issue skills when the skills service is available.
import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'ds-bot-goal'
const SKILLS = ['goal-grill', 'report-ds-bot-issue']
const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'skills')

function parseSkill(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const metadata = frontmatter?.[1] ? Object.fromEntries(
    frontmatter[1].split('\n').map(line => /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())?.slice(1) ?? []).filter(p => p.length === 2)) : {}
  if (typeof metadata.description !== 'string' || metadata.description.length === 0) {
    throw new Error(`${PROVIDER}: ${path} has no description`)
  }
  return { description: metadata.description, content: raw.slice(frontmatter[0].length).trim() }
}

function candidate(name) {
  const directory = join(ROOT, name)
  const locator = join(directory, 'SKILL.md')
  const { description } = parseSkill(readFileSync(locator, 'utf8'), locator)
  return {
    name, description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER, source: 'bundled', rank: 550,
    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
    locator,
  }
}

export function goalProvider() {
  const all = SKILLS.map(candidate)
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
