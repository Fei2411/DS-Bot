// The Claude Code engine: one process per session, stream-json both ways.
// stdin takes user/control JSON messages; stdout streams the assistant's
// events until a `result` ends the turn.
import { cleanEnv, spawnAgent } from './discover.js'

export class ClaudeEngine {
  constructor(route, engine, { findExecutable }) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.sessions = new Map()
  }

  // A live process holds its own event queue; the adapter drains it.
  open(dshSessionId, { cwd, resumeId, system, mode, mcp, model }) {
    let session = this.sessions.get(dshSessionId)
    if (session !== undefined && session.dead) session = undefined
    if (session === undefined) {
      session = new ClaudeSession(this, dshSessionId)
      this.sessions.set(dshSessionId, session)
    }
    return session.start({ cwd, resumeId, system, mode, mcp, model })
  }

  prompt(session, blocks) {
    return session.prompt(blocks)
  }

  cancel(session) {
    session.cancel()
  }

  // The adapter stopped reading this session. A process takes its model and tool
  // server when it starts, so it leaves too; a later open resumes the CLI session.
  forget(dshSessionId) {
    this.sessions.get(dshSessionId)?.kill()
    this.sessions.delete(dshSessionId)
  }

  async listModels() {
    return ['default', 'opus', 'sonnet', 'haiku'].map(id => ({ id, name: id === 'default' ? 'CLI default' : id }))
  }

  async close() {
    for (const session of this.sessions.values()) session.kill()
  }
}

class ClaudeSession {
  constructor(engine, dshSessionId) {
    this.engine = engine
    this.dshSessionId = dshSessionId
    this.events = []
    this.waiters = []
    this.dead = false
    this.idWaiters = []
  }

  emit(event) {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(event)
    else this.events.push(event)
  }
  next() {
    if (this.events.length > 0) return Promise.resolve(this.events.shift())
    return new Promise(resolve => this.waiters.push(resolve))
  }

  write(message) {
    try { this.child?.stdin.write(`${JSON.stringify(message)}\n`) } catch { this.dead = true }
  }

  async start({ cwd, resumeId, system, mode, mcp, model }) {
    if (this.child !== undefined) return this
    const bin = this.engine.findExecutable(this.engine.engine.command)
    if (bin === undefined) throw Object.assign(new Error(`${this.engine.engine.name} is not installed`), { code: 'NO_ADAPTER' })
    // Fixture scripts in tests ride in spec.args ahead of the real CLI flags.
    // The stream-json formats only exist in print mode: without `--print` the
    // CLI starts an interactive session and never speaks this protocol.
    const args = [...(this.engine.engine.args ?? []), '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    if (resumeId !== undefined) args.push('--resume', resumeId)
    if (system !== undefined) args.push('--append-system-prompt', system)
    if (mode !== undefined) args.push('--permission-mode', mode)
    if (model !== undefined && model !== 'default') args.push('--model', model)
    // Print mode has no one to ask: without a prompt tool a call that needs
    // permission is refused outright. `stdio` sends it here as a
    // control_request, which becomes the Bot's approval card.
    args.push('--permission-prompt-tool', 'stdio')
    if (mcp !== undefined) {
      args.push('--mcp-config', JSON.stringify({
        mcpServers: { dsbot: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } },
      }))
      // DS Bot's own team tools need no approval, as for a model-backed Bot:
      // toolsFor() already narrowed what this Bot may call.
      args.push('--allowedTools', 'mcp__dsbot')
    }
    this.resumeId = resumeId
    const child = this.child = spawnAgent(bin, args, {
      env: cleanEnv(this.engine.env ?? {}),
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // stderr is not part of the protocol, but it is where a CLI that cannot
    // start says why; its tail goes into the error the turn shows.
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    const fail = (message) => Object.assign(
      new Error(stderr.trim() === '' ? message : `${message}: ${stderr.trim().split('\n').slice(-5).join(' ')}`),
      { code: 'LOCAL_AGENT_EXIT' },
    )
    let rest = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      rest += chunk
      let at
      while ((at = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, at).trim()
        rest = rest.slice(at + 1)
        if (line !== '') this.onLine(line)
      }
    })
    // Writing to a CLI that has already exited fails asynchronously on stdin,
    // not on the child: without this listener the host dies with an unhandled
    // stream error. The failure goes into the session queue instead.
    child.stdin.on('error', (error) => {
      this.dead = true
      const failure = fail(`${this.engine.engine.name} stopped reading input: ${error.message}`)
      this.rejectStart?.(failure)
      this.rejectStart = undefined
      this.emit({ type: 'error', error: failure })
    })
    child.on('error', (error) => {
      this.dead = true
      const failure = fail(`${this.engine.engine.name} could not start: ${error.message}`)
      this.rejectStart?.(failure)
      this.rejectStart = undefined
      this.emit({ type: 'error', error: failure })
    })
    child.on('exit', (code, signal) => {
      this.dead = true
      // Claude Code deletes old conversations; resuming one that is gone exits
      // before init with this line on stderr.
      if (this.resumeId !== undefined && this.cliSessionId === undefined && /no conversation found/i.test(stderr)) this.resumeMissing = true
      for (const resolve of this.idWaiters.splice(0)) resolve(undefined)
      this.emit({ type: 'error', error: fail(`${this.engine.engine.name} exited ${signal === null ? `with code ${code}` : `on ${signal}`}`) })
    })
    // The CLI sends `system/init` only once the first message arrives on stdin,
    // and this engine writes that message after start resolves: waiting for init
    // here would deadlock every turn. A spawned process counts as started; a CLI
    // that cannot start reports it through 'error' instead.
    this.started = new Promise((resolve, reject) => {
      this.rejectStart = reject
      child.once('spawn', () => { this.rejectStart = undefined; resolve() })
    })
    return this.started.then(() => this)
  }

