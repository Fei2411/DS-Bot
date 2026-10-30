// Minimal ZIP reader/writer for OOXML packages (node:zlib only). Reads stored and
// deflate members through the central directory (so data descriptors are handled);
// zip64 is rejected with a clear error. Writes keep unchanged members' compressed
// bytes as they were; [Content_Types].xml always goes first.
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50, CDIR = 0x02014b50, LOCAL = 0x04034b50

function fail(message) { const error = new Error(message); error.code = 'zip'; throw error }

/**
 * Read all members of a ZIP file.
 * @param {Buffer} buf
 * @returns {{ name: string, data: Buffer, raw: Buffer, method: number }[]} members in archive order;
 *   `raw` is the compressed member data as stored.
 */
export function readZip(buf) {
  // The end-of-central-directory record lives in the last 64K.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break }
  }
  if (eocd < 0) fail('not a ZIP file: no end of central directory')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  let cdOff = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) fail('zip64 archives are not supported')
  const members = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cdOff) !== CDIR) fail('corrupt central directory')
    const flags = buf.readUInt16LE(cdOff + 8)
    const method = buf.readUInt16LE(cdOff + 10)
    const crc = buf.readUInt32LE(cdOff + 16)
    const csize = buf.readUInt32LE(cdOff + 20)
    const usize = buf.readUInt32LE(cdOff + 24)
    const nameLen = buf.readUInt16LE(cdOff + 28)
    const extraLen = buf.readUInt16LE(cdOff + 30)
    const commentLen = buf.readUInt16LE(cdOff + 32)
    const localOff = buf.readUInt32LE(cdOff + 42)
    if (csize === 0xffffffff || usize === 0xffffffff) fail('zip64 archives are not supported')
    const name = buf.subarray(cdOff + 46, cdOff + 46 + nameLen).toString('utf8')
    // Zip slip: a member escaping the destination tree is refused on read so
    // every command fails on such a package, not just unpack.
    const norm = name.replace(/\\/g, '/')
    if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').includes('..')) fail(`zip: unsafe member name ${name}`)
    if (buf.readUInt32LE(localOff) !== LOCAL) fail(`corrupt local header for ${name}`)
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const raw = buf.subarray(localOff + 30 + lNameLen + lExtraLen, localOff + 30 + lNameLen + lExtraLen + csize)
    let data
    if (method === 0) data = raw.subarray(0, usize)
    else if (method === 8) {
      // Enforce the declared uncompressed size — a zip bomb dies here.
      // inflateRawSync rejects a zero maxOutputLength, so floor it at 1; a
      // member lying about an empty body then fails on the size check.
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) })
      } catch (err) {
        if (err instanceof RangeError || err?.code === 'ERR_OUT_OF_RANGE') fail(`${name} inflates past its declared size`)
        fail(`corrupt data for ${name}`)
      }
    }
    else fail(`unsupported compression method ${method} for ${name}`)
    if (data.length !== usize) fail(`size mismatch for ${name}`)
    members.push({ name, data, raw, method, crc, flags: flags & 0x0800, extra: buf.subarray(cdOff + 46 + nameLen, cdOff + 46 + nameLen + extraLen) })
    cdOff += 46 + nameLen + extraLen + commentLen
  }
  return members
}

/**
 * Build a ZIP buffer. `[Content_Types].xml` goes first regardless of input order.
 * Unchanged members keep their original compressed bytes when `raw` is present and
 * `data` is not provided; anything else is deflate-compressed.
 * @param {{ name: string, data?: Buffer, raw?: Buffer, method?: number, crc?: number, usize?: number }[]} members
 * @returns {Buffer}
 */
export function writeZip(members) {
  const ordered = [...members].sort((a, b) =>
    (a.name === '[Content_Types].xml' ? -1 : 0) - (b.name === '[Content_Types].xml' ? -1 : 0))
  const local = [], central = []
  let offset = 0
  for (const member of ordered) {
    const nameBuf = Buffer.from(member.name, 'utf8')
    let raw, crc, usize, method
    if (member.raw !== undefined && member.data === undefined) {
      raw = member.raw; crc = member.crc; usize = member.usize; method = member.method
      if (method === 0 && usize === undefined) usize = raw.length
    } else {
      const plain = member.data ?? inflateRawSync(member.raw)
      method = member.method === 0 ? 0 : 8
      raw = method === 0 ? plain : deflateRawSync(plain, { level: 9 })
      crc = crc32(plain); usize = plain.length
    }
    const head = Buffer.alloc(30)
    head.writeUInt32LE(LOCAL, 0)
    head.writeUInt16LE(20, 4) // version needed
    head.writeUInt16LE(member.flags ?? 0x0800, 6)
    head.writeUInt16LE(method, 8)
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0, 12) // time, date
    head.writeUInt32LE(crc >>> 0, 14)
    head.writeUInt32LE(raw.length, 18)
    head.writeUInt32LE(usize, 22)
    head.writeUInt16LE(nameBuf.length, 26)
    head.writeUInt16LE(0, 28)
    local.push(head, nameBuf, raw)
    const cent = Buffer.alloc(46)
    cent.writeUInt32LE(CDIR, 0)
    cent.writeUInt16LE(20, 4); cent.writeUInt16LE(20, 6)
    cent.writeUInt16LE(member.flags ?? 0x0800, 8)
    cent.writeUInt16LE(method, 10)
    cent.writeUInt16LE(0, 12); cent.writeUInt16LE(0, 14)
    cent.writeUInt32LE(crc >>> 0, 16)
    cent.writeUInt32LE(raw.length, 20)
    cent.writeUInt32LE(usize, 24)
    cent.writeUInt16LE(nameBuf.length, 28)
    cent.writeUInt32LE(0, 38) // external attrs
    cent.writeUInt32LE(offset, 42)
    central.push(cent, nameBuf)
    offset += 30 + nameBuf.length + raw.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD, 0)
  end.writeUInt16LE(ordered.length, 8)
  end.writeUInt16LE(ordered.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, end])
}

const TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let crc = ~0
  for (const byte of buf) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return ~crc >>> 0
}
