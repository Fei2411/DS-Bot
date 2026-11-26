// Environment hygiene for plugin worker / MCP subprocess spawning.
//
// Honest boundary, verified against `@deepseek-ai/dsh-mcp-client`'s real contract:
// the MCP SDK spawns stdio servers with `{ ...scrubbedParentEnv(), ...config.env }`
// and `spawn` semantics REPLACE the child environment wholesale with that map —
// nothing outside the map exists in the child. DSH's `scrubbedParentEnv` drops
// credential-shaped names (`KEY|PASSWORD|SECRET|TOKEN` patterns and `DSH_*`) but
// deliberately keeps the rest of the parent environment, including capability
// variables that are not secrets by shape: `SSH_AUTH_SOCK` (agent sign-in),
// `KUBECONFIG` / `DOCKER_HOST` (cluster and daemon authority), `LD_PRELOAD` /
// `DYLD_INSERT_LIBRARIES` (code injection into other children).
//
// What DS Bot controls, and what this module honestly does:
//   1. `sanitizePluginEnv` constructs the EXPLICIT layer of the child env: the
//      plugin manifest's declared env passes verbatim (plaintext credentials in it
//      are already rejected at validation, `$DSH_SECRET_*` references expand before
//      this point), merged over an allowlisted base when there is one.
//   2. `envNullificationOverlay` neutralizes capability variables the parent may
//      carry by overriding them to empty strings inside `config.env`. Because the
//      SDK merges `config.env` last, the child receives those names empty — a real
//      mitigation that disables agent sockets, preload injection, and credential
//      file discovery, but NOT a guarantee: empty is not identical to absent for
//      every conceivable consumer, and unusual names outside the blocked list
//      still pass through DSH's scrub. Deleting inherited ambient variables from
//      the spawn environment entirely requires an authoritative-env option in
//      `@deepseek-ai/dsh-mcp-client` upstream; until then this module never claims
//      full ambient isolation.
//   3. Non-secret runtime requirements survive: `ELECTRON_RUN_AS_NODE` is
//      allowlisted because the desktop-bundled pnpm runner cannot start without it.
//
// Comparison is case-insensitive because Windows environment names are.

// Exact names (case-insensitive) a child runtime needs from an ambient base layer.
const SAFE_EXACT = new Set([
  // Loader and runtime paths.
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'WINDIR',
  // User/profile locations (not secrets themselves; required for HOME resolution).
  'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  // Temp locations.
  'TMPDIR', 'TMP', 'TEMP',
  // Shell identity needed to spawn shell-compatible children.
  'SHELL', 'TERM', 'TERM_PROGRAM', 'COLORTERM',
  // Locale and input methods.
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME',
  // Node/Electron runtime mode flags (non-secret; the desktop-bundled pnpm runner needs RUN_AS_NODE).
  'NODE_ENV', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE',
  // Proxy routing: network tools behind a corporate proxy fail hard without these.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  // Display/session type for GUI children (never the sockets themselves).
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP',
])

// Names carrying credentials or implicit authority must never cross implicitly,
// regardless of casing. Exported for tests and documentation.
export const SENSITIVE_ENV_PATTERN = /^(?:.*_)?(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret(?:[_-]key)?|token|password|passwd|credential(?:s)?|private[_-]?key|session[_-]?key)$/i

// Prefixes of host identity and vendor credentials that are never forwarded, and
// capability variables neutralized by the nullification overlay.
const BLOCKED_PREFIXES = [
  'DSH_SECRET_', 'DSH_', 'DS_BOT_SECRET', 'DEEPSEEK_', 'OPENAI_', 'ANTHROPIC_',
  'AWS_', 'AZURE_', 'GCP_', 'GOOGLE_APPLICATION_CREDENTIALS', 'GITHUB_', 'GH_',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO',
  'KUBECONFIG', 'DOCKER_HOST', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
]

function normalizeKey(key) {
  return String(key).toUpperCase()
}

function isBlockedName(key) {
  const upper = normalizeKey(key)
  if (SENSITIVE_ENV_PATTERN.test(upper)) return true
  return BLOCKED_PREFIXES.some(prefix => upper.startsWith(prefix) || upper === prefix.replace(/_$/, ''))
}

/**
 * Build the explicit environment layer a plugin worker / MCP subprocess config
 * carries. `baseEnv` passes only through the closed allowlist (used for host-level
 * runner configuration, which is ambient-ish input); `declaredEnv` — the plugin
 * manifest's own `env` — applies verbatim on top because those entries are
 * deliberate user configuration whose plaintext credentials were already rejected.
 *
 * @param {Record<string, string | undefined> | undefined} baseEnv - ambient-ish env to filter
 * @param {Record<string, string> | undefined} declaredEnv - the plugin's own declared env, applied verbatim last
 * @returns {Record<string, string>} fresh env object for the child config layer
 */
export function sanitizePluginEnv(baseEnv, declaredEnv) {
  const out = {}
  if (baseEnv && typeof baseEnv === 'object') {
    const claimed = new Set()
    for (const [key, value] of Object.entries(baseEnv)) {
      if (typeof value !== 'string') continue
      const upper = normalizeKey(key)
      if (claimed.has(upper)) continue
      if (!SAFE_EXACT.has(upper) && !upper.startsWith('LC_')) continue
      if (isBlockedName(key)) continue
      // Duplicate names differing only by case (POSIX) keep the first spelling.
      claimed.add(upper)
      out[key] = value
    }
  }
  if (declaredEnv && typeof declaredEnv === 'object') {
    for (const [key, value] of Object.entries(declaredEnv)) {
      if (typeof value !== 'string') continue
      // A declared name colliding case-insensitively with a base entry overrides it:
      // drop every spelling of that name first so the child sees exactly one value.
      const upper = normalizeKey(key)
      for (const existing of Object.keys(out)) {
        if (normalizeKey(existing) === upper) delete out[existing]
      }
      out[key] = value
    }
  }
  return out
}

/**
 * Capability variables present in the parent environment, mapped to empty strings.
 * Merged into the explicit config layer BEFORE the plugin's declared env, so a
 * deliberate user declaration can still re-enable one consciously (secret-shaped
 * values stay guarded by manifest validation). Because `@deepseek-ai/dsh-mcp-client`
 * merges `config.env` over its scrubbed parent env, the override neutralizes the
 * inherited value in the spawned child.
 *
 * Mitigation, not erasure — see the module header for the exact boundary.
 *
 * @param {Record<string, string | undefined>} [ambient] - parent env to scan (default `process.env`)
 * @returns {Record<string, string>} entries to fold into the child env config
 */
export function envNullificationOverlay(ambient = process.env) {
  const out = {}
  if (!ambient || typeof ambient !== 'object') return out
  const claimed = new Set()
  for (const key of Object.keys(ambient)) {
    const upper = normalizeKey(key)
    if (claimed.has(upper)) continue
    if (!isBlockedName(key)) continue
    claimed.add(upper)
    // One empty value per case-insensitive name; Windows children read names
    // case-insensitively, so shadowing the first spelling covers the rest.
    out[key] = ''
  }
  return out
}

/**
 * True when a name would survive the base-env allowlist. Exposed so callers can
 * explain why a variable the user expected is missing in the child.
 */
export function isSafePluginEnvName(key) {
  return SAFE_EXACT.has(normalizeKey(key)) && !isBlockedName(key)
}
