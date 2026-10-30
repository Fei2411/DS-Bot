// pptx commands: inventory (slide size, theme fonts, per-slide shapes with
// resolved boxes incl. group transforms and layout/master placeholder
// inheritance), layout (overlaps and off-slide findings, --autofit), slides
// (reorder/duplicate/remove), clean (unreachable parts and dangling refs).
import { posix } from 'node:path'
import { childrenOf, elementsOf, firstOf, textOf } from './xml.js'
import { checkPackage } from './check.js'

const EMU = 914400
const SLIDE_RE = /^ppt\/slides\/slide\d+\.xml$/

const slideParts = (pkg) => [...pkg.parts.keys()].filter(n => SLIDE_RE.test(n))
const deckOrder = (pkg) => {
  const pres = pkg.xml('ppt/presentation.xml')
  const lst = firstOf(pres.documentElement, 'p:sldIdLst')
  const rels = pkg.relsOf('ppt/presentation.xml')
  return childrenOf(lst ?? pres.documentElement, 'p:sldId').map(s => {
    const rel = rels.get(s.getAttribute('r:id'))
    return { sldId: s.getAttribute('id'), rid: s.getAttribute('r:id'), part: rel && pkg.targetOf('ppt/presentation.xml', rel.target) }
  }).filter(e => e.part)
}
const slideSize = (pkg) => {
  const sz = firstOf(pkg.xml('ppt/presentation.xml').documentElement, 'p:sldSz')
  return { cx: Number(sz?.getAttribute('cx') ?? 0) / EMU, cy: Number(sz?.getAttribute('cy') ?? 0) / EMU }
}
const themeFonts = (pkg) => {
  const theme = [...pkg.parts.keys()].find(n => /^ppt\/theme\/theme\d+\.xml$/.test(n))
  if (!theme) return {}
  const doc = pkg.xml(theme)
  const get = (tag) => elementsOf(doc.documentElement, tag).map(e => firstOf(e, 'a:latin')?.getAttribute('typeface')).find(Boolean)
  return { major: get('a:majorFont'), minor: get('a:minorFont') }
}

function relTarget(pkg, owner, el, attr = 'r:id') {
  const rel = pkg.relsOf(owner).get(el?.getAttribute(attr))
  return rel && pkg.targetOf(owner, rel.target)
}
const relatedPart = (pkg, owner, tags) => {
  for (const rel of pkg.relList(owner)) if (tags.some(t => rel.type.endsWith(`/${t}`))) return pkg.targetOf(owner, rel.target)
  return undefined
}

// nvPr / xfrm / txBody are direct children of their shape — descendant lookups
// would find a nested shape's inside a group.
const child = (el, tag) => childrenOf(el, tag)[0]
const nvPrOf = (sp) => child(child(sp, 'p:nvSpPr') ?? child(sp, 'p:nvPicPr') ?? child(sp, 'p:nvGrpSpPr')
  ?? child(sp, 'p:nvCxnSpPr') ?? child(sp, 'p:nvGraphicFramePr') ?? sp, 'p:nvPr')

function phOf(sp) {
  const ph = child(nvPrOf(sp) ?? sp, 'p:ph')
  return ph ? { type: ph.getAttribute('type') ?? 'body', idx: ph.getAttribute('idx') } : undefined
}
const shapeName = (sp) => child(child(sp, 'p:nvSpPr') ?? child(sp, 'p:nvPicPr') ?? child(sp, 'p:nvGrpSpPr')
  ?? child(sp, 'p:nvCxnSpPr') ?? child(sp, 'p:nvGraphicFramePr') ?? sp, 'p:cNvPr')?.getAttribute('name')
const shapeId = (sp) => child(child(sp, 'p:nvSpPr') ?? child(sp, 'p:nvPicPr') ?? child(sp, 'p:nvGrpSpPr')
  ?? child(sp, 'p:nvCxnSpPr') ?? child(sp, 'p:nvGraphicFramePr') ?? sp, 'p:cNvPr')?.getAttribute('id')

