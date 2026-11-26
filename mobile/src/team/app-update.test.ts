import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  androidApkName,
  checkAndroidUpdate,
  formatMegabytes,
  isNewerVersion,
  normalizeMirrorBase,
  parseGitHubDigest,
  parseReleaseMirrorUrl,
  parseSha256Sums,
  stripDownloadTable,
} from './app-update.ts'

const VALID_SHA = '3d419ff385a0d95e5a78fd211b98e39f529f80eacf96c75ea26edbc0c8fb077e'
const OTHER_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

test('isNewerVersion respects semver ordering and prerelease channels', () => {
  assert.equal(isNewerVersion('0.3.11', '0.3.10'), true)
  assert.equal(isNewerVersion('v0.4.0', '0.3.10'), true)
  assert.equal(isNewerVersion('0.3.10', '0.3.10'), false)
  assert.equal(isNewerVersion('0.3.9', '0.3.10'), false)
  assert.equal(isNewerVersion('0.4.0-rc.1', '0.3.10'), true)
  assert.equal(isNewerVersion('0.4.0-rc.2', '0.4.0-rc.1'), true)
  assert.equal(isNewerVersion('0.4.0', '0.4.0-rc.2'), true)
  assert.equal(isNewerVersion('0.4.0-rc.2', '0.4.0'), false)
  assert.equal(isNewerVersion('not-a-version', '0.3.10'), false)
})

test('parseSha256Sums strictly matches exact APK filename and rejects conflicting duplicates', () => {
  const sums = [
    `${OTHER_SHA}  DS-Bot-0.3.11-win-x64.exe`,
    `${VALID_SHA}  DS-Bot-0.3.11-android.apk`,
    `${VALID_SHA}  DS-Bot-android.apk`,
  ].join('\n')
  assert.equal(parseSha256Sums(sums, 'DS-Bot-0.3.11-android.apk'), VALID_SHA)
  assert.equal(parseSha256Sums(sums, 'DS-Bot-0.3.12-android.apk'), null)

  const conflicted = [
    `${VALID_SHA}  DS-Bot-0.3.11-android.apk`,
    `${OTHER_SHA}  DS-Bot-0.3.11-android.apk`,
  ].join('\n')
  assert.equal(parseSha256Sums(conflicted, 'DS-Bot-0.3.11-android.apk'), null)
  assert.equal(parseGitHubDigest(`sha256:${VALID_SHA.toUpperCase()}`), VALID_SHA)
  assert.equal(parseGitHubDigest('md5:1234'), null)
})

test('parseReleaseMirrorUrl and stripDownloadTable match release-notes.mjs format', () => {
  const body = [
    '<!-- downloads -->',
    '## Download / 下载',
    '',
    '| System / 系统 | Download / 下载 | Size / 大小 |',
    '|---|---|---|',
    '| Android (phone app / 手机 App) | DS-Bot-0.3.11-android.apk: [Mirror / 国内镜像](https://dl.dsbot.app/DS-Bot-0.3.11-android.apk) · [GitHub](https://github.com/Fei-Craft/DS-Bot/releases/download/v0.3.11/DS-Bot-0.3.11-android.apk) | 61 MB |',
    '<!-- /downloads -->',
    '',
    '### Added',
    '- Android auto-update',
  ].join('\n')

  assert.equal(parseReleaseMirrorUrl(body, 'DS-Bot-0.3.11-android.apk'), 'https://dl.dsbot.app/DS-Bot-0.3.11-android.apk')
  assert.equal(parseReleaseMirrorUrl(body, 'DS-Bot-0.3.12-android.apk'), null)
  assert.equal(stripDownloadTable(body), '### Added\n- Android auto-update')
  assert.equal(normalizeMirrorBase('https://dl.dsbot.app///'), 'https://dl.dsbot.app')
  assert.equal(normalizeMirrorBase('http://insecure.example.com'), null)
  assert.equal(normalizeMirrorBase(''), '')
  assert.equal(formatMegabytes(61 * 1024 * 1024), '61 MB')
})

test('checkAndroidUpdate verifies SHA256SUMS, prefers mirror URLs, ignores prereleases for stable installs', async () => {
  const apkName = androidApkName('0.3.11')
  const releases = [
    {
      tag_name: 'v0.4.0-rc.1',
      draft: false,
      prerelease: true,
      assets: [{ name: androidApkName('0.4.0-rc.1'), browser_download_url: 'https://github.com/Fei-Craft/DS-Bot/releases/download/v0.4.0-rc.1/DS-Bot-0.4.0-rc.1-android.apk', digest: `sha256:${OTHER_SHA}` }],
    },
    {
      tag_name: 'v0.3.11',
      draft: false,
      prerelease: false,
      html_url: 'https://github.com/Fei-Craft/DS-Bot/releases/tag/v0.3.11',
      body: `<!-- downloads -->\n| Android | ${apkName}: [Mirror / 国内镜像](https://mirror.test/${apkName}) · [GitHub](https://github.com/x) | 61 MB |\n<!-- /downloads -->\n\n### Fixed\n- Faster sync`,
      assets: [
        { name: apkName, browser_download_url: `https://github.com/Fei-Craft/DS-Bot/releases/download/v0.3.11/${apkName}`, size: 62_000_000, digest: `sha256:${VALID_SHA}` },
        { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/Fei-Craft/DS-Bot/releases/download/v0.3.11/SHA256SUMS.txt' },
      ],
    },
  ]

  const fetchMock: typeof globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('api.github.com')) {
      return new Response(JSON.stringify(releases), { status: 200, headers: { etag: '"etag-1"' } })
    }
    if (target.endsWith('SHA256SUMS.txt')) {
      return new Response(`${VALID_SHA}  ${apkName}\n`, { status: 200 })
    }
    return new Response('', { status: 404 })
  }

  const res = await checkAndroidUpdate({ currentVersion: '0.3.10', fetch: fetchMock })
  assert.equal(res.status, 'available')
  assert.equal(res.etag, '"etag-1"')
  assert.equal(res.release.version, '0.3.11')
  assert.equal(res.release.sha256, VALID_SHA)
  assert.deepEqual(res.release.downloadUrls, [
    `https://mirror.test/${apkName}`,
    `https://github.com/Fei-Craft/DS-Bot/releases/download/v0.3.11/${apkName}`,
  ])
  assert.equal(res.release.notes, '### Fixed\n- Faster sync')

  // Current version already up to date ignores prereleases.
  const current = await checkAndroidUpdate({ currentVersion: '0.3.11', fetch: fetchMock })
  assert.equal(current.status, 'up-to-date')

  // Prerelease install DOES see newer prerelease.
  const pre = await checkAndroidUpdate({ currentVersion: '0.4.0-rc.0', fetch: fetchMock })
  assert.equal(pre.status, 'available')
  assert.equal(pre.release.version, '0.4.0-rc.1')
})

