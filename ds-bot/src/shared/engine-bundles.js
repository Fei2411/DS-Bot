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

// DSH official bundles whose primary user-facing workflows depend on DSH Web UI surfaces
// (panels, drawers, action cards, upload dialogs) that DS Bot's standalone desktop frontend
// does not render. Several also register host-side services, routes, or tools, so on Desktop
// they are excluded from optional/discover lists when disabled, while any already-enabled
// bundle stays visible under Installed plugins so users can see and disable or remove it.
// Left untouched in the DSH plugin version.
export const DESKTOP_UNSUPPORTED_UI_BUNDLES = new Set([
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-experimental-liveshare',
  '@deepseek-ai/dsh-experimental-forge-bundle',
  '@deepseek-ai/dsh-personalized-recommendations',
  '@deepseek-ai/dsh-deepseek-chat-import',
])

const OFFICIAL_SUBAGENT_BUNDLE_RE = /^@deepseek-ai\/dsh-(?:experimental-)?subagent(?:$|-)/i

/**
 * Returns whether a DSH bundle package name should be hidden from the plugin list.
 * Pass `{ desktop: true, enabled }` in the standalone desktop app: disabled desktop-unsupported
 * bundles are hidden from discovery/optional lists, while already-enabled ones stay visible
 * so users can disable or remove them. Internal and banned bundles stay hidden unconditionally.
 */
export function isBlockedEngineBundle(name, { desktop = false, enabled = false } = {}) {
  if (typeof name !== 'string') return false
  const clean = name.trim()
  if (clean === '') return false
  if (HIDDEN_ENGINE_BUNDLES.has(clean) || BANNED_ENGINE_BUNDLES.has(clean) || OFFICIAL_SUBAGENT_BUNDLE_RE.test(clean)) {
    return true
  }
  return desktop && !enabled && DESKTOP_UNSUPPORTED_UI_BUNDLES.has(clean)
}
