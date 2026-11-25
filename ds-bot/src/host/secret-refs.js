// One-time secret handles (`secret-ref:<32hex>`) and private temporary secret files
// (`0o700` directory, `0o600` files, 24h expiry). Handles stay isolated from long-term
// `secrets.json` and are deleted before their value is returned so a single handle can
// never be consumed twice.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
const CONSUMING_REF_RE = /\.json\.consuming-[A-Za-z0-9-]+$/

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
  const renameFile = fsOps.rename ?? rename

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

  const OP_TEMP_SUBDIR = '_op'

  function assertValidBotId(botId, code = 'SECRET_FILE_INVALID') {
    if (
      typeof botId !== 'string'
      || botId === ''
      || botId === '.'
      || botId === '..'
      || botId === OP_TEMP_SUBDIR
      || botId.includes('/')
      || botId.includes('\\')
      || botId.includes('\0')
    ) {
      throw codedError(code, 'A valid Bot id is required for a secret file.')
    }
  }

  function botFilesDir(botId) {
    assertValidBotId(botId)
    return join(filesDir, botId)
  }

  async function readAndValidateRef(ref, botId, { unlinkExpired = false } = {}) {
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
      if (unlinkExpired) await unlinkFile(filePath).catch(() => {})
      throw codedError('SECRET_REF_EXPIRED', 'This secret reference has expired.')
    }
    if (typeof entry.value !== 'string') {
      throw codedError('SECRET_REF_INVALID', 'This secret reference has no value.')
    }
    return { ref, hex, filePath, value: entry.value, savedAt: entry.savedAt, ttl }
  }

  function consumeRef(ref, { botId } = {}) {
    return serialize(async () => {
      const item = await readAndValidateRef(ref, botId, { unlinkExpired: true })
      // Delete BEFORE returning plaintext so a handle can never be consumed twice.
      try {
        await unlinkFile(item.filePath)
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw codedError('SECRET_REF_NOT_FOUND', 'This secret reference has already been used.')
        }
        throw codedError('SECRET_REF_CONSUME_FAILED', `Could not remove secret reference after reading (${error?.code ?? 'error'}).`)
      }
      onPlaintext(item.value, `REF_${item.hex.slice(0, 8).toUpperCase()}`, {
        id: `ref:${item.hex}`,
        expiresAt: item.savedAt + item.ttl,
      })
      return item.value
    })
  }

  // Atomically validates and consumes a batch of secret-ref handles inside the single
  // serialized queue using two-phase reversible staging. If any handle is invalid, missing,
  // expired, locked, belongs to another Bot, or cannot be staged (e.g. Windows EBUSY),
  // every previously staged handle is renamed back in place so zero valid handles are burned.
  function consumeRefs(refs, { botId } = {}) {
    return serialize(async () => {
      if (typeof botId !== 'string' || botId === '') {
        throw codedError('SECRET_REF_FORBIDDEN', 'A Bot id is required to consume a secret reference.')
      }
      const uniqueRefs = [...new Set(refs ?? [])]
      if (uniqueRefs.length === 0) return new Map()
      const validated = []
      for (const ref of uniqueRefs) {
        validated.push(await readAndValidateRef(ref, botId, { unlinkExpired: false }))
      }
      // Phase 1: Stage every validated handle with a reversible rename. Once all renames
      // succeed, the batch reaches its atomic commit point (no concurrent caller can read
      // the original paths again).
      const nonce = `${process.pid}-${randomBytes(6).toString('hex')}`
      const staged = []
      try {
        for (const item of validated) {
          const stagedPath = `${item.filePath}.consuming-${nonce}`
          await renameFile(item.filePath, stagedPath)
          staged.push({ item, stagedPath })
        }
      } catch (error) {
        for (let i = staged.length - 1; i >= 0; i -= 1) {
          const { item, stagedPath } = staged[i]
          try {
            await renameFile(stagedPath, item.filePath)
          } catch (rollbackError) {
            warn('ds-bot: could not restore staged secret reference during rollback (%s)', rollbackError?.code ?? 'error')
          }
        }
        if (error?.code === 'ENOENT') {
          throw codedError('SECRET_REF_NOT_FOUND', 'This secret reference has already been used.')
        }
        throw codedError('SECRET_REF_CONSUME_FAILED', `Could not consume secret reference (${error?.code ?? 'error'}).`)
      }
      // Phase 2: Best-effort delete of staged files; if unlink fails (e.g. transient
      // Windows handle), scrub the file contents immediately so plaintext does not linger
      // on disk until `sweepExpiredRefs` or `rekeyRefs` removes it.
      for (const { stagedPath } of staged) {
        await unlinkFile(stagedPath).catch(async (error) => {
          if (error?.code !== 'ENOENT') {
            await writeFile(stagedPath, '', { mode: 0o600 }).catch(() => {})
            warn('ds-bot: could not remove staged secret reference (%s)', error?.code ?? 'error')
          }
        })
      }
      const values = new Map()
      for (const item of validated) {
        onPlaintext(item.value, `REF_${item.hex.slice(0, 8).toUpperCase()}`, {
          id: `ref:${item.hex}`,
          expiresAt: item.savedAt + item.ttl,
        })
        values.set(item.ref, item.value)
      }
      return values
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
        const full = join(refsDir, name)
        // Leftover `.consuming-*` files are already-consumed handles whose unlink failed;
        // remove (or scrub) regular files during rekey so enabling encryption never leaves plaintext behind.
        if (CONSUMING_REF_RE.test(name)) {
          let info
          try { info = await lstat(full) } catch { continue }
          if (info.isSymbolicLink() || !info.isFile()) continue
          await unlinkFile(full).catch(async (error) => {
            if (error?.code !== 'ENOENT') {
              await writeFile(full, '', { mode: 0o600 }).catch(() => {})
            }
          })
          continue
        }
        if (!name.endsWith('.json')) continue
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
      if (value.includes('\0')) throw codedError('SECRET_FILE_INVALID', 'A secret value cannot contain null bytes.')
      const dir = botFilesDir(botId)
      await ensurePrivateDir(filesDir)
      await ensurePrivateDir(dir)
      const token = randomBytes(16).toString('hex')
      const safeLabel = String(name ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32)
      const fileName = safeLabel ? `sf-${safeLabel.toLowerCase()}-${token}.secret` : `sf-${token}.secret`
      const filePath = join(dir, fileName)
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
  // without awaiting on every command. Each Bot writes into its own `<filesDir>/<botId>/`
  // folder and rotates to a fresh content-hashed path so Windows never hits EBUSY/EPERM.
  /** @type {Map<string, { filePath: string, hash: string }>} */
  const shellFiles = new Map()
  let shellFileGen = 0
  function ensureShellFileSync(botId, name, value) {
    const dir = botFilesDir(botId)
    ensurePrivateDirSync(filesDir)
    ensurePrivateDirSync(dir)
    const cacheKey = shellFileKey(botId, name)
    const hash = hashShellValue(value)
    const cached = shellFiles.get(cacheKey)
    if (cached !== undefined && cached.hash === hash && existsSync(cached.filePath)) {
      return cached.filePath
    }
    const keyHash = createHash('sha256').update(`${process.pid}\0${botId}\0${name}`).digest('hex').slice(0, 16)
    const valHash = hash.slice(0, 12)
    shellFileGen += 1
    const filePath = join(dir, `env-${keyHash}-${valHash}-${shellFileGen.toString(36)}.secret`)
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
    const touchedDirs = new Set()
    for (const [cacheKey, entry] of shellFiles.entries()) {
      const keepKey = keepKeys !== null && keepKeys.has(cacheKey)
      const keepHash = keepHashes === null || keepHashes.get(cacheKey) === entry.hash
      if (keepKey && keepHash) continue
      shellFiles.delete(cacheKey)
      try { unlinkSync(entry.filePath) } catch {}
      const parent = dirname(entry.filePath)
      if (parent !== filesDir) touchedDirs.add(parent)
    }
    for (const dir of touchedDirs) {
      try { rmdirSync(dir) } catch {}
    }
  }

  function removeBotFiles(botId) {
    return serialize(async () => {
      let dir
      try {
        dir = botFilesDir(botId)
      } catch {
        return 0
      }
      let dirInfo
      try {
        dirInfo = await lstat(dir)
      } catch (error) {
        if (error?.code === 'ENOENT') return 0
        throw error
      }
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return 0
      let names
      try {
        names = await readdir(dir)
      } catch (error) {
        if (error?.code === 'ENOENT') return 0
        throw error
      }
      let removed = 0
      const removedIds = []
      for (const name of names) {
        const full = join(dir, name)
        try {
          const info = await lstat(full)
          if (info.isSymbolicLink() || !info.isFile()) continue
          await unlink(full).catch(() => {})
          removed += 1
          const sfMatch = SF_FILE_RE.exec(name)
          if (sfMatch !== null) removedIds.push(`file:${sfMatch[2]}`)
        } catch {}
      }
      await rmdir(dir).catch(() => {})
      if (removedIds.length > 0) onSweep(now(), removedIds)
      return removed
    })
  }

  function activeShellFilePaths() {
    return new Set([...shellFiles.values()].map(entry => entry.filePath))
  }

  // Lists regular files inside `filesDir` and its immediate non-symlink subdirectories
  // without ever dereferencing symlinks.
  async function listSecretFiles({ includeOpDir = true } = {}) {
    let entries
    try {
      entries = await readdir(filesDir)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const found = []
    for (const name of entries) {
      const full = join(filesDir, name)
      let info
      try {
        info = await lstat(full)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isFile()) {
        found.push({ name, full, info })
        continue
      }
      if (!info.isDirectory()) continue
      if (!includeOpDir && name === OP_TEMP_SUBDIR) continue
      let children
      try {
        children = await readdir(full)
      } catch {
        continue
      }
      for (const childName of children) {
        const childFull = join(full, childName)
        let childInfo
        try {
          childInfo = await lstat(childFull)
        } catch {
          continue
        }
        if (childInfo.isSymbolicLink() || !childInfo.isFile()) continue
        found.push({ name: childName, full: childFull, info: childInfo })
      }
    }
    return found
  }

  function restoreSecretFiles({ maxAgeMs = DEFAULT_TTL_MS, cleanExpired = true } = {}) {
    return serialize(async () => {
      const files = await listSecretFiles({ includeOpDir: false })
      if (files.length === 0) return 0
      const current = now()
      let restored = 0
      const removedIds = []
      for (const { name, full, info } of files) {
        const match = SF_FILE_RE.exec(name)
        if (match === null) continue
        const [, rawLabel, token] = match
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
        if (name.endsWith('.partial') || CONSUMING_REF_RE.test(name)) {
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
      const files = await listSecretFiles({ includeOpDir: true })
      if (files.length === 0) return 0
      const current = now()
      const activeShellPaths = activeShellFilePaths()
      let removed = 0
      const removedIds = []
      for (const { name, full, info } of files) {
        if (activeShellPaths.has(full)) continue
        const limit = (name.endsWith('.partial') || name.endsWith('.tpl')) ? PARTIAL_MAX_AGE_MS : maxAgeMs
        if (current - info.mtimeMs >= limit) {
          await unlink(full).catch(() => {})
          removed += 1
          const sfMatch = SF_FILE_RE.exec(name)
          if (sfMatch !== null) removedIds.push(`file:${sfMatch[2]}`)
        }
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
    consumeRefs,
    rekeyRefs,
    writeSecretFile,
    savePastedFile,
    ensureShellFileSync,
    cleanupShellFiles,
    removeBotFiles,
    activeShellFilePaths,
    restoreSecretFiles,
    sweepExpiredRefs,
    sweepExpiredFiles,
    startSweeper,
    dispose,
  }
}
