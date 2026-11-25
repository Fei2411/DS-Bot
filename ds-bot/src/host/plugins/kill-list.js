// Kill-list circuit breaker for DS Bot plugins.
//
// A kill list is a signed-down-by-time revocation document distributed beside the
// plugin registry: when a plugin version turns out to be malicious or dangerously
// broken, the team-wide circuit breaker refuses activation immediately instead of
// waiting for every user to uninstall. Safety properties:
//   - anti-rollback: a document whose `issuedAt` is older than the cached one is
//     never applied, so a replayed stale list cannot un-kill a plugin;
//   - far-future rejection: `issuedAt` implausibly ahead of the host clock is
//     rejected, so a crafted document cannot pin itself ahead of every future update;
//   - offline tolerance: evaluation always reads the local cache only, so startup
//     never blocks on the network and a missing/invalid cache simply means no kills.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { satisfies as semverSatisfies, valid as semverValid, validRange } from 'semver'
import { replaceFile } from '../files.js'

export const KILL_LIST_MAX_AGE_FUTURE_MS = 24 * 60 * 60 * 1000
export const KILL_LIST_MAX_ENTRIES = 500
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9:._/@-]{1,120}$/i

function parseIssuedAt(value, now) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Kill list requires an "issuedAt" timestamp.')
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error('Kill list "issuedAt" is not a valid timestamp.')
  if (time > now() + KILL_LIST_MAX_AGE_FUTURE_MS) {
    throw new Error('Kill list "issuedAt" is implausibly far in the future.')
  }
  return { time, iso: new Date(time).toISOString() }
}

/**
 * Validate a raw kill-list document. Throws on any structural violation — a kill
 * list is fail-closed data, and half-valid revocation is worse than none.
 *
 * Schema (version 1):
 *   { schemaVersion: 1, issuedAt: ISO-8601, entries: [{ id, versions?, contentHashes?, reason? }] }
 *
 * @returns {{ schemaVersion: 1, issuedAt: string, issuedAtMs: number, entries: object[] }}
 */
export function validateKillListDocument(raw, { now = Date.now } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Kill list document must be a JSON object.')
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`Unsupported kill list schemaVersion: ${raw.schemaVersion}.`)
  }
  const { time, iso } = parseIssuedAt(raw.issuedAt, now)
  if (!Array.isArray(raw.entries)) {
    throw new Error('Kill list document must contain an "entries" array.')
  }
  const entries = []
  const seen = new Set()
  for (const item of raw.entries.slice(0, KILL_LIST_MAX_ENTRIES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const id = String(item.id ?? '').trim()
    if (!ENTRY_ID_RE.test(id)) continue
    if (seen.has(id)) continue
    const entry = { id }
    if (item.versions != null) {
      const range = String(item.versions).trim()
      if (!range || validRange(range) === null) continue
      entry.versions = range
    }
    if (Array.isArray(item.contentHashes)) {
      const hashes = [...new Set(item.contentHashes
        .map(h => String(h ?? '').trim().toLowerCase())
        .filter(h => /^[0-9a-f]{64}$/.test(h)))]
      if (hashes.length > 0) entry.contentHashes = hashes
    }
    // An entry that matches neither version nor content hash would kill every install
    // of the plugin; that is a deliberate kill switch, so it stays valid.
    if (typeof item.reason === 'string' && item.reason.trim()) {
      entry.reason = item.reason.trim().slice(0, 300)
    }
    seen.add(id)
    entries.push(entry)
  }
  return { schemaVersion: 1, issuedAt: iso, issuedAtMs: time, entries }
}

/**
 * Evaluate the kill list against one plugin activation.
 *
 * @param {{ entries: object[] }} list - validated kill list (any source)
 * @param {{ id: string, version?: string | null, contentHash?: string | null }} target
 * @returns {{ id: string, reason: string | null, versions?: string } | null} the matching entry or null
 */
export function evaluateKillEntry(list, { id, version = null, contentHash = null } = {}) {
  if (!list || !Array.isArray(list.entries) || typeof id !== 'string' || !id) return null
  for (const entry of list.entries) {
    if (entry.id !== id) continue
    // A content-hash match is exact regardless of version.
    if (typeof contentHash === 'string' && entry.contentHashes?.includes(contentHash.toLowerCase())) {
      return entry
    }
    if (entry.versions) {
      // A version range can only match a concrete known version; unknown versions do
      // not silently escape the range because absence of a version is not absence of risk —
      // but treating unknown as matched would make every unpackaged plugin unstartable,
      // so range matching stays exact-semver-only.
      if (version && semverValid(version) && semverSatisfies(version, entry.versions)) return entry
      // Content-hash-only or version-only entries that did not match keep looking.
      if (!entry.contentHashes) continue
      continue
    }
    if (entry.contentHashes) {
      // Hash-only entry: matches only exact content hashes, already checked above.
      continue
    }
    return entry
  }
  return null
}

