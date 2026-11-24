// The engines a local agent can run on. Each entry names its route, its display
// name, how it starts, and which driver speaks its protocol: 'acp' (Agent
// Client Protocol over stdio), 'codex' (the Codex app-server JSON-RPC), or
// 'claude' (Claude Code's stream-json).
import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve, win32 } from 'node:path'

export const KINDS = ['acp', 'codex', 'claude']
export const PROFILE_SEPARATOR = '@'
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const BLOCKED_PROFILE_ENV = new Set([
  'PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'ACP_BACKEND', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'ELECTRON_RUN_AS_NODE',
])
const BLOCKED_PROFILE_ENV_PREFIX = ['DS_BOT_', 'DSH_', 'ANTIGRAVITY_', 'AGY_', 'DEEPSEEK_', 'DYLD_']

// `args` run verbatim (no shell). `env` merges over the sanitized environment.
// `signedIn` checks a CLI status command, a credential file (in the home
// directory or the per-user app data folder), or a Keychain item (see probeSignIn).
// Local-agent routes live under their own prefix. Before it they shared the
// provider namespace, so a CLI named like a provider DSH or another plugin
// ships (`opencode`) took that provider's name and the LLM service failed to
// load with a duplicate adapter.
export const ROUTE_PREFIX = 'local-'

