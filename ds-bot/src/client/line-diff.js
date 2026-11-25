// A line diff for the Side Apps' Changes view. Pure: two texts in, rows out.
export const DIFF_LINES_MAX = 5000
export const DIFF_CHARS_MAX = 1024 * 1024
const CONTEXT = 3

const linesOf = text => {
  const list = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  if (list.length > 0 && list.at(-1) === '') list.pop()
  return list
}

/**
 * Rows of `{ kind: 'same'|'add'|'del', text, from, to }` turning `before` into `after`;
 * `from`/`to` are 1-based line numbers on each side (null where the line is absent).
 * @returns {{rows: object[], added: number, removed: number}|{tooLarge: true}}
 */
export function diffLines(before, after) {
  if (String(before ?? '').length > DIFF_CHARS_MAX || String(after ?? '').length > DIFF_CHARS_MAX) return { tooLarge: true }
  const a = linesOf(before)
  const b = linesOf(after)
  if (a.length > DIFF_LINES_MAX || b.length > DIFF_LINES_MAX) return { tooLarge: true }
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const n = midA.length
  const m = midB.length
  // Longest common subsequence of the differing middle, from the back so the walk runs forward.
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const rows = []
  for (let i = 0; i < head; i += 1) rows.push({ kind: 'same', text: a[i], from: i + 1, to: i + 1 })
  let i = 0
  let j = 0
  let added = 0
  let removed = 0
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      rows.push({ kind: 'same', text: midA[i], from: head + i + 1, to: head + j + 1 })
      i += 1
      j += 1
    } else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) {
      // Removed lines come before the added ones that replace them.
      rows.push({ kind: 'del', text: midA[i], from: head + i + 1, to: null })
      removed += 1
      i += 1
    } else {
      rows.push({ kind: 'add', text: midB[j], from: null, to: head + j + 1 })
      added += 1
      j += 1
    }
  }
  for (let k = 0; k < tail; k += 1) rows.push({ kind: 'same', text: a[a.length - tail + k], from: a.length - tail + k + 1, to: b.length - tail + k + 1 })
  return { rows, added, removed }
}

/**
 * Fold runs of unchanged lines longer than the context on both sides into
 * `{ kind: 'fold', count, rows }`; `open` holds the indexes of folds the user opened.
 */
export function foldRows(rows, open = new Set()) {
  const out = []
  let at = 0
  while (at < rows.length) {
    if (rows[at].kind !== 'same') { out.push(rows[at]); at += 1; continue }
    let end = at
    while (end < rows.length && rows[end].kind === 'same') end += 1
    const run = rows.slice(at, end)
    const lead = at === 0 ? 0 : CONTEXT
    const trail = end === rows.length ? 0 : CONTEXT
    const hidden = run.length - lead - trail
    const id = out.length + lead
    if (hidden <= 1 || open.has(id)) out.push(...run)
    else {
      out.push(...run.slice(0, lead))
      out.push({ kind: 'fold', count: hidden, id, rows: run.slice(lead, run.length - trail) })
      out.push(...run.slice(run.length - trail))
    }
    at = end
  }
  return out
}

/** The numbers `3 changes` counts: separate runs of added or removed lines. */
export function changeRuns(rows) {
  let runs = 0
  let inside = false
  for (const row of rows) {
    const changed = row.kind !== 'same'
    if (changed && !inside) runs += 1
    inside = changed
  }
  return runs
}
