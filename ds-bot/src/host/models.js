// Models. Every Bot runs on one model of its own, fixed when it is created and changed
// only in its settings or by a Main Bot. The team's first Main Bot has none until the
// user picks one in its chat. The Session keeps the selection durably.
import { BlockAssembler, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { normalize, splitRef } from './text.js'
import { serviceOf } from './services.js'
import { ownChatSessions } from './threads.js'

const CATALOG_TTL_MS = 10_000
const ROUTE_WAIT_MS = 30_000
// The DeepSeek account's sign-in grant (dsh-deepseek-account-platform).
const ACCOUNT_RECORD = 'deepseek-account-platform/default'
const TRANSIENT_LLM_CODES = new Set(['TRANSPORT', 'TIMEOUT', 'MALFORMED_RESPONSE'])
const MALFORMED_RETRIES = 2

function retryPolicyOf(ctx, provider) {
  try {
    const resolved = serviceOf(ctx, 'llm')?.providerRetryPolicy?.(provider)
    if (resolved !== undefined) return resolved
  } catch {}
  return resolveRetryPolicy(undefined, 'ds-bot')
}

function retryDelayMs(policy, failure, retry, backoff, random) {
  const initialDelayMs = backoff?.initialDelayMs ?? policy.initialDelayMs
  const maxDelayMs = backoff?.maxDelayMs ?? policy.maxDelayMs
  const jitterRatio = backoff?.jitterRatio ?? policy.jitterRatio
  const providerAfter = failure?.providerRetryAfterMs
  if (providerAfter !== undefined && Number.isFinite(providerAfter) && providerAfter > 0) {
    if (providerAfter <= maxDelayMs) return providerAfter
    if (policy.mode === 'normal') return undefined
  }
  const exponential = Math.min(initialDelayMs * 2 ** Math.min(retry - 1, 1024), maxDelayMs)
  const jitter = 1 - jitterRatio + 2 * jitterRatio * random()
  return Math.min(exponential * jitter, maxDelayMs)
}

function waitRetryDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortedAssembler(failure) {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'finish', reason: { kind: 'aborted', failure: failure ?? { code: 'ABORTED', message: 'aborted' } } })
  return assembler
}

function canRetryPolicy(policy, code, retry) {
  if (policy?.mode !== 'normal' && policy?.mode !== 'always') return false
  if (code === 'MALFORMED_RESPONSE') return retry <= (policy.mode === 'normal' ? Math.min(MALFORMED_RETRIES, policy.maxRetries) : MALFORMED_RETRIES)
  if (policy.mode === 'always') return true
  if (policy.mode !== 'normal') return false
  return Array.isArray(policy.retryableCodes) && policy.retryableCodes.includes(code) && retry <= policy.maxRetries
}

