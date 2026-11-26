// Bounded, streaming OOXML spreadsheet (.xlsx / .xlsm) parser for the desktop
// previewer. Reads ZIP central-directory entries with strict zip-slip, ZIP64,
// and byte caps, and parses XML with `saxes` (strict streaming XML 1.0/1.1) so
// hostile or giant workbooks cannot stall the host, leak phonetic runs, inflate
// empty styled cells, or exceed JSON response budgets.
import { posix } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createInflateRaw, inflateRawSync } from 'node:zlib'
import { SaxesParser } from 'saxes'

export const MAX_PREVIEW_SHEETS = 20
export const MAX_PREVIEW_ROWS = 500
export const MAX_PREVIEW_COLS = 40
export const MAX_ZIP_ENTRIES = 2_000
export const MAX_ENTRY_BYTES = 24 * 1024 * 1024
export const MAX_TOTAL_DECOMPRESSED_BYTES = 48 * 1024 * 1024
export const MAX_STREAM_SCAN_BYTES = 2 * 1024 * 1024
export const MAX_STREAM_SCAN_ROWS = 5_000
export const MAX_XML_DEPTH = 64
export const MAX_MERGES_PER_SHEET = 2_000
export const MAX_CELL_TEXT_CHARS = 4_000
export const MAX_WORKBOOK_TEXT_CHARS = 1_500_000
const STREAM_CHUNK_BYTES = 64 * 1024

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

// Standard OOXML built-in date/time numFmtIds (ECMA-376 §18.8.30).
const BUILTIN_DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
// Transitional (ECMA-376) and Strict (ISO/IEC 29500) OOXML relationship namespaces.
const OOXML_REL_NS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
])

function attrOf(attrs, ...names) {
  for (const name of names) {
    if (Object.hasOwn(attrs, name)) {
      const entry = attrs[name]
      return typeof entry === 'string' ? entry : entry?.value
    }
  }
  return undefined
}

function relIdOf(attrs) {
  let bareId = ''
  for (const attr of Object.values(attrs)) {
    if (!attr || typeof attr !== 'object') continue
    if (attr.local !== 'id') continue
    if (OOXML_REL_NS.has(attr.uri)) return attr.value ?? ''
    if (attr.uri === '' && bareId === '') bareId = attr.value ?? ''
  }
  return bareId
}

function findEocd(buf) {
  const minPos = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue
    const commentLen = buf.readUInt16LE(i + 20)
    if (i + 22 + commentLen === buf.length) return i
  }
  return -1
}

function normalizeZipPath(rawName) {
  const slashed = String(rawName ?? '').replace(/\\/g, '/')
  if (slashed === '' || slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    throw new Error(`Unsafe archive member path: ${rawName}`)
  }
  const parts = slashed.split('/')
  if (parts.includes('..')) throw new Error(`Unsafe archive member path: ${rawName}`)
  const norm = posix.normalize(slashed).replace(/^\.\//, '')
  if (norm === '' || norm === '.' || norm.startsWith('..')) {
    throw new Error(`Unsafe archive member path: ${rawName}`)
  }
  return norm
}

function resolveWorkbookTarget(target) {
  const clean = String(target ?? '').replace(/\\/g, '/').trim()
  if (clean === '') return ''
  const joined = clean.startsWith('/') ? clean.slice(1) : posix.join('xl', clean)
  const norm = posix.normalize(joined).replace(/^\/+/, '')
  if (norm === '' || norm === '.' || norm.startsWith('..')) return ''
  return norm
}

function readZipDirectory(buf, maxEntryBytes) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Not a valid ZIP archive')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found')
  const diskNumber = buf.readUInt16LE(eocd + 4)
  const cdDisk = buf.readUInt16LE(eocd + 6)
  const entryCount = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (
    diskNumber === 0xffff || cdDisk === 0xffff
    || entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 archives are not supported')
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error('Archive has too many entries to preview')
  }
  if (cdOffset + cdSize > eocd) throw new Error('Corrupt ZIP central directory')

  const entries = new Map()
  let pos = cdOffset
  for (let i = 0; i < entryCount && pos + 46 <= cdOffset + cdSize; i += 1) {
    if (buf.readUInt32LE(pos) !== CD_SIG) throw new Error('Corrupt ZIP central directory entry')
    const method = buf.readUInt16LE(pos + 10)
    const compSize = buf.readUInt32LE(pos + 20)
    const uncompSize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const lfhOffset = buf.readUInt32LE(pos + 42)
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || lfhOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported')
    }
    const headerEnd = pos + 46 + nameLen + extraLen + commentLen
    if (headerEnd > cdOffset + cdSize) throw new Error('Truncated ZIP central directory entry')
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    pos = headerEnd
    if (rawName.endsWith('/')) continue
    const name = normalizeZipPath(rawName)

    if (lfhOffset + 30 > buf.length || buf.readUInt32LE(lfhOffset) !== LFH_SIG) {
      throw new Error(`Corrupt local file header for ${name}`)
    }
    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26)
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28)
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen
    const dataEnd = dataStart + compSize
    if (dataStart > buf.length || dataEnd > buf.length) {
      throw new Error(`Truncated archive data for ${name}`)
    }
    if (method === 0 && compSize !== uncompSize) {
      throw new Error(`Stored size mismatch for ${name}`)
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`Unsupported compression method ${method} for ${name}`)
    }
    entries.set(name, {
      name,
      method,
      compSize,
      uncompSize,
      dataStart,
      dataEnd,
      oversized: uncompSize > maxEntryBytes,
    })
  }
  return entries
}

