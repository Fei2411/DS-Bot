import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanPreview, handoffTitleOf, roundEventText, settledQuestionPicks, stripLongNote } from '../screens/chat/settled.ts'
import { setLang, weekdayShort } from '../ui/i18n.ts'
import { workPhrase } from '../ui/phrases.ts'

test('settledQuestionPicks preserves option letters and custom slot from host answer item', () => {
  // Exact shape emitted by ds-bot/src/host/parts.js displayItems for kind: 'answer' (ask_user)
  const answerItem = {
    kind: 'answer' as const,
    at: 1794466440000,
    questions: [{
      id: 'q1',
      question: '从哪里开始?',
      options: [
        { label: '读 AGENTS.md, 公开仓 AGENTS.md, CONTRIBUTING.md' },
        { label: '先看线上 CI 状态' },
        { label: '直接检查发版脚本' },
      ],
      multiSelect: false,
    }],
    answers: [{ id: 'q1', selected: ['先看线上 CI 状态'], custom: '顺便看 release.yml' }],
  }
  const picks = settledQuestionPicks(answerItem.questions[0], answerItem.answers[0])
  assert.deepEqual(picks, [
    { label: '先看线上 CI 状态', letter: 'B' },
    { label: '顺便看 release.yml', letter: 'D' },
  ])
})

test('handoffTitleOf decodes host browser_handoff answer reasons in both languages', () => {
  // Exact shape emitted by ds-bot/src/host/parts.js readReply for answer_to_pending_handoff
  const handoff = { callId: 'call_1', reason: 'verification', note: '', outcome: 'done' as const }
  setLang('zh')
  assert.equal(handoffTitleOf(handoff.reason), '需要验证')
  assert.equal(handoffTitleOf('confirmation'), '需要确认')
  assert.equal(handoffTitleOf('other'), '请接手浏览器')
  setLang('en')
  assert.equal(handoffTitleOf(handoff.reason), 'Verification needed')
  assert.equal(handoffTitleOf('confirmation'), 'Confirmation needed')
  assert.equal(handoffTitleOf('other'), 'Your turn in the browser')
  setLang('system')
})

test('workPhrase and weekdayShort localize tool activity and schedule weekdays', () => {
  setLang('zh')
  assert.equal(workPhrase({ tool: 'run_shell_command', target: 'npm test' }), '运行命令 · npm test')
  assert.equal(weekdayShort(1), '一')
  assert.equal(weekdayShort(7), '日')

  setLang('en')
  assert.equal(workPhrase({ tool: 'run_shell_command', target: 'npm test' }), 'Running shell commands · npm test')
  assert.equal(weekdayShort(1), 'Mon')
  assert.equal(weekdayShort(7), 'Sun')
  setLang('system')
})

test('stripLongNote removes the host attachLong header and roundEventText formats group relay rows', () => {
  const raw = '[A long message: 24810 characters. The full text is attached in message.txt.]\n第一段正文'
  assert.equal(stripLongNote(raw), '第一段正文')
  setLang('zh')
  assert.equal(roundEventText('Beacon', 'done'), 'Beacon 做完了')
  assert.equal(roundEventText('Beacon', 'stopped'), '你停下了 Beacon 的工作')
  assert.equal(cleanPreview('[Browser handoff] verification — 完成 GitHub 两步验证\nAnswer: done'), '需要验证 · 完成 GitHub 两步验证')
  assert.equal(cleanPreview('[Answer to question card] 从哪里开始?\nAnswer: 读 AGENTS.md'), '读 AGENTS.md')
  setLang('system')
})
