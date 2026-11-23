import assert from 'node:assert/strict'
import test from 'node:test'

import { AcpEngine } from '../src/host/local-agents/acp.js'

test('drops session/load replay chunks while idle and forwards live chunks', async () => {
  const engine = new AcpEngine('local-acp-fake', {}, {})
  const session = engine.sessionFor('session-test')
  session.acpSessionId = 'acp-resumed-1'

  for (const update of [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE REPLAY TEXT' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'STALE THOUGHT' } },
    { sessionUpdate: 'tool_call', toolCallId: 'old-1', title: 'Old tool' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'old-1', status: 'failed' },
    { sessionUpdate: 'plan', entries: [{ content: 'STALE PLAN', status: 'pending' }] },
  ]) {
    engine.onNotice('session/update', { sessionId: session.acpSessionId, update })
  }
  engine.onNotice('session/update', {
    sessionId: session.acpSessionId,
    update: { sessionUpdate: 'usage_update', used: 12000, size: 200000 },
  })
  engine.onNotice('session/update', {
    sessionId: session.acpSessionId,
    update: { sessionUpdate: 'compaction_update', status: 'completed' },
  })
  assert.equal(session.toolCalls.size, 0)

  session.running = true
  engine.onNotice('session/update', {
    sessionId: session.acpSessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FRESH ANSWER' } },
  })
  session.running = false
  session.push({ type: 'done', reason: 'end_turn' })

  const events = []
  while (true) {
    const event = await session.next()
    events.push(event)
    if (event.type === 'done') break
  }
  assert.deepEqual(events, [
    { type: 'context', used: 12000, size: 200000 },
    { type: 'compaction', status: 'completed' },
    { type: 'text', text: 'FRESH ANSWER' },
    { type: 'done', reason: 'end_turn' },
  ])
})