const xfrmOf = (sp) => child(child(sp, 'p:spPr') ?? sp, 'a:xfrm')
const off = (xfrm) => ({ x: Number(firstOf(xfrm, 'a:off')?.getAttribute('x') ?? 0), y: Number(firstOf(xfrm, 'a:off')?.getAttribute('y') ?? 0) })
const ext = (xfrm) => ({ cx: Number(firstOf(xfrm, 'a:ext')?.getAttribute('cx') ?? 0), cy: Number(firstOf(xfrm, 'a:ext')?.getAttribute('cy') ?? 0) })

// Child box inside a group: scaled from the group's chOff/chExt space into off/ext.
function applyGroup(box, grpSp) {
  const g = child(child(grpSp, 'p:grpSpPr') ?? grpSp, 'a:xfrm')
  if (!g) return box
  const o = off(g), e = ext(g)
  const co = firstOf(g, 'a:chOff'), ce = firstOf(g, 'a:chExt')
  const sx = e.cx / Number(ce?.getAttribute('cx') || e.cx || 1)
  const sy = e.cy / Number(ce?.getAttribute('cy') || e.cy || 1)
  const cx0 = Number(co?.getAttribute('x') ?? 0), cy0 = Number(co?.getAttribute('y') ?? 0)
  return { x: o.x + (box.x - cx0) * sx, y: o.y + (box.y - cy0) * sy, cx: box.cx * sx, cy: box.cy * sy }
}

function shapeBox(pkg, sp, layoutDoc, masterDoc, groupChain = []) {
  const xfrm = xfrmOf(sp)
  let box
  if (xfrm && (firstOf(xfrm, 'a:off') || firstOf(xfrm, 'a:ext'))) {
    const o = off(xfrm), e = ext(xfrm)
    box = { x: o.x, y: o.y, cx: e.cx, cy: e.cy }
  } else {
    // Inherit from the matching placeholder in the slide layout, then master.
    const ph = phOf(sp)
    box = undefined
    if (ph) {
      for (const doc of [layoutDoc, masterDoc]) {
        if (!doc) continue
        const match = elementsOf(doc.documentElement).find(c =>
          (c.tagName === 'p:sp' || c.tagName === 'p:pic') && phMatch(phOf(c), ph))
        const inh = match && xfrmOf(match)
        if (inh) { box = { ...off(inh), ...ext(inh) }; box = { x: box.x, y: box.y, cx: box.cx, cy: box.cy }; break }
      }
    }
    if (!box) return undefined
  }
  for (const grp of groupChain) box = applyGroup(box, grp)
  return box
}
const phMatch = (a, b) => a && b && a.type === b.type && String(a.idx ?? '') === String(b.idx ?? '')
const inches = (box) => ({ x: +(box.x / EMU).toFixed(2), y: +(box.y / EMU).toFixed(2), w: +(box.cx / EMU).toFixed(2), h: +(box.cy / EMU).toFixed(2) })

const KIND = { 'p:sp': 'text', 'p:pic': 'picture', 'p:graphicFrame': 'frame', 'p:grpSp': 'group', 'p:cxnSp': 'connector' }
function shapeKind(sp) {
  if (sp.tagName === 'p:graphicFrame') {
    const data = firstOf(firstOf(sp, 'a:graphic') ?? sp, 'a:graphicData')
    const uri = data?.getAttribute('uri') ?? ''
    return uri.includes('chart') ? 'chart' : uri.includes('table') ? 'table' : 'frame'
  }
  if (sp.tagName === 'p:sp' && textOf(sp).trim() === '') return 'shape'
  return KIND[sp.tagName] ?? sp.tagName
}

