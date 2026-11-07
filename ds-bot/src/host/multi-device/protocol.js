// The task protocol shared by the hub, the worker and the Bot tools. A task is a small
// record with a `kind`: `shell` (an argument list, never a shell line), `read_file`,
// `write_file`, or `transfer` (a file either way). Older tasks carry only `argv`; they
// read as a `shell` task, so a worker from the previous version keeps working.
//
// Approval is decided on the hub, never here. A task that needs it carries
// `approved: true`; a worker refuses anything risky without that mark, so a hub bug
// cannot turn into an unapproved write.
import { extname, isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { classifyCommand } from './policy.js'

export const TASK_KINDS = ['shell', 'read_file', 'write_file', 'transfer']
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_PATH_LENGTH = 4096
export const MAX_TRANSFER_CHUNK = 256 * 1024

const refuse = (reason, code = 'invalid') => ({ ok: false, reason, code })

const MIME = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.log': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
}

export const mimeOf = path => MIME[extname(String(path)).toLowerCase()] ?? 'application/octet-stream'

// Text only when the bytes decode cleanly and hold no NUL or other control character
// besides tab, newline and carriage return: a binary file sent as UTF-8 would lose its
// bytes before the Bot ever sees it.
export function isText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (sample.includes(0)) return false
  const text = sample.toString('utf8')
  if (text.includes('\uFFFD')) return false
  return !/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)
}

export function encodeContent(buffer, requested = 'auto') {
  const encoding = requested === 'base64' ? 'base64' : requested === 'utf8' ? 'utf8' : (isText(buffer) ? 'utf8' : 'base64')
  return { data: buffer.toString(encoding), encoding }
}

// A path is either absolute (the user named it) or relative to the worker's workspace.
// A relative path may not climb out of that workspace.
export function resolveNodePath(raw, workspace) {
  if (typeof raw !== 'string' || raw.trim() === '') return refuse('path is empty')
  if (raw.length > MAX_PATH_LENGTH) return refuse(`path is longer than ${MAX_PATH_LENGTH} characters`)
  if (/\p{Cc}/u.test(raw)) return refuse('path contains a control character')
  const full = isAbsolute(raw) ? normalize(raw) : resolve(workspace, raw)
  if (!isAbsolute(raw)) {
    const rel = relative(workspace, full)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return refuse('a relative path may not leave the worker workspace')
    }
  }
  return { ok: true, path: full }
}

const sizeLimit = value => (Number.isInteger(value) ? Math.min(Math.max(value, 1), MAX_FILE_BYTES) : MAX_FILE_BYTES)

// The file body is one JSON string; the hub's request limit has to leave room for it.
export function normalizeTaskSpec(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const kind = raw.kind === undefined ? 'shell' : String(raw.kind)
  if (!TASK_KINDS.includes(kind)) return refuse(`unknown task kind: ${kind}`)
  if (kind === 'shell') {
    const check = classifyCommand(raw.argv)
    if (!check.ok) return check
    return {
      ok: true,
      spec: { kind, argv: [...raw.argv], ...(raw.approved === true ? { approved: true } : {}), safe: check.safe },
    }
  }
  const path = resolvePathField(raw.path)
  if (!path.ok) return path
  if (kind === 'read_file') {
    return {
      ok: true,
      spec: {
        kind,
        path: path.path,
        maxBytes: sizeLimit(raw.maxBytes),
        encoding: raw.encoding === 'base64' || raw.encoding === 'utf8' ? raw.encoding : 'auto',
      },
    }
  }
  if (kind === 'write_file') {
    const content = contentField(raw)
    if (!content.ok) return content
    return {
      ok: true,
      spec: {
        kind,
        path: path.path,
        data: content.data,
        encoding: content.encoding,
        ...(raw.approved === true ? { approved: true } : {}),
      },
    }
  }
  const direction = raw.direction === 'put' ? 'put' : raw.direction === 'get' ? 'get' : undefined
  if (direction === undefined) return refuse('transfer needs a direction: get or put')
  if (direction === 'get') {
    return {
      ok: true,
      spec: {
        kind,
        direction,
        path: path.path,
        maxBytes: sizeLimit(raw.maxBytes),
        // Text comes back as text, anything else as base64; the bytes are preserved.
        encoding: raw.encoding === 'base64' || raw.encoding === 'utf8' ? raw.encoding : 'auto',
      },
    }
  }
  const content = contentField(raw)
  if (!content.ok) return content
  return {
    ok: true,
    spec: {
      kind,
      direction,
      path: path.path,
      data: content.data,
      encoding: content.encoding,
      ...(raw.approved === true ? { approved: true } : {}),
    },
  }
}

function resolvePathField(raw) {
  // `resolveNodePath` waits for the worker's workspace, so this check is the shape one.
  if (typeof raw !== 'string' || raw.trim() === '') return refuse('path is empty')
  if (raw.length > MAX_PATH_LENGTH) return refuse(`path is longer than ${MAX_PATH_LENGTH} characters`)
  if (/\p{Cc}/u.test(raw)) return refuse('path contains a control character')
  return { ok: true, path: raw }
}

function contentField(raw) {
  const encoding = raw.encoding === 'base64' ? 'base64' : 'utf8'
  if (typeof raw.data !== 'string') return refuse('data must be a string')
  if (encoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)) return refuse('data is not valid base64')
  const bytes = encoding === 'base64' ? Buffer.byteLength(raw.data, 'base64') : Buffer.byteLength(raw.data, 'utf8')
  if (bytes > MAX_FILE_BYTES) return refuse(`the file is larger than ${MAX_FILE_BYTES} bytes`)
  return { ok: true, data: raw.data, encoding }
}

export function taskNeedsApproval(spec) {
  if (spec.kind === 'shell') return spec.safe !== true
  if (spec.kind === 'write_file') return true
  if (spec.kind === 'transfer') return spec.direction === 'put'
  return false
}

// What the hub sends down a node's stream: the spec without the hub's own bookkeeping.
export function wireTask(task) {
  const payload = { id: task.id, kind: task.kind, timeoutMs: task.timeoutMs }
  for (const key of ['argv', 'path', 'data', 'encoding', 'maxBytes', 'approved', 'direction']) {
    if (task[key] !== undefined) payload[key] = task[key]
  }
  return payload
}

export function taskLabel(task) {
  if (task.kind === 'shell') return (task.argv ?? []).join(' ')
  if (task.kind === 'write_file') return `write ${task.path}`
  if (task.kind === 'transfer') return `${task.direction === 'put' ? 'send' : 'read'} ${task.path}`
  return `read ${task.path}`
}
