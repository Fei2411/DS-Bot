// DSH's scrubbedParentEnv() drops names matching /KEY|PASSWORD|SECRET|TOKEN/i,
// which strips GIT_CONFIG_KEY_n while leaving GIT_CONFIG_COUNT and GIT_CONFIG_VALUE_n,
// causing git to exit 128 (#2291). Remove the whole inherited command-line Git config
// group while DS Bot is active so every DSH subprocess sees a consistent environment.

export const INJECTED_GIT_CONFIG_ENV_RE = /^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_\d+)$/i

const STATE_KEY = Symbol.for('ds-bot.gitConfigEnvGuard.state')

function stateMap() {
  globalThis[STATE_KEY] ??= new WeakMap()
  return globalThis[STATE_KEY]
}

export function isInjectedGitConfigEnvKey(key) {
  return INJECTED_GIT_CONFIG_ENV_RE.test(String(key ?? ''))
}

export function installGitConfigEnvGuard(env = process.env) {
  if (env === null || typeof env !== 'object') return () => {}
  const map = stateMap()
  let record = map.get(env)
  if (record === undefined) {
    record = { owners: new Set(), saved: new Map() }
    map.set(env, record)
  }
  for (const [key, value] of Object.entries(env)) {
    if (!isInjectedGitConfigEnvKey(key)) continue
    if (!record.saved.has(key) && value !== undefined) record.saved.set(key, value)
    delete env[key]
  }
  const release = () => {
    if (!record.owners.delete(release) || record.owners.size > 0) return
    map.delete(env)
    const present = new Set(Object.keys(env).map(key => key.toUpperCase()))
    for (const [key, value] of record.saved) {
      if (!present.has(key.toUpperCase())) env[key] = value
    }
  }
  record.owners.add(release)
  return release
}
