// DSH's scrubbedParentEnv() drops names matching /KEY|PASSWORD|SECRET|TOKEN/i,
// which strips GIT_CONFIG_KEY_n while leaving GIT_CONFIG_COUNT and GIT_CONFIG_VALUE_n,
// causing git to exit 128 (#2291). Remove the whole inherited command-line Git config
// group at child-env boundaries while keeping GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM.

export const INJECTED_GIT_CONFIG_ENV_RE = /^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_\d+)$/i

export function isInjectedGitConfigEnvKey(key) {
  return INJECTED_GIT_CONFIG_ENV_RE.test(String(key ?? ''))
}