function readExactEntryText(buf, entry, budget, maxEntryBytes) {
  if (entry.oversized || entry.uncompSize > maxEntryBytes) {
    throw new Error(`Workbook part ${entry.name} exceeds preview size limit`)
  }
  if (budget.inflated + entry.uncompSize > budget.maxTotalBytes) {
    throw new Error('Workbook decompressed size exceeds preview limit')
  }
  const raw = buf.subarray(entry.dataStart, entry.dataEnd)
  let data
  if (entry.method === 0) {
    if (raw.length !== entry.uncompSize || raw.length > maxEntryBytes) {
      throw new Error(`Stored size mismatch for ${entry.name}`)
    }
    data = raw
  } else {
    try {
      const cap = Math.min(maxEntryBytes, Math.max(entry.uncompSize, 1))
      data = inflateRawSync(raw, { maxOutputLength: cap })
    } catch (err) {
      if (err instanceof RangeError || err?.code === 'ERR_OUT_OF_RANGE') {
        throw new Error(`Workbook part ${entry.name} inflates past its declared size`)
      }
      throw new Error(`Corrupt compressed data in ${entry.name}`)
    }
    if (data.length !== entry.uncompSize) {
      throw new Error(`Decompressed size mismatch for ${entry.name}`)
    }
  }
  budget.inflated += data.length
  return data.toString('utf8')
}

const ABORT_PARSE = Symbol('abort-xlsx-parse')

function createStrictParser(handlers) {
  const parser = new SaxesParser({ xmlns: true })
  let depth = 0
  let aborted = false
  let fatalError = null

  const abort = () => {
    aborted = true
    throw ABORT_PARSE
  }
  const fail = (err) => {
    if (!fatalError) fatalError = err instanceof Error ? err : new Error(String(err))
    aborted = true
    throw ABORT_PARSE
  }

  parser.on('error', (err) => { fail(err) })
  parser.on('opentag', (node) => {
    if (aborted) throw ABORT_PARSE
    depth += 1
    if (depth > MAX_XML_DEPTH) {
      fail(new Error('XML nesting exceeds preview safety limit'))
    }
    try {
      handlers.onOpen?.(node.local, node.attributes, node.isSelfClosing, abort)
    } catch (err) {
      if (err === ABORT_PARSE) throw err
      fail(err)
    }
  })
  parser.on('text', (text) => {
    if (aborted) throw ABORT_PARSE
    try {
      handlers.onText?.(text, abort)
    } catch (err) {
      if (err === ABORT_PARSE) throw err
      fail(err)
    }
  })
  parser.on('cdata', (text) => {
    if (aborted) throw ABORT_PARSE
    try {
      handlers.onText?.(text, abort)
    } catch (err) {
      if (err === ABORT_PARSE) throw err
      fail(err)
    }
  })
  parser.on('closetag', (node) => {
    if (aborted) throw ABORT_PARSE
    depth = Math.max(0, depth - 1)
    try {
      handlers.onClose?.(node.local, abort)
    } catch (err) {
      if (err === ABORT_PARSE) throw err
      fail(err)
    }
  })

  return {
    write(chunk) {
      if (aborted) return false
      try {
        parser.write(chunk)
      } catch (err) {
        if (err !== ABORT_PARSE && !fatalError) {
          fatalError = err instanceof Error ? err : new Error(String(err))
          aborted = true
        }
      }
      if (fatalError) throw fatalError
      return !aborted
    },
    close() {
      if (aborted) {
        if (fatalError) throw fatalError
        return
      }
      try {
        parser.close()
      } catch (err) {
        if (err !== ABORT_PARSE && !fatalError) {
          fatalError = err instanceof Error ? err : new Error(String(err))
          aborted = true
        }
      }
      if (fatalError) throw fatalError
    },
    isAborted: () => aborted,
    getError: () => fatalError,
  }
}

