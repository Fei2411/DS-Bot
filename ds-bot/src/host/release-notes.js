// Host-side release-notes version resolution, pending calculation, and serialized claim.
import { readFileSync } from 'node:fs'
import { cleanSemver, compareSemver, pendingReleaseVersions } from '../shared/release-notes.js'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const PKG_VERSION = cleanSemver(PKG.version) ?? '0.0.0'

/** Prefer desktop app's explicit version env when present, falling back to ds-bot/package.json. */
export function resolveCurrentVersion(env = process.env, fallback = PKG_VERSION) {
  return cleanSemver(env?.DS_BOT_APP_VERSION) ?? cleanSemver(fallback) ?? PKG_VERSION
}

export function install(rt) {
  const { state, config } = rt
  let claimQueue = Promise.resolve()

  const currentReleaseVersion = () => resolveCurrentVersion(process.env, config?.appVersion ?? PKG_VERSION)

  const hasTeamContent = () =>
    rt.hasExistingTeamData?.() === true
    || Object.keys(state.bots ?? {}).length > 0
    || Object.keys(state.rooms ?? {}).length > 0
    || Object.keys(state.agents ?? {}).length > 0
    || (typeof state.workspaceId === 'string' && state.workspaceId !== '')

  const releaseNotesView = () => {
    const current = currentReleaseVersion()
    const lastSeenVersion = typeof state.lastSeenVersion === 'string' ? cleanSemver(state.lastSeenVersion) : null
    // A read-only window over a brand-new empty data dir must not treat empty state as an upgrade.
    const pending = lastSeenVersion === null && !hasTeamContent()
      ? []
      : pendingReleaseVersions({ current, lastSeenVersion })
    return { current, lastSeenVersion, pending }
  }

  const claimReleaseNotes = (requestedVersion) => {
    const requested = cleanSemver(requestedVersion)
    const current = currentReleaseVersion()
    if (requested === null || requested !== current) {
      return Promise.reject(Object.assign(new Error(`Expected current release version ${current}`), { code: 'bot/invalid' }))
    }
    const run = async () => {
      await rt.load()
      const liveCurrent = currentReleaseVersion()
      if (requested !== liveCurrent) {
        throw Object.assign(new Error(`Expected current release version ${liveCurrent}`), { code: 'bot/invalid' })
      }
      const lastSeen = typeof state.lastSeenVersion === 'string' ? cleanSemver(state.lastSeenVersion) : null
      if (lastSeen !== null && compareSemver(liveCurrent, lastSeen) <= 0) {
        return { claimed: false, version: liveCurrent }
      }
      if (lastSeen === null && !hasTeamContent()) {
        return { claimed: false, version: liveCurrent }
      }
      const pending = pendingReleaseVersions({ current: liveCurrent, lastSeenVersion: lastSeen })
      if (pending.length === 0) {
        return { claimed: false, version: liveCurrent }
      }
      const previous = state.lastSeenVersion
      state.lastSeenVersion = liveCurrent
      try {
        await rt.save({ required: true })
      } catch (error) {
        if (error?.code !== 'ELOCKLOST' && state.lastSeenVersion === liveCurrent) {
          if (previous === undefined) delete state.lastSeenVersion
          else state.lastSeenVersion = previous
        }
        throw error
      }
      return { claimed: true, version: liveCurrent }
    }
    const next = claimQueue.then(run, run)
    claimQueue = next.catch(() => {})
    return next
  }

  Object.assign(rt, { currentReleaseVersion, releaseNotesView, claimReleaseNotes })
}
