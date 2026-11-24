import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, sep } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { install, maintenanceProvider, skillResourcePath } from '../src/host/maintenance-skills.js'
import { TEAM_TOOLS } from '../src/host/constants.js'

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'skills')

function skillFiles(skillName) {
  const dir = join(SKILLS_DIR, skillName)
  const refsDir = join(dir, 'references')
  const files = [join(dir, 'SKILL.md')]
  if (existsSync(refsDir)) {
    for (const entry of readdirSync(refsDir).sort()) {
      if (entry.endsWith('.md')) files.push(join(refsDir, entry))
    }
  }
  return files
}

function teamTool(name) {
  assert.ok(TEAM_TOOLS.includes(name), `${name} is not a team tool`)
  return `\`${name}\``
}

function lineCount(text) {
  return text.trimEnd().split(/\r?\n/u).length
}

function assertCleanDocsHygiene(raw, filePath) {
  assert.doesNotMatch(raw, /@[a-z0-9_-]+\/dsh-dev-index/i, filePath)
  assert.doesNotMatch(raw, /(?:^|[\s(`'"]|\.\.\/)(?:spec|research|backup|shots|attachments|workspace)\//im, filePath)
  for (const line of raw.split(/\r?\n/u)) {
    if (/\bdsh-bot\b/i.test(line)) {
      assert.match(line, /legacy|旧版/, `${filePath}: ${line}`)
    }
  }
}

test('maintenanceProvider lists ds-bot-maintenance and ds-bot-plugin-dev with bundled rank 550 metadata', async () => {
  const provider = maintenanceProvider()
  assert.equal(provider.name, 'ds-bot-maintenance')

  const items = await provider.list()
  assert.deepEqual(items.map((item) => item.name), ['ds-bot-maintenance', 'ds-bot-plugin-dev'])

  const [maintenance, pluginDev] = items
  assert.match(maintenance.description, /Diagnose, inspect, update, back up, migrate, or repair DS Bot/)
  assert.match(pluginDev.description, /plugins, MCP servers, reusable skills, capability packs/)

  for (const item of items) {
    assert.equal(item.provider, 'ds-bot-maintenance')
    assert.equal(item.source, 'bundled')
    assert.equal(item.rank, 550)
    assert.deepEqual(item.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(item.resourceBase?.kind, 'directory')
    assert.ok((item.resourceBase?.path ?? '').endsWith(`/src/host/skills/${item.name}`))
    assert.equal(typeof item.locator, 'string')
  }
})

test('maintenanceProvider.get loads both skills by item, name, and locator while returning undefined for unknown', async () => {
  const provider = maintenanceProvider()
  const items = await provider.list()

  for (const listed of items) {
    const fromListed = await provider.get(listed)
    assert.ok(fromListed)
    assert.equal(fromListed.name, listed.name)
    assert.equal(fromListed.description, listed.description)
    assert.equal(fromListed.provider, 'ds-bot-maintenance')
    assert.equal(fromListed.source, 'bundled')
    assert.deepEqual(fromListed.invocation, { modelInvocable: true, userInvocable: true })
    assert.ok(!fromListed.content.startsWith('---'))

    const byName = await provider.get({ name: listed.name })
    assert.equal(byName?.content, fromListed.content)

    const byLocator = await provider.get({ locator: listed.locator })
    assert.equal(byLocator?.name, listed.name)
    assert.equal(byLocator?.content, fromListed.content)
  }

  assert.equal(await provider.get({ name: 'other-skill' }), undefined)
  assert.equal(await provider.get({ locator: '/nonexistent/skills/unknown/SKILL.md' }), undefined)
  assert.equal(await provider.get(), undefined)
})

test('maintenanceProvider.get keeps bundled metadata over caller-supplied fields', async () => {
  const provider = maintenanceProvider()
  const [listed] = await provider.list()
  const resolved = await provider.get({ ...listed, provider: 'caller', source: 'workspace', rank: 1 })
  assert.equal(resolved.provider, 'ds-bot-maintenance')
  assert.equal(resolved.source, 'bundled')
  assert.equal(resolved.rank, 550)
})

test('maintenanceProvider.get never reads a locator the caller supplied', async () => {
  const provider = maintenanceProvider()
  const [listed] = await provider.list()
  const foreign = join(SKILLS_DIR, 'ds-bot-plugin-dev', 'SKILL.md')
  const resolved = await provider.get({ name: 'ds-bot-maintenance', locator: foreign })
  assert.ok(resolved)
  assert.equal(resolved.name, 'ds-bot-maintenance')
  assert.equal(resolved.path, listed.locator)
  assert.equal(resolved.content, (await provider.get(listed)).content)
})

test('skillResourcePath rewrites app.asar to app.asar.unpacked with forward slashes', () => {
  const packed = ['root', 'resources', 'app.asar', 'node_modules', 'ds-bot', 'src', 'host', 'skills', 'ds-bot-maintenance'].join(sep)
  assert.equal(
    skillResourcePath(packed),
    'root/resources/app.asar.unpacked/node_modules/ds-bot/src/host/skills/ds-bot-maintenance',
  )
  const unpacked = ['root', 'ds-bot', 'src', 'host', 'skills', 'ds-bot-plugin-dev'].join(sep)
  assert.equal(skillResourcePath(unpacked), 'root/ds-bot/src/host/skills/ds-bot-plugin-dev')
})

test('maintenanceProvider rewrites app.asar to app.asar.unpacked for locator and get().path', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-maint-asar-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const suffix = join('node_modules', 'ds-bot', 'src', 'host', 'skills')
  const packedSkills = join(root, 'resources', 'app.asar', suffix)
  const unpackedSkills = join(root, 'resources', 'app.asar.unpacked', suffix)
  mkdirSync(dirname(unpackedSkills), { recursive: true })
  cpSync(SKILLS_DIR, unpackedSkills, { recursive: true })

  const provider = maintenanceProvider(packedSkills)
  const items = await provider.list()
  assert.deepEqual(items.map(item => item.name), ['ds-bot-maintenance', 'ds-bot-plugin-dev'])
  for (const item of items) {
    const expectedLocator = join(unpackedSkills, item.name, 'SKILL.md')
    assert.equal(item.locator, expectedLocator)
    assert.equal(item.resourceBase.path, join(unpackedSkills, item.name).split(sep).join('/'))
    assert.ok(!item.locator.includes(`${sep}app.asar${sep}`))
    const loaded = await provider.get(item)
    assert.equal(loaded.locator, expectedLocator)
    assert.equal(loaded.path, expectedLocator)
    assert.ok(!loaded.path.includes(`${sep}app.asar${sep}`))
    const fromPackedLocator = await provider.get({ locator: join(packedSkills, item.name, 'SKILL.md') })
    assert.equal(fromPackedLocator?.path, expectedLocator)
  }
})

test('bundled skills follow progressive disclosure, line budgets, valid references, required tokens, and docs hygiene', () => {
  // goal-grill belongs to another provider (goal-skills.js); its SKILL.md sits in the same
  // skills directory, so this layout check covers it too.
  for (const skillName of ['ds-bot-maintenance', 'ds-bot-plugin-dev', 'goal-grill']) {
    const skillPath = join(SKILLS_DIR, skillName, 'SKILL.md')
    const raw = readFileSync(skillPath, 'utf8')
    const lines = lineCount(raw)
    assert.ok(lines <= 85, `${skillName}/SKILL.md has ${lines} lines (expected <= 85)`)

    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
    assert.ok(frontmatter, `${skillName}/SKILL.md must start with YAML frontmatter`)
    assert.match(frontmatter[1], new RegExp(`^name:\\s*${skillName}$`, 'm'))
    assert.match(frontmatter[1], /^description:\s*\S+/m)
  }

  for (const skillName of ['ds-bot-maintenance', 'ds-bot-plugin-dev']) {
    const dir = join(SKILLS_DIR, skillName)
    const skillRaw = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    const citedRefs = [...new Set(skillRaw.match(/references\/[a-z0-9-]+\.md/g) ?? [])]
    assert.ok(citedRefs.length > 0, `expected ${skillName}/SKILL.md to cite references/*.md`)

    for (const relRef of citedRefs) {
      const refPath = join(dir, relRef)
      assert.ok(existsSync(refPath), `missing cited reference ${skillName}/${relRef}`)
      const refLines = lineCount(readFileSync(refPath, 'utf8'))
      assert.ok(refLines >= 20, `${skillName}/${relRef} has ${refLines} lines (expected >= 20)`)
    }

    for (const filePath of skillFiles(skillName)) {
      assertCleanDocsHygiene(readFileSync(filePath, 'utf8'), filePath)
    }
  }

  const maintenanceCombined = skillFiles('ds-bot-maintenance').map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const needle of [
    'bot/state.lock',
    'DSH_HOME',
    'DS_BOT_HOME',
    'start.ps1',
    'Docker',
    teamTool('list_bots'),
    teamTool('list_bot_models'),
    teamTool('list_secrets'),
    teamTool('bot_recall'),
    'diagnostics.jsonl',
    'main.1.log',
    'memory-tidy.js',
    'cursor-cli',
    'schedule_create',
    'this_session',
    '1m',
    '5m',
    '15m',
    'verifiedDsh',
    'minBot',
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
    'https://deepseek-harness.github.io/deepseek-harness/llms.txt',
    'https://github.com/deepseek-ai/deepseek-harness',
    'dsh_docs',
  ]) {
    assert.ok(maintenanceCombined.includes(needle), `expected ds-bot-maintenance skill/references to mention ${needle}`)
  }

  const pluginDevCombined = skillFiles('ds-bot-plugin-dev').map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const needle of [
    teamTool('save_capability'),
    teamTool('attach_capability'),
    teamTool('list_connectors'),
    teamTool('request_connector'),
    'request_secret',
    '$DSH_SECRET_',
    'approved: false',
    'Settings → Tools → Capabilities',
    'Settings → Connect → Connectors',
    'Settings → Models → Local agents',
    'Always',
    'Catalog',
    'Off',
    'use_pack',
    'drop_pack',
    'streamable-http',
    '<workspace>/plugins/<name>',
    'plainToolSchema',
    'peerDependencies',
    '@deepseek-ai/*',
    'sessionId !== botId',
    'cordis.patch.yml',
    'local-acp-',
    'LoopbackMcp',
    'mcp-stdio.js',
    'style-debt.test.js',
    'docs/plugin-development.md',
    'https://deepseek-harness.github.io/deepseek-harness/llms.txt',
    'https://github.com/deepseek-ai/deepseek-harness',
    'dsh_docs',
    'cordis_inspect_list',
    'cordis_inspect_query',
    'dsh_plugins',
  ]) {
    assert.ok(pluginDevCombined.includes(needle), `expected ds-bot-plugin-dev skill/references to mention ${needle}`)
  }
  assert.doesNotMatch(pluginDevCombined, /\b39\b/)

  const pluginDevSkillRaw = readFileSync(join(SKILLS_DIR, 'ds-bot-plugin-dev', 'SKILL.md'), 'utf8')
  const capabilitiesMcpRaw = readFileSync(join(SKILLS_DIR, 'ds-bot-plugin-dev', 'references', 'capabilities-and-mcp.md'), 'utf8')
  assert.match(pluginDevSkillRaw, /kind:\s*'skill'/)
  assert.match(pluginDevSkillRaw, /kind:\s*'mcp'/)
  assert.match(pluginDevSkillRaw, /kind:\s*'pack'/)
  assert.doesNotMatch(pluginDevSkillRaw, /type:\s*'(?:skill|mcp|pack)'/)

  assert.match(capabilitiesMcpRaw, /kind:\s*'mcp'/)
  assert.match(capabilitiesMcpRaw, /kind:\s*'skill'/)
  assert.match(capabilitiesMcpRaw, /kind:\s*'pack'/)
  assert.doesNotMatch(capabilitiesMcpRaw, /type:\s*'(?:mcp|skill|pack)'/)
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
  assert.deepEqual(items.map((item) => item.name), ['ds-bot-maintenance', 'ds-bot-plugin-dev'])

  assert.doesNotThrow(() => install({ ctx: {} }))
})

test('skill docs name only real team tools, never the old memory tool names', () => {
  for (const skillName of ['ds-bot-maintenance', 'ds-bot-plugin-dev']) {
    for (const filePath of skillFiles(skillName)) {
      const raw = readFileSync(filePath, 'utf8')
      for (const [, token] of raw.matchAll(/`([^`]+)`/g)) {
        assert.ok(!['remember', 'recall', 'forget'].includes(token), `${filePath} still names the renamed tool \`${token}\``)
        if (/^bot_[a-z_]+$/.test(token) || /^(list|read)_[a-z_]+$/.test(token) || token === 'message_bot') {
          assert.ok(TEAM_TOOLS.includes(token), `${filePath} names \`${token}\`, which is not a team tool`)
        }
      }
    }
  }
})