function parseStrictXml(xmlText, handlers) {
  const runner = createStrictParser(handlers)
  for (let offset = 0; offset < xmlText.length; offset += STREAM_CHUNK_BYTES) {
    if (!runner.write(xmlText.slice(offset, offset + STREAM_CHUNK_BYTES))) break
  }
  runner.close()
}

// Streams a ZIP entry (stored or deflate) into a strict saxes parser chunk by chunk,
// allowing worksheets to stop decompressing early once preview caps are exceeded.
async function streamZipEntryXml(buf, entry, budget, maxEntryBytes, handlers) {
  const runner = createStrictParser(handlers)
  const decoder = new StringDecoder('utf8')
  const raw = buf.subarray(entry.dataStart, entry.dataEnd)
  let inflatedBytes = 0
  let stoppedEarly = false
  let truncatedBySize = false

  if (entry.method === 0) {
    if (raw.length !== entry.uncompSize) {
      throw new Error(`Stored size mismatch for ${entry.name}`)
    }
    for (let offset = 0; offset < raw.length; offset += STREAM_CHUNK_BYTES) {
      const slice = raw.subarray(offset, Math.min(raw.length, offset + STREAM_CHUNK_BYTES))
      if (inflatedBytes + slice.length > maxEntryBytes || budget.inflated + slice.length > budget.maxTotalBytes) {
        truncatedBySize = true
        stoppedEarly = true
        break
      }
      inflatedBytes += slice.length
      budget.inflated += slice.length
      const text = decoder.write(slice)
      if (text !== '' && !runner.write(text)) {
        stoppedEarly = true
        break
      }
      if (handlers.shouldStop?.(inflatedBytes)) {
        stoppedEarly = true
        break
      }
    }
    if (!stoppedEarly) {
      const tail = decoder.end()
      if (tail !== '') runner.write(tail)
      runner.close()
    } else if (runner.getError()) {
      throw runner.getError()
    }
    return { inflatedBytes, stoppedEarly, truncatedBySize }
  }

  // DEFLATE streaming inflate with hard per-entry and workbook-total byte bounds.
  await new Promise((resolveStream, rejectStream) => {
    const inflate = createInflateRaw({ chunkSize: STREAM_CHUNK_BYTES })
    let settled = false
    const finishOk = () => {
      if (settled) return
      settled = true
      resolveStream()
    }
    const finishErr = (err) => {
      if (settled) return
      settled = true
      try { inflate.destroy() } catch { /* ignore */ }
      rejectStream(err)
    }

    inflate.on('data', (chunk) => {
      if (settled || stoppedEarly) return
      if (inflatedBytes + chunk.length > maxEntryBytes || budget.inflated + chunk.length > budget.maxTotalBytes) {
        truncatedBySize = true
        stoppedEarly = true
        try { inflate.destroy() } catch { /* ignore */ }
        finishOk()
        return
      }
      inflatedBytes += chunk.length
      budget.inflated += chunk.length
      if (!entry.oversized && inflatedBytes > entry.uncompSize) {
        finishErr(new Error(`Workbook part ${entry.name} inflates past its declared size`))
        return
      }
      try {
        const text = decoder.write(chunk)
        if (text !== '' && !runner.write(text)) {
          stoppedEarly = true
          try { inflate.destroy() } catch { /* ignore */ }
          finishOk()
          return
        }
        if (handlers.shouldStop?.(inflatedBytes)) {
          stoppedEarly = true
          try { inflate.destroy() } catch { /* ignore */ }
          finishOk()
        }
      } catch (err) {
        finishErr(err)
      }
    })

    inflate.on('end', () => {
      if (settled || stoppedEarly) return
      if (!entry.oversized && inflatedBytes !== entry.uncompSize) {
        finishErr(new Error(`Decompressed size mismatch for ${entry.name}`))
        return
      }
      try {
        const tail = decoder.end()
        if (tail !== '') runner.write(tail)
        runner.close()
        finishOk()
      } catch (err) {
        finishErr(err)
      }
    })

    inflate.on('error', (err) => {
      if (stoppedEarly) {
        if (runner.getError()) finishErr(runner.getError())
        else finishOk()
        return
      }
      finishErr(new Error(`Corrupt compressed data in ${entry.name}: ${err.message}`))
    })

    inflate.on('close', () => {
      if (!settled && stoppedEarly) {
        if (runner.getError()) finishErr(runner.getError())
        else finishOk()
      }
    })

    // Feed compressed input in chunks so an early stop never buffers the whole entry.
    let offset = 0
    const pump = () => {
      while (!settled && !stoppedEarly && offset < raw.length) {
        const nextEnd = Math.min(raw.length, offset + STREAM_CHUNK_BYTES)
        const slice = raw.subarray(offset, nextEnd)
        offset = nextEnd
        if (!inflate.write(slice)) {
          inflate.once('drain', pump)
          return
        }
      }
      if (!settled && !stoppedEarly && offset >= raw.length) {
        inflate.end()
      }
    }
    pump()
  })

  if (runner.getError()) throw runner.getError()
  return { inflatedBytes, stoppedEarly, truncatedBySize }
}

