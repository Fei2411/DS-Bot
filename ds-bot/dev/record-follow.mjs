// Records what `api/bot/session` (session-follow.js) streams from a real DSH, for the
// tests: start a bench (dev/bench.sh, or the Mac one) on the mock model, then
//   node dev/record-follow.mjs <bench-name> <web-port> [out.json]
// It opens the Main Bot's Session, sends a message that thinks and one that calls a tool,
// and keeps every frame until each turn has ended, then opens again to record a reconnect
// opening and reads one earlier page. Paths and ids are rewritten to fixed ones.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [name, port, out = 'test/fixtures/recorded/dsh-follow-0.2.2-rc.1.json'] = process.argv.slice(2)
if (!name || !port) {
  console.error('usage: node dev/record-follow.mjs <bench-name> <web-port> [out.json]')
  process.exit(2)
}
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const HOME = join(ROOT, `.dsh-test-${name}`)
const BASE = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const log = readFileSync(join(HOME, 'web.log'), 'utf8')
const loginUrl = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
if (!loginUrl) throw new Error('no login URL in web.log')
const login = await fetch(loginUrl, { redirect: 'manual' })
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')

async function api(endpoint, payload = {}) {
  const response = await fetch(`${BASE}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) })
  const result = await response.json()
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message}`)
  return result.value
}

// Every SSE event of one follow, until `stop` aborts it.
function follow(sessionId, max) {
  const events = []
  const stop = new AbortController()
  const done = (async () => {
    const response = await fetch(`${BASE}/api/bot/session?id=${encodeURIComponent(sessionId)}${max ? `&max=${max}` : ''}`, { headers: { cookie }, signal: stop.signal })
    if (!response.ok) throw new Error(`follow: HTTP ${response.status} ${await response.text()}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      buffer += decoder.decode(value, { stream: true })
      for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const event = /^event: (.+)$/m.exec(block)?.[1]
        const data = /^data: (.+)$/m.exec(block)?.[1]
        if (event !== undefined && data !== undefined) events.push({ event, data: JSON.parse(data) })
      }
    }
  })().catch((error) => { if (!stop.signal.aborted) throw error })
  return { events, stop: async () => { stop.abort(); await done } }
}

const turnEnds = events => events.filter(({ data }) => data.type === 'event' && data.event.type === 'turn/end').length
async function until(check, what) {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(200)) if (check()) return
  throw new Error(`timed out waiting for ${what}`)
}

const state = await api('state')
const main = Object.values(state.bots).find(bot => bot.main) ?? Object.values(state.bots)[0]
if (main === undefined) throw new Error('the bench has no Bot yet: open it once in a browser')
const sessionId = main.sessionId ?? main.id

const live = follow(sessionId, 20)
await until(() => live.events.length > 0, 'the opening snapshot')
const before = turnEnds(live.events)
await api('send', { sessionId: main.id, text: '想想下一步' })
await until(() => turnEnds(live.events) > before, 'the thinking turn')
await api('send', { sessionId: main.id, text: '看看团队' })
await until(() => turnEnds(live.events) > before + 1, 'the tool turn')
await sleep(500)
await live.stop()

const again = follow(sessionId, 4)
await until(() => again.events.length > 0, 'the reconnect snapshot')
await again.stop()
const opening = again.events[0].data
const page = await api('session-page', { sessionId, beforeSeq: opening.records[0]?.event.seq, maxMessages: 4 })

// The skills DSH found on this machine are this machine's, not the contract's.
const SKILLS = '<system-reminder>\n(the skills list is left out of the recording)\n</system-reminder>'
const ONE_SKILL = [{ name: 'example-skill', description: 'An example skill.' }]
const trim = value => (typeof value === 'string' ? (value.includes('<available_skills>') ? SKILLS : value)
  : Array.isArray(value) ? value.map(trim)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, value.kind === 'skill-catalog' && key === 'entries' ? ONE_SKILL : trim(inner)]))
      : value)
// Fixed ids and paths, so the file names nothing of this machine.
let text = JSON.stringify(trim({ dsh: '0.2.2-rc.1', recorded: 'mock model (dev/mock-llm.mjs)', live: live.events, reconnect: again.events, page }), null, 1)
for (const [from, to] of [[HOME, '/bench'], [sessionId, 'session-main']]) text = text.split(from).join(to)
// Any other absolute path (the harness checkout) is cut to its last folders.
text = text.replace(/(?:\/[^/"\\]+)+?(\/node_modules|\/dev\/harness)/g, '/checkout$1')
if (process.env.HOME && text.includes(process.env.HOME)) throw new Error('a home path is left in the recording')
writeFileSync(out, `${text}\n`)
console.log(`${live.events.length} live, ${again.events.length} reconnect, ${page.records.length} page records → ${out}`)
