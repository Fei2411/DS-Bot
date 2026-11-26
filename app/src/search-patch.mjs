// Reconcile #128: turning off `web-search-auto` does not undo the `web` row's
// `searchProvider: auto`, which DS Bot's own patch selects for the profile — every
// search then fails with WEB_PROVIDER_CONFIGURED_MISSING. When the app's own bundles
// configured the selector before ds-bot arrived, restore that selection through a
// `--patch` overlay the app writes into its own data area next to the profiles
// (`<DSH_HOME>/profiles/search-selector.patch.yml`): DSH reads it only through
// `patchFiles` and nothing scans this location, so it cannot rewrite the profile or
// outlive the fix. The plugins page's toggle takes effect at once; this
// reconciliation runs on the next launch.
import { dirname, join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { stringify } from 'yaml'

export const SEARCH_PATCH_NAME = 'search-selector.patch.yml'

/**
 * The overlay rows that put the `web` row back on the app's own bundles'
 * selection, or `undefined` when none is needed.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {import('@deepseek-ai/cordis-plugin-include').PatchOptions[] | undefined}
 */
export function searchSelectorPatch(profile) {
  const layers = profile.layers
  const entries = composeEntries([...layers.map(layer => layer.patches), profile.patches])
  if (entries.find(entry => entry.id === 'web-search-auto')?.disabled !== true) return undefined
  const web = entries.find(entry => entry.id === 'web')
  if (web?.config?.searchProvider !== 'auto') return undefined
  // The web row as it composes from the bundles alone, before ds-bot's selection.
  // DSH 0.2.2-rc.5 omits `searchProvider` on `@deepseek-ai/dsh-base` so `dsh-web` selects by
  // model route; restoring that config clears `searchProvider: auto` via whole-config replacement.
  const base = layers.filter(({ packageName }) => packageName !== 'ds-bot')
  const original = composeEntries(base.map(layer => layer.patches)).find(entry => entry.id === 'web')
  if (original === undefined || original.config?.searchProvider === 'auto') return undefined
  return [{ id: 'web', name: original.name, config: original.config ?? {} }]
}

/**
 * Write the reconciliation overlay next to the profiles and report it for
 * `patchFiles`; when none is needed, drop a stale one from an earlier launch.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {string[]} the `patchFiles` argument for this launch
 */
export function reconcileSearchSelector(profile) {
  const file = join(dirname(profile.dir), SEARCH_PATCH_NAME)
  const rows = searchSelectorPatch(profile)
  if (rows === undefined) {
    rmSync(file, { force: true })
    return []
  }
  writeFileSync(file, stringify(rows), 'utf8')
  return [file]
}
