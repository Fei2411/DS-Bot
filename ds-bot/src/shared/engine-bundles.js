// Shared blocklists for DSH engine bundles across DS Bot's Plugins catalog (`plugins-page.js`)
// and the desktop app's Engine plugins settings (`app/ui/src/engine-settings.js`).

// Internal DSH profiles and low-level engine bundles that must never surface in either list.
export const HIDDEN_ENGINE_BUNDLES = new Set([
  'dsbot-engine',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-tool-worktree',
])

// Bundles disallowed by DS Bot policy (subagent/delegation/agent-team/ralph).
export const BANNED_ENGINE_BUNDLES = new Set([
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
])

// DSH official bundles whose user-facing surfaces depend on DSH Web UI slots/panels that
// DS Bot's own desktop frontend intentionally does not render (no DSH UI plugin compat layer).
// Hidden only on the standalone desktop app; left untouched in the DSH plugin version.
export const DESKTOP_UNSUPPORTED_UI_BUNDLES = new Set([
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-experimental-liveshare',
  '@deepseek-ai/dsh-experimental-forge-bundle',
  '@deepseek-ai/dsh-personalized-recommendations',
  '@deepseek-ai/dsh-deepseek-chat-import',
])

/**
 * Returns whether a DSH bundle package name should be hidden from the plugin list.
 * Pass `{ desktop: true }` in the standalone desktop app to also hide DSH Web UI-only bundles.
 */
export function isBlockedEngineBundle(name, { desktop = false } = {}) {
  if (typeof name !== 'string') return false
  const clean = name.trim()
  if (clean === '') return false
  if (HIDDEN_ENGINE_BUNDLES.has(clean) || BANNED_ENGINE_BUNDLES.has(clean) || /subagent/i.test(clean)) {
    return true
  }
  return desktop && DESKTOP_UNSUPPORTED_UI_BUNDLES.has(clean)
}
