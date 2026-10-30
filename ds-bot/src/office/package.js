// The OOXML package: parts, [Content_Types].xml, and .rels files as a small model.
// Loads from a .docx/.pptx/.xlsx ZIP or from an `unpack` directory; saves back
// keeping untouched members' compressed bytes.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { parseXml, serializeXml, childrenOf } from './xml.js'
import { readZip, writeZip } from './zip.js'

export const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'

function fail(message) { const error = new Error(message); error.code = 'package'; throw error }

const absTarget = (base, target) => {
  if (target.startsWith('/')) return target.slice(1)
  return posix.normalize(posix.join(posix.dirname(base), target))
}

const relSig = (map) => [...map.values()].map(r => `${r.id}${r.type}${r.target}${r.mode}`).join('')

/** One package: a name→{data|raw} part map plus content-type and relationship views. */
export class Package {
  constructor() {
    /** @type {Map<string, { data?: Buffer, raw?: Buffer, method?: number, crc?: number, usize?: number }>} */
    this.parts = new Map()
    /** @type {Map<string, Map<string, { id: string, type: string, target: string, mode: string }>>} rels-owner part ('' = package root) → rel id → rel */
    this.rels = new Map()
    this.defaults = new Map() // extension → content type
    this.overrides = new Map() // part name → content type
  }

  /** @param {string} file - a ZIP package file */
  static open(file) {
    const pkg = new Package()
    for (const member of readZip(readFileSync(file))) {
      pkg.parts.set(member.name, { raw: member.raw, method: member.method, crc: member.crc, usize: member.data.length })
      pkg.#cache(member.name, member.data)
    }
    pkg.#readModel()
    return pkg
  }

  /** @param {string} dir - a directory tree as `unpack` writes it */
  static loadDir(dir) {
    const pkg = new Package()
    const walk = (base, rel) => {
      for (const entry of readdirSync(join(base, rel))) {
        const path = rel === '' ? entry : `${rel}/${entry}`
        if (statSync(join(base, path)).isDirectory()) walk(base, path)
        else {
          const data = readFileSync(join(base, path))
          pkg.parts.set(path, { data })
          pkg.#cache(path, data)
        }
      }
    }
    walk(dir, '')
    pkg.#readModel()
    return pkg
  }

  #cache(name, data) { (this.dataCache ??= new Map()).set(name, data) }

  #readModel() {
    const ct = this.get('[Content_Types].xml')
    if (ct === undefined) fail('[Content_Types].xml missing')
    const doc = parseXml(ct)
    for (const el of childrenOf(doc.documentElement)) {
      if (el.tagName === 'Default') this.defaults.set(el.getAttribute('Extension'), el.getAttribute('ContentType'))
      else if (el.tagName === 'Override') this.overrides.set(el.getAttribute('PartName').replace(/^\//, ''), el.getAttribute('ContentType'))
    }
    for (const name of this.parts.keys()) {
      if (!name.endsWith('.rels')) continue
      const owner = name === '_rels/.rels' ? '' : posix.dirname(posix.dirname(name)) + '/' + posix.basename(name, '.rels')
      const map = new Map()
      try {
        for (const rel of childrenOf(parseXml(this.get(name)).documentElement, 'Relationship')) {
          map.set(rel.getAttribute('Id'), {
            id: rel.getAttribute('Id'), type: rel.getAttribute('Type'),
            target: rel.getAttribute('Target'), mode: rel.getAttribute('TargetMode') ?? 'Internal',
          })
        }
      } catch { /* malformed rels surface through check */ }
      this.rels.set(owner, map)
    }
    // Baselines for flush(): a .rels part is rewritten only when its map changed.
    this.relSigs = new Map([...this.rels].map(([owner, map]) => [owner, relSig(map)]))
    this.ctSig = JSON.stringify([...this.defaults].sort().concat([...this.overrides].filter(([n]) => this.parts.has(n)).sort()))
  }

  /** @returns {Buffer|undefined} part bytes */
  get(name) { return this.dataCache?.get(name) ?? this.parts.get(name)?.data }

  /** @returns {Document} parsed XML part */
  xml(name) { return parseXml(this.get(name)) }

  /** Store XML text (or bytes) as a part, replacing its entry. */
  put(name, content) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    this.parts.set(name, { data })
    this.#cache(name, data)
  }

  putXml(name, doc) { this.put(name, serializeXml(doc)) }

  remove(name) { this.parts.delete(name); this.dataCache?.delete(name) }

  /** @returns {string|undefined} content type for a part, from Override or Default */
  contentType(name) {
    return this.overrides.get(name) ?? this.defaults.get(name.slice(name.lastIndexOf('.') + 1))
  }

  /** Add or update an Override for a part. */
  override(name, type) { this.overrides.set(name, type) }

  /** The .rels owner name for a part ('word/document.xml' → itself, '' → package root). */
  relsOf(owner) { return this.rels.get(owner) ?? new Map() }

  /** Absolute part name a relationship target resolves to. */
  targetOf(owner, target) { return absTarget(owner === '' ? 'x' : owner, target) }

  /** @returns {{ id: string, type: string, target: string, mode: string }[]} relationships of a part (or package root) */
  relList(owner) { return [...this.relsOf(owner).values()] }

