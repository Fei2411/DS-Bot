// Pure SemVer parsing and comparison utilities (zero dependencies, browser/Node/RN safe).
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

/** Parse a semver string, stripping leading `v` and ignoring `+build` metadata. */
export function parseSemver(value) {
  if (typeof value !== 'string') return null
  const match = SEMVER_RE.exec(value.trim())
  if (match === null) return null
  const pre = match[4] === undefined ? null : match[4].split('.')
  if (pre !== null && pre.some(part => part === '')) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre,
    clean: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${pre ? `-${pre.join('.')}` : ''}`,
  }
}

/** Return the normalized semver string without leading `v` or `+build` metadata, or null. */
export function cleanSemver(value) {
  return parseSemver(value)?.clean ?? null
}

/** Standard SemVer comparison ignoring build metadata: -1 (a < b), 0 (a == b), 1 (a > b). */
export function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === null || right === null) return 0
  if (left.major !== right.major) return left.major > right.major ? 1 : -1
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  const len = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < len; i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const lNum = /^\d+$/u.test(l)
    const rNum = /^\d+$/u.test(r)
    if (lNum && rNum) {
      const diff = Number(l) - Number(r)
      if (diff !== 0) return diff > 0 ? 1 : -1
      continue
    }
    if (lNum !== rNum) return lNum ? -1 : 1
    return l > r ? 1 : -1
  }
  return 0
}

/** True when `candidate` is strictly newer than `current` by SemVer. */
export function isNewerRelease(candidate, current) {
  return parseSemver(candidate) !== null && parseSemver(current) !== null && compareSemver(candidate, current) > 0
}
