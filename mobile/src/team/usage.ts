import { DAY_MS, RANGES, dayKey, hourMs, mondayOf, summarize, tokensOf } from '../../../ds-bot/src/client/usage-data.js'

export { compact, percent } from '../../../ds-bot/src/client/usage-data.js'

export type UsageRow = [string, number, number, number, number, number, number, number, number]
export interface UsageView {
  now: string
  scanning?: boolean
  owners: { key: string; id?: string; name?: string; kind: string; deleted?: boolean }[]
  models: { key: string; name?: string; model?: string; providerName?: string; provider?: string }[]
  kinds?: string[]
  rows: UsageRow[]
}
export interface UsageSum { input: number; cacheRead: number; output: number; calls: number; total: number }
export interface UsageBucket { key: string; start: number; sum: UsageSum; stacks: Map<number, number> }
export interface UsageReport {
  buckets: UsageBucket[]
  total: UsageSum
  previous: number
  owners: Map<number, UsageSum>
  models: Map<number, UsageSum>
  bots: Set<number>
}
export const usageRanges = RANGES as { id: string; unit: string; count: number; stride: number }[]
export type UsageRange = typeof usageRanges[number]

// Share the desktop's wall-clock buckets, comparison window and cache accounting.
const sumUsage = summarize as unknown as (view: UsageView, range: UsageRange, keep: undefined, series: (row: UsageRow) => number) => Omit<UsageReport, 'bots'>
export function usageReport(view: UsageView, range: UsageRange, by: 'bot' | 'model'): UsageReport {
  const bots = new Set(view.owners.flatMap((owner, id) => ['bot', 'agent'].includes(owner.kind) ? [id] : []))
  return { ...sumUsage(view, range, undefined, row => row[by === 'bot' ? 1 : 2]), bots }
}

export const rankUsage = (sums: Map<number, UsageSum>) => [...sums].filter(([, sum]) => sum.total > 0).sort((a, b) => b[1].total - a[1].total)

// Like web, keep a busy team's chart readable without dropping smaller series.
export function usageChart(report: UsageReport, by: 'bot' | 'model', limit = 7) {
  const ranked = rankUsage(by === 'bot' ? report.owners : report.models).filter(([id]) => by === 'model' || report.bots.has(id))
  const ids = ranked.slice(0, limit).map(([id]) => id)
  const other = by === 'bot' && rankUsage(report.owners).some(([id]) => !report.bots.has(id))
  const more = ranked.length > limit
  if (!more && !other) return { report, ids }
  const shown = new Set(ids)
  const buckets = report.buckets.map(bucket => {
    const stacks = new Map<number, number>()
    for (const [id, value] of bucket.stacks) {
      const key = by === 'bot' && !report.bots.has(id) ? -2 : shown.has(id) ? id : -1
      stacks.set(key, (stacks.get(key) ?? 0) + value)
    }
    return { ...bucket, stacks }
  })
  return { report: { ...report, buckets }, ids: [...ids, ...(more ? [-1] : []), ...(other ? [-2] : [])] }
}

export function usageActivity(view: UsageView) {
  const today = hourMs(view.now.slice(0, 10))
  const first = mondayOf(today - 364 * DAY_MS)
  const days = new Map<string, number>()
  for (const row of view.rows) {
    const date = row[0].slice(0, 10)
    const at = hourMs(date)
    if (at < today - 364 * DAY_MS || at > today) continue
    days.set(date, (days.get(date) ?? 0) + tokensOf(row))
  }
  const max = Math.max(1, ...days.values())
  const weeks = Array.from({ length: 53 }, (_, week) => Array.from({ length: 7 }, (_, day) => {
    const at = first + (week * 7 + day) * DAY_MS
    const key = dayKey(at)
    const value = days.get(key) ?? 0
    return { key, value, level: value > 0 ? Math.max(1, Math.ceil(value / max * 4)) : 0, outside: at > today || at < today - 364 * DAY_MS }
  }))
  return { weeks, active: [...days.values()].filter(value => value > 0).length }
}
