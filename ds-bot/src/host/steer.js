// In a Bot's private chat a slow shell call moves to a DSH background job on
// schedule (Settings > Background work) and a user steer reaches the Bot at
// once, not at the next DSH step boundary:
//  - for normal calls, tightening timeoutMs (or setting run_in_background at 0s)
//    lets DSH's own waitOnJob promote the command and hand its lifecycle to
//    tool-jobs, avoiding dual waiters, premature registry removal, and duplicate
//    completion notices;
//  - if a user steers while a longer wait is still in flight, the shell call
//    detaches after a short grace window with an isolated AbortController;
//  - a running model call is cancelled (hook reason) and the steer is moved to
//    the front of next-turn, so a fresh turn claims it at once.
import { isAbsolute, resolve } from 'node:path'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { BACKGROUND_WAIT_MS, STEER_CUT } from './constants.js'

const SHELL_TOOLS = ['pwsh', 'bash']
const STEER_GRACE_MS = 1000
const DEFAULT_MAX_CONCURRENT_JOBS = 10
const INLINE_OUTPUT_LIMIT = 2048
const TERMINAL_JOB_STATUS = /\[status:\s*(?:completed|killed|failed)(?:,|\])/

const addToSetMap = (map, key, value) => {
  let set = map.get(key)
  if (set === undefined) { set = new Set(); map.set(key, set) }
  set.add(value)
}
const deleteFromSetMap = (map, key, value) => {
  const set = map.get(key)
  if (set === undefined) return
  set.delete(value)
  if (set.size === 0) map.delete(key)
}
const contentText = (content) => (Array.isArray(content) ? content : [])
  .map(block => (typeof block?.text === 'string' ? block.text : ''))
  .join('\n')

const truncateBytes = (text, maxBytes) => {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') <= maxBytes) return { text: text ?? '', truncated: false }
  const buf = Buffer.from(text, 'utf8')
  let end = maxBytes
  // Back off UTF-8 continuation bytes so we never split a code point.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true }
}