const CLIS = {
  'devin-cli': {
    name: 'Devin CLI', kind: 'acp', command: 'devin', args: ['acp'], version: ['--version'], signIn: 'devin auth login',
    // `devin auth status` fetches remote team settings and can time out offline;
    // `devin auth logout` deletes credentials.toml, which requires top-level `windsurf_api_key`.
    signedIn: {
      args: ['auth', 'status'],
      fallback: {
        platformFile: {
          win32: { env: 'APPDATA', base: ['AppData', 'Roaming'], path: ['devin', 'credentials.toml'] },
          default: { env: 'XDG_DATA_HOME', base: ['.local', 'share'], path: ['devin', 'credentials.toml'] },
          tomlStrings: ['windsurf_api_key'],
        },
      },
    },
  },
  'claude-code': { name: 'Claude Code', kind: 'claude', command: 'claude', args: [], version: ['--version'], signIn: 'claude', signedIn: { args: ['auth', 'status'], fallback: { file: ['.claude', '.credentials.json'], envDir: 'CLAUDE_CONFIG_DIR' } } },
  'codex-cli': { name: 'Codex CLI', kind: 'codex', command: 'codex', args: ['app-server', '--listen', 'stdio://'], version: ['--version'], signIn: 'codex login', signedIn: { args: ['login', 'status'] } },
  'cursor-cli': {
    name: 'Cursor CLI', kind: 'acp', command: 'cursor-agent', args: ['acp'], version: ['--version'], signIn: 'cursor-agent login',
    // `cursor-agent status` validates over the network and requires either both OAuth
    // tokens (access + refresh) or an API key; fall back to macOS Keychain metadata
    // or auth.json with the same contract if the status call is inconclusive.
    signedIn: {
      args: ['status'],
      fallback: {
        macKeychain: { services: ['cursor-access-token', 'cursor-refresh-token'], account: 'cursor-user' },
        fallback: {
          macKeychain: { service: 'cursor-api-key', account: 'cursor-user' },
          fallback: {
            platformFile: {
              darwin: { path: ['.cursor', 'auth.json'] },
              win32: { env: 'APPDATA', base: ['AppData', 'Roaming'], path: ['Cursor', 'auth.json'] },
              default: { env: 'XDG_CONFIG_HOME', base: ['.config'], path: ['cursor', 'auth.json'] },
              stringGroups: [[['accessToken'], ['refreshToken']], [['apiKey']]],
            },
          },
        },
      },
    },
  },
  'copilot-cli': { name: 'GitHub Copilot', kind: 'acp', command: 'copilot', args: ['--acp'], version: ['--version'], signIn: 'copilot' },
  'gemini-cli': { name: 'Gemini CLI', kind: 'acp', command: 'gemini', args: ['--acp'], version: ['--version'], signIn: 'gemini', signedIn: { file: ['.gemini', 'oauth_creds.json'] } },
  'antigravity': {
    name: 'Antigravity', kind: 'acp', command: 'agy', args: ['acp'], version: ['--version'], signIn: 'agy acp --login',
    signedIn: { macKeychain: { service: 'gemini', account: 'antigravity' } },
    cwdPerProcess: true,
    modes: {
      'read-only': ['default'],
      'workspace-write': ['accept-edits'],
      'danger-full-access': ['auto'],
    },
  },
  'opencode': { name: 'OpenCode', kind: 'acp', command: 'opencode', args: ['acp'], version: ['--version'], signIn: 'opencode auth login' },
  'cline': { name: 'Cline', kind: 'acp', command: 'cline', args: ['--acp'], version: ['--version'], signIn: 'cline auth', env: { CLINE_SESSION_BACKEND_MODE: 'local' } },
  'kilo': { name: 'Kilo CLI', kind: 'acp', command: 'kilo', commands: ['kilo', 'kilocode'], args: ['acp'], version: ['--version'], signIn: 'kilo auth' },
  'goose': { name: 'Goose', kind: 'acp', command: 'goose', args: ['acp'], version: ['--version'], signIn: 'goose configure' },
  'grok-cli': { name: 'Grok CLI', kind: 'acp', command: 'grok', args: ['agent', 'stdio'], version: ['--version'], signIn: 'grok' },
  'kimi-cli': { name: 'Kimi CLI', kind: 'acp', command: 'kimi', args: ['acp'], version: ['--version'], signIn: 'kimi login' },
  'qwen-code': { name: 'Qwen Code', kind: 'acp', command: 'qwen', args: ['--acp'], version: ['--version'], signIn: 'qwen', signedIn: { file: ['.qwen', 'oauth_creds.json'] } },
  'codebuddy': {
    name: 'CodeBuddy Code', kind: 'acp', command: 'codebuddy', commands: ['codebuddy', 'codebuddy-code'], args: ['--acp'], version: ['--version'], signIn: 'codebuddy',
    // CodeBuddy has no status command. Its OAuth session file stays in place
    // until logout renames it and leaves a `.logged-out` marker beside it; it
    // only accepts a file with a token and an account (the values may be encrypted).
    signedIn: { appDataFile: { path: ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info'], loggedOut: '.logged-out', has: [['auth', 'accessToken'], ['account']] } },
  },
  'qoder': { name: 'Qoder CLI', kind: 'acp', command: 'qodercli', commands: ['qodercli', 'qoder', 'qoderclicn', 'qodercn', 'qoder-cn'], args: ['--acp'], version: ['--version'], signIn: 'qodercli', signInBy: { qoderclicn: 'qoderclicn', qodercn: 'qoderclicn', 'qoder-cn': 'qoderclicn' } },
  'minimax-code': { name: 'MiniMax Code', kind: 'acp', command: 'mcode', args: ['acp'], version: ['--version'], signIn: 'mcode' },
  'glm-cli': { name: 'GLM Agent', kind: 'acp', command: 'glm-acp-agent', args: [], version: ['--version'], signIn: 'glm-acp-agent --setup' },
  'kiro-cli': { name: 'Kiro CLI', kind: 'acp', command: 'kiro-cli', args: ['acp'], version: ['--version'], signIn: 'kiro-cli login' },
  'factory-droid': { name: 'Factory Droid', kind: 'acp', command: 'droid', args: ['exec', '--output-format', 'acp-daemon'], version: ['--version'], signIn: 'droid' },
  'auggie': { name: 'Auggie CLI', kind: 'acp', command: 'auggie', args: ['--acp'], version: ['--version'], signIn: 'auggie login' },
  'mistral-vibe': { name: 'Mistral Vibe', kind: 'acp', command: 'vibe-acp', args: [], version: ['--version'], signIn: 'vibe' },
  'junie': { name: 'Junie', kind: 'acp', command: 'junie', args: ['--acp=true'], version: ['--version'], signIn: 'junie' },
  'iflow': { name: 'iFlow CLI', kind: 'acp', command: 'iflow', args: ['--experimental-acp'], version: ['--version'], signIn: 'iflow' },
}

// route -> engine, e.g. 'local-codex-cli'. `id` is the CLI's name without the prefix.
export const ENGINES = Object.fromEntries(Object.entries(CLIS).map(([id, spec]) => [`${ROUTE_PREFIX}${id}`, { ...spec, id }]))

function quotePosixDouble(value) {
  return `"${String(value).replace(/[\\"$`]/g, '\\$&')}"`
}

