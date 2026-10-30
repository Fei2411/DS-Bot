// `check`: find only the defects that make Office refuse a file or show a repair
// prompt (not XSD validation). --against reports only findings absent from an
// original; --fix repairs the set it can repair safely.
import { posix } from 'node:path'
import { parseXml, childrenOf, elementsOf, firstOf } from './xml.js'

const KNOWN_OVERRIDES = {
  'word/document.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'word/styles.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  'word/numbering.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  'word/settings.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  'word/comments.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
  'word/footnotes.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  'word/endnotes.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
  'word/fontTable.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml',
  'xl/workbook.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  'xl/sharedStrings.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  'xl/styles.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  'ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml',
  'docProps/app.xml': 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
}
const patternType = (name) => {
  if (KNOWN_OVERRIDES[name]) return KNOWN_OVERRIDES[name]
  const base = 'application/vnd.openxmlformats-officedocument.'
  if (/^word\/header\d+\.xml$/.test(name)) return base + 'wordprocessingml.header+xml'
  if (/^word\/footer\d+\.xml$/.test(name)) return base + 'wordprocessingml.footer+xml'
  if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) return base + 'presentationml.slide+xml'
  if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name)) return base + 'presentationml.slideLayout+xml'
  if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)) return base + 'presentationml.slideMaster+xml'
  if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)) return base + 'presentationml.notesSlide+xml'
  if (/^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(name)) return base + 'presentationml.notesMaster+xml'
  if (/^ppt\/theme\/theme\d+\.xml$/.test(name)) return base + 'theme+xml'
  if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) return base + 'spreadsheetml.worksheet+xml'
  if (/^xl\/theme\/theme\d+\.xml$/.test(name)) return base + 'theme+xml'
  return undefined
}

/** One finding: a stable `key` (for --against diffing) plus human-readable fields. */
const finding = (rule, part, message) => ({ rule, part, key: `${rule}|${part}|${message}`, message })

/**
 * Run all checks over an opened Package. `original` (another Package) limits the
 * report to findings whose key does not exist there.
 * @returns {object[]} findings
 */
export function checkPackage(pkg, original) {
  const found = runRules(pkg)
  if (!original) return found
  const before = new Set(runRules(original).map(f => f.key))
  return found.filter(f => !before.has(f.key))
}

function runRules(pkg) {
  const out = []
  const xmlDocs = new Map()
  // Every XML part must be well-formed and typed.
  for (const name of pkg.parts.keys()) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue
    try { xmlDocs.set(name, parseXml(pkg.get(name))) }
    catch (error) { out.push(finding('malformed-xml', name, error.message.slice(0, 200))) }
  }
  for (const name of pkg.parts.keys()) {
    if (pkg.contentType(name) === undefined && !name.endsWith('/')) {
      out.push(finding('no-content-type', name, `${name} has no Default or Override`))
    }
  }
  for (const part of pkg.overrides.keys()) {
    if (!pkg.parts.has(part)) out.push(finding('override-absent-part', part, `Override names absent part /${part}`))
  }
  // Relationship integrity: unique ids, internal targets that exist.
  for (const name of [...pkg.parts.keys()].filter(n => n.endsWith('.rels'))) {
    const doc = xmlDocs.get(name)
    if (!doc) continue
    const owner = name === '_rels/.rels' ? '' : posix.dirname(posix.dirname(name)) + '/' + posix.basename(name, '.rels')
    const seen = new Set()
    for (const rel of childrenOf(doc.documentElement, 'Relationship')) {
      const id = rel.getAttribute('Id')
      if (seen.has(id)) out.push(finding('duplicate-rel-id', name, `relationship id ${id} used twice`))
      seen.add(id)
      if ((rel.getAttribute('TargetMode') ?? 'Internal') !== 'External') {
        const target = pkg.targetOf(owner, rel.getAttribute('Target'))
        if (!pkg.parts.has(target)) out.push(finding('dangling-rel', name, `${id} → ${target} is absent`))
      }
    }
  }
  // r:id / r:embed / r:link references must resolve in the same part's rels.
  for (const [name, doc] of xmlDocs) {
    if (name.endsWith('.rels')) continue
    const rels = pkg.relsOf(name)
    for (const el of elementsOf(doc.documentElement)) {
      for (const attr of ['r:id', 'r:embed', 'r:link', 'r:dm', 'r:lo', 'r:qs', 'r:cs']) {
        const value = el.getAttribute?.(attr)
        if (value && !rels.has(value)) out.push(finding('unknown-rel-ref', name, `${el.tagName} ${attr}="${value}" has no relationship`))
      }
    }
  }
  // Parts reached by a known relationship type must carry its content type —
  // an application/xml Default is not a match.
  contentTypeRules(pkg, out)
  // Part-kind rules.
  const isPptx = pkg.parts.has('ppt/presentation.xml'), isDocx = pkg.parts.has('word/document.xml')
  if (isPptx) pptxRules(pkg, xmlDocs, out)
  if (isDocx) docxRules(pkg, xmlDocs, out)
  return out
}

