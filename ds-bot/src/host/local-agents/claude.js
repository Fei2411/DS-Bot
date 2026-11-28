// The Claude Code engine: one process per session, stream-json both ways.
// stdin takes user/control JSON messages; stdout streams the assistant's
// events until a `result` ends the turn.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { cleanEnv, findEngineExecutable, spawnAgent, terminateChild } from './discover.js'
import { lineSplitter } from './lines.js'

// Claude Code tools that only read; the rest may change files or run something.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead'])
// Stop reasons that end an assistant message without expecting a tool result.
const TERMINAL_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal', 'model_context_window_exceeded'])
// Grace window after a definitive end-of-message signal (`message_stop` or terminal `stop_reason`)
// before completing a turn when stream-json never emits `result` (#2382).
const DEFAULT_RESULT_GRACE_MS = 5_000
// Fallback quiet window when neither `stream_event` nor `stop_reason` is available.
const DEFAULT_RESULT_FALLBACK_MS = 15_000
// On Windows, CreateProcessW caps total command-line length at 32K chars (and .cmd shims at 8K);
// pass long appended system prompts via `--append-system-prompt-file` to stay well below OS limits.
const DEFAULT_SYSTEM_FILE_THRESHOLD = process.platform === 'win32' ? 4_000 : 64_000

export class ClaudeEngine {
  constructor(route, engine, {
    findExecutable,
    systemFileThreshold = DEFAULT_SYSTEM_FILE_THRESHOLD,
    resultGraceMs = DEFAULT_RESULT_GRACE_MS,
    resultFallbackMs = DEFAULT_RESULT_FALLBACK_MS,
  } = {}) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.systemFileThreshold = systemFileThreshold
    this.resultGraceMs = resultGraceMs
    this.resultFallbackMs = resultFallbackMs
    this.noPromptFile = false
    this.noPartialMessages = false
    this.forkSupported = undefined
    this.sessions = new Map()
  }

  // A live process holds its own event queue; the adapter drains it.
  open(dshSessionId, { cwd, resumeId, forkSession = false, system, mode, mcp, model }) {
    let session = this.sessions.get(dshSessionId)
    if (session !== undefined && session.dead) session = undefined
    if (session === undefined) {
      session = new ClaudeSession(this, dshSessionId)
      this.sessions.set(dshSessionId, session)
    }
    return session.start({ cwd, resumeId, forkSession, system, mode, mcp, model })
  }

  prompt(session, blocks) {
    return session.prompt(blocks)
  }

  canSteer(session) {
    return session.running === true
  }

  steer(session, input) {
    return session.steer(input)
  }

  cancel(session) {
    session.cancel()
  }

  compact(session) {
    return session.compact()
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
    this.sessions.clear()
  }
}

