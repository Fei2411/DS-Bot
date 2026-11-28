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
  const web = entries.find(entry => entry.id === 'web')
  const searchDisabled = entries.find(entry => entry.id === 'web-search-auto')?.disabled === true
  const fetchDisabled = entries.find(entry => entry.id === 'web-fetch-auto')?.disabled === true
  const searchStale = searchDisabled && web?.config?.searchProvider === 'auto'
  const fetchStale = fetchDisabled && web?.config?.fetchProvider === 'auto'
  if (!searchStale && !fetchStale) return undefined
  // The web row as it composes from the bundles alone, before ds-bot's selection.
  // DSH 0.2.2-rc.5 omits `searchProvider` on `@deepseek-ai/dsh-base` so `dsh-web` selects by
  // model route, and defaults `fetchProvider` to `http`; restoring either clears the stale
  // `auto` selection via whole-config replacement while keeping the other provider intact.
  const base = layers.filter(({ packageName }) => packageName !== 'ds-bot')
  const original = composeEntries(base.map(layer => layer.patches)).find(entry => entry.id === 'web')
  if (original === undefined) return undefined
  const fixSearch = searchStale && original.config?.searchProvider !== 'auto'
  const fixFetch = fetchStale && original.config?.fetchProvider !== 'auto'
  if (!fixSearch && !fixFetch) return undefined
  const nextConfig = { ...(web?.config ?? {}) }
  if (fixSearch) {
    if (original.config?.searchProvider !== undefined) nextConfig.searchProvider = original.config.searchProvider
    else delete nextConfig.searchProvider
  }
  if (fixFetch) {
    if (original.config?.fetchProvider !== undefined) nextConfig.fetchProvider = original.config.fetchProvider
    else delete nextConfig.fetchProvider
  }
  return [{ id: 'web', name: original.name, config: nextConfig }]
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