// Auxiliary calls (memory, learning, handoff, steward, OCR, side chats, browser_task)
// bypass the agent loop's `agent/request-error` hook, so `dsh-llm-retry` never sees
// their transport, stream-idle or malformed-response failures. Retry those transient codes on the same
// route with the provider's own retry policy, discarding partial chunks from failed attempts.
export async function assembleLlmStream(ctx, options, { signal, backoff, random = Math.random } = {}) {
  const service = serviceOf(ctx, 'llm')
  if (service === undefined) throw Object.assign(new Error('DS Bot is shutting down'), { code: 'ABORTED', failure: { code: 'ABORTED', message: 'DS Bot is shutting down' } })
  const fused = options.signal && signal ? AbortSignal.any([options.signal, signal]) : (options.signal ?? signal)
  const request = fused === options.signal ? options : { ...options, signal: fused }
  for (let retry = 1; ; retry += 1) {
    const assembler = new BlockAssembler()
    let thrown
    try {
      for await (const chunk of service.stream(request)) assembler.push(chunk)
    } catch (error) {
      thrown = error
    }
    if (thrown !== undefined) {
      const code = thrown?.failure?.code ?? thrown?.code
      const failure = thrown?.failure ?? { code, message: thrown?.message || String(thrown) }
      if (fused?.aborted || !TRANSIENT_LLM_CODES.has(code)) throw thrown
      const policy = retryPolicyOf(ctx, options.provider)
      if (!canRetryPolicy(policy, code, retry)) throw thrown
      const delayMs = retryDelayMs(policy, failure, retry, backoff, random)
      if (delayMs === undefined) throw thrown
      if (!await waitRetryDelay(delayMs, fused)) throw fused?.reason ?? thrown
      continue
    }
    const finish = assembler.finish
    if (finish.kind !== 'error' || fused?.aborted) return assembler
    const failure = finish.failure
    const code = failure?.code
    if (!TRANSIENT_LLM_CODES.has(code)) return assembler
    const policy = retryPolicyOf(ctx, options.provider)
    if (!canRetryPolicy(policy, code, retry)) return assembler
    const delayMs = retryDelayMs(policy, failure, retry, backoff, random)
    if (delayMs === undefined) return assembler
    if (!await waitRetryDelay(delayMs, fused)) return abortedAssembler({ code: 'ABORTED', message: failure?.message ?? 'aborted' })
  }
}

