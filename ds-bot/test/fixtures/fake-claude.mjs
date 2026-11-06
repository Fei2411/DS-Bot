// A fake Claude Code for tests: stream-json both ways. Prints the init system
// line, then answers each user message with thinking + text + result events.
const sessionId = `claude-${Math.random().toString(36).slice(2)}`
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

send({ type: 'system', subtype: 'init', session_id: sessionId })

let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  rest += chunk
  let at
  while ((at = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, at).trim()
    rest = rest.slice(at + 1)
    if (line === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
      send({ type: 'result', subtype: 'success', session_id: sessionId, result: 'interrupted', usage: { input_tokens: 1, output_tokens: 1 } })
      continue
    }
    if (message.type !== 'user') continue
    const text = (message.message?.content ?? []).map(block => block.text ?? '').join('\n')
    send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: `thought about: ${text.slice(0, 40)}` }, { type: 'tool_use', name: 'Read' }, { type: 'text', text: `ok: ${text.slice(0, 60)}` }] } })
    send({ type: 'result', subtype: 'success', session_id: sessionId, result: `ok: ${text.slice(0, 60)}`, usage: { input_tokens: 10, output_tokens: 5 } })
  }
})
