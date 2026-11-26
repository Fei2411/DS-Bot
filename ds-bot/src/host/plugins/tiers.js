// Canonical execution tiers and capability vocabulary for DS Bot plugin manifests.
//
// Every plugin (built-in, native provider, DSH bundle, or MCP wrapper) is classified
// into exactly one execution tier. The tier is a declared upper bound on how its code
// may execute; capabilities are the observable executable powers a manifest requests.
// Tier validation is fail-closed: a combination the vocabulary cannot reason about is
// rejected instead of silently accepted, and normalization defaults keep every plugin
// shape that predates this vocabulary loading exactly as before.
//
//   data            Pure declarative data (translations, themes, knowledge). No executable
//                   capability may be declared.
//   declarative     Declarative wiring only: hook/entry-point names the host interprets
//                   (`entry`), but no code the plugin itself runs (`process` / `worker`).
//   sandboxed-ui    UI confined to a sandboxed renderer surface (the existing sandboxed
//                   iframe/widget contract). May declare host-rendered entry points but no
//                   host worker execution.
//   trusted-worker  Full host trust: the plugin's own code runs in or beside the host
//                   process (native `mount` descriptors, stdio MCP subprocesses, DSH
//                   bundles). This is the implicit tier of every pre-existing plugin.

export const EXECUTION_TIERS = Object.freeze(['data', 'declarative', 'sandboxed-ui', 'trusted-worker'])

// Canonical capability vocabulary. Unknown capabilities are tolerated only on
// `trusted-worker` (full host trust is already implied there); the confined tiers must
// stay a closed system so a registry update cannot smuggle in a capability the tier
// boundary cannot reason about.
export const EXECUTION_CAPABILITIES = Object.freeze(['entry', 'process', 'worker'])

// The maximum capabilities each tier may declare.
const TIER_CAPABILITY_CEILING = Object.freeze({
  data: Object.freeze([]),
  declarative: Object.freeze(['entry']),
  'sandboxed-ui': Object.freeze(['entry']),
  'trusted-worker': Object.freeze(['entry', 'process', 'worker']),
})

// Capabilities a manifest of each tier is assumed to use when it declares none.
// `trusted-worker` implies full host execution: anything that runs its own code does.
const TIER_DEFAULT_CAPABILITIES = Object.freeze({
  data: Object.freeze([]),
  declarative: Object.freeze(['entry']),
  'sandboxed-ui': Object.freeze(['entry']),
  'trusted-worker': Object.freeze(['entry', 'process', 'worker']),
})

export function isExecutionTier(value) {
  return typeof value === 'string' && TIER_CAPABILITY_CEILING[value] !== undefined
}

function tierCapabilities(tier) {
  return TIER_CAPABILITY_CEILING[tier]
}

/**
 * Validate and normalize an execution tier declaration plus its capability list.
 * Returns `{ execution, capabilities, unknown }` where `capabilities` is the sorted,
 * deduplicated canonical set (unknown ones included for `trusted-worker` only) and
 * `unknown` lists capability names outside the canonical vocabulary.
 *
 * @param {object} input
 * @param {string} input.execution - canonical tier (required, already defaulted by caller)
 * @param {string[] | undefined} input.capabilities - declared capability list, if any
 */
export function validateExecutionCapabilities({ execution, capabilities } = {}) {
  if (!isExecutionTier(execution)) {
    throw new TypeError(`Invalid plugin execution tier "${execution}"; expected one of: ${EXECUTION_TIERS.join(', ')}.`)
  }
  const ceiling = tierCapabilities(execution)
  let list
  if (capabilities === undefined || capabilities === null) {
    list = [...TIER_DEFAULT_CAPABILITIES[execution]]
  } else {
    if (!Array.isArray(capabilities)) {
      throw new TypeError('Plugin capabilities must be an array of capability names.')
    }
    list = [...new Set(capabilities.map(item => String(item ?? '').trim().toLowerCase()).filter(Boolean))]
  }
  const overreach = list.filter(cap => !ceiling.includes(cap) && EXECUTION_CAPABILITIES.includes(cap))
  if (overreach.length > 0) {
    throw new TypeError(
      `Execution tier "${execution}" cannot declare ${overreach.map(cap => `"${cap}"`).join(', ')}: `
      + 'executable process/worker capabilities require "trusted-worker", and "data" plugins cannot declare executable capabilities.',
    )
  }
  const unknown = list.filter(cap => !EXECUTION_CAPABILITIES.includes(cap))
  if (unknown.length > 0 && execution !== 'trusted-worker') {
    throw new TypeError(
      `Unknown plugin capabilities ${unknown.map(cap => `"${cap}"`).join(', ')} are not allowed below "trusted-worker".`,
    )
  }
  return { execution, capabilities: list.sort(), unknown }
}

/**
 * Derive the execution tier a plugin definition runs at when it declares none.
 * Everything that exists today executes host-trusted code, so the safe default is
 * `trusted-worker`; a manifest must explicitly opt into a lower tier and accept its
 * boundaries.
 */
export function defaultExecutionTier() {
  return 'trusted-worker'
}

/**
 * Normalize the execution tier declaration of a plugin manifest-shaped object.
 * `explicit` is the manifest's own `execution` field; when absent the default applies.
 * Throws TypeError for invalid tiers or tier/capability combinations.
 */
export function normalizeExecution({ execution, capabilities } = {}) {
  const tier = execution == null || execution === ''
    ? defaultExecutionTier()
    : String(execution).trim().toLowerCase()
  return validateExecutionCapabilities({ execution: tier, capabilities })
}

/**
 * Silent variant of `normalizeExecution` for registry parsing, where malformed entries
 * are dropped rather than thrown. Returns null when the declaration is invalid.
 */
export function tryNormalizeExecution(input) {
  try {
    return normalizeExecution(input)
  } catch {
    return null
  }
}

/**
 * Normalize a manifest's tier with the capabilities its activation kind implies
 * regardless of declaration — a stdio MCP subprocess always executes a process, a DSH
 * bundle always runs host code. The effective capability set is the union, and it must
 * fit inside the declared tier: a `data` plugin cannot silently execute a subprocess,
 * so such a manifest is invalid (null) instead of trusted.
 *
 * @param {{ execution?: string, capabilities?: string[] }} source - manifest-shaped input
 * @param {string[]} implied - capabilities the activation kind always executes with
 */
export function normalizeExecutionWithImplied(source, implied) {
  // No silent fallback here: an absent declaration defaults to trusted-worker inside
  // normalization itself, while an explicit invalid combination must surface as
  // invalid (null) rather than being laundered into full trust.
  const declared = tryNormalizeExecution({ execution: source?.execution, capabilities: source?.capabilities })
  if (!declared) return null
  if (!Array.isArray(implied) || implied.length === 0) return declared
  const effective = [...new Set([...declared.capabilities, ...implied])].sort()
  return tryNormalizeExecution({ execution: declared.execution, capabilities: effective })
}
