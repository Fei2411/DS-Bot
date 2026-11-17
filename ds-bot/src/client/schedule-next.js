const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

// The next few times a task fires, from what it keeps (its next firing plus the
// rule). A task whose zone is not the one on this screen stays a single date: the
// local clock would lie about it.
export function nextRuns(task, from = Date.now(), count = 3) {
  if (task.status !== 'active') return []
  if (task.timeZone && task.timeZone !== localZone()) return []
  const first = Date.parse(task.scheduledAt)
  if (!Number.isFinite(first)) return []
  if (task.kind === 'at' || task.kind === 'after') return first > from ? [first] : []
  if (task.kind === 'every') {
    const step = Number(task.everySeconds) * 1000
    if (!(step > 0)) return []
    let next = first
    if (next <= from) next += Math.ceil((from - next) / step) * step
    return Array.from({ length: count }, (_, index) => next + index * step)
  }
  const clockOf = (text) => {
    const [, hours, minutes, seconds] = /^(\d\d):(\d\d)(?::(\d\d))?/.exec(String(text ?? '')) ?? []
    return hours === undefined ? null : [Number(hours), Number(minutes), Number(seconds ?? '0')]
  }
  if (task.kind === 'daily' || task.kind === 'weekly') {
    const [hours, minutes, seconds] = clockOf(task.time) ?? []
    if (hours === undefined) return []
    const days = task.kind === 'weekly' ? new Set((task.weekdays ?? []).map(Number)) : null
    const out = []
    const day = new Date(first)
    day.setHours(hours, minutes, seconds, 0)
    for (let step = 0; step < 366 && out.length < count; step += 1) {
      const at = new Date(day)
      at.setDate(day.getDate() + step)
      const weekday = at.getDay() === 0 ? 7 : at.getDay()
      if (days !== null && !days.has(weekday)) continue
      if (at.getTime() > from) out.push(at.getTime())
    }
    return out
  }
  return []
}