const CT_BASE = 'application/vnd.openxmlformats-officedocument.'
const pkgKind = (pkg) => pkg.parts.has('word/document.xml') ? 'docx' : pkg.parts.has('ppt/presentation.xml') ? 'pptx' : pkg.parts.has('xl/workbook.xml') ? 'xlsx' : undefined
const MAIN_CT = { docx: CT_BASE + 'wordprocessingml.document.main+xml', pptx: CT_BASE + 'presentationml.presentation.main+xml', xlsx: CT_BASE + 'spreadsheetml.sheet.main+xml' }

// Relationship-type suffix → expected content type (or a per-package map).
const REL_TYPE_CT = {
  officeDocument: MAIN_CT,
  document: MAIN_CT,
  styles: { docx: CT_BASE + 'wordprocessingml.styles+xml', xlsx: CT_BASE + 'spreadsheetml.styles+xml' },
  numbering: CT_BASE + 'wordprocessingml.numbering+xml',
  settings: CT_BASE + 'wordprocessingml.settings+xml',
  comments: CT_BASE + 'wordprocessingml.comments+xml',
  footnotes: CT_BASE + 'wordprocessingml.footnotes+xml',
  endnotes: CT_BASE + 'wordprocessingml.endnotes+xml',
  header: CT_BASE + 'wordprocessingml.header+xml',
  footer: CT_BASE + 'wordprocessingml.footer+xml',
  fontTable: CT_BASE + 'wordprocessingml.fontTable+xml',
  theme: CT_BASE + 'theme+xml',
  slide: CT_BASE + 'presentationml.slide+xml',
  slideLayout: CT_BASE + 'presentationml.slideLayout+xml',
  slideMaster: CT_BASE + 'presentationml.slideMaster+xml',
  notesSlide: CT_BASE + 'presentationml.notesSlide+xml',
  notesMaster: CT_BASE + 'presentationml.notesMaster+xml',
  chart: CT_BASE + 'drawingml.chart+xml',
  worksheet: CT_BASE + 'spreadsheetml.worksheet+xml',
  sharedStrings: CT_BASE + 'spreadsheetml.sharedStrings+xml',
  coreProperties: 'application/vnd.openxmlformats-package.core-properties+xml',
  'core-properties': 'application/vnd.openxmlformats-package.core-properties+xml',
  extendedProperties: CT_BASE + 'extended-properties+xml',
  'extended-properties': CT_BASE + 'extended-properties+xml',
}

export function expectedContentType(pkg, relType) {
  const suffix = relType.split('/').pop()
  const rule = REL_TYPE_CT[suffix]
  if (rule === undefined) return undefined
  if (typeof rule === 'string') return rule
  const kind = pkgKind(pkg)
  return kind ? rule[kind] : undefined
}

function contentTypeRules(pkg, out) {
  for (const [owner, map] of pkg.rels) {
    for (const rel of map.values()) {
      if (rel.mode === 'External') continue
      const expected = expectedContentType(pkg, rel.type)
      if (expected === undefined) continue
      const target = pkg.targetOf(owner, rel.target)
      if (!pkg.parts.has(target)) continue
      const actual = pkg.contentType(target)
      if (actual !== expected) {
        out.push(finding('wrong-content-type', target, `${target} is ${actual ?? 'untyped'}, expected ${expected} for ${rel.type.split('/').pop()}`))
      }
    }
  }
}

