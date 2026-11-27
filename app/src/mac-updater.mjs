// macOS in-place self-updater for ad-hoc signed builds.
// Squirrel.Mac (used by electron-updater on darwin) rejects ad-hoc signed bundles because their
// CDHash changes on every build. This module implements the same updater contract that
// watchUpdates() expects: it downloads the matching macOS zip from GitHub Releases over HTTPS,
// verifies its SHA-256 against SHA256SUMS.txt, extracts with macOS ditto (preserving symlinks,
// permissions and without adding quarantine), validates Info.plist and codesign --verify --deep,
// and hands the atomic bundle swap + optional relaunch to a detached /bin/sh helper once the app
// process exits.
import { execFile as defaultExecFile, spawn as defaultSpawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { accessSync, constants, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isNewer, parseVersion, RELEASES_URL } from './updates.mjs'

const DEFAULT_BUNDLE_ID = 'io.github.fei2411.dsbot'
const SUMS_ASSET = 'SHA256SUMS.txt'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

// Detached helper script: waits for the Electron process to exit, moves the verified new bundle
// beside the target on the same filesystem, performs an atomic swap with rollback on failure,
// cleans up staging/backup files, and optionally relaunches the updated app.
// All paths are passed as positional parameters ($1..$6), never interpolated into shell source.
export const MAC_SWAP_SCRIPT = [
  'set -eu',
  'PARENT_PID="$1"',
  'TARGET_APP="$2"',
  'STAGED_APP="$3"',
  'RELAUNCH="$4"',
  'STAGE_ROOT="$5"',
  'LOG_FILE="$6"',
  'mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true',
  'exec >>"$LOG_FILE" 2>&1',
  'echo "[$(date -u \'+%Y-%m-%dT%H:%M:%SZ\')] mac-updater: waiting for pid $PARENT_PID to exit"',
  'i=0',
  'while kill -0 "$PARENT_PID" 2>/dev/null; do',
  '  if [ "$i" -ge 300 ]; then',
  '    echo "mac-updater: timed out waiting for pid $PARENT_PID"',
  '    exit 1',
  '  fi',
  '  sleep 0.1',
  '  i=$((i + 1))',
  'done',
  'if [ ! -d "$STAGED_APP" ]; then',
  '  echo "mac-updater: staged app missing: $STAGED_APP"',
  '  exit 1',
  'fi',
  'if [ ! -d "$TARGET_APP" ]; then',
  '  echo "mac-updater: target app missing: $TARGET_APP"',
  '  exit 1',
  'fi',
  'PARENT_DIR="$(dirname "$TARGET_APP")"',
  'APP_NAME="$(basename "$TARGET_APP")"',
  'NEW_TMP="$PARENT_DIR/.${APP_NAME}.new.$$"',
  'OLD_BAK="$PARENT_DIR/.${APP_NAME}.old.$$"',
  'rm -rf "$NEW_TMP" "$OLD_BAK"',
  'STAGED_DEV="$(stat -f %d "$STAGED_APP")"',
  'TARGET_DEV="$(stat -f %d "$PARENT_DIR")"',
  'if [ "$STAGED_DEV" = "$TARGET_DEV" ]; then',
  '  mv "$STAGED_APP" "$NEW_TMP"',
  'else',
  '  /usr/bin/ditto --noqtn "$STAGED_APP" "$NEW_TMP"',
  'fi',
  'if ! mv "$TARGET_APP" "$OLD_BAK"; then',
  '  echo "mac-updater: failed to move target app aside: $TARGET_APP"',
  '  if [ "$STAGED_DEV" = "$TARGET_DEV" ] && [ ! -e "$STAGED_APP" ]; then',
  '    mv "$NEW_TMP" "$STAGED_APP" 2>/dev/null || rm -rf "$NEW_TMP"',
  '  else',
  '    rm -rf "$NEW_TMP"',
  '  fi',
  '  if [ "$RELAUNCH" = "1" ]; then /usr/bin/open "$TARGET_APP" || true; fi',
  '  exit 1',
  'fi',
  'if ! mv "$NEW_TMP" "$TARGET_APP"; then',
  '  echo "mac-updater: failed to move new app into place; rolling back"',
  '  mv "$OLD_BAK" "$TARGET_APP" || true',
  '  rm -rf "$NEW_TMP" || true',
  '  if [ "$RELAUNCH" = "1" ]; then /usr/bin/open "$TARGET_APP" || true; fi',
  '  exit 1',
  'fi',
  'touch "$TARGET_APP" || true',
  'echo "mac-updater: swapped $TARGET_APP successfully"',
  'rm -rf "$OLD_BAK" "$STAGE_ROOT" || true',
  'if [ "$RELAUNCH" = "1" ]; then',
  '  /usr/bin/open "$TARGET_APP" || true',
  'fi',
].join('\n')

/**
 * Determine whether `execPath` is inside a writable, non-translocated macOS `.app` bundle
 * that can be atomically replaced in place.
 */
export function resolveMacAppBundle(execPath, { access = accessSync } = {}) {
  if (typeof execPath !== 'string' || execPath.trim() === '') {
    return { eligible: false, reason: 'not-bundle' }
  }
  const normalized = resolve(execPath)
  const macosDir = dirname(normalized)
  const contentsDir = dirname(macosDir)
  const appPath = dirname(contentsDir)
  const appName = basename(appPath)
  if (basename(macosDir) !== 'MacOS' || basename(contentsDir) !== 'Contents'
    || !appName.endsWith('.app') || appName.length <= 4) {
    return { eligible: false, reason: 'not-bundle' }
  }
  if (appPath.includes('/AppTranslocation/')) {
    return { eligible: false, appPath, reason: 'translocated' }
  }
  try {
    access(appPath, constants.W_OK)
    access(dirname(appPath), constants.W_OK)
  } catch {
    return { eligible: false, appPath, reason: 'not-writable' }
  }
  return { eligible: true, appPath }
}

/** Parse a `SHA256SUMS.txt` file into a map of filename -> lowercase 64-char hex digest. */
export function parseSha256Sums(text) {
  const result = new Map()
  if (typeof text !== 'string') return result
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '') continue
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line)
    if (match === null) continue
    result.set(match[2].trim(), match[1].toLowerCase())
  }
  return result
}