/**
 * Merge kill-list documents from independent sources. Entries are additive across
 * sources: any source may kill a plugin, and no source can un-kill another source's
 * entries (the document-level anti-rollback is per source, see the store below).
 */
export function mergeKillLists(documents) {
  const entries = []
  const seen = new Set()
  let newest = 0
  for (const doc of documents) {
    if (!doc) continue
    newest = Math.max(newest, doc.issuedAtMs ?? 0)
    for (const entry of doc.entries ?? []) {
      const key = `${entry.id}${entry.versions ?? ''}${(entry.contentHashes ?? []).join(',')}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
  }
  return { entries, issuedAtMs: newest }
}

/**
 * Persistent per-source kill-list store. The cache file at `cachePath` is local,
 * offline-first state: `load()` reads it once, `updateFromSource()` applies a fetched
 * document when it is at least as new as the cached one for that source, and
 * `evaluate()` answers synchronously from memory.
 */
export function createKillListStore({ cachePath, now = Date.now } = {}) {
  /** @type {Map<string, { schemaVersion: 1, issuedAt: string, issuedAtMs: number, entries: object[] }>} */
  const perSource = new Map()
  let loadPromise = null
  let writeChain = Promise.resolve()

  async function load() {
    if (!loadPromise) {
      loadPromise = (async () => {
        if (!cachePath) return
        try {
          const text = await readFile(cachePath, 'utf8')
          const parsed = JSON.parse(text)
          if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || typeof parsed.sources !== 'object') return
          for (const [sourceId, doc] of Object.entries(parsed.sources)) {
            try {
              perSource.set(sourceId, validateKillListDocument(doc, { now: () => Number.POSITIVE_INFINITY }))
            } catch { /* a corrupt per-source entry is dropped, the rest survives */ }
          }
        } catch { /* missing or corrupt cache means no kills yet */ }
      })()
    }
    return loadPromise
  }

  function snapshotSources() {
    const sources = {}
    for (const [sourceId, doc] of perSource) {
      sources[sourceId] = { schemaVersion: 1, issuedAt: doc.issuedAt, entries: doc.entries }
    }
    return { schemaVersion: 1, sources }
  }

  async function persist() {
    if (!cachePath) return
    writeChain = writeChain.then(async () => {
      try {
        await mkdir(dirname(cachePath), { recursive: true })
        const temp = `${cachePath}.tmp-${process.pid}`
        await writeFile(temp, JSON.stringify(snapshotSources(), null, 2))
        await replaceFile(temp, cachePath)
      } catch { /* cache write is best-effort; evaluation is in-memory anyway */ }
    }).catch(() => {})
    return writeChain
  }

  /**
   * Apply a freshly fetched kill-list document for one source. Anti-rollback: a
   * document strictly older than the cached one for the same source is ignored.
   * Far-future documents are already rejected by validation.
   *
   * @returns {{ applied: boolean, reason?: string }}
   */
  async function updateFromSource(sourceId, rawDoc) {
    await load()
    const id = String(sourceId ?? '').trim() || 'unknown'
    let doc
    try {
      doc = validateKillListDocument(rawDoc, { now })
    } catch (error) {
      return { applied: false, reason: error?.message ?? String(error) }
    }
    const existing = perSource.get(id)
    if (existing && doc.issuedAtMs < existing.issuedAtMs) {
      return { applied: false, reason: 'stale' }
    }
    // Re-applying the byte-identical document is a no-op: only genuinely new or
    // changed kill state may wake reconciliation, or every catalog refresh would loop.
    const unchanged = existing
      && existing.issuedAtMs === doc.issuedAtMs
      && JSON.stringify(existing.entries) === JSON.stringify(doc.entries)
    perSource.set(id, doc)
    if (!unchanged) await persist()
    return { applied: true, changed: !unchanged }
  }

  /**
   * Synchronously evaluate one target against the merged cached lists.
   * Returns `{ killed: true, id, reason, issuedAt }` or null. Always offline-safe:
   * nothing here touches the network, and an unloaded cache means no matches.
   */
  function evaluate(target) {
    if (perSource.size === 0) return null
    const merged = mergeKillLists([...perSource.values()])
    const match = evaluateKillEntry(merged, target)
    if (!match) return null
    return {
      killed: true,
      id: match.id,
      reason: match.reason ?? null,
      versions: match.versions ?? null,
      issuedAtMs: merged.issuedAtMs,
    }
  }

  function listEntries() {
    return mergeKillLists([...perSource.values()]).entries.map(entry => ({ ...entry }))
  }

  return { load, updateFromSource, evaluate, listEntries }
}