function uniqueIds(elements, attr, part, rule, out) {
  const seen = new Set()
  for (const el of elements) {
    const id = el.getAttribute(attr)
    if (id !== null && seen.has(id)) out.push(finding(rule, part, `${el.tagName} @${attr}=${id} duplicated`))
    seen.add(id)
  }
}

function pptxRules(pkg, xmlDocs, out) {
  for (const [name, doc] of xmlDocs) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      uniqueIds(elementsOf(doc.documentElement, 'p:cNvPr'), 'id', name, 'duplicate-shape-id', out)
    }
    if (name === 'ppt/presentation.xml') {
      const lst = firstOf(doc.documentElement, 'p:sldIdLst')
      const ids = []
      for (const sld of childrenOf(lst ?? doc.documentElement, 'p:sldId')) {
        const num = Number(sld.getAttribute('id'))
        ids.push(sld.getAttribute('id'))
        if (!Number.isInteger(num) || num < 256) out.push(finding('invalid-slide-id', name, `p:sldId id ${sld.getAttribute('id')} must be an integer ≥ 256`))
        const rid = sld.getAttribute('r:id')
        const rel = pkg.relsOf(name).get(rid)
        if (!rel) { out.push(finding('unknown-rel-ref', name, `p:sldId r:id="${rid}" has no relationship`)); continue }
        const target = pkg.targetOf(name, rel.target)
        if (!/^ppt\/slides\/slide\d+\.xml$/.test(target)) out.push(finding('sldid-not-slide', name, `p:sldId ${rid} → ${target}, not a slide part`))
      }
      const seen = new Set()
      for (const id of ids) { if (seen.has(id)) out.push(finding('duplicate-slide-id', name, `p:sldId id ${id} used twice`)); seen.add(id) }
    }
  }
}

function docxRules(pkg, xmlDocs, out) {
  const main = 'word/document.xml'
  for (const [name, doc] of xmlDocs) {
    if (name !== main && !/^word\/(header|footer)\d+\.xml$|^word\/(footnotes|endnotes|comments)\.xml$/.test(name)) continue
    uniqueIds(elementsOf(doc.documentElement, 'wp:docPr'), 'id', name, 'duplicate-docpr-id', out)
    const paraIds = elementsOf(doc.documentElement, 'w:p').map(p => p.getAttribute('w14:paraId')).filter(Boolean)
    uniqueIds(paraIds.map(id => ({ getAttribute: () => id, tagName: 'w:p' })), null, name, 'duplicate-paraid', out)
    for (const p of elementsOf(doc.documentElement, 'w:p')) {
      const id = p.getAttribute('w14:paraId')
      if (id && parseInt(id, 16) >= 0x80000000) out.push(finding('invalid-paraid', name, `w14:paraId ${id} ≥ 0x80000000`))
    }
    for (const tag of ['w:t', 'w:delText', 'w:instrText']) {
      for (const el of elementsOf(doc.documentElement, tag)) {
        const text = el.textContent
        if (text !== text.trim() && el.getAttribute('xml:space') !== 'preserve') {
          out.push(finding('missing-xml-space', name, `${tag} "${text.slice(0, 30).trim()}…" needs xml:space="preserve"`))
        }
      }
    }
    if (name === main) {
      const comments = xmlDocs.get('word/comments.xml')
      const ids = new Set(comments ? elementsOf(comments.documentElement, 'w:comment').map(c => c.getAttribute('w:id')) : [])
      const refs = elementsOf(doc.documentElement, 'w:commentReference')
        .concat(elementsOf(doc.documentElement, 'w:commentRangeStart'), elementsOf(doc.documentElement, 'w:commentRangeEnd'))
      for (const ref of refs) {
        const id = ref.getAttribute('w:id')
        if (!ids.has(id)) out.push(finding('dangling-comment', name, `${ref.tagName} w:id="${id}" has no w:comment`))
      }
    }
  }
}

// ---- fixes ----


/**
 * Repair every fixable finding in place. Returns the findings that remain.
 * @returns {{ fixed: string[], remaining: object[] }}
 */
