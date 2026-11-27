// Dedicated tool cards for Office document operations:
// 1. DSH native Office tools (`office_render`, `office_convert`, `office_recalculate`)
// 2. DS Bot's bundled `office.js` CLI calls run through `bash` / `pwsh`
// Shows document kind, operation, rendered page thumbnails (click to enlarge),
// missing-font notices, foldable details, and a direct "Preview" action into the right panel.
import { createElement as h, useEffect, useMemo, useRef } from 'react'
import { FileIcon } from '../../../ds-bot/src/client/icons.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ToolImageThumb } from './image-lightbox.js'
import { CodeSection, formatResult, formatToolDuration } from './tool-card.js'
import { MiniCopy, ToolCardShell, compact, errorLineOf, parseExitStatus, readArgText, readArgValue, shortPath } from './tool-view-shared.js'

export const OFFICE_TOOL_NAMES = ['office_render', 'office_convert', 'office_recalculate']

const EXT_KIND = {
  docx: 'Word',
  doc: 'Word',
  odt: 'Word',
  rtf: 'Word',
  xlsx: 'Excel',
  xls: 'Excel',
  ods: 'Excel',
  csv: 'Excel',
  pptx: 'PowerPoint',
  ppt: 'PowerPoint',
  odp: 'PowerPoint',
  pdf: 'PDF',
}

const OP_LABELS = {
  office_render: 'Render document',
  office_convert: 'Convert document',
  office_recalculate: 'Recalculate spreadsheet',
}

const CLI_OP_LABELS = {
  docx: 'Word document',
  pptx: 'Presentation',
  xlsx: 'Spreadsheet',
  sheet: 'Contact sheet',
  check: 'Check document',
  pack: 'Pack document',
  unpack: 'Unpack document',
}

export function officeKindOf(rawPath) {
  if (typeof rawPath !== 'string' || rawPath === '') return ''
  const dot = rawPath.lastIndexOf('.')
  if (dot < 0) return ''
  const ext = rawPath.slice(dot + 1).toLowerCase().trim()
  return EXT_KIND[ext] ?? ''
}

function normSlashes(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, '')
}

function isAbsolutePath(filePath) {
  const value = String(filePath ?? '')
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function normalizePosixPath(rawPath) {
  const s = normSlashes(rawPath)
  if (!s) return ''
  let prefix = ''
  let rest = s
  let unc = false
  if (s.startsWith('//')) {
    unc = true
    prefix = '//'
    rest = s.replace(/^\/+/, '')
  } else if (/^[A-Za-z]:/.test(s)) {
    prefix = s.slice(0, 2)
    rest = s.slice(2)
  }
  const rooted = !unc && rest.startsWith('/')
  const minParts = unc ? 2 : 0
  const parts = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > minParts && parts.at(-1) !== '..') parts.pop()
      else if (!rooted && !unc) parts.push('..')
    } else {
      parts.push(part)
    }
  }
  return `${prefix}${rooted ? '/' : ''}${parts.join('/')}`
}

function resolveAgainstDir(baseDir, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') return ''
  const trimmed = targetPath.trim()
  if (isAbsolutePath(trimmed) || !baseDir) return normalizePosixPath(trimmed)
  return normalizePosixPath(`${normSlashes(baseDir)}/${trimmed}`)
}

function isInsideDir(filePath, dirPath) {
  if (!filePath || !dirPath) return false
  const f = normalizePosixPath(filePath)
  const d = normalizePosixPath(dirPath)
  if (!f || !d) return false
  // Windows drive prefixes are case-insensitive.
  const fCmp = /^[A-Za-z]:/.test(f) ? f[0].toLowerCase() + f.slice(1) : f
  const dCmp = /^[A-Za-z]:/.test(d) ? d[0].toLowerCase() + d.slice(1) : d
  return fCmp === dCmp || fCmp.startsWith(`${dCmp}/`)
}

function looksLikeTempPath(filePath) {
  const norm = normSlashes(filePath)
  return norm.includes('/dsh-office') || norm.startsWith('/tmp/') || norm.startsWith('/var/folders/') || /\/temp\//i.test(norm)
}

