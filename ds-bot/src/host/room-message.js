// The transcript is public to the room. Only the envelope is addressed.
// In particular a result resumes its caller; it is not a request from the worker.
export const roomNote = () => ({ kind: 'note' })
export const roomRequest = ids => ({ kind: 'request', to: [...new Set(ids)] })
export const roomResult = (caller, batch) => ({
  kind: 'result', to: [caller], ...(batch ? { batch } : {}),
})

export function addressedMembers(route, members, senderId) {
  if (!['request', 'result'].includes(route?.kind) || !Array.isArray(route.to)) return []
  const byId = new Map(members.map(member => [member.id, member]))
  return [...new Set(route.to)].filter(id => id !== senderId && byId.has(id)).map(id => byId.get(id))
}

export function waitsOnMember(batches, roomId, caller, target) {
  const parents = new Map()
  for (const batch of Object.values(batches ?? {})) {
    if (batch.roomId !== roomId) continue
    for (const child of batch.pending) {
      if (!parents.has(child)) parents.set(child, [])
      parents.get(child).push(batch.by)
    }
  }
  const seen = new Set([caller])
  for (const id of seen) {
    for (const parent of parents.get(id) ?? []) {
      if (parent === target) return true
      seen.add(parent)
    }
  }
  return false
}
