// Memory as text: the entry and file format (Agent Memory Repo), and the checks an
// entry passes. Nothing here touches the disk.
import { createHash, randomBytes } from 'node:crypto'

// Sizes, in characters of entry text: metadata does not count. Each MEMORY.md rides in
// every request of a conversation, so its size is what a scope may always have in view;
// the user can change these three (prefs.memoryLimits). A topic is read whole in one
// recall. An entry holds one fact.
export const MEMORY_LIMITS = { entry: 300, group: 12_000, bot: 8_000, team: 4_000, topic: 16_000, topics: 40 }
// What one MEMORY.md may take of the model's window, however large the size is set.
export const WINDOW_SHARE = 0.02

export const MAIN = 'MEMORY.md'
// Where the team's entries wait for whoever needs them. MEMORY.md is for what every Bot
// must always have in view, and only the user puts things there.
export const TEAM_SHARED = 'shared'
export const EMPTY_MAIN = '# Memory\n\n## Index\n'
export const INDEX = /^##\s+index\s*$/i
export const HEADING = /^#{1,6}\s/
const META = /\s*\[([A-Za-z][\w-]*:[^\];]*(?:;\s*[A-Za-z][\w-]*:[^\];]*)*)\]\s*$/

// A change whose entry is gone; any other failure keeps the review's place.
export const NO_MATCH = 'memory/no-match'
export const GONE = 'memory/bot-gone'
export const DENIED = 'memory/denied'
// The codes the memory review routes on. A failure that carries one keeps it.
export const ROUTED = new Set([NO_MATCH, GONE, DENIED])
// What a review shows of memory, in characters of entry text.
export const REVIEW_MEMORY_MAX = 16_000

export function splitMeta(body) {
  const found = META.exec(body)
  if (found === null) return { text: body.trim(), meta: {} }
  const meta = {}
  for (const pair of found[1].split(';')) {
    const at = pair.indexOf(':')
    const key = pair.slice(0, at).trim().toLowerCase()
    if (key !== '') meta[key] = pair.slice(at + 1).trim()
  }
  return { text: body.slice(0, found.index).trim(), meta }
}

const metaValue = value => String(value ?? '').replace(/[;[\]\n]/g, ' ').replace(/\s+/g, ' ').trim()
export const bodySize = parsed => parsed.entries.reduce((sum, entry) => sum + entry.text.length, 0)

// An entry is named by a short id. One saved before ids has none in its file, and its
// text gives it one that stays the same as long as the text does.
export const entryId = entry => entry.meta?.id ?? createHash('sha256').update(squash(entry.text)).digest('hex').slice(0, 4)
export function newEntryId(entries) {
  const taken = new Set(entries.map(entryId))
  for (;;) {
    const id = randomBytes(2).toString('hex')
    if (!taken.has(id)) return id
  }
}
// A topic's navigation note is separate from its entries.
const ABOUT_MAX = 60
export function topicAbout(parsed) {
  const note = parsed.lines.find(line => /^>\s*\S/.test(line))?.replace(/^>\s*/, '') ?? ''
  return note.length > ABOUT_MAX ? `${note.slice(0, ABOUT_MAX)}…` : note
}

export const isPinned = entry => Boolean(entry.meta?.pinned)
const DAY = /^\d{4}-\d{2}-\d{2}$/
export const cleanDay = raw => (DAY.test(String(raw ?? '').trim()) ? String(raw).trim() : undefined)
export const isExpired = (entry, today) => DAY.test(String(entry.meta?.until ?? '')) && entry.meta.until < today

// An entry as the prompt shows it: its id and the day it was saved. recall shows the rest.
export function promptEntry(entry) {
  const day = /^\d{4}-(\d{2}-\d{2})$/.exec(String(entry.meta?.added ?? ''))?.[1]
  return `- ${entry.text} [${[entryId(entry), day].filter(Boolean).join(' · ')}]`
}