function quotePowerShellDouble(value) {
  return `"${String(value).replace(/["`$]/g, '`$&')}"`
}

// An engine found under another product's command (Qoder CN) signs in through that command.
// Isolated profile specs include their config directory environment variable so the user
// signs into that profile instead of the default global account.
export function signInFor(spec, path, { platform = process.platform } = {}) {
  const command = typeof path === 'string' ? win32.basename(path).replace(/\.(cmd|exe|bat|com)$/i, '') : undefined
  const base = spec?.signInBy?.[command] ?? spec?.signIn
  if (!base) return undefined
  if (spec?.profile === true && spec.profileEnvKey && spec.profileDir) {
    return platform === 'win32'
      ? `$env:${spec.profileEnvKey}=${quotePowerShellDouble(spec.profileDir)}; ${base}`
      : `${spec.profileEnvKey}=${quotePosixDouble(spec.profileDir)} ${base}`
  }
  return base
}

export const CUSTOM_PREFIX = `${ROUTE_PREFIX}acp-`

export const isValidProfileId = id => typeof id === 'string' && PROFILE_ID_RE.test(id)

export function profileRoute(baseRoute, profileId) {
  if (ENGINES[baseRoute] === undefined) throw new Error(`Unknown built-in local agent: ${baseRoute}`)
  if (!isValidProfileId(profileId)) throw new Error('Profile ID must use lowercase letters, digits, hyphens, or underscores')
  return `${baseRoute}${PROFILE_SEPARATOR}${profileId}`
}

export function splitProfileRoute(route) {
  if (typeof route !== 'string') return null
  const at = route.indexOf(PROFILE_SEPARATOR)
  if (at <= 0 || route.indexOf(PROFILE_SEPARATOR, at + 1) !== -1) return null
  const baseRoute = route.slice(0, at)
  const profileId = route.slice(at + 1)
  if (ENGINES[baseRoute] === undefined || !isValidProfileId(profileId)) return null
  return { baseRoute, profileId }
}

export const isProfileRoute = route => splitProfileRoute(route) !== null

export function profileEnvKeyFor(baseRoute) {
  if (baseRoute === 'local-claude-code') return 'CLAUDE_CONFIG_DIR'
  if (baseRoute === 'local-codex-cli') return 'CODEX_HOME'
  return 'XDG_CONFIG_HOME'
}

export function isBlockedProfileEnvKey(key) {
  const upper = String(key ?? '').toUpperCase()
  return /^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_\d+)$/.test(upper)
    || BLOCKED_PROFILE_ENV.has(upper)
    || BLOCKED_PROFILE_ENV_PREFIX.some(prefix => upper.startsWith(prefix))
}

export function validateProfileEnv(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Environment overrides must be a key-value object')
  const clean = {}
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = String(rawKey).trim()
    if (!ENV_KEY_RE.test(key)) throw new Error(`Invalid environment variable name: ${key}`)
    if (isBlockedProfileEnvKey(key)) throw new Error(`Environment variable ${key} cannot be overridden in a profile`)
    if (typeof rawValue !== 'string' || rawValue.includes('\0') || /[\r\n]/.test(rawValue)) throw new Error(`Invalid value for environment variable ${key}`)
    clean[key] = rawValue
  }
  return clean
}