function shapeText(sp) {
  const body = child(sp, 'p:txBody')
  if (!body) return []
  return childrenOf(body, 'a:p').map(p => ({
    text: textOf(p),
    runs: elementsOf(p, 'a:r').map(r => ({
      text: textOf(r),
      font: firstOf(firstOf(r, 'a:rPr') ?? r, 'a:latin')?.getAttribute('typeface'),
      size: Number(firstOf(r, 'a:rPr')?.getAttribute('sz') ?? 0) / 100 || undefined,
    })),
  })).filter(p => p.text !== '' || p.runs.length > 0)
}

function shapesIn(spTree, pkg, layoutDoc, masterDoc, groupChain = []) {
  const out = []
  for (const el of childrenOf(spTree)) {
    if (!KIND[el.tagName]) continue
    if (el.tagName === 'p:grpSp') {
      out.push(describe(el, pkg, layoutDoc, masterDoc, groupChain))
      out.push(...shapesIn(el, pkg, layoutDoc, masterDoc, [...groupChain, el]).map(s => ({ ...s, inGroup: shapeName(el) })))
      continue
    }
    out.push(describe(el, pkg, layoutDoc, masterDoc, groupChain))
  }
  return out
}

function describe(sp, pkg, layoutDoc, masterDoc, groupChain) {
  const entry = { id: shapeId(sp), name: shapeName(sp), kind: shapeKind(sp) }
  const ph = phOf(sp); if (ph) entry.placeholder = ph
  const box = shapeBox(pkg, sp, layoutDoc, masterDoc, groupChain)
  if (box) entry.box = inches(box)
  if (sp.tagName === 'p:pic') {
    const blip = elementsOf(sp, 'a:blip')[0]
    const media = blip && relTarget(pkg, entry.owner ?? sp.ownerDocument?.partName, blip, 'r:embed')
    if (media) entry.media = media
  }
  const paragraphs = shapeText(sp)
  if (paragraphs.length > 0) entry.text = paragraphs
  return entry
}

const layoutName = (doc) => firstOf(doc.documentElement, 'p:cSld')?.getAttribute('name')
const notesText = (pkg, slide) => {
  const notes = relatedPart(pkg, slide, ['notesSlide'])
  if (!notes || !pkg.parts.has(notes)) return ''
  return elementsOf(pkg.xml(notes).documentElement, 'p:sp').map(s => textOf(s).trim()).filter(t => t && !/^(slide number|\d+)$/i.test(t)).join(' ')
}

/** @returns {object} the deck inventory */
export function pptxInventory(pkg, slidesFilter) {
  const size = slideSize(pkg)
  const fonts = themeFonts(pkg)
  const order = deckOrder(pkg)
  const wanted = new Set(slidesFilter?.length ? slidesFilter.map(String) : order.map((_, i) => String(i + 1)))
  const slides = order.map((entry, i) => {
    const pos = i + 1
    if (!wanted.has(String(pos)) && !wanted.has(entry.part)) return undefined
    if (!pkg.parts.has(entry.part)) return { position: pos, part: entry.part, missing: true }
    const doc = pkg.xml(entry.part)
    doc.partName = entry.part
    const layoutPart = relatedPart(pkg, entry.part, ['slideLayout'])
    const masterPart = layoutPart && relatedPart(pkg, layoutPart, ['slideMaster'])
    const layoutDoc = layoutPart && pkg.parts.has(layoutPart) ? pkg.xml(layoutPart) : undefined
    const masterDoc = masterPart && pkg.parts.has(masterPart) ? pkg.xml(masterPart) : undefined
    const tree = firstOf(firstOf(doc.documentElement, 'p:cSld') ?? doc.documentElement, 'p:spTree')
    const shapes = tree ? shapesIn(tree, pkg, layoutDoc, masterDoc) : []
    for (const s of shapes) s.owner = undefined
    return {
      position: pos, part: entry.part, sldId: entry.sldId,
      layout: layoutPart ? layoutName(pkg.xml(layoutPart)) : undefined,
      hidden: doc.documentElement.getAttribute('show') === '0' || undefined,
      notes: notesText(pkg, entry.part) || undefined,
      shapes,
    }
  }).filter(Boolean)
  return { slideSize: size, themeFonts: fonts, slides }
}

