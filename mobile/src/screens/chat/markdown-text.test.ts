import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRemoteImageUrl, softBreakText, webFileLinks } from './markdown-text.ts'

test('a soft break inside a paragraph is a space', () => {
  assert.equal(softBreakText('one\ntwo'), 'one two')
  assert.equal(softBreakText('one\r\ntwo'), 'one two')
  assert.equal(softBreakText('no break'), 'no break')
})

test('web links that name a file become file cards', () => {
  assert.deepEqual(webFileLinks('اتفضل [brochure-A4.pdf](https://example.com/a/brochure-A4.pdf?x=1)'), [
    { name: 'brochure-A4.pdf', url: 'https://example.com/a/brochure-A4.pdf?x=1' },
  ])
  assert.deepEqual(webFileLinks('[حمّل التقرير](https://example.com/files/report.pdf)'), [
    { name: 'report.pdf', url: 'https://example.com/files/report.pdf' },
  ])
  assert.deepEqual(webFileLinks('[صفحة](https://example.com/page)'), [])
  assert.deepEqual(webFileLinks('[رابط محلي](sandbox:/work/report.pdf)'), [])
  assert.deepEqual(webFileLinks('```\n[مثال](https://example.com/a.pdf)\n```'), [])
})

test('only web images are fetched', () => {
  assert.equal(isRemoteImageUrl('https://example.com/a.png'), true)
  assert.equal(isRemoteImageUrl('http://example.com/a.png'), true)
  assert.equal(isRemoteImageUrl('data:image/png;base64,xx'), false)
  assert.equal(isRemoteImageUrl('file:///tmp/a.png'), false)
  assert.equal(isRemoteImageUrl(undefined), false)
})
