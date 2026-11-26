// Exact UTF-8 byte-budget calculation and deterministic history trimming for
// conversation handoff packages and CLI replay prompts.
//
// Formula (derived dynamically from the target model's context window):
//   availableBytes = max(0, targetWindowBytes - nativeUsedBytes - currentTurnBytes - attachmentAllowanceBytes - workReserveBytes)
//
// Invariant: the user's newest/current turn and its attachments are NEVER
// truncated or dropped, even when availableBytes === 0. Older history and
// lower-priority tool snippets are trimmed deterministically oldest-first,
// and any individual overly long historical entry is cut at a clean UTF-8
// code-point boundary (never splitting surrogate pairs or multi-byte chars).

export const DEFAULT_BYTES_PER_TOKEN = 3.5
export const DEFAULT_WORK_RESERVE_RATIO = 0.25
export const DEFAULT_MIN_WORK_RESERVE_BYTES = 16 * 1024
export const DEFAULT_ATTACHMENT_ALLOWANCE_BYTES = 4 * 1024
export const DEFAULT_MAX_ENTRY_BYTES = 12 * 1024

const nonNegative = (value, fallback = 0) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
)

export const utf8Bytes = text => Buffer.byteLength(String(text ?? ''), 'utf8')

// Truncates `text` to at most `maxBytes` UTF-8 bytes without splitting any
// UTF-16 surrogate pair or multi-byte UTF-8 sequence.
export function truncateUtf8Bytes(text, maxBytes, suffix = '…') {
  const str = String(text ?? '')
  if (maxBytes === Infinity) return str
  const limit = Math.floor(nonNegative(maxBytes, 0))
  if (limit === 0 || str === '') return ''
  if (Buffer.byteLength(str, 'utf8') <= limit) return str

  const tail = String(suffix ?? '')
  const tailBytes = Buffer.byteLength(tail, 'utf8')
  if (limit <= tailBytes) {
    // Fit as much of the suffix as possible on code-point boundaries, or empty.
    let out = ''
    let used = 0
    for (const ch of tail) {
      const size = Buffer.byteLength(ch, 'utf8')
      if (used + size > limit) break
      out += ch
      used += size
    }
    return out
  }

  const bodyBudget = limit - tailBytes
  // Every UTF-16 code unit encodes to at least 1 UTF-8 byte (surrogate pairs:
  // 2 code units -> 4 bytes; BMP: 1 code unit -> 1..3 bytes), so scanning at
  // most `bodyBudget + 1` code units always covers the cut point.
  const scanEnd = Math.min(str.length, bodyBudget + 1)
  let cut = 0
  let used = 0
  while (cut < scanEnd) {
    const code = str.charCodeAt(cut)
    const isSurrogatePair = code >= 0xD800 && code <= 0xDBFF && cut + 1 < str.length
      && str.charCodeAt(cut + 1) >= 0xDC00 && str.charCodeAt(cut + 1) <= 0xDFFF
    const step = isSurrogatePair ? 2 : 1
    const charBytes = isSurrogatePair ? 4 : code <= 0x7F ? 1 : code <= 0x7FF ? 2 : 3
    if (used + charBytes > bodyBudget) break
    used += charBytes
    cut += step
  }
  return `${str.slice(0, cut)}${tail}`
}

// Counts image/non-text attachment blocks across a list of DSH messages.
export function countMessageAttachments(messages) {
  let count = 0
  for (const message of messages ?? []) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      if (block?.type === 'image' || block?.type === 'file' || block?.type === 'audio' || block?.type === 'document') {
        count += 1
      }
    }
  }
  return count
}

// Measures the UTF-8 byte size of the text payload across a list of DSH messages.
export function measureMessagesBytes(messages) {
  let total = 0
  for (const message of messages ?? []) {
    if (typeof message === 'string') {
      total += utf8Bytes(message)
      continue
    }
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      if (typeof block?.text === 'string') total += utf8Bytes(block.text)
    }
  }
  return total
}

