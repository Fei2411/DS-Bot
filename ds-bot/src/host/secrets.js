// Secrets: keys the user types into a card for a Bot. A value lives only in
// secrets.json (mode 600) and in this process; Bots use it as $DSH_SECRET_<NAME> in
// their shell, tool results lose it before they are saved, and every model request
// has it replaced by [secret:<NAME>] before it leaves.
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { cleanPassphrase, decryptSecrets, encryptSecrets, isEncryptedSecretsFile, passphraseFromEnv } from './secrets-crypto.js'
import { createSecretRefs, hashShellValue, shellFileKey } from './secret-refs.js'
import { createDefaultProviderRegistry } from './secret-providers/registry.js'
import { createSecretResolver } from './secret-providers/resolver.js'
import { serviceOf } from './services.js'
import { replaceFile } from './files.js'
import { output } from './tools.js'

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
export const ENV_PREFIX = 'DSH_SECRET_'
export const ENV_FILE_PREFIX = 'DSH_SECRET_FILE_'
// A short value (a PIN, a short password) would also hit ordinary words if it were
// replaced wherever it appears, so below WHOLE_VALUE it is replaced only where it
// stands alone: no letter or digit right before or after it.
export const MIN_VALUE = 4
export const WHOLE_VALUE = 8
export const MAX_VALUE = 16384
const MAX_REQUESTS = 20
const MAX_EPHEMERAL_REDACTIONS = 256
const USED_SAVE_MS = 5000
const DELIVERIES = new Set(['vault', 'ref', 'file'])
const SHELL_ENV_TOOLS = new Set(['bash', 'pwsh', 'terminal_open', 'terminal_send'])

export const envName = name => `${ENV_PREFIX}${name}`
export const envFileName = name => `${ENV_FILE_PREFIX}${name}`
export const canUse = (secret, botId) => secret !== undefined && botId !== undefined
  && (secret.scope === 'all' || (Array.isArray(secret.scope) && secret.scope.includes(botId)))

export function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/^\$(env:)?/i, '').replace(/^DSH_SECRET_/i, '').replace(/[\s-]+/g, '_').toUpperCase()
}

// encodeURIComponent leaves ' as is, but new URL() turns it into %27 in a query, so the
// URL sent out would hold a form the redactor does not know. Encoding these characters
// too keeps the sent URL equal to the text the redactor looks for.
export const encodeUrlComponent = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

const WORD_CHAR = /^[\p{L}\p{N}]$/u
const prevCodePoint = (text, index) => {
  if (index <= 0) return ''
  const code = text.codePointAt(index - 1)
  if (code >= 0xDC00 && code <= 0xDFFF && index >= 2) {
    const pair = text.codePointAt(index - 2)
    if (pair >= 0x10000) return String.fromCodePoint(pair)
  }
  return String.fromCodePoint(code)
}
const nextCodePoint = (text, index) => (index >= text.length ? '' : String.fromCodePoint(text.codePointAt(index)))
const isWordChar = char => char !== '' && WORD_CHAR.test(char)

const findNextMatch = (text, [needle, , short], from) => {
  let at = from
  while (at <= text.length - needle.length) {
    const pos = text.indexOf(needle, at)
    if (pos === -1) return -1
    if (!short || (!isWordChar(prevCodePoint(text, pos)) && !isWordChar(nextCodePoint(text, pos + needle.length)))) {
      return pos
    }
    at = pos + 1
  }
  return -1
}

// One function that replaces every known value in a string, longest first so a value
// that contains another is replaced whole. JSON-escaped, URL-encoded, CRLF/LF, and
// space-folded multiline forms are covered too. Pure literal scanning avoids V8's
// 32 KiB RegExp atom limit and keeps secret text out of SyntaxError messages.
export function redactor(entries) {
  const pairs = []
  const add = (seen, variant, label, short, priority) => {
    if (variant.length < MIN_VALUE || seen.has(variant)) return
    seen.add(variant)
    pairs.push([variant, label, short, priority])
  }
  const addEncoded = (seen, raw, label, short, priority) => {
    add(seen, raw, label, short, priority)
    const escaped = JSON.stringify(raw).slice(1, -1)
    if (escaped !== raw) add(seen, escaped, label, short, priority)
    // encodeURIComponent throws on a lone surrogate; such a value cannot sit in a URL anyway.
    const encoded = raw.isWellFormed() ? encodeUrlComponent(raw) : raw
    if (encoded !== raw && encoded !== escaped) add(seen, encoded, label, short, priority)
  }
  for (const { name, value } of entries) {
    if (typeof value !== 'string' || value.length < MIN_VALUE) continue
    const label = `[secret:${name}]`
    const multiline = /[\r\n]/.test(value)
    const lf = multiline ? value.replace(/\r\n?/g, '\n') : value
    const short = lf.length < WHOLE_VALUE
    const seen = new Set()
    addEncoded(seen, value, label, short, 0)
    // Cover trailing-newline-stripped and trimmed forms too (e.g. file-delivered
    // secrets with leading whitespace and trailing `\n` when POSIX command
    // substitution `$(cat "$file")` strips only trailing newlines).
    const withoutTrailingNewlines = lf.replace(/\n+$/, '')
    if (withoutTrailingNewlines !== lf && withoutTrailingNewlines.length >= MIN_VALUE) {
      addEncoded(seen, withoutTrailingNewlines, label, withoutTrailingNewlines.length < WHOLE_VALUE, 0)
    }
    const trimmed = lf.trim()
    if (trimmed !== lf && trimmed.length >= MIN_VALUE) {
      addEncoded(seen, trimmed, label, trimmed.length < WHOLE_VALUE, 0)
    }
    if (multiline) {
      const crlf = lf.replace(/\n/g, '\r\n')
      addEncoded(seen, lf, label, short, 0)
      addEncoded(seen, crlf, label, short, 0)
      if (withoutTrailingNewlines !== lf && withoutTrailingNewlines.includes('\n') && withoutTrailingNewlines.length >= MIN_VALUE) {
        addEncoded(seen, withoutTrailingNewlines.replace(/\n/g, '\r\n'), label, withoutTrailingNewlines.length < WHOLE_VALUE, 0)
      }
      // Unquoted shell expansion (`echo $DSH_SECRET_NAME`) and single-line logs fold
      // line breaks into spaces; cover those when long enough not to hit ordinary prose.
      const spaced = lf.replace(/\n/g, ' ')
      if (spaced.length >= WHOLE_VALUE) addEncoded(seen, spaced, label, false, 1)
      const collapsed = lf.replace(/\s+/g, ' ').trim()
      if (collapsed.length >= WHOLE_VALUE) addEncoded(seen, collapsed, label, false, 1)
    }
  }
  // Longest first; when two secrets share a variant of equal length, exact forms win over
  // synthetic space-folded forms.
  pairs.sort((a, b) => b[0].length - a[0].length || a[3] - b[3])
  if (pairs.length === 0) return text => text
  const seenNeedles = new Set()
  const unique = []
  for (const [needle, label, short] of pairs) {
    if (seenNeedles.has(needle)) continue
    seenNeedles.add(needle)
    unique.push([needle, label, short])
  }
  return (text) => {
    if (typeof text !== 'string') return text
    const hits = []
    for (const entry of unique) {
      if (text.includes(entry[0])) hits.push(entry)
    }
    if (hits.length === 0) return text
    const positions = hits.map(entry => findNextMatch(text, entry, 0))
    let out = ''
    let cursor = 0
    while (true) {
      let bestIndex = -1
      let bestPos = Infinity
      for (let i = 0; i < hits.length; i += 1) {
        const pos = positions[i]
        // `hits` is ordered longest-first (and exact before folded), so `<` picks the
        // earliest match and breaks ties by longest / highest priority.
        if (pos !== -1 && pos < bestPos) {
          bestPos = pos
          bestIndex = i
        }
      }
      if (bestIndex === -1) break
      const [needle, label] = hits[bestIndex]
      out += text.slice(cursor, bestPos) + label
      cursor = bestPos + needle.length
      for (let i = 0; i < hits.length; i += 1) {
        if (positions[i] !== -1 && positions[i] < cursor) {
          positions[i] = findNextMatch(text, hits[i], cursor)
        }
      }
    }
    return cursor === 0 ? text : out + text.slice(cursor)
  }
}

