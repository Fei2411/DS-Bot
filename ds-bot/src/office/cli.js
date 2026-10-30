// ds-bot Office CLI: inspect, check and edit .docx/.pptx/.xlsx packages without
// installing anything. Bundled into ../office.js by `npm run build`.
// Exit codes: 0 ok, 1 findings remain, 2 usage or failure. `--json` on any
// command prints {"ok":true,"data":…} or {"ok":false,"error":{"code","message"}}.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Package } from './package.js'
import { checkPackage, fixPackage } from './check.js'
import { docxRead, docxFields, docxEdit } from './docx.js'
import { pptxInventory, pptxLayout, pptxSlides, pptxClean } from './pptx.js'
import { xlsxInventory, xlsxRead } from './xlsx.js'
import { decodePng, encodePng, contactSheet } from './png.js'
import { stripPrettyWhitespace } from './xml.js'

const USAGE = `ds-bot office — inspect, check and edit .docx/.pptx/.xlsx

unpack <file> <dir>                        extract with pretty-printed XML (new or reused dir)
pack <dir> <file> [--against <orig>]       repack (strips formatting whitespace) and check
check <file|dir> [--against <orig>] [--fix [-o out|--in-place]]
docx read <file> [--changes]               body blocks p1…/t1…, headers, notes, comments
docx fields <file>                         simple and complex fields
docx edit <file> -o out|--in-place --ops <json|@file>
pptx inventory <file|dir> [--slides N…|slideN.xml]
pptx layout <file> [--slides …] [--autofit (-o|--in-place)]
pptx slides <file> -o|--in-place --order 3,1,1,5
pptx clean <file|dir> [-o|--in-place] [--dry-run]
xlsx inventory <file>
xlsx read <file> --sheet <name> [--range A1:H40]
sheet <png…|dir> -o <contact.png> [--cols 4] [--width 320]`

let JSON_MODE = false

class Usage extends Error { constructor(m) { super(m); this.code = 'usage' } }
const need = (cond, message) => { if (!cond) throw new Usage(message) }

function openAny(path) {
  return statSync(path).isDirectory() ? Package.loadDir(path) : Package.open(path)
}

