// Tests import web-search.js outside a dsh profile, so its @deepseek-ai peers resolve from a
// DeepSeek Harness, as a profile would supply them: DSH_HARNESS, else the packages that
// `npm run harness` installs in dev/harness, else the nearest deepseek-harness/ checkout in a
// folder above ds-bot, else the same search from ds-bot's place in the main worktree (a git
// worktree has no checkout of its own).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugin = resolve(import.meta.dirname, '..')
const above = (start) => {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'deepseek-harness'))) return join(dir, 'deepseek-harness')
    if (dirname(dir) === dir) return undefined
  }
}
const installed = join(plugin, 'dev', 'harness')
const findHarness = () => {
  if (process.env.DSH_HARNESS) return process.env.DSH_HARNESS
  if (existsSync(join(installed, 'node_modules'))) return installed
  const near = above(dirname(plugin))
  if (near) return near
  const beside = resolve(plugin, '../deepseek-harness')
  try {
    const git = (...args) => execFileSync('git', ['-C', dirname(plugin), 'rev-parse', ...args], { encoding: 'utf8' }).trim()
    return above(join(dirname(git('--path-format=absolute', '--git-common-dir')), git('--show-prefix'))) ?? beside
  } catch {
    return beside
  }
}
const harness = findHarness()
// Tests that load other harness packages (jsdom) read the same checkout.
process.env.DSH_HARNESS = harness
// An npm install links the packages at its root; a pnpm checkout keeps each workspace
// package in its own folder, where Node's self-reference rule resolves its exports.
const base = resolve(harness, 'packages/bundle/base/package.json')
const anchor = pathToFileURL(existsSync(base) ? base : resolve(harness, 'package.json')).href
const workspacePackages = new Map()
if (existsSync(base)) {
  const dirs = [
    ...['apps', 'vendor'].flatMap(group => existsSync(join(harness, group))
      ? readdirSync(join(harness, group), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(harness, group, entry.name))
      : []),
    ...(existsSync(join(harness, 'packages'))
      ? readdirSync(join(harness, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())
        .flatMap(group => readdirSync(join(harness, 'packages', group.name), { withFileTypes: true })
          .filter(entry => entry.isDirectory()).map(entry => join(harness, 'packages', group.name, entry.name)))
      : []),
  ]
  for (const dir of dirs) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof name === 'string') workspacePackages.set(name, pathToFileURL(manifest).href)
    } catch {}
  }
}
const packageNameOf = specifier => specifier.split('/').slice(0, 2).join('/')
const pluginUrl = `${pathToFileURL(plugin).href}/`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(pluginUrl)) {
      const parentURL = workspacePackages.get(packageNameOf(specifier)) ?? anchor
      return nextResolve(specifier, { ...context, parentURL })
    }
    return nextResolve(specifier, context)
  },
})
