// Desktop-only lazy entry for SettingsDialog so Settings code is never parsed during
// cold start until the user opens Settings.
import { createElement as h, Suspense, lazy } from 'react'

const LazySettingsDialog = lazy(() =>
  import('../../../ds-bot/src/client/settings.js').then(mod => ({ default: mod.SettingsDialog })),
)

export function SettingsDialog(props) {
  return h(Suspense, { fallback: null }, h(LazySettingsDialog, props))
}
