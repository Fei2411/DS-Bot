// Pure-JS PNG decode (8-bit gray/RGB/RGBA/palette, all filters, non-interlaced)
// and encode (RGB), plus the contact-sheet composer with a small built-in
// 5x7 bitmap digit font for page labels.
import { deflateSync, inflateSync } from 'node:zlib'

function fail(message) { const error = new Error(message); error.code = 'png'; throw error }

/**
 * Decode a PNG to 8-bit RGBA.
 * @returns {{ width: number, height: number, data: Buffer }} RGBA pixels, row-major
 */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) fail('not a PNG file')
  let width, height, depth, color, interlace
  let palette, trns
  const idat = []
  for (let pos = 8; pos < buf.length;) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      depth = data[8]; color = data[9]; interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (depth !== 8) fail(`PNG bit depth ${depth} unsupported (8 only)`)
  if (interlace !== 0) fail('interlaced PNG unsupported')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]
  if (channels === undefined) fail(`PNG color type ${color} unsupported`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  for (let y = 0, pos = 0; y < height; y++) {
    const filter = raw[pos++]
    const row = raw.subarray(pos, pos + stride)
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride)
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = row[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff
      else if (filter !== 0) fail(`PNG filter ${filter} unsupported`)
      cur[x] = v
    }
    pos += stride
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const s = i * channels, d = i * 4
    if (color === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = 255 }
    else if (color === 2) { rgba.set(out.subarray(s, s + 3), d); rgba[d + 3] = 255 }
    else if (color === 3) {
      const idx = out[s]
      rgba[d] = palette[idx * 3]; rgba[d + 1] = palette[idx * 3 + 1]; rgba[d + 2] = palette[idx * 3 + 2]
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255
    } else if (color === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = out[s + 1] }
    else rgba.set(out.subarray(s, s + 4), d)
  }
  return { width, height, data: rgba }
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Encode RGB(A) pixels as PNG color type 2. @param data Buffer (rgb or rgba) */
export function encodePng({ width, height, data, channels = 4 }) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * channels
      raw.set(data.subarray(s, s + 3), y * (stride + 1) + 1 + x * 3)
    }
  }
  const chunk = (type, payload) => {
    const buf = Buffer.alloc(12 + payload.length)
    buf.writeUInt32BE(payload.length, 0); buf.write(type, 4, 'latin1')
    payload.copy(buf, 8)
    buf.writeUInt32BE(crc32(buf.subarray(4, 8 + payload.length)), 8 + payload.length)
    return buf
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

const TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t
})()
const crc32 = (buf) => { let c = ~0; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return ~c >>> 0 }

// Original 5x7 digit glyphs, one bit per pixel, rows top→bottom.
const DIGITS = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
}

/** Blit a label (digits) at x,y in an RGBA image, scale×, dark gray on white. */
export function drawLabel(img, x, y, text, scale = 1) {
  let cx = x
  for (const ch of text) {
    const glyph = DIGITS[ch]
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (!(glyph[row] & (0x10 >> col))) continue
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
            const px = cx + col * scale + dx, py = y + row * scale + dy
            if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue
            const o = (py * img.width + px) * 4
            img.data[o] = img.data[o + 1] = img.data[o + 2] = 40; img.data[o + 3] = 255
          }
        }
      }
    }
    cx += 6 * scale
  }
}

/**
 * Compose a contact sheet: images in order, each scaled to `width` px, `cols` per row,
 * a white label strip under each tile with the page number.
 * @param {{ width, height, data }[]} images - decoded RGBA frames in page order
 * @returns {{ width, height, data, channels: 4 }}
 */
export function contactSheet(images, { cols = 4, width = 320 } = {}) {
  const labelH = 10
  const tiles = images.map(img => {
    const h = Math.max(1, Math.round(img.height * width / img.width))
    return { img, h }
  })
  const rows = Math.ceil(tiles.length / cols)
  const rowH = []
  for (let r = 0; r < rows; r++) rowH.push(Math.max(...tiles.slice(r * cols, (r + 1) * cols).map(t => t.h), 1))
  const sheetW = cols * width
  const sheetH = rowH.reduce((a, b) => a + b + labelH, 0)
  const data = Buffer.alloc(sheetW * sheetH * 4, 255)
  const sheet = { width: sheetW, height: sheetH, data, channels: 4 }
  let ty = 0
  tiles.forEach((tile, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    const y0 = ty; if (col === 0) ty = y0 // row baseline computed via rowH
    // scale blit
    const dstX = col * width, dstY = rowBaseline(rowH, row)
    for (let y = 0; y < tile.h; y++) {
      const sy = Math.floor(y * tile.img.height / tile.h)
      for (let x = 0; x < width; x++) {
        const sx = Math.floor(x * tile.img.width / width)
        const s = (sy * tile.img.width + sx) * 4, d = ((dstY + y) * sheetW + dstX + x) * 4
        data.set(tile.img.data.subarray(s, s + 4), d)
      }
    }
    drawLabel(sheet, dstX + 2, dstY + tile.h + 1, String(i + 1), 1)
    ty = dstY
  })
  return sheet
}
const rowBaseline = (rowH, row) => rowH.slice(0, row).reduce((a, b) => a + b + 10, 0)
