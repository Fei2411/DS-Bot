// A waiting card goes after the last turn that ended before it was proposed, else
// after the latest turn, else to the dock. An answered card stays where it was
// answered: when no turn ended before it was proposed, after the last one that
// ended before the answer; it never goes to the dock.
export function proposalPlacement(proposal, turns) {
  const settled = proposal?.outcome !== undefined
  if (!Number.isFinite(proposal?.at) || typeof turns?.values !== 'function') return { kind: settled ? 'none' : 'dock' }
  const lastBy = (time) => {
    let found
    for (const location of turns.values()) {
      const end = location?.end?.time
      if (location?.status !== 'closed' || !Number.isFinite(end) || end > time) continue
      if (found === undefined || end > found.end.time || (end === found.end.time && location.turn > found.turn)) found = location
    }
    return found
  }
  const turn = (lastBy(proposal.at) ?? lastBy(settled ? proposal.settledAt ?? proposal.at : Infinity))?.turn
  if (turn === undefined) return { kind: settled ? 'none' : 'dock' }
  return { kind: 'turn', turn }
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

// A failed answer keeps its card only while another try could work — the host still has
// the proposal. `bot/stale` says it does not, so the card goes; every other failure
// (network, `bot/internal`, a skill of that name already existing) keeps it.
export const answerKeepsCard = failure => failure?.code !== 'bot/stale'

// A copy of a per-proposal record without one entry; the same object when nothing changed.
export const withoutEntry = (state, key) => {
  if (!(key in state)) return state
  const next = { ...state }
  delete next[key]
  return next
}

// What a failed answer leaves behind for one Session's cards: a stale proposal is forgotten,
// every other failure is recorded on its card so the card stays and can be tried again.
export function answerFailure(record, proposal, failure) {
  if (!answerKeepsCard(failure)) return withoutEntry(record, proposal.id)
  return { ...record, [proposal.id]: { proposal, error: failure?.message ?? String(failure) } }
}

// The cards a Session draws: the host's proposals and its settled ones, plus the cards a
// failed answer keeps up for another try. A stale answer puts nothing back.
export function proposalCards({ proposals = [], settled = [], failures = {} }) {
  const visible = [...settled.filter(entry => !proposals.some(proposal => proposal.id === entry.id)), ...proposals]
  for (const entry of Object.values(failures)) {
    if (!proposals.some(proposal => proposal.id === entry.proposal.id) && !visible.some(proposal => proposal.id === entry.proposal.id)) visible.push(entry.proposal)
  }
  return visible.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}
