// The hub's node registry: who has paired, what it runs, and when it last spoke. One
// JSON file under the hub's data folder, written whole through a temporary file so a
// reader never sees half a registry.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { hashToken, tokenMatches } from './pairing.js'

const NAME_MAX = 40
const SAVE_EVERY_MS = 5_000

// A name the CLI can type: lowercase letters, digits, dash and underscore.
export function nodeName(raw, fallback = 'device') {
  const value = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return (value || fallback).slice(0, NAME_MAX)
}

const text = (value, max) => {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/\p{Cc}+/gu, ' ').trim()
  return clean === '' ? undefined : clean.slice(0, max)
}

export function createRegistry({ dataDir, now = Date.now, file = join(dataDir, 'nodes.json'), log = () => {} }) {
  mkdirSync(dataDir, { recursive: true })
  let state = load()
  let savedAt = 0

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const nodes = {}
      for (const node of Object.values(parsed?.nodes ?? {})) {
        if (node && typeof node.id === 'string' && typeof node.tokenHash === 'string') nodes[node.id] = node
      }
      return { version: 1, nodes }
    } catch (error) {
      if (error?.code !== 'ENOENT') log('ds-bot lan: could not read %s: %s', file, error.message)
      return { version: 1, nodes: {} }
    }
  }

  function save(force = false) {
    const at = now()
    if (!force && at - savedAt < SAVE_EVERY_MS) return
    savedAt = at
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: 1, revision: at, nodes: state.nodes }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
    if (process.platform !== 'win32') {
      try {
        chmodSync(file, 0o600)
      } catch {
        // A file system without modes still gets the 0600 write above.
      }
    }
  }

  const list = () => Object.values(state.nodes)

  // A node is found by its id or by its name, as a person types it: "Windows PC" finds
  // the node registered as "windows-pc".
  function findNode(reference) {
    const wanted = String(reference ?? '').trim()
    if (wanted === '') return undefined
    const exact = state.nodes[wanted]
    if (exact !== undefined) return exact
    const slug = nodeName(wanted, '')
    return list().find(node => node.name === slug) ?? list().find(node => node.name === wanted.toLowerCase())
  }

  function uniqueName(raw) {
    const base = nodeName(raw)
    if (!list().some(node => node.name === base)) return base
    for (let index = 2; ; index += 1) {
      const candidate = `${base}-${index}`
      if (!list().some(node => node.name === candidate)) return candidate
    }
  }

  return {
    get file() {
      return file
    },
    list,
    find: findNode,
    findByToken(token) {
      return list().find(node => tokenMatches(token, node.tokenHash))
    },
    add({ name, token, os, platform, arch, hostname, agentVersion }) {
      const id = `nd_${randomBytes(5).toString('hex')}`
      const node = {
        id,
        name: uniqueName(name),
        tokenHash: hashToken(token),
        os: text(os, 40),
        platform: text(platform, 120),
        arch: text(arch, 40),
        hostname: text(hostname, 120),
        agentVersion: text(agentVersion, 40),
        pairedAt: new Date(now()).toISOString(),
        lastSeen: new Date(now()).toISOString(),
      }
      state.nodes[id] = node
      save(true)
      return node
    },
    // A heartbeat is frequent, so the file follows it at most every few seconds; the
    // in-memory record is always current.
    touch(id) {
      const node = state.nodes[id]
      if (node === undefined) return
      node.lastSeen = new Date(now()).toISOString()
      save()
    },
    remove(reference) {
      const node = findNode(reference)
      if (node === undefined) return false
      delete state.nodes[node.id]
      save(true)
      return true
    },
    save,
  }
}
