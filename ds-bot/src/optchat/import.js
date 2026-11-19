// Import a copy of an earlier OptChat store (main/*.jsonl, tree/*.jsonl) into one Bot's
// namespace. Every message keeps its kind, original date and metadata, plus where it came
// from; a key per source message makes a second run add nothing. The source is only read.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { KINDS, part, utf8 } from './core.js'

function readJsonl(dir) {
  if (!existsSync(dir)) return []
  const rows = []
  for (const name of readdirSync(dir).filter(file => file.endsWith('.jsonl')).sort()) {
    readFileSync(join(dir, name), 'utf8').split('\n').forEach((line, n) => {
      if (line.trim() === '') return
      try { rows.push(JSON.parse(line)) } catch { throw new Error(`optchat import: bad JSON at ${name}:${n + 1}`) }
    })
  }
  return rows
}

/**
 * @param ns - an open Namespace
 * @param sourceDir - a copy of the old store
 * @param label - the provenance name written into each message
 */
export function importStore(ns, sourceDir, { label = resolve(sourceDir) } = {}) {
  const rows = readJsonl(join(sourceDir, 'main')).sort((a, b) => a.i - b.i)
  rows.forEach((row, index) => {
    if (row.i !== index) throw new Error(`optchat import: source IDs are not contiguous at ${index}`)
    if (!KINDS.has(row.kind) || typeof row.text !== 'string' || typeof row.date !== 'string') throw new Error(`optchat import: invalid source message ${row.i}`)
  })
  let added = 0
  let aligned = true
  for (const row of rows) {
    const metadata = {}
    for (const [key, value] of Object.entries(row.metadata ?? {})) metadata[key] = typeof value === 'string' ? value : JSON.stringify(value)
    metadata.import_source = label
    metadata.import_id = String(row.i)
    const result = ns.append(row.kind, row.text, { metadata, date: row.date, key: `import:${label}:${row.i}` })
    if (result.added) added += 1
    if (result.event.i !== row.i) aligned = false
  }
  // Old summaries are reused only when every imported message kept its ID, so each
  // node still covers exactly the messages it summarized.
  let nodes = 0
  if (aligned) {
    const tree = readJsonl(join(sourceDir, 'tree')).sort((a, b) => a.l - b.l || a.i - b.i)
    for (const node of tree) {
      const p = part(node.l, node.i)
      if (p.end > rows.length || ns.has(p) || typeof node.text !== 'string' || node.text.trim() === '' || utf8(node.text) !== node.size) continue
      if (node.l > 0 && !ns.children(p).every(child => ns.has(child))) continue
      ns.saveNode(node)
      nodes += 1
    }
  }
  return { source: rows.length, added, skipped: rows.length - added, aligned, nodes, first: rows[0]?.date, last: rows.at(-1)?.date }
}
