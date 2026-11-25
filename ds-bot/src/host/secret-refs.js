// One-time secret handles (`secret-ref:<32hex>`) and private temporary secret files
// (`0o700` directory, `0o600` files, 24h expiry). Handles stay isolated from long-term
// `secrets.json` and are deleted before their value is returned so a single handle can
// never be consumed twice.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from './files.js'
import { decryptSecretRecord, encryptSecretRecord, isEncryptedSecretsFile } from './secrets-crypto.js'

export const SECRET_REF_PREFIX = 'secret-ref:'
export const SECRET_REF_PATTERN = /^secret-ref:([0-9a-f]{32})$/
export const SECRET_REF_GLOBAL = /secret-ref:([0-9a-f]{32})/g
export const DEFAULT_TTL_MS = 86_400_000
export const SWEEP_INTERVAL_MS = 3_600_000
const PARTIAL_MAX_AGE_MS = 5 * 60_000
const SALT_BYTES = 32
const MAX_RESTORE_BYTES = 64 * 1024
const SF_FILE_RE = /^sf-(?:([a-z0-9_]{1,32})-)?([0-9a-f]{32})\.secret$/

export function isSecretRef(value) {
  return typeof value === 'string' && SECRET_REF_PATTERN.test(value)
}

export function matchSecretRefs(text) {
  return [...String(text ?? '').matchAll(/secret-ref:([0-9a-f]{32})/g)]
}

export function shellFileKey(botId, name) {
  return `${botId}\0${name}`
}

export function hashShellValue(value) {
  return createHash('sha256').update(value).digest('hex')
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code })
}

async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try { await chmod(dir, 0o700) } catch {}
}

function ensurePrivateDirSync(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch {}
}