// The entries a window has room for, newest kept, shown in their own order.
export function fitWindow(entries, tokens, measure) {
  if (tokens === undefined) return { shown: entries, left: 0 }
  const order = entries.map((entry, at) => ({ entry, at })).sort((a, b) => Number(isPinned(b.entry)) - Number(isPinned(a.entry)) || String(b.entry.meta?.added ?? '').localeCompare(String(a.entry.meta?.added ?? '')) || b.at - a.at)
  const kept = new Set()
  let used = 0
  for (const { entry } of order) {
    const cost = measure(promptEntry(entry))
    if (used + cost > tokens) continue
    used += cost
    kept.add(entry)
  }
  return { shown: entries.filter(entry => kept.has(entry)), left: entries.length - kept.size }
}

export function formatEntry(text, meta = {}) {
  const pairs = Object.entries(meta).filter(([, value]) => metaValue(value) !== '').map(([key, value]) => `${key}: ${metaValue(value)}`)
  return `- ${text}${pairs.length > 0 ? ` [${pairs.join('; ')}]` : ''}`
}

// One line, without a bullet or metadata of its own: the tool adds those.
export function cleanEntry(raw) {
  const line = String(raw ?? '').replace(/\s+/g, ' ').trim().replace(/^(?:[-*•]\s+)+/, '')
  return splitMeta(line).text
}

// A flat file name: case folds on some file systems, so names are lower case.
export function cleanTopic(raw) {
  const name = String(raw ?? '').trim().replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '').trim().toLowerCase().replace(/\s+/g, '-')
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u.test(name) && name !== 'memory' ? name : undefined
}

// Bullets outside `## Index` are entries; the Index holds [[links]]. Other lines
// (titles, notes the user wrote by hand) are kept as they are.
export function parseMemory(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
  const entries = []
  const links = []
  let inIndex = false
  lines.forEach((line, index) => {
    if (HEADING.test(line)) {
      inIndex = INDEX.test(line.trim())
      return
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet === null) return
    if (inIndex) {
      for (const match of bullet[1].matchAll(/\[\[([^\]]+)\]\]/g)) links.push(match[1].trim())
      return
    }
    const { text, meta } = splitMeta(bullet[1])
    if (text !== '') entries.push({ line: index, text, meta })
  })
  return { lines, entries, links }
}

export const joinLines = lines => `${lines.join('\n')}\n`

// A new entry goes after the last one above `## Index`, or at the end of a topic.
export function insertEntry(lines, line) {
  const index = lines.findIndex(item => INDEX.test(item.trim()))
  const end = index === -1 ? lines.length : index
  let at = end
  while (at > 0 && lines[at - 1].trim() === '') at -= 1
  const head = lines.slice(0, at)
  if (head.length > 0 && HEADING.test(head.at(-1))) head.push('')
  const tail = lines.slice(end)
  return [...head, line, ...(tail.length > 0 ? ['', ...tail] : [])]
}

export function addLink(lines, topic) {
  const next = [...lines]
  let index = next.findIndex(item => INDEX.test(item.trim()))
  if (index === -1) {
    if (next.length > 0) next.push('')
    next.push('## Index')
    index = next.length - 1
  }
  let end = next.findIndex((item, at) => at > index && HEADING.test(item))
  if (end === -1) end = next.length
  let at = end
  while (at > index + 1 && next[at - 1].trim() === '') at -= 1
  next.splice(at, 0, `- [[${topic}]]`)
  return next
}

export function removeLink(lines, topic) {
  return lines.filter(line => !/^\s*[-*]\s+\[\[([^\]]+)\]\]\s*$/.test(line) || /\[\[([^\]]+)\]\]/.exec(line)[1].trim() !== topic)
}

export const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