test('checkAndroidUpdate refuses updates with missing or conflicting SHA-256', async () => {
  const apkName = androidApkName('0.3.11')
  const mismatchedFetch: typeof globalThis.fetch = async (url) => {
    if (String(url).includes('api.github.com')) {
      return new Response(JSON.stringify([{
        tag_name: 'v0.3.11',
        draft: false,
        prerelease: false,
        assets: [
          { name: apkName, browser_download_url: `https://github.com/x/${apkName}`, digest: `sha256:${VALID_SHA}` },
          { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/x/SHA256SUMS.txt' },
        ],
      }]), { status: 200 })
    }
    return new Response(`${OTHER_SHA}  ${apkName}\n`, { status: 200 })
  }
  await assert.rejects(checkAndroidUpdate({ currentVersion: '0.3.10', fetch: mismatchedFetch }), /checksum mismatch/i)

  const noShaFetch: typeof globalThis.fetch = async () => new Response(JSON.stringify([{
    tag_name: 'v0.3.11',
    draft: false,
    prerelease: false,
    assets: [{ name: apkName, browser_download_url: `https://github.com/x/${apkName}` }],
  }]), { status: 200 })
  await assert.rejects(checkAndroidUpdate({ currentVersion: '0.3.10', fetch: noShaFetch }), /SHA-256/)
})

test('checkAndroidUpdate falls back to releases/latest on API rate limit and supports custom mirror manifest', async () => {
  const apkName = androidApkName('0.3.12')
  const requests: string[] = []
  const rateLimitedFetch: typeof globalThis.fetch = async (url) => {
    const target = String(url)
    requests.push(target)
    if (target.includes('api.github.com')) return new Response('rate limit', { status: 403 })
    if (target.endsWith('/releases/latest')) {
      const resp = new Response('', { status: 200 })
      Object.defineProperty(resp, 'url', { value: 'https://github.com/Fei-Craft/DS-Bot/releases/tag/v0.3.12' })
      return resp
    }
    if (target.endsWith('SHA256SUMS.txt')) return new Response(`${VALID_SHA}  ${apkName}\n`, { status: 200 })
    return new Response('', { status: 404 })
  }
  const fallback = await checkAndroidUpdate({ currentVersion: '0.3.10', fetch: rateLimitedFetch })
  assert.equal(fallback.status, 'available')
  assert.equal(fallback.release.version, '0.3.12')
  assert.equal(fallback.release.sha256, VALID_SHA)
  assert.deepEqual(requests, [
    'https://api.github.com/repos/Fei-Craft/DS-Bot/releases?per_page=20',
    'https://github.com/Fei-Craft/DS-Bot/releases/latest',
    'https://github.com/Fei-Craft/DS-Bot/releases/download/v0.3.12/SHA256SUMS.txt',
  ])
  assert.deepEqual(fallback.release.downloadUrls, [
    `https://github.com/Fei-Craft/DS-Bot/releases/download/v0.3.12/${apkName}`,
  ])

  // Custom mirror manifest works even when GitHub is completely unreachable.
  const mirrorOnlyFetch: typeof globalThis.fetch = async (url) => {
    const target = String(url)
    if (target === 'https://cn.mirror.test/ds-bot/latest-android.json') {
      return new Response(JSON.stringify({
        version: '0.3.15',
        sha256: VALID_SHA,
        size: 60_000_000,
        notes: 'Mirror release',
      }), { status: 200 })
    }
    throw new Error('GitHub unreachable')
  }
  const fromMirror = await checkAndroidUpdate({
    currentVersion: '0.3.10',
    customMirror: 'https://cn.mirror.test/ds-bot',
    fetch: mirrorOnlyFetch,
  })
  assert.equal(fromMirror.status, 'available')
  assert.equal(fromMirror.release.version, '0.3.15')
  assert.equal(fromMirror.release.downloadUrls[0], 'https://cn.mirror.test/ds-bot/DS-Bot-0.3.15-android.apk')
})

test('checkAndroidUpdate rejects insecure HTTP redirects during metadata fetch', async () => {
  const downgradeFetch: typeof globalThis.fetch = async () => {
    const resp = new Response('[]', { status: 200 })
    Object.defineProperty(resp, 'url', { value: 'http://downgrade.example/releases' })
    return resp
  }
  await assert.rejects(
    checkAndroidUpdate({ currentVersion: '0.3.10', fetch: downgradeFetch }),
    /insecure address/i,
  )
})
