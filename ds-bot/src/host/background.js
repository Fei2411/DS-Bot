// Background tool calls. In a Bot's own chat a call that is not done within the wait
// (BACKGROUND_WAIT_MS, or the team's setting) goes on as a background job the Session
// owns, and the step moves on at once: the chat is free for the next message while the
// work runs. DSH's tool-jobs hands the result back when the job ends (it wakes an idle
// Session, or joins the next step of a busy one) and lets the Bot stop it with job_kill.
//
// DSH's `tools/execute` wrapper cannot do this: the pipeline ties the tool body to the
// call's own signal and freezes the call once it returns, so a body cannot outlive its
// call there. A shadow of the tool in the Session's own scope runs the body inside the
// job instead, with the job's signal. The shells keep their own path (steer.js), and a
// tool registered in the Session's own scope (team tools, a Bot's own MCP servers)
// cannot be shadowed there, so it keeps running in the step.
import { BACKGROUND_WAIT_MS, TEAM_TOOLS } from './constants.js'

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
// Calls that wait for a person or another Bot by design, and the job controls. `skill`
// lists what each Session has attached at the time it is asked, so a copy of it would
// keep an old list.
const KEEP_WAITING = new Set([...TEAM_TOOLS, 'job_output', 'job_list', 'job_kill', 'run_code', 'ask_user_question', 'skill'])
const LABEL_MAX = 120
// What a call that went on in the background returns. Its own key keeps it apart from
// every value the tool itself returns, so `oneOf` with the tool's schema stays exact.
// Written the way dsh-tools compiles a value schema (properties are required).
const NOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { backgroundJob: { type: 'string' }, note: { type: 'string' } },
}
const isNote = value => value !== null && typeof value === 'object' && typeof value.backgroundJob === 'string' && typeof value.note === 'string'
const NOTE_MARK = 'it goes on as background job'
const noteIn = result => (result?.content ?? []).some(block => typeof block?.text === 'string' && block.text.includes(NOTE_MARK))

const labelOf = (name, args) => {
  let detail = ''
  try { detail = JSON.stringify(args ?? {}) } catch { /* arguments that cannot print keep the name only */ }
  return `${name} ${detail}`.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX)
}

