// Linear-space Myers O(ND) line diff with Patience unique-line anchoring for very large
// files and hunk-based folding (no hard line cap; never silently drops content).

// Maximum per-subproblem edit distance before splitting a giant unrelated chunk.
// At 1500 edits, a single middle-snake pass stays well under a few milliseconds while
// keeping exact optimal Myers alignment for realistic large diffs (including >200x200).
const MAX_MYERS_D = 1500
const ANCHOR_THRESHOLD = 1000

// Keep line terminators attached to each token so adding/removing a trailing newline
// produces an exact diff rather than looking identical to an unchanged file.
function splitLineTokens(text) {
  if (text === null || text === undefined || text === '') return []
  const tokens = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      tokens.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) tokens.push(text.slice(start))
  return tokens
}

const tokenText = token => (token.endsWith('\n') ? token.slice(0, -1) : token)
const tokenNoNewline = token => !token.endsWith('\n')

function makeDiffRow(kind, token, nums, showNoNewline = false) {
  return {
    kind,
    ...nums,
    text: tokenText(token),
    ...(showNoNewline && kind !== 'ctx' && tokenNoNewline(token) ? { noNewline: true } : {}),
  }
}

// Finds longest increasing subsequence of unique lines present exactly once in both ranges
// (Patience diff anchors) to partition huge inputs into small independent Myers subproblems.
function findUniqueAnchors(a, a0, a1, b, b0, b1) {
  const countA = new Map()
  for (let i = a0; i < a1; i += 1) {
    const line = a[i]
    countA.set(line, countA.has(line) ? -1 : i)
  }
  const countB = new Map()
  for (let j = b0; j < b1; j += 1) {
    const line = b[j]
    if (!countA.has(line) || countA.get(line) < 0) continue
    countB.set(line, countB.has(line) ? -1 : j)
  }
  const pairs = []
  for (let j = b0; j < b1; j += 1) {
    const line = b[j]
    if (countB.get(line) !== j) continue
    const ai = countA.get(line)
    if (ai >= 0) pairs.push([ai, j])
  }
  if (pairs.length === 0) return []

  // LIS on ai (j is already strictly increasing).
  const tails = []
  const tailPairIdx = []
  const prev = new Int32Array(pairs.length).fill(-1)
  for (let idx = 0; idx < pairs.length; idx += 1) {
    const val = pairs[idx][0]
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < val) lo = mid + 1
      else hi = mid
    }
    tails[lo] = val
    tailPairIdx[lo] = idx
    if (lo > 0) prev[idx] = tailPairIdx[lo - 1]
  }
  const anchors = []
  let cur = tailPairIdx[tails.length - 1]
  while (cur !== -1) {
    anchors.push(pairs[cur])
    cur = prev[cur]
  }
  anchors.reverse()
  return anchors
}

// Finds the middle snake of Myers' O(ND) linear-space algorithm for a[a0..a1) vs b[b0..b1).
// Returns `{ x, y, u, v }` in local coordinates (0..n, 0..m) or `null` if edit distance > maxD.
function findMiddleSnake(a, a0, a1, b, b0, b1, maxD) {
  const n = a1 - a0
  const m = b1 - b0
  const delta = n - m
  const odd = (delta & 1) !== 0
  const half = Math.min(Math.ceil((n + m) / 2), maxD)
  const size = 2 * half + 3
  const offset = half + 1
  const vf = new Int32Array(size)
  const vb = new Int32Array(size)
  vf[offset + 1] = 0
  vb[offset + 1] = 0

  for (let d = 0; d <= half; d += 1) {
    // Forward pass.
    for (let k = -d; k <= d; k += 2) {
      const idx = offset + k
      let x
      if (k === -d || (k !== d && vf[idx - 1] < vf[idx + 1])) {
        x = vf[idx + 1]
      } else {
        x = vf[idx - 1] + 1
      }
      let y = x - k
      const startX = x
      const startY = y
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x += 1
        y += 1
      }
      vf[idx] = x
      if (odd) {
        const backK = delta - k
        if (backK >= -(d - 1) && backK <= d - 1) {
          const bx = n - vb[offset + backK]
          if (x >= bx) {
            return { x: startX, y: startY, u: x, v: y }
          }
        }
      }
    }

    // Backward pass.
    for (let k = -d; k <= d; k += 2) {
      const idx = offset + k
      let bx
      if (k === -d || (k !== d && vb[idx - 1] < vb[idx + 1])) {
        bx = vb[idx + 1]
      } else {
        bx = vb[idx - 1] + 1
      }
      let by = bx - k
      const startBx = bx
      const startBy = by
      while (bx < n && by < m && a[a1 - 1 - bx] === b[b1 - 1 - by]) {
        bx += 1
        by += 1
      }
      vb[idx] = bx
      if (!odd) {
        const fwdK = delta - k
        if (fwdK >= -d && fwdK <= d) {
          const fx = vf[offset + fwdK]
          const rx = n - bx
          if (fx >= rx) {
            return { x: rx, y: m - by, u: n - startBx, v: m - startBy }
          }
        }
      }
    }
  }
  return null
}

