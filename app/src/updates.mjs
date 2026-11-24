// Windows and a Linux AppImage download and install updates; macOS and a Linux deb ask before
// opening the release page. main.mjs asks the questions, in the dialog.update.* copy of
// start/text.mjs.

const CHECK_EVERY_MS = 4 * 60 * 60_000
export const RELEASES_URL = 'https://api.github.com/repos/Fei2411/DS-Bot/releases?per_page=20'
// Where a user downloads the newest version by hand.
export const RELEASE_PAGE = 'https://github.com/Fei2411/DS-Bot/releases/latest'
const MB = 1024 * 1024

function parseVersion(version) {
  if (typeof version !== 'string') return null
  const value = version.replace(/^v/u, '')
  const separator = value.indexOf('-')
  const core = separator < 0 ? value : value.slice(0, separator)
  const pre = separator < 0 ? null : value.slice(separator + 1).split('.')
  const parts = core.split('.')
  if (parts.length > 3 || parts.some(part => !/^\d+$/u.test(part)) || pre?.some(part => part === '')) return null
  return {
    core: [0, 1, 2].map(index => (index < parts.length ? BigInt(parts[index]) : 0n)),
    pre,
  }
}

export function isNewer(candidate, current) {
  const newer = parseVersion(candidate)
  const older = parseVersion(current)
  if (newer === null || older === null) return false
  for (let index = 0; index < 3; index += 1) {
    if (newer.core[index] !== older.core[index]) return newer.core[index] > older.core[index]
  }
  if (newer.pre === null) return older.pre !== null
  if (older.pre === null) return false
  for (let index = 0; index < Math.max(newer.pre.length, older.pre.length); index += 1) {
    const left = newer.pre[index]
    const right = older.pre[index]
    if (left === undefined) return false
    if (right === undefined) return true
    if (left === right) continue
    const leftNumeric = /^\d+$/u.test(left)
    const rightNumeric = /^\d+$/u.test(right)
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right)
    if (leftNumeric !== rightNumeric) return !leftNumeric
    return left > right
  }
  return false
}

function isHttpsPage(page) {
  if (typeof page !== 'string') return false
  try {
    return new URL(page).protocol === 'https:'
  } catch {
    return false
  }
}

// The About row shows the checker's phase: idle | checking → current | downloading →
// downloaded | available | failed. While a check, a download or a ready install is on, a
// new check must not start, so `check()` is a no-op in those phases.
const UPDATE_BUSY = new Set(['checking', 'downloading', 'downloaded'])

