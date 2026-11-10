// Claims: what a Bot's final reply says it did or is doing, checked against the computer.
// A reply that names a local file which is not there, or announces work while no tool,
// background job or subagent is running, gets a marker on the group message. The marker
// is only for the reader: nothing is retried, resent or reworded.
//
// Only unambiguous local references count. A bare name such as `report.md` could be any
// file, so it is not checked; `./out/report.md`, `/tmp/report.md` and a path with a
// directory in it are.
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/i
const UNC = /^\\\\[^\\]/
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
const CODE_SPAN = /`([^`\n]{1,300})`/g
// A path written plainly in a sentence: it must start with `/`, `./`, `../`, `~/` or a
// Windows drive, so an ordinary word or a date is not a file.
const PLAIN_PATH = /(?:^|[\s(（:：,，])((?:~|\.{1,2})?\/[^\s，。；、()（）<>"'`]+|[a-z]:\\[^\s，。；、()（）<>"'`]+)/gi
const GLOB = /[*?[\]{}]/
const TRAILING = /[),.;:!?]+$/

const isPathLike = (text) => {
  if (text === '' || text.startsWith('#') || text.startsWith('//')) return false
  if (text === '~' || text.startsWith('~/') || isAbsolute(text) || WINDOWS_ABSOLUTE.test(text) || UNC.test(text)) return true
  if (SCHEME.test(text)) return false
  if (text.startsWith('./') || text.startsWith('../')) return true
  // A bare file name says nothing about which folder, so only a path with a directory
  // and an extension is checked.
  return text.includes('/') && /\.[a-z0-9]{1,8}$/i.test(text)
}

const expandHome = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path)

// The local paths a reply names, as written, in the order they appear. Markdown links
// and inline code are the two ways a Bot points at a file; a URL is never one.
export function fileRefs(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = []
  const seen = new Set()
  const add = (raw) => {
    let path = raw.trim()
    if (path.startsWith('<') && path.endsWith('>')) path = path.slice(1, -1)
    path = path.replace(TRAILING, '')
    if (!isPathLike(path) || GLOB.test(path)) return
    const key = path.replace(/\\/g, '/')
    if (seen.has(key)) return
    seen.add(key)
    found.push(path)
  }
  for (const match of text.matchAll(MARKDOWN_LINK)) add(match[1])
  for (const match of text.matchAll(CODE_SPAN)) add(match[1])
  for (const match of text.matchAll(PLAIN_PATH)) add(match[1])
  return found
}

// The referenced paths that are not on disk, as the reply wrote them. A path that
// exists is never reported; neither is a path that cannot be resolved at all.
export function missingFileRefs(text, base = process.cwd(), exists = (path) => existsSync(path)) {
  const missing = []
  const seen = new Set()
  for (const raw of fileRefs(text)) {
    const path = resolve(base, expandHome(raw))
    if (seen.has(path)) continue
    seen.add(path)
    try {
      if (exists(path)) continue
      // A dangling symlink or an unreadable parent is not proof the file is absent.
      statSync(path, { throwIfNoEntry: false })
    } catch {
      continue
    }
    missing.push(raw)
    if (missing.length >= 3) break
  }
  return missing
}

// English and Chinese phrases that announce work in progress. Work already reported as
// done is not an announcement, so "exported to report.pptx" does not match.
const DONE = /(?:已完成|已经完成|完成了|已导出|已生成|已保存|做好了|搞定|finished|completed|here (?:is|are)\b)/i
const IN_PROGRESS = /\b(?:i(?:'m| am)|we(?:'re| are)|still|currently)\s+(?:still\s+)?(?:working on|working|running|exporting|generating|building|preparing|processing|checking|investigating|researching|drafting|writing|putting together)\b|\b(?:will|going to|about to)\s+(?:report|send|share|finish|follow up|come back)\b|\b(?:in progress|on it now|working on it)\b|(?:正在|还在|仍在)(?:导出|生成|处理|整理|制作|编写|准备|检查|调查|运行|执行|做|写|搜索|分析)|(?:稍后|待会|马上|一会儿|等下)(?:汇报|回复|发|给你|回来|完成)|进行中|处理中|马上回来/

export function announcesWork(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  return trimmed !== '' && !DONE.test(trimmed) && IN_PROGRESS.test(trimmed)
}

// The marker data for one final reply, or undefined when there is nothing to mark.
// `worked` is whether the turn used any tool; `subagents` and `runningJobs` are the
// work still going on for the same Session when the turn ended.
export function claimsFor({ text, base, worked = false, subagents = false, runningJobs = 0 } = {}) {
  const claims = {}
  const missingFiles = missingFileRefs(text, base)
  if (missingFiles.length > 0) claims.missingFiles = missingFiles
  if (!worked && !subagents && runningJobs === 0 && announcesWork(text)) claims.inProgress = true
  return Object.keys(claims).length > 0 ? claims : undefined
}