/**
 * Chooses the best file path to open in the right-panel document previewer.
 * Relative output/input paths resolve against the shell working directory (`workdir` or `cwd`);
 * `workspace-read` remains the authoritative server-side workspace fence, and temp-dir outputs fall back to the workspace document.
 */
export function officePreviewTarget(inputPath, outputPath, cwd, workdir = '') {
  const baseDir = workdir ? resolveAgainstDir(cwd, workdir) : cwd
  if (typeof outputPath === 'string' && outputPath.trim() !== '') {
    const resolvedOut = resolveAgainstDir(baseDir, outputPath)
    if (cwd ? isInsideDir(resolvedOut, cwd) : !looksLikeTempPath(resolvedOut)) return resolvedOut
  }
  if (typeof inputPath === 'string' && inputPath.trim() !== '') {
    return resolveAgainstDir(baseDir, inputPath)
  }
  return ''
}

export function parseOfficeResultText(text) {
  const source = typeof text === 'string' ? text : ''
  const missingFonts = []
  const fontMatch = /(?:fonts not installed and substituted|missing fonts?):\s*(.+?)\.?\s*$/im.exec(source)
  if (fontMatch?.[1]) {
    for (const item of fontMatch[1].split(/[,;]/)) {
      const cleaned = item.replace(/\.+$/, '').trim()
      if (cleaned) missingFonts.push(cleaned)
    }
  }
  const pageMatch = /(\d+)\s+pages?\b/i.exec(source)
    ?? /\bRendered\s+(\d+)\s+images?(?:\(s\))?\b/i.exec(source)
  const pages = pageMatch ? Number(pageMatch[1]) : undefined
  const firstLine = source.split('\n').map(line => line.trim()).find(Boolean) ?? ''
  return { missingFonts, pages, firstLine }
}

function tokenizeShell(command) {
  const tokens = []
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens
}

/**
 * Recognizes DS Bot's bundled `office.js` CLI calls executed inside `bash` / `pwsh`
 * (e.g. `node .../office.js docx write ... -o out.docx`).
 */
export function parseOfficeCliCommand(command) {
  if (typeof command !== 'string' || !/\boffice\.js\b/.test(command)) return null
  // Ignore compound pipelines/chains where office.js is only a fragment.
  if (/[|;&]{1,2}|\n/.test(command.trim())) return null
  const tokens = tokenizeShell(command.trim())
  const scriptIdx = tokens.findIndex(tok => /(?:^|[\\/])office\.js$/.test(tok))
  if (scriptIdx < 0) return null
  const rest = tokens.slice(scriptIdx + 1)
  if (rest.length === 0) return null
  const subcommand = rest[0].toLowerCase()
  if (!Object.hasOwn(CLI_OP_LABELS, subcommand)) return null
  let action = ''
  let outputPath = ''
  let inPlace = false
  const positionals = []
  for (let i = 1; i < rest.length; i += 1) {
    const tok = rest[i]
    if (tok === '-o' || tok === '--out' || tok === '--output') {
      outputPath = rest[i + 1] ?? ''
      i += 1
      continue
    }
    if (tok.startsWith('--out=')) { outputPath = tok.slice(6); continue }
    if (tok.startsWith('--output=')) { outputPath = tok.slice(9); continue }
    if (tok === '--in-place') { inPlace = true; continue }
    if (tok.startsWith('-')) {
      // Skip value for known value flags (matching ds-bot/src/office/cli.js options).
      if (['--sheet', '--range', '--slides', '--slide', '--cols', '--width', '--format', '--dpi', '--pages', '--json-file', '--spec', '--against', '--ops', '--order'].includes(tok)) i += 1
      continue
    }
    if (!action && ['docx', 'pptx', 'xlsx'].includes(subcommand) && !tok.includes('.') && !tok.includes('/') && !tok.includes('\\')) {
      action = tok
      continue
    }
    positionals.push(tok)
  }
  const docPath = positionals.find(p => /\.(docx|xlsx|pptx|pdf|odt|ods|odp)$/i.test(p)) ?? positionals[0] ?? ''
  const targetPath = outputPath || docPath
  const docKind = officeKindOf(targetPath) || (subcommand === 'docx' ? 'Word' : subcommand === 'pptx' ? 'PowerPoint' : subcommand === 'xlsx' ? 'Excel' : '')
  return {
    subcommand,
    action,
    inputPath: docPath,
    outputPath,
    inPlace,
    previewPath: targetPath,
    docKind,
  }
}

