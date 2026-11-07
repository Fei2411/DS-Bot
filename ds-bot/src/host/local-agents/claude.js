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
    const args = [...(this.engine.engine.args ?? []), '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    if (resumeId !== undefined) args.push('--resume', resumeId)
    if (system !== undefined) args.push('--append-system-prompt', system)
    if (mode !== undefined) args.push('--permission-mode', mode)
    if (model !== undefined && model !== 'default') args.push('--model', model)
    if (mcp !== undefined) {
      args.push('--mcp-config', JSON.stringify({
        mcpServers: { dsbot: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } },
      }))
    }
    const child = this.child = spawnAgent(bin, args, {
      env: cleanEnv(this.engine.env ?? {}),
      cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    })
    // A write that meets the process on its way out fails with EPIPE; its exit reports it.
    child.stdin.on('error', () => { this.dead = true })
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
    child.on('exit', () => {
      this.dead = true
      this.emit({ type: 'error', error: new Error(`${this.engine.engine.name} exited`) })
    })
    this.started = new Promise((resolve, reject) => {
      this.onInit = resolve
      setTimeout(() => reject(new Error('the agent did not start')), 60_000).unref?.()
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
          this.onInit?.(this)
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
        this.emit(event.subtype === 'success' || event.is_error !== true
          ? { type: 'done', reason: 'stop', usage: usageOf(event.usage) }
          : { type: 'error', error: new Error(event.result ?? 'the agent failed') })
        break
      default: break
    }
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