  /** @returns {string} the .rels part name for an owner part ('' for the package root). */
  relsName(owner) {
    return owner === '' ? '_rels/.rels' : `${posix.dirname(owner)}/_rels/${posix.basename(owner)}.rels`
  }

  /** Write .rels and [Content_Types].xml back into parts from the model — a
   * .rels part changes only when its owner part is gone or its map's signature
   * differs from the load baseline, so malformed or empty-but-valid .rels keep
   * their bytes instead of being dropped. */
  flush() {
    for (const name of [...this.parts.keys()]) {
      if (!name.endsWith('.rels')) continue
      const owner = this.#relsOwner(name)
      if (owner !== '' && !this.parts.has(owner)) this.parts.delete(name)
    }
    for (const [owner, map] of this.rels) {
      if (owner !== '' && !this.parts.has(owner)) { this.rels.delete(owner); continue }
      const name = this.relsName(owner)
      const sig = relSig(map)
      const base = (this.relSigs ??= new Map()).get(owner)
      if (map.size === 0) {
        // The model emptied a previously non-empty map → drop the part; a map
        // that was empty at load (malformed, or a real empty Relationships)
        // leaves the member's bytes alone.
        if (base !== undefined && base !== sig) this.parts.delete(name)
        continue
      }
      if (sig === base && this.parts.has(name)) continue
      const doc = parseXml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
      for (const rel of map.values()) {
        const el = doc.createElement('Relationship')
        el.setAttribute('Id', rel.id); el.setAttribute('Type', rel.type); el.setAttribute('Target', rel.target)
        if (rel.mode !== 'Internal') el.setAttribute('TargetMode', rel.mode)
        doc.documentElement.appendChild(el)
      }
      this.putXml(name, doc)
      this.relSigs.set(owner, sig)
    }
    const ctSig = JSON.stringify([...this.defaults].sort() .concat([...this.overrides].filter(([n]) => this.parts.has(n)).sort()))
    if (ctSig !== this.ctSig || !this.parts.has('[Content_Types].xml')) {
      const ct = parseXml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
      for (const [ext, type] of this.defaults) {
        const el = ct.createElement('Default'); el.setAttribute('Extension', ext); el.setAttribute('ContentType', type); ct.documentElement.appendChild(el)
      }
      for (const [name, type] of this.overrides) {
        if (!this.parts.has(name)) continue
        const el = ct.createElement('Override'); el.setAttribute('PartName', `/${name}`); el.setAttribute('ContentType', type); ct.documentElement.appendChild(el)
      }
      this.putXml('[Content_Types].xml', ct)
      this.ctSig = ctSig
    }
    this.parts.delete('') // never emit a directory entry
  }

  #relsOwner(name) {
    return name === '_rels/.rels' ? '' : posix.dirname(posix.dirname(name)) + '/' + posix.basename(name, '.rels')
  }

  /** @returns {Buffer} the package as a ZIP */
  save() {
    this.flush()
    return writeZip([...this.parts.entries()].map(([name, part]) => ({ name, ...part })))
  }

  /** Write an `unpack` directory tree. An existing non-empty dir must hold an
   * earlier unpack ([Content_Types].xml at its root); files the package no
   * longer has are removed. The model is flushed first so .rels and content
   * types written to disk match the in-memory state. */
  unpack(dir) {
    this.flush()
    if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, '[Content_Types].xml'))) {
      fail(`unpack: ${dir} exists and is not an earlier unpack`)
    }
    mkdirSync(dir, { recursive: true })
    const root = resolve(dir)
    const rootReal = realpathSync(dir)
    const keep = new Set()
    for (const [name] of this.parts) {
      const file = join(dir, name)
      if (!resolve(file).startsWith(root + sep) && resolve(file) !== root) fail(`unpack: unsafe member name ${name}`)
      keep.add(file)
      mkdirSync(dirname(file), { recursive: true })
      // A linked subdirectory walks the write outside the destination.
      const parentReal = realpathSync(dirname(file))
      if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) fail(`unpack: ${name} resolves outside ${dir}`)
      if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`unpack: ${name} is a link`)
      const data = this.get(name)
      if (name.endsWith('.xml') || name.endsWith('.rels')) {
        try { writeFileSync(file, prettyForUnpack(data)); continue } catch { /* fall back to raw */ }
      }
      writeFileSync(file, data)
    }
    const sweep = (rel) => {
      for (const entry of readdirSync(join(dir, rel))) {
        const path = rel === '' ? entry : `${rel}/${entry}`
        const full = join(dir, path)
        const st = lstatSync(full) // no link following: a link inside the tree is refused
        if (st.isSymbolicLink()) fail(`unpack: link inside ${dir}`)
        if (st.isDirectory()) { sweep(path); if (readdirSync(full).length === 0) rmdirSync(full) }
        else if (!keep.has(full)) unlinkSync(full)
      }
    }
    sweep('')
  }
}

function prettyForUnpack(data) {
  const { prettyXml } = xmlHelpers
  return prettyXml(parseXml(data))
}

// Late-bound to keep this file's import list flat.
import * as xmlHelpers from './xml.js'

export { absTarget }
