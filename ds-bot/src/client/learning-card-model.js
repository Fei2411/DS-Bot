export function proposalPlacement(proposal, turns) {
  if (!Number.isFinite(proposal?.at) || typeof turns?.values !== 'function') return { kind: 'dock' }
  let latest
  let before
  for (const location of turns.values()) {
    const end = location?.end?.time
    if (location?.status !== 'closed' || !Number.isFinite(end)) continue
    const later = target => target === undefined || end > target.end.time || (end === target.end.time && location.turn > target.turn)
    if (later(latest)) latest = location
    if (end <= proposal.at && later(before)) before = location
  }
  const turn = (before ?? latest)?.turn
  return turn === undefined ? { kind: 'dock' } : { kind: 'turn', turn }
}

export function fileLines(text) {
  const body = String(text ?? '').replace(/\n+$/, '')
  return body === '' ? [] : body.split('\n')
}

export function editLines(text) {
  return typeof text === 'string' ? text.split(/\r?\n/) : []
}

const DIFF_CELLS = 250_000

export function lineDiff(before, after) {
  const a = fileLines(before)
  const b = fileLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let tail = 0
  while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const midA = a.slice(start, a.length - tail)
  const midB = b.slice(start, b.length - tail)
  const rows = b.slice(0, start).map((line, index) => ({ kind: 'same', line, number: index + 1 }))
  const added = j => ({ kind: 'added', line: midB[j], number: start + j + 1 })
  if (midA.length * midB.length > DIFF_CELLS) {
    rows.push(...midA.map(line => ({ kind: 'removed', line })), ...midB.map((_, j) => added(j)))
  } else {
    const keep = Array.from({ length: midA.length + 1 }, () => new Array(midB.length + 1).fill(0))
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        keep[i][j] = midA[i] === midB[j] ? keep[i + 1][j + 1] + 1 : Math.max(keep[i + 1][j], keep[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        rows.push({ kind: 'same', line: midB[j], number: start + j + 1 })
        i++
        j++
      } else if (i < midA.length && (j === midB.length || keep[i + 1][j] >= keep[i][j + 1])) {
        rows.push({ kind: 'removed', line: midA[i] })
        i++
      } else {
        rows.push(added(j))
        j++
      }
    }
  }
  const offset = b.length - tail
  rows.push(...b.slice(offset).map((line, index) => ({ kind: 'same', line, number: offset + index + 1 })))
  return rows
}
