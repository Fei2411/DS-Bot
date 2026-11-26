// Pure-Node OOXML spreadsheet (.xlsx / .xlsm) reader for desktop workspace preview.
// Parses ZIP central directory + workbook/sharedStrings/styles/worksheets with strict
// memory and size bounds; throws on encrypted or malformed archives so callers can
// fall back cleanly.
import { inflateRawSync } from 'node:zlib'

const MAX_ZIP_ENTRIES = 512
const MAX_ENTRY_BYTES = 24 * 1024 * 1024
const MAX_TOTAL_BYTES = 48 * 1024 * 1024
export const MAX_PREVIEW_SHEETS = 40
export const MAX_PREVIEW_ROWS = 500
export const MAX_PREVIEW_COLS = 80

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])

function findEocd(buf) {
  const minOffset = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Invalid ZIP archive')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('ZIP end-of-central-directory not found')
  const entryCount = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error('Archive contains too many entries')
  if (cdOffset + cdSize > buf.length) throw new Error('Corrupt ZIP central directory')

  /** @type {Map<string, { method: number, compressedSize: number, uncompressedSize: number, localOffset: number }>} */
  const index = new Map()
  let cursor = cdOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory entry')
    }
    const flags = buf.readUInt16LE(cursor + 8)
    if ((flags & 0x1) !== 0) throw new Error('Encrypted workbook is not supported')
    const method = buf.readUInt16LE(cursor + 10)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const uncompressedSize = buf.readUInt32LE(cursor + 24)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLen
    if (nameEnd > buf.length) throw new Error('Corrupt ZIP entry name')
    const rawName = buf.subarray(nameStart, nameEnd).toString('utf8').replace(/^\/+/, '')
    if (uncompressedSize <= MAX_ENTRY_BYTES && !rawName.includes('..')) {
      index.set(rawName, { method, compressedSize, uncompressedSize, localOffset })
    }
    cursor = nameEnd + extraLen + commentLen
  }

  let totalRead = 0
  const readText = (targetPath) => {
    const normalized = targetPath.replace(/^\/+/, '')
    let entry = index.get(normalized)
    if (!entry) {
      const lower = normalized.toLowerCase()
      for (const [key, value] of index) {
        if (key.toLowerCase() === lower) { entry = value; break }
      }
    }
    if (!entry) return null
    const off = entry.localOffset
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) {
      throw new Error('Corrupt ZIP local header')
    }
    const localNameLen = buf.readUInt16LE(off + 26)
    const localExtraLen = buf.readUInt16LE(off + 28)
    const dataStart = off + 30 + localNameLen + localExtraLen
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > buf.length) throw new Error('Truncated ZIP entry')
    const slice = buf.subarray(dataStart, dataEnd)
    let out
    if (entry.method === 0) {
      out = slice
    } else if (entry.method === 8) {
      out = inflateRawSync(slice, { maxOutputLength: MAX_ENTRY_BYTES })
    } else {
      throw new Error(`Unsupported ZIP compression method ${entry.method}`)
    }
    totalRead += out.length
    if (totalRead > MAX_TOTAL_BYTES) throw new Error('Workbook exceeds preview memory limit')
    return out.toString('utf8')
  }

  return { index, readText }
}

function decodeXmlEntities(text) {
  if (!text || !text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, ent) => {
    if (ent === 'amp') return '&'
    if (ent === 'lt') return '<'
    if (ent === 'gt') return '>'
    if (ent === 'quot') return '"'
    if (ent === 'apos') return "'"
    if (ent.startsWith('#x') || ent.startsWith('#X')) {
      const code = Number.parseInt(ent.slice(2), 16)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    if (ent.startsWith('#')) {
      const code = Number.parseInt(ent.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return match
  })
}

function parseAttrs(raw) {
  const attrs = {}
  if (!raw) return attrs
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]
    const val = decodeXmlEntities(m[2] ?? m[3] ?? '')
    attrs[key] = val
    const colon = key.indexOf(':')
    if (colon >= 0) attrs[key.slice(colon + 1)] = val
  }
  return attrs
}