export function createSecretRefs({
  home,
  getEncryption = () => ({ mode: 'plaintext', locked: false, passphrase: null }),
  warn = () => {},
  onPlaintext = () => {},
  onSweep = () => {},
  now = () => Date.now(),
  fsOps = {},
} = {}) {
  const refsDir = join(home, 'secret-refs')
  const filesDir = join(home, 'secret-files')
  const saltPath = join(refsDir, '.salt')
  const unlinkFile = fsOps.unlink ?? unlink

  let queue = Promise.resolve()
  const serialize = (run) => {
    const job = queue.then(run)
    queue = job.catch(() => {})
    return job
  }

  let cachedSalt = null
  async function loadOrCreateSalt() {
    if (cachedSalt !== null) return cachedSalt
    await ensurePrivateDir(refsDir)
    let corruptedBytes = null
    try {
      const existing = await readFile(saltPath)
      if (existing.length === SALT_BYTES) {
        try { await chmod(saltPath, 0o600) } catch {}
        cachedSalt = existing
        return existing
      }
      corruptedBytes = existing.length
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const fresh = randomBytes(SALT_BYTES)
    if (corruptedBytes !== null) {
      warn('ds-bot: secret-refs salt is invalid (%d bytes); replacing atomically', corruptedBytes)
      await atomicWritePrivate(saltPath, fresh)
      cachedSalt = fresh
      return fresh
    }
    try {
      await writeFile(saltPath, fresh, { flag: 'wx', mode: 0o600 })
      try { await chmod(saltPath, 0o600) } catch {}
      cachedSalt = fresh
      return fresh
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const existing = await readFile(saltPath)
        if (existing.length === SALT_BYTES) {
          try { await chmod(saltPath, 0o600) } catch {}
          cachedSalt = existing
          return existing
        }
        warn('ds-bot: secret-refs salt is invalid (%d bytes); replacing atomically', existing.length)
        await atomicWritePrivate(saltPath, fresh)
        cachedSalt = fresh
        return fresh
      }
      throw error
    }
  }

  async function atomicWritePrivate(filePath, contents) {
    const partial = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.partial`
    try {
      const opts = typeof contents === 'string'
        ? { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        : { flag: 'wx', mode: 0o600 }
      await writeFile(partial, contents, opts)
      try { await chmod(partial, 0o600) } catch {}
      await replaceFile(partial, filePath)
      try { await chmod(filePath, 0o600) } catch {}
    } catch (error) {
      await unlink(partial).catch(() => {})
      throw error
    }
  }

  function atomicWritePrivateSync(filePath, contents) {
    const partial = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.partial`
    try {
      writeFileSync(partial, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      try { chmodSync(partial, 0o600) } catch {}
      renameSync(partial, filePath)
      try { chmodSync(filePath, 0o600) } catch {}
    } catch (error) {
      try { unlinkSync(partial) } catch {}
      throw error
    }
  }

  function issueRef({ botId, sessionId = '', requestId, field = 'value', value, ttlMs = DEFAULT_TTL_MS }) {
    return serialize(async () => {
      if (typeof botId !== 'string' || botId === '') throw codedError('SECRET_REF_INVALID', 'A secret reference requires a Bot id.')
      if (typeof requestId !== 'string' || requestId === '') throw codedError('SECRET_REF_INVALID', 'A secret reference requires a request id.')
      if (typeof value !== 'string' || value.length === 0) throw codedError('SECRET_REF_INVALID', 'A secret value cannot be empty.')
      const enc = getEncryption()
      if (enc?.mode === 'encrypted' && (enc.locked || !enc.passphrase)) {
        throw codedError('SECRET_STORE_LOCKED', 'The secrets store is locked. Unlock it before issuing a secret reference.')
      }
      const salt = await loadOrCreateSalt()
      const material = `${botId}\0${String(sessionId)}\0${requestId}\0${String(field)}`
      const hex = createHmac('sha256', salt).update(material).digest('hex').slice(0, 32)
      const ref = `${SECRET_REF_PREFIX}${hex}`
      const record = {
        botId,
        sessionId: String(sessionId),
        value,
        savedAt: now(),
        ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS,
      }
      const serialized = enc?.mode === 'encrypted'
        ? JSON.stringify(encryptSecretRecord(record, enc.passphrase), null, 2)
        : JSON.stringify(record, null, 2)
      await atomicWritePrivate(join(refsDir, `${hex}.json`), serialized)
      onPlaintext(value, `REF_${hex.slice(0, 8).toUpperCase()}`, {
        id: `ref:${hex}`,
        expiresAt: record.savedAt + record.ttlMs,
      })
      return ref
    })
  }

  function consumeRef(ref, { botId } = {}) {
    return serialize(async () => {
      const match = typeof ref === 'string' ? SECRET_REF_PATTERN.exec(ref) : null
      if (match === null) throw codedError('SECRET_REF_INVALID', 'Invalid secret reference format.')
      if (typeof botId !== 'string' || botId === '') throw codedError('SECRET_REF_FORBIDDEN', 'A Bot id is required to consume a secret reference.')
      const hex = match[1]
      const filePath = join(refsDir, `${hex}.json`)
      let raw
      try {
        raw = await readFile(filePath, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') throw codedError('SECRET_REF_NOT_FOUND', 'This secret reference was not found or has already been used.')
        throw error
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw codedError('SECRET_REF_INVALID', 'This secret reference file is damaged.')
      }
      let entry = parsed
      if (isEncryptedSecretsFile(parsed)) {
        const enc = getEncryption()
        if (enc?.locked || !enc?.passphrase) {
          throw codedError('SECRET_STORE_LOCKED', 'The secrets store is locked. Unlock it to use this secret reference.')
        }
        entry = decryptSecretRecord(parsed, enc.passphrase)
      }
      if (entry?.botId !== botId) {
        throw codedError('SECRET_REF_FORBIDDEN', 'This secret reference belongs to another Bot.')
      }
      const ttl = Number.isFinite(entry.ttlMs) && entry.ttlMs > 0 ? entry.ttlMs : DEFAULT_TTL_MS
      if (!Number.isFinite(entry.savedAt) || now() - entry.savedAt > ttl) {
        await unlinkFile(filePath).catch(() => {})
        throw codedError('SECRET_REF_EXPIRED', 'This secret reference has expired.')
      }
      if (typeof entry.value !== 'string') {
        throw codedError('SECRET_REF_INVALID', 'This secret reference has no value.')
      }
      // Delete BEFORE returning plaintext so a handle can never be consumed twice.
      try {
        await unlinkFile(filePath)
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw codedError('SECRET_REF_NOT_FOUND', 'This secret reference has already been used.')
        }
        throw codedError('SECRET_REF_CONSUME_FAILED', `Could not remove secret reference after reading (${error?.code ?? 'error'}).`)
      }
      onPlaintext(entry.value, `REF_${hex.slice(0, 8).toUpperCase()}`, {
        id: `ref:${hex}`,
        expiresAt: entry.savedAt + ttl,
      })
      return entry.value
    })
  }

  // Re-encrypts or decrypts all existing in-flight secret-ref files when secrets.json
  // transitions between plaintext and encrypted modes (or rotates its passphrase).
  function rekeyRefs({ fromPassphrase = null, toPassphrase = null } = {}) {
    return serialize(async () => {
      let names
      try {
        names = await readdir(refsDir)
      } catch (error) {
        if (error?.code === 'ENOENT') return { updated: 0 }
        throw error
      }
      let updated = 0
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const full = join(refsDir, name)
        let info
        try {
          info = await lstat(full)
        } catch (error) {
          if (error?.code === 'ENOENT') continue
          throw error
        }
        if (info.isSymbolicLink() || !info.isFile()) continue
        let raw
        try {
          raw = await readFile(full, 'utf8')
        } catch (error) {
          if (error?.code === 'ENOENT') continue
          throw error
        }
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          continue
        }
        const encrypted = isEncryptedSecretsFile(parsed)
        if (typeof toPassphrase === 'string' && toPassphrase.length > 0) {
          let record
          if (encrypted) {
            if (typeof fromPassphrase !== 'string' || fromPassphrase.length === 0) continue
            record = decryptSecretRecord(parsed, fromPassphrase)
          } else {
            record = parsed
          }
          const envelope = encryptSecretRecord(record, toPassphrase)
          await atomicWritePrivate(full, JSON.stringify(envelope, null, 2))
          updated += 1
        } else if (encrypted) {
          if (typeof fromPassphrase !== 'string' || fromPassphrase.length === 0) {
            throw codedError('SECRET_STORE_LOCKED', 'Passphrase is required to decrypt secret references.')
          }
          const record = decryptSecretRecord(parsed, fromPassphrase)
          await atomicWritePrivate(full, JSON.stringify(record, null, 2))
          updated += 1
        }
      }
      return { updated }
    })
  }

  function writeSecretFile({ botId = '', sessionId = '', name = '', value, ttlMs = DEFAULT_TTL_MS } = {}) {
    return serialize(async () => {
      if (typeof value !== 'string' || value.length === 0) throw codedError('SECRET_FILE_INVALID', 'A secret value cannot be empty.')
      await ensurePrivateDir(filesDir)
      const token = randomBytes(16).toString('hex')
      const safeLabel = String(name ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32)
      const fileName = safeLabel ? `sf-${safeLabel.toLowerCase()}-${token}.secret` : `sf-${token}.secret`
      const filePath = join(filesDir, fileName)
      await atomicWritePrivate(filePath, value)
      const expiresAt = now() + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS)
      onPlaintext(value, safeLabel || `FILE_${token.slice(0, 8).toUpperCase()}`, {
        id: `file:${token}`,
        expiresAt,
      })
      return { filePath, expiresAt, botId: String(botId), sessionId: String(sessionId) }
    })
  }

  function savePastedFile(options) {
    return writeSecretFile(options)
  }

  // Managed temp files for optional Shell File Mode (`$DSH_SECRET_FILE_<NAME>`).
  // Kept in sync synchronously so DSH's synchronous `shellEnv.resolve` contract works
  // without awaiting on every command. Each value rotation writes to a fresh content-hashed
  // path so Windows never fails with EBUSY/EPERM if a running child holds the previous handle.
  /** @type {Map<string, { filePath: string, hash: string }>} */
  const shellFiles = new Map()
  let shellFileGen = 0
  function ensureShellFileSync(botId, name, value) {
    ensurePrivateDirSync(filesDir)
    const cacheKey = shellFileKey(botId, name)
    const hash = hashShellValue(value)
    const cached = shellFiles.get(cacheKey)
    if (cached !== undefined && cached.hash === hash && existsSync(cached.filePath)) {
      return cached.filePath
    }
    const keyHash = createHash('sha256').update(`${process.pid}\0${botId}\0${name}`).digest('hex').slice(0, 16)
    const valHash = hash.slice(0, 12)
    shellFileGen += 1
    const filePath = join(filesDir, `env-${keyHash}-${valHash}-${shellFileGen.toString(36)}.secret`)
    atomicWritePrivateSync(filePath, value)
    const previousPath = cached?.filePath
    shellFiles.set(cacheKey, { filePath, hash })
    if (previousPath !== undefined && previousPath !== filePath) {
      try { unlinkSync(previousPath) } catch {}
    }
    return filePath
  }

  function cleanupShellFiles(options = null) {
    const keepKeys = options instanceof Set ? options : (options?.keepKeys ?? null)
    const keepHashes = options instanceof Set ? null : (options?.keepHashes ?? null)
    for (const [cacheKey, entry] of shellFiles.entries()) {
      const keepKey = keepKeys !== null && keepKeys.has(cacheKey)
      const keepHash = keepHashes === null || keepHashes.get(cacheKey) === entry.hash
      if (keepKey && keepHash) continue
      shellFiles.delete(cacheKey)
      try { unlinkSync(entry.filePath) } catch {}
    }
  }

  function activeShellFilePaths() {
    return new Set([...shellFiles.values()].map(entry => entry.filePath))
  }

  function restoreSecretFiles({ maxAgeMs = DEFAULT_TTL_MS, cleanExpired = true } = {}) {
    return serialize(async () => {
      let names
      try {
        names = await readdir(filesDir)
      } catch (error) {
        if (error?.code === 'ENOENT') return 0
        throw error
      }
      const current = now()
      let restored = 0
      const removedIds = []
      for (const name of names) {
        const match = SF_FILE_RE.exec(name)
        if (match === null) continue
        const [, rawLabel, token] = match
        const full = join(filesDir, name)
        let info
        try {
          info = await lstat(full)
        } catch {
          continue
        }
        if (info.isSymbolicLink() || !info.isFile()) continue
        if (current - info.mtimeMs >= maxAgeMs) {
          if (cleanExpired) {
            await unlink(full).catch(() => {})
            removedIds.push(`file:${token}`)
          }
          continue
        }
        if (info.size === 0 || info.size > MAX_RESTORE_BYTES) continue
        let value
        try {
          value = await readFile(full, 'utf8')
        } catch {
          continue
        }
        if (value.length === 0) continue
        const label = rawLabel ? rawLabel.toUpperCase() : `FILE_${token.slice(0, 8).toUpperCase()}`
        onPlaintext(value, label, {
          id: `file:${token}`,
          expiresAt: info.mtimeMs + maxAgeMs,
        })
        restored += 1
      }
      if (removedIds.length > 0) onSweep(current, removedIds)
      return restored
    })
  }

  function sweepExpiredRefs({ maxAgeMs = DEFAULT_TTL_MS } = {}) {
    return serialize(async () => {
      let names
      try {
        names = await readdir(refsDir)
      } catch (error) {
        if (error?.code === 'ENOENT') return 0
        throw error
      }
      const current = now()
      let removed = 0
      const removedIds = []
      for (const name of names) {
        if (name === '.salt') continue
        const full = join(refsDir, name)
        let info
        try {
          info = await lstat(full)
        } catch {
          continue
        }
        if (info.isSymbolicLink() || !info.isFile()) continue
        if (name.endsWith('.partial')) {
          if (current - info.mtimeMs >= PARTIAL_MAX_AGE_MS) {
            await unlink(full).catch(() => {})
            removed += 1
          }
          continue
        }
        if (!name.endsWith('.json')) continue
        let expired = false
        try {
          const raw = await readFile(full, 'utf8')
          const parsed = JSON.parse(raw)
          if (isEncryptedSecretsFile(parsed)) {
            if (current - info.mtimeMs > maxAgeMs) expired = true
          } else {
            const ttl = Number.isFinite(parsed?.ttlMs) && parsed.ttlMs > 0 ? parsed.ttlMs : maxAgeMs
            if (!Number.isFinite(parsed?.savedAt) || current - parsed.savedAt > ttl) expired = true
          }
        } catch {
          if (current - info.mtimeMs > maxAgeMs) expired = true
        }
        if (expired) {
          await unlink(full).catch(() => {})
          removed += 1
          removedIds.push(`ref:${name.slice(0, -'.json'.length)}`)
        }
      }
      onSweep(current, removedIds)
      return removed
    })
  }

  function sweepExpiredFiles({ maxAgeMs = DEFAULT_TTL_MS } = {}) {
    return serialize(async () => {
      let names
      try {
        names = await readdir(filesDir)
      } catch (error) {
        if (error?.code === 'ENOENT') return 0
        throw error
      }
      const current = now()
      const activeShellPaths = activeShellFilePaths()
      let removed = 0
      const removedIds = []
      for (const name of names) {
        const full = join(filesDir, name)
        if (activeShellPaths.has(full)) continue
        try {
          const info = await lstat(full)
          if (info.isSymbolicLink() || !info.isFile()) continue
          const limit = (name.endsWith('.partial') || name.endsWith('.tpl')) ? PARTIAL_MAX_AGE_MS : maxAgeMs
          if (current - info.mtimeMs >= limit) {
            await unlink(full).catch(() => {})
            removed += 1
            const sfMatch = SF_FILE_RE.exec(name)
            if (sfMatch !== null) removedIds.push(`file:${sfMatch[2]}`)
          }
        } catch {}
      }
      onSweep(current, removedIds)
      return removed
    })
  }

  let sweepTimer = null
  function startSweeper(intervalMs = SWEEP_INTERVAL_MS) {
    if (sweepTimer !== null) return
    const runSweep = () => {
      void sweepExpiredRefs().catch(error => warn('ds-bot: secret-refs sweep failed: %s', error?.code ?? error?.message ?? 'error'))
      void sweepExpiredFiles().catch(error => warn('ds-bot: secret-files sweep failed: %s', error?.code ?? error?.message ?? 'error'))
    }
    runSweep()
    sweepTimer = setInterval(runSweep, intervalMs)
    sweepTimer.unref?.()
  }

  function dispose() {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
    cleanupShellFiles()
  }

  return {
    refsDir,
    filesDir,
    issueRef,
    consumeRef,
    rekeyRefs,
    writeSecretFile,
    savePastedFile,
    ensureShellFileSync,
    cleanupShellFiles,
    activeShellFilePaths,
    restoreSecretFiles,
    sweepExpiredRefs,
    sweepExpiredFiles,
    startSweeper,
    dispose,
  }
}
