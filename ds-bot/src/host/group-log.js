// What was said in each group, kept for as long as the group is. A room's own log holds
// the latest lines for the interface and the members' turns; the memory review and a
// source that points back at a message need the ones that have left it.
//
//   <home>/group-logs/<roomId>.jsonl    one whole line per message
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const SEARCH_MAX = 20

export function install(rt) {
  const { ctx, home } = rt
  const dir = join(home, 'group-logs')
  const safeId = id => (/^[\w-]{1,128}$/.test(id) ? id : createHash('sha256').update(String(id)).digest('hex').slice(0, 32))
  const pathOf = roomId => join(dir, `${safeId(roomId)}.jsonl`)

  /** @type {Map<string, Promise<unknown>>} */
  const writing = new Map()
  const inLine = (roomId, job) => {
    const run = (writing.get(roomId) ?? Promise.resolve()).then(job)
    writing.set(roomId, run.catch(() => {}))
    return run
  }

  ctx.effect(() => rt.onRoomLine((room, line) => {
    if (rt.readOnly() !== undefined) return
    void inLine(room.id, async () => {
      await mkdir(dir, { recursive: true })
      await appendFile(pathOf(room.id), `${JSON.stringify(line)}\n`, 'utf8')
    }).catch(error => rt.warn('ds-bot: line %d of group %s not kept: %s', line.seq, room.name, error?.message ?? error))
  }), 'ds-bot: group log')

  // Oldest first. A line cut by an interruption is not a line.
  async function linesOf(roomId) {
    await writing.get(roomId)
    let text = ''
    try {
      text = await readFile(pathOf(roomId), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    // Upgraded groups still have recent messages that predate this file.
    const lines = new Map((await rt.recentGroupLines(roomId)).map(line => [line.seq, line]))
    for (const row of text.split('\n')) {
      if (row === '') continue
      try {
        const line = JSON.parse(row)
        if (Number.isInteger(line?.seq)) lines.set(line.seq, line)
      } catch { /* half-written */ }
    }
    return [...lines.values()].sort((a, b) => a.seq - b.seq)
  }

  async function groupLinesAfter(roomId, since) {
    return (await linesOf(roomId)).filter(line => since === undefined || line.seq > since)
  }
  async function groupLine(roomId, seq) {
    return (await linesOf(roomId)).find(line => line.seq === seq)
  }
  // Newest first: every word has to be in the line.
  async function searchGroupLog(roomId, query) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    return (await linesOf(roomId)).filter(line => typeof line.text === 'string' && words.every(word => line.text.toLowerCase().includes(word))).slice(-SEARCH_MAX).reverse()
  }
  function dropGroupLog(roomId) {
    void inLine(roomId, () => (rt.readOnly() === undefined ? rm(pathOf(roomId), { force: true }) : undefined)).catch(() => {})
  }

  Object.assign(rt, { groupLinesAfter, groupLine, searchGroupLog, dropGroupLog })
}