class ClaudeSession {
  constructor(engine, dshSessionId) {
    this.engine = engine
    this.dshSessionId = dshSessionId
    this.events = []
    this.waiters = []
    this.dead = false
    this.retired = false
    this.idWaiters = []
    this.turnCalls = new Set()
    this.pendingToolUses = new Set()
    this.pendingPermissions = new Set()
    this.pendingHooks = new Set()
    this.awaitingToolResult = false
    this.compacting = false
    this.inMessage = false
    this.lastMessageId = null
    this.messageHasToolUse = false
    this.messageStopReason = null
    this.messageStopped = false
    this.turnSawStreamEvent = false
    this.turnHasAssistantOutput = false
    this.turnUsage = undefined
    this.resultTimer = undefined
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

  async start({ cwd, resumeId, forkSession = false, system, mode, mcp, model }) {
    if (this.child !== undefined) return this
    const bin = findEngineExecutable(this.engine.engine, name => this.engine.findExecutable(name))
    if (bin === undefined) throw Object.assign(new Error(`${this.engine.engine.name} is not installed`), { code: 'NO_ADAPTER' })
    // Fixture scripts in tests ride in spec.args ahead of the real CLI flags.
    // The stream-json formats only exist in print mode: without `--print` the
    // CLI starts an interactive session and never speaks this protocol.
    const args = [...(this.engine.engine.args ?? []), '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    if (!this.engine.noPartialMessages) {
      args.push('--include-partial-messages')
      this.usedPartialMessages = true
    }
    if (resumeId !== undefined) {
      if (forkSession === true && this.engine.forkSupported === false) {
        // Never silently resume the parent conversation when a fork was requested but unsupported.
        this.forkUnsupported = true
        this.dead = true
        throw Object.assign(new Error(`${this.engine.engine.name} does not support --fork-session`), { code: 'LOCAL_AGENT_EXIT' })
      }
      args.push('--resume', resumeId)
      if (forkSession === true) {
        args.push('--fork-session')
        this.usedForkSession = true
      }
    }
    if (system !== undefined) {
      const threshold = this.engine.systemFileThreshold ?? DEFAULT_SYSTEM_FILE_THRESHOLD
      if (!this.engine.noPromptFile && system.length > threshold) {
        const dir = mkdtempSync(join(tmpdir(), 'dsb-claude-sys-'))
        this.systemPromptDir = dir
        this.usedPromptFile = true
        this.onProcessExit = () => { this.cleanupSystemFile() }
        process.once('exit', this.onProcessExit)
        try {
          try { chmodSync(dir, 0o700) } catch {}
          const promptFile = join(dir, 'system-prompt.txt')
          writeFileSync(promptFile, system, { flag: 'wx', mode: 0o600 })
          args.push('--append-system-prompt-file', promptFile)
        } catch (error) {
          this.cleanupSystemFile()
          throw error
        }
      } else {
        args.push('--append-system-prompt', system)
      }
    }
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
    cwd = resolve(cwd ?? process.cwd())
    // A resumed conversation may restore a shell directory we cannot observe.
    this.cwd = resumeId === undefined ? cwd : undefined
    let child
    try {
      child = this.child = spawnAgent(bin, args, {
        env: cleanEnv(this.engine.engine.env ?? this.engine.env ?? {}),
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.dead = true
      this.cleanupSystemFile()
      throw error
    }
    // stderr is not part of the protocol, but it is where a CLI that cannot
    // start says why; its tail goes into the error the turn shows.
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    const fail = (message) => Object.assign(
      new Error(stderr.trim() === '' ? message : `${message}: ${stderr.trim().split('\n').slice(-5).join(' ')}`),
      { code: 'LOCAL_AGENT_EXIT' },
    )
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', lineSplitter(line => this.onLine(line)))
    // Writing to a CLI that has already exited fails asynchronously on stdin,
    // not on the child: without this listener the host dies with an unhandled
    // stream error. The failure goes into the session queue instead.
    child.stdin.on('error', (error) => {
      if (this.retired) return
      this.cancelResultTimer()
      this.dead = true
      const failure = fail(`${this.engine.engine.name} stopped reading input: ${error.message}`)
      this.rejectStart?.(failure)
      this.rejectStart = undefined
      this.emit({ type: 'error', error: failure })
    })
    child.on('error', (error) => {
      if (this.retired) return
      this.cancelResultTimer()
      this.dead = true
      this.cleanupSystemFile()
      const failure = fail(`${this.engine.engine.name} could not start: ${error.message}`)
      this.rejectStart?.(failure)
      this.rejectStart = undefined
      this.emit({ type: 'error', error: failure })
    })
    child.on('exit', (code, signal) => {
      this.cancelResultTimer()
      this.dead = true
      this.cleanupSystemFile()
      if (this.retired) {
        for (const resolve of this.idWaiters.splice(0)) resolve(this.cliSessionId)
        return
      }
      // Older Claude CLI builds without `--append-system-prompt-file` reject it before init.
      if (this.usedPromptFile === true && this.cliSessionId === undefined && /unknown option.*append-system-prompt-file|unrecognized option.*append-system-prompt-file/i.test(stderr)) {
        this.engine.noPromptFile = true
        this.promptFileUnsupported = true
      }
      if (this.usedPartialMessages === true && this.cliSessionId === undefined && /unknown option.*include-partial-messages|unrecognized option.*include-partial-messages/i.test(stderr)) {
        this.engine.noPartialMessages = true
        this.partialMessagesUnsupported = true
      }
      if (this.usedForkSession === true && this.cliSessionId === undefined && /unknown option.*fork-session|unrecognized option.*fork-session/i.test(stderr)) {
        this.engine.forkSupported = false
        this.forkUnsupported = true
      }
      // Claude Code deletes old conversations; resuming one that is gone exits
      // before init with this line on stderr.
      if (this.resumeId !== undefined && this.cliSessionId === undefined && /no conversation found/i.test(stderr)) this.resumeMissing = true
      if (code === 0 && signal === null && this.canFinishWithoutResult()) {
        for (const resolve of this.idWaiters.splice(0)) resolve(this.cliSessionId)
        this.finishWithoutResult({ retireChild: false })
        return
      }
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
    if (this.retired) return
    let event
    try { event = JSON.parse(line) } catch { return }
    switch (event?.type) {
      case 'system':
        if (event.subtype === 'init') {
          this.cliSessionId = event.session_id
          if (typeof event.cwd === 'string' && isAbsolute(event.cwd)) this.cwd = event.cwd
          this.model = event.model
          for (const resolve of this.idWaiters.splice(0)) resolve(this.cliSessionId)
        } else if (event.subtype === 'compact_boundary') {
          this.compacting = false
          this.emit({ type: 'compaction', status: 'completed' })
        } else if (event.subtype === 'status' && event.status === 'compacting') {
          this.compacting = true
          this.cancelResultTimer()
          this.emit({ type: 'compaction', status: 'started' })
        } else if (event.subtype === 'status' && this.compacting) {
          this.compacting = false
          this.maybeScheduleResultFallback()
        } else if (event.subtype === 'hook_started') {
          this.pendingHooks.add(event.hook_id ?? event.uuid ?? 'hook')
          this.cancelResultTimer()
        } else if (event.subtype === 'hook_response') {
          if (event.hook_id !== undefined || event.uuid !== undefined) this.pendingHooks.delete(event.hook_id ?? event.uuid)
          else this.pendingHooks.clear()
          this.maybeScheduleResultFallback()
        }
        break
      case 'stream_event': {
        if (event.parent_tool_use_id != null) break
        this.turnSawStreamEvent = true
        const inner = event.event
        switch (inner?.type) {
          case 'message_start':
            this.cancelResultTimer()
            this.inMessage = true
            this.messageHasToolUse = false
            this.messageStopReason = null
            this.messageStopped = false
            this.recordTurnUsage(inner.message?.usage)
            break
          case 'content_block_start':
            this.cancelResultTimer()
            if (inner.content_block?.type === 'tool_use') {
              this.messageHasToolUse = true
              this.turnHasAssistantOutput = false
            }
            break
          case 'content_block_delta':
          case 'content_block_stop':
            this.cancelResultTimer()
            break
          case 'message_delta':
            this.cancelResultTimer()
            if (typeof inner.delta?.stop_reason === 'string') this.messageStopReason = inner.delta.stop_reason
            this.recordTurnUsage(inner.usage)
            this.maybeScheduleResultFallback()
            break
          case 'message_stop':
            this.inMessage = false
            this.messageStopped = true
            this.maybeScheduleResultFallback()
            break
          default: break
        }
        break
      }
      case 'assistant': {
        const topLevel = event.parent_tool_use_id == null
        // Each response carries its usage, and what it read plus what it wrote is
        // what the context holds now. A subagent's (parent_tool_use_id) is its own.
        const usage = event.message?.usage
        if (topLevel) {
          this.cancelResultTimer()
          const msgId = typeof event.message?.id === 'string' && event.message.id !== '' ? event.message.id : null
          if (msgId !== null && msgId !== this.lastMessageId) {
            this.lastMessageId = msgId
            if (!this.inMessage) {
              this.messageHasToolUse = false
              this.messageStopReason = null
            }
          }
          if (typeof event.message?.stop_reason === 'string') this.messageStopReason = event.message.stop_reason
        }
        if (usage !== undefined && topLevel) {
          if (typeof event.message?.id === 'string' && event.message.id !== '') this.turnCalls.add(event.message.id)
          this.recordTurnUsage(usage)
          const used = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((sum, key) => sum + (usage[key] ?? 0), 0)
          if (used > 0) this.emit({ type: 'context', used })
        }
        let sawToolUse = false
        let sawText = false
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text') {
            this.emit({ type: 'text', text: block.text ?? '' })
            if (topLevel && typeof block.text === 'string' && block.text !== '') sawText = true
          } else if (block.type === 'thinking') this.emit({ type: 'thought', text: block.thinking ?? '' })
          else if (block.type === 'tool_use') {
            // Shells, subagents and custom tools may change cwd without reporting it.
            if (!READ_TOOLS.has(block.name)) this.cwd = undefined
            if (topLevel) {
              sawToolUse = true
              this.messageHasToolUse = true
              this.turnHasAssistantOutput = false
              if (typeof block.id === 'string' && block.id !== '') this.pendingToolUses.add(block.id)
              else this.awaitingToolResult = true
            }
            this.emit({ type: 'activity', text: `▸ ${claudeActivity(block)}`, ...(String(block.name ?? '').startsWith('mcp__dsbot__') ? { team: true } : {}) })
          }
        }
        if (topLevel) {
          if (!sawToolUse && sawText) this.turnHasAssistantOutput = true
          this.maybeScheduleResultFallback()
        }
        break
      }
      case 'user': {
        if (event.parent_tool_use_id != null) break
        const content = event.message?.content
        if (!Array.isArray(content)) break
        for (const block of content) {
          if (block?.type === 'tool_result') {
            this.cancelResultTimer()
            if (typeof block.tool_use_id === 'string') this.pendingToolUses.delete(block.tool_use_id)
            this.awaitingToolResult = false
            this.messageHasToolUse = false
            this.messageStopReason = null
          }
        }
        break
      }
      case 'control_request': {
        const request = event.request ?? {}
        if (request.subtype === 'can_use_tool') {
          this.cancelResultTimer()
          const requestId = event.request_id
          if (requestId !== undefined) this.pendingPermissions.add(requestId)
          const tool = request.tool_name ?? 'tool'
          this.emit({
            type: 'permission', id: requestId, cwd: this.cwd,
            reply: (optionId) => {
              if (requestId !== undefined) this.pendingPermissions.delete(requestId)
              if (optionId === 'allow' && !READ_TOOLS.has(tool)) this.cwd = undefined
              this.write({
                type: 'control_response',
                response: { subtype: 'success', request_id: requestId, response: optionId === 'allow' ? { behavior: 'allow', updatedInput: request.input ?? {} } : { behavior: 'deny', message: 'The user denied this action.' } },
              })
            },
            action: `Run ${tool}`,
            detail: JSON.stringify(request),
            changes: !READ_TOOLS.has(tool),
            options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
          })
        }
        break
      }
      case 'result':
        this.cancelResultTimer()
        // A resume of a conversation the CLI no longer has ends at once, before
        // init and with no turn.
        if (this.resumeId !== undefined && this.cliSessionId === undefined && event.is_error === true && (event.num_turns ?? 0) === 0) {
          this.resumeMissing = true
          // It exits next and reads no more input.
          this.dead = true
          this.emit({ type: 'error', error: Object.assign(new Error(`${this.engine.engine.name} no longer has this conversation`), { code: 'LOCAL_AGENT_EXIT' }) })
          break
        }
        {
          // modelUsage names each model's window; the session's own model decides.
          const models = Object.entries(event.modelUsage ?? {})
          const size = (models.find(([name]) => name === this.model) ?? models.toSorted((a, b) => (b[1]?.contextWindow ?? 0) - (a[1]?.contextWindow ?? 0))[0])?.[1]?.contextWindow
          if (typeof size === 'number' && size > 0) this.emit({ type: 'context', size })
        }
        const observedCalls = this.turnCalls.size
        this.resetTurnState()
        this.pendingPermissions.clear()
        const calls = positiveInt(event.num_turns) ?? (observedCalls > 0 ? observedCalls : undefined)
        this.running = false
        this.emit(event.subtype === 'success' || event.is_error !== true
          ? { type: 'done', reason: 'stop', usage: usageOf(event.usage, calls) }
          : { type: 'error', error: new Error(event.result ?? 'the agent failed') })
        break
      default: break
    }
  }

  recordTurnUsage(usage) {
    if (usage === undefined || usage === null || typeof usage !== 'object') return
    const prev = this.turnUsage ?? {}
    const cacheRead = usage.cache_read_input_tokens ?? prev.cache_read_input_tokens
    const cacheWrite = usage.cache_creation_input_tokens ?? prev.cache_creation_input_tokens
    this.turnUsage = {
      input_tokens: usage.input_tokens ?? prev.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? prev.output_tokens ?? 0,
      ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
      ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
    }
  }

  resetTurnState() {
    this.cancelResultTimer()
    this.turnCalls.clear()
    this.pendingToolUses.clear()
    this.pendingHooks.clear()
    this.awaitingToolResult = false
    this.inMessage = false
    this.lastMessageId = null
    this.messageHasToolUse = false
    this.messageStopReason = null
    this.messageStopped = false
    this.turnSawStreamEvent = false
    this.turnHasAssistantOutput = false
    this.turnUsage = undefined
  }

  canFinishWithoutResult() {
    if (this.running !== true || this.retired) return false
    if (!this.turnHasAssistantOutput) return false
    if ((this.inMessage && !TERMINAL_STOP_REASONS.has(this.messageStopReason)) || this.messageHasToolUse) return false
    if (this.messageStopReason !== null && !TERMINAL_STOP_REASONS.has(this.messageStopReason)) return false
    if (this.pendingToolUses.size > 0 || this.awaitingToolResult) return false
    if (this.pendingPermissions.size > 0 || this.pendingHooks.size > 0 || this.compacting) return false
    return true
  }

  cancelResultTimer() {
    if (this.resultTimer !== undefined) {
      clearTimeout(this.resultTimer)
      this.resultTimer = undefined
    }
  }

  maybeScheduleResultFallback() {
    this.cancelResultTimer()
    if (this.dead || !this.canFinishWithoutResult()) return
    const definitive = this.messageStopped || TERMINAL_STOP_REASONS.has(this.messageStopReason)
    if (!definitive && this.turnSawStreamEvent) return
    const delay = definitive
      ? (this.engine.resultGraceMs ?? DEFAULT_RESULT_GRACE_MS)
      : (this.engine.resultFallbackMs ?? DEFAULT_RESULT_FALLBACK_MS)
    if (!(delay > 0)) return
    this.resultTimer = setTimeout(() => {
      this.resultTimer = undefined
      if (this.dead || !this.canFinishWithoutResult()) return
      this.finishWithoutResult({ retireChild: true })
    }, delay)
    this.resultTimer.unref?.()
  }

  // Some Claude Code runs emit the full assistant reply and never emit the
  // closing `result` line (#2382). Complete the turn with the output already
  // streamed and retire the wedged child so the next turn resumes cleanly.
  finishWithoutResult({ retireChild }) {
    const observedCalls = this.turnCalls.size
    const calls = observedCalls > 0 ? observedCalls : undefined
    const usage = usageOf(this.turnUsage, calls)
    this.resetTurnState()
    this.pendingPermissions.clear()
    this.running = false
    if (retireChild) {
      this.retired = true
      this.dead = true
      this.cleanupSystemFile()
      for (const resolve of this.idWaiters.splice(0)) resolve(this.cliSessionId)
      const child = this.child
      this.child = undefined
      terminateChild(child)
    }
    this.emit({ type: 'done', reason: 'stop', usage })
  }

  // The CLI reports its session id with `system/init`, which arrives after
  // start() resolved: callers that must persist it wait here.
  whenSessionId() {
    if (this.cliSessionId !== undefined) return Promise.resolve(this.cliSessionId)
    if (this.dead) return Promise.resolve(undefined)
    return new Promise(resolve => { this.idWaiters.push(resolve) })
  }

  prompt(blocks) {
    if (this.running !== true) {
      this.resetTurnState()
    } else {
      this.cancelResultTimer()
      this.inMessage = false
      this.messageHasToolUse = false
      this.messageStopReason = null
      this.messageStopped = false
      this.turnHasAssistantOutput = false
    }
    this.running = true
    this.write({ type: 'user', message: { role: 'user', content: claudeContent(blocks) } })
    return Promise.resolve()
  }

  steer(input) {
    return this.prompt(Array.isArray(input) ? input : [{ type: 'text', text: input }])
  }

  // `/compact` in stream-json runs the CLI's own compaction and ends with a result.
  compact() {
    this.prompt([{ type: 'text', text: '/compact' }])
    return true
  }

  cancel() {
    this.cancelResultTimer()
    // The documented interrupt asks the turn to stop cleanly.
    this.write({ type: 'control_request', request: { subtype: 'interrupt' } })
  }

  cleanupSystemFile() {
    if (this.onProcessExit !== undefined) {
      process.off('exit', this.onProcessExit)
      this.onProcessExit = undefined
    }
    const dir = this.systemPromptDir
    if (dir === undefined) return
    this.systemPromptDir = undefined
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }

  kill() {
    this.cancelResultTimer()
    this.dead = true
    this.cleanupSystemFile()
    const child = this.child
    this.child = undefined
    terminateChild(child)
  }
}

function claudeActivity(block) {
  const name = block.name ?? 'tool'
  const input = block.input !== null && typeof block.input === 'object' ? block.input : {}
  const command = input.command ?? input.cmd
  const detail = typeof command === 'string' && command.trim() !== ''
    ? `\`${command.trim().slice(0, 160)}\``
    : [input.description, input.file_path, input.path, input.pattern, input.url, input.query]
      .find(value => typeof value === 'string' && value.trim() !== '')?.trim().slice(0, 120)
  return detail ? `${name} ${detail}` : name
}

function claudeContent(blocks) {
  const out = []
  for (const block of blocks) {
    if (block.type === 'image') {
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mediaType ?? block.mimeType ?? 'image/png',
          data: block.data,
        },
      })
    } else if ((block.text ?? '') !== '') {
      out.push({ type: 'text', text: block.text })
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }]
}

const positiveInt = value => (Number.isSafeInteger(value) && value > 0 ? value : undefined)

const usageOf = (usage, calls) => (usage === undefined ? undefined : {
  inputTokens: usage.input_tokens ?? 0,
  outputTokens: usage.output_tokens ?? 0,
  ...(usage.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
  ...(usage.cache_creation_input_tokens ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
  ...(calls !== undefined && calls > 1 ? { calls } : {}),
})
