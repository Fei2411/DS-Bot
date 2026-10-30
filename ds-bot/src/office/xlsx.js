// xlsx commands: inventory (sheets, names, error cells) and read (a grid of
// cached values with formulas, dates shown as ISO, booleans).
import { childrenOf, elementsOf, firstOf, textOf } from './xml.js'

const DATE_FORMATS = new Set([14, 15, 16, 17, 22, 45, 46, 47])
const dateLike = (code) => /(^|[^\\])[ymdhs]/i.test(code ?? '')

function numFmts(pkg) {
  const map = new Map()
  if (!pkg.parts.has('xl/styles.xml')) return map
  const doc = pkg.xml('xl/styles.xml')
  const cellXfs = firstOf(doc.documentElement, 'cellXfs')
  const custom = new Map()
  for (const f of elementsOf(doc.documentElement, 'numFmt')) custom.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '')
  let i = 0
  for (const xf of childrenOf(cellXfs)) {
    const id = Number(xf.getAttribute('numFmtId') ?? 0)
    map.set(i++, DATE_FORMATS.has(id) || dateLike(custom.get(id)) ? 'date' : undefined)
  }
  return map
}

function sharedStrings(pkg) {
  if (!pkg.parts.has('xl/sharedStrings.xml')) return []
  return elementsOf(pkg.xml('xl/sharedStrings.xml').documentElement, 'si').map(si => textOf(si))
}

function sheetList(pkg) {
  const wb = pkg.xml('xl/workbook.xml')
  const rels = pkg.relsOf('xl/workbook.xml')
  return childrenOf(firstOf(wb.documentElement, 'sheets') ?? wb.documentElement, 'sheet').map(s => {
    const rel = rels.get(s.getAttribute('r:id'))
    return { name: s.getAttribute('name'), state: s.getAttribute('state') ?? 'visible', part: rel && pkg.targetOf('xl/workbook.xml', rel.target) }
  })
}

const colOf = (ref) => /^([A-Z]+)/.exec(ref)[1]
const rowOf = (ref) => Number(/(\d+)$/.exec(ref)[1])
const colNum = (col) => [...col].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0)

// Serial → unix-day offset: 1899-12-30 (Lotus 1900 compat), or 1904-01-01 when
// the workbook declares <workbookPr date1904="1"/>.
function dateEpoch(pkg) {
  const wb = pkg.parts.has('xl/workbook.xml') ? pkg.xml('xl/workbook.xml') : undefined
  return /^(1|true)$/i.test(firstOf(wb?.documentElement, 'workbookPr')?.getAttribute('date1904') ?? '') ? 24107 : 25569
}

function cellValue(c, shared, fmt, epoch = 25569) {
  const t = c.getAttribute('t'), v = firstOf(c, 'v'), f = firstOf(c, 'f')
  let value = v == null ? undefined : v.textContent
  if (t === 's' && value !== undefined) value = shared[Number(value)] ?? `#SST${value}`
  else if (t === 'b') value = value === '1'
  else if (t === 'str' || t === 'inlineStr') value = t === 'inlineStr' ? textOf(firstOf(c, 'is') ?? c) : value
  else if (t === 'e') value = value // error text as stored
  else if (value !== undefined && fmt.get(Number(c.getAttribute('s') ?? 0)) === 'date' && !Number.isNaN(Number(value))) {
    const days = Number(value) - epoch
    value = new Date(days * 86400_000).toISOString().slice(0, value.includes('.') ? 19 : 10)
  }
  return { value, formula: f?.textContent }
}

/** @returns {object} workbook inventory */
export function xlsxInventory(pkg) {
  const wb = pkg.xml('xl/workbook.xml')
  const names = []
  const dn = firstOf(wb.documentElement, 'definedNames')
  for (const d of childrenOf(dn, 'definedName')) {
    names.push({ name: d.getAttribute('name'), scope: d.getAttribute('localSheetId'), value: d.textContent })
  }
  const sheets = sheetList(pkg).map(s => {
    if (!s.part || !pkg.parts.has(s.part)) return { ...s, missing: true }
    const doc = pkg.xml(s.part)
    const dim = firstOf(doc.documentElement, 'dimension')?.getAttribute('ref')
    const cells = elementsOf(doc.documentElement, 'c')
    const errors = cells.filter(c => c.getAttribute('t') === 'e')
      .map(c => ({ cell: c.getAttribute('r'), value: firstOf(c, 'v')?.textContent, formula: firstOf(c, 'f')?.textContent }))
    const uncached = cells.filter(c => firstOf(c, 'f') && !firstOf(c, 'v')).length
    const tables = pkg.relList(s.part).filter(r => r.type.endsWith('/table')).length
    const charts = pkg.relList(s.part).filter(r => r.type.endsWith('/chart') || r.type.endsWith('/drawing')).length
    return {
      ...s, dimension: dim,
      cells: cells.length, formulas: cells.filter(c => firstOf(c, 'f')).length,
      merged: childrenOf(firstOf(doc.documentElement, 'mergeCells'), 'mergeCell').length,
      tables, drawings: charts,
      errors,
      uncachedFormulas: uncached || undefined,
    }
  })
  return { sheets, definedNames: names }
}

/** @returns {object} a grid of cached values (and formulas) for one sheet/range */
export function xlsxRead(pkg, sheetName, range) {
  const sheet = sheetList(pkg).find(s => s.name === sheetName)
  if (!sheet) { const e = new Error(`no sheet named ${sheetName}`); e.code = 'args'; throw e }
  if (!pkg.parts.has(sheet.part)) { const e = new Error(`sheet part ${sheet.part} missing`); e.code = 'args'; throw e }
  const shared = sharedStrings(pkg)
  const fmt = numFmts(pkg)
  const epoch = dateEpoch(pkg)
  const doc = pkg.xml(sheet.part)
  const inRange = (ref) => {
    if (!range) return true
    const [lo, hi] = range.split(':')
    const [c, r] = [colNum(colOf(ref)), rowOf(ref)]
    return c >= colNum(colOf(lo)) && c <= colNum(colOf(hi ?? lo)) && r >= rowOf(lo) && r <= rowOf(hi ?? lo)
  }
  const rows = []
  for (const row of elementsOf(doc.documentElement, 'row')) {
    const cells = {}
    for (const c of childrenOf(row, 'c')) {
      const ref = c.getAttribute('r')
      if (!inRange(ref)) continue
      const { value, formula } = cellValue(c, shared, fmt, epoch)
      cells[ref] = formula ? { v: value, f: formula } : { v: value }
    }
    if (Object.keys(cells).length > 0) rows.push({ row: Number(row.getAttribute('r')), cells })
  }
  return { sheet: sheetName, range, rows }
}