  onLine(line) {
    let event
    try { event = JSON.parse(line) } catch { return }
    switch (event?.type) {
      case 'system':
        if (event.subtype === 'init') {
          this.cliSessionId = event.session_id
          for (const resolve of this.idWaiters.splice(0)) resolve(this.cliSessionId)
        }
        break
      case 'assistant': {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text') this.emit({ type: 'text', text: block.text ?? '' })
          else if (block.type === 'thinking') this.emit({ type: 'thought', text: block.thinking ?? '' })
          else if (block.type === 'tool_use') this.emit({ type: 'activity', text: `▸ ${block.name ?? 'tool'}` })
        }
        break
      }
      case 'control_request': {
        const request = event.request ?? {}
        if (request.subtype === 'can_use_tool') {
          const tool = request.tool_name ?? 'tool'
          this.emit({
            type: 'permission', id: event.request_id,
            reply: (allowed) => this.write({
              type: 'control_response',
              response: { subtype: 'success', request_id: event.request_id, response: allowed === null ? { behavior: 'deny' } : { behavior: 'allow', updatedInput: request.input ?? {} } },
            }),
            action: `Run ${tool}`,
            detail: JSON.stringify(request.input ?? {}).slice(0, 4_000),
            options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
          })
        }
        break
      }
      case 'result':
        // A resume of a conversation the CLI no longer has ends at once, before
        // init and with no turn.
        if (this.resumeId !== undefined && this.cliSessionId === undefined && event.is_error === true && (event.num_turns ?? 0) === 0) {
          this.resumeMissing = true
          // It exits next and reads no more input.
          this.dead = true
          this.emit({ type: 'error', error: Object.assign(new Error(`${this.engine.engine.name} no longer has this conversation`), { code: 'LOCAL_AGENT_EXIT' }) })
          break
        }
        this.emit(event.subtype === 'success' || event.is_error !== true
          ? { type: 'done', reason: 'stop', usage: usageOf(event.usage) }
          : { type: 'error', error: new Error(event.result ?? 'the agent failed') })
        break
      default: break
    }
  }

  // The CLI reports its session id with `system/init`, which arrives after
  // start() resolved: callers that must persist it wait here.
  whenSessionId() {
    if (this.cliSessionId !== undefined) return Promise.resolve(this.cliSessionId)
    if (this.dead) return Promise.resolve(undefined)
    return new Promise(resolve => { this.idWaiters.push(resolve) })
  }

  prompt(blocks) {
    this.write({ type: 'user', message: { role: 'user', content: blocks } })
    return Promise.resolve()
  }

  async steer(thread, text) {
    this.prompt([{ type: 'text', text }])
  }

  cancel() {
    // The documented interrupt asks the turn to stop cleanly.
    this.write({ type: 'control_request', request: { subtype: 'interrupt' } })
  }

  kill() {
    this.dead = true
    this.child?.kill('SIGTERM')
    setTimeout(() => { try { this.child?.kill('SIGKILL') } catch {} }, 5_000).unref?.()
    this.child = undefined
  }
}

const usageOf = usage => (usage === undefined ? undefined : {
  inputTokens: usage.input_tokens ?? 0,
  outputTokens: usage.output_tokens ?? 0,
  ...(usage.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
})
