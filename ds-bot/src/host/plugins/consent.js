// Consent fingerprinting for plugin activation.
//
// Installing or activating a plugin is the user's consent to run exactly what the
// plugin is at that moment. The consent fingerprint binds that moment: the declared
// capabilities and execution tier, the executable entry point (command, package spec,
// URL), the content hash of the installed tree when one exists, and the slot/replaces
// placement. Everything is canonicalized into a single SHA-256 hex string, so when an
// update or a registry/catalog change alters any of these inputs the fingerprint no
// longer matches the stored consent and the plugin must not silently run upgraded
// code under the stale approval.
import { createHash } from 'node:crypto'
import { normalizeExecution } from './tiers.js'

function cleanSortedList(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.map(item => String(item ?? '').trim()).filter(Boolean))].sort()
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * Canonical consent fingerprint of one plugin manifest/activation input set.
 * Every field is normalized before hashing: order-insensitive lists are sorted,
 * order-sensitive argv is preserved verbatim, and missing fields are explicit nulls
 * rather than absent keys so no input can be hidden by omission.
 *
 * @param {object} input
 * @param {string} input.kind - plugin kind (`builtin` | `provider` | `dsh` | `mcp`)
 * @param {string} input.execution - canonical execution tier
 * @param {string[]} [input.capabilities] - declared capabilities
 * @param {string | null} [input.entry] - executable entry point (command / package spec / URL / package name)
 * @param {string[]} [input.entryArgs] - argv in declared order (order is significant)
 * @param {string[]} [input.envKeys] - declared environment variable names (never values)
 * @param {string[]} [input.headerKeys] - declared HTTP header names (never values)
 * @param {string[]} [input.secretRefs] - declared `$DSH_SECRET_*` references bound to headers/env (names only, never secret values)
 * @param {string | null} [input.version] - exact installed package version when known
 * @param {string | null} [input.contentHash] - `hashPluginTree` hex digest when a tree exists
 * @param {string | null} [input.slot] - exclusive slot the plugin occupies
 * @param {string[]} [input.replaces] - plugins this one declares to replace
 */
export function consentFingerprint(input) {
  const normalized = normalizeExecution({ execution: input?.execution, capabilities: input?.capabilities })
  // `kind` is deliberately not an input: how the host mounts a target (package-only
  // bundle vs. the same bundle's native provider) is an implementation detail, while
  // the executable truth — capabilities, tier, entry, bytes, placement — is what
  // consent binds. Entry shape already distinguishes MCP transports.
  const canonical = {
    capabilities: normalized.capabilities,
    contentHash: typeof input?.contentHash === 'string' && input.contentHash ? input.contentHash : null,
    entry: typeof input?.entry === 'string' && input.entry ? input.entry : null,
    entryArgs: Array.isArray(input?.entryArgs) ? input.entryArgs.map(arg => String(arg)) : [],
    envKeys: cleanSortedList(input?.envKeys),
    execution: normalized.execution,
    headerKeys: cleanSortedList(input?.headerKeys),
    replaces: cleanSortedList(input?.replaces),
    secretRefs: cleanSortedList(input?.secretRefs),
    slot: input?.slot ? String(input.slot) : null,
    version: typeof input?.version === 'string' && input.version ? input.version : null,
  }
  return createHash('sha256').update(canonicalize(canonical), 'utf8').digest('hex')
}

/**
 * Compare the live fingerprint inputs with a stored consent record.
 *
 * @param {object | undefined} record - stored `{ fingerprint, grantedAt }` consent
 * @param {string} fingerprint - fingerprint computed from the live inputs
 * @returns {{ state: 'granted' | 'required' | 'baseline', fingerprint: string }}
 *   `granted` — live fingerprint matches stored consent; `required` — a stored
 *   consent exists but the fingerprint drifted (updated plugin must not run under
 *   stale approval); `baseline` — nothing stored yet, first activation establishes it.
 */
export function evaluateConsent(record, fingerprint) {
  if (!record || typeof record !== 'object' || typeof record.fingerprint !== 'string' || !record.fingerprint) {
    return { state: 'baseline', fingerprint }
  }
  return record.fingerprint === fingerprint
    ? { state: 'granted', fingerprint }
    : { state: 'required', fingerprint }
}
