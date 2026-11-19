#!/usr/bin/env node
// Usage: node scripts/optchat-import.mjs <copy of old store> <namespace root> <botId>
// Imports into <namespace root>/<botId>. Point it at a copy, never at a live store.
import { join } from 'node:path'
import { closeNamespace, openNamespace } from '../src/optchat/core.js'
import { importStore } from '../src/optchat/import.js'

const [source, root, botId, label] = process.argv.slice(2)
if (!source || !root || !botId) {
  console.error('usage: optchat-import.mjs <source-copy> <namespace-root> <botId> [label]')
  process.exit(2)
}
const dir = join(root, botId)
const ns = openNamespace(dir, { warn: message => console.error(message) })
try {
  const result = importStore(ns, source, { label: label ?? 'optchat:tropmaid' })
  console.log(JSON.stringify({ ...result, namespace: dir, events: ns.events.length, treeNodes: ns.nodes.size }))
} finally {
  closeNamespace(dir)
}
