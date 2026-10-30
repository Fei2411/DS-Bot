// docx commands: read (block ids, tables, headers/footers, notes, comments,
// tracked changes), fields, and edit (batched ops, all-or-nothing).
import { childrenOf, elementsOf, firstOf, textOf, parseXml } from './xml.js'


const parts = (pkg) => [...pkg.parts.keys()].filter(name =>
  name === 'word/document.xml' || /^word\/(header|footer)\d+\.xml$/.test(name)
  || /^word\/(footnotes|endnotes|comments)\.xml$/.test(name))

// The paragraph/table texts a Bot reads, with tracked changes resolved one way.
function blockText(el, changes = false) {
  let out = ''
  const walk = (node, inside) => {
    if (node.nodeType === 3 || node.nodeType === 4) { if (!inside.del) out += node.data; return }
    if (node.nodeType !== 1) return
    const tag = node.tagName
    if (!changes) {
      for (const child of [...node.childNodes]) {
        if (tag === 'w:del' || tag === 'w:moveFrom') continue
        walk(child, inside)
      }
      return
    }
    let mark = inside
    let pre = '', post = ''
    const author = node.getAttribute?.('w:author') ?? ''
    if (tag === 'w:ins') { pre = `{+`; post = ` (${author})+}`; mark = { ...inside, del: false } }
    else if (tag === 'w:del') { pre = `{-`; post = ` (${author})-}`; mark = { ...inside, del: false } }
    else if (tag === 'w:moveFrom') { pre = `{<`; post = ` (${author})<}`; mark = { ...inside, del: false } }
    else if (tag === 'w:moveTo') { pre = `{>`; post = ` (${author})>}`; mark = { ...inside, del: false } }
    else if (tag === 'w:rPrChange' || tag === 'w:pPrChange') { out += '{~fmt~}'; return }
    else if (tag === 'w:moveFromRangeStart') { out += `{<move ${node.getAttribute('w:name') ?? ''}>`; return }
    else if (tag === 'w:moveToRangeStart') { out += `{>move ${node.getAttribute('w:name') ?? ''}>`; return }
    else if (tag === 'w:moveFromRangeEnd' || tag === 'w:moveToRangeEnd') { out += '{end}'; return }
    out += pre
    for (const child of [...node.childNodes]) walk(child, mark)
    out += post
  }
  walk(el, { del: false })
  return out
}

function paraStyle(p) { return firstOf(firstOf(p, 'w:pPr') ?? p, 'w:pStyle')?.getAttribute('w:val') }

function deletedParaMark(p) {
  const pPr = firstOf(p, 'w:pPr')
  return pPr !== undefined && firstOf(firstOf(pPr, 'w:rPr') ?? pPr, 'w:del') !== undefined
}

/** @returns {object[]} body blocks in reading order: pN paragraphs, tN tables */
export function docxRead(pkg, { changes = false } = {}) {
  const doc = pkg.xml('word/document.xml')
  const body = firstOf(doc.documentElement, 'w:body')
  const blocks = []
  let pi = 0, ti = 0
  const commentIds = commentsIndex(pkg, doc)
  for (const el of childrenOf(body)) {
    if (el.tagName === 'w:p') {
      pi++
      const id = `p${pi}`
      const entry = { id, type: 'paragraph', style: paraStyle(el), text: blockText(el, changes) }
      const anchored = commentIds.get(el)
      if (anchored) entry.comments = anchored
      if (deletedParaMark(el)) entry.deletedParagraphMark = true
      blocks.push(entry)
    } else if (el.tagName === 'w:tbl') {
      ti++
      blocks.push({ id: `t${ti}`, type: 'table', rows: tableRows(el, changes) })
    }
  }
  // headers/footers per section, footnotes, endnotes, comments.
  const sections = []
  const refs = elementsOf(doc.documentElement, 'w:headerReference').concat(elementsOf(doc.documentElement, 'w:footerReference'))
  const rels = pkg.relsOf('word/document.xml')
  for (const ref of refs) {
    const rel = rels.get(ref.getAttribute('r:id'))
    if (!rel) continue
    const target = pkg.targetOf('word/document.xml', rel.target)
    const part = pkg.xml(target)
    sections.push({
      kind: ref.tagName === 'w:headerReference' ? 'header' : 'footer',
      type: ref.getAttribute('w:type'), part: target,
      text: elementsOf(part.documentElement, 'w:p').map(p => blockText(p, changes)).filter(Boolean).join('\n'),
    })
  }
  const notes = []
  for (const [kind, part] of [['footnote', 'word/footnotes.xml'], ['endnote', 'word/endnotes.xml']]) {
    if (!pkg.parts.has(part)) continue
    for (const note of elementsOf(pkg.xml(part).documentElement, `w:${kind}`)) {
      const id = note.getAttribute('w:id')
      if (id === '-1' || id === '0') continue
      notes.push({ kind, id, text: elementsOf(note, 'w:p').map(p => blockText(p, changes)).join(' ') })
    }
  }
  return { blocks, sections, notes, comments: commentsList(pkg, changes) }
}

