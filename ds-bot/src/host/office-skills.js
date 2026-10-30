// The ds-bot Office skills: `office` (the routing skill, preferred over the
// platform's own bundled router) and `office-tools` (the CLI that inspects,
// checks and edits Office packages). Registered when a `skills` service exists;
// the sub-fiber stays inactive where it does not, so the plugin runs the same
// in DSH Web, DSH Desktop and the desktop app.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'ds-bot-office'
const RANK = { office: 550, 'office-tools': 600 }
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'office', 'skills')
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'office.js')

function parseSkill(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const metadata = frontmatter?.[1] ? Object.fromEntries(
    frontmatter[1].split('\n').map(line => /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())?.slice(1) ?? []).filter(p => p.length === 2)) : {}
  if (typeof metadata.description !== 'string' || metadata.description.length === 0) {
    throw new Error(`${PROVIDER}: ${path} has no description`)
  }
  return { description: metadata.description, content: raw.slice(frontmatter[0].length).trim() }
}

// The payload Node is a plain interpreter and cannot read through an asar archive.
export function cliPath(manifest = CLI) {
  return manifest.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

// Where the commands run: the app's Office payload when it shipped, plain Node
// hosts (DSH Web, a developer Node), or the workspace-dependencies tool's node.
export function officeNode(env = process.env) {
  const bundled = env.DS_BOT_OFFICE_NODE
  if (bundled !== undefined && existsSync(bundled)) return { node: bundled }
  if (process.versions.electron === undefined && !isSea()) return { node: process.execPath }
  return { node: undefined }
}

function runtimeBlock() {
  const cli = cliPath()
  const { node } = officeNode()
  const paths = node === undefined
    ? `The commands need a standalone Node. Call the \`load_workspace_dependencies\` tool and use its \`node\` value; if that tool is not in the catalog, these commands are unavailable here.`
    : `Run the commands as \`"${node}" "${cli}" …\` in Bash, or \`& "${node}" "${cli}" …\` in PowerShell.`
  return `\n\n## Office tools\n\n${JSON.stringify({ officeTools: { node, cli } }, undefined, 2)}\n\n${paths}`
}

function candidates() {
  return Object.keys(RANK).map(skillName => {
    const directory = join(ASSETS, skillName)
    const locator = join(directory, 'SKILL.md')
    const { description } = parseSkill(readFileSync(locator, 'utf8'), locator)
    return {
      name: skillName, description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER, source: 'bundled', rank: RANK[skillName],
      resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
      locator,
    }
  })
}

export function officeProvider() {
  const all = candidates()
  return {
    name: PROVIDER,
    list: () => Promise.resolve(all),
    async get(candidate) {
      const { description, content } = parseSkill(readFileSync(candidate.locator, 'utf8'), candidate.locator)
      return { ...candidate, description, content: content + (candidate.name === 'office-tools' ? runtimeBlock() : '') }
    },
  }
}

export function install(rt) {
  rt.ctx.inject?.({ skills: null }, ctx => ctx.skills.registerProvider(() => officeProvider()))
}
