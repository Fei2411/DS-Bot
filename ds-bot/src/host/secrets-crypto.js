// Optional encryption at rest for secrets.json. The file keeps its name and its 600
// mode; the body becomes a versioned envelope instead of the plain {version:1,secrets}
// object. The key is derived from a passphrase the user supplies, so a copied data
// folder or a backup never holds the values in readable form. Node's own crypto does
// the work: scrypt for the key, AES-256-GCM for the payload. No dependency and no
// network service, which keeps Linux servers without a keyring usable.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const SECRETS_ENCRYPTED_VERSION = 2
export const MIN_PASSPHRASE = 8
export const MAX_PASSPHRASE = 1024
export const PASSPHRASE_ENV = 'DS_BOT_SECRETS_PASSPHRASE'
export const PASSPHRASE_FILE_ENV = 'DS_BOT_SECRETS_PASSPHRASE_FILE'

// scrypt at N=2^15 is ~32 MB and roughly 50-100 ms per derivation; the file's KDF
// settings are validated before use, so a tampered file cannot ask for a huge cost.
const KDF = { name: 'scrypt', N: 1 << 15, r: 8, p: 1 }
const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const AAD = Buffer.from('ds-bot secrets v2', 'utf8')

export class SecretsPassphraseError extends Error {
  constructor(message = 'The passphrase did not unlock the secrets file.') {
    super(message)
    this.code = 'secrets/passphrase'
  }
}

export class SecretsFormatError extends Error {
  constructor(message = 'The secrets file is not in a form this DS Bot can read.') {
    super(message)
    this.code = 'secrets/format'
  }
}

const b64 = value => Buffer.from(value).toString('base64')
const unb64 = (value, name) => {
  if (typeof value !== 'string' || value === '') throw new SecretsFormatError(`The secrets file has no ${name}.`)
  const buffer = Buffer.from(value, 'base64')
  if (buffer.length === 0) throw new SecretsFormatError(`The secrets file's ${name} is empty.`)
  return buffer
}

export const isEncryptedSecretsFile = value => value !== null && typeof value === 'object'
  && value.version === SECRETS_ENCRYPTED_VERSION && value.encrypted === true

const safeKdf = (kdf) => {
  if (kdf === null || typeof kdf !== 'object') throw new SecretsFormatError('The secrets file has no key settings.')
  if (kdf.name !== KDF.name || kdf.r !== KDF.r || kdf.p !== KDF.p || !Number.isInteger(kdf.N)) {
    throw new SecretsFormatError('The secrets file uses key settings this DS Bot does not know.')
  }
  // Refuse a cost the file could use to wedge startup: at most 2^17 and a power of two.
  if (kdf.N < 1 << 14 || kdf.N > 1 << 17 || (kdf.N & (kdf.N - 1)) !== 0) {
    throw new SecretsFormatError('The secrets file uses key settings this DS Bot does not accept.')
  }
  return kdf
}

export const cleanPassphrase = (value) => {
  if (typeof value !== 'string') throw new SecretsPassphraseError('Type the passphrase first.')
  if (value.length < MIN_PASSPHRASE) throw new SecretsPassphraseError(`A passphrase has at least ${MIN_PASSPHRASE} characters.`)
  if (value.length > MAX_PASSPHRASE) throw new SecretsPassphraseError(`A passphrase has at most ${MAX_PASSPHRASE} characters.`)
  return value
}

const derive = (passphrase, salt, kdf) => scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_BYTES, {
  N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024,
})

// The payload is the plain file body: { version: 1, secrets: [...] }. It travels only
// inside the ciphertext; the envelope itself has no secret name, value or purpose.
export function encryptSecrets(payload, passphrase) {
  cleanPassphrase(passphrase)
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = derive(passphrase, salt, KDF)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    version: SECRETS_ENCRYPTED_VERSION,
    encrypted: true,
    kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p },
    salt: b64(salt),
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    ciphertext: b64(ciphertext),
  }
}

export function decryptSecrets(envelope, passphrase) {
  if (!isEncryptedSecretsFile(envelope)) throw new SecretsFormatError()
  if (typeof passphrase !== 'string' || passphrase === '') throw new SecretsPassphraseError('Type the passphrase first.')
  const kdf = safeKdf(envelope.kdf)
  const salt = unb64(envelope.salt, 'salt')
  const iv = unb64(envelope.iv, 'IV')
  const tag = unb64(envelope.tag, 'authentication tag')
  const ciphertext = unb64(envelope.ciphertext, 'ciphertext')
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length < 16) throw new SecretsFormatError()
  const key = derive(passphrase, salt, kdf)
  let plaintext
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // A wrong passphrase and a damaged file look the same to GCM; say both, never say
    // which byte failed.
    throw new SecretsPassphraseError('The passphrase did not unlock the secrets file, or the file is damaged.')
  }
  let payload
  try {
    payload = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new SecretsFormatError('The secrets file decrypted to something that is not JSON.')
  }
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.secrets)) {
    throw new SecretsFormatError('The secrets file decrypted to a form this DS Bot does not know.')
  }
  return payload
}

// Unattended starts read the passphrase from the environment, or from a file so it can
// live in a service manager's secret file instead of the process environment. The value
// returned here is never logged or written anywhere.
export function passphraseFromEnv(env = process.env) {
  const direct = env[PASSPHRASE_ENV]
  if (typeof direct === 'string' && direct.trim() !== '') return { passphrase: direct, source: 'env' }
  const path = env[PASSPHRASE_FILE_ENV]
  if (typeof path === 'string' && path.trim() !== '') {
    try {
      // A trailing newline from an editor is not part of the passphrase; other
      // whitespace is significant.
      const passphrase = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
      if (passphrase === '') return { error: `${PASSPHRASE_FILE_ENV} names a file with no passphrase.` }
      return { passphrase, source: 'file' }
    } catch (error) {
      return { error: `${PASSPHRASE_FILE_ENV} could not be read (${error?.code ?? 'error'}).` }
    }
  }
  return undefined
}
