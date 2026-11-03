// Reconcile C2 / #133: Bots run DS Bot's own group goal, and DSH's session
// goal does not survive conversation parts — in the app the `/goal` command,
// and its tool are dead weight. Removing them needs
// new rows in the bundled presets, which the app must not rewrite, so the
// Host restates the preset rows without the goal rows through a `--patch`
// overlay it writes into its own data area next to the profiles
// (`<DSH_HOME>/profiles/goal.patch.yml`): DSH reads it only through
// `patchFiles` and nothing scans this location. The composer's goal bar
// stays — a DSH goal left from before must still be pausable, and no new
// one can start without the command or the tool. Preset rows carry `!!js`
// expressions; the overlay keeps them by writing through the same
// entry-list dialect the include parses. This reconciliation runs on the
// next launch.
import { dirname, join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'

export const GOAL_PATCH_NAME = 'goal.patch.yml'

const PRESET = '@deepseek-ai/dsh-agent-preset'
const GOAL_ROWS = new Set(['@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-goal'])

// A group row keeps its child rows in `config`, a plain list.
const hasGoalRow = (rows) => rows.some(row => GOAL_ROWS.has(row?.name)
  || (row?.group === true && Array.isArray(row.config) && hasGoalRow(row.config)))

const stripGoalRows = (rows) => rows
  .map(row => (row?.group === true && Array.isArray(row.config)
    ? { ...row, config: stripGoalRows(row.config) }
    : row))
  .filter(row => GOAL_ROWS.has(row?.name) === false)

/**
 * The overlay rows that restate every preset carrying goal rows without them,
 * or `undefined` when no preset needs it. Composed over the bundles and the
 * profile's own patch, so user edits to a preset survive — minus the rows.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {import('@deepseek-ai/cordis-plugin-include').PatchOptions[] | undefined}
 */
export function goalPatch(profile) {
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  const rows = entries
    .filter(entry => entry.name === PRESET && Array.isArray(entry.config?.plugins) && hasGoalRow(entry.config.plugins))
    .map(entry => ({ id: entry.id, name: entry.name, config: { ...entry.config, plugins: stripGoalRows(entry.config.plugins) } }))
  return rows.length === 0 ? undefined : rows
}

/**
 * Write the goal overlay next to the profiles and report it for `patchFiles`;
 * when none is needed, drop a stale one from an earlier launch.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {string[]} the `patchFiles` argument for this launch
 */
export function reconcileGoal(profile) {
  const file = join(dirname(profile.dir), GOAL_PATCH_NAME)
  const rows = goalPatch(profile)
  if (rows === undefined) {
    rmSync(file, { force: true })
    return []
  }
  writeFileSync(file, dump(rows, { schema: entryListSchema }), 'utf8')
  return [file]
}