function diffRange(a, a0, a1, b, b0, b1, out, showNoNewline) {
  // Trim common prefix & suffix iteratively to minimize recursion depth.
  let sA = a0
  let eA = a1
  let sB = b0
  let eB = b1

  while (sA < eA && sB < eB && a[sA] === b[sB]) {
    out.push(makeDiffRow('ctx', a[sA], { oldNum: sA + 1, newNum: sB + 1 }))
    sA += 1
    sB += 1
  }

  let suffix = 0
  while (sA < eA - suffix && sB < eB - suffix && a[eA - 1 - suffix] === b[eB - 1 - suffix]) {
    suffix += 1
  }
  const midEA = eA - suffix
  const midEB = eB - suffix

  const n = midEA - sA
  const m = midEB - sB

  if (n === 0) {
    for (let j = sB; j < midEB; j += 1) {
      out.push(makeDiffRow('add', b[j], { newNum: j + 1 }, showNoNewline))
    }
  } else if (m === 0) {
    for (let i = sA; i < midEA; i += 1) {
      out.push(makeDiffRow('del', a[i], { oldNum: i + 1 }, showNoNewline))
    }
  } else {
    // For very large spans, anchor on unique matching lines first to partition cleanly.
    const anchors = n + m >= ANCHOR_THRESHOLD ? findUniqueAnchors(a, sA, midEA, b, sB, midEB) : []
    if (anchors.length > 0) {
      let curA = sA
      let curB = sB
      for (const [ai, bj] of anchors) {
        if (ai > curA || bj > curB) diffRange(a, curA, ai, b, curB, bj, out, showNoNewline)
        out.push(makeDiffRow('ctx', a[ai], { oldNum: ai + 1, newNum: bj + 1 }))
        curA = ai + 1
        curB = bj + 1
      }
      if (curA < midEA || curB < midEB) diffRange(a, curA, midEA, b, curB, midEB, out, showNoNewline)
    } else {
      const snake = findMiddleSnake(a, sA, midEA, b, sB, midEB, MAX_MYERS_D)
      if (snake === null) {
        // Edit distance exceeds single-pass budget on completely dissimilar giant blocks:
        // emit all removed then added lines without dropping a single line.
        for (let i = sA; i < midEA; i += 1) {
          out.push(makeDiffRow('del', a[i], { oldNum: i + 1 }, showNoNewline))
        }
        for (let j = sB; j < midEB; j += 1) {
          out.push(makeDiffRow('add', b[j], { newNum: j + 1 }, showNoNewline))
        }
      } else {
        const { x, y, u, v } = snake
        if (x > 0 || y > 0) diffRange(a, sA, sA + x, b, sB, sB + y, out, showNoNewline)
        for (let k = 0; k < u - x; k += 1) {
          out.push(makeDiffRow('ctx', a[sA + x + k], { oldNum: sA + x + k + 1, newNum: sB + y + k + 1 }))
        }
        if (u < n || v < m) diffRange(a, sA + u, midEA, b, sB + v, midEB, out, showNoNewline)
      }
    }
  }

  for (let k = 0; k < suffix; k += 1) {
    const oi = midEA + k
    const ni = midEB + k
    out.push(makeDiffRow('ctx', a[oi], { oldNum: oi + 1, newNum: ni + 1 }))
  }
}

