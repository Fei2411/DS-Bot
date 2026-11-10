// A fake Claude Code whose run count lives in a file: the runs listed in its
// second argument die before `system/init`, like a CLI whose sign-in failed.
// Every other run behaves like 2.1.302: init after the first message, and it
// echoes the `--resume` id it was given so a resumed session is visible.
// Ids in the third argument are conversations the CLI no longer has: resuming
// one fails the way 2.1.317 does (stderr line, an error result, exit 1).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const [stateFile, failOn = '', gone = ''] = process.argv.slice(2, 5)
let run = 0
try { run = Number(readFileSync(stateFile, 'utf8')) } catch {}
run += 1
writeFileSync(stateFile, String(run))
if (failOn.split(',').includes(String(run))) process.exit(1)

const resumeAt = process.argv.indexOf('--resume')
const resumed = resumeAt === -1 ? 'none' : process.argv[resumeAt + 1]
if (resumed !== 'none' && gone.split(',').includes(resumed)) {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`)
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution', duration_ms: 0, duration_api_ms: 0, is_error: true, num_turns: 0, stop_reason: null, session_id: resumed, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })}\n`)
  process.exit(1)
}
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
    // What the CLI actually received, so a test can tell a replay from a delta.
    appendFileSync(`${stateFile}.prompts`, `${text}\n---\n`)
    send({ type: 'assistant', message: { content: [{ type: 'text', text: `ok: ${text.slice(0, 60)} resume=${resumed}` }] } })
    send({ type: 'result', subtype: 'success', session_id: sessionId, result: 'ok', usage: { input_tokens: 3, output_tokens: 1 } })
  }
})
