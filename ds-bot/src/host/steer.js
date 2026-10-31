// In a Bot's private chat a user steer must reach the Bot at once, not at the
// next DSH step boundary. Two mechanisms:
//  - a foreground shell call detaches into the jobs registry on a steer and
//    returns DSH's promoted result, so the step ends while the command runs on;
//  - a running model call is cancelled (hook reason) and the steer is moved to
//    the front of next-turn, so a fresh turn claims it at once.
import { isAbsolute, resolve } from 'node:path'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { STEER_CUT } from './constants.js'

const SHELL_TOOLS = ['pwsh', 'bash']
const STEER_GRACE_MS = 1000

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
    if (entry === undefined) state.set(id, entry = { phase: 'boundary', jobsByCall: new Map(), jobWaiters: new Map(), steerWaiters: new Set(), killedJobs: new Set(), cutting: false })
    return entry
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

  const detachAfter = (jobId, args, exec, def, native, label) => {
    const id = exec.agent.id
    const command = args?.command ?? ''
    native.then(value => {
      const track = stateOf(id)
      if (track.killedJobs.delete(jobId) || liveAgent(id) !== exec.agent) return
      const deliver = (text) => {
        const message = noticeOf(label, command, text)
        if (exec.agent.status === 'idle') return exec.agent.followup(message)
        return exec.agent.inject(message)
      }
      if (value?.kind === 'promoted') {
        // The native timeout passed after the detach; the job stays registered
        // and tool-jobs will notify on settle.
        if (typeof value.output === 'string' && value.output !== '') {
          return deliver(`background job ${jobId} (${label}: ${command}) is still running. Output since your last read:\n${value.output}`)
        }
        return
      }
      const rendered = (def.output?.render?.(args, value) ?? [])
        .map(block => block?.text ?? '')
        .filter(text => text !== '')
        .join('\n')
      return deliver(`background job ${jobId} (${label}: ${command}) finished:\n${rendered}`)
    }, error => {
      const track = stateOf(id)
      if (track.killedJobs.delete(jobId) || liveAgent(id) !== exec.agent) return
      const message = noticeOf(label, command, `background job ${jobId} (${label}: ${command}) failed: ${error?.message ?? String(error)}`)
      if (exec.agent.status === 'idle') return exec.agent.followup(message)
      return exec.agent.inject(message)
    })
  }

  const shadowed = new WeakSet()
  const formatWarned = new Set()
  const shadowShell = (agent, name) => {
    if (typeof ctx.tools?.get !== 'function') return
    const def = ctx.tools.get(name, agent)
    if (def === undefined) return
    const promoted = (def.output?.schema?.oneOf ?? []).find(variant => variant?.properties?.kind?.const === 'promoted')
    if (typeof def.output?.render !== 'function'
      || promoted?.properties?.cwd === undefined || promoted?.properties?.jobId === undefined
      || promoted?.properties?.timeoutMs === undefined || promoted?.properties?.output === undefined) {
      if (!formatWarned.has(name)) {
        formatWarned.add(name)
        rt.warn('ds-bot: %s has no promoted result format; its calls keep the step boundary', name)
      }
      return
    }
    shadowed.add(agent)
    agent.ctx.tools.register({
      ...def,
      execute: async (args, exec) => {
        const native = def.execute(args, exec)
        const sessionId = exec.agent?.id
        if (args?.run_in_background === true || jobs === undefined || sessionId === undefined
          || !privateOf(sessionId)) return native
        const track = stateOf(sessionId)
        const startedAt = Date.now()
        let steerResolve
        let jobResolve
        let graceTimer
        try {
          // A user steer ends the wait: first for the steer event itself, then a
          // short grace for a fast command, then for the job id the native call
          // registers (it may not exist yet while approval is pending).
          const steerSeen = () => {
            if ((exec.agent.inbox?.nextStep ?? []).some(message => message?.source?.kind === 'user')) return Promise.resolve('steered')
            return new Promise(resolve => { steerResolve = resolve; track.steerWaiters.add(resolve) }).then(() => 'steered')
          }
          const first = await Promise.race([native, steerSeen()])
          if (first !== 'steered') return await native
          const graced = await Promise.race([native, new Promise(resolve => { graceTimer = setTimeout(() => resolve('grace'), STEER_GRACE_MS) })])
          if (graced !== 'grace') return await native
          const known = track.jobsByCall.get(exec.callId)
          const jobWait = known !== undefined ? Promise.resolve(known) : new Promise(resolve => {
            jobResolve = resolve
            const set = track.jobWaiters.get(exec.callId) ?? new Set()
            track.jobWaiters.set(exec.callId, set)
            set.add(resolve)
          })
          const settled = await Promise.race([native.then(() => 'native'), jobWait.then(() => 'job')])
          if (settled !== 'job') return await native
        } catch {
          // A native rejection before or after the steer propagates unchanged.
          return await native
        } finally {
          if (steerResolve !== undefined) track.steerWaiters.delete(steerResolve)
          if (jobResolve !== undefined) {
            const set = track.jobWaiters.get(exec.callId)
            set?.delete(jobResolve)
            if (set?.size === 0) track.jobWaiters.delete(exec.callId)
          }
          clearTimeout(graceTimer)
        }
        const jobId = track.jobsByCall.get(exec.callId)
        let read
        try {
          read = jobs.read(jobId, sessionId)
        } catch {
          return await native
        }
        const status = read?.job?.status
        if (status === 'completed' || status === 'killed' || status === 'failed') return await native
        detachAfter(jobId, args, exec, def, native, name)
        const base = rt.sessionFolder?.(exec.agent.session)
        const cwd = args?.workdir === undefined ? (base ?? '')
          : !isAbsolute(args.workdir) && base !== undefined ? resolve(base, args.workdir) : args.workdir
        return { kind: 'promoted', cwd, jobId, timeoutMs: Date.now() - startedAt, output: renderJobRead(read) }
      },
    })
  }
  rt.shadowShells = (agent) => {
    if (agent === undefined || !rt.isBotSession(agent.session?.id)) return
    if (shadowed.has(agent) || typeof agent.ctx?.tools?.register !== 'function') return
    for (const name of SHELL_TOOLS) {
      try {
        shadowShell(agent, name)
      } catch (error) {
        rt.warn('ds-bot: shadowing %s failed: %s', name, error)
      }
    }
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
        break
      case 'tool/call': {
        if (event.data?.name === 'job_kill') {
          try {
            const parsed = JSON.parse(event.data.arguments ?? '{}')
            if (parsed.job_id !== undefined) track.killedJobs.add(parsed.job_id)
          } catch { /* unparseable args carry no kill target */ }
        }
        break
      }
      case 'agent/inbox/spliced':
        if (isUserSteer(event)) {
          wake(track.steerWaiters, true)
          scheduleCut(id)
        }
        break
    }
  })
}