// Returns the same reference when nothing changed, so callers can tell cheaply.
export function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) {
    let next = null
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) continue
      const item = value[i]
      const replaced = redactDeep(item, redact)
      if (next !== null) {
        next[i] = replaced
      } else if (replaced !== item) {
        next = []
        next.length = value.length
        for (let j = 0; j < i; j += 1) {
          if (j in value) next[j] = value[j]
        }
        next[i] = replaced
      }
    }
    return next ?? value
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let next = null
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      const item = value[key]
      const replaced = redactDeep(item, redact)
      if (next !== null) {
        next[key] = replaced
      } else if (replaced !== item) {
        next = {}
        for (const prev in value) {
          if (prev === key) break
          if (Object.hasOwn(value, prev)) next[prev] = value[prev]
        }
        next[key] = replaced
      }
    }
    return next ?? value
  }
  return value
}

export function install(rt) {
  const { ctx, home, state } = rt
  const path = join(home, 'secrets.json')

  // How the file holds the values. `plaintext` is the default and the format older
  // versions wrote; `encrypted` is the optional envelope. The passphrase lives only in
  // this process: never in state.json, a log, or the view.
  const store = { mode: 'plaintext', locked: false, source: null, reason: null, passphrase: null }
  const secretStoreStatus = () => ({
    mode: store.mode,
    locked: store.locked === true,
    source: store.locked ? null : store.source,
    ...(store.locked && store.reason ? { reason: store.reason } : {}),
  })
  const LOCKED = 'The secrets store is locked. Unlock it in Settings → Secrets, or start DS Bot with DS_BOT_SECRETS_PASSPHRASE_FILE set to a file that holds the passphrase.'

  /** @type {Map<string, {name:string, value?:string, kind?:'external', providerId?:string, reference?:string, purpose:string, scope:'all'|string[], requestedBy:string|null, createdAt:number, updatedAt:number, lastUsedAt?:number}>} */
  const secrets = new Map()
  const providerRegistry = createDefaultProviderRegistry({
    ...rt.config?.secretProviders,
    onepassword: {
      tempDir: join(home, 'secret-files', '_op'),
      ...rt.config?.secretProviders?.onepassword,
    },
  })
  const resolver = createSecretResolver({ registry: providerRegistry })
  // Process-lifetime redaction memory for external secret values that may already have
  // been injected into running MCP servers or shell subprocesses. Kept in memory only,
  // deduplicated by value, never written to disk, and cleared when the host disposes.
  /** @type {Map<string, string>} */
  const retiredExternalRedactions = new Map()
  /** @type {Map<string, { name: string, value: string, expiresAt: number }>} */
  const ephemeralRedactions = new Map()
  let hasRedactions = false
  let hasExternalSecrets = false
  const shellMode = () => (state.prefs?.secretShellMode === 'file' ? 'file' : 'env')
  const providerConfigOf = (providerId) => state.prefs?.secretProviders?.[providerId] ?? {}
  const resolvedValueOf = (secret) => {
    if (secret === undefined) return undefined
    if (secret.kind === 'external') {
      const hit = resolver.getCached(secret.providerId, providerConfigOf(secret.providerId), secret.reference)
      return hit?.ok ? hit.value : undefined
    }
    return secret.value
  }
  const retireExternalValue = (name, value) => {
    if (typeof value === 'string' && value.length >= MIN_VALUE) {
      retiredExternalRedactions.set(value, name)
    }
  }
  const retireSecretValue = (secret) => {
    if (secret?.kind !== 'external') return
    const value = resolvedValueOf(secret)
    if (value !== undefined) retireExternalValue(secret.name, value)
  }
  const retireCachedExternals = (providerId) => {
    for (const secret of secrets.values()) {
      if (secret.kind !== 'external') continue
      if (providerId !== undefined && secret.providerId !== providerId) continue
      retireSecretValue(secret)
    }
  }
  const hasExternalRef = (providerId, reference, { exceptName } = {}) => {
    for (const secret of secrets.values()) {
      if (secret.kind === 'external' && secret.providerId === providerId && secret.reference === reference && secret.name !== exceptName) {
        return true
      }
    }
    return false
  }
  const invalidateRefIfUnused = (providerId, reference, options) => {
    if (!hasExternalRef(providerId, reference, options)) {
      resolver.invalidateRef(providerId, providerConfigOf(providerId), reference)
    }
  }
  const pruneExpiredEphemeral = (current = Date.now()) => {
    let removed = false
    for (const [id, entry] of ephemeralRedactions.entries()) {
      if (Number.isFinite(entry.expiresAt) && entry.expiresAt <= current) {
        ephemeralRedactions.delete(id)
        removed = true
      }
    }
    return removed
  }
  const rebuildRedactor = () => {
    pruneExpiredEphemeral()
    const entries = []
    hasExternalSecrets = false
    for (const secret of secrets.values()) {
      if (secret.kind === 'external') hasExternalSecrets = true
      const value = resolvedValueOf(secret)
      if (typeof value === 'string' && value.length >= MIN_VALUE) {
        entries.push({ name: secret.name, value })
      }
    }
    for (const [value, name] of retiredExternalRedactions.entries()) {
      if (typeof value === 'string' && value.length >= MIN_VALUE) {
        entries.push({ name, value })
      }
    }
    for (const { name, value } of ephemeralRedactions.values()) {
      if (typeof value === 'string' && value.length >= MIN_VALUE) {
        entries.push({ name, value })
      }
    }
    hasRedactions = entries.length > 0
    redact = redactor(entries)
    redactedMessages = new WeakMap()
  }
  const trackEphemeralPlaintext = (value, label, { id, expiresAt } = {}) => {
    if (typeof value !== 'string' || value.length < MIN_VALUE) return
    pruneExpiredEphemeral()
    const name = String(label || 'TEMP')
    const entryId = typeof id === 'string' && id !== '' ? id : `${name}:${randomUUID()}`
    if (ephemeralRedactions.has(entryId)) ephemeralRedactions.delete(entryId)
    ephemeralRedactions.set(entryId, {
      name,
      value,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 86_400_000,
    })
    while (ephemeralRedactions.size > MAX_EPHEMERAL_REDACTIONS) {
      const oldest = ephemeralRedactions.keys().next().value
      if (oldest === undefined) break
      ephemeralRedactions.delete(oldest)
    }
    rebuildRedactor()
  }
  const secretRefs = createSecretRefs({
    home,
    getEncryption: () => ({ mode: store.mode, locked: store.locked, passphrase: store.passphrase }),
    warn: (...args) => rt.warn(...args),
    onPlaintext: trackEphemeralPlaintext,
    onSweep: (current, removedIds = []) => {
      let changedEphemeral = pruneExpiredEphemeral(current)
      for (const id of removedIds) {
        if (ephemeralRedactions.delete(id)) changedEphemeral = true
      }
      if (changedEphemeral) rebuildRedactor()
    },
  })

  let loaded = null
  let writing = Promise.resolve()
  let mutating = Promise.resolve()
  const mutate = (run) => {
    const job = mutating.then(run)
    mutating = job.catch(() => {})
    return job
  }
  let redact = text => text
  let redactedMessages = new WeakMap()
  let refreshEnv = () => {}
  let refreshQueued = false
  let seenStamp = ''
  const fileStamp = () => {
    try {
      const { ino, ctimeMs, mtimeMs, size } = statSync(path)
      return `${ino}:${ctimeMs}:${mtimeMs}:${size}`
    } catch {
      return ''
    }
  }
  const scheduleRefreshEnv = () => {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(() => {
      refreshQueued = false
      refreshEnv()
    })
  }

  const pruneShellFiles = (excludeBotId = null) => {
    if (shellMode() !== 'file') {
      secretRefs.cleanupShellFiles()
      return
    }
    const keepKeys = new Set()
    const keepHashes = new Map()
    const botIds = Object.keys(state.bots ?? {})
    for (const secret of secrets.values()) {
      const value = resolvedValueOf(secret)
      if (typeof value !== 'string') continue
      const valHash = hashShellValue(value)
      for (const botId of botIds) {
        if (botId === excludeBotId || !canUse(secret, botId)) continue
        const key = shellFileKey(botId, secret.name)
        keepKeys.add(key)
        keepHashes.set(key, valHash)
      }
    }
    secretRefs.cleanupShellFiles({ keepKeys, keepHashes })
  }

  const notify = ({ declare = true } = {}) => {
    rebuildRedactor()
    pruneShellFiles()
    if (declare) refreshEnv()
    else scheduleRefreshEnv()
    rt.secretsChanged?.()
  }
  const changed = () => notify({ declare: true })

  // Error messages from JSON.parse quote the file, so only the code or name is logged.
  const reason = error => error?.code ?? error?.name ?? 'error'

  // While another dsh holds the team (or before store.load() has checked the lock),
  // that host owns secrets.json, so this host neither chmods nor writes backups and
  // re-reads before resolving or changing keys.
  let loadedReadOnly = false
  const readOnlyNow = () => rt.readOnly() !== undefined || rt.hasLoaded?.() === false
  // An existing secrets file that cannot be read is not an empty one: writing over it
  // would lose every key in it. While `blocked` holds the reason nothing is written,
  // and each load reads the file again (a busy file may only be briefly unreadable).
  let blocked
  const shouldReload = () => {
    if (loaded === null || blocked !== undefined) return true
    if (!loadedReadOnly && rt.readOnly() === undefined) return false
    if (loadedReadOnly && rt.readOnly() === undefined && rt.hasLoaded?.() !== false) return true
    return fileStamp() !== seenStamp
  }
  const loadSecrets = () => {
    if (loaded !== null && shouldReload()) loaded = null
    return loaded ??= readSecrets()
  }
  // The parsed body becomes the map. Only entries that name a key are kept.
  const fillSecrets = (parsed) => {
    secrets.clear()
    for (const entry of parsed.secrets) {
      if (!SECRET_NAME.test(entry?.name ?? '')) continue
      const common = {
        name: entry.name,
        purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
        scope: entry.scope === 'all' ? 'all' : Array.isArray(entry.scope) ? entry.scope.filter(id => typeof id === 'string') : 'all',
        requestedBy: typeof entry.requestedBy === 'string' ? entry.requestedBy : null,
        createdAt: Number(entry.createdAt) || Date.now(),
        updatedAt: Number(entry.updatedAt) || Date.now(),
        ...(Number.isFinite(entry.lastUsedAt) ? { lastUsedAt: entry.lastUsedAt } : {}),
      }
      if (entry.kind === 'external' && typeof entry.providerId === 'string' && typeof entry.reference === 'string') {
        secrets.set(entry.name, {
          ...common,
          kind: 'external',
          providerId: entry.providerId,
          reference: entry.reference,
        })
      } else if (typeof entry.value === 'string') {
        secrets.set(entry.name, {
          ...common,
          value: entry.value,
        })
      }
    }
  }
  const setPlaintext = () => {
    store.mode = 'plaintext'
    store.locked = false
    store.source = null
    store.reason = null
    store.passphrase = null
  }

  // Synchronous on purpose: a shell resolves its environment without an await, so the
  // map must be full before the first resolve after a start reads it.
  const readSecretsSync = ({ declare = true } = {}) => {
    loadedReadOnly = readOnlyNow()
    let contents
    try {
      contents = readFileSync(path, 'utf8')
      seenStamp = fileStamp()
    } catch (error) {
      seenStamp = fileStamp()
      if (error?.code === 'ENOENT') {
        blocked = undefined
        // A store this process knew as encrypted keeps its mode: losing the file must
        // not make the next write plaintext. A fresh process has no file and starts
        // plaintext, which is the default.
        if (store.mode === 'encrypted') {
          store.locked = true
          store.reason = 'missing-passphrase'
        } else {
          setPlaintext()
        }
        secrets.clear()
      } else {
        blocked = reason(error)
        rt.warn('ds-bot: unreadable secrets file %s (%s)', path, blocked)
      }
      notify({ declare })
      return
    }
    let parsed
    try {
      parsed = JSON.parse(contents)
    } catch {
      parsed = null
    }
    if (isEncryptedSecretsFile(parsed)) {
      store.mode = 'encrypted'
      store.locked = false
      store.reason = null
      let passphrase = store.passphrase
      let source = store.source
      if (passphrase === null) {
        const fromEnv = passphraseFromEnv()
        if (fromEnv?.passphrase !== undefined) {
          passphrase = fromEnv.passphrase
          source = fromEnv.source
        } else if (fromEnv?.error !== undefined) {
          store.locked = true
          store.reason = 'passphrase-source'
          secrets.clear()
          notify({ declare })
          rt.warn('ds-bot: %s Secrets stay locked until it is fixed.', fromEnv.error)
          return
        }
      }
      if (passphrase === null) {
        store.locked = true
        store.reason = 'missing-passphrase'
        secrets.clear()
        notify({ declare })
        rt.warn('ds-bot: secrets are encrypted and locked. Unlock them in Settings → Secrets, or set DS_BOT_SECRETS_PASSPHRASE_FILE.')
        return
      }
      let payload
      try {
        payload = decryptSecrets(parsed, passphrase)
      } catch (error) {
        store.locked = true
        store.reason = 'wrong-passphrase'
        store.passphrase = null
        secrets.clear()
        notify({ declare })
        rt.warn('ds-bot: the secrets file could not be unlocked (%s). Unlock it in Settings → Secrets or fix the passphrase source.', error?.message ?? error)
        return
      }
      store.locked = false
      store.passphrase = passphrase
      store.source = source ?? 'user'
      blocked = undefined
      fillSecrets(payload)
      if (!loadedReadOnly) try { chmodSync(path, 0o600) } catch {}
      notify({ declare })
      return
    }
    if (parsed !== null && typeof parsed === 'object' && (parsed.encrypted === true || typeof parsed.ciphertext === 'string')) {
      blocked = 'secrets/format'
      store.mode = 'encrypted'
      store.locked = true
      store.reason = 'format'
      secrets.clear()
      notify({ declare })
      return
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.secrets)) {
      if (loadedReadOnly) {
        blocked = 'secrets/format'
        setPlaintext()
        secrets.clear()
        rt.warn('ds-bot: unreadable secrets file %s (read-only mode)', path)
        notify({ declare })
        return
      }
      // A file that is not a secrets file is kept aside, like a broken state.json, then
      // the store goes on with an empty one.
      const backup = `${path}.broken-${Date.now()}`
      try {
        copyFileSync(path, backup)
        blocked = undefined
        setPlaintext()
        secrets.clear()
        rt.warn('ds-bot: unreadable secrets file %s; backed up as %s', path, backup)
      } catch (error) {
        blocked = reason(error)
        rt.warn('ds-bot: unreadable secrets file %s; backup failed: %s', path, error)
      }
      notify({ declare })
      return
    }
    blocked = undefined
    setPlaintext()
    fillSecrets(parsed)
    if (!loadedReadOnly) try { chmodSync(path, 0o600) } catch {}
    notify({ declare })
  }
  let restoredFilesPromise = null
  const ensureRestoredSecretFiles = () => {
    if (restoredFilesPromise !== null) return restoredFilesPromise
    const cleanExpired = !readOnlyNow()
    restoredFilesPromise = secretRefs.restoreSecretFiles({ cleanExpired })
      .catch(error => {
        restoredFilesPromise = null
        rt.warn('ds-bot: secret-files restore failed: %s', reason(error))
        return 0
      })
    return restoredFilesPromise
  }
  const readSecrets = async () => {
    readSecretsSync({ declare: true })
    await ensureRestoredSecretFiles()
  }

  // Resolves once secrets.json holds the current map; rejects when the write failed.
  const persist = () => {
    if (blocked !== undefined) return Promise.reject(new Error(`The secrets file ${path} could not be read (${blocked}). DS Bot does not change it; fix or move the file and reload.`))
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) return Promise.reject(new Error(readOnly))
    if (store.mode === 'encrypted' && (store.locked || store.passphrase === null)) return Promise.reject(new Error(LOCKED))
    const payload = { version: 1, secrets: [...secrets.values()] }
    let snapshot
    try {
      snapshot = JSON.stringify(store.mode === 'encrypted' ? encryptSecrets(payload, store.passphrase) : payload, null, 2)
    } catch (error) {
      return Promise.reject(error)
    }
    const job = writing.then(async () => {
      await mkdir(home, { recursive: true })
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
        await chmod(temp, 0o600)
        await replaceFile(temp, path)
        seenStamp = fileStamp()
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    writing = job.catch(error => rt.warn('ds-bot: secrets write failed (%s)', reason(error)))
    return job
  }

  let usedTimer = null
  const noteUsed = () => {
    if (usedTimer !== null) return
    usedTimer = setTimeout(() => {
      usedTimer = null
      if (loadedReadOnly || rt.readOnly() !== undefined || blocked !== undefined) return
      void mutate(() => persist()).catch(() => {})
    }, USED_SAVE_MS)
    usedTimer.unref?.()
  }

  // A Bot's pending secret cards, keyed by its id. A key that is not a real Bot (and
  // never an inherited name like "__proto__", which a plain assignment would not even
  // set as a key) gets a throwaway list instead of a stored one.
  const requestsOf = (botId) => {
    const requests = (state.secretRequests ??= {})
    if (!Object.hasOwn(requests, botId) && rt.botOf(botId) === undefined) return []
    return (requests[botId] ??= [])
  }
  const findRequest = (id) => {
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      const request = list.find(entry => entry.id === id)
      if (request !== undefined) return { botId, request }
    }
    return undefined
  }
  const trimRequests = (list) => {
    while (list.length > MAX_REQUESTS) {
      const settled = list.findIndex(entry => entry.status !== 'pending')
      list.splice(settled === -1 ? 0 : settled, 1)
    }
  }

  const scopeText = (scope) => {
    if (scope === 'all') return 'every Bot'
    const names = scope.map(id => rt.botOf(id)?.name).filter(Boolean)
    return names.length === 0 ? 'no Bot' : names.join(', ')
  }
  const usage = (name) => {
    if (shellMode() === 'file') {
      return `the file path in $${envFileName(name)} in bash, or $env:${envFileName(name)} in PowerShell`
    }
    return `$${envName(name)} in bash, or $env:${envName(name)} in PowerShell`
  }

  async function tell(botId, text) {
    if (rt.botOf(botId) === undefined) return
    await rt.deliver({ toId: botId, role: 'secret', text })
      .catch(error => rt.warn('ds-bot: secret note to %s failed: %s', botId, error))
  }
  const savedNote = (name, lead) => [
    `${lead} Use it as ${usage(name)}.`,
    'You cannot see the value. Never print, echo, or log it, and never ask the user to paste it into the chat. Carry on with what you needed it for.',
  ].join(' ')

  function settle(botId, request, status) {
    request.status = status
    request.settledAt = Date.now()
    if (status === 'saved' || status === 'allowed') request.scope = secrets.get(request.name)?.scope ?? 'all'
  }

  // After any change to `name`, every pending card for it either resolves (its Bot can
  // use the key now) or shows the form that still applies.
  function reconcile(name, notes, except) {
    const secret = secrets.get(name)
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      for (const request of list) {
        if (request.status !== 'pending' || request.name !== name || request === except) continue
        if ((request.delivery ?? 'vault') !== 'vault') continue
        if (canUse(secret, botId)) {
          settle(botId, request, 'saved')
          notes.push([botId, savedNote(name, `The user saved ${name}, and you may use it now.`)])
        } else {
          request.kind = secret ? 'allow' : 'fill'
        }
      }
    }
  }

  async function commit(notes) {
    changed()
    await persist()
    await rt.save()
    for (const [botId, text] of notes) await tell(botId, text)
  }

  const cleanValue = (raw) => {
    if (typeof raw !== 'string') throw new Error('Type the key first')
    const value = raw.replace(/\r\n?/g, '\n').trim()
    if (value.includes('\0')) throw new Error('A key cannot contain null bytes')
    if (value.length < MIN_VALUE) throw new Error(`A key must have at least ${MIN_VALUE} characters`)
    if (value.length > MAX_VALUE) throw new Error(`A key can have at most ${MAX_VALUE} characters`)
    return value
  }
  // Preserves exact bytes (including leading/trailing whitespace and trailing `\n`
  // required by OpenSSH private keys) for `delivery: 'file'` temp files.
  const cleanFileValue = (raw) => {
    if (typeof raw !== 'string') throw new Error('Type the key first')
    if (raw.includes('\0')) throw new Error('A key cannot contain null bytes')
    const trimmedLen = raw.trim().length
    if (trimmedLen === 0) throw new Error('Type the key first')
    if (trimmedLen < MIN_VALUE) throw new Error(`A key must have at least ${MIN_VALUE} characters`)
    if (raw.length > MAX_VALUE) throw new Error(`A key can have at most ${MAX_VALUE} characters`)
    return raw
  }
  const cleanScope = (raw) => {
    if (raw === 'all') return 'all'
    if (!Array.isArray(raw)) throw new Error('Choose every Bot or a list of Bots')
    return [...new Set(raw.filter(id => typeof id === 'string' && rt.botOf(id) !== undefined))]
  }
  const pendingRequest = (id) => {
    const found = findRequest(String(id ?? ''))
    if (found === undefined) throw new Error('This request is gone')
    if (found.request.status !== 'pending') throw new Error('This request was already answered')
    return found
  }

  const cleanReference = (raw) => {
    const reference = String(raw ?? '').trim()
    const driver = providerRegistry.findForReference(reference)
    if (driver === undefined) {
      throw new Error('Enter a valid 1Password reference like op://vault/item/field')
    }
    return { providerId: driver.kind, reference }
  }
  const secretView = (secret) => {
    const base = {
      name: secret.name,
      purpose: secret.purpose,
      scope: secret.scope,
      requestedBy: secret.requestedBy,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      ...(secret.lastUsedAt !== undefined ? { lastUsedAt: secret.lastUsedAt } : {}),
    }
    if (secret.kind !== 'external') return base
    const hit = resolver.getCached(secret.providerId, providerConfigOf(secret.providerId), secret.reference)
    return {
      ...base,
      kind: 'external',
      providerId: secret.providerId,
      reference: secret.reference,
      externalStatus: hit === undefined ? 'pending' : hit.ok ? 'ready' : 'error',
      ...(hit && !hit.ok ? { externalError: String(hit.error?.message ?? 'Failed to resolve').slice(0, 200) } : {}),
    }
  }
  const secretsView = () => [...secrets.values()].sort((a, b) => a.name.localeCompare(b.name)).map(secretView)

  const externalItemsForBot = (botId, names) => {
    const nameSet = names === undefined ? null : (names instanceof Set ? names : new Set(names))
    if (nameSet !== null && nameSet.size === 0) return []
    const items = []
    for (const secret of secrets.values()) {
      if (secret.kind !== 'external') continue
      if (nameSet !== null && !nameSet.has(secret.name)) continue
      if (botId !== undefined && !canUse(secret, botId)) continue
      items.push({
        name: secret.name,
        providerId: secret.providerId,
        config: providerConfigOf(secret.providerId),
        reference: secret.reference,
      })
    }
    return items
  }
  const hasUncachedExternalForBot = (botId) => {
    if (!hasExternalSecrets) return false
    for (const secret of secrets.values()) {
      if (secret.kind !== 'external') continue
      if (botId !== undefined && !canUse(secret, botId)) continue
      if (resolver.getCached(secret.providerId, providerConfigOf(secret.providerId), secret.reference) === undefined) return true
    }
    return false
  }
  async function resolveExternalForBot(botId, { signal, names } = {}) {
    if (loaded === null) await loadSecrets()
    if (!hasExternalSecrets) return { resolved: 0, failed: 0, errors: {} }
    const items = externalItemsForBot(botId, names)
    if (items.length === 0) return { resolved: 0, failed: 0, errors: {} }
    const hadBefore = items.map(item => resolver.getCached(item.providerId, item.config, item.reference))
    const results = await resolver.resolve(items, { signal })
    let resolved = 0
    let failed = 0
    let changedAny = false
    const errors = {}
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      const res = results.get(item.reference)
      if (res?.ok) {
        resolved += 1
        retireExternalValue(item.name, res.value)
        if (!hadBefore[i]?.ok || hadBefore[i].value !== res.value) changedAny = true
      } else {
        failed += 1
        errors[item.name] = res?.error?.message ?? 'Failed to resolve external secret'
        if (hadBefore[i] === undefined) changedAny = true
      }
    }
    if (changedAny) {
      rebuildRedactor()
      scheduleRefreshEnv()
    }
    return { resolved, failed, errors }
  }
  function resolveUncachedExternalForBot(botId, signal) {
    if (botId === undefined || !hasUncachedExternalForBot(botId)) return
    return resolveExternalForBot(botId, { signal }).catch(error => {
      if (!signal?.aborted) rt.warn('ds-bot: external secret resolution failed: %s', error?.message ?? 'error')
    })
  }
  const botForSecretSession = sessionId => blocked === undefined && !store.locked ? rt.selfOf(sessionId) : undefined
  async function prepareSecretEnvForSession(sessionId, signal) {
    signal?.throwIfAborted()
    if (rt.hasLoaded?.() === false) await rt.load()
    if (shouldReload()) await loadSecrets()
    let botId = botForSecretSession(sessionId)
    if (botId === undefined && rt.readOnly() !== undefined) {
      rt.syncReadOnly?.()
      botId = botForSecretSession(sessionId)
    }
    if (rt.botOf(botId) !== undefined) await resolveUncachedExternalForBot(botId, signal)
  }
  const invalidateExternal = (providerId) => {
    retireCachedExternals(providerId)
    resolver.invalidate(providerId)
    if (shellMode() === 'file') secretRefs.cleanupShellFiles()
    rebuildRedactor()
    scheduleRefreshEnv()
  }
  const onPrefsChanged = ({ shellModeChanged = false, providersChanged = false } = {}) => {
    if (providersChanged) {
      retireCachedExternals()
      resolver.invalidate()
    }
    if (shellModeChanged || providersChanged) {
      secretRefs.cleanupShellFiles()
      changed()
    }
  }

  // The encrypted envelope on disk, for unlock and rollback. A plaintext file stays a
  // valid plaintext file; only the two explicit actions move between the modes.
  const readEnvelope = () => {
    let parsed
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { parsed = null }
    if (!isEncryptedSecretsFile(parsed)) throw new Error('The secrets file is not encrypted.')
    return parsed
  }

  const endpoints = {
    // The settings card: the mode, whether this process can read the values, and why not.
    async 'secret-store'() {
      return secretStoreStatus()
    },
    // A typed passphrase unlocks the store for this process; the file is unchanged.
    async 'secret-unlock'(body) {
      const passphrase = cleanPassphrase(body.passphrase)
      await writing
      const payload = decryptSecrets(readEnvelope(), passphrase)
      store.mode = 'encrypted'
      store.locked = false
      store.reason = null
      store.source = 'user'
      store.passphrase = passphrase
      blocked = undefined
      fillSecrets(payload)
      changed()
      // A reading host cannot save; unlocking still works in this process.
      await rt.save().catch(() => {})
      return secretStoreStatus()
    },
    // Rewrite the same file as an envelope. The plaintext file is replaced atomically,
    // so the two forms never sit on disk together.
    async 'secret-encrypt'(body) {
      const passphrase = cleanPassphrase(body.passphrase)
      if (store.mode === 'encrypted') throw new Error('Secrets are already encrypted.')
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) throw new Error(readOnly)
      const previous = { ...store }
      store.mode = 'encrypted'
      store.passphrase = passphrase
      store.source = 'user'
      store.locked = false
      store.reason = null
      let persisted = false
      try {
        await persist()
        persisted = true
        await secretRefs.rekeyRefs({ fromPassphrase: null, toPassphrase: passphrase })
      } catch (error) {
        if (persisted) {
          await secretRefs.rekeyRefs({ fromPassphrase: passphrase, toPassphrase: null }).catch(() => {})
        }
        Object.assign(store, previous)
        if (persisted) await persist().catch(() => {})
        throw error
      }
      changed()
      await rt.save()
      return secretStoreStatus()
    },
    // Write the values back as the plaintext file, after proving the passphrase against
    // the current envelope. This is also the recovery path while the store is locked.
    async 'secret-decrypt'(body) {
      const passphrase = cleanPassphrase(body.passphrase)
      if (store.mode !== 'encrypted') throw new Error('Secrets are not encrypted.')
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) throw new Error(readOnly)
      await writing
      const payload = decryptSecrets(readEnvelope(), passphrase)
      const previous = { ...store }
      const before = [...secrets.values()]
      fillSecrets(payload)
      store.mode = 'plaintext'
      store.locked = false
      store.reason = null
      store.source = null
      // Keep the verified passphrase available while in-flight encrypted secret-refs are
      // decrypted so concurrent consumeRef calls never hit SECRET_STORE_LOCKED.
      store.passphrase = passphrase
      let persisted = false
      try {
        await persist()
        persisted = true
        await secretRefs.rekeyRefs({ fromPassphrase: passphrase, toPassphrase: null })
      } catch (error) {
        if (persisted) {
          await secretRefs.rekeyRefs({ fromPassphrase: null, toPassphrase: passphrase }).catch(() => {})
        }
        Object.assign(store, previous)
        secrets.clear()
        for (const secret of before) secrets.set(secret.name, secret)
        if (persisted) await persist().catch(() => {})
        changed()
        throw error
      }
      store.passphrase = null
      changed()
      await rt.save()
      return secretStoreStatus()
    },
    // From a card (requestId) or from the settings page (name).
    async 'secret-set'(body) {
      const now = Date.now()
      const notes = []
      const hasRefInput = typeof body.reference === 'string' && body.reference.trim() !== ''
      if (body.requestId !== undefined) {
        const { botId, request } = pendingRequest(body.requestId)
        const delivery = request.delivery ?? 'vault'
        if (delivery === 'ref') {
          const value = cleanValue(body.value)
          const ref = await secretRefs.issueRef({
            botId,
            sessionId: request.sessionId ?? botId,
            requestId: request.id,
            field: request.name,
            value,
          })
          settle(botId, request, 'saved')
          await rt.save()
          await tell(botId, `The user provided ${request.name} as a one-time secret reference: ${ref}. Pass this handle to a Bot host tool that accepts secret-ref handles (such as save_capability); it is deleted on first use and expires in 24 hours. You cannot see the value.`)
          return { name: request.name, delivery: 'ref', status: 'saved' }
        }
        if (delivery === 'file') {
          const value = cleanFileValue(body.value)
          const { filePath, expiresAt } = await secretRefs.writeSecretFile({
            botId,
            sessionId: request.sessionId ?? botId,
            name: request.name,
            value,
          })
          settle(botId, request, 'saved')
          await rt.save()
          await tell(botId, `The user provided ${request.name} in a private temporary file (0600): ${filePath} (expires at ${new Date(expiresAt).toISOString()}). Read it from that path in your command and never print, echo, or log its contents.`)
          return { name: request.name, delivery: 'file', expiresAt, status: 'saved' }
        }
        const existing = secrets.get(request.name)
        let scope
        if (existing === undefined || request.kind === 'fill') scope = body.scope === 'bot' ? [botId] : 'all'
        else scope = existing.scope === 'all' ? 'all' : [...new Set([...existing.scope, botId])]
        if (hasRefInput) {
          const { providerId, reference } = cleanReference(body.reference)
          retireSecretValue(existing)
          secrets.set(request.name, {
            name: request.name,
            kind: 'external',
            providerId,
            reference,
            purpose: existing?.purpose || request.purpose,
            scope,
            requestedBy: existing?.requestedBy ?? botId,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
          })
          if (existing?.kind === 'external' && (existing.providerId !== providerId || existing.reference !== reference)) {
            invalidateRefIfUnused(existing.providerId, existing.reference)
          }
          invalidateRefIfUnused(providerId, reference, { exceptName: request.name })
        } else {
          const value = cleanValue(body.value)
          retireSecretValue(existing)
          secrets.set(request.name, {
            name: request.name,
            value,
            purpose: existing?.purpose || request.purpose,
            scope,
            requestedBy: existing?.requestedBy ?? botId,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
          })
          if (existing?.kind === 'external') {
            invalidateRefIfUnused(existing.providerId, existing.reference)
          }
        }
        settle(botId, request, 'saved')
        notes.push([botId, savedNote(request.name, `The user saved ${request.name} for ${scopeText(scope)}.`)])
        reconcile(request.name, notes, request)
        await commit(notes)
        return secretView(secrets.get(request.name))
      }
      const name = normalizeName(body.name)
      if (!SECRET_NAME.test(name)) throw new Error('A name uses capitals, digits, and underscores, and starts with a letter')
      const existing = secrets.get(name)
      if (hasRefInput) {
        const { providerId, reference } = cleanReference(body.reference)
        retireSecretValue(existing)
        secrets.set(name, {
          name,
          kind: 'external',
          providerId,
          reference,
          purpose: typeof body.purpose === 'string' && body.purpose.trim() !== '' ? body.purpose.trim().slice(0, 300) : existing?.purpose ?? '',
          scope: body.scope !== undefined ? cleanScope(body.scope) : existing?.scope ?? 'all',
          requestedBy: existing?.requestedBy ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
        })
        if (existing?.kind === 'external' && (existing.providerId !== providerId || existing.reference !== reference)) {
          invalidateRefIfUnused(existing.providerId, existing.reference)
        }
        invalidateRefIfUnused(providerId, reference, { exceptName: name })
      } else {
        const value = cleanValue(body.value)
        retireSecretValue(existing)
        secrets.set(name, {
          name,
          value,
          purpose: typeof body.purpose === 'string' && body.purpose.trim() !== '' ? body.purpose.trim().slice(0, 300) : existing?.purpose ?? '',
          scope: body.scope !== undefined ? cleanScope(body.scope) : existing?.scope ?? 'all',
          requestedBy: existing?.requestedBy ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
        })
        if (existing?.kind === 'external') {
          invalidateRefIfUnused(existing.providerId, existing.reference)
        }
      }
      reconcile(name, notes)
      await commit(notes)
      return secretView(secrets.get(name))
    },
    async 'secret-refresh-external'(body) {
      const providerId = typeof body.providerId === 'string' && body.providerId !== '' ? body.providerId : undefined
      invalidateExternal(providerId)
      if (body.resolve === true) {
        return resolveExternalForBot(undefined)
      }
      return { refreshed: true }
    },
    async 'secret-allow'(body) {
      const { botId, request } = pendingRequest(body.requestId)
      if ((request.delivery ?? 'vault') !== 'vault') throw new Error('This request cannot be answered with an existing key')
      const secret = secrets.get(request.name)
      if (secret === undefined) throw new Error(`${request.name} is not saved yet`)
      if (!canUse(secret, botId)) secret.scope = [...new Set([...secret.scope, botId])]
      secret.updatedAt = Date.now()
      settle(botId, request, 'allowed')
      const notes = [[botId, savedNote(request.name, `The user let you use ${request.name}.`)]]
      reconcile(request.name, notes, request)
      await commit(notes)
      return secretView(secret)
    },
    async 'secret-cancel'(body) {
      const { botId, request } = pendingRequest(body.requestId)
      settle(botId, request, 'canceled')
      await rt.save()
      await tell(botId, `The user canceled your request for ${request.name}. Do not ask for it again unless the user brings it up; carry on without it, or tell the user what you cannot do without it.`)
      return true
    },
    async 'secret-update'(body) {
      const secret = secrets.get(normalizeName(body.name))
      if (secret === undefined) throw new Error('No such key')
      if (body.scope !== undefined) secret.scope = cleanScope(body.scope)
      if (typeof body.purpose === 'string') secret.purpose = body.purpose.trim().slice(0, 300)
      secret.updatedAt = Date.now()
      const notes = []
      reconcile(secret.name, notes)
      await commit(notes)
      return secretView(secret)
    },
    async 'secret-delete'(body) {
      const name = normalizeName(body.name)
      const existing = secrets.get(name)
      if (existing === undefined) throw new Error('No such key')
      if (existing.kind === 'external') {
        retireSecretValue(existing)
      }
      secrets.delete(name)
      if (existing.kind === 'external') {
        invalidateRefIfUnused(existing.providerId, existing.reference)
      }
      const notes = []
      reconcile(name, notes)
      await commit(notes)
      return true
    },
  }

  // A locked store has no values to change; a write would also replace the encrypted
  // file with an empty one. Unlocking and rolling back are the exceptions.
  const LOCKED_ENDPOINTS = new Set(['secret-set', 'secret-allow', 'secret-update', 'secret-delete'])
  function secretEndpoint(endpoint, body) {
    return mutate(async () => {
      await loadSecrets()
      if (store.locked && LOCKED_ENDPOINTS.has(endpoint)) throw new Error(LOCKED)
      return endpoints[endpoint](body ?? {})
    })
  }

  // A deleted Bot leaves every list it was on, and its cards go with it.
  function forgetBotSecrets(botId) {
    return mutate(async () => {
      await loadSecrets()
      if (state.secretRequests !== undefined) delete state.secretRequests[botId]
      let touched = false
      for (const secret of secrets.values()) {
        if (Array.isArray(secret.scope) && secret.scope.includes(botId)) {
          secret.scope = secret.scope.filter(id => id !== botId)
          touched = true
        }
      }
      pruneShellFiles(botId)
      await secretRefs.removeBotFiles(botId).catch(() => {})
      if (touched) {
        changed()
        await persist().catch(() => {})
      }
    })
  }

  const resolveBotId = (execution) => {
    for (const id of [execution?.agent?.session?.header?.id, execution?.agent?.session?.id, execution?.agent?.id]) {
      if (typeof id !== 'string' || id === '') continue
      const botId = rt.selfOf(id)
      if (botId !== undefined) return botId
    }
    return undefined
  }
  const callerOf = exec => resolveBotId(exec)

  rt.teamTools.push(defineTool({
    name: 'request_secret',
    description: 'Ask the user for a key, token, or password through a secure card in your own chat. The user types it into the card; you never see the value. Default delivery ("vault") saves it to Secrets and exposes it to your shell. Use delivery="ref" for a one-time secret-ref handle (not saved to Secrets) to pass to Bot host tools that consume secret-ref handles (such as save_capability), or delivery="file" for a private 0600 temporary file deleted after 24 hours. Showing a card ends your turn; a note arrives when the user saves or cancels.',
    parameters: {
      name: { type: 'string', required: true, description: 'Key name in capitals, digits, and underscores, e.g. GITHUB_TOKEN' },
      purpose: { type: 'string', required: true, description: 'One short line for the user: what you need it for' },
      delivery: { type: 'string', enum: ['vault', 'ref', 'file'], description: 'Delivery mode: vault (default), ref (one-time secret-ref handle), or file (private 0600 temporary file)' },
      value: { type: 'string', description: 'Optional, only with delivery="file": save a secret the user already pasted into chat directly to a private 0600 temporary file without showing a card' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      await loadSecrets()
      if (store.locked) return LOCKED
      const id = exec.agent?.id
      const bot = rt.botOf(callerOf(exec))
      if (bot === undefined) return 'Only Bots on the team can use request_secret.'
      const name = normalizeName(args.name)
      if (!SECRET_NAME.test(name)) return 'Name the key with capitals, digits, and underscores, starting with a letter (for example GITHUB_TOKEN).'
      const delivery = args.delivery === undefined ? 'vault' : String(args.delivery)
      if (!DELIVERIES.has(delivery)) return 'Delivery must be vault, ref, or file.'
      if (typeof args.value === 'string' && args.value !== '') {
        if (delivery !== 'file') return 'Direct value saving is only supported with delivery="file".'
        const readOnly = rt.readOnly()
        if (readOnly !== undefined) return `Cannot write a temporary secret file now. ${readOnly}`
        let value
        try { value = cleanFileValue(args.value) } catch (error) { return error.message }
        const { filePath, expiresAt } = await secretRefs.savePastedFile({
          botId: bot.id,
          sessionId: id ?? bot.id,
          name,
          value,
        })
        return `Saved ${name} to a private temporary file (0600): ${filePath} (expires at ${new Date(expiresAt).toISOString()}). Read it from that path in your command and never print, echo, or log its contents.`
      }
      const secret = delivery === 'vault' ? secrets.get(name) : undefined
      if (delivery === 'vault' && canUse(secret, bot.id)) return `${name} is already saved and you may use it: ${usage(name)}. You cannot see the value; never print it.`
      if (rt.taskOwners?.has(id)) return `Background tasks cannot show secret cards directly. End or report back to your own chat naming ${name} and why you need it, so your own chat can request it from the user.`
      if (rt.groupOwners.has(id)) return 'Secret cards only work in your own chat. Tell the group you will ask the user in your own chat, and call request_secret there.'
      if (!rt.chatOwners.has(id)) return 'Secret cards only work in your current own chat.'
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) return `No card can be shown now. ${readOnly}`
      const list = requestsOf(bot.id)
      const now = Date.now()
      for (const request of list) {
        if (request.status === 'pending' && request.name === name) {
          request.status = 'canceled'
          request.settledAt = now
        }
      }
      list.push({
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        sessionId: id,
        name,
        purpose: String(args.purpose ?? '').trim().slice(0, 300),
        kind: secret ? 'allow' : 'fill',
        ...(delivery !== 'vault' ? { delivery } : {}),
        status: 'pending',
        askedAt: now,
      })
      trimRequests(list)
      await rt.save()
      exec.concludeTurn?.()
      return secret
        ? `The card asking the user to let you use ${name} is on screen. A note arrives when the user answers; you will not see the value.`
        : `The card asking the user for ${name} is on screen. A note arrives when the user saves or cancels; you will not see the value.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'list_secrets',
    description: 'List the keys the user saved for the team: name, purpose, which Bots may use them, and whether you may. Values are never shown.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      await loadSecrets()
      if (store.locked) return LOCKED
      const self = callerOf(exec)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use list_secrets.'
      if (secrets.size === 0) return 'No keys are saved yet. Ask for one with request_secret.'
      const varFor = name => (shellMode() === 'file' ? `$${envFileName(name)}` : `$${envName(name)}`)
      return [
        'Saved keys (values are never shown):',
        ...secretsView().map(secret => `- ${secret.name}${secret.kind === 'external' ? ` (${providerRegistry.get(secret.providerId)?.label ?? secret.providerId})` : ''}${secret.purpose ? ` — ${secret.purpose}` : ''} — for ${scopeText(secret.scope)} — ${canUse(secrets.get(secret.name), self) ? `you may use it as ${varFor(secret.name)}` : 'you may not use it; ask with request_secret'}`),
      ].join('\n')
    },
  }))

  // Tool results lose the values before the registry renders and saves them. Every
  // field is redacted — a wrapper further out in the pipeline still sees a whole
  // result (its `content`, `meta`, and `additionalContexts` too), and the registry
  // re-renders a changed success result from its redacted value.
  ctx.on('tools/execute', async (exec, next) => {
    if (hasExternalSecrets && SHELL_ENV_TOOLS.has(exec?.name)) {
      await resolveUncachedExternalForBot(resolveBotId(exec))
    }
    const result = await next()
    if (!hasRedactions || result === null || typeof result !== 'object') return result
    return redactDeep(result, redact)
  })

  // Anything that still carries a value (the user pasted it, an earlier part kept it)
  // is replaced before the request leaves. `next` cannot take new options, so the
  // request starts over; it then carries no value and passes through here.
  // A value that is part of its own label would be replaced again on every pass, so a
  // request this listener rewrote passes straight through.
  const rewritten = new WeakSet()
  const freezeCopies = value => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const key of Reflect.ownKeys(value)) freezeCopies(Object.getOwnPropertyDescriptor(value, key).value)
    return Object.freeze(value)
  }
  const immutableData = value => {
    if (value === null || typeof value !== 'object') return typeof value !== 'function'
    const prototype = Object.getPrototypeOf(value)
    if (!Object.isFrozen(value)) return false
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return false
      for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false
    } else if (prototype !== Object.prototype && prototype !== null) return false
    return Reflect.ownKeys(value).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return Object.hasOwn(descriptor, 'value') && immutableData(descriptor.value)
    })
  }
  ctx.on('llm/stream', (options, next) => {
    if (!hasRedactions || rewritten.has(options.messages)) return next()
    let messages = options.messages
    if (Array.isArray(messages)) {
      let nextMessages = null
      for (let i = 0; i < messages.length; i += 1) {
        const message = messages[i]
        const object = message !== null && typeof message === 'object'
        let replaced
        if (object && redactedMessages.has(message)) replaced = redactedMessages.get(message)
        else {
          replaced = redactDeep(message, redact)
          if (object && immutableData(message)) redactedMessages.set(message, freezeCopies(replaced))
        }
        if (nextMessages !== null) {
          nextMessages[i] = replaced
        } else if (replaced !== message) {
          nextMessages = messages.slice(0, i)
          nextMessages.push(replaced)
        }
      }
      if (nextMessages !== null) messages = nextMessages
    } else messages = redactDeep(messages, redact)
    const system = redactDeep(options.system, redact)
    if (messages === options.messages && system === options.system) return next()
    const fresh = [...(messages ?? [])]
    rewritten.add(fresh)
    rt.carryUsageTag(options.messages, fresh)
    const llm = serviceOf(ctx, 'llm')
    if (llm === undefined) return next()
    return llm.stream({ ...options, messages: fresh, ...(system !== undefined ? { system } : {}) })
  })

  function resolveEnv(botForSession, declaredKeys, command = '') {
    if (rt.hasLoaded?.() === false) void rt.load()
    if (loaded === null || loadedReadOnly || rt.readOnly() !== undefined || blocked !== undefined) {
      if (loaded === null || fileStamp() !== seenStamp || (loadedReadOnly && rt.readOnly() === undefined && rt.hasLoaded?.() !== false)) {
        readSecretsSync({ declare: declaredKeys === undefined })
        loaded = Promise.resolve()
      }
    }
    let botId = botForSession()
    if (botId === undefined && rt.readOnly() !== undefined) {
      rt.syncReadOnly?.()
      botId = botForSession()
    }
    if (rt.botOf(botId) === undefined) return {}
    const mode = shellMode()
    const values = {}
    let used = false
    for (const secret of secrets.values()) {
      if (!canUse(secret, botId)) continue
      const secretVal = resolvedValueOf(secret)
      if (typeof secretVal !== 'string') continue
      const key = mode === 'file' ? envFileName(secret.name) : envName(secret.name)
      if (declaredKeys !== undefined && !declaredKeys.has(key)) continue
      if (mode === 'file') {
        try {
          values[key] = secretRefs.ensureShellFileSync(botId, secret.name, secretVal)
        } catch (error) {
          rt.warn('ds-bot: could not write secret file for %s: %s', secret.name, reason(error))
          continue
        }
      } else {
        values[key] = secretVal
      }
      if (command.includes(key)) {
        secret.lastUsedAt = Date.now()
        used = true
      }
    }
    if (used) noteUsed()
    return values
  }

  // Keys must be declared up front, so the contribution is registered again whenever
  // the set of names (or a purpose, which describes the key) changes.
  function attachShellEnv(sub) {
    let unregister = null
    let declared = ''
    refreshEnv = () => {
      const mode = shellMode()
      const list = [...secrets.values()].sort((a, b) => a.name.localeCompare(b.name))
      const key = `${mode}\n${list.map(secret => `${secret.name}\u0000${secret.purpose}`).join('\n')}`
      if (key === declared) return
      unregister?.()
      unregister = null
      declared = key
      if (list.length === 0) return
      const variables = Object.fromEntries(list.map(secret => [
        mode === 'file' ? envFileName(secret.name) : envName(secret.name),
        {
          description: mode === 'file'
            ? `Path to 0600 file holding DS Bot secret ${secret.name}${secret.purpose ? `: ${secret.purpose}` : ''}`
            : `DS Bot secret ${secret.name}${secret.purpose ? `: ${secret.purpose}` : ''}`,
        },
      ]))
      const declaredKeys = new Set(Object.keys(variables))
      try {
        unregister = sub.shellEnv.register({
          name: 'ds-bot-secrets',
          variables,
          resolve: execution => resolveEnv(() => resolveBotId(execution), declaredKeys,
            typeof execution.arguments?.command === 'string' ? execution.arguments.command : ''),
        })
      } catch (error) {
        declared = ''
        rt.warn('ds-bot: secrets not offered to the shell: %s', error?.message ?? error)
      }
    }
    refreshEnv()
    sub.effect(() => () => {
      unregister?.()
      unregister = null
      declared = ''
      refreshEnv = () => {}
    }, 'ds-bot: secrets shell env')
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['shellEnv'], sub => attachShellEnv(sub))
  } else if (ctx.get?.('shellEnv') !== undefined) {
    attachShellEnv({ shellEnv: ctx.get('shellEnv'), effect: (execute, label) => ctx.effect(execute, label) })
  }

  rt.onStoreSync = () => {
    if (shouldReload()) void loadSecrets()
  }

  ctx.effect(() => {
    void loadSecrets().then(async () => {
      await ensureRestoredSecretFiles()
      if (rt.readOnly() === undefined) secretRefs.startSweeper()
    })
    return () => {
      if (usedTimer !== null) clearTimeout(usedTimer)
      retiredExternalRedactions.clear()
      ephemeralRedactions.clear()
      secretRefs.dispose()
    }
  }, 'ds-bot: load secrets')

  const secretsApi = {
    issueRef: opts => secretRefs.issueRef(opts),
    consumeRef: (ref, opts) => secretRefs.consumeRef(ref, opts),
    consumeRefs: (refs, opts) => secretRefs.consumeRefs(refs, opts),
    rekeyRefs: opts => secretRefs.rekeyRefs(opts),
    writeSecretFile: opts => secretRefs.writeSecretFile(opts),
    savePastedFile: opts => secretRefs.savePastedFile(opts),
    activeShellFilePaths: () => secretRefs.activeShellFilePaths(),
    restoreSecretFiles: opts => secretRefs.restoreSecretFiles(opts),
    sweepExpiredRefs: opts => secretRefs.sweepExpiredRefs(opts),
    sweepExpiredFiles: opts => secretRefs.sweepExpiredFiles(opts),
    resolveExternalForBot,
    invalidateExternal,
    listProviders: () => providerRegistry.list(),
    isExternalReference: value => providerRegistry.findForReference(value) !== undefined,
    shellMode,
    onPrefsChanged,
  }

  Object.assign(rt, {
    secrets: secretsApi,
    secretsView,
    secretStoreStatus,
    secretValue: name => resolvedValueOf(secrets.get(name)),
    canUseSecret: (name, botId) => canUse(secrets.get(name), botId),
    prepareSecretEnvForSession,
    secretEnvForSession: sessionId => resolveEnv(() => botForSecretSession(sessionId)),
    secretEndpoint,
    forgetBotSecrets,
    loadSecrets,
    resolveExternalForBot,
    onSecretPrefsChanged: onPrefsChanged,
    redactSecrets: text => redact(text),
  })
}