// pN ids number only the body's top-level paragraphs — the same ids docxRead
// gives. `doc` must be the parse the blocks come from: element keys from a
// second parse never match.
function commentsIndex(pkg, doc) {
  const byEl = new Map()
  if (!pkg.parts.has('word/comments.xml')) return byEl
  for (const ref of elementsOf(doc.documentElement, 'w:commentReference')) {
    let p = ref.parentNode
    while (p && p.tagName !== 'w:p') p = p.parentNode
    if (!p) continue
    const arr = byEl.get(p) ?? []
    arr.push({ commentId: ref.getAttribute('w:id') })
    byEl.set(p, arr)
  }
  return byEl
}

function commentsList(pkg, changes) {
  if (!pkg.parts.has('word/comments.xml')) return []
  const commentsDoc = pkg.xml('word/comments.xml')
  const anchors = commentAnchors(pkg)
  return elementsOf(commentsDoc.documentElement, 'w:comment').map(c => ({
    id: c.getAttribute('w:id'), author: c.getAttribute('w:author'), initials: c.getAttribute('w:initials'),
    date: c.getAttribute('w:date'), text: elementsOf(c, 'w:p').map(p => blockText(p, changes)).join(' '),
    anchorsTo: anchors.get(c.getAttribute('w:id')),
  }))
}

function commentAnchors(pkg) {
  const map = new Map()
  const doc = pkg.xml('word/document.xml')
  const index = blockIndex(doc)
  const byEl = new Map([...index].map(([id, el]) => [el, id]))
  for (const ref of elementsOf(doc.documentElement, 'w:commentReference')) {
    let p = ref.parentNode
    while (p && p.tagName !== 'w:p') p = p.parentNode
    if (p && byEl.has(p)) map.set(ref.getAttribute('w:id'), byEl.get(p))
  }
  return map
}

function tableRows(tbl, changes) {
  return childrenOf(tbl, 'w:tr').map(tr =>
    childrenOf(tr, 'w:tc').map(tc => {
      const gridSpan = firstOf(firstOf(tc, 'w:tcPr') ?? tc, 'w:gridSpan')?.getAttribute('w:val')
      const vMerge = firstOf(firstOf(tc, 'w:tcPr') ?? tc, 'w:vMerge')
      return {
        text: elementsOf(tc, 'w:p').map(p => blockText(p, changes)).join(' '),
        ...(gridSpan ? { gridSpan: Number(gridSpan) } : {}),
        ...(vMerge ? { vMerge: vMerge.getAttribute('w:val') ?? 'continue' } : {}),
      }
    }))
}

