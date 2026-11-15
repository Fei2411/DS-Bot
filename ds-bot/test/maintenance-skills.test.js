import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { install, maintenanceProvider } from '../src/host/maintenance-skills.js'

const SKILL_MD = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'host', 'skills', 'ds-bot-maintenance', 'SKILL.md',
)

test('maintenanceProvider lists ds-bot-maintenance with bundled rank 550 metadata', async () => {
  const provider = maintenanceProvider()
  assert.equal(provider.name, 'ds-bot-maintenance')

  const items = await provider.list()
  assert.equal(items.length, 1)

  const [item] = items
  assert.equal(item.name, 'ds-bot-maintenance')
  assert.match(item.description, /Diagnose, inspect, update, back up, migrate, or repair DS Bot/)
  assert.equal(item.provider, 'ds-bot-maintenance')
  assert.equal(item.source, 'bundled')
  assert.equal(item.rank, 550)
  assert.deepEqual(item.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(item.resourceBase?.kind, 'directory')
  assert.match(item.resourceBase?.path ?? '', /\/src\/host\/skills\/ds-bot-maintenance$/)
  assert.equal(typeof item.locator, 'string')
})

test('maintenanceProvider.get loads YAML frontmatter, required maintenance sections, and clean docs tokens', async () => {
  const raw = readFileSync(SKILL_MD, 'utf8')
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  assert.ok(frontmatter, 'SKILL.md must start with YAML frontmatter')
  assert.match(frontmatter[1], /^name:\s*ds-bot-maintenance$/m)
  assert.match(frontmatter[1], /^description:\s*\S+/m)

  const provider = maintenanceProvider()
  const [listed] = await provider.list()

  const fromListed = await provider.get(listed)
  assert.ok(fromListed)
  assert.equal(fromListed.name, 'ds-bot-maintenance')
  assert.equal(fromListed.description, listed.description)
  assert.equal(fromListed.provider, 'ds-bot-maintenance')
  assert.equal(fromListed.source, 'bundled')
  assert.deepEqual(fromListed.invocation, { modelInvocable: true, userInvocable: true })
  assert.ok(!fromListed.content.startsWith('---'))

  const byName = await provider.get({ name: 'ds-bot-maintenance' })
  assert.equal(byName?.content, fromListed.content)
  assert.equal(await provider.get({ name: 'other-skill' }), undefined)

  for (const needle of [
    'bot/state.lock',
    'DSH_HOME',
    'DS_BOT_HOME',
    'start.ps1',
    'Docker',
    'list_bots',
    'list_bot_models',
    'list_secrets',
    'recall',
    'diagnostics.jsonl',
    'npx ds-bot doctor',
    '--fix',
    '--home',
    '--dsh-version',
    'pnpm why @deepseek-ai/',
    'disabling profile plugin row "bot"',
    'WEB_PROVIDER_CONFIGURED_MISSING',
    'GLIBC_2.27',
    'DSH_TRUSTED_HOST',
    'Settings > General > Locations',
    'docs/self-maintenance.md',
  ]) {
    assert.ok(fromListed.content.includes(needle), `expected SKILL.md to mention ${needle}`)
  }

  assert.doesNotMatch(raw, new RegExp(`${['DeepSeek', '[-_ ]?Bot'].join('')}|${['dsh', '\\s+bot'].join('')}`, 'i'))
  assert.doesNotMatch(raw, new RegExp(`\\.${['dsh', 'home'].join('-')}`))
  assert.doesNotMatch(raw, /(?:^|[\s(`'"]|\.\.\/)(?:spec|research|backup|shots|attachments|workspace)\//im)
  assert.doesNotMatch(raw, new RegExp([`TB${'D\\('}`, `DRA${'FT for'}`, '\u8349\u7a3f'].join('|')))
  for (const line of raw.split(/\r?\n/u)) {
    if (/\bdsh-bot\b/i.test(line)) {
      assert.match(line, /legacy|旧版/)
    }
  }
})

test('install registers the maintenance provider through ctx.inject when skills exists', async () => {
  const registered = []
  let injectedDeps = null
  const rt = {
    ctx: {
      inject(deps, callback) {
        injectedDeps = deps
        return callback({
          skills: {
            registerProvider(factory) {
              registered.push(factory)
              return () => {}
            },
          },
        })
      },
    },
  }

  install(rt)
  assert.deepEqual(injectedDeps, { skills: null })
  assert.equal(registered.length, 1)

  const provider = registered[0]()
  assert.equal(provider.name, 'ds-bot-maintenance')
  const items = await provider.list()
  assert.equal(items.length, 1)
  assert.equal(items[0].name, 'ds-bot-maintenance')

  assert.doesNotThrow(() => install({ ctx: {} }))
})
