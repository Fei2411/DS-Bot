import { createUserMessage } from '@deepseek-ai/dsh-llm'

const SOURCE = 'ds-bot-time-context'
const isClock = source => source?.kind === SOURCE || source?.kind === 'time-context'
const CLOCK_CACHE_MAX = 2_000

export function install(rt) {
  const { ctx, config } = rt
  const interval = config.timeRefreshIntervalMs ?? 600_000
  if (!Number.isSafeInteger(interval) || interval < 0) throw new TypeError('timeRefreshIntervalMs must be a non-negative safe integer')
  const formatter = new Intl.DateTimeFormat('en-CA', {
    ...(config.timeZone ? { timeZone: config.timeZone } : {}),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  const zone = formatter.resolvedOptions().timeZone
  // Per-session last clock timestamp so the fallback clock scans history at most once
  // on a cold miss rather than calling eventsBackwards on every step.
  const lastClockAt = new Map()
  const rememberClock = (sessionId, time) => {
    lastClockAt.delete(sessionId)
    lastClockAt.set(sessionId, time)
    if (lastClockAt.size > CLOCK_CACHE_MAX) lastClockAt.delete(lastClockAt.keys().next().value)
  }
  rt.onBotDelete?.((botId) => {
    const bot = rt.botOf?.(botId)
    const ids = [
      botId,
      rt.chatOf?.(botId),
      ...(bot?.segments ?? []).map(seg => seg?.sessionId),
      ...(bot?.tasks ?? []).flatMap(task => [task?.sessionId, ...(task?.segments ?? []).map(seg => seg?.sessionId)]),
      ...(rt.groupSessionsOf?.(botId) ?? []),
    ]
    for (const sid of ids) if (sid !== undefined) lastClockAt.delete(sid)
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    await rt.load()
    if (!rt.isBotSession(agent.id) || signal.aborted) return decision
    // A loaded DSH clock covers every step itself. Its listener may run before or
    // after this one (a reload reorders them), so its presence is read from its
    // projection, not from the messages added so far.
    if (ctx.get?.('sessionProjections')?.stateOf(agent.session, 'timeContext') !== undefined) return decision
    const now = Date.now()
    if (decision.messages.some(message => isClock(message.source))) {
      rememberClock(agent.id, now)
      return decision
    }
    const cached = lastClockAt.get(agent.id)
    if (cached !== undefined) {
      if (now >= cached && now - cached < interval) {
        rememberClock(agent.id, cached)
        return decision
      }
    } else {
      for await (const event of rt.eventsBackwards(agent.id, signal, Infinity)) {
        if (event.type === 'user/message' && isClock(event.data.source)) {
          rememberClock(agent.id, event.time)
          if (now >= event.time && now - event.time < interval) return decision
          break
        }
        if (event.time <= now - interval) break
      }
    }
    if (signal.aborted) return decision
    rememberClock(agent.id, now)
    const text = `Current time: ${formatter.format(now)} (${zone}).`
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: SOURCE, form: 'snapshot', sections: [{ name: SOURCE, text }] },
      })],
    }
  }, { prepend: true })
}
