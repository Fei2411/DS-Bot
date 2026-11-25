// Earlier desktop builds mounted @deepseek-ai/dsh-web-app and wrote
// `<DSH_HOME>/profiles/app-onboarding.patch.yml` to disable DSH Web's
// `ui-settings-models` credential onboarding modal. With DS Bot's own frontend
// (`dsbot-engine` + `app/ui/dist`) no DSH Web rows are mounted, so any leftover
// overlay from an earlier version is removed on launch.
import { dirname, join } from 'node:path'
import { rmSync } from 'node:fs'

export const APP_PATCH_NAME = 'app-onboarding.patch.yml'
export const APP_PATCH_ROWS = []

/**
 * Drop any stale DSH Web onboarding overlay left by an earlier build.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {string[]} its part of the `patchFiles` argument (empty for DS Bot's own frontend)
 */
export function writeAppPatch(profile) {
  const file = join(dirname(profile.dir), APP_PATCH_NAME)
  rmSync(file, { force: true })
  return []
}
