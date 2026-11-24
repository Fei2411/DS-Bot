// Pure Android app auto-update logic: semver comparison, GitHub Release / mirror
// discovery, mandatory SHA-256 checksum extraction, and release-note cleanup.
// Kept React-Native-free so unit tests run directly under Node 24.

export const REPO = 'Fei-Craft/DS-Bot'
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`
export const LATEST_RELEASE_URL = `https://github.com/${REPO}/releases/latest`
export const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60_000

const SUMS_NAME = 'SHA256SUMS.txt'
const SHA256_RE = /^[0-9a-f]{64}$/i
const DOWNLOAD_BLOCK_RE = /<!--\s*downloads\s*-->[\s\S]*?<!--\s*\/downloads\s*-->/gi

export interface AndroidReleaseInfo {
  version: string
  apkName: string
  sha256: string
  size: number
  downloadUrls: string[]
  releasePageUrl: string
  notes: string
  publishedAt?: string
}

export type UpdateCheckResult =
  | { status: 'available'; release: AndroidReleaseInfo; etag?: string }
  | { status: 'up-to-date'; currentVersion: string; etag?: string }
  | { status: 'unchanged' }

interface ParsedVersion {
  core: [bigint, bigint, bigint]
  pre: string[] | null
}

function parseVersion(version: unknown): ParsedVersion | null {
  if (typeof version !== 'string') return null
  const value = version.trim().replace(/^v/u, '')
  const sep = value.indexOf('-')
  const core = sep < 0 ? value : value.slice(0, sep)
  const pre = sep < 0 ? null : value.slice(sep + 1).split('.')
  const parts = core.split('.')
  if (parts.length === 0 || parts.length > 3 || parts.some(part => !/^\d+$/u.test(part)) || pre?.some(part => part === '')) {
    return null
  }
  return {
    core: [0, 1, 2].map(index => (index < parts.length ? BigInt(parts[index]) : 0n)) as [bigint, bigint, bigint],
    pre,
  }
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const newer = parseVersion(candidate)
  const older = parseVersion(current)
  if (newer === null || older === null) return false
  for (let i = 0; i < 3; i += 1) {
    if (newer.core[i] !== older.core[i]) return newer.core[i] > older.core[i]
  }
  if (newer.pre === null) return older.pre !== null
  if (older.pre === null) return false
  for (let i = 0; i < Math.max(newer.pre.length, older.pre.length); i += 1) {
    const left = newer.pre[i]
    const right = older.pre[i]
    if (left === undefined) return false
    if (right === undefined) return true
    if (left === right) continue
    const leftNum = /^\d+$/u.test(left)
    const rightNum = /^\d+$/u.test(right)
    if (leftNum && rightNum) return BigInt(left) > BigInt(right)
    if (leftNum !== rightNum) return !leftNum
    return left > right
  }
  return false
}

export function isPrereleaseVersion(version: string): boolean {
  return parseVersion(version)?.pre !== null
}

export function androidApkName(version: string): string {
  return `DS-Bot-${version}-android.apk`
}

export function isSafeUpdateUrl(raw: unknown, options: { allowLoopbackHttp?: boolean } = {}): raw is string {
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed !== raw || trimmed.length > 1024) return false
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '' || url.hostname === '') return false
  if (url.protocol === 'https:') return true
  if (options.allowLoopbackHttp === true && url.protocol === 'http:') {
    const host = url.hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2' || host === '[::1]'
  }
  return false
}

/** Validates and normalizes an optional mirror base URL (empty string clears it). */
export function normalizeMirrorBase(input: string, options: { allowLoopbackHttp?: boolean } = {}): string | null {
  const trimmed = input.trim().replace(/\/+$/u, '')
  if (trimmed === '') return ''
  if (!isSafeUpdateUrl(trimmed, options)) return null
  return trimmed
}

/** Parses `SHA256SUMS.txt` (`<64-hex>  <filename>`) strictly for `fileName`. */
export function parseSha256Sums(text: string, fileName: string): string | null {
  let matched: string | null = null
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line)
    if (match === null) continue
    const hash = match[1].toLowerCase()
    const name = match[2].trim()
    if (name !== fileName) continue
    if (matched !== null && matched !== hash) return null
    matched = hash
  }
  return matched
}

