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
    if (message.type === 'control_response') {
      const res = message.response?.response
      const textOut = `perm:${JSON.stringify(res)}`
      send({ type: 'assistant', message: { content: [{ type: 'text', text: textOut }] } })
      send({ type: 'result', subtype: 'success', session_id: sessionId, result: textOut, usage: { input_tokens: 10, output_tokens: 5 } })
      continue
    }
    if (message.type !== 'user') continue
    const blocks = message.message?.content ?? []
    if (!Array.isArray(blocks) || blocks.length === 0) {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'empty user message content' })
      continue
    }
    if (blocks.length > 1 && blocks.some(block => block.type === 'text' && block.text === '')) {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'text content blocks must be non-empty' })
      continue
    }
    const badImage = blocks.find(block => block.type === 'image' && (block.source?.type !== 'base64' || typeof block.source?.media_type !== 'string' || typeof block.source?.data !== 'string' || block.source.data.startsWith('data:')))
    if (badImage !== undefined) {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'invalid anthropic image block' })
      continue
    }
    const images = blocks.filter(block => block.type === 'image').map(block => ({ mediaType: block.source.media_type, data: block.source.data }))
    const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    if (text.includes('ask-claude-perm')) {
      send({ type: 'control_request', request_id: 'cr-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/test' } } })
      continue
    }
    const suffix = images.length > 0 ? ` images=${JSON.stringify(images)}` : ''
    send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: `thought about: ${text.slice(0, 40)}` }, { type: 'tool_use', name: 'Read' }, { type: 'text', text: `ok: ${text.slice(0, 60)}${suffix}` }] } })
    send({ type: 'result', subtype: 'success', session_id: sessionId, result: `ok: ${text.slice(0, 60)}${suffix}`, usage: { input_tokens: 10, output_tokens: 5 } })
  }
})
