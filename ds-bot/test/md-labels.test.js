import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mdLabels } from '../src/client/i18n.js'

// DSH's MarkdownText memoizes on `labels` and drops its streaming cache when the
// object changes, so a new object per render re-parses every message.
test('the Markdown labels stay one object between renders', () => {
  assert.equal(mdLabels(), mdLabels())
  assert.deepEqual(mdLabels(), { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' })
})