export function parseOfficeCliOutput(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object') return null
    const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed
    const outPath = typeof data.output === 'string' ? data.output : (typeof data.path === 'string' ? data.path : (typeof data.file === 'string' ? data.file : ''))
    const findings = Array.isArray(data.findings) ? data.findings.length
      : (Array.isArray(data.issues) ? data.issues.length : undefined)
    const count = Number.isInteger(data.slides) ? { kind: 'slides', value: data.slides }
      : Array.isArray(data.slides) ? { kind: 'slides', value: data.slides.length }
        : Array.isArray(data.sheets) ? { kind: 'sheets', value: data.sheets.length }
          : Number.isInteger(data.paragraphs) ? { kind: 'paragraphs', value: data.paragraphs }
            : Number.isInteger(data.pages) ? { kind: 'pages', value: data.pages }
              : null
    const errorMessage = typeof parsed.error === 'string'
      ? parsed.error
      : (typeof parsed.error?.message === 'string' ? parsed.error.message : '')
    return {
      ok: parsed.ok !== false,
      error: errorMessage,
      outPath,
      findings,
      count,
    }
  } catch {
    return null
  }
}

function countLabel(kind, count) {
  if (kind === 'pages') return count === 1 ? t('1 page') : t('{count} pages', { count })
  if (kind === 'slides') return count === 1 ? t('1 slide') : t('{count} slides', { count })
  if (kind === 'sheets') return count === 1 ? t('1 sheet') : t('{count} sheets', { count })
  if (kind === 'paragraphs') return count === 1 ? t('1 paragraph') : t('{count} paragraphs', { count })
  if (kind === 'issues') return count === 1 ? t('1 issue') : t('{count} issues', { count })
  return String(count)
}

function pageLabelsFromContent(content) {
  const labels = []
  for (const item of Array.isArray(content) ? content : []) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue
    for (const rawLine of item.text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const stripped = line.replace(/:\s*\d+\s*[x×]\s*\d+\s*px\s*$/i, '').trim()
      if (/^(?:Page|Slide|Sheet)\s+\S/i.test(stripped)) {
        labels.push(stripped)
      }
    }
  }
  return labels
}

/**
 * Tool card for DSH's `office_render`, `office_convert`, and `office_recalculate`.
 */