export function fixPackage(pkg) {
  const fixed = []
  for (const name of pkg.parts.keys()) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue
    let doc, dirty = false
    try { doc = parseXml(pkg.get(name)) } catch { continue }
    // xml:space on whitespace-boundary text nodes.
    for (const tag of ['w:t', 'w:delText', 'w:instrText']) {
      for (const el of elementsOf(doc.documentElement, tag)) {
        const text = el.textContent
        if (text !== text.trim() && el.getAttribute('xml:space') !== 'preserve') { el.setAttribute('xml:space', 'preserve'); dirty = true }
      }
    }
    for (const tag of ['p:cNvPr', 'wp:docPr']) {
      const seen = new Set()
      for (const el of elementsOf(doc.documentElement, tag)) {
        let id = el.getAttribute('id')
        if (id === null || seen.has(id)) {
          let next = 2
          while (seen.has(String(next)) || hasIdAnywhere(doc, tag, String(next))) next++
          el.setAttribute('id', String(next)); dirty = true
        }
        seen.add(el.getAttribute('id'))
      }
    }
    if (dirty) { pkg.putXml(name, doc); fixed.push(name) }
  }
  // paraId duplicates: renumber in document order to the next unused value
  // below 0x80000000, deterministically.
  const paraIds = new Set()
  for (const name of pkg.parts.keys()) {
    if (!/^word\//.test(name) || !name.endsWith('.xml')) continue
    try { for (const p of elementsOf(parseXml(pkg.get(name)).documentElement, 'w:p')) paraIds.add(p.getAttribute('w14:paraId')) } catch { /* malformed stays */ }
  }
  for (const name of pkg.parts.keys()) {
    if (!/^word\//.test(name) || !name.endsWith('.xml')) continue
    let doc
    try { doc = parseXml(pkg.get(name)) } catch { continue }
    const seen = new Set(); let dirty = false
    for (const p of elementsOf(doc.documentElement, 'w:p')) {
      const id = p.getAttribute('w14:paraId')
      if (!id) continue
      if (seen.has(id) || parseInt(id, 16) >= 0x80000000) {
        let next = 1
        while (paraIds.has(next.toString(16).padStart(8, '0')) || paraIds.has(next.toString(16))) next++
        const fresh = next.toString(16).padStart(8, '0')
        p.setAttribute('w14:paraId', fresh)
        paraIds.add(fresh)
        dirty = true
      }
      seen.add(p.getAttribute('w14:paraId'))
    }
    if (dirty) { pkg.putXml(name, doc); fixed.push(name) }
  }
  // Wrong content types on parts a known relationship type points at.
  for (const [owner, map] of pkg.rels) {
    for (const rel of map.values()) {
      if (rel.mode === 'External') continue
      const expected = expectedContentType(pkg, rel.type)
      if (expected === undefined) continue
      const target = pkg.targetOf(owner, rel.target)
      if (pkg.parts.has(target) && pkg.contentType(target) !== expected) {
        pkg.override(target, expected); fixed.push(target)
      }
    }
  }
  // Content types: drop Overrides for absent parts, add Overrides for known types.
  for (const part of [...pkg.overrides.keys()]) {
    if (!pkg.parts.has(part)) { pkg.overrides.delete(part); fixed.push(`-${part}`) }
  }
  for (const name of pkg.parts.keys()) {
    if (pkg.contentType(name) !== undefined || name.endsWith('/')) continue
    const type = patternType(name)
    if (type) { pkg.override(name, type); fixed.push(`+${name}`) }
  }
  // Dangling internal relationships to absent parts.
  for (const [owner, map] of pkg.rels) {
    for (const [id, rel] of [...map]) {
      if (rel.mode !== 'External' && !pkg.parts.has(pkg.targetOf(owner, rel.target))) { map.delete(id); fixed.push(`${owner || '/'}#${id}`) }
    }
  }
  // Flush so the re-check reads .rels parts reflecting the model, not the
  // bytes the package was opened with.
  pkg.flush()
  return { fixed, remaining: checkPackage(pkg) }
}

function hasIdAnywhere(doc, tag, id) {
  for (const other of ['p:cNvPr', 'wp:docPr']) {
    if (elementsOf(doc.documentElement, other).some(el => el.getAttribute('id') === id)) return true
  }
  return false
}