function extractTextRuns(xmlFragment) {
  if (!xmlFragment) return ''
  const parts = []
  const re = /<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g
  let m
  while ((m = re.exec(xmlFragment)) !== null) {
    parts.push(decodeXmlEntities(m[1]))
  }
  return parts.join('')
}

function parseSharedStrings(xml) {
  if (!xml) return []
  const out = []
  const re = /<(?:[A-Za-z_][\w.-]*:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    out.push(extractTextRuns(m[1]))
  }
  return out
}

function isDateFormatCode(code) {
  if (!code) return false
  // Strip quoted literals, escaped chars, and bracketed locale/color tokens.
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase()
  return /[ymdhs]/.test(stripped)
}

function parseStyles(xml) {
  const dateStyleIndexes = new Set()
  if (!xml) return dateStyleIndexes
  const customFmtDate = new Map()
  const numFmtRe = /<(?:[A-Za-z_][\w.-]*:)?numFmt\s+([^>]*?)\/>/g
  let m
  while ((m = numFmtRe.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1])
    const id = Number.parseInt(attrs.numFmtId ?? '', 10)
    if (Number.isInteger(id)) customFmtDate.set(id, isDateFormatCode(attrs.formatCode ?? ''))
  }
  const cellXfsMatch = /<(?:[A-Za-z_][\w.-]*:)?cellXfs(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?cellXfs>/.exec(xml)
  if (!cellXfsMatch) return dateStyleIndexes
  const xfRe = /<(?:[A-Za-z_][\w.-]*:)?xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?xf>)/g
  let index = 0
  while ((m = xfRe.exec(cellXfsMatch[1])) !== null) {
    const attrs = parseAttrs(m[1])
    const numFmtId = Number.parseInt(attrs.numFmtId ?? '', 10)
    if (Number.isInteger(numFmtId)) {
      if (BUILTIN_DATE_FMTS.has(numFmtId) || customFmtDate.get(numFmtId) === true) {
        dateStyleIndexes.add(index)
      }
    }
    index += 1
  }
  return dateStyleIndexes
}

