import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileCandidates } from '../src/host/file-refs.js'

test('a path in inline code is a file the reply points at', () => {
  const found = fileCandidates('الملف الجاهز: `pdf-edit2/التقرير.pdf` — تحت إشراف')
  assert.deepEqual(found, [{ kind: 'path', value: 'pdf-edit2/التقرير.pdf', name: 'التقرير.pdf' }])
})

test('a path with spaces, brackets and Arabic in a code block is found', () => {
  const path = '/home/mahmoud/DS Bot/pdf-edit/(معدل) - تحت [إشراف] النظام الغذائي العلاجي .pdf'
  const found = fileCandidates(`الملف قدامك 👇 وده المسار المباشر:\n\`\`\`\n${path}\n\`\`\``)
  assert.deepEqual(found, [{ kind: 'path', value: path, name: '(معدل) - تحت [إشراف] النظام الغذائي العلاجي .pdf' }])
})

test('a markdown link to a local file drops sandbox: and names the real file', () => {
  const found = fileCandidates('اتفضل [التقرير النهائي](sandbox:/work/out/report.pdf)')
  assert.deepEqual(found, [{ kind: 'path', value: '/work/out/report.pdf', name: 'report.pdf' }])
})

test('a web link that names a file becomes a downloadable reference', () => {
  const found = fileCandidates('شوف [brochure-A4.pdf](https://example.com/files/brochure-A4.pdf?x=1)')
  assert.deepEqual(found, [{ kind: 'url', value: 'https://example.com/files/brochure-A4.pdf?x=1', name: 'brochure-A4.pdf' }])
})

test('plain prose and code that is not a file are left alone', () => {
  assert.deepEqual(fileCandidates('استخدم `npm test` ثم اقرأ docs/guide.md لاحقًا'), [])
  assert.deepEqual(fileCandidates('المسار `src/host/mobile.js` مذكور هنا'), [{ kind: 'path', value: 'src/host/mobile.js', name: 'mobile.js' }])
  assert.deepEqual(fileCandidates('حمل من [هنا](https://example.com/page)'), [])
  assert.deepEqual(fileCandidates(''), [])
})
