// Tests for the ds-bot Office skill provider (src/host/office-skills.js).
import { existsSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert'
import { officeProvider, officeNode, cliPath } from '../src/host/office-skills.js'

describe('office skill provider', () => {
  test('lists office and office-tools with bundled metadata', async () => {
    const provider = officeProvider()
    const list = await provider.list()
    assert.deepEqual(list.map(s => s.name), ['office', 'office-tools'])
    for (const skill of list) {
      assert.equal(skill.provider, 'ds-bot-office')
      assert.equal(skill.source, 'bundled')
      assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
      assert.equal(skill.resourceBase.kind, 'directory')
      assert.ok(existsSync(skill.locator))
      assert.ok(skill.description.length > 0)
    }
    assert.equal(list[0].rank, 550)
    assert.equal(list[1].rank, 600)
  })

  test('office beats a rank-600 office from another provider in the same registry', async () => {
    // A registry shaped like the real one: lowest rank wins within a source layer.
    const fakeDsh = {
      name: 'dsh-office',
      list: () => Promise.resolve([{ name: 'office', provider: 'dsh-office', rank: 600 }]),
    }
    const providers = [officeProvider(), fakeDsh]
    const all = (await Promise.all(providers.map(p => p.list()))).flat()
    const offices = all.filter(s => s.name === 'office').sort((a, b) => a.rank - b.rank)
    assert.equal(offices[0].provider, 'ds-bot-office')
  })

  test('office-tools content carries the runtime block', async () => {
    const provider = officeProvider()
    const [candidate] = (await provider.list()).filter(s => s.name === 'office-tools')
    const skill = await provider.get(candidate)
    assert.match(skill.content, /officeTools/)
    assert.match(skill.content, /PowerShell/)
  })

  test('office skill routes to office-tools and mentions availability', async () => {
    const provider = officeProvider()
    const [candidate] = (await provider.list()).filter(s => s.name === 'office')
    const skill = await provider.get(candidate)
    assert.match(skill.content, /`office-tools`/)
    assert.match(skill.content, /unavailable/)
  })
})

describe('office node selection', () => {
  test('uses DS_BOT_OFFICE_NODE when the file exists', () => {
    const { node } = officeNode({ DS_BOT_OFFICE_NODE: process.execPath })
    assert.equal(node, process.execPath)
  })
  test('ignores DS_BOT_OFFICE_NODE that does not exist', () => {
    const { node } = officeNode({ DS_BOT_OFFICE_NODE: '/no/such/node-here' })
    // In the test harness the host is plain Node, so execPath applies.
    assert.equal(node, process.execPath)
  })
  test('falls back to the host interpreter under plain Node', () => {
    const { node } = officeNode({})
    assert.equal(node, process.execPath)
  })
})

describe('cli path mapping', () => {
  test('maps app.asar to app.asar.unpacked', () => {
    const inAsar = `D:${sep}app${sep}resources${sep}app.asar${sep}node_modules${sep}ds-bot${sep}office.js`
    assert.equal(cliPath(inAsar), `D:${sep}app${sep}resources${sep}app.asar.unpacked${sep}node_modules${sep}ds-bot${sep}office.js`)
  })
  test('leaves unpackaged paths alone', () => {
    const plain = `D:${sep}repo${sep}ds-bot${sep}office.js`
    assert.equal(cliPath(plain), plain)
  })
})