// The entry a request means: the one with that exact text, else every entry that
// contains it.
export function matchEntries(entries, wanted) {
  const key = squash(cleanEntry(wanted))
  if (key === '') return []
  const named = entries.find(entry => entry.meta?.id === key || (/^[0-9a-f]{4}$/.test(key) && entryId(entry) === key))
  if (named !== undefined) return [named]
  const exact = entries.find(entry => squash(entry.text) === key)
  if (exact !== undefined) return [exact]
  return entries.filter(entry => squash(entry.text).includes(key))
}

const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
]
// Known key formats, or a long unbroken run of mixed-case letters and digits outside a
// link. Separators break runs, so paths and names-with-dashes stay; a document id in
// a URL looks like a key and is worth keeping.
export function looksLikeKey(text) {
  if (KEY_PATTERNS.some(pattern => pattern.test(text))) return true
  const bare = text.replace(/\bhttps?:\/\/\S+/g, ' ')
  return (bare.match(/[A-Za-z0-9+=]{32,}/g) ?? []).some(run => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run))
}

// "password … is x": a password word (or PIN, passcode, 验证码…), a few words naming whose or where ("for
// root", "of the staging box", "的"), then the verb that gives its value.
// "Password manager", "password policy", and words such as 因为 or 作为 give none.
const PASSWORD_GIVEN = /(?:密码(?!管理|策略|规则)|口令|验证码|校验码|\bpassw(?:or)?d\b(?!\s*(?:managers?|polic(?:y|ies)|rules?|resets?|strength|less)\b)|\bpwd\b|\bpin(?: code)?\b|\bpass(?:code|phrase)\b|\b(?:otp|cvv|cvc)\b|\b(?:security|verification) code\b)[^\n.。;；,，]{0,40}?(?:是|(?<![因作认成以行])为|还是|改成|改为|换成|设为|设成|用(?![户于来途])(?!\s*\S+\s*(?:管理|保存|存|记))|叫|:|：|=|\b(?:is|are|was|remains|stays|becomes)\b|\b(?:set|changed) to\b)\s*\S/i
// The value first, perhaps several words: "uses correct horse battery staple as the
// root password", "我用 hunter2 当密码".
const PASSWORD_AFTER = /(?:\b(?:use[sd]?|using|set|sets|chose|chosen|picked|picks)\s+(?:[^\s,.;]+\s+){1,8}?(?:as|for)\s+(?:[\w'-]+\s+){0,3}?(?:passw(?:or)?d\b(?!\s*(?:managers?|polic(?:y|ies)|rules?|resets?|strength|fields?|prompts?|screens?|box(?:es)?)\b)|pwd\b|pin\b(?!\s*(?:pads?|entry|fields?|prompts?|screens?)\b)|pass(?:code|phrase)\b|otp\b)|用(?![户于来途])[^\n,，。;；]{1,40}?(?:当作?|作为?|做)\s*\S{0,6}?(?:密码(?!管理)|口令|验证码))/i
// An ID number under its label: "SSN 123-45-6789", "passport number is A12345678",
// "护照号 E12345678". Dates are no ID.
const ID_GIVEN = /(?:\bssn\b|\bsocial security\b|\bpassport\b|\btax (?:id|number)\b|\bdriver'?s licen[cs]e\b|\bnational (?:id|insurance)\b|\bid (?:card|number)\b|护照|身份证|社保|税号|驾驶证|驾照)[^\n.。;；,，]{0,30}?(?<![A-Za-z0-9-])(?!\d{4}-\d{1,2}-\d{1,2}(?!\d))[a-z]{0,2}\d[\d -]{4,}\d/i

// A key, a password given as one ("the root password is …"), a short ID number under
// its label, or an ID or card number: 15 digits or more in a row, outside a link. Spaces between digits and hyphens
// between groups of three digits or more are read through; a date's two-digit groups
// keep two dates apart.
export function looksSecret(text) {
  if (looksLikeKey(text)) return true
  if (PASSWORD_GIVEN.test(text) || PASSWORD_AFTER.test(text) || ID_GIVEN.test(text)) return true
  return /\d{15,}/.test(text.replace(/\bhttps?:\/\/\S+/g, ' ').replace(/(?<=\d) (?=\d)/g, '').replace(/(?<=\d{3})-(?=\d{3})/g, ''))
}

// The answer of the memory panel's model: {"reply": …, "changes": […]}, perhaps in a
// code fence; anything else is a reply with no changes.
export function parseAsk(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1))
      if (value !== null && typeof value === 'object') {
        return { reply: String(value.reply ?? '').trim(), changes: Array.isArray(value.changes) ? value.changes : [] }
      }
    } catch { /* not JSON: the text is the reply */ }
  }
  return { reply: text.trim(), changes: [] }
}