export function install(rt) {
  const ctx = rt.ctx
  let jobs
  const attachJobs = (sub) => {
    const own = sub.jobs
    jobs = own
    sub.effect(() => () => { if (jobs === own) jobs = undefined }, 'ds-bot: background jobs')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['jobs'], attachJobs)
  else if (ctx.get?.('jobs') !== undefined) attachJobs({ jobs: ctx.get('jobs'), effect: (execute, label) => ctx.effect(execute, label) })

  rt.backgroundWaitMs = () => {
    const seconds = rt.state?.prefs?.backgroundAfterSec
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : BACKGROUND_WAIT_MS
  }
  const ownChat = id => id !== undefined && rt.chatOwners.has(id) && !rt.groupOwners.has(id)

  const textOf = (def, args, value) => {
    const rendered = (def.output?.render?.(args, value) ?? [])
      .map(block => block?.text ?? '')
      .filter(text => text !== '')
      .join('\n')
    const text = rendered !== '' ? rendered : typeof value === 'string' ? value : JSON.stringify(value ?? null)
    return rt.redactText?.(text) ?? text
  }

  // The tool as it was, plus the note a backgrounded call returns. The tool's own
  // renderers never see the note: each one passes it by (undefined means "default").
  const outputOf = (def) => {
    const schema = def.output?.schema
    const anything = schema !== undefined && Object.keys(schema).length === 0
    return {
      ...def.output,
      schema: schema === undefined || anything ? (schema ?? {}) : { oneOf: [schema, NOTE_SCHEMA] },
      render: (args, value) => (isNote(value) ? [{ type: 'text', text: value.note }] : def.output.render(args, value)),
      ...(typeof def.output?.presentationMeta === 'function'
        ? { presentationMeta: (args, value) => (isNote(value) ? undefined : def.output.presentationMeta(args, value)) }
        : {}),
    }
  }
  const passNote = (fn, test) => (typeof fn === 'function' ? (...args) => (test(...args) ? undefined : fn(...args)) : undefined)

  const shadowOf = (name, def) => ({
    ...def,
    output: outputOf(def),
    ...(def.projectContent ? { projectContent: passNote(def.projectContent.bind(def), (_exec, result) => isNote(result?.value) || noteIn(result)) } : {}),
    ...(def.finalizeContent ? { finalizeContent: passNote(def.finalizeContent.bind(def), (_exec, result) => isNote(result?.value) || noteIn(result)) } : {}),
    ...(def.presentResult ? { presentResult: passNote(def.presentResult.bind(def), (_args, result) => noteIn(result)) } : {}),
    async execute(args, exec) {
      const owner = exec.agent?.id
      if (jobs === undefined || !ownChat(owner)) return def.execute(args, exec)
      const own = new AbortController()
      // The body reads the job's signal: it outlives the step, and job_kill or the
      // Session's end stops it.
      const runCtx = Object.create(exec, { signal: { value: own.signal, enumerable: true } })
      let body
      let id
      try {
        id = jobs.start({
          kind: 'tool',
          label: labelOf(name, args),
          owner,
          ...(exec.callId === undefined ? {} : { toolCall: { callId: exec.callId, name } }),
          run: () => {
            body = Promise.resolve().then(() => def.execute(args, runCtx))
            return {
              cancel: () => own.abort(),
              done: body.then(
                value => ({ status: 'completed', result: textOf(def, args, value) }),
                error => ({ status: own.signal.aborted ? 'killed' : 'failed', detail: rt.redactText?.(String(error?.message ?? error)) ?? String(error?.message ?? error) }),
              ),
            }
          },
        })
      } catch {
        // No controller serves this Session, or it already runs as many jobs as DSH
        // admits: the call runs in the step, as before.
        if (body !== undefined) return body
        return def.execute(args, exec)
      }
      const stop = () => own.abort()
      exec.signal?.addEventListener('abort', stop, { once: true })
      let view
      try {
        // A wait that is live when the job ends tells tool-jobs the result was
        // collected here, so no notice goes out for a call that came back in time.
        view = await jobs.wait(id, Math.max(1, rt.backgroundWaitMs()), owner)
      } finally {
        exec.signal?.removeEventListener('abort', stop)
      }
      if (view?.status !== 'running' && view?.status !== 'stopping') {
        try { jobs.remove(id, owner) } catch { /* already gone with its owner */ }
        return body
      }
      const seconds = Math.round(rt.backgroundWaitMs() / 1000)
      return { backgroundJob: id, note: `[Still running after ${seconds}s; ${NOTE_MARK} ${id}. Its result comes back to you when it ends, so do not wait or poll for it; stop it with job_kill.]` }
    },
  })

  // Shadows each tool this Session is served once; tools that arrive later are
  // shadowed on the next call (tools/change runs it again for every Bot Session).
  const shadowed = new WeakMap()
  rt.shadowTools = (agent) => {
    const id = agent?.session?.id
    if (agent === undefined || !rt.isBotSession(id) || typeof agent.ctx?.tools?.register !== 'function') return []
    if (typeof ctx.tools?.definitions !== 'function') return []
    const mine = shadowed.get(agent) ?? { names: new Map(), skipped: new Set() }
    shadowed.set(agent, mine)
    const disposers = []
    for (const def of ctx.tools.definitions(agent)) {
      const name = def?.name
      if (typeof name !== 'string' || SHELL_TOOLS.has(name) || KEEP_WAITING.has(name) || mine.skipped.has(name)) continue
      if (mine.names.get(name) === def || typeof def.execute !== 'function') continue
      const shadow = shadowOf(name, def)
      try {
        const lift = agent.ctx.tools.register(shadow)
        mine.names.set(name, shadow)
        disposers.push(() => {
          if (mine.names.get(name) === shadow) mine.names.delete(name)
          lift?.()
        })
      } catch {
        // Registered in the Session's own scope: it cannot be shadowed there.
        mine.skipped.add(name)
      }
    }
    return disposers
  }
}