function isLoopbackHttp(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

function isAllowedAssetUrl(url, allowLocalHttp) {
  if (typeof url !== 'string' || url.trim() === '') return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    if (allowLocalHttp && parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return true
    return false
  } catch {
    return false
  }
}

function execFileAsync(execFileImpl, file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      if (error) {
        const detail = typeof stderr === 'string' && stderr.trim() !== '' ? `: ${stderr.trim()}` : ''
        const wrapped = new Error(`${file} failed${detail}`)
        wrapped.cause = error
        if (error.name === 'AbortError' || error.code === 'ABORT_ERR') wrapped.name = 'AbortError'
        rejectPromise(wrapped)
        return
      }
      resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function makeCancelledError() {
  const error = new Error('Update download cancelled')
  error.name = 'AbortError'
  return error
}

function isCancelledError(error, token) {
  return Boolean(token?.cancelled || token?.signal?.aborted
    || error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
}

function safeRm(target) {
  try { rmSync(target, { recursive: true, force: true }) } catch { /* ignore cleanup failure */ }
}

function pruneStaleStaging(stagingRoot, keepName) {
  let entries
  try { entries = readdirSync(stagingRoot) } catch { return }
  for (const name of entries) {
    if (name === keepName) continue
    safeRm(join(stagingRoot, name))
  }
}

async function streamToFileWithSha256(response, destPath, { signal, onProgress }) {
  const total = Number(response.headers?.get?.('content-length')) || 0
  const hash = createHash('sha256')
  const out = createWriteStream(destPath)
  let transferred = 0
  let failed = false
  let streamError = null
  out.on('error', (err) => { streamError = err })

  const closeStream = () => new Promise((done, fail) => {
    if (streamError) { fail(streamError); return }
    const onError = (err) => { fail(err) }
    out.once('error', onError)
    out.end(() => {
      out.off('error', onError)
      if (streamError) fail(streamError)
      else done()
    })
  })

  try {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader()
      try {
        for (;;) {
          if (streamError) throw streamError
          if (signal?.aborted) throw makeCancelledError()
          const { done, value } = await reader.read()
          if (done) break
          if (streamError) throw streamError
          if (signal?.aborted) throw makeCancelledError()
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          hash.update(chunk)
          transferred += chunk.length
          if (!out.write(chunk)) {
            await new Promise((doneWrite, failWrite) => {
              if (streamError) { failWrite(streamError); return }
              const onDrain = () => { out.off('error', onErr); doneWrite() }
              const onErr = (err) => { out.off('drain', onDrain); failWrite(err) }
              out.once('drain', onDrain)
              out.once('error', onErr)
            })
          }
          const percent = total > 0 ? Math.min(100, (transferred / total) * 100) : 0
          onProgress?.({ percent, transferred, total })
        }
      } finally {
        try { await reader.cancel() } catch { /* ignore */ }
      }
    } else {
      if (signal?.aborted) throw makeCancelledError()
      const data = Buffer.from(await response.arrayBuffer())
      if (streamError) throw streamError
      if (signal?.aborted) throw makeCancelledError()
      hash.update(data)
      transferred = data.length
      out.write(data)
      onProgress?.({ percent: 100, transferred, total: total || transferred })
    }
    await closeStream()
    return hash.digest('hex')
  } catch (error) {
    failed = true
    out.destroy()
    throw error
  } finally {
    if (failed) safeRm(destPath)
  }
}

/**
 * Create a macOS self-updater implementing the EventEmitter contract expected by `watchUpdates`.
 */
export function createMacUpdater({
  current,
  arch,
  appPath,
  expectedBundleId = DEFAULT_BUNDLE_ID,
  stagingRoot,
  logFile,
  fetch = globalThis.fetch,
  execFile = defaultExecFile,
  spawn = defaultSpawn,
  quit,
  onWillQuit,
  log = console,
  pid = process.pid,
  access = accessSync,
}) {
  const emitter = new EventEmitter()
  let feedUrl = RELEASES_URL
  let pendingRelease = null
  let staged = null
  let activeDownload = null
  let quitHookRegistered = false
  let installTriggered = false

  const allowLocalHttp = () => isLoopbackHttp(feedUrl)

  const spawnSwap = ({ relaunch }) => {
    if (!staged) return false
    const args = [
      '-c',
      MAC_SWAP_SCRIPT,
      'ds-bot-mac-updater',
      String(pid),
      appPath,
      staged.appPath,
      relaunch ? '1' : '0',
      staged.stageDir,
      logFile ?? join(stagingRoot, 'mac-updater.log'),
    ]
    const child = spawn('/bin/sh', args, { detached: true, stdio: 'ignore' })
    child.unref?.()
    return true
  }

  const verifyExtractedBundle = async (extractDir, expectedVersion, signal) => {
    const entries = readdirSync(extractDir, { withFileTypes: true })
    const apps = entries.filter(entry => entry.name.endsWith('.app'))
    if (apps.length !== 1 || !apps[0].isDirectory() || apps[0].isSymbolicLink()) {
      throw new Error(`Expected exactly one .app bundle in archive, found ${String(apps.length)}`)
    }
    const stagedApp = join(extractDir, apps[0].name)

    const plistPath = join(stagedApp, 'Contents', 'Info.plist')
    const { stdout } = await execFileAsync(execFile, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { signal })
    let plist
    try { plist = JSON.parse(stdout) } catch { throw new Error('Extracted bundle Info.plist is invalid') }

    if (expectedBundleId && plist?.CFBundleIdentifier !== expectedBundleId) {
      throw new Error(`Unexpected bundle identifier: ${String(plist?.CFBundleIdentifier)}`)
    }
    const bundleVersion = typeof plist?.CFBundleShortVersionString === 'string'
      ? plist.CFBundleShortVersionString.replace(/^v/u, '')
      : ''
    if (bundleVersion !== expectedVersion) {
      throw new Error(`Bundle version ${bundleVersion || '<missing>'} does not match expected ${expectedVersion}`)
    }
    const executable = plist?.CFBundleExecutable
    if (typeof executable !== 'string' || executable === '' || basename(executable) !== executable
      || executable === '.' || executable === '..') {
      throw new Error('Extracted bundle has invalid CFBundleExecutable')
    }
    const execTarget = join(stagedApp, 'Contents', 'MacOS', executable)
    try {
      access(execTarget, constants.X_OK)
    } catch {
      throw new Error(`Extracted executable is missing or not executable: ${executable}`)
    }

    await execFileAsync(execFile, '/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp], { signal })
    return stagedApp
  }

  const downloadUpdate = (cancellationToken) => {
    if (activeDownload !== null) return activeDownload
    if (pendingRelease === null) return Promise.reject(new Error('No pending update to download'))
    const release = pendingRelease
    const signal = cancellationToken?.signal
    const stageName = `v${release.version}-${Date.now()}`
    const stageDir = join(stagingRoot, stageName)

    const run = (async () => {
      try {
        if (signal?.aborted) throw makeCancelledError()
        pruneStaleStaging(stagingRoot, staged ? basename(staged.stageDir) : '')
        mkdirSync(stageDir, { recursive: true })

        const localHttp = allowLocalHttp()
        if (!isAllowedAssetUrl(release.sumsUrl, localHttp) || !isAllowedAssetUrl(release.zipUrl, localHttp)) {
          throw new Error('Update asset URL is not HTTPS')
        }

        const headers = { 'user-agent': `DS-Bot/${current}` }
        const sumsResponse = await fetch(release.sumsUrl, { headers, signal })
        if (!sumsResponse.ok) throw new Error(`Failed to download ${SUMS_ASSET}: HTTP ${String(sumsResponse.status)}`)
        if (sumsResponse.url && !isAllowedAssetUrl(sumsResponse.url, localHttp)) {
          throw new Error(`${SUMS_ASSET} redirected to a non-HTTPS URL`)
        }
        const sums = parseSha256Sums(await sumsResponse.text())
        const expectedHash = sums.get(release.assetName)
        if (!expectedHash) throw new Error(`${SUMS_ASSET} does not list ${release.assetName}`)

        const zipResponse = await fetch(release.zipUrl, { headers, signal })
        if (!zipResponse.ok) throw new Error(`Failed to download ${release.assetName}: HTTP ${String(zipResponse.status)}`)
        if (zipResponse.url && !isAllowedAssetUrl(zipResponse.url, localHttp)) {
          throw new Error(`${release.assetName} redirected to a non-HTTPS URL`)
        }

        const partPath = join(stageDir, `${release.assetName}.part`)
        const zipPath = join(stageDir, release.assetName)
        const actualHash = await streamToFileWithSha256(zipResponse, partPath, {
          signal,
          onProgress: (progress) => { emitter.emit('download-progress', progress) },
        })

        const expectedBuf = Buffer.from(expectedHash, 'hex')
        const actualBuf = Buffer.from(actualHash, 'hex')
        if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
          throw new Error(`SHA-256 checksum mismatch for ${release.assetName}`)
        }
        renameSync(partPath, zipPath)

        if (signal?.aborted) throw makeCancelledError()
        const extractDir = join(stageDir, 'extracted')
        mkdirSync(extractDir, { recursive: true })
        await execFileAsync(execFile, '/usr/bin/ditto', ['-x', '-k', '--noqtn', zipPath, extractDir], { signal })
        safeRm(zipPath)

        if (signal?.aborted) throw makeCancelledError()
        const stagedApp = await verifyExtractedBundle(extractDir, release.version, signal)
        if (signal?.aborted) throw makeCancelledError()

        const previousStageDir = staged?.stageDir
        staged = { version: release.version, appPath: stagedApp, stageDir, releaseNotes: release.releaseNotes }
        if (previousStageDir && previousStageDir !== stageDir) safeRm(previousStageDir)

        if (updater.autoInstallOnAppQuit === true && !quitHookRegistered) {
          quitHookRegistered = true
          onWillQuit?.(() => {
            if (updater.autoInstallOnAppQuit === true && !installTriggered && staged) {
              installTriggered = true
              spawnSwap({ relaunch: false })
            }
          })
        }

        const downloadedInfo = {
          version: release.version,
          ...(release.releaseNotes ? { releaseNotes: release.releaseNotes } : {}),
        }
        emitter.emit('update-downloaded', downloadedInfo)
        return [stagedApp]
      } catch (error) {
        safeRm(stageDir)
        if (!isCancelledError(error, cancellationToken)) {
          emitter.emit('error', error instanceof Error ? error : new Error(String(error)))
        }
        throw error
      }
    })().finally(() => { activeDownload = null })

    activeDownload = run
    return run
  }

  const checkForUpdates = async () => {
    emitter.emit('checking-for-update')
    try {
      const response = await fetch(feedUrl, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `DS-Bot/${current}` },
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const releases = await response.json()
      if (!Array.isArray(releases)) throw new Error('releases response is not an array')

      const currentVersion = parseVersion(current)
      const allowPrerelease = currentVersion !== null && currentVersion.pre !== null
      const localHttp = allowLocalHttp()
      let found

      for (const release of releases) {
        if (release === null || typeof release !== 'object' || release.draft === true
          || (release.prerelease === true && !allowPrerelease)) continue
        const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/u, '') : ''
        if (!isNewer(version, current)) continue
        if (!Array.isArray(release.assets)) continue
        const assetName = `DS-Bot-${version}-mac-${arch}.zip`
        const zipAsset = release.assets.find(entry => entry?.name === assetName)
        const sumsAsset = release.assets.find(entry => entry?.name === SUMS_ASSET)
        if (!zipAsset || !sumsAsset) continue
        if (!isAllowedAssetUrl(zipAsset.browser_download_url, localHttp)
          || !isAllowedAssetUrl(sumsAsset.browser_download_url, localHttp)) {
          log.error('DS Bot: update check skipped release with non-HTTPS asset URL')
          continue
        }
        const releaseNotes = typeof release.body === 'string' ? release.body : ''
        if (found === undefined || isNewer(version, found.version)) {
          found = {
            version,
            assetName,
            zipUrl: zipAsset.browser_download_url,
            sumsUrl: sumsAsset.browser_download_url,
            releaseNotes,
          }
        }
      }

      if (found === undefined) {
        pendingRelease = null
        const info = { version: current }
        emitter.emit('update-not-available', info)
        return { isUpdateAvailable: false, updateInfo: info }
      }

      pendingRelease = found
      const updateInfo = {
        version: found.version,
        ...(found.releaseNotes ? { releaseNotes: found.releaseNotes } : {}),
      }
      emitter.emit('update-available', updateInfo)

      if (updater.autoDownload) {
        const controller = new AbortController()
        const cancellationToken = {
          cancelled: false,
          signal: controller.signal,
          cancel() {
            if (this.cancelled) return
            this.cancelled = true
            controller.abort()
          },
        }
        const downloadPromise = downloadUpdate(cancellationToken)
        return { isUpdateAvailable: true, updateInfo, downloadPromise, cancellationToken }
      }
      return { isUpdateAvailable: true, updateInfo }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      emitter.emit('error', failure)
      throw failure
    }
  }

  const updater = Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    setFeedURL(options) {
      const next = typeof options === 'string' ? options : options?.url
      if (typeof next === 'string' && next.trim() !== '') feedUrl = next.trim()
    },
    checkForUpdates,
    downloadUpdate,
    quitAndInstall(_isSilent = true, isForceRunAfter = true) {
      if (!staged || installTriggered) return
      installTriggered = true
      spawnSwap({ relaunch: isForceRunAfter !== false })
      quit?.()
    },
  })

  return updater
}