function parseSharedStrings(xmlText) {
  const list = []
  let inSi = false
  let inT = false
  let rPhDepth = 0
  let current = ''

  parseStrictXml(xmlText, {
    onOpen(tag) {
      if (tag === 'si') {
        inSi = true
        current = ''
      } else if (inSi && tag === 'rPh') {
        rPhDepth += 1
      } else if (inSi && rPhDepth === 0 && tag === 't') {
        inT = true
      }
    },
    onText(text) {
      if (inSi && inT && rPhDepth === 0) current += text
    },
    onClose(tag) {
      if (tag === 't') {
        inT = false
      } else if (tag === 'rPh' && rPhDepth > 0) {
        rPhDepth -= 1
      } else if (tag === 'si' && inSi) {
        list.push(current)
        inSi = false
        inT = false
        rPhDepth = 0
        current = ''
      }
    },
  })
  return list
}

function isCustomDateFormatCode(code) {
  if (!code) return false
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
  return /[ymdhs]/i.test(stripped) && !/^[@#0,.\s%E+\-()]+$/.test(stripped)
}

function parseDateStyleIndices(xmlText) {
  const customDateIds = new Set()
  const dateStyleIndexes = new Set()
  let inCellXfs = false
  let xfIndex = 0

  parseStrictXml(xmlText, {
    onOpen(tag, attrs) {
      if (tag === 'numFmt') {
        const id = Number(attrOf(attrs, 'numFmtId'))
        const code = attrOf(attrs, 'formatCode') ?? ''
        if (Number.isInteger(id) && isCustomDateFormatCode(code)) customDateIds.add(id)
      } else if (tag === 'cellXfs') {
        inCellXfs = true
        xfIndex = 0
      } else if (inCellXfs && tag === 'xf') {
        const numFmtId = Number(attrOf(attrs, 'numFmtId') ?? '0')
        if (BUILTIN_DATE_FMT_IDS.has(numFmtId) || customDateIds.has(numFmtId)) {
          dateStyleIndexes.add(xfIndex)
        }
        xfIndex += 1
      }
    },
    onClose(tag) {
      if (tag === 'cellXfs') inCellXfs = false
    },
  })
  return dateStyleIndexes
}

function formatExcelDate(serial, date1904) {
  if (!Number.isFinite(serial)) return String(serial)
  const baseUtc = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const ms = Math.round(serial * 86_400_000)
  const d = new Date(baseUtc + ms)
  if (Number.isNaN(d.getTime())) return String(serial)
  const hasTime = Math.abs(serial - Math.trunc(serial)) > 1e-6
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  if (!hasTime) return `${yyyy}-${mm}-${dd}`
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
}

export function colLettersToIndex(letters) {
  let idx = 0
  for (let i = 0; i < letters.length; i += 1) {
    const code = letters.charCodeAt(i)
    if (code < 65 || code > 90) return -1
    idx = idx * 26 + (code - 64)
  }
  return idx - 1
}

export function colIndexToLetters(index) {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function parseCellRef(ref) {
  const match = /^([A-Z]{1,4})(\d{1,7})$/.exec(ref)
  if (!match) return null
  const col = colLettersToIndex(match[1])
  const row = Number(match[2]) - 1
  if (col < 0 || row < 0) return null
  return { row, col }
}

function parseWorkbook(xmlText) {
  let date1904 = false
  const sheets = []
  let inSheets = false

  parseStrictXml(xmlText, {
    onOpen(tag, attrs) {
      if (tag === 'workbookPr') {
        const d = attrOf(attrs, 'date1904')
        if (d === '1' || d === 'true') date1904 = true
      } else if (tag === 'sheets') {
        inSheets = true
      } else if (inSheets && tag === 'sheet') {
        const name = attrOf(attrs, 'name') ?? ''
        const rId = relIdOf(attrs)
        const state = attrOf(attrs, 'state') ?? 'visible'
        if (name !== '' && rId !== '') sheets.push({ name, rId, state })
      }
    },
    onClose(tag) {
      if (tag === 'sheets') inSheets = false
    },
  })
  return { date1904, sheets }
}

function parseWorkbookRels(xmlText) {
  const rels = new Map()
  parseStrictXml(xmlText, {
    onOpen(tag, attrs) {
      if (tag !== 'Relationship') return
      const id = attrOf(attrs, 'Id')
      const target = attrOf(attrs, 'Target')
      if (!id || !target) return
      const resolved = resolveWorkbookTarget(target)
      if (resolved) rels.set(id, resolved)
    },
  })
  return rels
}

function clipText(raw, textBudget) {
  let text = String(raw ?? '')
  let clipped = false
  if (text.length > MAX_CELL_TEXT_CHARS) {
    text = `${text.slice(0, MAX_CELL_TEXT_CHARS)}…`
    clipped = true
  }
  const remaining = textBudget.maxChars - textBudget.usedChars
  if (remaining <= 0) {
    return { text: '', clipped: true, exhausted: true }
  }
  if (text.length > remaining) {
    text = `${text.slice(0, Math.max(0, remaining - 1))}…`
    textBudget.usedChars = textBudget.maxChars
    return { text, clipped: true, exhausted: true }
  }
  textBudget.usedChars += text.length
  return { text, clipped, exhausted: false }
}

async function parseWorksheetStream(buf, entry, budget, textBudget, {
  sharedStrings,
  dateStyleIndexes,
  date1904,
  maxRows,
  maxCols,
  maxEntryBytes,
}) {
  const rowsMap = new Map()
  const merges = []
  const seenMerges = new Set()
  let maxSeenRow = -1
  let maxSeenCol = -1
  let sawTruncatedRows = false
  let sawTruncatedCols = false
  let sawTruncatedText = false
  let exactRowCount = true

  let inSheetData = false
  let currentRowIdx = -1
  let nextImplicitRow = 0
  let nextImplicitCol = 0

  let inCell = false
  let cellRow = -1
  let cellCol = -1
  let cellType = ''
  let cellStyle = -1
  let cellInBounds = false
  let inV = false
  let inF = false
  let inIs = false
  let inT = false
  let rPhDepth = 0
  let rawV = ''
  let hasV = false
  let rawF = ''
  let hasF = false
  let rawIs = ''
  let hasIs = false
  let outOfBoundsContent = false
  const MAX_RAW_CELL_CHARS = MAX_CELL_TEXT_CHARS + 64

  const commitCell = (abort) => {
    if (!inCell) return
    inCell = false
    inV = false
    inF = false
    inIs = false
    inT = false
    rPhDepth = 0

    if (!cellInBounds) {
      if (!outOfBoundsContent) return
      if (cellRow > maxSeenRow) maxSeenRow = cellRow
      if (cellCol > maxSeenCol) maxSeenCol = cellCol
      if (cellRow >= maxRows) sawTruncatedRows = true
      if (cellCol >= maxCols) sawTruncatedCols = true
      return
    }

    // Decode value/formula before deciding whether the cell is populated.
    let display = ''
    let kind = 's'
    if (cellType === 's') {
      if (hasV) {
        const idx = Number(rawV.trim())
        display = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : ''
      }
      kind = 's'
    } else if (cellType === 'inlineStr') {
      display = hasIs ? rawIs : ''
      kind = 's'
    } else if (cellType === 'b') {
      if (hasV) display = rawV.trim() === '1' ? 'TRUE' : 'FALSE'
      kind = 'b'
    } else if (cellType === 'e') {
      display = hasV ? rawV.trim() : ''
      kind = 'e'
    } else if (cellType === 'str') {
      display = hasV ? rawV : ''
      kind = 's'
    } else if (hasV && rawV.trim() !== '') {
      const trimmed = rawV.trim()
      const num = Number(trimmed)
      if (Number.isFinite(num) && dateStyleIndexes.has(cellStyle)) {
        display = formatExcelDate(num, date1904)
        kind = 'd'
      } else if (Number.isFinite(num)) {
        display = trimmed
        kind = 'n'
      } else {
        display = rawV
        kind = 's'
      }
    }

    const formula = hasF && rawF.trim() !== '' ? `=${rawF.trim()}` : undefined
    const hasContent = display !== '' || formula !== undefined
    if (!hasContent) return

    if (cellRow > maxSeenRow) maxSeenRow = cellRow
    if (cellCol > maxSeenCol) maxSeenCol = cellCol
    if (cellRow >= maxRows) sawTruncatedRows = true
    if (cellCol >= maxCols) sawTruncatedCols = true
    if (!cellInBounds) return

    const valClip = clipText(display, textBudget)
    if (valClip.clipped) sawTruncatedText = true
    let finalFormula = formula
    if (finalFormula !== undefined && !valClip.exhausted) {
      const fClip = clipText(finalFormula, textBudget)
      finalFormula = fClip.text
      if (fClip.clipped) sawTruncatedText = true
      if (fClip.exhausted) {
        sawTruncatedRows = true
        exactRowCount = false
        abort()
      }
    } else if (valClip.exhausted) {
      sawTruncatedRows = true
      exactRowCount = false
      abort()
      return
    }

    let rowCells = rowsMap.get(cellRow)
    if (!rowCells) {
      rowCells = new Map()
      rowsMap.set(cellRow, rowCells)
    }
    const cellObj = { v: valClip.text }
    if (kind === 'n') cellObj.num = true
    if (kind === 'e') cellObj.err = true
    if (finalFormula) cellObj.f = finalFormula
    rowCells.set(cellCol, cellObj)
  }

  const streamMeta = await streamZipEntryXml(buf, entry, budget, maxEntryBytes, {
    onOpen(tag, attrs, _isSelfClosing, abort) {
      if (tag === 'sheetData') {
        inSheetData = true
      } else if (inSheetData && tag === 'row') {
        const rAttr = attrOf(attrs, 'r')
        currentRowIdx = rAttr !== undefined ? Number(rAttr) - 1 : nextImplicitRow
        if (!Number.isInteger(currentRowIdx) || currentRowIdx < 0) currentRowIdx = nextImplicitRow
        nextImplicitRow = currentRowIdx + 1
        nextImplicitCol = 0
        if (sawTruncatedRows && currentRowIdx >= MAX_STREAM_SCAN_ROWS) {
          exactRowCount = false
          abort()
        }
      } else if (inSheetData && tag === 'c') {
        const refAttr = attrOf(attrs, 'r')
        const parsed = refAttr ? parseCellRef(refAttr) : null
        cellRow = parsed ? parsed.row : currentRowIdx
        cellCol = parsed ? parsed.col : nextImplicitCol
        if (cellRow < 0 || cellCol < 0) {
          inCell = false
          return
        }
        nextImplicitCol = cellCol + 1
        cellType = attrOf(attrs, 't') ?? ''
        const sAttr = attrOf(attrs, 's')
        cellStyle = sAttr !== undefined ? Number(sAttr) : -1
        cellInBounds = cellRow < maxRows && cellCol < maxCols
        inCell = true
        inV = false
        inF = false
        inIs = false
        inT = false
        rPhDepth = 0
        rawV = ''
        hasV = false
        rawF = ''
        hasF = false
        rawIs = ''
        hasIs = false
        outOfBoundsContent = false
      } else if (inCell) {
        if (tag === 'v') {
          inV = true
          hasV = true
        } else if (tag === 'f') {
          inF = true
          hasF = true
        } else if (tag === 'is') {
          inIs = true
          hasIs = true
        } else if (inIs && tag === 'rPh') {
          rPhDepth += 1
        } else if (inIs && rPhDepth === 0 && tag === 't') {
          inT = true
        }
      } else if (tag === 'mergeCell' && merges.length < MAX_MERGES_PER_SHEET) {
        const ref = attrOf(attrs, 'ref')
        if (!ref) return
        const [startRef, endRef] = ref.split(':')
        if (!startRef || !endRef) return
        const a = parseCellRef(startRef)
        const b = parseCellRef(endRef)
        if (!a || !b) return
        const r1 = Math.min(a.row, b.row)
        const r2 = Math.max(a.row, b.row)
        const c1 = Math.min(a.col, b.col)
        const c2 = Math.max(a.col, b.col)
        const key = `${r1}:${c1}:${r2}:${c2}`
        if (seenMerges.has(key)) return
        seenMerges.add(key)
        merges.push({ r1, c1, r2, c2 })
      }
    },
    onText(text) {
      if (!inCell) return
      if (!cellInBounds) {
        if ((inV || inF || (inIs && inT && rPhDepth === 0)) && text.trim() !== '') outOfBoundsContent = true
        return
      }
      if (inV) {
        if (rawV.length < MAX_RAW_CELL_CHARS) rawV += text.slice(0, MAX_RAW_CELL_CHARS - rawV.length)
        else sawTruncatedText = true
      } else if (inF) {
        if (rawF.length < MAX_RAW_CELL_CHARS) rawF += text.slice(0, MAX_RAW_CELL_CHARS - rawF.length)
        else sawTruncatedText = true
      } else if (inIs && inT && rPhDepth === 0) {
        if (rawIs.length < MAX_RAW_CELL_CHARS) rawIs += text.slice(0, MAX_RAW_CELL_CHARS - rawIs.length)
        else sawTruncatedText = true
      }
    },
    onClose(tag, abort) {
      if (tag === 'sheetData') {
        inSheetData = false
      } else if (tag === 'c') {
        commitCell(abort)
      } else if (tag === 'v') {
        inV = false
      } else if (tag === 'f') {
        inF = false
      } else if (tag === 't') {
        inT = false
      } else if (tag === 'rPh' && rPhDepth > 0) {
        rPhDepth -= 1
      } else if (tag === 'is') {
        inIs = false
        inT = false
        rPhDepth = 0
      }
    },
    shouldStop(inflatedBytes) {
      if (sawTruncatedRows && inflatedBytes >= MAX_STREAM_SCAN_BYTES) {
        exactRowCount = false
        return true
      }
      return false
    },
  })

  if (streamMeta.truncatedBySize) {
    sawTruncatedRows = true
    exactRowCount = false
  }

  // Only include merges that intersect populated rows/columns within the preview window.
  const populatedRowCount = maxSeenRow + 1
  const populatedColCount = maxSeenCol + 1
  let visibleRows = Math.min(populatedRowCount, maxRows)
  let visibleCols = Math.min(populatedColCount, maxCols)

  const clippedMerges = []
  for (const m of merges) {
    // Keep merges whose origin cell has content or that lie within the populated grid.
    const originHasContent = Boolean(rowsMap.get(m.r1)?.has(m.c1))
    if (!originHasContent && (m.r1 >= populatedRowCount || m.c1 >= populatedColCount)) continue
    if (originHasContent) {
      visibleRows = Math.max(visibleRows, Math.min(m.r2 + 1, maxRows))
      visibleCols = Math.max(visibleCols, Math.min(m.c2 + 1, maxCols))
    }
    if (m.r1 < visibleRows && m.c1 < visibleCols) {
      clippedMerges.push({
        r1: m.r1,
        c1: m.c1,
        r2: Math.min(m.r2, visibleRows - 1),
        c2: Math.min(m.c2, visibleCols - 1),
      })
    }
  }

  const rows = []
  for (let r = 0; r < visibleRows; r += 1) {
    const rowCells = rowsMap.get(r)
    const rowArr = new Array(visibleCols)
    for (let c = 0; c < visibleCols; c += 1) {
      rowArr[c] = rowCells?.get(c) ?? null
    }
    rows.push(rowArr)
  }

  return {
    rows,
    rowCount: visibleRows,
    colCount: visibleCols,
    totalRows: exactRowCount ? Math.max(populatedRowCount, visibleRows) : null,
    totalCols: Math.max(populatedColCount, visibleCols),
    truncatedRows: sawTruncatedRows || populatedRowCount > maxRows,
    truncatedCols: sawTruncatedCols || populatedColCount > maxCols,
    truncatedText: sawTruncatedText,
    truncatedBySize: streamMeta.truncatedBySize,
    merges: clippedMerges,
  }
}

/**
 * Parses an `.xlsx`/`.xlsm` workbook buffer into bounded multi-sheet preview data.
 * Uses strict streaming XML parsing (`saxes`) and strict ZIP bounds.
 */
export async function parseXlsxBuffer(buf, options = {}) {
  const maxSheets = Number.isInteger(options.maxSheets) && options.maxSheets > 0 ? options.maxSheets : MAX_PREVIEW_SHEETS
  const maxRows = Number.isInteger(options.maxRows) && options.maxRows > 0 ? options.maxRows : MAX_PREVIEW_ROWS
  const maxCols = Number.isInteger(options.maxCols) && options.maxCols > 0 ? options.maxCols : MAX_PREVIEW_COLS
  const maxEntryBytes = Number.isInteger(options.maxEntryBytes) && options.maxEntryBytes > 0 ? options.maxEntryBytes : MAX_ENTRY_BYTES
  const maxTotalBytes = Number.isInteger(options.maxTotalBytes) && options.maxTotalBytes > 0 ? options.maxTotalBytes : MAX_TOTAL_DECOMPRESSED_BYTES
  const maxWorkbookChars = Number.isInteger(options.maxWorkbookChars) && options.maxWorkbookChars > 0 ? options.maxWorkbookChars : MAX_WORKBOOK_TEXT_CHARS

  const entries = readZipDirectory(buf, maxEntryBytes)
  const workbookEntry = entries.get('xl/workbook.xml')
  if (!workbookEntry) throw new Error('Workbook metadata (xl/workbook.xml) is missing')

  const budget = { inflated: 0, maxTotalBytes }
  const textBudget = { usedChars: 0, maxChars: maxWorkbookChars }

  const workbookXml = readExactEntryText(buf, workbookEntry, budget, maxEntryBytes)
  const { date1904, sheets: sheetDefs } = parseWorkbook(workbookXml)
  if (sheetDefs.length === 0) throw new Error('Workbook contains no sheets')

  const relsEntry = entries.get('xl/_rels/workbook.xml.rels')
  const rels = relsEntry ? parseWorkbookRels(readExactEntryText(buf, relsEntry, budget, maxEntryBytes)) : new Map()

  const sharedEntry = entries.get('xl/sharedStrings.xml')
  const sharedStrings = sharedEntry ? parseSharedStrings(readExactEntryText(buf, sharedEntry, budget, maxEntryBytes)) : []

  const stylesEntry = entries.get('xl/styles.xml')
  const dateStyleIndexes = stylesEntry ? parseDateStyleIndices(readExactEntryText(buf, stylesEntry, budget, maxEntryBytes)) : new Set()

  const totalSheets = sheetDefs.length
  let truncatedSheets = totalSheets > maxSheets
  let truncatedText = false
  const sheets = []

  for (let i = 0; i < Math.min(sheetDefs.length, maxSheets); i += 1) {
    const def = sheetDefs[i]
    const target = rels.get(def.rId) ?? `xl/worksheets/sheet${i + 1}.xml`
    const wsEntry = entries.get(target)
    if (!wsEntry) {
      throw new Error(`Worksheet part ${target} is missing`)
    }
    if (textBudget.usedChars >= textBudget.maxChars) {
      truncatedSheets = true
      truncatedText = true
      break
    }
    const parsed = await parseWorksheetStream(buf, wsEntry, budget, textBudget, {
      sharedStrings,
      dateStyleIndexes,
      date1904,
      maxRows,
      maxCols,
      maxEntryBytes,
    })
    if (parsed.truncatedText) truncatedText = true
    sheets.push({
      name: def.name,
      state: def.state,
      ...parsed,
    })
  }
  if (sheets.length === 0) throw new Error('No readable worksheets found in workbook')
  return {
    sheets,
    totalSheets,
    truncatedSheets,
    truncatedText,
  }
}
