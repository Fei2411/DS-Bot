// The engines a local agent can run on. Each entry names its route, its display
// name, how it starts, and which driver speaks its protocol: 'acp' (Agent
// Client Protocol over stdio), 'codex' (the Codex app-server JSON-RPC), or
// 'claude' (Claude Code's stream-json).
export const KINDS = ['acp', 'codex', 'claude']

// `args` run verbatim (no shell). `env` merges over the sanitized environment.
// `signedIn` says how to tell whether the CLI is signed in: a command that prints
// it, or a credential file under the home folder (see probeSignIn).
// Local-agent routes live under their own prefix. Before it they shared the
// provider namespace, so a CLI named like a provider DSH or another plugin
// ships (`opencode`) took that provider's name and the LLM service failed to
// load with a duplicate adapter.
export const ROUTE_PREFIX = 'local-'

const CLIS = {
  'devin-cli': { name: 'Devin CLI', kind: 'acp', command: 'devin', args: ['acp'], version: ['--version'], signedIn: { args: ['auth', 'status'] } },
  'claude-code': { name: 'Claude Code', kind: 'claude', command: 'claude', args: [], version: ['--version'], signedIn: { file: ['.claude', '.credentials.json'] } },
  'codex-cli': { name: 'Codex CLI', kind: 'codex', command: 'codex', args: ['app-server', '--listen', 'stdio://'], version: ['--version'], signedIn: { args: ['login', 'status'] } },
  'opencode': { name: 'OpenCode', kind: 'acp', command: 'opencode', args: ['acp'], version: ['--version'] },
  'cursor-cli': { name: 'Cursor CLI', kind: 'acp', command: 'cursor-agent', args: ['acp'], version: ['--version'], signedIn: { args: ['status'] } },
  'gemini-cli': { name: 'Gemini CLI', kind: 'acp', command: 'gemini', args: ['--acp'], version: ['--version'], signedIn: { file: ['.gemini', 'oauth_creds.json'] } },
  'grok-cli': { name: 'Grok CLI', kind: 'acp', command: 'grok', args: ['agent', 'stdio'], version: ['--version'] },
  'cline': { name: 'Cline', kind: 'acp', command: 'cline', args: ['--acp'], version: ['--version'], env: { CLINE_SESSION_BACKEND_MODE: 'local' } },
  'qwen-code': { name: 'Qwen Code', kind: 'acp', command: 'qwen', args: ['--acp'], version: ['--version'], signedIn: { file: ['.qwen', 'oauth_creds.json'] } },
  'goose': { name: 'Goose', kind: 'acp', command: 'goose', args: ['acp'], version: ['--version'] },
}

// route -> engine, e.g. 'local-codex-cli'. `id` is the CLI's name without the prefix.
export const ENGINES = Object.fromEntries(Object.entries(CLIS).map(([id, spec]) => [`${ROUTE_PREFIX}${id}`, { ...spec, id }]))

export const CUSTOM_PREFIX = `${ROUTE_PREFIX}acp-`

// LEGACY: the route a ref saved before the prefix names, or undefined when its
// provider was never a local-agent route. `opencode` is also a provider DSH
// ships, so an old `opencode/...` ref is ambiguous: the caller decides.
const OLD_CUSTOM_PREFIX = 'acp-'
export const AMBIGUOUS_OLD_ROUTES = new Set(['opencode'])
export const legacyRoute = (provider) => {
  if (typeof provider !== 'string') return undefined
  if (CLIS[provider] !== undefined) return `${ROUTE_PREFIX}${provider}`
  if (provider.startsWith(OLD_CUSTOM_PREFIX)) return `${ROUTE_PREFIX}${provider}`
  return undefined
}

// A custom ACP agent's route id from its list position (stable across edits).
export const customRoute = (id) => `${CUSTOM_PREFIX}${id}`

export function engineOf(route, custom = []) {
  if (ENGINES[route] !== undefined) return ENGINES[route]
  if (route.startsWith(CUSTOM_PREFIX)) {
    const entry = custom.find(agent => agent.id === route.slice(CUSTOM_PREFIX.length))
    if (entry !== undefined) return { name: entry.name, kind: 'acp', command: entry.command, args: entry.args ?? [], custom: true }
  }
  return undefined
}

export const isLocalAgentRoute = route => typeof route === 'string' && (ENGINES[route] !== undefined || route.startsWith(CUSTOM_PREFIX))

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
  'read-only': { acp: ['ask', 'plan'], claude: 'plan', codex: 'read-only' },
  'workspace-write': { acp: ['accept-edits', 'accept_edits', 'acceptEdits'], claude: 'acceptEdits', codex: 'workspace-write' },
  'danger-full-access': { acp: ['bypass', 'bypassPermissions', 'bypass-permissions'], claude: 'bypassPermissions', codex: 'danger-full-access' },
}
export const acpMode = (preset, advertised) => {
  const wanted = MODES[preset]?.acp ?? []
  const ids = (advertised ?? []).map(option => option.id ?? option.value ?? option)
  return ids.length === 0 ? wanted[0] : wanted.find(id => ids.includes(id))
}
// Codex and Claude take a fixed mode; an ACP engine maps the preset itself once
// its session lists the modes (acpMode).
export const cliMode = (kind, preset) => (kind === 'acp' ? undefined : MODES[preset]?.[kind])