/** Overlap and off-slide findings over resolved text-shape boxes. */
export function pptxLayout(pkg, slidesFilter, { autofit = false } = {}) {
  const inv = pptxInventory(pkg, slidesFilter)
  const size = inv.slideSize
  const findings = []
  const fitted = []
  for (const slide of inv.slides) {
    if (!slide.shapes) continue
    // Off-slide bounds apply to every shape with a resolved box (pictures,
    // charts, tables, group children); overlap stays among text shapes.
    const allBoxes = []
    const collect = (shapes) => { for (const s of shapes) { if (s.box) allBoxes.push(s); if (s.children) collect(s.children) } }
    collect(slide.shapes)
    const boxes = slide.shapes.filter(s => s.box && s.text?.length)
    for (const s of allBoxes) {
      const a = s.box
      if (a.x < 0 || a.y < 0 || a.x + a.w > size.cx + 0.01 || a.y + a.h > size.cy + 0.01) {
        findings.push({ slide: slide.position, rule: 'off-slide', shape: s.name, box: a })
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].box, b = boxes[j].box
        const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
        const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
        const area = ox * oy
        if (area <= 0) continue
        const share = area / Math.min(a.w * a.h, b.w * b.h)
        findings.push({ slide: slide.position, rule: 'overlap', shapes: [boxes[i].name, boxes[j].name], area: +area.toFixed(2), shareOfSmaller: +share.toFixed(2) })
      }
    }
    if (autofit) {
      const names = new Set(findings.filter(f => f.slide === slide.position).flatMap(f => f.shapes ?? [f.shape]))
      if (names.size > 0) {
        const doc = pkg.xml(slide.part)
        for (const el of elementsOf(doc.documentElement, 'p:sp')) {
          if (!names.has(shapeName(el))) continue
          const body = firstOf(el, 'p:txBody')
          const bodyPr = body && firstOf(body, 'a:bodyPr')
          if (bodyPr && !firstOf(bodyPr, 'a:normAutofit')) {
            for (const tag of ['a:noAutofit', 'a:spAutoFit']) {
              const old = firstOf(bodyPr, tag)
              if (old) bodyPr.removeChild(old)
            }
            // a:normAutofit belongs before a:scene3d / a:sp3d / a:flatTx / a:extLst.
            const anchor = childrenOf(bodyPr).find(c =>
              ['a:scene3d', 'a:sp3d', 'a:flatTx', 'a:extLst'].includes(c.tagName))
            bodyPr.insertBefore(doc.createElement('a:normAutofit'), anchor ?? null)
            fitted.push(`${slide.position}:${shapeName(el)}`)
          }
        }
        pkg.putXml(slide.part, doc)
      }
    }
  }
  return { findings, autofitApplied: fitted, note: 'Text overflowing inside a box still needs a render to see.' }
}

/**
 * Reorder/duplicate/remove slides by current positions, then clean. Duplicates get
 * fresh slide parts (with rels, notes slide, charts and embedded workbooks).
 * @returns {{ order: number[], removed: number[], duplicated: number[] }}
 */
