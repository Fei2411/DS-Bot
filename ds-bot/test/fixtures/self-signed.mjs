// A throwaway self-signed certificate for one DNS name, built with node:crypto alone so tests need
// no openssl binary and no key file in the tree. The certificate is its own trust anchor
// (NODE_EXTRA_CA_CERTS) and lives for two days.
import { generateKeyPairSync, sign } from 'node:crypto'

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts)
  const size = body.length < 128 ? Buffer.from([body.length])
    : body.length < 256 ? Buffer.from([0x81, body.length])
      : Buffer.from([0x82, body.length >> 8, body.length & 0xff])
  return Buffer.concat([Buffer.from([tag]), size, body])
}
const oid = bytes => der(0x06, Buffer.from(bytes))
const ECDSA_SHA256 = oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])
const COMMON_NAME = oid([0x55, 0x04, 0x03])
const SUBJECT_ALT_NAME = oid([0x55, 0x1d, 0x11])
const BASIC_CONSTRAINTS = oid([0x55, 0x1d, 0x13])
const utcTime = date => der(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`))
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`

export function selfSigned(hostname) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const name = der(0x30, der(0x31, der(0x30, COMMON_NAME, der(0x0c, Buffer.from(hostname)))))
  const now = Date.now()
  const extensions = der(0xa3, der(0x30,
    der(0x30, SUBJECT_ALT_NAME, der(0x04, der(0x30, der(0x82, Buffer.from(hostname))))),
    der(0x30, BASIC_CONSTRAINTS, der(0x01, Buffer.from([0xff])), der(0x04, der(0x30, der(0x01, Buffer.from([0xff]))))),
  ))
  const tbs = der(0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    der(0x30, ECDSA_SHA256),
    name,
    der(0x30, utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 2 * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  )
  const signature = sign('sha256', tbs, privateKey)
  const certificate = der(0x30, tbs, der(0x30, ECDSA_SHA256), der(0x03, Buffer.concat([Buffer.from([0]), signature])))
  return { cert: pem('CERTIFICATE', certificate), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}
