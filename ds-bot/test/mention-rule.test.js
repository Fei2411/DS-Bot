import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { mentionSpans, nameProblem, referenceSpans } from '../src/shared/mentions.js'
import { mentionsIn } from '../src/host/groups.js'
import { linkMentions, MENTION_ORIGIN } from '../src/client/text.js'

const bots = [{ id: 'a', name: '新 Bot' }, { id: 'b', name: '新 Bot 2' }, { id: 'c', name: 'Chief' }, { id: 'k', name: 'K' }]

// The user's bubble is drawn by a module that needs the DSH platform; only its pure part runs here.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/user-message.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = { react: { createElement: () => null, Fragment: 'fragment', useState: initial => [initial, () => {}], useEffect: () => {}, useRef: initial => ({ current: initial }), useLayoutEffect: () => {}, useId: () => 'id' }, 'react-dom': {}, '@deepseek-ai/dsh-client-ui-primitives': {} }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { userTextParts, mentionableBots, canDrawUserMessages, contentParts } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))

const called = text => mentionSpans(text, bots).map(span => (span.all ? '@all' : span.bot.name))

test('a name may hold spaces, and the longest name wins', () => {
  assert.deepEqual(called('@新 Bot 提权'), ['新 Bot'])
  assert.deepEqual(called('@新 Bot 2 和 @新 Bot，还有@chief'), ['新 Bot 2', '新 Bot', 'Chief'])
  assert.deepEqual(called('@Kate 不是 K，@K你好'), ['K'])
  assert.deepEqual(called('@everyone @所有人'), ['@all', '@all'])
})

test('addresses, code and links never call', () => {
  assert.deepEqual(called('mail a@K.com'), [])
  assert.deepEqual(called('run `@Chief` now'), [])
  assert.deepEqual(called('```\n@Chief\n```\n@K'), ['K'])
  assert.deepEqual(called('[@Chief](https://example.com) @K'), ['K'])
  assert.deepEqual(called('[read @Chief](https://example.com "docs") @K'), ['K'])
  assert.deepEqual(called("[read @Chief](https://example.com 'docs')"), [])
  assert.deepEqual(called('https://medium.com/@Chief'), [])
})

test('a file or folder reference that starts with a Bot name is not a call', () => {
  assert.deepEqual(called('看 @Chief.md 和 @chief/notes.md、@Chief\\a.txt'), [])
  assert.deepEqual(called('@Chief. @K。@Chief...'), ['Chief', 'K', 'Chief'])
})

test('a referenced conversation\'s "@label" is a reference, once per label', () => {
  assert.deepEqual(plain(referenceSpans('see @K notes and @K', ['K notes'])), [{ start: 4, end: 12, label: 'K notes' }])
  assert.deepEqual(mentionSpans('Read @Chief, then @Chief please', bots, { references: ['Chief'] }).map(span => span.start), [18])
})

test('the group host and the bubbles call the same Bots', () => {
  const texts = ['@新 Bot 提权', '@新 Bot 2 来一下', 'a@K.com @K', '`@Chief` @新 Bot', '@Chief，@K。', '@Chief.md @K', '[see @K](https://x.dev "t") @Chief']
  for (const text of texts) {
    const host = mentionsIn(text, bots).found.map(bot => bot.id)
    const linked = [...linkMentions(text, bots, undefined).matchAll(new RegExp(`\\]\\(${MENTION_ORIGIN}([^)]+)\\)`, 'g'))].map(match => match[1])
    const drawn = userTextParts(text, bots).filter(part => part.bot).map(part => part.bot.id)
    assert.deepEqual(linked, host, text)
    assert.deepEqual(plain(drawn), host, text)
  }
})

test('the user bubble keeps the text around a mention, and a group only calls its members', () => {
  assert.deepEqual(plain(userTextParts('@新 Bot 提权', bots)), [{ bot: bots[0], label: '新 Bot' }, { text: ' 提权' }])
  assert.deepEqual(plain(userTextParts('看 @a/b.md', bots)), [{ text: '看 @a/b.md' }])
  assert.deepEqual(plain(userTextParts('打开 @K.md', bots)), [{ text: '打开 @K.md' }])
  // Text blocks join as the group host joins them, so "@新" + " Bot" is not "@新 Bot".
  const { text } = contentParts([{ type: 'text', text: 'hi @新' }, { type: 'text', text: ' Bot' }])
  assert.equal(text, 'hi @新\n Bot')
  assert.deepEqual(plain(userTextParts(text, bots).filter(part => part.bot)), [])
  const roster = { bots, byId: Object.fromEntries(bots.map(bot => [bot.id, bot])), roomsById: { r: { members: ['c', 'k'] } } }
  assert.deepEqual(plain(mentionableBots(roster, 'r').map(bot => bot.id)), ['c', 'k'])
  assert.equal(mentionableBots(roster, 'a').length, 4)
  assert.equal(mentionableBots(roster, 'elsewhere').length, 0)
  // Without DSH's text projection the plugin leaves the bubble to DSH.
  assert.equal(canDrawUserMessages(), false)
})

test('a Bot name is something "@" can call without a second reading', () => {
  assert.equal(nameProblem('新 Bot'), undefined)
  assert.equal(nameProblem('  '), 'A Bot needs a name')
  for (const name of ['a@b', 'x`y', 'two\nlines']) assert.equal(nameProblem(name), 'A Bot name cannot contain @, ` or a line break')
  assert.match(nameProblem('All'), /calls everyone in a group/)
})
