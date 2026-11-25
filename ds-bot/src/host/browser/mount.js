// Registers one browser plugin's tools. ds-bot passes a key function that resolves
// the Bot; a standalone package can pass the Session id instead.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openBotBrowser } from './session.js'
import { gateScope } from './gate.js'

export const browserOutput = {
  schema: {
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          image: { type: 'string' },
          attachment: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              name: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  render(_args, value) {
    if (value && typeof value === 'object') {
      const blocks = [{ type: 'text', text: String(value.text ?? '') }]
      // Image blocks must reference a stored attachment; a raw base64 payload is
      // not a valid content block and breaks the session's transport encoding.
      if (value.attachment) blocks.push({ type: 'image', attachment: value.attachment })
      return blocks
    }
    return [{ type: 'text', text: String(value) }]
  },
}

// Tool bodies return screenshot bytes; the model-facing result must carry the
// stored attachment instead, since content blocks cannot inline image data.
async function saveShot(ctx, value) {
  if (!value || typeof value !== 'object' || typeof value.image !== 'string') return value
  const attachments = ctx.get('attachments')
  if (typeof attachments?.saveImage === 'function') {
    try {
      const attachment = await attachments.saveImage({
        mediaType: 'image/jpeg',
        data: Buffer.from(value.image, 'base64'),
        name: 'Browser screenshot',
      })
      return { text: value.text, attachment }
    } catch (error) {
      ctx.logger?.warn?.('ds-bot: screenshot could not be stored: %s', error?.message ?? error)
    }
  }
  return { text: `${value.text ?? ''} (The screenshot could not be attached.)` }
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_SESSIONS = 4

/**
 * @param {any} ctx
 * @param {{ toolDefs: any[], defineTool: Function, keyOf: (exec: any) => Promise<string|undefined>, profileRoot: string, downloadRoot?: string, downloadRoots?: (botId: string) => Promise<string[]>, uploadRoots?: (botId: string) => Promise<string[]>, headless: boolean, playwrightUrl?: string, executablePath?: string, actionTimeout?: number, downloadGraceMs?: number, idleTimeoutMs?: number, maxSessions?: number, authorize?: (exec: any, botId: string, action: any) => Promise<void>, completeFor?: (exec: any) => Function, connect?: (botId: string, downloadRoots?: string[]) => Promise<string>, getHold?: (botId: string) => any, onHold?: (botId: string, hold: any) => void, subscribeHolds?: (listener: (botId: string, hold: any) => void) => (() => void) | undefined, openSession?: typeof openBotBrowser, api?: object, register?: (tool: any) => void }} options
 */
export function mountBrowserPlugin(ctx, { toolDefs, defineTool, keyOf, profileRoot, downloadRoot, downloadRoots, uploadRoots, headless, playwrightUrl, executablePath, actionTimeout, downloadGraceMs, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, maxSessions = DEFAULT_MAX_SESSIONS, authorize, completeFor, connect, getHold, onHold, subscribeHolds, openSession = openBotBrowser, api, register }) {
  const sessions = new Map()
  const openedSessions = new Map()
  const pendingCalls = new Map()
  const inFlight = new Map()
  const idleTimers = new Map()
  const lastUsed = new Map()
  let useSeq = 0
  let disposed = false
  const names = new Set(toolDefs.map(tool => tool.name))
  const isBusy = botId => (inFlight.get(botId) ?? 0) > 0 || pendingCalls.has(botId)
  const isHeld = botId => Boolean(getHold ? getHold(botId) : openedSessions.get(botId)?.hold)
  const clearIdle = botId => {
    const timer = idleTimers.get(botId)
    if (timer !== undefined) {
      clearTimeout(timer)
      idleTimers.delete(botId)
    }
  }
  const clearAllIdle = () => {
    for (const timer of idleTimers.values()) clearTimeout(timer)
    idleTimers.clear()
  }
  const evictSession = botId => {
    clearIdle(botId)
    lastUsed.delete(botId)
    openedSessions.delete(botId)
    const entry = sessions.get(botId)
    if (entry === undefined) return
    sessions.delete(botId)
    void Promise.resolve(entry).then(s => s.close(), () => {}).catch(() => {})
  }
  const scheduleIdle = botId => {
    clearIdle(botId)
    if (connect || disposed || !idleTimeoutMs || idleTimeoutMs <= 0 || !sessions.has(botId)) return
    const timer = setTimeout(() => {
      idleTimers.delete(botId)
      if (disposed || !sessions.has(botId)) return
      if (isBusy(botId) || isHeld(botId)) {
        scheduleIdle(botId)
        return
      }
      evictSession(botId)
    }, idleTimeoutMs)
    timer.unref?.()
    idleTimers.set(botId, timer)
  }
  const touch = botId => {
    lastUsed.set(botId, ++useSeq)
    if (!isBusy(botId)) scheduleIdle(botId)
  }
  const enforceSessionCap = incomingBotId => {
    if (connect || !maxSessions || maxSessions <= 0 || sessions.size < maxSessions) return
    const victims = [...sessions.keys()]
      .filter(id => id !== incomingBotId && !isBusy(id) && !isHeld(id))
      .sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0))
    for (const victimId of victims) {
      if (sessions.size < maxSessions) break
      evictSession(victimId)
    }
  }
  // Tool results persist their rendered blocks, so changing render() cannot fix
  // old screenshots. Replace only this plugin's malformed image blocks through
  // DSH's public surface API, keeping the original log for the transcript.
  // Track the highest checked seq per Session so subsequent steps skip already-verified nodes.
  // Surface replacements splice higher seqs in place (incrementing replaceGeneration), so the
  // O(1) fast path requires tail stability and unchanged replaceGeneration/contentGeneration.
  const checkedState = new WeakMap()
  const offPreStep = ctx.on?.('agent/pre-step', async ({ agent }, next) => {
    if (disposed) return next()
    const session = agent.session
    const nodes = session.surface?.nodes ?? []
    if (nodes.length === 0) return next()
    const prev = checkedState.get(session)
    const replaceGen = session.surface?.replaceGeneration
    const contentGen = session.surface?.contentGeneration
    const lastSeq = nodes.at(-1)
    if (
      prev !== undefined
      && typeof replaceGen === 'number'
      && prev.replaceGen === replaceGen
      && prev.contentGen === contentGen
      && prev.nodesLen === nodes.length
      && prev.lastSeq === lastSeq
    ) return next()
    const through = prev?.through ?? -1
    let changed = false
    let highest = through
    let initialMax = through
    let skippedUnowned = false
    const replacedSeqs = new Set()
    const snapshot = nodes.slice()
    for (const seq of snapshot) {
      if (seq > initialMax) initialMax = seq
      if (seq <= through) continue
      if (seq > highest) highest = seq
      const event = session.eventAt(seq)
      if (event.type !== 'tool/result') continue
      if (!event.sourceEventSeqs?.some(source => names.has(session.eventAt(source)?.data?.name))) continue
      const message = session.deriveEventMessage(event)
      if (!message.content.some(block => block.type === 'image' && !block.attachment && typeof block.data === 'string')) continue
      if (!await keyOf({ agent })) { skippedUnowned = true; continue }
      const content = []
      for (const block of message.content) {
        if (block.type !== 'image' || block.attachment || typeof block.data !== 'string') { content.push(block); continue }
        const saved = await saveShot(ctx, { text: '', image: block.data })
        content.push(saved.attachment
          ? { type: 'image', attachment: saved.attachment, ...(block.offloaded ? { offloaded: true } : {}) }
          : { type: 'text', text: saved.text.trim() })
      }
      const replacement = session.append('tool/result', { ...event.data, message: { ...message, content } }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
      })
      if (typeof replacement?.seq === 'number') {
        replacedSeqs.add(replacement.seq)
        if (replacement.seq > highest) highest = replacement.seq
      }
      changed = true
    }
    if (!skippedUnowned) {
      const updated = session.surface?.nodes ?? nodes
      const sawConcurrent = updated.some(seq => seq > initialMax && !replacedSeqs.has(seq))
      if (sawConcurrent) {
        // An unrelated event arrived while awaiting keyOf/saveShot: only mark the initial
        // snapshot as checked and leave the O(1) fast path uncached so the next step inspects it.
        checkedState.set(session, { through: initialMax })
      } else {
        checkedState.set(session, {
          through: highest,
          replaceGen: session.surface?.replaceGeneration,
          contentGen: session.surface?.contentGeneration,
          nodesLen: updated.length,
          lastSeq: updated.at(-1),
        })
      }
    }
    if (changed) await ctx.sessions.flush(session)
    return next()
  }, { prepend: true })
  const unsubscribeHolds = subscribeHolds?.((botId, hold) => {
    if (hold?.by === 'user') {
      evictSession(botId)
      return
    }
    if (hold == null && sessions.has(botId) && !isBusy(botId)) scheduleIdle(botId)
  })
  let closing = null
  const closeAll = () => {
    if (closing) return closing
    disposed = true
    clearAllIdle()
    lastUsed.clear()
    openedSessions.clear()
    closing = (async () => {
      try { offPreStep?.() } catch { /* ignore */ }
      try { unsubscribeHolds?.() } catch { /* ignore */ }
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.all(open.map(session => Promise.resolve(session).then(opened => opened.close(), () => {})))
    })()
    return closing
  }
  const offEffect = ctx.effect(() => () => closeAll(), 'ds-bot: browser plugin')

  // Closes a Bot's browser and removes its profile directory; used when the Bot is deleted.
  async function drop(botId) {
    clearIdle(botId)
    lastUsed.delete(botId)
    openedSessions.delete(botId)
    const session = sessions.get(botId)
    sessions.delete(botId)
    if (session !== undefined) await Promise.resolve(session).then(opened => opened.close(), () => {})
    await rm(join(profileRoot, botId), { recursive: true, force: true }).catch(() => {})
  }

  const registerTool = register ?? (tool => ctx.tools.register(tool))
  for (const spec of toolDefs) {
    registerTool(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters ?? {},
      output: browserOutput,
      async execute(args, exec) {
        const botId = await keyOf(exec)
        if (!botId) return 'Only Bots on the team have a browser.'
        exec.signal?.throwIfAborted()
        if (disposed) throw new Error('The browser plugin is closed.')
        if (getHold?.(botId)?.by === 'user') throw new Error('The user has taken over this browser. Wait for them to give it back.')
        inFlight.set(botId, (inFlight.get(botId) ?? 0) + 1)
        clearIdle(botId)
        lastUsed.set(botId, ++useSeq)
        try {
          let session = sessions.get(botId)
          if (spec.needsBrowser && session === undefined) {
            enforceSessionCap(botId)
            // Store the opening promise before resolving roots so concurrent calls share the launch.
            const opening = Promise.resolve().then(async () => {
              const roots = downloadRoots ? await downloadRoots(botId) : undefined
              const opened = await openSession({
                botId,
                profileRoot,
                downloadDir: roots === undefined
                  ? join(downloadRoot ?? join(profileRoot, 'browser-downloads'), botId)
                  : async () => (await downloadRoots(botId))[0],
                headless,
                playwrightUrl,
                executablePath,
                actionTimeout,
                downloadGraceMs,
                connect: connect ? id => connect(id, roots ?? []) : undefined,
                getHold: getHold ? () => getHold(botId) : undefined,
                onHold: hold => onHold?.(botId, hold),
                uploadRoots: uploadRoots ? () => uploadRoots(botId) : undefined,
              })
              opened.signal?.throwIfAborted()
              if (sessions.get(botId) === opening) openedSessions.set(botId, opened)
              opened.signal?.addEventListener('abort', () => {
                if (sessions.get(botId) === opening) {
                  sessions.delete(botId)
                  openedSessions.delete(botId)
                  clearIdle(botId)
                  lastUsed.delete(botId)
                }
              }, { once: true })
              return opened
            })
            sessions.set(botId, opening)
            opening.catch(() => {
              if (sessions.get(botId) === opening) {
                sessions.delete(botId)
                openedSessions.delete(botId)
                clearIdle(botId)
                lastUsed.delete(botId)
              }
            })
            session = opening
          }
          const sessionEntry = session
          session = await session
          const gate = authorize ? async action => {
            exec.signal?.throwIfAborted()
            await authorize(exec, botId, action)
            exec.signal?.throwIfAborted()
          } : undefined
          // A Bot shares one browser across Sessions. Keep its action and any
          // delayed download inside the call that owns the approval context.
          const previous = pendingCalls.get(botId) ?? Promise.resolve()
          const running = previous.catch(() => {}).then(async () => {
            exec.signal?.throwIfAborted()
            if (disposed) throw new Error('The browser plugin is closed.')
            if (getHold?.(botId)?.by === 'user') throw new Error('The user has taken over this browser. Wait for them to give it back.')
            if (sessionEntry !== undefined && sessions.get(botId) !== sessionEntry) throw new Error('The browser session is closed.')
            return saveShot(ctx, await gateScope.run(gate, () => spec.execute(args ?? {}, {
              botId,
              profileDir: join(profileRoot, botId),
              session,
              complete: completeFor?.(exec),
              origin: { ...(exec.callId !== undefined ? { callId: exec.callId } : {}), ...(exec.agent?.id !== undefined ? { sessionId: exec.agent.id } : {}) },
              signal: exec.signal,
            })))
          })
          pendingCalls.set(botId, running)
          try {
            return await running
          } finally {
            if (pendingCalls.get(botId) === running) pendingCalls.delete(botId)
          }
        } finally {
          const remaining = (inFlight.get(botId) ?? 1) - 1
          if (remaining <= 0) inFlight.delete(botId)
          else inFlight.set(botId, remaining)
          if (sessions.has(botId)) touch(botId)
        }
      },
    }))
  }

  // An object return would be collected as an effect by cordis, so the api is an out-param.
  if (api) {
    api.drop = drop
    api.frame = async botId => {
      const entry = sessions.get(botId)
      if (!entry) return undefined
      touch(botId)
      return (await entry)?.frame?.()
    }
    api.dispose = async () => {
      try { offEffect?.() } catch { /* ignore */ }
      await closeAll()
    }
  }
}