function outArgs(values, input) {
  if (values['in-place']) return input
  need(values.o !== undefined, 'an edit writes to -o <file> or --in-place')
  return values.o
}

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true })

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, strict: true, allowPositionals: true,
    options: {
      json: { type: 'boolean' }, o: { type: 'string' }, 'in-place': { type: 'boolean' },
      against: { type: 'string' }, fix: { type: 'boolean' }, changes: { type: 'boolean' },
      ops: { type: 'string' }, slides: { type: 'string', multiple: true }, autofit: { type: 'boolean' },
      order: { type: 'string' }, 'dry-run': { type: 'boolean' }, sheet: { type: 'string' },
      range: { type: 'string' }, cols: { type: 'string', default: '4' }, width: { type: 'string', default: '320' },
    },
  })
  JSON_MODE = values.json
  const [cmd, sub, ...rest] = positionals
  const positional = sub !== undefined && ['read', 'fields', 'edit', 'inventory', 'layout', 'slides', 'clean'].includes(sub) ? rest : [sub, ...rest]
  const file = positional[0]
  const command = ['unpack', 'pack', 'check', 'docx', 'pptx', 'xlsx', 'sheet'].includes(cmd) ? cmd : undefined
  need(command !== undefined && file !== undefined || cmd === 'sheet' && file !== undefined, USAGE)

  if (command === 'unpack') {
    need(positional[1], 'unpack <file> <dir>')
    Package.open(file).unpack(positional[1])
    return { dir: positional[1] }
  }
  if (command === 'pack') {
    const dir = file, target = positional[1]
    need(target, 'pack <dir> <file>')
    const pkg = Package.loadDir(dir)
    for (const name of pkg.parts.keys()) {
      if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue
      try { const doc = pkg.xml(name); stripPrettyWhitespace(doc); pkg.putXml(name, doc) } catch { /* non-XML stays */ }
    }
    writeFileSync(target, pkg.save())
    const against = values.against ? Package.open(values.against) : undefined
    const findings = checkPackage(pkg, against)
    return findings.length > 0 ? findingsResult(findings) : { file: target }
  }
  if (command === 'check') {
    const pkg = openAny(file)
    if (values.fix) {
      const { fixed, remaining } = fixPackage(pkg)
      const out = outArgs(values, file)
      if (statSync(file).isDirectory()) pkg.unpack(out)
      else writeFileSync(out, pkg.save())
      return remaining.length > 0 ? findingsResult(remaining, { fixed }) : { fixed, findings: [] }
    }
    const against = values.against ? openAny(values.against) : undefined
    const findings = checkPackage(pkg, against)
    return findings.length > 0 ? findingsResult(findings) : { findings: [] }
  }

  need(file && existsSync(file), `no such file: ${String(file)}`)
  const pkg = ['docx', 'pptx', 'xlsx'].includes(command) ? openAny(file) : undefined

  if (command === 'docx') {
    if (sub === 'read') return docxRead(pkg, { changes: values.changes })
    if (sub === 'fields') return docxFields(pkg)
    if (sub === 'edit') {
      need(values.ops, 'docx edit needs --ops <json|@file>')
      const ops = JSON.parse(values.ops.startsWith('@') ? readFileSync(values.ops.slice(1), 'utf8') : values.ops)
      const result = docxEdit(pkg, ops)
      const out = outArgs(values, file)
      writeFileSync(out, pkg.save())
      return { file: out, ...result }
    }
    throw new Usage('docx read|fields|edit')
  }
  if (command === 'pptx') {
    if (sub === 'inventory') return pptxInventory(pkg, values.slides)
    if (sub === 'layout') {
      const result = pptxLayout(pkg, values.slides, { autofit: values.autofit })
      if (values.autofit && result.autofitApplied.length > 0) {
        const out = outArgs(values, file)
        writeFileSync(out, pkg.save())
        result.file = out
      }
      return result.findings.length > 0 ? findingsResult(result.findings, result) : result
    }
    if (sub === 'slides') {
      need(values.order, 'pptx slides needs --order 3,1,1,5')
      const out = outArgs(values, file)
      const order = values.order.split(',').map(s => Number(s.trim()))
      const result = pptxSlides(pkg, order)
      writeFileSync(out, pkg.save())
      return { file: out, ...result }
    }
    if (sub === 'clean') {
      const dry = values['dry-run']
      const result = pptxClean(pkg, { dryRun: dry })
      if (!dry) {
        const out = outArgs(values, file)
        if (statSync(file).isDirectory()) pkg.unpack(out)
        else writeFileSync(out, pkg.save())
        result.file = out
      }
      return result
    }
    throw new Usage('pptx inventory|layout|slides|clean')
  }
  if (command === 'xlsx') {
    if (sub === 'inventory') return xlsxInventory(pkg)
    if (sub === 'read') {
      need(values.sheet, 'xlsx read needs --sheet <name>')
      return xlsxRead(pkg, values.sheet, values.range)
    }
    throw new Usage('xlsx inventory|read')
  }
  if (command === 'sheet') {
    const inputs = positional.flatMap(p => statSync(p).isDirectory()
      ? readdirSync(p).filter(n => /\.png$/i.test(n)).sort(natural).map(n => join(p, n))
      : [p])
    need(inputs.length > 0 && values.o, 'sheet <png…|dir> -o <contact.png>')
    const images = inputs.map(p => decodePng(readFileSync(p)))
    const sheetImg = contactSheet(images, { cols: Number(values.cols), width: Number(values.width) })
    mkdirSync(join(values.o, '..'), { recursive: true })
    writeFileSync(values.o, encodePng(sheetImg))
    return { file: values.o, pages: images.length, width: sheetImg.width, height: sheetImg.height }
  }
  throw new Usage(USAGE)
}

function findingsResult(findings, extra = {}) {
  return { __findings: true, findings, ...extra }
}

main(process.argv.slice(2)).then(result => {
  if (JSON_MODE) {
    // Findings are a successful run with results: ok stays true, the exit code
    // (1) carries "findings remain". ok:false is for errors only.
    const data = result?.__findings ? omit(result, ['__findings']) : result
    console.log(JSON.stringify({ ok: true, data }))
    process.exit(result?.__findings ? 1 : 0)
  }
  if (result?.__findings) {
    for (const f of result.findings) console.log(`${f.part}: ${f.message}`)
    process.exit(1)
  }
  console.log(typeof result === 'string' ? result : JSON.stringify(result))
  process.exit(0)
}, error => {
  if (JSON_MODE) console.log(JSON.stringify({ ok: false, error: { code: error.code ?? 'error', message: error.message } }))
  else console.error(error instanceof Usage ? `${error.message}\n${USAGE}` : `office: ${error.message}`)
  process.exit(2)
})

const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)))
