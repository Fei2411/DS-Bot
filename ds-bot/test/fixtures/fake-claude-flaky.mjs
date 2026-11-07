// A fake Claude Code whose run count lives in a file: the runs listed in its
// second argument die before `system/init`, like a CLI whose sign-in failed.
// Every other run behaves like 2.1.302: init after the first message, and it
// echoes the `--resume` id it was given so a resumed session is visible.
import { readFileSync, writeFileSync } from 'node:fs'

const [stateFile, failOn = ''] = process.argv.slice(2, 4)
let run = 0
try { run = Number(readFileSync(stateFile, 'utf8')) } catch {}
run += 1
writeFileSync(stateFile, String(run))
if (failOn.split(',').includes(String(run))) process.exit(1)

const resumeAt = process.argv.indexOf('--resume')
const resumed = resumeAt === -1 ? 'none' : process.argv[resumeAt + 1]
const sessionId = resumed === 'none' ? `claude-${Math.random().toString(36).slice(2)}` : resumed
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

let inited = false
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
    if (message.type !== 'user') continue
    if (!inited) {
      inited = true
      send({ type: 'system', subtype: 'init', session_id: sessionId })
    }
    const text = (message.message?.content ?? []).map(block => block.text ?? '').join('\n')
    send({ type: 'assistant', message: { content: [{ type: 'text', text: `ok: ${text.slice(0, 60)} resume=${resumed}` }] } })
    send({ type: 'result', subtype: 'success', session_id: sessionId, result: 'ok', usage: { input_tokens: 3, output_tokens: 1 } })
  }
})
