// Strict environment allowlist for plugin worker / MCP subprocess spawning.
//
// Anything spawned on behalf of a plugin must never inherit host secrets implicitly.
// `sanitizePluginEnv` builds the child environment from two explicit layers:
//   - `baseEnv` (usually the ambient process environment) passes only through a
//     closed allowlist of names a spawned runtime genuinely needs (loader paths,
//     locales, temp and profile locations, proxy routing). Everything else —
//     `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `DSH_SECRET_*`, `DEEPSEEK_*`, cloud and
//     agent credentials, session sockets — is dropped regardless of name casing.
//   - `declaredEnv` (the plugin manifest's own `env` map) is applied verbatim on
//     top: those entries are deliberate configuration the user wrote or approved,
//     and plaintext credentials in them are already rejected at validation time
//     (see `validateMcpConfig`), with `$DSH_SECRET_<NAME>` expansion happening
//     before this layer.
// Comparison is case-insensitive because Windows environment names are.

// Exact names (case-insensitive) a child runtime needs from its parent.
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
// regardless of casing. The allowlist above already excludes them; this explicit
// list exists so a future allowlist addition cannot silently re-admit them and so
// audits have the threat model in one place. Exported for tests and documentation.
export const SENSITIVE_ENV_PATTERN = /^(?:.*_)?(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret(?:[_-]key)?|token|password|passwd|credential(?:s)?|private[_-]?key|session[_-]?key)$/i

// Prefixes of host identity and vendor credentials that are never forwarded.
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
 * Build the environment a plugin worker / MCP subprocess may start from.
 *
 * @param {Record<string, string | undefined> | undefined} baseEnv - ambient env to filter (e.g. `process.env`)
 * @param {Record<string, string> | undefined} declaredEnv - the plugin's own declared env, applied verbatim last
 * @returns {Record<string, string>} fresh env object safe to hand to a child spawn
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
 * True when a name would survive the base-env allowlist. Exposed so callers can
 * explain why a variable the user expected is missing in the child.
 */
export function isSafePluginEnvName(key) {
  return SAFE_EXACT.has(normalizeKey(key)) && !isBlockedName(key)
}