export function parseGitHubDigest(digest: unknown): string | null {
  if (typeof digest !== 'string') return null
  const match = /^sha256:([0-9a-fA-F]{64})$/u.exec(digest.trim())
  return match === null ? null : match[1].toLowerCase()
}

/** Extracts an optional `[Mirror / 国内镜像](https://...)` URL from release notes for `fileName`. */
export function parseReleaseMirrorUrl(body: string, fileName: string, options: { allowLoopbackHttp?: boolean } = {}): string | null {
  if (typeof body !== 'string' || body === '') return null
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rowRe = new RegExp(`${escaped}[^\\r\\n]*?\\[[^\\]]*Mirror[^\\]]*\\]\\(([^)\\s]+)\\)`, 'i')
  const match = rowRe.exec(body)
  if (match === null) return null
  return isSafeUpdateUrl(match[1], options) ? match[1] : null
}

/** Removes the generated download table so the update screen shows only user-facing release notes. */
export function stripDownloadTable(body: string): string {
  if (typeof body !== 'string') return ''
  return body
    .replace(DOWNLOAD_BLOCK_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}

interface GitHubAsset {
  name?: string
  browser_download_url?: string
  size?: number
  digest?: string
}

interface GitHubRelease {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  html_url?: string
  body?: string
  published_at?: string
  assets?: GitHubAsset[]
}

export interface CheckUpdateOptions {
  currentVersion: string
  customMirror?: string
  etag?: string
  fetch?: typeof globalThis.fetch
  releasesApiUrl?: string
  latestReleaseUrl?: string
  allowLoopbackHttp?: boolean
}

function uniqueUrls(urls: (string | null | undefined)[], options: { allowLoopbackHttp?: boolean }): string[] {
  const out: string[] = []
  for (const url of urls) {
    if (isSafeUpdateUrl(url, options) && !out.includes(url)) out.push(url)
  }
  return out
}

const FETCH_TIMEOUT_MS = 15_000

async function fetchSafe(
  fetchFn: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  urlOpts: { allowLoopbackHttp?: boolean },
): Promise<Response> {
  if (!isSafeUpdateUrl(url, urlOpts)) throw new Error('Only HTTPS update URLs are allowed')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal })
    if (response.url && !isSafeUpdateUrl(response.url, urlOpts)) {
      throw new Error('Update source redirected to an insecure address')
    }
    return response
  } finally {
    clearTimeout(timer)
  }
}

async function fetchShaFromSums(
  fetchFn: typeof globalThis.fetch,
  sumsUrl: string,
  apkName: string,
  userAgent: string,
  urlOpts: { allowLoopbackHttp?: boolean },
): Promise<string | null> {
  const response = await fetchSafe(fetchFn, sumsUrl, {
    headers: { 'user-agent': userAgent, accept: 'text/plain, */*' },
  }, urlOpts)
  if (!response.ok) return null
  return parseSha256Sums(await response.text(), apkName)
}

