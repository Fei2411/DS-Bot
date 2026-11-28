import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { previewFormat, readFilePreview, type FileRef } from './file-preview.ts'

function preview(file: FileRef, data: string | Uint8Array, requests: object[] = []) {
  const bytes = typeof data === 'string' ? strToU8(data) : data
  return readFilePreview(async (endpoint, payload) => {
    assert.equal(endpoint, 'file-download')
    requests.push(payload)
    const { offset } = payload as { offset: number }
    const nextOffset = offset === 0 && bytes.length > 4 ? 4 : bytes.length
    return { bytes: Buffer.from(bytes.subarray(offset, nextOffset)).toString('base64'), nextOffset, size: bytes.length, version: 'v1', done: nextOffset === bytes.length }
  }, file, 'current-part', new AbortController().signal)
}

test('Markdown previews use exact presented-file coordinates and render heading, lists and code', async () => {
  const requests: object[] = []
  const result = await preview({ name: 'Notes.MD', sessionId: 'earlier-part', seq: 42, index: 2 }, '# 标题\n\n- **Readable**\n- `code`', requests)
  assert.deepEqual(requests, [
    { sessionId: 'earlier-part', seq: 42, index: 2, offset: 0 },
    { sessionId: 'earlier-part', seq: 42, index: 2, offset: 4, version: 'v1' },
  ])
  assert.equal(result.kind, 'html')
  assert.match(result.content, /<h1>标题<\/h1>/)
  assert.match(result.content, /<li><strong>Readable<\/strong><\/li>/)
  assert.match(result.content, /<li><code>code<\/code><\/li>/)
})

test('HTML preview keeps readable content but removes document styling, actions and external resources', async () => {
  const result = await preview({ name: 'Report.html', seq: 1 }, `<html><head><title>Hidden</title><meta http-equiv="refresh" content="0;url=https://example.com"></head>
    <body><h1 onclick="alert(1)">Schedule</h1><style>@import "https://example.com";</style>
    <p style="display:none">A &amp; B <a href="https://example.com">Reference</a><img src="https://example.com" alt=" (diagram)"></p>
    <script>bad()</script><iframe src="https://example.com"></iframe><svg><a href="https://example.com">SVG</a></svg></body></html>`)
  assert.equal(result.kind, 'html')
  assert.match(result.content, /<h1>Schedule<\/h1>/)
  assert.match(result.content, /<p>A &amp; B Reference \(diagram\)<\/p>/)
  assert.doesNotMatch(result.content, /Hidden|example\.com|style|onclick|bad\(\)|SVG/)
})

test('text previews honor UTF-16 LE and BE byte order marks', async () => {
  const le = Uint8Array.from([0xff, 0xfe, 0x2d, 0x4e, 0x3d, 0xd8, 0x00, 0xde])
  const be = Uint8Array.from([0xfe, 0xff, 0x4e, 0x2d, 0xd8, 0x3d, 0xde, 0x00])
  for (const bytes of [le, be]) {
    assert.deepEqual(await preview({ name: 'Notes.txt', seq: 1 }, bytes), { kind: 'text', content: '中😀' })
  }
})

test('HTML previews decode declared Windows-1252 and Latin-1 but prefer a UTF-8 BOM', async () => {
  for (const charset of ['windows-1252', 'ISO-8859-1']) {
    const html = `<meta charset="${charset}"><p>\x93Caf\xe9\x94 \x80</p>`
    const bytes = Uint8Array.from(html, char => char.charCodeAt(0))
    assert.deepEqual(await preview({ name: 'Notes.html', seq: 1 }, bytes), { kind: 'html', content: '<p>“Café” €</p>' })
  }
  const html = '\uFEFF<meta charset="windows-1252"><p>Café</p>'
  assert.deepEqual(await preview({ name: 'Notes.html', seq: 1 }, html), { kind: 'html', content: '<p>Café</p>' })
})

test('DOCX reads body headings, line breaks and tables without loading relationships', async () => {
  const doc = `<?xml version="1.0" encoding="UTF-8"?><x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body>
    <x:p><x:pPr><x:pStyle x:val="Heading1"/></x:pPr><x:r><x:t>Field &amp; office notes</x:t></x:r></x:p>
    <x:p><x:r><x:t>First</x:t><x:br/><x:t>Second</x:t></x:r></x:p>
    <x:tbl><x:tr><x:tc><x:p><x:r><x:t>Table cell</x:t></x:r></x:p></x:tc></x:tr></x:tbl>
    </x:body></x:document>`
  const bytes = zipSync({ 'word/document.xml': strToU8(doc), 'word/_rels/document.xml.rels': strToU8('https://example.com') })
  const result = await preview({ name: 'Notes.docx', seq: 1 }, bytes)
  assert.deepEqual(result, { kind: 'html', content: '<h1>Field &amp; office notes</h1><p>First<br>Second</p><table><tbody><tr><td><p>Table cell</p></td></tr></tbody></table>' })
})

test('plain text stays literal and unsupported formats remain share-only', async () => {
  const requests: object[] = []
  assert.deepEqual(await preview({ name: 'Notes.txt', attachmentId: 'file-id' }, '\uFEFF<script>plain text</script>', requests),
    { kind: 'text', content: '<script>plain text</script>' })
  assert.deepEqual(requests[0], { sessionId: 'current-part', attachmentId: 'file-id', offset: 0 })
  assert.equal(previewFormat('Legacy.doc'), undefined)
  assert.equal(previewFormat('md'), undefined)
})

test('previews refuse invalid and oversized documents', async () => {
  await assert.rejects(preview({ name: 'invalid.docx' }, 'not a ZIP'), /cannot be read/)
  await assert.rejects(preview({ name: 'large.docx' }, zipSync({ 'word/document.xml': new Uint8Array(2 * 1024 * 1024 + 1) })), /too large/)
  const requests: object[] = []
  await assert.rejects(preview({ name: 'large.html' }, new Uint8Array(2 * 1024 * 1024 + 1), requests), /too large/)
  assert.equal(requests.length, 1)
})