function formatExcelDate(serial, date1904) {
  if (!Number.isFinite(serial)) return String(serial)
  // Excel 1900 epoch has the famous 1900-02-29 leap bug for serials >= 60.
  const baseMs = date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, 30)
  const adjusted = !date1904 && serial > 0 && serial < 60 ? serial + 1 : serial
  const ms = Math.round(baseMs + adjusted * 86_400_000)
  const dt = new Date(ms)
  if (Number.isNaN(dt.getTime())) return String(serial)
  const pad = n => String(n).padStart(2, '0')
  const y = dt.getUTCFullYear()
  const mo = pad(dt.getUTCMonth() + 1)
  const d = pad(dt.getUTCDate())
  const frac = Math.abs(serial - Math.trunc(serial))
  if (frac < 1e-6) return `${y}-${mo}-${d}`
  const h = pad(dt.getUTCHours())
  const mi = pad(dt.getUTCMinutes())
  const s = pad(dt.getUTCSeconds())
  if (serial >= 0 && serial < 1) return `${h}:${mi}:${s}`
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`
}

function formatNumber(raw) {
  const num = Number(raw)
  if (!Number.isFinite(num)) return raw
  // Avoid floating-point artifact tails like 12.300000000000001 from IEEE-754 serialization.
  return String(Number(num.toPrecision(15)))
}

export function colLettersToIndex(letters) {
  let index = 0
  for (let i = 0; i < letters.length; i += 1) {
    const code = letters.charCodeAt(i)
    const upper = code >= 97 && code <= 122 ? code - 32 : code
    if (upper < 65 || upper > 90) return -1
    index = index * 26 + (upper - 64)
  }
  return index - 1
}

function parseCellRef(ref) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(ref ?? '')
  if (!match) return null
  const col = colLettersToIndex(match[1])
  const row = Number.parseInt(match[2], 10) - 1
  if (col < 0 || !Number.isInteger(row) || row < 0) return null
  return { row, col }
}

function resolveSheetTarget(relTarget) {
  if (!relTarget) return null
  const clean = relTarget.replace(/\\/g, '/')
  if (clean.startsWith('/')) return clean.slice(1)
  if (clean.startsWith('xl/')) return clean
  if (clean.startsWith('../')) return clean.replace(/^(?:\.\.\/)+/, '')
  return `xl/${clean}`
}

function parseWorkbook(workbookXml, relsXml) {
  const date1904 = /<(?:[A-Za-z_][\w.-]*:)?workbookPr\b[^>]*date1904\s*=\s*["'](?:1|true)["']/i.test(workbookXml)
  const rels = new Map()
  if (relsXml) {
    const relRe = /<(?:[A-Za-z_][\w.-]*:)?Relationship\s+([^>]*?)\/?>/g
    let m
    while ((m = relRe.exec(relsXml)) !== null) {
      const attrs = parseAttrs(m[1])
      if (attrs.Id && attrs.Target) rels.set(attrs.Id, resolveSheetTarget(attrs.Target))
    }
  }
  const sheets = []
  const sheetRe = /<(?:[A-Za-z_][\w.-]*:)?sheet\s+([^>]*?)\/?>/g
  let m
  let ordinal = 0
  while ((m = sheetRe.exec(workbookXml)) !== null) {
    ordinal += 1
    const attrs = parseAttrs(m[1])
    const name = attrs.name || `Sheet ${ordinal}`
    const relId = attrs['r:id'] ?? attrs.id
    const target = (relId && rels.get(relId)) || `xl/worksheets/sheet${ordinal}.xml`
    const state = attrs.state === 'hidden' || attrs.state === 'veryHidden' ? attrs.state : 'visible'
    sheets.push({ name, target, state })
  }
  return { date1904, sheets }
}

function parseWorksheet(xml, { sharedStrings, dateStyleIndexes, date1904, maxRows, maxCols }) {
  const cellMap = new Map()
  let maxSeenRow = -1
  let maxSeenCol = -1
  let hasFormulas = false

  const rowRe = /<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/g
  const cellRe = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g
  let rowAuto = 0
  let rm
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowAttrs = parseAttrs(rm[1])
    const parsedRowNum = rowAttrs.r ? Number.parseInt(rowAttrs.r, 10) - 1 : rowAuto
    const rowIdx = Number.isInteger(parsedRowNum) && parsedRowNum >= 0 ? parsedRowNum : rowAuto
    rowAuto = rowIdx + 1
    const rowBody = rm[2]
    let colAuto = 0
    cellRe.lastIndex = 0
    let cm
    while ((cm = cellRe.exec(rowBody)) !== null) {
      const attrs = parseAttrs(cm[1])
      const refPos = attrs.r ? parseCellRef(attrs.r) : null
      const r = refPos ? refPos.row : rowIdx
      const c = refPos ? refPos.col : colAuto
      colAuto = c + 1

      if (r > maxSeenRow) maxSeenRow = r
      if (c > maxSeenCol) maxSeenCol = c
      if (r >= maxRows || c >= maxCols) continue

      const body = cm[2] ?? ''
      const type = attrs.t ?? ''
      const styleIdx = attrs.s !== undefined ? Number.parseInt(attrs.s, 10) : -1
      const vMatch = /<(?:[A-Za-z_][\w.-]*:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/.exec(body)
      const fMatch = /<(?:[A-Za-z_][\w.-]*:)?f(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?f>/.exec(body)
      const isMatch = /<(?:[A-Za-z_][\w.-]*:)?is(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?is>/.exec(body)

      const rawVal = vMatch ? decodeXmlEntities(vMatch[1]) : null
      const rawFormula = fMatch ? decodeXmlEntities(fMatch[1]).trim() : ''
      let display = ''
      let num = false
      let err = false

      if (type === 's') {
        const idx = Number.parseInt(rawVal ?? '', 10)
        display = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : ''
      } else if (type === 'inlineStr') {
        display = isMatch ? extractTextRuns(isMatch[1]) : ''
      } else if (type === 'b') {
        display = rawVal === '1' || rawVal?.toLowerCase() === 'true' ? 'TRUE' : 'FALSE'
      } else if (type === 'e') {
        display = rawVal ?? '#ERROR!'
        err = true
      } else if (type === 'str' || type === 'd') {
        display = rawVal ?? ''
      } else if (rawVal !== null && rawVal !== '') {
        if (styleIdx >= 0 && dateStyleIndexes.has(styleIdx)) {
          display = formatExcelDate(Number(rawVal), date1904)
        } else {
          display = formatNumber(rawVal)
          num = true
        }
      }

      if (rawFormula) {
        hasFormulas = true
        if (display === '' && rawVal === null) display = `=${rawFormula}`
      }
      if (display === '' && !rawFormula) continue

      let rowBucket = cellMap.get(r)
      if (!rowBucket) {
        rowBucket = new Map()
        cellMap.set(r, rowBucket)
      }
      const cell = { v: display }
      if (rawFormula) cell.f = `=${rawFormula}`
      if (num) cell.num = true
      if (err) cell.err = true
      rowBucket.set(c, cell)
    }
  }

  const totalRows = maxSeenRow + 1
  const totalCols = maxSeenCol + 1
  const rowCount = Math.min(totalRows, maxRows)
  const colCount = Math.min(totalCols, maxCols)

  const rows = []
  for (let r = 0; r < rowCount; r += 1) {
    const bucket = cellMap.get(r)
    const row = Array.from({ length: colCount }, () => null)
    if (bucket) {
      for (const [c, cell] of bucket) {
        if (c < colCount) row[c] = cell
      }
    }
    rows.push(row)
  }

  const merges = []
  const mergeRe = /<(?:[A-Za-z_][\w.-]*:)?mergeCell\s+([^>]*?)\/?>/g
  let mm
  while ((mm = mergeRe.exec(xml)) !== null) {
    const ref = parseAttrs(mm[1]).ref
    if (!ref || !ref.includes(':')) continue
    const [startStr, endStr] = ref.split(':')
    const start = parseCellRef(startStr)
    const end = parseCellRef(endStr)
    if (!start || !end) continue
    if (start.row >= rowCount || start.col >= colCount) continue
    merges.push({
      r1: start.row,
      c1: start.col,
      r2: Math.min(end.row, rowCount - 1),
      c2: Math.min(end.col, colCount - 1),
    })
  }

  return {
    rows,
    rowCount,
    colCount,
    totalRows,
    totalCols,
    truncatedRows: totalRows > maxRows,
    truncatedCols: totalCols > maxCols,
    hasFormulas,
    merges,
  }
}

export function parseXlsxBuffer(buffer, { maxSheets = MAX_PREVIEW_SHEETS, maxRows = MAX_PREVIEW_ROWS, maxCols = MAX_PREVIEW_COLS } = {}) {
  const zip = readZipEntries(buffer)
  const workbookXml = zip.readText('xl/workbook.xml')
  if (!workbookXml) throw new Error('Workbook metadata missing from spreadsheet')
  const relsXml = zip.readText('xl/_rels/workbook.xml.rels')
  const sharedStrings = parseSharedStrings(zip.readText('xl/sharedStrings.xml'))
  const dateStyleIndexes = parseStyles(zip.readText('xl/styles.xml'))
  const { date1904, sheets: metaSheets } = parseWorkbook(workbookXml, relsXml)

  const truncatedSheets = metaSheets.length > maxSheets
  const bounded = metaSheets.slice(0, maxSheets)
  const sheets = []
  for (const meta of bounded) {
    const sheetXml = zip.readText(meta.target)
    if (!sheetXml) continue
    const parsed = parseWorksheet(sheetXml, { sharedStrings, dateStyleIndexes, date1904, maxRows, maxCols })
    sheets.push({
      name: meta.name,
      state: meta.state,
      ...parsed,
    })
  }
  if (sheets.length === 0) throw new Error('Workbook contains no readable worksheets')
  return {
    sheets,
    totalSheets: metaSheets.length,
    truncatedSheets,
  }
}