/**
 * Computes an exact line diff using linear-space Myers O(ND) with Patience anchoring
 * for very large inputs. Never silently drops lines or hits a 200x200 DP wall.
 * @param {string | null} oldText
 * @param {string} newText
 * @returns {{ rows: Array<{ kind: 'ctx'|'add'|'del', oldNum?: number, newNum?: number, text: string, noNewline?: boolean }>, added: number, removed: number }}
 */
export function computeLineDiff(oldText, newText) {
  const before = oldText === null ? [] : splitLineTokens(oldText)
  const after = splitLineTokens(newText)
  const showNoNewline = oldText !== null && oldText.length > 0 && newText.length > 0
    && oldText.endsWith('\n') !== newText.endsWith('\n')

  if (before.length === 0 && after.length === 0) return { rows: [], added: 0, removed: 0 }
  if (before.length === 0) {
    return {
      rows: after.map((tok, index) => makeDiffRow('add', tok, { newNum: index + 1 })),
      added: after.length,
      removed: 0,
    }
  }
  if (after.length === 0) {
    return {
      rows: before.map((tok, index) => makeDiffRow('del', tok, { oldNum: index + 1 })),
      added: 0,
      removed: before.length,
    }
  }

  const rows = []
  diffRange(before, 0, before.length, after, 0, after.length, rows, showNoNewline)
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.kind === 'add') added += 1
    else if (row.kind === 'del') removed += 1
  }
  return { rows, added, removed }
}

/**
 * Groups flat diff rows into visible change hunks (with `context` unchanged lines around
 * every edit) separated by expandable unchanged gaps.
 * @param {Array<{ kind: 'ctx'|'add'|'del', oldNum?: number, newNum?: number, text: string, noNewline?: boolean }>} rows
 * @param {{ context?: number }} [options]
 * @returns {Array<{ type: 'hunk', id: string, start: number, end: number } | { type: 'gap', id: string, start: number, end: number, count: number, oldStart?: number, newStart?: number }>}
 */
export function buildDiffHunks(rows, { context = 3 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  const changeRanges = []
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].kind === 'ctx') continue
    const start = Math.max(0, i - context)
    const end = Math.min(rows.length, i + context + 1)
    const last = changeRanges[changeRanges.length - 1]
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
    } else {
      changeRanges.push({ start, end })
    }
  }

  if (changeRanges.length === 0) {
    return [{ type: 'hunk', id: 'h:0', start: 0, end: rows.length }]
  }

  const blocks = []
  let cursor = 0
  for (let idx = 0; idx < changeRanges.length; idx += 1) {
    const { start, end } = changeRanges[idx]
    if (start > cursor) {
      // Avoid emitting a 1-line gap divider when the divider itself takes a full row.
      if (start - cursor === 1 && blocks.length > 0 && blocks[blocks.length - 1].type === 'hunk') {
        blocks[blocks.length - 1].end = end
        cursor = end
        continue
      }
      blocks.push({
        type: 'gap',
        id: `g:${cursor}:${start}`,
        start: cursor,
        end: start,
        count: start - cursor,
        oldStart: rows[cursor]?.oldNum,
        newStart: rows[cursor]?.newNum,
      })
    }
    blocks.push({ type: 'hunk', id: `h:${start}:${end}`, start, end })
    cursor = end
  }
  if (cursor < rows.length) {
    if (rows.length - cursor === 1 && blocks.length > 0 && blocks[blocks.length - 1].type === 'hunk') {
      blocks[blocks.length - 1].end = rows.length
    } else {
      blocks.push({
        type: 'gap',
        id: `g:${cursor}:${rows.length}`,
        start: cursor,
        end: rows.length,
        count: rows.length - cursor,
        oldStart: rows[cursor]?.oldNum,
        newStart: rows[cursor]?.newNum,
      })
    }
  }
  return blocks
}
