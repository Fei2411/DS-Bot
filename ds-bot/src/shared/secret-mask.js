// Credential detection and masking shared by host diagnostics and browser UI.
// Pure ESM with zero Node-only dependencies so both host and browser bundles use one source of truth.

const VISIBLE_PREFIX_CHARS = 8
const WORD_CHAR = /[A-Za-z0-9_]/
const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g
const PEM_END_RE = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g
const URL_CRED_RE = /([a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@?#]{0,256}:)([^\s/@?#]+)@/g

// Prefixed provider keys, access keys, webhook secrets, and JWTs.
const TOKEN_PATTERNS = [
  // OpenAI / DeepSeek / Anthropic-style `sk-` keys: require at least one digit in the first 256 chars.
  { kind: 'token', re: /sk-[A-Za-z0-9_-]{20,}/g, check: raw => /\d/.test(raw.slice(0, 256)) },
  // Google API keys (fixed 39-char length: `AIza` + 35 chars).
  { kind: 'token', re: /AIza[A-Za-z0-9_-]{35}/g },
  // GitHub classic & fine-grained personal access tokens.
  { kind: 'token', re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { kind: 'token', re: /github_pat_[A-Za-z0-9_]{22,}/g },
  // GitLab PAT, npm token, HuggingFace token.
  { kind: 'token', re: /glpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'token', re: /npm_[A-Za-z0-9]{36,}/g },
  { kind: 'token', re: /hf_[A-Za-z0-9]{30,}/g },
  // AWS, Alibaba Cloud, and Tencent Cloud access key IDs.
  { kind: 'token', re: /(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9_])/g },
  { kind: 'token', re: /LTAI[A-Za-z0-9]{12,20}(?![A-Za-z0-9_])/g },
  { kind: 'token', re: /AKID[A-Za-z0-9]{28,36}(?![A-Za-z0-9_])/g },
  // Slack tokens.
  { kind: 'token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  // Stripe live/test API keys and webhook signing secrets.
  { kind: 'token', re: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'token', re: /whsec_[A-Za-z0-9]{24,}/g },
  // JSON Web Tokens (three base64url segments starting with eyJ.eyJ.).
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
]

function maskAllCodePoints(value) {
  let out = ''
  for (const ch of value) {
    out += (ch === '\n' || ch === '\r') ? ch : '*'
  }
  return out
}

function maskPrefixedToken(raw, visible = VISIBLE_PREFIX_CHARS) {
  let kept = ''
  let stars = ''
  let count = 0
  for (const ch of raw) {
    if (count < visible) {
      kept += ch
      count += 1
    } else {
      stars += (ch === '\n' || ch === '\r') ? ch : '*'
    }
  }
  return kept + stars
}

function maskPrivateKeyBlock(raw) {
  PEM_BEGIN_RE.lastIndex = 0
  const begin = PEM_BEGIN_RE.exec(raw)
  if (!begin) return maskAllCodePoints(raw)
  const bodyStart = begin.index + begin[0].length
  PEM_END_RE.lastIndex = bodyStart
  const end = PEM_END_RE.exec(raw)
  const bodyEnd = end ? end.index : raw.length
  return raw.slice(0, bodyStart) + maskAllCodePoints(raw.slice(bodyStart, bodyEnd)) + raw.slice(bodyEnd)
}

function maskSpan(raw, kind) {
  if (kind === 'private-key') return maskPrivateKeyBlock(raw)
  if (kind === 'url-password') return maskAllCodePoints(raw)
  return maskPrefixedToken(raw)
}

export function secretSpanKey(span) {
  return `${span.start}:${span.raw}`
}

/**
 * Finds all credential-like spans in `text`, returning sorted, non-overlapping spans:
 * `{ start, end, kind, raw, masked, key }`.
 */
export function detectSecrets(text) {
  if (typeof text !== 'string' || text.length < 10) return []
  const rawSpans = []

  // 1. PEM private key blocks.
  PEM_BEGIN_RE.lastIndex = 0
  let pem
  while ((pem = PEM_BEGIN_RE.exec(text)) !== null) {
    const start = pem.index
    const afterBegin = start + pem[0].length
    PEM_END_RE.lastIndex = afterBegin
    const closing = PEM_END_RE.exec(text)
    const end = closing ? closing.index + closing[0].length : text.length
    rawSpans.push({ start, end, kind: 'private-key' })
    PEM_BEGIN_RE.lastIndex = end
  }

  // 2. URL embedded passwords (`scheme://user:password@`).
  URL_CRED_RE.lastIndex = 0
  let urlMatch
  while ((urlMatch = URL_CRED_RE.exec(text)) !== null) {
    const fullStart = urlMatch.index
    if (fullStart > 0 && WORD_CHAR.test(text[fullStart - 1])) continue
    const pwStart = fullStart + urlMatch[1].length
    const pwEnd = pwStart + urlMatch[2].length
    if (pwEnd > pwStart) rawSpans.push({ start: pwStart, end: pwEnd, kind: 'url-password' })
  }

  // 3. Prefixed tokens, cloud keys, and JWTs.
  for (const { kind, re, check } of TOKEN_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const start = m.index
      if (start > 0 && WORD_CHAR.test(text[start - 1])) continue
      const raw = m[0]
      if (check && !check(raw)) continue
      rawSpans.push({ start, end: start + raw.length, kind })
    }
  }

  if (rawSpans.length === 0) return []
  rawSpans.sort((a, b) => (a.start - b.start) || (b.end - a.end))

  // Merge overlapping spans (keeping the earliest start and outer kind).
  const merged = []
  for (const span of rawSpans) {
    const prev = merged.at(-1)
    if (prev && span.start < prev.end) {
      if (span.end > prev.end) prev.end = span.end
      continue
    }
    merged.push({ ...span })
  }

  return merged.map((span) => {
    const raw = text.slice(span.start, span.end)
    const masked = maskSpan(raw, span.kind)
    return { ...span, raw, masked, key: `${span.start}:${raw}` }
  })
}

/**
 * Projects secret spans detected on `fullText` onto a folded/truncated slice `shownText`.
 * Guarantees folding never unmasks a credential crossing the fold boundary (including
 * truncated tokens, URL passwords cut before `@host`, and PEM keys cut before `-----END`)
 * and keeps each span's full-text `key` intact so reveal-then-copy always agrees.
 */
export function projectSecretsToSlice(fullText, shownText, fullSpans = null) {
  if (typeof shownText !== 'string' || shownText === '') return []
  const source = typeof fullText === 'string' ? fullText : shownText
  const spans = Array.isArray(fullSpans) ? fullSpans : detectSecrets(source)
  if (spans.length === 0) return []

  let sliceStart = 0
  if (shownText !== source) {
    const strippedOffset = source.length - source.replace(/^(\s*\n)+/, '').length
    if (source.startsWith(shownText, strippedOffset)) {
      sliceStart = strippedOffset
    } else {
      const idx = source.indexOf(shownText)
      if (idx === -1) return detectSecrets(shownText)
      sliceStart = idx
    }
  }
  const sliceEnd = sliceStart + shownText.length
  const projected = []

  for (const span of spans) {
    if (span.end <= sliceStart || span.start >= sliceEnd) continue
    const visStart = Math.max(span.start, sliceStart)
    const visEnd = Math.min(span.end, sliceEnd)
    const start = visStart - sliceStart
    const end = visEnd - sliceStart
    if (visStart === span.start && visEnd === span.end) {
      projected.push({ ...span, start, end })
      continue
    }
    const raw = source.slice(visStart, visEnd)
    const relStart = visStart - span.start
    let masked
    if (span.kind === 'url-password') {
      masked = maskAllCodePoints(raw)
    } else if (span.kind === 'private-key') {
      masked = relStart === 0 ? maskPrivateKeyBlock(raw) : maskAllCodePoints(raw)
    } else {
      const remainingPrefix = Math.max(0, VISIBLE_PREFIX_CHARS - relStart)
      masked = maskPrefixedToken(raw, remainingPrefix)
    }
    projected.push({
      start,
      end,
      kind: span.kind,
      raw,
      masked,
      key: span.key,
      clipped: true,
    })
  }
  return projected
}

/**
 * Returns `text` with all detected secrets masked except those whose `span.key` is in `revealedKeys`.
 */
export function maskSecrets(text, revealedKeys = null) {
  if (typeof text !== 'string' || text === '') return ''
  const spans = detectSecrets(text)
  if (spans.length === 0) return text
  const hasReveal = revealedKeys instanceof Set && revealedKeys.size > 0
  let out = ''
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) out += text.slice(cursor, span.start)
    out += (hasReveal && revealedKeys.has(span.key)) ? span.raw : span.masked
    cursor = span.end
  }
  if (cursor < text.length) out += text.slice(cursor)
  return out
}

/**
 * Replaces every detected secret in `text` with a log-safe placeholder (`sk-[hidden]` or `[hidden]`),
 * sharing the exact same detector rules with host diagnostics.
 */
export function redactSecretsForLog(text) {
  if (typeof text !== 'string' || text === '') return ''
  const spans = detectSecrets(text)
  if (spans.length === 0) return text
  let out = ''
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) out += text.slice(cursor, span.start)
    out += span.raw.startsWith('sk-') ? 'sk-[hidden]' : '[hidden]'
    cursor = span.end
  }
  if (cursor < text.length) out += text.slice(cursor)
  return out
}
