// Claims: what a Bot's final reply says it did or is doing, checked against the computer.
// A reply that links to a local file which is not there, or announces work while no tool,
// background job, subagent or group handoff is running, gets a marker on the group message.
// The marker is only for the reader: nothing is retried, resent or reworded.
//
// Only deliberate Markdown file links (`[label](path)`) are checked against disk. Inline
// code and plain prose paths often name deleted files, missing files in diagnostics, or
// example commands, so treating them as existence promises would misreport real replies.
import { statSync } from 'node:fs'
import { fileLinks } from './links.js'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const GLOB = /[*?[\]{}]/
const LINE_COL = /:\d+(?::\d+)?$/
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g

const expandHome = path => (path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path)

const existsOnDisk = (path) => {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined
  } catch {
    return true
  }
}

// The local paths a reply links to, decoded as the chat opens them, in appearance order.
// Folder links (ending in `/` or `\`) and globs are not checked.
export function fileRefs(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = []
  const seen = new Set()
  for (const raw of fileLinks(text)) {
    const path = raw.trim()
    if (path === '' || path === '~' || path.endsWith('/') || path.endsWith('\\') || GLOB.test(path)) continue
    const key = path.replace(/\\/g, '/')
    if (seen.has(key)) continue
    seen.add(key)
    found.push(path)
  }
  return found
}

// The linked local paths that are not on disk, as decoded from the link. A path that
// exists (including `[foo.js](src/foo.js:42)` with a line suffix) is never reported.
export function missingFileRefs(text, base = process.cwd()) {
  const missing = []
  const seen = new Set()
  for (const raw of fileRefs(text)) {
    const path = resolve(base, expandHome(raw))
    if (seen.has(path)) continue
    seen.add(path)
    if (existsOnDisk(path)) continue
    if (LINE_COL.test(raw)) {
      const stripped = raw.replace(LINE_COL, '')
      if (stripped !== '' && !/^[a-z]:$/i.test(stripped) && existsOnDisk(resolve(base, expandHome(stripped)))) continue
    }
    missing.push(raw)
  }
  return missing
}

// English and Chinese phrases that announce work in progress. Within each sentence, only
// what comes after the last completion phrase counts: "was checking earlier, now completed"
// is done, whereas "part 1 completed, still exporting part 2" still announces ongoing work.
const AFTER_DONE = /^[\s\S]*(?:已完成|已经完成|完成了|已导出|已生成|已保存|做好了|搞定|finished|completed|here (?:is|are)\b)/i
const IN_PROGRESS = /\b(?:i(?:'m| am)|we(?:'re| are)|still|currently)\s+(?:still\s+)?(?:working on|working|running|exporting|generating|building|preparing|processing|checking|investigating|researching|drafting|writing|putting together)\b|\b(?:will|going to|about to)\s+(?:report|send|share|finish|follow up|come back)\b|\b(?:in progress|on it now|working on it)\b|(?:正在|还在|仍在)(?:导出|生成|处理|整理|制作|编写|准备|检查|调查|运行|执行|做|写|搜索|分析)|(?:稍后|待会|马上|一会儿|等下)(?:汇报|回复|发|给你|回来|完成)|进行中|处理中|马上回来/

export function announcesWork(text) {
  if (typeof text !== 'string') return false
  const prose = text.split(CODE).filter((_, index) => index % 2 === 0).join(' ').trim()
  if (prose === '') return false
  return prose.split(/[\r\n。！？!?；;]+/).some((sentence) => {
    const tail = sentence.replace(AFTER_DONE, '').trim()
    return tail !== '' && IN_PROGRESS.test(tail)
  })
}

// The marker data for one final reply, or undefined when there is nothing to mark.
// `worked` is whether the turn used any tool; `subagents` and `runningJobs` are the
// work still going on for the same Session when the turn ended; `calledPeer` is true
// when the reply handed work to another member in the group (`@Name`).
export function claimsFor({ text, base, worked = false, subagents = false, runningJobs = 0, calledPeer = false } = {}) {
  const claims = {}
  const missingFiles = missingFileRefs(text, base)
  if (missingFiles.length > 0) claims.missingFiles = missingFiles
  if (!worked && !subagents && runningJobs === 0 && !calledPeer && announcesWork(text)) claims.inProgress = true
  return Object.keys(claims).length > 0 ? claims : undefined
}
