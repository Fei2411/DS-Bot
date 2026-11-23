import type { UsageView } from './usage.ts'

const wallHour = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}`

// The same hourly ledger shape as the host, so demo charts exercise real ranges.
export function demoUsage(bots: { id: string; name: string }[], now = new Date()): UsageView {
  const view: UsageView = {
    now: wallHour(now),
    owners: bots.map(bot => ({ key: bot.id, id: bot.id, name: bot.name, kind: 'bot' })),
    kinds: ['chat'],
    models: [
      { key: 'deepseek-official/deepseek-v4.1', name: 'DeepSeek v4.1', providerName: 'DeepSeek' },
      { key: 'deepseek-official/deepseek-flash', name: 'DeepSeek Flash', providerName: 'DeepSeek' },
    ],
    rows: [],
  }
  for (let back = 369; back >= 0; back -= 1) {
    if (back % 11 === 0 && back > 7) continue
    for (let owner = 0; owner < bots.length; owner += 1) {
      for (const hour of [2, 9, 16]) {
        const key = wallHour(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, hour))
        if (key > view.now) continue
        const scale = (bots.length - owner) * (3 + (back * 7 + owner * 3 + hour) % 13)
        view.rows.push([key, owner, owner % 2, 0, scale * 430, scale * 710, scale * 40, scale * 180, Math.ceil(scale / 3)])
      }
    }
  }
  return view
}