export function OfficeToolView({ toolName, block, cwd, phase, useDisclosure, openFile, loadImage }) {
  const imageBlocks = useMemo(
    () => (Array.isArray(block?.content) ? block.content.filter(item => item?.type === 'image' && item.attachment) : []),
    [block?.content],
  )
  // Expand automatically when rendered page thumbnails exist so visuals are immediately scannable.
  const disclosure = useDisclosure(imageBlocks.length > 0)
  const autoOpened = useRef(imageBlocks.length > 0)
  useEffect(() => {
    if (!autoOpened.current && imageBlocks.length > 0) {
      autoOpened.current = true
      disclosure.setExpanded(true)
    }
  }, [imageBlocks.length, disclosure])
  const isError = phase === 'result' && block?.isError === true
  const meta = block?.meta && typeof block.meta === 'object' ? block.meta : null
  const inputPath = (typeof meta?.path === 'string' && meta.path !== '' ? meta.path : '') || readArgText(block, 'input', 'file_path', 'path')
  const outputPath = typeof meta?.file === 'string' ? meta.file : ''
  const previewPath = officePreviewTarget(inputPath, outputPath, cwd)
  const displayPath = shortPath(previewPath || inputPath, cwd)
  const docKind = officeKindOf(previewPath || inputPath)
  const format = readArgText(block, 'format').toUpperCase()
  const rawPagesArg = readArgValue(block, 'pages')
  const pagesArg = Array.isArray(rawPagesArg)
    ? rawPagesArg.filter(v => Number.isInteger(v) || (typeof v === 'string' && v.trim() !== '')).join(', ')
    : (typeof rawPagesArg === 'string' ? rawPagesArg.trim() : '')
  const sheetArg = readArgText(block, 'sheet')
  const rangeArg = readArgText(block, 'range')
  const dpiArg = readArgValue(block, 'dpi')

  const rawResult = useMemo(() => (phase === 'result' ? formatResult(block) : ''), [phase, block])
  const parsed = useMemo(() => parseOfficeResultText(rawResult), [rawResult])
  const pageLabels = useMemo(() => pageLabelsFromContent(block?.content), [block?.content])
  const missingFonts = Array.isArray(meta?.missingFonts) && meta.missingFonts.length > 0
    ? meta.missingFonts
    : parsed.missingFonts
  const errLine = errorLineOf(block, isError)

  const badges = []
  if (docKind) badges.push(h('span', { key: 'kind', className: 'dsb-tool-pill' }, docKind))
  if (format && format !== docKind.toUpperCase()) {
    badges.push(h('span', { key: 'fmt', className: 'dsb-tool-pill', 'data-tone': 'ok' }, `→ ${format}`))
  }
  if (imageBlocks.length > 0) {
    badges.push(h('span', { key: 'pages', className: 'dsb-tool-pill' }, countLabel('pages', imageBlocks.length)))
  } else if (parsed.pages) {
    badges.push(h('span', { key: 'pages', className: 'dsb-tool-pill' }, countLabel('pages', parsed.pages)))
  } else if (pagesArg) {
    badges.push(h('span', { key: 'pages', className: 'dsb-tool-pill' }, pagesArg))
  }
  if (sheetArg) badges.push(h('span', { key: 'sheet', className: 'dsb-tool-pill' }, sheetArg))
  if (missingFonts.length > 0) {
    badges.push(h('span', { key: 'fonts', className: 'dsb-tool-pill', 'data-tone': 'warn' }, t('Missing fonts')))
  }

  const canPreview = typeof openFile === 'function' && previewPath !== '' && !isError
  const headerAction = canPreview
    ? h('button', {
      type: 'button',
      className: 'dsb-tool-action',
      title: previewPath,
      onClick: () => openFile(previewPath),
    }, t('Preview'))
    : null

  const detailChips = [
    rangeArg ? `${t('Range')}: ${rangeArg}` : '',
    Number.isFinite(dpiArg) ? `${dpiArg} DPI` : '',
  ].filter(Boolean)

  const hasBody = imageBlocks.length > 0 || missingFonts.length > 0 || outputPath !== '' || detailChips.length > 0 || rawResult !== '' || errLine !== '' || canPreview

  return h(ToolCardShell, {
    icon: FileIcon,
    label: t(OP_LABELS[toolName] ?? 'Document'),
    summary: displayPath,
    summaryTitle: previewPath || inputPath || undefined,
    badges,
    headerAction,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  detailChips.length > 0 ? h('div', { className: 'dsb-tool-kv' },
    detailChips.map((chip, index) => h('span', { key: index, className: 'dsb-tool-pill' }, chip))) : null,
  missingFonts.length > 0 ? h('div', { className: 'dsb-office-warn', role: 'status' },
    `${t('Missing fonts')}: ${missingFonts.join(', ')}`) : null,
  imageBlocks.length > 0 ? h('div', { className: 'dsb-office-pages' },
    imageBlocks.map((item, index) => h(ToolImageThumb, {
      key: item.attachment.attachmentId ?? index,
      attachment: item.attachment,
      loadImage,
      alt: `${displayPath || t('Document')} · ${pageLabels[index] || t('Page {n}', { n: index + 1 })}`,
      label: pageLabels[index] || t('Page {n}', { n: index + 1 }),
      compact: true,
    }))) : null,
  outputPath && outputPath !== previewPath ? h('div', { className: 'dsb-office-out' },
    h('span', { className: 'dsb-office-out-label' }, t('Output file')),
    h('span', { className: 'dsb-code-path', title: outputPath }, shortPath(outputPath, cwd)),
    h(MiniCopy, { text: outputPath })) : null,
  rawResult !== '' ? h(CodeSection, { label: isError ? t('Error') : t('Output'), text: rawResult, error: isError }) : null)
}

/**
 * Renders a `bash` / `pwsh` invocation of DS Bot's bundled `office.js` CLI as a structured Office card.
 */
export function OfficeCliCard({ parsedCli, command, block, cwd, workdir = '', phase, useDisclosure, openFile }) {
  const disclosure = useDisclosure()
  const rawResult = useMemo(() => (phase === 'result' ? formatResult(block) : ''), [phase, block])
  const exitParsed = useMemo(() => (phase === 'result' ? parseExitStatus(rawResult) : null), [phase, rawResult])
  const bodyText = exitParsed ? exitParsed.body : ''
  const cliOut = useMemo(() => (phase === 'result' ? parseOfficeCliOutput(bodyText) : null), [phase, bodyText])
  // `office.js check` and `pptx layout` exit with code 1 when findings remain while
  // reporting `{ ok: true, data: { findings: [...] } }`; treat that as a warning with
  // findings and keep Preview enabled instead of flagging the command as a hard error.
  const findingsExit = exitParsed !== null
    && !('signal' in exitParsed)
    && exitParsed.exitCode === 1
    && cliOut?.ok === true
    && typeof cliOut.findings === 'number'
    && cliOut.findings > 0
  const nonZero = exitParsed !== null && ('signal' in exitParsed || exitParsed.exitCode !== 0)
  const isError = phase === 'result' && (
    cliOut?.ok === false
    || (!findingsExit && (block?.isError === true || nonZero))
  )
  const errLine = (!findingsExit ? errorLineOf(block, block?.isError === true) : '') || (cliOut?.ok === false ? cliOut.error : '')

  // `pptx layout` and `pptx clean` only write `-o` when changes are applied (and include `data.file`
  // in `--json` output); when structured output omits `data.file`, preview the input document instead.
  const conditionalWrite = cliOut !== null && parsedCli.subcommand === 'pptx' && (parsedCli.action === 'layout' || parsedCli.action === 'clean')
  const effectiveOutPath = conditionalWrite ? cliOut.outPath : (cliOut?.outPath || parsedCli.outputPath)
  const previewPath = officePreviewTarget(parsedCli.inputPath, effectiveOutPath, cwd, workdir)
  const displayPath = shortPath(previewPath || parsedCli.inputPath, cwd)
  const docKind = officeKindOf(previewPath) || parsedCli.docKind

  const badges = []
  if (docKind) badges.push(h('span', { key: 'kind', className: 'dsb-tool-pill' }, docKind))
  if (parsedCli.action) badges.push(h('span', { key: 'act', className: 'dsb-tool-pill' }, parsedCli.action))
  if (cliOut?.count) {
    badges.push(h('span', { key: 'cnt', className: 'dsb-tool-pill' }, countLabel(cliOut.count.kind, cliOut.count.value)))
  }
  if (typeof cliOut?.findings === 'number') {
    badges.push(h('span', {
      key: 'find',
      className: 'dsb-tool-pill',
      'data-tone': cliOut.findings === 0 ? 'ok' : 'warn',
    }, cliOut.findings === 0 ? t('No issues') : countLabel('issues', cliOut.findings)))
  }
  if (exitParsed && 'signal' in exitParsed) {
    badges.push(h('span', { key: 'sig', className: 'dsb-tool-pill', 'data-tone': 'danger' }, t('signal {signal}', { signal: exitParsed.signal })))
  } else if (exitParsed && exitParsed.exitCode !== 0 && !findingsExit) {
    badges.push(h('span', { key: 'exit', className: 'dsb-tool-pill', 'data-tone': 'danger' }, t('exit {code}', { code: exitParsed.exitCode })))
  }

  const canPreview = typeof openFile === 'function' && previewPath !== '' && !isError && phase === 'result'
  const headerAction = canPreview
    ? h('button', {
      type: 'button',
      className: 'dsb-tool-action',
      title: previewPath,
      onClick: () => openFile(previewPath),
    }, t('Preview'))
    : null

  const hasBody = command !== '' || bodyText !== '' || errLine !== ''

  return h(ToolCardShell, {
    icon: FileIcon,
    label: t(CLI_OP_LABELS[parsedCli.subcommand] ?? 'Document'),
    summary: displayPath || compact(command),
    summaryTitle: previewPath || command || undefined,
    badges,
    headerAction,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  command !== '' ? h(CodeSection, { label: t('Command'), text: command }) : null,
  bodyText !== '' ? h(CodeSection, { label: isError ? t('Error') : t('Output'), text: bodyText, error: isError }) : null)
}
