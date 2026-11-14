import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lexer, type Token } from 'marked'
import { inlineImage, softBreakText } from './markdown-rules.ts'

// The phone's Markdown draws a text token inside React Native <Text>, which turns every
// "\n" into a drawn line break; a browser collapses a soft break to a space. marked
// keeps the single newline in the token, as in the reply that showed "… 2,438" and then
// "open" on its own line.
test('a soft break inside a text token becomes a space', () => {
  assert.equal(softBreakText('Out 15 May, back 23 May — MYR 2,185 · nonstop MYR 2,438\n'), 'Out 15 May, back 23 May — MYR 2,185 · nonstop MYR 2,438 ')
  assert.equal(softBreakText('first\r\nsecond'), 'first second')
  assert.equal(softBreakText('no break'), 'no break')
})

test('only an absolute https image can load on the phone; the rest keep their alt text', () => {
  assert.deepEqual(inlineImage('https://cdn.example.test/a.png', 'Tokyo page'), {
    kind: 'image', src: 'https://cdn.example.test/a.png', alt: 'Tokyo page',
  })
  // A workspace-relative path has no file service behind it on the phone.
  assert.deepEqual(inlineImage('assets/screenshots/tokyo.png', 'Tokyo page'), { kind: 'alt', text: 'Tokyo page' })
  // http is blocked as cleartext on Android; other schemes are not images.
  assert.deepEqual(inlineImage('http://cdn.example.test/a.png', 'Tokyo page'), { kind: 'alt', text: 'Tokyo page' })
  assert.deepEqual(inlineImage('javascript:alert(1)', 'Tokyo page'), { kind: 'alt', text: 'Tokyo page' })
  assert.deepEqual(inlineImage('https://cdn.example.test/a.png', ''), { kind: 'image', src: 'https://cdn.example.test/a.png', alt: 'image' })
  assert.deepEqual(inlineImage(undefined, undefined), { kind: 'alt', text: 'image' })
})

// The renderer walks marked's tokens, so the exact shape marked produces for the
// reported reply is what the test keeps: a text token ending in the source newline
// followed by a link token. The phone must not draw that newline as a line break.
const textOfToken = (token: Token): string => String((token as { text?: unknown }).text ?? '')

function textTokens(tokens: Token[], found: Token[] = []): Token[] {
  for (const token of tokens) {
    const inner = (token as { tokens?: Token[] }).tokens
    if (token.type === 'text' && !Array.isArray(inner)) found.push(token)
    if (Array.isArray(inner)) textTokens(inner, found)
    if (token.type === 'list') for (const item of (token as { items?: { tokens?: Token[] }[] }).items ?? []) textTokens(item.tokens ?? [], found)
  }
  return found
}

test('the reported list item lexes as a text token with a soft break, then a link', () => {
  const tokens = lexer('- Out 15 May, back 23 May — MYR 2,185 · nonstop MYR 2,438\n[open](https://example.test/fare)')
  const soft = textTokens(tokens).find(token => textOfToken(token).includes('\n'))
  assert.ok(soft, 'marked kept the soft break inside a text token')
  assert.equal(softBreakText(textOfToken(soft)).includes('\n'), false)
  assert.equal(softBreakText(textOfToken(soft)).endsWith('2,438 '), true)
})

test('the reported Markdown image lexes as an image token, which inlineImage can load', () => {
  const tokens = lexer('![Tokyo page](https://cdn.example.test/tokyo.png)')
  const image = (tokens[0] as { tokens?: Token[] }).tokens?.find(token => token.type === 'image')
  assert.ok(image, 'marked produced an image token')
  assert.deepEqual(inlineImage((image as { href?: string }).href, (image as { text?: string }).text), {
    kind: 'image', src: 'https://cdn.example.test/tokyo.png', alt: 'Tokyo page',
  })
})