// Computes the exact UTF-8 byte budget available for historical handoff content.
// Scales dynamically with `targetWindowTokens` (or explicit `targetWindowBytes`),
// subtracting native overhead, the preserved current turn, attachment allowance,
// and work reserve (clamped to at most half the window so tiny windows degrade
// gracefully instead of zeroing out prematurely).
export function computeHandoffBudget({
  targetWindowTokens,
  targetWindowBytes,
  bytesPerToken = DEFAULT_BYTES_PER_TOKEN,
  nativeUsedBytes,
  nativeUsedTokens = 0,
  currentTurnBytes = 0,
  attachmentCount = 0,
  attachmentAllowanceBytes,
  perAttachmentBytes = DEFAULT_ATTACHMENT_ALLOWANCE_BYTES,
  workReserveBytes,
  workReserveRatio = DEFAULT_WORK_RESERVE_RATIO,
  minWorkReserveBytes = DEFAULT_MIN_WORK_RESERVE_BYTES,
  maxHistoryBytes,
} = {}) {
  const ratio = typeof bytesPerToken === 'number' && Number.isFinite(bytesPerToken) && bytesPerToken > 0
    ? bytesPerToken : DEFAULT_BYTES_PER_TOKEN
  const windowBytes = targetWindowBytes !== undefined
    ? Math.floor(nonNegative(targetWindowBytes, 0))
    : Math.floor(nonNegative(targetWindowTokens, 0) * ratio)
  const nativeBytes = nativeUsedBytes !== undefined
    ? Math.floor(nonNegative(nativeUsedBytes, 0))
    : Math.floor(nonNegative(nativeUsedTokens, 0) * ratio)
  const turnBytes = Math.floor(nonNegative(currentTurnBytes, 0))
  const attachBytes = attachmentAllowanceBytes !== undefined
    ? Math.floor(nonNegative(attachmentAllowanceBytes, 0))
    : Math.floor(nonNegative(attachmentCount, 0) * nonNegative(perAttachmentBytes, DEFAULT_ATTACHMENT_ALLOWANCE_BYTES))

  let reserveBytes
  if (workReserveBytes !== undefined) {
    reserveBytes = Math.floor(nonNegative(workReserveBytes, 0))
  } else {
    const clampedRatio = typeof workReserveRatio === 'number' && Number.isFinite(workReserveRatio) && workReserveRatio >= 0 && workReserveRatio <= 1
      ? workReserveRatio : DEFAULT_WORK_RESERVE_RATIO
    const scaled = Math.floor(windowBytes * clampedRatio)
    const floor = Math.min(Math.floor(nonNegative(minWorkReserveBytes, DEFAULT_MIN_WORK_RESERVE_BYTES)), Math.floor(windowBytes * 0.5))
    reserveBytes = Math.max(scaled, floor)
  }

  const uncapped = Math.max(0, windowBytes - nativeBytes - turnBytes - attachBytes - reserveBytes)
  const availableBytes = maxHistoryBytes !== undefined
    ? Math.min(uncapped, Math.floor(nonNegative(maxHistoryBytes, 0)))
    : uncapped

  return {
    targetWindowBytes: windowBytes,
    nativeUsedBytes: nativeBytes,
    currentTurnBytes: turnBytes,
    attachmentAllowanceBytes: attachBytes,
    workReserveBytes: reserveBytes,
    availableBytes,
  }
}

const listBytes = (items, delimiterBytes) => {
  if (items.length === 0) return 0
  let total = 0
  for (let i = 0; i < items.length; i += 1) {
    total += utf8Bytes(items[i])
    if (i > 0) total += delimiterBytes
  }
  return total
}

