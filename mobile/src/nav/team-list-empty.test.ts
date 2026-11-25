import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang } from '../ui/i18n.ts'
import { teamListEmptyMessage } from './team-list-empty.ts'

test('the team list shows a localized message only for a search with no matches', () => {
  try {
    setLang('en')
    assert.equal(teamListEmptyMessage(true, 'unknown', 0), 'No results')
    assert.equal(teamListEmptyMessage(true, 'main', 1), null)
    assert.equal(teamListEmptyMessage(true, '', 0), null)
    assert.equal(teamListEmptyMessage(false, 'unknown', 0), 'Connecting…')

    setLang('zh')
    assert.equal(teamListEmptyMessage(true, 'unknown', 0), '没有结果')
  } finally {
    setLang('system')
  }
})