export function install(rt) {
  const ctx = rt.ctx
  let jobs
  const attachJobs = (sub) => {
    const own = sub.jobs
    jobs = own
    sub.effect(() => () => { if (jobs === own) jobs = undefined }, 'ds-bot: jobs service')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['jobs'], attachJobs)
  else if (ctx.get?.('jobs') !== undefined) attachJobs({ jobs: ctx.get('jobs'), effect: (execute, label) => ctx.effect(execute, label) })

  const privateOf = (sessionId) => sessionId !== undefined && rt.chatOwners.has(sessionId) && !rt.groupOwners.has(sessionId)
  const liveAgent = (sessionId) => ctx.get('agents')?.get(sessionId)

  // Per-session state kept by the session/event listener below.
  const state = new Map()
  const stateOf = (id) => {
    let entry = state.get(id)
    if (entry === undefined) {
      entry = {
        phase: 'boundary',
        jobsByCall: new Map(),
        jobWaiters: new Map(),
        steerWaiters: new Set(),
        detachedJobs: new Set(),
        settledJobs: new Set(),
        settledKilledJobs: new Set(),
        killedJobs: new Set(),
        readJobs: new Set(),
        jobToolCalls: new Map(),
        activeWaitReads: new Map(),
        activeKills: new Map(),
        cutting: false,
      }
      state.set(id, entry)
    }
    return entry
  }

  // How long a Bot's own chat waits for a shell call before it goes on as a background
  // job and the step moves on (Settings > Background work).
  rt.backgroundWaitMs = () => {
    const seconds = rt.state?.prefs?.backgroundAfterSec
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : BACKGROUND_WAIT_MS
  }
  // Background jobs still running for a Session. A reply that announces work while
  // this is empty and no subagent runs is marked in the group view (#977).
  rt.runningJobs = (sessionId) => {
    if (jobs === undefined || sessionId === undefined) return []
    try {
      return jobs.list(sessionId).filter(job => job.status === 'running' || job.status === 'stopping')
    } catch {
      return undefined
    }
  }

  const hasJobCapacity = (sessionId) => {
    if (jobs === undefined) return false
    if (typeof jobs.list !== 'function') return true
    const active = rt.runningJobs(sessionId)
    if (active === undefined) return false
    const limit = Number.isInteger(jobs.maxConcurrentJobsPerOwner) && jobs.maxConcurrentJobsPerOwner > 0
      ? jobs.maxConcurrentJobsPerOwner : DEFAULT_MAX_CONCURRENT_JOBS
    return active.length < limit
  }

  const isUserSteer = (event) => event?.data?.target === 'next-step'
    && (event.data.inserted ?? []).some(message => message?.source?.kind === 'user')
  const wake = (set, value) => { const waiters = [...set]; set.clear(); for (const fn of waiters) fn(value) }

  // A user steer into a private chat must cut a running model call. The check runs
  // off the event that queued it, never inside the append that emitted the event.
  const maybeCut = (id) => {
    const entry = rt.live.get(id)
    const agent = liveAgent(id)
    if (!privateOf(id) || rt.readOnly?.() !== undefined || entry === undefined || agent === undefined) return
    if (rt.taskOwners?.has(id) || rt.shouldMoveForeground?.(rt.botOf(rt.chatOwners.get(id)), id)) return
    if ([...(rt.switchJobs?.() ?? [])].some(job => job?.botId === rt.chatOwners.get(id) && job.roomId === undefined)) return
    const track = stateOf(id)
    if (track.phase !== 'model' || track.cutting) return
    if (entry.turn === undefined || (entry.calls?.size ?? 0) > 0 || agent.status !== 'running') return
    const nextStep = agent.inbox?.nextStep ?? []
    const last = [...nextStep].reverse().find(message => message?.source?.kind === 'user')
    if (last === undefined) return
    track.cutting = true
    rt.markSteerCut(id)
    agent.inbox.remove(last.id)
    agent.cancel({ kind: 'hook', reason: STEER_CUT }, { keepInbox: true })
    agent.send(last, 'next-turn', true)
    if (agent.inbox.nextTurn[0]?.id !== last.id) {
      agent.inbox.remove(last.id)
      agent.inbox.prepend('next-turn', last)
    }
  }
  const scheduleCut = (id) => { queueMicrotask(() => maybeCut(id)) }

  // Renders one jobs.read() result the way tool-jobs' renderModelDelta does:
  // stdout and unlabeled chunks joined, then a [stderr] section, then a
  // dropped-output note when the ring lost bytes.
  const renderJobRead = (read) => {
    const visible = (read.chunks ?? []).filter(chunk => chunk?.channel !== 'log')
    const out = visible.filter(chunk => chunk.channel !== 'stderr').map(chunk => chunk.text ?? '').join('')
    const err = visible.filter(chunk => chunk.channel === 'stderr').map(chunk => chunk.text ?? '').join('')
    const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
    const body = out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
    const spillPaths = read.job?.output?.spillPaths ?? []
    if (read.lossy !== true && !visible.some(chunk => chunk.gapBefore === true)) return body
    const notice = `[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`
    return `${body}${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}${notice}`
  }

  const noticeOf = (name, command, text) => createUserMessage({
    content: [{ type: 'text', text }],
    // Same source as DSH's job-completion notice so every chat renders it the
    // same way, and DS Bot's routing ignores it.
    source: { kind: 'tool-jobs', form: 'notice', summary: boundContextSummary(`${name} ${command} …`) },
  })

  const redact = (text) => (typeof rt.redactSecrets === 'function' ? rt.redactSecrets(text) : text)
  const boundedText = (text) => {
    const safe = redact(typeof text === 'string' ? text : '')
    const clipped = truncateBytes(safe, INLINE_OUTPUT_LIMIT)
    return clipped.truncated ? `${clipped.text}\n[output truncated to ${INLINE_OUTPUT_LIMIT} bytes]` : clipped.text
  }

  // Fallback completion delivery used only when a user steer detached a call
  // before DSH's own waitOnJob timed out.
  const detachAfter = (jobId, args, exec, def, native, label) => {
    const id = exec.agent.id
    const command = boundContextSummary(redact(String(args?.command ?? '').split(/\r?\n/, 1)[0]))
    const track = stateOf(id)
    track.detachedJobs.add(jobId)
    const consume = (value) => {
      track.detachedJobs.delete(jobId)
      track.settledJobs.delete(jobId)
      const activeKill = (track.activeKills.get(jobId)?.size ?? 0) > 0
      track.activeKills.delete(jobId)
      track.activeWaitReads.delete(jobId)
      for (const [callId, call] of track.jobToolCalls) {
        if (call.jobId === jobId) track.jobToolCalls.delete(callId)
      }
      const settledKilled = track.settledKilledJobs.delete(jobId)
      const killed = track.killedJobs.delete(jobId) || (activeKill && (settledKilled || value?.stopped !== undefined))
      // Only suppress on a confirmed terminal job_output tool/result: when
      // waitOnJob settles and removes the job first, any in-flight
      // job_output(wait:true) fails with "unknown job" and cannot deliver output.
      const read = track.readJobs.delete(jobId)
      return killed || read || liveAgent(id) !== exec.agent
    }
    native.then(value => {
      if (consume(value)) return
      const deliver = (text) => {
        const message = noticeOf(label, command, text)
        if (exec.agent.status === 'idle') return exec.agent.followup(message)
        return exec.agent.inject(message)
      }
      if (value?.kind === 'promoted') {
        // The native timeout passed after the steer detach; the job stays
        // registered and tool-jobs will notify on settle.
        if (typeof value.output === 'string' && value.output !== '') {
          return deliver(`background job ${jobId} (${label}: ${command}) is still running. Output since your last read:\n${boundedText(value.output)}`)
        }
        return
      }
      const rendered = (def.output?.render?.(args, value) ?? [])
        .map(block => block?.text ?? '')
        .filter(text => text !== '')
        .join('\n')
      return deliver(`background job ${jobId} (${label}: ${command}) finished:\n${boundedText(rendered)}`)
    }, error => {
      if (consume(undefined)) return
      const message = noticeOf(label, command, `background job ${jobId} (${label}: ${command}) failed: ${boundedText(error?.message ?? String(error))}`)
      if (exec.agent.status === 'idle') return exec.agent.followup(message)
      return exec.agent.inject(message)
    })
  }

  const paramOf = (def, key) => def?.parameters?.properties?.[key] ?? def?.parameters?.[key]
  const hasPromotedFormat = (def) => {
    const promoted = (def.output?.schema?.oneOf ?? []).find(variant => variant?.properties?.kind?.const === 'promoted')
    return typeof def.output?.render === 'function'
      && promoted?.properties?.cwd !== undefined && promoted?.properties?.jobId !== undefined
      && promoted?.properties?.timeoutMs !== undefined && promoted?.properties?.output !== undefined
  }
  const hasBackgroundFormat = (def) => paramOf(def, 'run_in_background') !== undefined
    && (def.output?.schema?.oneOf ?? []).some(variant => variant?.properties?.kind?.const === 'background')
  const canNativePromote = (def) => hasPromotedFormat(def)
    && paramOf(def, 'run_in_background') !== undefined
    && !/kills the command on expiry/i.test(paramOf(def, 'timeoutMs')?.description ?? '')

  // Track the underlying global definition wrapped per agent so tools/change
  // (e.g. when jobs attaches after startup and dsh-tool-bash re-registers) can
  // refresh the shadow without recursive wrapping.
  const wrappedDefs = new WeakSet()
  const agentShadows = new WeakMap()
  const formatWarned = new Set()
  const KEEP_CURRENT = Symbol('keep-current-shadow')

  const resolveShellDef = (name, agent, current) => {
    if (typeof ctx.tools?.get !== 'function') return undefined
    const globalRaw = ctx.tools.get(name)
    const globalDef = globalRaw !== undefined && !wrappedDefs.has(globalRaw) ? globalRaw : undefined
    if (current !== undefined) {
      if (current.fromGlobal) {
        if (globalDef === undefined) return undefined
        if (globalDef === current.rawDef) return KEEP_CURRENT
        return { def: globalDef, fromGlobal: true, checkVisibleAfterDispose: true }
      }
      const scopedDef = ctx.tools.get(name, agent)
      if (scopedDef !== undefined && wrappedDefs.has(scopedDef)) return KEEP_CURRENT
      return scopedDef !== undefined ? { def: scopedDef, fromGlobal: false, checkVisibleAfterDispose: false } : undefined
    }
    // Initial attach must respect agent-level tools.restrict() visibility.
    const visible = ctx.tools.get(name, agent)
    if (visible === undefined || wrappedDefs.has(visible)) return undefined
    return { def: visible, fromGlobal: visible === globalDef, checkVisibleAfterDispose: false }
  }

  const shadowShell = (agent, name, def) => {
    if (!hasPromotedFormat(def)) {
      if (!formatWarned.has(name)) {
        formatWarned.add(name)
        rt.warn('ds-bot: %s has no promoted result format; its calls keep the step boundary', name)
      }
      return undefined
    }
    const wrapper = {
      ...def,
      ...(typeof def.presentResult === 'function' ? {
        presentResult: (args, result) => {
          const effectiveArgs = result?.value?.kind === 'background' && args?.run_in_background !== true
            ? { ...args, run_in_background: true } : args
          return def.presentResult(effectiveArgs, result)
        },
      } : {}),
      execute: async (args, exec) => {
        const sessionId = exec.agent?.id
        if (args?.run_in_background === true || jobs === undefined || sessionId === undefined
          || !privateOf(sessionId)) return def.execute(args, exec)

        const waitMs = rt.backgroundWaitMs?.()
        const capacity = hasJobCapacity(sessionId)

        // 0s setting: hand off directly to DSH's native run_in_background path
        // so approval runs first, startJob registers once, and tool-jobs owns
        // every read and completion notice.
        if (waitMs === 0 && capacity && hasBackgroundFormat(def)) {
          return def.execute({ ...args, run_in_background: true }, exec)
        }

        // Tighten timeoutMs into DSH's native waitOnJob whenever the shell tool
        // supports native timeout promotion and the owner has job capacity.
        // Leave invalid caller timeoutMs untouched so DSH's own validation rejects it.
        const nativePromote = Number.isFinite(waitMs) && waitMs > 0 && capacity && canNativePromote(def)
        const callerTimeout = args?.timeoutMs
        const validCallerTimeout = callerTimeout === undefined || (Number.isFinite(callerTimeout) && callerTimeout > 0)
        const effectiveTimeoutMs = nativePromote && validCallerTimeout
          ? (callerTimeout !== undefined ? Math.min(callerTimeout, waitMs) : waitMs)
          : undefined
        const callArgs = effectiveTimeoutMs !== undefined ? { ...args, timeoutMs: effectiveTimeoutMs } : args

        const track = stateOf(sessionId)
        // Proxy exec.signal so a turn cancellation (such as STEER_CUT) after a
        // steer detach cannot reach waitOnJob and kill the promoted job, while
        // still forwarding aborts before detach (including during approvals).
        const nativeController = new AbortController()
        const onTurnAbort = () => nativeController.abort(exec.signal.reason)
        if (exec.signal?.aborted) nativeController.abort(exec.signal.reason)
        else exec.signal?.addEventListener('abort', onTurnAbort, { once: true })
        const detachSignal = () => exec.signal?.removeEventListener('abort', onTurnAbort)
        const nativeExec = exec.signal === undefined ? exec : { ...exec, signal: nativeController.signal }

        let steeredAt = (exec.agent.inbox?.nextStep ?? []).some(message => message?.source?.kind === 'user') ? Date.now() : undefined
        let steerSignal
        const onSteer = () => {
          if (steeredAt === undefined) steeredAt = Date.now()
          steerSignal?.()
        }
        // Subscribe before calling def.execute so a steer arriving during
        // approval or before job/registered is never missed.
        track.steerWaiters.add(onSteer)

        let native
        try {
          native = Promise.resolve(def.execute(callArgs, nativeExec))
        } catch (error) {
          track.steerWaiters.delete(onSteer)
          detachSignal()
          throw error
        }
        native.catch(() => {})

        let jobResolve
        let graceTimer
        let waitTimer
        let runningSince
        let detached = false
        try {
          const known = track.jobsByCall.get(exec.callId)
          const jobWait = known !== undefined ? Promise.resolve(known) : new Promise((resolve) => {
            jobResolve = resolve
            const set = track.jobWaiters.get(exec.callId) ?? new Set()
            track.jobWaiters.set(exec.callId, set)
            set.add(resolve)
          })
          const registered = await Promise.race([native.then(() => 'native', () => 'native'), jobWait.then(() => 'job')])
          if (registered !== 'job') return await native
          runningSince = Date.now()

          if (waitMs !== 0 || !capacity) {
            if (steeredAt === undefined && (exec.agent.inbox?.nextStep ?? []).some(message => message?.source?.kind === 'user')) {
              steeredAt = Date.now()
            }
            if (steeredAt === undefined) {
              const steerPromise = new Promise((resolve) => { steerSignal = () => resolve('steered') })
              // When nativePromote is active, DSH's own waitOnJob owns the
              // timeout so we only wake early on a user steer. Otherwise (e.g.
              // a custom/mock tool without run_in_background), keep the local
              // wait timer as fallback.
              const racers = [native.then(() => 'native', () => 'native'), steerPromise]
              if (!nativePromote && Number.isFinite(waitMs) && waitMs > 0) {
                racers.push(new Promise((resolve) => { waitTimer = setTimeout(() => resolve('waited'), waitMs) }))
              }
              const first = await Promise.race(racers)
              if (first !== 'steered' && first !== 'waited') return await native
            }
            if (steeredAt !== undefined) {
              const remainingGrace = Math.max(0, STEER_GRACE_MS - (Date.now() - steeredAt))
              const capMs = effectiveTimeoutMs ?? (Number.isFinite(waitMs) && waitMs > 0 ? waitMs : Infinity)
              const remainingWait = Number.isFinite(capMs) ? Math.max(0, capMs - (Date.now() - runningSince)) : Infinity
              // If native waitOnJob will promote within the steer grace window
              // anyway, stay on the native single track instead of detaching.
              if (nativePromote && remainingWait <= remainingGrace) return await native
              const grace = Math.min(remainingGrace, remainingWait)
              if (grace > 0) {
                const graced = await Promise.race([
                  native.then(() => 'native', () => 'native'),
                  new Promise((resolve) => { graceTimer = setTimeout(() => resolve('grace'), grace) }),
                ])
                if (graced !== 'grace') return await native
              }
            }
          }

          if (nativeController.signal.aborted) return await native
          const jobId = track.jobsByCall.get(exec.callId)
          let read
          try {
            read = jobs.read(jobId, sessionId)
          } catch {
            return await native
          }
          const status = read?.job?.status
          if (status === 'completed' || status === 'killed' || status === 'failed') return await native
          detached = true
          detachSignal()
          detachAfter(jobId, args, exec, def, native, name)
          const base = rt.sessionFolder?.(exec.agent.session)
          const cwd = args?.workdir === undefined ? (base ?? '')
            : !isAbsolute(args.workdir) && base !== undefined ? resolve(base, args.workdir) : args.workdir
          return { kind: 'promoted', cwd, jobId, timeoutMs: Math.max(0, Date.now() - runningSince), output: renderJobRead(read) }
        } finally {
          if (!detached) void native.then(detachSignal, detachSignal)
          track.steerWaiters.delete(onSteer)
          if (jobResolve !== undefined) {
            const set = track.jobWaiters.get(exec.callId)
            set?.delete(jobResolve)
            if (set?.size === 0) track.jobWaiters.delete(exec.callId)
          }
          clearTimeout(graceTimer)
          clearTimeout(waitTimer)
        }
      },
    }
    wrappedDefs.add(wrapper)
    const lift = agent.ctx.tools.register(wrapper)
    return typeof lift === 'function' ? lift : () => {}
  }

  const syncing = new WeakSet()

  const syncShellShadows = (agent) => {
    if (agent === undefined || !rt.isBotSession(agent.session?.id)) return false
    if (typeof agent.ctx?.tools?.register !== 'function') return false
    // agent.ctx.tools.register() and its disposer synchronously emit tools/change;
    // ignore re-entrant refreshes triggered by our own mutations.
    if (syncing.has(agent)) return (agentShadows.get(agent)?.size ?? 0) > 0
    syncing.add(agent)
    try {
      let map = agentShadows.get(agent)
      if (map === undefined) {
        map = new Map()
        agentShadows.set(agent, map)
      }
      for (const name of SHELL_TOOLS) {
        const current = map.get(name)
        const resolved = resolveShellDef(name, agent, current)
        if (resolved === KEEP_CURRENT) continue
        if (current !== undefined) {
          map.delete(name)
          current.dispose()
        }
        if (resolved === undefined) continue
        if (resolved.checkVisibleAfterDispose && ctx.tools.get(name, agent) !== resolved.def) continue
        try {
          const dispose = shadowShell(agent, name, resolved.def)
          if (dispose !== undefined) map.set(name, { rawDef: resolved.def, fromGlobal: resolved.fromGlobal, dispose })
        } catch (error) {
          rt.warn('ds-bot: shadowing %s failed: %s', name, error)
        }
      }
      return map.size > 0
    } finally {
      syncing.delete(agent)
    }
  }

  const ownedDisposers = new WeakSet()
  rt.shadowShells = (agent) => {
    if (agent === undefined || !rt.isBotSession(agent.session?.id)) return []
    if (typeof agent.ctx?.tools?.register !== 'function') return []
    const alreadyOwned = ownedDisposers.has(agent)
    ownedDisposers.add(agent)
    syncShellShadows(agent)
    if (alreadyOwned) return []
    const id = agent.session?.id ?? agent.id
    return [() => {
      ownedDisposers.delete(agent)
      syncing.add(agent)
      try {
        const map = agentShadows.get(agent)
        agentShadows.delete(agent)
        if (map !== undefined) {
          for (const item of map.values()) item.dispose()
          map.clear()
        }
      } finally {
        syncing.delete(agent)
      }
      if (id !== undefined && (liveAgent(id) === undefined || liveAgent(id) === agent)) {
        state.delete(id)
      }
    }]
  }
  rt.refreshShellShadows = (agent) => {
    if (agent !== undefined && ownedDisposers.has(agent)) syncShellShadows(agent)
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined || !privateOf(id)) return
    const track = stateOf(id)
    switch (event.type) {
      case 'step/start': {
        track.phase = 'model'
        const agent = liveAgent(id)
        if ((agent?.inbox?.nextStep ?? []).some(message => message?.source?.kind === 'user')) scheduleCut(id)
        break
      }
      case 'assistant/message':
        track.phase = 'tools'
        break
      case 'step/end':
      case 'turn/start':
      case 'turn/end':
        track.phase = 'boundary'
        track.cutting = false
        break
      case 'job/registered': {
        const callId = event.data?.toolCall?.callId
        if (callId !== undefined) {
          track.jobsByCall.set(callId, event.data.jobId)
          const set = track.jobWaiters.get(callId)
          if (set !== undefined) { track.jobWaiters.delete(callId); wake(set, event.data.jobId) }
        }
        break
      }
      case 'job/settled':
        if (event.data?.toolCall?.callId !== undefined) track.jobsByCall.delete(event.data.toolCall.callId)
        if (event.data?.jobId !== undefined) {
          if (track.detachedJobs.has(event.data.jobId)) {
            track.settledJobs.add(event.data.jobId)
            if (event.data.status === 'killed') track.settledKilledJobs.add(event.data.jobId)
          } else {
            track.killedJobs.delete(event.data.jobId)
          }
        }
        break
      case 'tool/call': {
        if (event.data?.name === 'job_kill' || event.data?.name === 'job_output') {
          try {
            const parsed = JSON.parse(event.data.arguments ?? '{}')
            const jobId = parsed.job_id
            if (jobId === undefined) break
            const tracked = track.detachedJobs.has(jobId) || [...track.jobsByCall.values()].includes(jobId)
            if (tracked) {
              const callId = event.data.callId
              if (event.data.name === 'job_kill') {
                if (callId === undefined) track.killedJobs.add(jobId)
                else {
                  track.jobToolCalls.set(callId, { name: 'job_kill', jobId })
                  addToSetMap(track.activeKills, jobId, callId)
                }
              } else if (track.detachedJobs.has(jobId) && (parsed.wait === true || track.settledJobs.has(jobId))) {
                if (callId === undefined) track.readJobs.add(jobId)
                else {
                  track.jobToolCalls.set(callId, { name: 'job_output', jobId })
                  addToSetMap(track.activeWaitReads, jobId, callId)
                }
              }
            }
          } catch { /* unparseable args carry no job target */ }
        }
        break
      }
      case 'tool/result': {
        const callId = event.data?.message?.toolCallId
        const call = callId !== undefined ? track.jobToolCalls.get(callId) : undefined
        if (call === undefined) break
        track.jobToolCalls.delete(callId)
        const failed = event.data?.message?.isError === true || event.data?.error !== undefined
        if (call.name === 'job_kill') {
          deleteFromSetMap(track.activeKills, call.jobId, callId)
          const stillTracked = track.detachedJobs.has(call.jobId) || [...track.jobsByCall.values()].includes(call.jobId)
          if (!failed && stillTracked) track.killedJobs.add(call.jobId)
        } else if (call.name === 'job_output') {
          deleteFromSetMap(track.activeWaitReads, call.jobId, callId)
          if (!failed && TERMINAL_JOB_STATUS.test(contentText(event.data?.message?.content))) {
            track.readJobs.add(call.jobId)
          }
        }
        break
      }
      case 'agent/inbox/spliced':
        if (isUserSteer(event)) {
          if (rt.taskOwners?.has(id) || rt.shouldMoveForeground?.(rt.botOf(rt.chatOwners.get(id)), id)) break
          wake(track.steerWaiters, true)
          scheduleCut(id)
        }
        break
    }
  })
}