// Trims historical handoff sections (`earlier`, `tools`, `recent`) to fit strictly
// within `availableBytes` UTF-8 bytes while preserving `currentTurn` verbatim.
//
// Priority order (trimmed lowest-priority first, oldest-first within each tier):
//   1. `earlier` (oldest anchored summaries)
//   2. `tools` (historical tool activity snippets)
//   3. `recent` (older verbatim turns before the preserved current turn)
//   4. Truncate a single remaining overly-long older `recent` entry on a UTF-8 boundary
export function fitHandoffHistory({
  currentTurn = [],
  recent = [],
  earlier = [],
  tools = [],
  availableBytes = 0,
  maxEntryBytes,
  delimiterBytes = 1,
} = {}) {
  const budget = Math.floor(nonNegative(availableBytes, 0))
  const sep = Math.floor(nonNegative(delimiterBytes, 1))
  const preserved = Array.isArray(currentTurn) ? [...currentTurn] : (currentTurn === '' || currentTurn == null ? [] : [String(currentTurn)])

  const hasEntryCap = maxEntryBytes !== undefined && maxEntryBytes !== null && maxEntryBytes !== Infinity
  const entryCap = hasEntryCap ? Math.floor(nonNegative(maxEntryBytes, 0)) : undefined

  const prepareList = (items) => {
    const kept = []
    let dropped = 0
    for (const item of items ?? []) {
      const str = String(item ?? '')
      if (!hasEntryCap || utf8Bytes(str) <= entryCap) {
        kept.push({ text: str, truncated: false })
        continue
      }
      const cut = truncateUtf8Bytes(str, entryCap)
      if (cut === '') {
        dropped += 1
        continue
      }
      kept.push({ text: cut, truncated: true })
    }
    return { kept, dropped }
  }

  const prepRecent = prepareList(recent)
  const prepEarlier = prepareList(earlier)
  const prepTools = prepareList(tools)
  const keptRecent = prepRecent.kept
  const keptEarlier = prepEarlier.kept
  const keptTools = prepTools.kept

  const entryListBytes = (items, delimiter) => {
    if (items.length === 0) return 0
    let total = 0
    for (let i = 0; i < items.length; i += 1) {
      total += utf8Bytes(items[i].text)
      if (i > 0) total += delimiter
    }
    return total
  }

  const totalBytes = () => {
    let sum = 0
    let sections = 0
    for (const list of [keptEarlier, keptTools, keptRecent]) {
      if (list.length === 0) continue
      sum += entryListBytes(list, sep)
      sections += 1
    }
    if (sections > 1) sum += (sections - 1) * sep
    return sum
  }

  let droppedEarlier = prepEarlier.dropped
  let droppedTools = prepTools.dropped
  let droppedRecent = prepRecent.dropped

  while (keptEarlier.length > 0 && totalBytes() > budget) {
    keptEarlier.shift()
    droppedEarlier += 1
  }
  while (keptTools.length > 0 && totalBytes() > budget) {
    keptTools.shift()
    droppedTools += 1
  }
  while (keptRecent.length > 1 && totalBytes() > budget) {
    keptRecent.shift()
    droppedRecent += 1
  }
  if (keptRecent.length === 1 && totalBytes() > budget) {
    if (budget === 0) {
      keptRecent.shift()
      droppedRecent += 1
    } else {
      const cut = truncateUtf8Bytes(keptRecent[0].text, budget)
      if (cut === '') {
        keptRecent.shift()
        droppedRecent += 1
      } else {
        keptRecent[0] = { text: cut, truncated: true }
      }
    }
  }

  const truncatedEntries = [...keptEarlier, ...keptTools, ...keptRecent].filter(item => item.truncated).length

  return {
    currentTurn: preserved,
    recent: keptRecent.map(item => item.text),
    earlier: keptEarlier.map(item => item.text),
    tools: keptTools.map(item => item.text),
    usedBytes: totalBytes(),
    currentTurnBytes: listBytes(preserved, sep),
    droppedRecent,
    droppedEarlier,
    droppedTools,
    truncatedEntries,
  }
}
