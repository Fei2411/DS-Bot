import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MOCK = fileURLToPath(new URL('../dev/mock-llm.mjs', import.meta.url))

// One Anthropic-shaped request, its SSE reply folded into { text, tools }.
async function call(url, messages, names = ['list_bots']) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', stream: true, tools: names.map(name => ({ name })), messages }),
  })
  assert.equal(res.status, 200)
  const events = (await res.text()).split('\n\n')
    .map(chunk => /^data: (.+)$/m.exec(chunk)?.[1]).filter(Boolean).map(line => JSON.parse(line))
  let text = ''
  const tools = []
  for (const event of events) {
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') tools.push({ id: event.content_block.id, name: event.content_block.name })
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') text += event.delta.text
  }
  return { text, tools }
}

// Append the reply and its tool results, as the next model request would carry them.
function fold(messages, out) {
  messages.push(
    { role: 'assistant', content: [...(out.text ? [{ type: 'text', text: out.text }] : []), ...out.tools.map(used => ({ type: 'tool_use', id: used.id, name: used.name, input: {} }))] },
    { role: 'user', content: out.tools.map(used => ({ type: 'tool_result', tool_use_id: used.id, content: '[]' })) },
  )
}

async function startMock(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-mock-'))
  const mock = spawn(process.execPath, [MOCK], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: join(home, 'mock.jsonl'), MOCK_DELAY_MS: '5', MOCK_JITTER_MS: '0' },
  })
  t.after(() => { mock.kill(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  // MOCK_PORT=0 lets the kernel pick a free port; the mock prints the real one.
  return new Promise((resolve, reject) => {
    mock.stdout.on('data', chunk => {
      const found = /127\.0\.0\.1:(\d+)\/v1/.exec(String(chunk))
      if (found !== null) resolve(`http://127.0.0.1:${found[1]}/v1/messages`)
    })
    mock.once('exit', code => reject(new Error(`mock-llm exited ${code}`)))
  })
}

// "长任务 N [K]" adds about K×1000 characters per step, defaulting to 4. A missing K once
// parsed as NaN, so every step after the opener silently sent no text block.
test('长任务 writes text on every step when the step size is left out', async (t) => {
  const url = await startMock(t)

  const messages = [{ role: 'user', content: '长任务 3' }]
  let out = await call(url, messages)
  assert.equal(out.text.length, 4000) // 步骤0
  fold(messages, out)

  out = await call(url, messages)
  assert.equal(out.text.length, 4000) // a tool result continues the task
  fold(messages, out)

  // A spliced Bot message mid-task hits the other parse of the same command, and its
  // note comes before the step's text.
  messages.push({ role: 'user', content: '[Message from HelperBot] 进度如何？' })
  out = await call(url, messages)
  const ack = '（已按 HelperBot 的话调整）\n'
  assert.ok(out.text.startsWith(ack), out.text.slice(0, 40))
  assert.equal(out.text.length - ack.length, 4000)
  fold(messages, out)

  out = await call(url, messages)
  assert.match(out.text, /长任务做完了，一共 3 步。/)
})

// A Bot hands work on when a Bot message says 转告, and answers 慢慢做 N after N seconds,
// so the bench can watch a Bot wait for work it handed on.
test('a Bot message hands work on with 转告 and takes its time with 慢慢做', async (t) => {
  const url = await startMock(t)
  const tools = ['list_bots', 'message_bot']
  const handed = await call(url, [{ role: 'user', content: '[Message from Chief]\n转告 Coder: 慢慢做 1' }], tools)
  assert.deepEqual(handed.tools.map(used => used.name), ['message_bot'])
  const started = Date.now()
  const slow = await call(url, [{ role: 'user', content: '[Message from Writer]\n慢慢做 1' }], tools)
  assert.ok(Date.now() - started >= 1000)
  assert.equal(slow.text, '给 Writer 的回复：做完了，用了 1 秒。')
  const back = await call(url, [{ role: 'user', content: '[Reply from Coder · for the work Chief asked you for; your answer goes to Chief once everything you handed on is back]\n做完了' }], tools)
  assert.deepEqual([back.text, back.tools], ['Coder 交回了，我把结果交给 Chief。', []])
})