/** @returns {object[]} simple + complex fields with instruction and cached result */
export function docxFields(pkg) {
  const out = []
  for (const name of parts(pkg)) {
    const doc = pkg.xml(name)
    for (const fld of elementsOf(doc.documentElement, 'w:fldSimple')) {
      out.push({ part: name, kind: 'simple', instruction: fld.getAttribute('w:instr') ?? '', result: textOf(fld) })
    }
    // Complex fields: instrText between fldChar begin and separate, result till end.
    const paras = elementsOf(doc.documentElement, 'w:p')
    let open = null
    const flush = () => { if (open) { delete open.phase; out.push(open) } open = null }
    for (const p of paras) {
      for (const el of elementsOf(p)) {
        if (el.tagName === 'w:fldChar') {
          const type = el.getAttribute('w:fldCharType')
          if (type === 'begin') { flush(); open = { part: name, kind: 'complex', instruction: '', result: '' } }
          else if (type === 'separate' && open) open.phase = 'result'
          else if (type === 'end') flush()
        } else if (open && el.tagName === 'w:instrText' && open.phase !== 'result') open.instruction += el.textContent
        else if (open && open.phase === 'result' && (el.tagName === 'w:t' || el.tagName === 'w:delText')) open.result += el.textContent
      }
    }
    flush()
  }
  return out
}

// ---- edit ops ----

const EDIT_PARTS = (pkg, bodyOnly) => parts(pkg).filter(name =>
  name === 'word/document.xml' || (!bodyOnly && /^word\/(header|footer)\d+\.xml$|^word\/(footnotes|endnotes)\.xml$/.test(name)))

/** Map pN/tN ids to elements exactly as docxRead numbers them. */
export function blockIndex(doc) {
  const body = firstOf(doc.documentElement, 'w:body')
  const map = new Map()
  let pi = 0, ti = 0
  for (const el of childrenOf(body)) {
    if (el.tagName === 'w:p') map.set(`p${++pi}`, el)
    else if (el.tagName === 'w:tbl') map.set(`t${++ti}`, el)
  }
  return map
}

function isDeleted(p, r) {
  for (let n = r; n && n !== p; n = n.parentNode) if (n.tagName === 'w:del' || n.tagName === 'w:moveFrom') return true
  return false
}



/**
 * Apply an array of ops to every docx part they reach. All-or-nothing: callers
 * hold the saved copy until every op reports success.
 * @returns {{ changed: string[], count: number }}
 */
export function docxEdit(pkg, ops) {
  const docs = new Map()
  const getDoc = (name) => {
    if (!docs.has(name)) docs.set(name, pkg.xml(name))
    return docs.get(name)
  }
  // All ids in a batch refer to the document the caller read, before any edits.
  const body = firstOf(getDoc('word/document.xml').documentElement, 'w:body')
  const blocks = blockIndex(getDoc('word/document.xml'))
  const blockOf = (id) => {
    const block = blocks.get(id)
    if (!block || block.parentNode !== body) throw new Error(`no block ${id}`)
    return block
  }
  const changed = new Set()
  let count = 0
  ops.forEach((op, index) => {
    try { applyOp(pkg, getDoc, blockOf, changed, op); count++ }
    catch (error) { const e = new Error(`op ${index} (${opKind(op)}): ${error.message}`); e.code = 'ops'; throw e }
  })
  for (const [name, doc] of docs) if (changed.has(name)) pkg.putXml(name, doc)
  return { changed: [...changed], count }
}

const opKind = (op) => Object.keys(op).find(k => !['o', 'inPlace'].includes(k)) ?? '?'