export function install(rt) {
  const { ctx, state } = rt

  const malformedRetries = new WeakMap()
  ctx.on?.('agent/request-error', async (payload, next) => {
    const decided = await next()
    const { agent, turn, step, signal, failure } = payload
    if (decided !== undefined || failure?.code !== 'MALFORMED_RESPONSE' || signal?.aborted || !rt.isBotSession(agent.id)) return decided
    let retries = malformedRetries.get(agent)
    if (retries?.turn !== turn || retries?.step !== step) {
      retries = { turn, step, count: 0 }
      malformedRetries.set(agent, retries)
    }
    const policy = payload.retryPolicy ?? retryPolicyOf(ctx, payload.provider)
    if (!canRetryPolicy(policy, failure.code, retries.count + 1)) return undefined
    retries.count += 1
    rt.warn(`Retrying malformed model response for ${agent.id} (turn ${turn}, step ${step}, retry ${retries.count}/${MALFORMED_RETRIES})`)
    if (!await waitRetryDelay(250, signal)) return undefined
    return { kind: 'retry' }
  }, { prepend: true })

  let closing = false
  let modelsSynced = null
  // A model service that cannot be read means the host is going away.
  const llm = () => closing ? undefined : serviceOf(ctx, 'llm')
  let catalogCache = { at: 0, value: [] }
  // Routes DSH serves that cannot answer a request at all — a hosted loop engine
  // publishes one so its Sessions can be prompted. Once one refuses with
  // HOSTED_ENGINE_ROUTE it is remembered with the models its provider served then,
  // and nothing chooses it again until that provider serves different models.
  const refused = new Map()
  const answerable = entries => (refused.size === 0 ? entries : entries.filter(entry => !refused.has(entry.ref)))
  // The models a ref's provider serves, as a string to compare; undefined when it
  // cannot be listed, e.g. the provider is not registered.
  async function servedModels(ref) {
    const service = llm()
    if (service === undefined) return undefined
    try { return JSON.stringify(await service.listModels(splitRef(ref).provider)) } catch { return undefined }
  }
  // An adapter update may have replaced a refused placeholder with a real route, which
  // serves other models; the same models again are the same route, still refused.
  async function forgetChangedRefusals() {
    for (const [ref, served] of refused) {
      const now = await servedModels(ref)
      if (now !== undefined && now !== served) refused.delete(ref)
    }
  }
  // A model's thinking levels, resolved once and kept for a short while: they change
  // only with the provider, which also drops the catalog cache.
  const reasoningCache = new Map()
  let syncedKey
  const dropCatalog = () => { catalogCache = { at: 0, value: [] } }
  // A key set or a sign-in may be the user's fix for a Bot's failed turn (turns.js); a
  // key removed or a sign-out is not. A provider that registers or changes fixes
  // nothing by itself: providers register late at every start.
  ctx.on?.('llm/adapters-updated', () => { dropCatalog(); syncedKey = undefined; reasoningCache.clear(); return forgetChangedRefusals() })
  ctx.on?.('credentials/reference-updated', async (ref) => {
    dropCatalog()
    if (await inPlace(credentials => credentials.describe(ref))) rt.unblockBots?.({ ref })
  })
  // A sign-in writes the account's record. A sign-out removes it, and so does a token
  // the provider refused, while the turn that failed on it still runs. Other plugins'
  // records (an OAuth token refresh) say nothing about the account.
  ctx.on?.('credentials/record-updated', async (key) => {
    dropCatalog()
    if (String(key) !== ACCOUNT_RECORD) return
    if (await inPlace(credentials => credentials.describeRecord(key))) rt.unblockBots?.({ signedIn: true })
  })
  ctx.on?.('settings/document-updated', dropCatalog)

  // Whether a credential is there after a change. One that cannot be read counts as
  // there, so a fix is not missed.
  async function inPlace(describe) {
    const credentials = ctx.get?.('credentials')
    if (credentials === undefined) return true
    try { return (await describe(credentials))?.configured !== false } catch { return true }
  }

  // The thinking levels a model serves: `{efforts: [{id, name, description?}],
  // defaultEffort?}`, or undefined when it has none or the provider cannot say.
  async function reasoningOf(ref) {
    const cached = reasoningCache.get(ref)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value
    const route = splitRef(ref)
    const service = llm()
    if (service === undefined) return undefined
    const info = route === undefined ? undefined : await service.resolveModelInfo?.(route.provider, route.model).catch(() => undefined)
    const value = info?.reasoning === undefined ? undefined : {
      efforts: (info.reasoning.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name ?? effort.id, ...(effort.description ? { description: effort.description } : {}) })),
      ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
    }
    reasoningCache.set(ref, { at: Date.now(), value })
    return value
  }

  // A provider's model list can change in DSH settings without any event, so a picker
  // that is about to be used asks for a `fresh` one. Entries for models a Bot uses
  // also carry their `reasoning`, so the picker can offer thinking levels.
  async function catalog({ fresh = false } = {}) {
    if (!fresh && Date.now() - catalogCache.at < CATALOG_TTL_MS && catalogCache.value.length > 0) return answerable(catalogCache.value)
    // The host is gone: the last answer stands, and no service is read again.
    const service = llm()
    if (service === undefined) return answerable(catalogCache.value)
    const entries = []
    for (const provider of service.listProviders()) {
      // A local-agent route owned by another adapter is not offered by DS Bot.
      if (rt.isLocalAgentRoute?.(provider.id) && rt.isLocalAgentAvailable?.(provider.id) === false) continue
      let models = []
      try { models = await service.listModels(provider.id) } catch { continue }
      for (const model of models) {
        entries.push({
          ref: `${provider.id}/${model.id}`,
          provider: provider.id,
          providerName: provider.name ?? provider.id,
          id: model.id,
          name: model.name ?? model.id,
          ...(model.inputModalities ? { input: [...model.inputModalities] } : {}),
        })
      }
    }
    // The host was disposed while the models were listed: keep the answer, skip the
    // work that would read other services.
    if (llm() === undefined) return answerable(entries)
    // DSH serves a provider's models whether or not its key is set; without one, every
    // turn on them fails.
    const missing = await rt.missingKeys?.([...new Set(entries.map(entry => entry.provider))]) ?? new Set()
    for (const entry of entries) if (missing.has(entry.provider)) entry.needsKey = true
    // A key can arrive without an event (an environment variable at the next start), so
    // a provider listed with its key again lifts what its missing key blocked.
    rt.unblockBots?.({ keyed: new Set(entries.filter(entry => !entry.needsKey).map(entry => entry.provider)) })
    const used = new Set(Object.values(state.bots ?? {}).flatMap(bot => [bot.model, bot.appliedModel].filter(Boolean)))
    await Promise.all(entries.filter(entry => used.has(entry.ref)).map(async (entry) => {
      const reasoning = await reasoningOf(entry.ref)
      if (reasoning !== undefined) entry.reasoning = reasoning
    }))
    catalogCache = { at: Date.now(), value: entries }
    return answerable(entries)
  }

  // The profile default model of DSH as set, served or not, and able to answer.
  const defaultRef = () => {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (!selection?.provider || !selection?.model) return undefined
    const ref = `${selection.provider}/${selection.model}`
    return refused.has(ref) ? undefined : ref
  }
  // A model whose provider has no key fails every turn, so no Bot is given one unasked.
  const keyed = entries => entries.filter(entry => entry.needsKey !== true)
  const isLocal = ref => rt.isLocalAgentRef?.(ref) === true
  // Matches DSH's attachment admission (commands.js): a model rejects images only when
  // its resolved `inputModalities` is defined and omits 'image'. When `listModels` omits
  // `inputModalities`, confirm via `resolveModelInfo` before picking the route for a room.
  const acceptsImagesListed = entry => entry !== undefined && (entry.input === undefined || entry.input.includes('image'))
  async function acceptsImages(entry) {
    if (!acceptsImagesListed(entry)) return false
    if (entry.input !== undefined) return true
    const service = llm()
    if (typeof service?.resolveModelInfo !== 'function') return true
    try {
      const info = await service.resolveModelInfo(entry.provider, entry.id)
      return info?.inputModalities === undefined || info.inputModalities.includes('image')
    } catch {
      return true
    }
  }
  async function firstImageCapable(entries) {
    for (const entry of entries) {
      if (await acceptsImages(entry)) return entry.ref
    }
    return undefined
  }
  // Nor is a Bot given a local agent unasked: what it runs on changes only in its settings.
  const usableOf = entries => keyed(entries).filter(entry => !isLocal(entry.ref))
  // By the catalog as last listed, without waiting for a fresh one.
  const isUsable = ref => keyed(catalogCache.value).some(entry => entry.ref === ref)
  // The profile default model of DSH, when it is served and usable; else the first
  // usable model; else none.
  function pickDefault(entries) {
    const usable = usableOf(entries)
    const ref = defaultRef()
    // Neither a refused route nor one that fails for a missing key is picked.
    const list = answerable(usable)
    return list.find(entry => entry.ref === ref)?.ref ?? list[0]?.ref
  }
  const defaultModel = async () => pickDefault(await catalog())

  // The model a create that names none starts on: the team's pick while the catalog
  // still serves it, else the DSH default. A create fixes the ref then, so a later
  // change of either default leaves the Bot alone.
  const pickBotDefault = (entries) => {
    const preferred = state.prefs.defaultBotModel
    return !isLocal(preferred) && entries.some(entry => entry.ref === preferred) ? preferred : pickDefault(entries)
  }
  const defaultBotModel = async () => pickBotDefault(await catalog())

  // A local agent's model, by its full ref only, so a short name never moves a Bot onto
  // a CLI. Its CLI is asked only when DS Bot does not know the model yet.
  async function resolveLocalModel(ref) {
    const { provider, model } = splitRef(ref)
    if (rt.isLocalAgentAvailable?.(provider) === false) throw new Error(`Model ${ref} is not available: its local agent route is not registered`)
    const service = llm()
    if (service === undefined) throw new Error('DS Bot is shutting down')
    const known = await service.listModels(provider).catch(() => [])
    const probed = !known.some(entry => entry.id === model)
    const served = probed ? await rt.localAgentModels(provider) : known
    if (served.some(entry => entry.id === model)) {
      if (probed) dropCatalog()
      return ref
    }
    throw new Error(`Model ${ref} is not available. Available models: ${served.map(entry => `${provider}/${entry.id}`).join(', ') || 'none'}`)
  }

  // A full `provider/model` ref, or a model id or name that only one provider serves.
  async function resolveModel(text) {
    const wanted = String(text ?? '').trim()
    if (isLocal(wanted)) return resolveLocalModel(wanted)
    const entries = (await catalog({ fresh: true })).filter(entry => !isLocal(entry.ref))
    const exact = entries.find(entry => entry.ref === wanted)
    if (exact) return exact.ref
    const key = normalize(wanted)
    const named = entries.filter(entry => normalize(entry.id) === key || normalize(entry.name) === key)
    if (named.length === 1) return named[0].ref
    const known = entries.map(entry => entry.ref).join(', ') || 'none'
    throw new Error(named.length > 1
      ? `Model ${wanted} is served by more than one provider; use one of ${named.map(entry => entry.ref).join(', ')}`
      : `Model ${wanted} is not available. Available models: ${known}`)
  }

  // A Bot with no model yet waits for the user to pick one and changes nothing. A
  // model that is no longer served falls back to the last one it ran on, then the
  // default; a fallback is never one that needs a key, nor a local agent. A local
  // agent that is gone stays the Bot's: its turn fails with the repair card.
  async function desiredModel(bot) {
    if (!bot.model) return undefined
    if (isLocal(bot.model)) return bot.model
    const entries = await catalog()
    if (entries.some(entry => entry.ref === bot.model)) return bot.model
    return usableOf(entries).some(entry => entry.ref === bot.appliedModel) ? bot.appliedModel : pickDefault(entries)
  }

  // The thinking level a Bot asked for, when the model it runs on serves it; else the
  // model's own default applies. A level the model does not have is ignored, never
  // sent: an explicit effort a provider does not know is a hard refusal there.
  async function desiredEffort(bot, ref) {
    if (bot.effort === undefined || ref === undefined) return undefined
    const reasoning = await reasoningOf(ref)
    return reasoning?.efforts?.some(effort => effort.id === bot.effort) ? bot.effort : undefined
  }

  // A thinking level id, or a name only one level of the model has, like resolveModel.
  async function resolveEffort(ref, text) {
    const wanted = String(text ?? '').trim()
    if (wanted === '') return undefined
    const reasoning = await reasoningOf(ref)
    const efforts = reasoning?.efforts ?? []
    if (efforts.length === 0) throw new Error(`Model ${ref} has no thinking levels`)
    const key = normalize(wanted)
    const named = efforts.filter(effort => normalize(effort.id) === key || normalize(effort.name) === key)
    if (named.length === 1) return named[0].id
    throw new Error(`Thinking level ${wanted} is not available for ${ref}. Available: ${efforts.map(effort => effort.name).join(', ')}`)
  }

  // The profile default model's thinking level, when the model a Bot starts on
  // serves it. A level the model does not know is ignored, like an inherited
  // `bot.effort` — the model's own default applies instead.
  async function defaultEffort(ref) {
    const wanted = ctx.get?.('agentDefaultModel')?.currentSelection?.()?.reasoningEffort
    if (ref === undefined || wanted === undefined) return undefined
    return resolveEffort(ref, wanted).catch(() => undefined)
  }

  // DSH's selectModel also saves the selection as the profile default model, in the
  // background. A Bot's model is its own, so the user's default is written back after
  // it. Selections run one at a time and wait for the write-back: profile writes land in
  // submission order, so the next one reads the user's default, not a Bot's.
  let selecting = Promise.resolve()
  // Recheck group Sessions after every restart: Bot-level applied fields cannot
  // prove that an older group Session received the member's thinking level.
  const sessionSelections = new Map()
  const selectedSessions = new Set()

  // Cold Sessions avoid replay only when the checkpoint and our durable selection
  // agree. A composer change lost before a crash flushed the checkpoint remains
  // undetectable without a DSH freshness witness.
  const LISTING_TTL_MS = 15_000
  let listing
  async function listedSessions() {
    if (listing !== undefined && Date.now() - listing.at < LISTING_TTL_MS) return listing.records
    const query = serviceOf(ctx, 'sessionQuery')
    if (query?.listSessions === undefined) return undefined
    const records = new Map()
    for (const record of await query.listSessions()) records.set(record.header.id, record)
    let pruned = false
    for (const id of Object.keys(state.sessionModelSelections ?? {})) {
      if (records.has(id)) continue
      delete state.sessionModelSelections[id]
      pruned = true
    }
    if (pruned) await rt.save()
    listing = { at: Date.now(), records }
    return records
  }

  // The selection a stored Session runs on, or undefined when this start can only learn
  // it by resuming the Session. A live Session is left to the call: the composer's own
  // model picker can move it at any time, and loading it costs nothing.
  async function recordedSelection(sessionId) {
    try {
      if (selectedSessions.has(sessionId)) return undefined
      const cache = serviceOf(ctx, 'sessionProjectionCache')
      if (cache?.cachedSnapshot === undefined) return undefined
      const record = (await listedSessions())?.get(sessionId)
      if (record === undefined || !record.persisted || record.live) return undefined
      if (ctx.sessions?.get?.(sessionId) !== undefined || ctx.agents?.get?.(sessionId) !== undefined) return undefined
      const selection = cache.cachedSnapshot(record.header, ['modelSelection'])?.values?.modelSelection
      return selection?.next ?? selection?.lastUsed ?? undefined
    } catch (error) {
      rt.warn?.('ds-bot: the model selection %s runs on was not read: %s', sessionId, error)
      return undefined
    }
  }

  function selectSessionModel(sessionId, { provider, model, reasoningEffort }, { force = false } = {}) {
    const run = selecting.then(async () => {
      if (llm() === undefined) return
      const route = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
      if (!force) {
        const recorded = await recordedSelection(sessionId)
        const witnessed = state.sessionModelSelections?.[sessionId]
        const requested = witnessed?.requested ?? witnessed
        const resolved = witnessed?.resolved ?? witnessed
        if (recorded !== undefined && requested !== undefined && sameSelection(requested, route) && (sameSelection(recorded, resolved) || sameSelection(recorded, route))) {
          sessionSelections.set(sessionId, route)
          return { selected: route }
        }
      }
      const defaults = ctx.get?.('agentDefaultModel')
      const before = defaults?.currentSelection?.()
      selectedSessions.add(sessionId)
      const result = await ctx.sessionController.selectModel({
        sessionId, provider, model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      const saved = result?.selected ?? route
      state.sessionModelSelections ??= {}
      state.sessionModelSelections[sessionId] = { requested: { ...route }, resolved: { ...saved } }
      if (llm() !== undefined && before?.provider && before?.model && !sameSelection(before, saved)) {
        await defaults.saveSelection(before).catch(error => rt.warn('ds-bot: the default model was not restored: %s', error))
      }
      await rt.save().catch(error => rt.warn?.('ds-bot: the model selection of %s was not saved: %s', sessionId, error))
      if (llm() === undefined) return result
      sessionSelections.set(sessionId, { provider, model, reasoningEffort })
      return result
    })
    selecting = run.catch(() => {})
    return run
  }

  const sameSelection = (a, b) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

  async function syncBotRooms(botId) {
    for (const room of Object.values(state.rooms ?? {})) {
      if (room.members?.includes(botId)) await selectRoomSession(rt.sessionOfRoom?.(room) ?? room.sessionId ?? room.id, room)
    }
  }

  // `force` re-selects even when the record says it is applied: the composer's own
  // model picker can move the Session without telling this plugin.
  async function applyModel(bot, { force = false, syncGroups = true } = {}) {
    if (llm() === undefined) return undefined
    const ref = await desiredModel(bot)
    if (ref === undefined) {
      if (syncGroups) await syncBotRooms(bot.id)
      return ref
    }
    const effort = await desiredEffort(bot, ref)
    if (llm() === undefined) return
    const ownChanged = force || bot.appliedModel !== ref || (bot.appliedEffort ?? undefined) !== effort
    const route = { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    // A Bot's model is the model of every part of its own chat, the background ones
    // included: a part left on the old route would keep answering with the old model
    // while the settings show the new one. A part that cannot take it fails the change.
    if (ownChanged) for (const sessionId of ownChatSessions(bot)) await selectSessionModel(sessionId, route, { force })
    for (const sessionId of rt.groupSessionsOf(bot.id)) {
      const applied = sessionSelections.get(sessionId)
      if (!force && applied !== undefined && sameSelection(applied, route)) continue
      await selectSessionModel(sessionId, route, { force })
        .catch(error => rt.warn('ds-bot: model for %s in a group not applied: %s', bot.name, error))
    }
    if (llm() === undefined || !ownChanged) return ref
    bot.appliedModel = ref
    if (effort === undefined) delete bot.appliedEffort
    else bot.appliedEffort = effort
    await rt.save()
    if (syncGroups) await syncBotRooms(bot.id)
    return ref
  }

  // A group's own Session never asks the model (groups.js synthesizes its relay step),
  // but DSH resolves the Session's selection before every step and rejects image uploads
  // (MODEL_DOES_NOT_SUPPORT_IMAGES) when that selection declares text-only input. Keep
  // the group Session on an image-capable route when one is available so members with
  // vision (or OCR) can still receive pictures even when the team default is text-only.
  async function roomModel(sessionId, room = rt.roomOf?.(sessionId)) {
    const entries = await catalog()
    const fallback = pickBotDefault(entries)
    const byRef = new Map(entries.map(entry => [entry.ref, entry]))
    if (fallback !== undefined && await acceptsImages(byRef.get(fallback))) return fallback
    const memberRefs = (room?.members ?? []).map(id => state.bots?.[id]?.model ?? state.bots?.[id]?.appliedModel).filter(Boolean)
    const usable = answerable(usableOf(entries))
    const usableByRef = new Map(usable.map(entry => [entry.ref, entry]))
    const memberUsable = await firstImageCapable(memberRefs.map(ref => usableByRef.get(ref)).filter(Boolean))
    if (memberUsable !== undefined) return memberUsable
    const anyUsable = await firstImageCapable(usable)
    if (anyUsable !== undefined) return anyUsable
    const local = answerable(keyed(entries).filter(entry => isLocal(entry.ref)))
    const localByRef = new Map(local.map(entry => [entry.ref, entry]))
    const memberLocal = await firstImageCapable(memberRefs.map(ref => localByRef.get(ref)).filter(Boolean))
    if (memberLocal !== undefined) return memberLocal
    const anyLocal = await firstImageCapable(local)
    if (anyLocal !== undefined) return anyLocal
    return fallback
  }

  // The Sessions whose selection failed. The models may not change again, so the next
  // sync tries them once more instead of waiting for a change that never comes.
  const roomRetry = new Set()
  async function selectRoomSession(sessionId, room = rt.roomOf?.(sessionId)) {
    try {
      const ref = await roomModel(sessionId, room)
      if (ref === undefined) return
      const route = splitRef(ref)
      const applied = sessionSelections.get(sessionId)
      if (applied !== undefined && sameSelection(applied, route)) { roomRetry.delete(sessionId); return }
      await selectSessionModel(sessionId, route)
      roomRetry.delete(sessionId)
    } catch (error) {
      roomRetry.add(sessionId)
      rt.warn('ds-bot: model for the group Session %s not applied: %s', sessionId, error)
    }
  }
  async function syncRoomSessions() {
    const rooms = Object.values(state.rooms ?? {})
    const current = new Set(rooms.map(room => rt.sessionOfRoom(room)))
    // A deleted group, or one moved on to a fresh part, no longer needs its old Session.
    for (const sessionId of roomRetry) if (!current.has(sessionId)) roomRetry.delete(sessionId)
    for (const room of rooms) await selectRoomSession(rt.sessionOfRoom(room), room)
  }

  // A provider may register after the plugin starts; a greeting waits for its Bot's
  // model instead of failing with "no adapter registered".
  async function waitForModel(bot, ms = ROUTE_WAIT_MS) {
    const deadline = Date.now() + ms
    for (;;) {
      if (!bot.model) return undefined
      catalogCache = { at: 0, value: [] }
      const served = new Set((await catalog()).map(entry => entry.ref))
      if (llm() === undefined) return undefined
      if (served.has(bot.model) || Date.now() >= deadline) return desiredModel(bot)
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(2000, deadline - Date.now()))
        const off = ctx.on?.('llm/adapters-updated', done)
        function done() { clearTimeout(timer); off?.(); resolve() }
      })
    }
  }

  // Sequential, and again whenever the answerable models change (a refused route is
  // not one of them): a provider that registers late still gets its Bots' models selected.
  const syncModels = () => {
    const key = answerable(catalogCache.value).map(entry => entry.ref).join(',')
    if (key !== syncedKey) { syncedKey = key; modelsSynced = modelsSynced?.then(syncAll, syncAll) ?? syncAll() }
    else if (roomRetry.size > 0) modelsSynced = modelsSynced?.then(syncRooms, syncRooms) ?? syncRooms()
    return modelsSynced
  }
  // Nothing awaits a sync (bootstrap starts one and drops the promise), so a failure
  // here, such as a catalog that cannot be read, is logged; the retry record stays.
  const syncRooms = () => syncRoomSessions().catch(error => rt.warn('ds-bot: models of the groups not applied: %s', error))
  async function syncAll() {
    for (const bot of Object.values(state.bots)) {
      await applyModel(bot, { syncGroups: false }).catch(error => rt.warn('ds-bot: model for %s not applied: %s', bot.name, error))
    }
    await syncRooms()
  }

  // A route that refused a request for not being a model endpoint: it stays out of
  // the catalog from now on, the Bots pinned to it move to what they would be given
  // today, and each of them re-selects even when its record looks applied (`force`):
  // its Session may still be on the route, or on another Bot's route in a group.
  async function routeRefused(ref, bot) {
    const served = await servedModels(ref)
    if (!refused.has(ref)) {
      refused.set(ref, served)
      rt.warn('ds-bot: %s is not a model endpoint, so it is not chosen again', ref)
      const entries = await catalog()
      const pinned = Object.values(state.bots).filter(other => other.model === ref || other.appliedModel === ref)
      for (const other of pinned) {
        if (other.model === ref) other.model = pickDefault(entries)
        if (other.appliedModel === ref) delete other.appliedModel
      }
      await rt.save()
      for (const other of pinned) {
        if (other !== bot) await applyModel(other, { force: true }).catch(error => rt.warn('ds-bot: model for %s not applied: %s', other.name, error))
      }
    }
    if (bot !== undefined) await applyModel(bot, { force: true })
  }

  const lifetime = new AbortController()
  ctx.effect?.(() => () => { closing = true; lifetime.abort() }, 'ds-bot: auxiliary llm retry')
  const assembleLlm = options => assembleLlmStream(ctx, options, { signal: lifetime.signal, backoff: rt.config?.llmRetryBackoff })

  Object.assign(rt, {
    // Work that starts while the host runs can ask whether the host is still there.
    hostClosing: () => llm() === undefined,
    catalog, cachedCatalog: () => answerable(catalogCache.value), cachedDefault: () => pickDefault(catalogCache.value),
    defaultRef, defaultModel, defaultBotModel, defaultEffort, isUsable, resolveModel, desiredModel, reasoningOf, resolveEffort, desiredEffort,
    selectSessionModel, applyModel, selectRoomSession, syncRoomSessions, waitForModel, syncModels, routeRefused, dropCatalog, assembleLlm,
  })
}