async function tryCustomMirrorManifest(
  fetchFn: typeof globalThis.fetch,
  mirrorBase: string,
  currentVersion: string,
  allowPrerelease: boolean,
  userAgent: string,
  urlOpts: { allowLoopbackHttp?: boolean },
): Promise<UpdateCheckResult | null> {
  try {
    const response = await fetchSafe(fetchFn, `${mirrorBase}/latest-android.json`, {
      headers: { 'user-agent': userAgent, accept: 'application/json' },
    }, urlOpts)
    if (!response.ok) return null
    const data = await response.json() as Record<string, unknown>
    const version = typeof data.version === 'string' ? data.version.trim().replace(/^v/u, '') : ''
    if (!version || parseVersion(version) === null) return null
    if (isPrereleaseVersion(version) && !allowPrerelease) return { status: 'up-to-date', currentVersion }
    if (!isNewerVersion(version, currentVersion)) return { status: 'up-to-date', currentVersion }
    const sha256 = typeof data.sha256 === 'string' && SHA256_RE.test(data.sha256.trim()) ? data.sha256.trim().toLowerCase() : null
    if (sha256 === null) return null
    const apkName = typeof data.apkName === 'string' && /^[A-Za-z0-9._-]+\.apk$/u.test(data.apkName)
      ? data.apkName
      : androidApkName(version)
    const mirrorApk = typeof data.apkUrl === 'string'
      ? data.apkUrl
      : `${mirrorBase}/${encodeURIComponent(apkName)}`
    const githubApk = `https://github.com/${REPO}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(apkName)}`
    const downloadUrls = uniqueUrls([mirrorApk, githubApk], urlOpts)
    if (downloadUrls.length === 0) return null
    return {
      status: 'available',
      release: {
        version,
        apkName,
        sha256,
        size: typeof data.size === 'number' && data.size > 0 ? data.size : 0,
        downloadUrls,
        releasePageUrl: typeof data.releasePageUrl === 'string' && isSafeUpdateUrl(data.releasePageUrl, urlOpts)
          ? data.releasePageUrl
          : `https://github.com/${REPO}/releases/tag/v${version}`,
        notes: typeof data.notes === 'string' ? stripDownloadTable(data.notes) : '',
        ...(typeof data.publishedAt === 'string' ? { publishedAt: data.publishedAt } : {}),
      },
    }
  } catch {
    return null
  }
}