export function profileEnvFor(baseRoute, profileDir, extraEnv = {}) {
  if (ENGINES[baseRoute] === undefined) throw new Error(`Unknown built-in local agent: ${baseRoute}`)
  const env = validateProfileEnv(extraEnv)
  if (typeof profileDir === 'string' && profileDir.trim() !== '') {
    env[profileEnvKeyFor(baseRoute)] = profileDir
  }
  return env
}

export function defaultProfileDir(home, baseRoute, profileId) {
  if (typeof home !== 'string' || home.trim() === '') throw new Error('DS Bot home directory is required for default profile paths')
  const base = ENGINES[baseRoute]
  if (base === undefined) throw new Error(`Unknown built-in local agent: ${baseRoute}`)
  if (!isValidProfileId(profileId)) throw new Error('Invalid profile ID')
  const root = resolve(home, 'cli-profiles')
  const target = resolve(root, `${base.id}-${profileId}`)
  // Defense in depth: ensure the derived folder stays strictly inside `<home>/cli-profiles/`.
  if (!target.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`) && !target.startsWith(`${root}/`)) {
    throw new Error('Derived profile directory escaped cli-profiles root')
  }
  return target
}

export function ensureProfileDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch {}
  return dir
}

export function slugifyProfileId(name, existingIds = new Set()) {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+|[-_]+$/g, '')
    .slice(0, 24)
  const seed = base !== '' && isValidProfileId(base) ? base : 'profile'
  if (!existingIds.has(seed)) return seed
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${seed.slice(0, 27)}-${n}`
    if (!existingIds.has(candidate)) return candidate
  }
  return `p-${Date.now().toString(36)}`
}

export function validateProfile({ id, baseRoute, name, configDir, env }, { existingIds } = {}) {
  const cleanBase = String(baseRoute ?? '').trim()
  if (ENGINES[cleanBase] === undefined) throw new Error('Choose a built-in local agent')
  const cleanName = String(name ?? '').trim().slice(0, 32)
  if (cleanName === '') throw new Error('Profile name is required')
  let cleanId
  if (id !== undefined && String(id).trim() !== '') {
    cleanId = String(id).trim().toLowerCase()
    if (!isValidProfileId(cleanId)) throw new Error('Profile ID must start with a lowercase letter or digit and use only a-z, 0-9, -, _')
  } else {
    cleanId = slugifyProfileId(cleanName, existingIds)
  }
  let cleanDir
  if (configDir !== undefined && configDir !== null && String(configDir).trim() !== '') {
    const raw = String(configDir).trim()
    if (raw.includes('\0') || /[\r\n]/.test(raw)) throw new Error('Profile folder must not contain newlines')
    const expanded = raw.startsWith('~/') || raw.startsWith('~\\') ? join(homedir(), raw.slice(2)) : raw
    if (!isAbsolute(expanded)) throw new Error('Profile folder must be an absolute path')
    const resolved = resolve(expanded)
    if (resolved === parse(resolved).root || resolved === resolve(homedir())) {
      throw new Error('Profile folder must be a dedicated subfolder, not the root or home directory')
    }
    cleanDir = resolved
  }
  const cleanEnv = validateProfileEnv(env)
  return {
    id: cleanId,
    baseRoute: cleanBase,
    name: cleanName,
    ...(cleanDir !== undefined ? { configDir: cleanDir } : {}),
    ...(Object.keys(cleanEnv).length > 0 ? { env: cleanEnv } : {}),
  }
}

// LEGACY: the route a ref saved before the prefix names, or undefined when its
// provider was never a local-agent route. Some of those names are also provider
// ids DSH or another plugin ships, so an old `<name>/...` ref is ambiguous: the
// caller decides on evidence. `qoder` is one too — dsh-connect-qoder registers a
// provider called `qoder` for the same models the Qoder CLI offers. `antigravity`
// is one too — dsh-llm-antigravity-acp registers a provider called `antigravity`
// for the same models the Antigravity CLI offers.
const OLD_CUSTOM_PREFIX = 'acp-'
export const AMBIGUOUS_OLD_ROUTES = new Set(['opencode', 'qoder', 'antigravity'])
export const legacyRoute = (provider) => {
  if (typeof provider !== 'string') return undefined
  if (CLIS[provider] !== undefined) return `${ROUTE_PREFIX}${provider}`
  if (provider.startsWith(OLD_CUSTOM_PREFIX)) return `${ROUTE_PREFIX}${provider}`
  return undefined
}