export function pptxSlides(pkg, order) {
  const current = deckOrder(pkg)
  const pres = pkg.xml('ppt/presentation.xml')
  const lst = firstOf(pres.documentElement, 'p:sldIdLst')
  const presRels = pkg.rels.get('ppt/presentation.xml')
  // Every allocation probes the live map/set — a gap below a live id must not
  // be overwritten by a later duplicate in the same batch.
  const usedSldIds = new Set(current.map(e => Number(e.sldId)))
  const newSlidePart = () => { let n = 1; while (pkg.parts.has(`ppt/slides/slide${n}.xml`)) n++; return n }
  const newSldId = () => { let n = Math.max(256, ...usedSldIds) + 1; usedSldIds.add(n); return n }
  const seen = new Set()
  const newEntries = []
  const duplicated = []
  for (const pos of order) {
    const source = current[pos - 1]
    if (!source) throw new Error(`no slide at position ${pos}`)
    if (!seen.has(pos)) { newEntries.push({ ...source }); seen.add(pos); continue }
    // Duplicate: copy slide + notes slide + chart parts + embedded workbooks.
    const dup = String(newSlidePart())
    const newPart = `ppt/slides/slide${dup}.xml`
    pkg.parts.set(newPart, { data: pkg.get(source.part) })
    if (pkg.overrides.has(source.part)) pkg.overrides.set(newPart, pkg.overrides.get(source.part))
    const mapped = new Map([[source.part, newPart]])
    const rid = `rId${nextRid(presRels)}`
    presRels.set(rid, { id: rid, type: presRels.get(source.rid)?.type ?? 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${dup}.xml`, mode: 'Internal' })
    const sid = String(newSldId())
    // Copy the slide's .rels, duplicating owned parts (notes, charts, workbooks).
    const slideRels = new Map()
    for (const [id, rel] of pkg.relsOf(source.part)) {
      if (rel.mode === 'External') { slideRels.set(id, { ...rel }); continue }
      const target = pkg.targetOf(source.part, rel.target)
      if (/notesSlide|chart|package|oleObject|embeddings/i.test(rel.type) && pkg.parts.has(target)) {
        const newTarget = copyPart(pkg, target, mapped)
        slideRels.set(id, { ...rel, target: posix.relative(posix.dirname(newPart), newTarget) })
      } else slideRels.set(id, { ...rel })
    }
    pkg.rels.set(newPart, slideRels)
    // Copied parts keep rels to mapped sources — the notes slide must point at
    // the new slide, a chart at its new embedded workbook.
    for (const copy of mapped.values()) {
      const map = pkg.rels.get(copy)
      if (!map) continue
      for (const rel of map.values()) {
        if (rel.mode === 'External') continue
        const abs = pkg.targetOf(copy, rel.target)
        if (mapped.has(abs)) rel.target = posix.relative(posix.dirname(copy), mapped.get(abs))
      }
    }
    newEntries.push({ sldId: sid, rid, part: newPart })
    duplicated.push(pos)
  }
  // Rewrite sldIdLst in the requested order; drop unlisted slides.
  for (const el of childrenOf(lst)) lst.removeChild(el)
  for (const entry of newEntries) {
    const el = pres.createElement('p:sldId')
    el.setAttribute('id', entry.sldId)
    el.setAttribute('r:id', entry.rid)
    lst.appendChild(el)
  }
  for (const [rid, rel] of [...presRels]) {
    if (rel.type.endsWith('/slide') && !newEntries.some(e => e.rid === rid)) presRels.delete(rid)
  }
  const kept = new Set(newEntries.map(e => e.part))
  const removed = current.filter(e => !kept.has(e.part)).map(e => e.part)
  for (const part of removed) pkg.remove(part)
  pkg.putXml('ppt/presentation.xml', pres)
  const cleaned = pptxClean(pkg)
  return { order, duplicated, removed: [...removed, ...cleaned.removed] }
}

const maxNum = (names, re) => Math.max(0, ...names.map(n => Number(re.exec(n)?.[1] ?? 0)))
const nextRid = (map) => { let i = 1; while (map.has(`rId${i}`)) i++; return i }

function copyPart(pkg, part, mapped = new Map()) {
  const dir = posix.dirname(part), base = posix.basename(part)
  const stem = base.replace(/\d+(\.\w+)$/, ''), extn = base.match(/\.\w+$/)[0]
  const n = maxNum([...pkg.parts.keys()].filter(k => k.startsWith(dir + '/')), new RegExp(`${stem}(\\d+)${extn.replace('.', '\\.')}$`)) + 1
  const target = `${dir}/${stem}${n}${extn}`
  pkg.parts.set(target, { data: pkg.get(part) })
  mapped.set(part, target)
  if (pkg.overrides.has(part)) pkg.overrides.set(target, pkg.overrides.get(part))
  // Copy that part's rels; duplicate its own embedded parts (chart workbooks).
  const map = new Map()
  for (const [id, rel] of pkg.relsOf(part)) {
    if (rel.mode === 'External') { map.set(id, { ...rel }); continue }
    const t = pkg.targetOf(part, rel.target)
    if (/package|oleObject|workbook|embeddings|xlsx/i.test(rel.type) && pkg.parts.has(t)) {
      map.set(id, { ...rel, target: posix.relative(dir, copyPart(pkg, t, mapped)) })
    } else map.set(id, { ...rel })
  }
  if (map.size > 0) pkg.rels.set(target, map)
  return target
}

/**
 * Drop slides missing from sldIdLst, then every part not reachable from the
 * package root rels, dangling relationships and Overrides, and media that no
 * remaining rel references.
 * @returns {{ removed: string[] }}
 */
// Relationship kinds that only matter when the owning XML references them:
// deleting a picture leaves its r:embed rel behind, and so on. Structural rels
// (layouts, masters, notes, themes, comments, tags) are not listed.
const CONTENT_REL = /\/(image|media|video|audio|chart|oleObject|package|diagramData|diagramLayout|diagramColors|diagramQuickStyle|drawing|hyperlink)$/

export function pptxClean(pkg, { dryRun = false } = {}) {
  const removed = []
  // Drop content relationships whose Id no part XML uses any more.
  for (const [owner, map] of [...pkg.rels]) {
    if (!pkg.parts.has(owner)) continue
    const xml = pkg.get(owner) ?? Buffer.alloc(0)
    for (const [id, rel] of [...map]) {
      if (rel.mode !== 'Internal' || !CONTENT_REL.test(rel.type)) continue
      // Non-Office generators can write single-quoted attributes.
      if (!xml.includes(`"${id}"`) && !xml.includes(`'${id}'`)) map.delete(id)
    }
  }
  // Slides not in sldIdLst — pptx only; docx/xlsx have no presentation part.
  const listed = new Set(pkg.parts.has('ppt/presentation.xml') ? deckOrder(pkg).map(e => e.part) : [])
  for (const part of slideParts(pkg)) {
    if (!listed.has(part)) { removed.push(part); if (!dryRun) pkg.remove(part) }
  }
  // Reachability from the package root through relationships.
  const reachable = new Set(['[Content_Types].xml'])
  const queue = ['']
  while (queue.length) {
    const owner = queue.pop()
    for (const rel of pkg.relList(owner)) {
      if (rel.mode === 'External') continue
      const target = pkg.targetOf(owner, rel.target)
      if (!reachable.has(target) && pkg.parts.has(target)) { reachable.add(target); queue.push(target) }
    }
  }
  for (const name of [...pkg.parts.keys()]) {
    if (name.endsWith('.rels')) continue
    if (!reachable.has(name)) { removed.push(name); if (!dryRun) pkg.remove(name) }
  }
  if (!dryRun) {
    // Clean rels of removed owners + dangling rels/Overrides.
    for (const [owner, map] of [...pkg.rels]) {
      if (owner !== '' && !pkg.parts.has(owner)) { pkg.rels.delete(owner); continue }
      for (const [id, rel] of [...map]) {
        if (rel.mode !== 'External' && !pkg.parts.has(pkg.targetOf(owner, rel.target))) map.delete(id)
      }
    }
    for (const part of [...pkg.overrides.keys()]) if (!pkg.parts.has(part)) pkg.overrides.delete(part)
    // Media no remaining rel references (bail if any rel target resolves there).
    const used = new Set()
    for (const [owner] of pkg.rels) for (const rel of pkg.relList(owner)) used.add(pkg.targetOf(owner, rel.target))
    for (const name of [...pkg.parts.keys()]) {
      if (/^(ppt|word|xl)\/media\//.test(name) && !used.has(name)) { removed.push(name); pkg.remove(name) }
    }
  }
  return { removed: [...new Set(removed)], check: dryRun ? undefined : checkPackage(pkg).length }
}