function applyOp(pkg, getDoc, blockOf, changed, op) {
  const mainDoc = () => getDoc('word/document.xml')
  if (op.replace) {
    const { find, with: withText, regex = false, bodyOnly = false } = op.replace
    const re = regex ? new RegExp(find, 'g') : new RegExp(escapeRe(find), 'g')
    for (const name of EDIT_PARTS(pkg, bodyOnly)) {
      const doc = getDoc(name)
      const n = replaceInDoc(doc, re, withText)
      if (n > 0) changed.add(name)
    }
    return
  }
  if (op.set_cell) {
    const { table, row, col, text } = op.set_cell
    const tbl = blockOf(`t${table}`)
    const tr = childrenOf(tbl, 'w:tr')[row - 1]
    const tc = tr && childrenOf(tr, 'w:tc')[col - 1]
    if (!tc) throw new Error(`no cell r${row}c${col} in t${table}`)
    setCellText(getDoc('word/document.xml'), tc, String(text))
    changed.add('word/document.xml')
    return
  }
  if (op.set_field) {
    const { match, value } = op.set_field
    const re = new RegExp(match)
    let any = false
    for (const name of EDIT_PARTS(pkg, false)) {
      const doc = getDoc(name)
      let hit = false
      for (const fld of elementsOf(doc.documentElement, 'w:fldSimple')) {
        if (re.test(fld.getAttribute('w:instr') ?? '')) { setFieldResult(doc, fld, String(value)); hit = true }
      }
      if (setComplexFieldResult(doc, re, String(value))) hit = true
      if (hit) { changed.add(name); any = true }
    }
    if (!any) throw new Error(`no field instruction matches /${match}/`)
    return
  }
  if (op.insert) {
    const { after, before, text, style, like } = op.insert
    const doc = mainDoc()
    const anchor = blockOf(after ?? before)
    const p = doc.createElement('w:p')
    if (style || like) {
      const pPr = doc.createElement('w:pPr')
      const pStyle = doc.createElement('w:pStyle')
      pStyle.setAttribute('w:val', style ?? paraStyle(blockOf(like)) ?? 'Normal')
      pPr.appendChild(pStyle); p.appendChild(pPr)
    }
    const r = doc.createElement('w:r')
    const t = doc.createElement('w:t'); t.setAttribute('xml:space', 'preserve')
    t.appendChild(doc.createTextNode(text))
    r.appendChild(t); p.appendChild(r)
    anchor.parentNode.insertBefore(p, before ? anchor : anchor.nextSibling)
    changed.add('word/document.xml')
    return
  }
  if (op.delete) {
    for (const id of op.delete.paragraphs) {
      const el = blockOf(id)
      el.parentNode.removeChild(el)
    }
    changed.add('word/document.xml')
    return
  }
  if (op.comment) {
    addComment(pkg, getDoc, blockOf, changed, op.comment)
    return
  }
  if (op.accept_changes || op.reject_changes) {
    const accept = Boolean(op.accept_changes)
    for (const name of parts(pkg)) {
      if (!pkg.parts.has(name)) continue
      const doc = getDoc(name)
      if (resolveChanges(doc, accept)) changed.add(name)
    }
    return
  }
  throw new Error(`unknown op ${JSON.stringify(op)}`)
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// Replacement text with $1..$9 group, $& match and $$ escapes resolved — the
// pattern is not re-run, so anchors and lookarounds cannot be lost.
const expand = (m, withText) =>
  withText.replace(/\$(\$|&|[1-9]\d?)/g, (_, g) => g === '$' ? '$' : g === '&' ? m[0] : (m[Number(g)] ?? ''))

const nearestPara = (el) => { for (let n = el.parentNode; n; n = n.parentNode) if (n.tagName === 'w:p') return n; return null }

// A new run holding `text`, with `src`'s w:rPr cloned so formatting survives.
const cloneRun = (doc, src, text) => {
  const clone = src.cloneNode(false)
  const rPr = childrenOf(src, 'w:rPr')[0]
  if (rPr) clone.appendChild(rPr.cloneNode(true))
  const t = doc.createElement('w:t'); t.setAttribute('xml:space', 'preserve')
  t.appendChild(doc.createTextNode(text)); clone.appendChild(t)
  return clone
}

// Replace text across runs inside one document; deletions skipped; formatting
// of the match-start run kept. Each affected run is rebuilt once from its
// original text and every match that touches it, so several matches in one
// run, adjacent matches and spanning matches all compose. Returns the count.
function replaceInDoc(doc, re, withText) {
  let total = 0
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  for (const p of elementsOf(doc.documentElement, 'w:p')) {
    const runs = elementsOf(p, 'w:r').filter(r => !isDeleted(p, r) && nearestPara(r) === p)
    const texts = runs.map(r => elementsOf(r, 'w:t').map(t => t.textContent).join(''))
    const joined = texts.join('')
    const matches = [...joined.matchAll(global)]
    if (matches.length === 0) continue
    if (runs.length === 0) {
      const run = doc.createElement('w:r')
      run.appendChild(doc.createElement('w:t'))
      p.appendChild(run)
      runs.push(run)
      texts.push('')
    }
    const bounds = []
    let cursor = 0
    for (const t of texts) { bounds.push([cursor, cursor + t.length]); cursor += t.length }
    for (let i = 0; i < runs.length; i++) {
      const [rs, rend] = bounds[i]
      // The final run also owns the paragraph's end, including a zero-width match.
      const startsHere = m => m.index >= rs && (m.index < rend || (i === runs.length - 1 && m.index === rend))
      const covers = matches.filter(m => startsHere(m) || (m.index < rend && m.index + m[0].length > rs))
      if (covers.length === 0) continue
      // Pieces in order: kept text fragments alternating with replacement runs
      // (a run emits a replacement only for matches starting inside it).
      const pieces = []
      let pos = 0
      for (const m of covers) {
        const cs = Math.max(0, m.index - rs)
        const ce = Math.min(texts[i].length, m.index + m[0].length - rs)
        if (cs > pos) pieces.push({ text: texts[i].slice(pos, cs) })
        if (startsHere(m)) pieces.push({ repl: expand(m, withText) })
        pos = ce
      }
      if (pos < texts[i].length || pieces.length === 0) pieces.push({ text: texts[i].slice(pos) })
      const run = runs[i]
      let anchor = run
      for (const [k, piece] of pieces.entries()) {
        if (k === 0) {
          setRunText(run, piece.text ?? '')
          if (piece.text !== undefined) continue
        }
        const clone = cloneRun(doc, run, piece.repl ?? piece.text)
        anchor.parentNode.insertBefore(clone, anchor.nextSibling)
        anchor = clone
      }
      total += covers.filter(startsHere).length
    }
  }
  return total
}


function setRunText(run, text) {
  const ts = elementsOf(run, 'w:t')
  if (ts.length === 0) return
  ts[0].textContent = text
  if (text !== text.trim()) ts[0].setAttribute('xml:space', 'preserve')
  for (const extra of ts.slice(1)) extra.textContent = ''
}

function setCellText(doc, tc, text) {
  // w:tcPr stays; the first paragraph's pPr and the first run's rPr carry over.
  const paras = childrenOf(tc, 'w:p')
  const pPr = paras[0] && childrenOf(paras[0], 'w:pPr')[0]
  const firstRun = paras[0] && elementsOf(paras[0], 'w:r')[0]
  const rPr = firstRun && childrenOf(firstRun, 'w:rPr')[0]
  for (const p of paras) tc.removeChild(p)
  const p = doc.createElement('w:p')
  if (pPr) p.appendChild(pPr)
  const r = doc.createElement('w:r')
  if (rPr) r.appendChild(rPr)
  const t = doc.createElement('w:t'); t.setAttribute('xml:space', 'preserve')
  t.appendChild(doc.createTextNode(text))
  r.appendChild(t); p.appendChild(r); tc.appendChild(p)
}

function setFieldResult(doc, fld, value) {
  // One run with the value, carrying the first run's rPr.
  const rPr = elementsOf(fld, 'w:r')[0] && childrenOf(elementsOf(fld, 'w:r')[0], 'w:rPr')[0]
  for (const child of [...fld.childNodes]) fld.removeChild(child)
  const r = doc.createElement('w:r')
  if (rPr) r.appendChild(rPr.cloneNode(true))
  const t = doc.createElement('w:t'); t.setAttribute('xml:space', 'preserve')
  t.appendChild(doc.createTextNode(value))
  r.appendChild(t); fld.appendChild(r)
}

// Complex fields can nest and span paragraphs: track begin/end depth, and in
// the result span (after the depth-1 separate, before the matching end) give
// the first run the value and clear the rest.
function setComplexFieldResult(doc, re, value) {
  let hit = false
  let depth = 0, inField = false, inResult = false, first = true
  for (const el of elementsOf(doc.documentElement)) {
    if (el.tagName === 'w:instrText') {
      if (!inField && re.test(el.textContent)) { inField = true; depth = 1; inResult = false; first = true }
      continue
    }
    if (!inField) continue
    if (el.tagName === 'w:fldChar') {
      const type = el.getAttribute('w:fldCharType')
      if (type === 'begin') depth++
      else if (type === 'end') { depth--; if (depth === 0) inField = false }
      else if (type === 'separate' && depth === 1) inResult = true
      continue
    }
    if (inResult && el.tagName === 'w:r') {
      if (first) { setRunText(el, value); first = false }
      else setRunText(el, '')
      hit = true
    }
  }
  return hit
}

const ancestor = (node, tag) => { for (let n = node.parentNode; n; n = n.parentNode) if (n.tagName === tag) return n; return null }

// Split `run` at `offset`: the original keeps the first half, a clone with its
// rPr takes the rest right after it. Returns the clone.
function splitRunAt(doc, run, offset) {
  const text = elementsOf(run, 'w:t').map(t => t.textContent).join('')
  const clone = cloneRun(doc, run, text.slice(offset))
  setRunText(run, text.slice(0, offset))
  run.parentNode.insertBefore(clone, run.nextSibling)
  return clone
}

// The run sequence covering `anchor` inside `p`, split at its exact edges.
// Returns { firstRun, lastRun } or undefined when the phrase is not there.
function phraseRuns(doc, p, anchor) {
  const runs = elementsOf(p, 'w:r').filter(r => !isDeleted(p, r) && nearestPara(r) === p)
  const texts = runs.map(r => elementsOf(r, 'w:t').map(t => t.textContent).join(''))
  const joined = texts.join('')
  const start = joined.indexOf(anchor)
  if (start < 0) return undefined
  const end = start + anchor.length
  const locate = (pos) => {
    let c = 0
    for (let i = 0; i < runs.length; i++) {
      const e = c + texts[i].length
      if (pos < e || (pos === e && i === runs.length - 1)) return { i, off: pos - c }
      c = e
    }
    return { i: runs.length - 1, off: texts.at(-1).length }
  }
  const e = locate(end), s = locate(start)
  let lastRun, firstRun
  if (e.off === texts[e.i].length) lastRun = runs[e.i]
  else if (e.off === 0) lastRun = runs[e.i - 1]
  else { splitRunAt(doc, runs[e.i], e.off); lastRun = runs[e.i] }
  if (s.i === e.i && s.off > 0) {
    // The phrase lives in the clone the start split creates, not the prefix run.
    firstRun = lastRun = splitRunAt(doc, runs[s.i], s.off)
  } else {
    firstRun = s.off === 0 ? runs[s.i] : splitRunAt(doc, runs[s.i], s.off)
  }
  return { firstRun, lastRun }
}

function addComment(pkg, getDoc, blockOf, changed, { paragraph, text, anchor, author = 'Bot', initials = 'B' }) {
  const doc = getDoc('word/document.xml')
  const p = blockOf(paragraph)
  // comments.xml + its rel + content type are created when missing.
  let commentsDoc
  if (!pkg.parts.has('word/comments.xml')) {
    commentsDoc = parseXml('<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>')
    pkg.rels.set('word/document.xml', pkg.relsOf('word/document.xml'))
    let next = 1
    const map = pkg.rels.get('word/document.xml')
    while (map.has(`rId${next}`)) next++
    map.set(`rId${next}`, { id: `rId${next}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments', target: 'comments.xml', mode: 'Internal' })
    pkg.override('word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml')
  } else commentsDoc = getDoc('word/comments.xml')
  const id = String(Math.max(0, ...elementsOf(commentsDoc.documentElement, 'w:comment').map(c => Number(c.getAttribute('w:id')) || 0)) + 1)
  const comment = commentsDoc.createElement('w:comment')
  comment.setAttribute('w:id', id); comment.setAttribute('w:author', author); comment.setAttribute('w:initials', initials)
  const cp = commentsDoc.createElement('w:p'); const cr = commentsDoc.createElement('w:r')
  const ct = commentsDoc.createElement('w:t'); ct.setAttribute('xml:space', 'preserve')
  ct.appendChild(commentsDoc.createTextNode(text)); cr.appendChild(ct); cp.appendChild(cr); comment.appendChild(cp)
  commentsDoc.documentElement.appendChild(comment)
  pkg.putXml('word/comments.xml', commentsDoc)
  const rangeStart = doc.createElement('w:commentRangeStart'); rangeStart.setAttribute('w:id', id)
  const rangeEnd = doc.createElement('w:commentRangeEnd'); rangeEnd.setAttribute('w:id', id)
  const ref = doc.createElement('w:r')
  const refEl = doc.createElement('w:commentReference'); refEl.setAttribute('w:id', id)
  ref.appendChild(refEl)
  // Range markers sit between runs, never before the paragraph's w:pPr.
  const pPr = childrenOf(p, 'w:pPr')[0]
  if (anchor) {
    const span = phraseRuns(doc, p, anchor)
    if (!span) throw new Error(`anchor "${anchor}" not found in ${paragraph}`)
    // The phrase can sit inside a w:hyperlink — insert beside the run itself.
    span.firstRun.parentNode.insertBefore(rangeStart, span.firstRun)
    span.lastRun.parentNode.insertBefore(rangeEnd, span.lastRun.nextSibling)
    span.lastRun.parentNode.insertBefore(ref, rangeEnd.nextSibling)
  } else {
    p.insertBefore(rangeStart, pPr ? pPr.nextSibling : p.firstChild)
    p.appendChild(rangeEnd)
    p.appendChild(ref)
  }
  changed.add('word/document.xml')
}

// accept/reject tracked changes across one document part.
export function resolveChanges(doc, accept) {
  let dirty = false
  const lift = (el) => { while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el); el.parentNode.removeChild(el) }
  // Paragraph and row marks first: they restructure the tree, so the generic
  // ins/del pass must not see them. Merging moves this paragraph's content
  // children (all but w:pPr), in order, into the next paragraph after its w:pPr
  // — the merged paragraph keeps the next paragraph's mark and properties.
  const mergeIntoNext = (p, pPr) => {
    const next = p.nextSibling
    if (!next || next.tagName !== 'w:p') return false
    const nextPPr = childrenOf(next, 'w:pPr')[0]
    const anchor = nextPPr ? nextPPr.nextSibling : next.firstChild
    for (const node of [...p.childNodes]) {
      if (node === pPr) continue
      next.insertBefore(node, anchor)
    }
    p.parentNode.removeChild(p)
    return true
  }
  for (const p of elementsOf(doc.documentElement, 'w:p')) {
    const pPr = childrenOf(p, 'w:pPr')[0]
    const rPr = pPr && childrenOf(pPr, 'w:rPr')[0]
    if (!rPr) continue
    const del = childrenOf(rPr, 'w:del')[0]
    const ins = childrenOf(rPr, 'w:ins')[0]
    if (del) { dirty = true; if (!accept || !mergeIntoNext(p, pPr)) rPr.removeChild(del) }
    else if (ins) { dirty = true; if (accept || !mergeIntoNext(p, pPr)) rPr.removeChild(ins) }
  }
  for (const tr of elementsOf(doc.documentElement, 'w:tr')) {
    const trPr = childrenOf(tr, 'w:trPr')[0]
    if (!trPr) continue
    const ins = childrenOf(trPr, 'w:ins')[0]
    const del = childrenOf(trPr, 'w:del')[0]
    if (ins) { dirty = true; if (accept) trPr.removeChild(ins); else tr.parentNode.removeChild(tr) }
    else if (del) { dirty = true; if (accept) tr.parentNode.removeChild(tr); else trPr.removeChild(del) }
  }
  // Range markers next so wrappers see clean ranges.
  for (const el of elementsOf(doc.documentElement)) {
    const tag = el.tagName
    if (tag === 'w:moveFromRangeStart' || tag === 'w:moveFromRangeEnd' || tag === 'w:moveToRangeStart' || tag === 'w:moveToRangeEnd'
      || tag === 'w:customXmlInsRangeStart' || tag === 'w:customXmlInsRangeEnd'
      || tag === 'w:customXmlDelRangeStart' || tag === 'w:customXmlDelRangeEnd'
      || tag === 'w:customXmlMoveFromRangeStart' || tag === 'w:customXmlMoveFromRangeEnd'
      || tag === 'w:customXmlMoveToRangeStart' || tag === 'w:customXmlMoveToRangeEnd') {
      el.parentNode?.removeChild(el); dirty = true
    }
  }
  for (const el of elementsOf(doc.documentElement)) {
    const tag = el.tagName
    if (tag === 'w:ins' || tag === 'w:moveTo') {
      if (accept) lift(el)
      else el.parentNode.removeChild(el)
      dirty = true
    }
    else if (tag === 'w:del' || tag === 'w:moveFrom') {
      if (accept) { el.parentNode.removeChild(el); dirty = true }
      else {
        // w:delText → w:t restores the deleted text.
        for (const t of elementsOf(el, 'w:delText')) { t.tagName = 'w:t' }
        lift(el); dirty = true
      }
    } else if (tag === 'w:numberingChange') {
      el.parentNode.removeChild(el); dirty = true
    } else if (/^w:(pPrChange|rPrChange|tblPrChange|tcPrChange|trPrChange|sectPrChange)$/.test(tag)) {
      const parent = el.parentNode
      if (accept) { parent.removeChild(el); dirty = true }
      else {
        // Restore the stored old properties: the parent keeps the parts the
        // stored copy never holds (a pPr's mark rPr and sectPr; a sectPr's
        // header/footer references) and takes the rest from the stored copy.
        const stored = childrenOf(el)[0]
        const keep = new Set()
        if (parent.tagName === 'w:pPr') { keep.add('w:rPr'); keep.add('w:sectPr') }
        if (parent.tagName === 'w:sectPr') { keep.add('w:headerReference'); keep.add('w:footerReference') }
        for (const c of [...parent.childNodes]) if (!keep.has(c.tagName) && c !== el) parent.removeChild(c)
        if (stored) {
          // pPr keeps its mark rPr/sectPr at the end; a sectPr's header/footer
          // references come first, so restored children go after them (the
          // change element is removed anyway).
          const kept = [...parent.childNodes].filter(c => keep.has(c.tagName))
          const anchor = parent.tagName === 'w:sectPr'
            ? (kept.length > 0 ? kept.at(-1).nextSibling : parent.firstChild === el ? null : parent.firstChild)
            : (kept[0] ?? el)
          for (const s of [...stored.childNodes]) parent.insertBefore(s, anchor)
        }
        parent.removeChild(el)
        dirty = true
      }
    } else if (tag === 'w:cellIns' || tag === 'w:cellDel') {
      const tc = ancestor(el, 'w:tc')
      if (tc) {
        if (accept && tag === 'w:cellDel') tc.parentNode?.removeChild(tc)
        else if (!accept && tag === 'w:cellIns') tc.parentNode?.removeChild(tc)
        el.parentNode.removeChild(el); dirty = true
      }
    }
  }
  return dirty
}