async function fallbackLatestRedirect(
  fetchFn: typeof globalThis.fetch,
  latestUrl: string,
  currentVersion: string,
  customMirror: string,
  userAgent: string,
  urlOpts: { allowLoopbackHttp?: boolean },
): Promise<UpdateCheckResult> {
  const response = await fetchSafe(fetchFn, latestUrl, { headers: { 'user-agent': userAgent } }, urlOpts)
  if (!response.ok) throw new Error(`Update check failed (HTTP ${response.status})`)
  const finalUrl = response.url || ''
  const tagMatch = /\/releases\/tag\/v?([^/?#]+)/u.exec(finalUrl)
  if (tagMatch === null) throw new Error('Could not resolve the latest release version.')
  const version = decodeURIComponent(tagMatch[1]).replace(/^v/u, '')
  if (!isNewerVersion(version, currentVersion)) return { status: 'up-to-date', currentVersion }
  const apkName = androidApkName(version)
  const baseDownload = `https://github.com/${REPO}/releases/download/v${encodeURIComponent(version)}`
  const sumsUrl = `${baseDownload}/${SUMS_NAME}`
  const sha256 = await fetchShaFromSums(fetchFn, sumsUrl, apkName, userAgent, urlOpts)
  if (sha256 === null) throw new Error('Release checksum file is missing the Android APK digest.')
  const mirrorApk = customMirror ? `${customMirror}/${encodeURIComponent(apkName)}` : null
  const downloadUrls = uniqueUrls([mirrorApk, `${baseDownload}/${encodeURIComponent(apkName)}`], urlOpts)
  if (downloadUrls.length === 0) throw new Error('No valid download URL found for the Android APK.')
  return {
    status: 'available',
    release: {
      version,
      apkName,
      sha256,
      size: 0,
      downloadUrls,
      releasePageUrl: `https://github.com/${REPO}/releases/tag/v${version}`,
      notes: '',
    },
  }
}

export async function checkAndroidUpdate(options: CheckUpdateOptions): Promise<UpdateCheckResult> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const urlOpts = { allowLoopbackHttp: options.allowLoopbackHttp === true }
  const currentVersion = options.currentVersion.trim().replace(/^v/u, '')
  const allowPrerelease = isPrereleaseVersion(currentVersion)
  const userAgent = `DS-Bot-Android/${currentVersion || '0.0.0'}`
  const customMirror = normalizeMirrorBase(options.customMirror ?? '', urlOpts) ?? ''

  if (customMirror !== '') {
    const fromMirror = await tryCustomMirrorManifest(fetchFn, customMirror, currentVersion, allowPrerelease, userAgent, urlOpts)
    if (fromMirror !== null) return fromMirror
  }

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': userAgent,
  }
  if (options.etag) headers['if-none-match'] = options.etag

  let response: Response | null = null
  try {
    response = await fetchSafe(fetchFn, options.releasesApiUrl ?? RELEASES_API_URL, { headers }, urlOpts)
  } catch (networkError) {
    if (!allowPrerelease) {
      return fallbackLatestRedirect(fetchFn, options.latestReleaseUrl ?? LATEST_RELEASE_URL, currentVersion, customMirror, userAgent, urlOpts)
    }
    throw networkError
  }

  if (response.status === 304) return { status: 'unchanged' }
  if (!response.ok) {
    if (!allowPrerelease && (response.status === 403 || response.status === 429 || response.status >= 500)) {
      return fallbackLatestRedirect(fetchFn, options.latestReleaseUrl ?? LATEST_RELEASE_URL, currentVersion, customMirror, userAgent, urlOpts)
    }
    throw new Error(`Update check failed (HTTP ${response.status})`)
  }

  const etag = response.headers.get('etag') ?? undefined
  const releases = await response.json()
  if (!Array.isArray(releases)) throw new Error('Invalid releases response.')

  let chosen: { release: GitHubRelease; version: string; apk: GitHubAsset; sums?: GitHubAsset } | undefined
  for (const item of releases as GitHubRelease[]) {
    if (item === null || typeof item !== 'object' || item.draft === true) continue
    if (item.prerelease === true && !allowPrerelease) continue
    const version = typeof item.tag_name === 'string' ? item.tag_name.replace(/^v/u, '') : ''
    if (!isNewerVersion(version, currentVersion)) continue
    const apkName = androidApkName(version)
    const assets = Array.isArray(item.assets) ? item.assets : []
    const apk = assets.find(asset => asset?.name === apkName && isSafeUpdateUrl(asset?.browser_download_url, urlOpts))
    if (apk === undefined) continue
    const sums = assets.find(asset => asset?.name === SUMS_NAME && isSafeUpdateUrl(asset?.browser_download_url, urlOpts))
    if (chosen === undefined || isNewerVersion(version, chosen.version)) {
      chosen = { release: item, version, apk, sums }
    }
  }

  if (chosen === undefined) {
    return { status: 'up-to-date', currentVersion, ...(etag ? { etag } : {}) }
  }

  const apkName = androidApkName(chosen.version)
  const apiDigest = parseGitHubDigest(chosen.apk.digest)
  const sumsDigest = chosen.sums?.browser_download_url
    ? await fetchShaFromSums(fetchFn, chosen.sums.browser_download_url, apkName, userAgent, urlOpts).catch(() => null)
    : null

  if (sumsDigest !== null && apiDigest !== null && sumsDigest !== apiDigest) {
    throw new Error('Release checksum mismatch between SHA256SUMS.txt and release metadata.')
  }
  const sha256 = sumsDigest ?? apiDigest
  if (sha256 === null) {
    throw new Error('Release does not provide a verified SHA-256 checksum for the Android APK.')
  }

  const body = typeof chosen.release.body === 'string' ? chosen.release.body : ''
  const releaseMirrorUrl = parseReleaseMirrorUrl(body, apkName, urlOpts)
  const customMirrorApk = customMirror ? `${customMirror}/${encodeURIComponent(apkName)}` : null
  const downloadUrls = uniqueUrls([customMirrorApk, releaseMirrorUrl, chosen.apk.browser_download_url], urlOpts)
  if (downloadUrls.length === 0) throw new Error('No valid download URL found for the Android APK.')

  const releasePageUrl = isSafeUpdateUrl(chosen.release.html_url, urlOpts)
    ? chosen.release.html_url
    : `https://github.com/${REPO}/releases/tag/v${chosen.version}`

  return {
    status: 'available',
    ...(etag ? { etag } : {}),
    release: {
      version: chosen.version,
      apkName,
      sha256,
      size: typeof chosen.apk.size === 'number' && chosen.apk.size > 0 ? chosen.apk.size : 0,
      downloadUrls,
      releasePageUrl,
      notes: stripDownloadTable(body),
      ...(typeof chosen.release.published_at === 'string' ? { publishedAt: chosen.release.published_at } : {}),
    },
  }
}
