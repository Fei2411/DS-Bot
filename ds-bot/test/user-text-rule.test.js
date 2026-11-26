import assert from 'node:assert/strict'
import { test } from 'node:test'
import { botMentionRule, installBotMentionRule } from '../src/client/user-text-rule.js'

const bots = [{ id: 'g', name: 'BetterNotch GM' }, { id: 'n', name: 'BetterNotch' }, { id: 'd', name: 'Docs' }, { id: 'c', name: 'Chief' }]
const read = (facts = {}) => ({ read: key => facts[key] })
const rule = botMentionRule(bots)
const match = (text, from = 0, facts) => rule.match(text, from, read(facts))

// DSH's own file reference rule at 0.2.2-rc.1 (dsh-client-ui-reference): an "@" token
// ends at the first whitespace. It is the rule that cut "@BetterNotch GM" in two.
const fileRule = {
  id: 'file',
  order: 30,
  match(text, from) {
    const tokens = /(?<!\S)(@"[^"\n]+"|@[^\s]+)/gu
    tokens.lastIndex = from
    const found = tokens.exec(text)
    if (found === null) return undefined
    const raw = found[0].replace(/[.,;:!?，。；：！？]+$/u, '')
    return { id: 'file', start: found.index, end: found.index + raw.length, data: { path: raw.slice(1), label: raw.slice(1) } }
  },
}

// The nearest candidate wins and a tie goes to the lower order, as DSH reconciles a document.
function nodesOf(text, rules) {
  const sorted = [...rules].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const nodes = []
  let cursor = 0
  for (;;) {
    let winner
    for (const item of sorted) {
      const node = item.match(text, cursor, read())
      if (node !== undefined && (winner === undefined || node.start < winner.start)) winner = node
    }
    if (winner === undefined) break
    if (cursor < winner.start) nodes.push({ id: 'text', text: text.slice(cursor, winner.start) })
    nodes.push({ id: winner.id, text: text.slice(winner.start, winner.end), data: winner.data })
    cursor = winner.end
  }
  if (cursor < text.length) nodes.push({ id: 'text', text: text.slice(cursor) })
  return nodes
}

test('a Bot name with a space is one mention, not a file cut at the space', () => {
  const text = '@BetterNotch GM 你好'
  assert.deepEqual(match(text), { id: 'bot-mention', start: 0, end: 15, data: { botId: 'g', label: 'BetterNotch GM' } })
  // Beside DSH's file rule the whole name still goes to the Bot; without ours the file rule cuts it.
  assert.deepEqual(nodesOf(text, [fileRule, rule]).map(node => [node.id, node.text]), [['bot-mention', '@BetterNotch GM'], ['text', ' 你好']])
  assert.deepEqual(nodesOf(text, [fileRule]).map(node => [node.id, node.text]), [['file', '@BetterNotch'], ['text', ' GM 你好']])
})

test('the shorter name still answers when the longer one is not written out', () => {
  assert.equal(match('@BetterNotch 你好').data.botId, 'n')
  assert.equal(match('@BetterNotch GMs').data.botId, 'n')
})

test('the next mention at or after the start is found, with its label as typed', () => {
  const text = '问 @chief 再问 @BetterNotch GM'
  assert.deepEqual(match(text), { id: 'bot-mention', start: 2, end: 8, data: { botId: 'c', label: 'chief' } })
  assert.deepEqual(match(text, 3), { id: 'bot-mention', start: 12, end: 27, data: { botId: 'g', label: 'BetterNotch GM' } })
  assert.equal(match(text, 13), undefined)
})

test('files, folders, addresses, code and links are not mentions', () => {
  assert.equal(match('看 @Docs/guide.md'), undefined)
  assert.equal(match('看 @Docs.md'), undefined)
  assert.equal(match('mail me@Chief.dev'), undefined)
  assert.equal(match('run `@Chief` now'), undefined)
  assert.equal(match('see [@Chief](https://example.com)'), undefined)
})

test('a referenced conversation named like a Bot stays a reference', () => {
  assert.equal(match('看 @Chief 的记录', 0, { sessionLabels: ['Chief'] }), undefined)
  assert.equal(match('看 @Chief 的记录').data.botId, 'c')
})

test('@all and a team with no Bots draw nothing here', () => {
  assert.equal(match('@all 开会'), undefined)
  assert.equal(botMentionRule([]).match('@Chief hi', 0, read()), undefined)
})

test('the rule goes ahead of DSH\'s file, session and skill rules', () => {
  // DSH's session rule is 10 and its file and folder rules are 30; a lower order wins a tie.
  assert.ok(rule.order < 10)
  assert.equal(rule.id, 'bot-mention')
})

test('the rule follows the roster: a new Bot name is matched, and the old rule is withdrawn', () => {
  let roster = { bots }
  const listeners = new Set()
  const registered = []
  const userText = { register: (item) => { registered.push(item); return () => { registered.splice(registered.indexOf(item), 1) } } }
  const store = { getSnapshot: () => roster, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } }
  const off = installBotMentionRule(userText, store)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].match('@新 Bot', 0, read()), undefined)
  roster = { bots: [...bots, { id: 'x', name: '新 Bot' }] }
  for (const listener of listeners) listener()
  assert.equal(registered.length, 1)
  assert.equal(registered[0].match('@新 Bot', 0, read()).data.botId, 'x')
  // Nothing changed in the names: the registry is not touched, so no document is parsed again.
  const before = registered[0]
  roster = { bots: [...roster.bots] }
  for (const listener of listeners) listener()
  assert.equal(registered[0], before)
  off()
  assert.equal(registered.length, 0)
  assert.equal(listeners.size, 0)
})