function stateHolder(log, initial = { phase: 'checking' }) {
  let state = initial
  const listeners = new Set()
  return {
    state: () => state,
    set: (next) => {
      state = next
      for (const listener of [...listeners]) {
        try { listener(next) } catch (error) { log.error(`DS Bot: an update state listener failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

// `asset` names the release asset of this install (default: the macOS zip); a release without
// it does not count.
export function watchReleases({ current, arch, fetch = globalThis.fetch, ask, open, feed = RELEASES_URL, log = console, asset, autoUpdate = true }) {
  const assetName = asset ?? (version => `DS-Bot-${version}-mac-${arch}.zip`)
  let auto = autoUpdate !== false
  let timer = null
  let asked
  let latest = Promise.resolve(null)
  const holder = stateHolder(log, { phase: auto ? 'checking' : 'idle', autoUpdate: auto })
  const set = (next) => { holder.set({ ...next, autoUpdate: auto }) }
  const run = ({ manual = false } = {}) => {
    set({ phase: 'checking' })
    latest = (async () => {
      try {
        const response = await fetch(feed, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': `DS-Bot/${current}` },
        })
        if (!response.ok) {
          log.error(`DS Bot: update check failed: HTTP ${String(response.status)}`)
          set({ phase: 'failed' })
          return null
        }
        const releases = await response.json()
        if (!Array.isArray(releases)) {
          log.error('DS Bot: update check failed: releases response is not an array')
          set({ phase: 'failed' })
          return null
        }
        const currentVersion = parseVersion(current)
        const allowPrerelease = currentVersion !== null && currentVersion.pre !== null
        let found
        for (const release of releases) {
          if (release === null || typeof release !== 'object' || release.draft === true
            || (release.prerelease === true && !allowPrerelease)) continue
          const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/u, '') : ''
          if (!isNewer(version, current)) continue
          if (!Array.isArray(release.assets) || !release.assets.some(entry => entry?.name === assetName(version))) continue
          if (!isHttpsPage(release.html_url)) {
            log.error('DS Bot: update check failed: release page URL is not HTTPS')
            continue
          }
          if (found === undefined || isNewer(version, found.version)) found = { version, page: release.html_url }
        }
        if (found === undefined) {
          set({ phase: 'current' })
          return null
        }
        log.info(`DS Bot: update ${found.version} available`)
        if (!manual && auto && ask !== undefined && asked !== found.version) {
          const { version, page } = found
          void Promise.resolve().then(() => {
            if (!auto || asked === version) return false
            asked = version
            return ask(version)
          })
            .then(yes => (yes && auto ? open(page) : undefined))
            .catch((error) => { log.error(`DS Bot: update ${version} not opened: ${error instanceof Error ? error.message : String(error)}`) })
        }
        set({ phase: 'available', version: found.version, page: found.page })
        return found
      } catch (error) {
        log.error(`DS Bot: update check failed: ${error instanceof Error ? error.message : String(error)}`)
        set({ phase: 'failed' })
        return null
      }
    })()
  }
  const stopTimer = () => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }
  const startTimer = () => {
    if (timer !== null || !auto) return
    timer = setInterval(() => { if (auto && !UPDATE_BUSY.has(holder.state().phase)) run({ manual: false }) }, CHECK_EVERY_MS)
    timer.unref?.()
  }
  // A manual check only starts when none is on, and leaves the About row to offer the download.
  const check = () => { if (!UPDATE_BUSY.has(holder.state().phase)) run({ manual: true }) }
  const setAutoUpdate = (enabled) => {
    const next = Boolean(enabled)
    if (next === auto) return holder.state()
    auto = next
    if (auto) startTimer()
    else {
      stopTimer()
      latest = Promise.resolve(null)
    }
    const phase = holder.state().phase
    if (auto && (phase === 'idle' || phase === 'failed')) run({ manual: false })
    else set(holder.state())
    return holder.state()
  }
  if (auto) {
    run({ manual: false })
    startTimer()
  }
  return { stop: stopTimer, latest: () => latest, state: holder.state, subscribe: holder.subscribe, check, setAutoUpdate }
}

/**
 * @param {{
 *   updater: import('electron-updater').AppUpdater,
 *   beforeInstall: () => Promise<void>,
 *   ask?: (version: string) => Promise<boolean>,
 *   feed?: string,
 *   log?: Pick<Console, 'info' | 'error'>,
 *   autoUpdate?: boolean,
 * }} options `ask` answers whether to restart now; without it the update waits for the next
 *   quit. `beforeInstall` stops the Host, which runs from the files the installer replaces.
 *   `feed` is a folder URL with a latest.yml, in place of the GitHub releases.
 * @returns {{
 *   stop: () => void,
 *   latest: () => Promise<{ version: string, downloaded: Promise<boolean> } | null>,
 *   install: () => Promise<void>,
 *   download: () => void,
 *   state: () => { phase: string, version?: string, page?: string, percent?: number, received?: number, total?: number, canDownload?: boolean, autoInstall?: boolean, autoUpdate: boolean },
 *   subscribe: (listener: (state: { phase: string, autoUpdate: boolean }) => void) => () => void,
 *   check: () => void,
 *   setAutoUpdate: (enabled: boolean) => { phase: string, autoUpdate: boolean },
 * }} `latest` is what the newest check found: the version and whether its download finished.
 *   `install` stops the Host and runs the installer, which opens the app again. `state` is
 *   the phase the About row shows, with the download's per cent and MB while it downloads;
 *   `check` runs the same check the timer does and does nothing while a check, a download or a
 *   ready install is on.
 */
export function watchUpdates({ updater, beforeInstall, ask, feed, log = console, autoUpdate = true }) {
  let auto = autoUpdate !== false
  let timer = null
  let activeCancel = null
  let activeDownload = null
  let cancelling = null
  let manualDownload = false
  let autoInstallReady = false
  updater.autoDownload = auto
  updater.autoInstallOnAppQuit = auto
  if (feed) updater.setFeedURL({ provider: 'generic', url: feed })
  const holder = stateHolder(log, { phase: auto ? 'checking' : 'idle', autoUpdate: auto })
  const set = (next) => { holder.set({ ...next, autoUpdate: auto }) }
  const cancelBackgroundDownload = (cancel, downloadPromise) => {
    if (downloadPromise) {
      const wait = Promise.resolve(downloadPromise).catch(() => {})
      cancelling = wait
      void wait.finally(() => { if (cancelling === wait) cancelling = null })
    }
    try { cancel?.cancel?.() } catch { /* ignore */ }
  }
  const install = async () => {
    await beforeInstall()
    updater.quitAndInstall(true, true)
  }
  let asked
  updater.on('checking-for-update', () => {
    const current = holder.state()
    if (current.phase === 'checking' && current.autoUpdate === auto) return
    set({ phase: 'checking' })
  })
  updater.on('update-not-available', () => {
    activeCancel = null
    activeDownload = null
    set({ phase: 'current' })
  })
  updater.on('update-available', (info) => {
    if (auto && updater.autoDownload) set({ phase: 'downloading', version: info?.version })
    else set({ phase: 'available', version: info?.version, canDownload: true })
  })
  // The download's progress, for the failure page's update banner: once per whole per cent.
  updater.on('download-progress', (progress) => {
    if (cancelling !== null) return
    const current = holder.state()
    const percent = Math.floor(Number(progress?.percent))
    if (current.phase !== 'downloading' || !Number.isFinite(percent) || percent === current.percent) return
    set({ ...current, percent, received: Math.round(Number(progress.transferred) / MB) || 0, total: Math.round(Number(progress.total) / MB) || 0 })
  })
  updater.on('update-downloaded', ({ version }) => {
    activeCancel = null
    activeDownload = null
    manualDownload = false
    // electron-updater adds its quit handler at most once per process, and only when
    // autoInstallOnAppQuit is true at download time; once registered, the quit handler stays
    // armed and reads autoInstallOnAppQuit dynamically at quit.
    autoInstallReady = autoInstallReady || updater.autoInstallOnAppQuit === true
    log.info(`DS Bot: update ${version} downloaded`)
    set({ phase: 'downloaded', version, autoInstall: auto && autoInstallReady })
    if (!auto || ask === undefined || asked === version) return
    asked = version
    void ask(version).then(now => (now ? install() : undefined))
      .catch((error) => { log.error(`DS Bot: update ${version} not installed: ${error instanceof Error ? error.message : String(error)}`) })
  })
  // A downloaded update stays ready: a later failed check does not hide it.
  updater.on('error', (error) => {
    activeCancel = null
    activeDownload = null
    manualDownload = false
    log.error(`DS Bot: update failed: ${error instanceof Error ? error.message : String(error)}`)
    if (holder.state().phase !== 'downloaded') set({ phase: 'failed' })
  })
  let latest = Promise.resolve(null)
  // A failed check or download also comes as an 'error' event.
  // The events normally move the phase; a check that settles without one must not leave it
  // on `checking`, or the busy guard would also stop the timer's checks.
  const settled = (next) => { if (holder.state().phase === 'checking') set(next) }
  const run = () => {
    const prev = holder.state()
    if (prev.phase !== 'checking' || prev.autoUpdate !== auto) set({ phase: 'checking' })
    latest = updater.checkForUpdates().then((result) => {
      const version = result?.updateInfo?.version
      activeCancel = result?.cancellationToken ?? null
      activeDownload = result?.downloadPromise ?? null
      if (result?.isUpdateAvailable && result.downloadPromise) {
        if (!auto && !manualDownload) {
          const cancel = activeCancel
          const dl = activeDownload
          activeCancel = null
          activeDownload = null
          cancelBackgroundDownload(cancel, dl)
          if (holder.state().phase !== 'downloaded') set(version ? { phase: 'available', version, canDownload: true } : { phase: 'idle' })
          return null
        }
        settled({ phase: 'downloading', version })
        return { version, downloaded: result.downloadPromise.then(() => true, () => false) }
      }
      if (result?.isUpdateAvailable) {
        activeDownload = null
        settled({ phase: 'available', version, canDownload: true })
        return null
      }
      activeCancel = null
      activeDownload = null
      settled({ phase: 'current' })
      return null
    }, () => { activeCancel = null; activeDownload = null; settled({ phase: 'failed' }); return null })
  }
  const stopTimer = () => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }
  const startTimer = () => {
    if (timer !== null || !auto) return
    timer = setInterval(() => { if (auto && !UPDATE_BUSY.has(holder.state().phase)) run() }, CHECK_EVERY_MS)
    timer.unref?.()
  }
  const check = () => { if (!UPDATE_BUSY.has(holder.state().phase)) run() }
  const download = () => {
    const current = holder.state()
    if (current.phase !== 'available' || typeof updater.downloadUpdate !== 'function') return
    manualDownload = true
    set({ phase: 'downloading', version: current.version })
    void (async () => {
      try {
        // Wait for any cancelled background download's cleanup so electron-updater clears its
        // internal downloadPromise slot before starting the manual download.
        if (cancelling !== null) await cancelling
        if (holder.state().phase !== 'downloading') return
        await updater.downloadUpdate()
      } catch (error) {
        if (holder.state().phase === 'downloading') {
          log.error(`DS Bot: update failed: ${error instanceof Error ? error.message : String(error)}`)
          set({ phase: 'failed' })
        }
      } finally {
        manualDownload = false
      }
    })()
  }
  const setAutoUpdate = (enabled) => {
    const next = Boolean(enabled)
    if (next === auto) return holder.state()
    auto = next
    updater.autoDownload = auto
    updater.autoInstallOnAppQuit = auto
    if (auto) startTimer()
    else {
      stopTimer()
      latest = Promise.resolve(null)
    }
    const current = holder.state()
    if (!auto) {
      if (current.phase === 'downloading' && !manualDownload) {
        const cancel = activeCancel
        const dl = activeDownload
        activeCancel = null
        activeDownload = null
        cancelBackgroundDownload(cancel, dl)
        set(current.version ? { phase: 'available', version: current.version, canDownload: true } : { phase: 'idle' })
      } else if (current.phase === 'downloaded') {
        set({ phase: 'downloaded', version: current.version, autoInstall: false })
      } else {
        set(current)
      }
    } else if (current.phase === 'idle' || current.phase === 'failed') {
      run()
    } else if (current.phase === 'downloaded') {
      set({ phase: 'downloaded', version: current.version, autoInstall: autoInstallReady })
    } else {
      set(current)
    }
    return holder.state()
  }
  if (auto) {
    run()
    startTimer()
  }
  return { stop: stopTimer, latest: () => latest, install, download, state: holder.state, subscribe: holder.subscribe, check, setAutoUpdate }
}
