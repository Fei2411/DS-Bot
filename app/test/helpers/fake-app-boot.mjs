// The boot of the profile, as a test double: the version of DSH the app reports, and the
// parts of a profile the app asks for. The app's own main process never calls them.
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'

export const getDshRuntimeVersion = () => ({ release: { version: '0.2.1-rc.4' } })
export const loadLayeredEnv = () => ({})
export const reportSkippedBundles = () => {}
export const initProfile = () => {}
export const loadProfileDirectory = () => ({})
export const readProfileManifest = () => ({ dsh: { profile: { bundles: [] } } })
export const resolveProfileDir = (name) => name
export const writeProfileBundles = () => {}
// The real composeEntries applies each patch list by row id onto an empty entry
// list; the doubles must keep that semantics so patches that restate rows
// (search selector, goal presets) compose exactly like a launch.
export const composeEntries = (entries) => applyEntryPatches([], structuredClone(entries.flat()), () => {})