// Words to compare by: Latin words of three letters or more, and pairs of Han
// characters, which Chinese writes without spaces.
export const wordsOf = (text) => {
  const lower = squash(text)
  const words = new Set(lower.match(/[a-z0-9]{3,}/g) ?? [])
  for (const run of lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []) for (let at = 0; at + 1 < run.length; at += 1) words.add(run.slice(at, at + 2))
  return words
}

// What the review shows of memory: both MEMORY.md files whole, then topic entries
// while they fit, those sharing words with `about` (the user's new lines) first so
// the model can correct them, then the newest. Topics can hold far more than a
// model's window. `home` is the memory the review writes, tagged `tag`: a Bot's own,
// or a group's.
export function reviewEntries(home, team, budget = REVIEW_MEMORY_MAX, about = '', tag = 'own') {
  const tagged = (files, scope) => files.flatMap(file => file.entries.map(entry => ({ ...entry, file, scope })))
  const main = [...tagged(home.slice(0, 1), tag), ...tagged(team.slice(0, 1), 'team')]
  const topics = [...tagged(home.slice(1), tag), ...tagged(team.slice(1), 'team')]
  let used = main.reduce((sum, entry) => sum + entry.text.length, 0)
  const asked = wordsOf(about)
  const shared = entry => [...wordsOf(`${entry.text} ${entry.file.topic ?? ''}`)].filter(word => asked.has(word)).length
  const newest = topics.map((entry, at) => ({ entry, at, score: shared(entry) }))
    .sort((a, b) => b.score - a.score || String(b.entry.meta?.added ?? '').localeCompare(String(a.entry.meta?.added ?? '')) || a.at - b.at)
  const shown = new Set()
  // One entry too long for what is left does not keep out shorter ones after it.
  for (const { entry } of newest) {
    if (used + entry.text.length > budget) continue
    used += entry.text.length
    shown.add(entry)
  }
  return { numbered: [...main, ...topics.filter(entry => shown.has(entry))], left: topics.length - shown.size }
}

// The memory review's answer: {"changes": […]}, perhaps in a code fence. `changes`
// are the well-formed ones; `leftOut` the rest, so a malformed change does not
// take the whole answer down — it is set aside and said, and the well-formed ones
// are saved. Anything else is no answer: the review says so and moves on — the
// same lines are not read again.
export function parseReview(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let value
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || !Array.isArray(value.changes)) return undefined
  const changes = []
  const leftOut = []
  for (const change of value.changes) (wellFormed(change) ? changes : leftOut).push(change)
  return { changes, leftOut }
}
const wellFormed = (change) => {
  if (change === null || typeof change !== 'object') return false
  const texted = typeof change.text === 'string' && change.text.trim() !== ''
  const numbered = Number.isInteger(Number(change.entry)) && Number(change.entry) >= 1
  if (change.op === 'add') return texted && (change.topic === undefined || typeof change.topic === 'string') && (change.team === undefined || typeof change.team === 'boolean') && (change.for === undefined || typeof change.for === 'string') && (change.group === undefined || typeof change.group === 'string') && (change.until === undefined || typeof change.until === 'string')
  if (change.op === 'edit') return texted && numbered
  return change.op === 'remove' && numbered
}