// A custom ACP agent's route id from its list position (stable across edits).
export const customRoute = (id) => `${CUSTOM_PREFIX}${id}`

export function engineOf(route, custom = [], profiles = [], { home } = {}) {
  if (ENGINES[route] !== undefined) return ENGINES[route]
  if (route.startsWith(CUSTOM_PREFIX)) {
    const entry = custom.find(agent => agent.id === route.slice(CUSTOM_PREFIX.length))
    if (entry !== undefined) return { name: entry.name, kind: 'acp', command: entry.command, args: entry.args ?? [], custom: true }
  }
  const split = splitProfileRoute(route)
  if (split !== null) {
    const entry = profiles.find(profile => profile?.baseRoute === split.baseRoute && profile?.id === split.profileId)
    if (entry !== undefined) {
      const base = ENGINES[split.baseRoute]
      const profileDir = entry.configDir ?? (home ? defaultProfileDir(home, split.baseRoute, split.profileId) : undefined)
      const profileEnvKey = profileEnvKeyFor(split.baseRoute)
      const env = { ...base.env, ...profileEnvFor(split.baseRoute, profileDir, entry.env) }
      return {
        ...base,
        name: `${base.name} (${entry.name})`,
        baseRoute: split.baseRoute,
        profileId: split.profileId,
        profileName: entry.name,
        profileDir,
        profileEnvKey,
        env,
        profile: true,
      }
    }
  }
  return undefined
}

export const isLocalAgentRoute = route => typeof route === 'string' && (ENGINES[route] !== undefined || route.startsWith(CUSTOM_PREFIX) || isProfileRoute(route))

// A custom agent the user typed: a bare command name, an absolute path or
// ~/path; args without NUL or newlines (they would smuggle extra arguments).
export function validateCustom({ name, command, args }) {
  const clean = {
    name: String(name ?? '').trim().slice(0, 40),
    command: String(command ?? '').trim(),
    args: (Array.isArray(args) ? args : String(args ?? '').split(' ')).map(arg => String(arg).trim()).filter(Boolean),
  }
  if (clean.name === '') throw new Error('Name is required')
  if (clean.command === '' || /[\s]/.test(clean.command) || !(clean.command.startsWith('/') || clean.command.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(clean.command) || /^[\w.-]+$/.test(clean.command))) {
    throw new Error('Command must be a program name, an absolute path, or a ~/path')
  }
  if (clean.args.some(arg => arg.includes('\0') || /[\r\n]/.test(arg))) throw new Error('Arguments must not contain newlines')
  return clean
}

// The permission preset DS Bot gives the Bot, mapped to each driver's mode.
// An ACP agent that lists its modes gets one of them or none: an agent with no
// matching mode keeps its own (see acp.js).
export const MODES = {
  'read-only': { acp: ['ask', 'plan', 'read-only', 'readonly'], claude: 'plan', codex: 'read-only' },
  'workspace-write': { acp: ['accept-edits', 'accept_edits', 'acceptEdits'], claude: 'acceptEdits', codex: 'workspace-write' },
  'danger-full-access': { acp: ['bypass', 'bypassPermissions', 'bypass-permissions', 'yolo', 'full-access', 'auto-approve'], claude: 'bypassPermissions', codex: 'danger-full-access' },
}
export const acpMode = (preset, advertised, modes) => {
  const wanted = modes?.[preset] ?? MODES[preset]?.acp ?? []
  const ids = (advertised ?? []).map(option => option.id ?? option.value ?? option)
  return ids.length === 0 ? wanted[0] : wanted.find(id => ids.includes(id))
}
// Codex and Claude take a fixed mode; an ACP engine maps the preset itself once
// its session lists the modes (acpMode).
export const cliMode = (kind, preset) => (kind === 'acp' ? undefined : MODES[preset]?.[kind])
