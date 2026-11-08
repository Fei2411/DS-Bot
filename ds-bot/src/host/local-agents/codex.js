// The Codex app-server engine: `codex app-server --listen stdio://`, one
// JSON-RPC process per route that multiplexes threads. DS Bot Sessions map to
// threads; turns stream item notifications back.
import { JsonRpcPeer, wireProcess, EventQueue } from './jsonrpc.js'
import { cleanEnv, spawnAgent } from './discover.js'

// The name the loopback MCP server is registered under in each thread's config.
const MCP_SERVER = 'dsbot'

export class CodexEngine {
  constructor(route, engine, { findExecutable }) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.child = undefined
    this.peer = undefined
    this.threads = new Map()
  }

  threadFor(dshSessionId) {
    let thread = this.threads.get(dshSessionId)
    if (thread === undefined) {
      const queue = new EventQueue()
      thread = { dshSessionId, threadId: undefined, dead: false, push: event => queue.push(event), next: () => queue.next() }
      this.threads.set(dshSessionId, thread)
    }
    return thread
  }

  async ensure() {
    if (this.peer !== undefined) return this.peer
    const bin = this.findExecutable(this.engine.command)
    if (bin === undefined) throw Object.assign(new Error(`${this.engine.name} is not installed`), { code: 'NO_ADAPTER' })
    const child = spawnAgent(bin, this.engine.args ?? [], {
      env: cleanEnv(this.engine.env ?? {}),
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    })
    this.child = child
    const peer = this.peer = new JsonRpcPeer(line => child.stdin.write(`${JSON.stringify(line)}\n`))
    wireProcess(child, peer)
    child.on('exit', () => {
      peer.close(new Error(`${this.engine.name} exited`))
      this.child = undefined
      this.peer = undefined
      for (const thread of this.threads.values()) {
        thread.dead = true
        thread.push({ type: 'error', error: new Error(`${this.engine.name} exited`) })
      }
    })
    peer.notificationHandler = (method, params) => this.onNotice(method, params)
    peer.requestHandler = (method, params) => this.onRequest(method, params)
    await peer.request('initialize', { clientInfo: { name: 'ds-bot', title: null, version: '1' } }, { timeout: 30_000 })
    peer.notify('initialized', {})
    return peer
  }

  onNotice(method, params) {
    const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const item = params?.item ?? {}
        if (thread === undefined) break
        if (item.type === 'agentMessage' || item.type === 'agent_message') thread.push({ type: 'text', text: item.text ?? '' })
        else if (item.type === 'reasoning') thread.push({ type: 'thought', text: (item.content ?? []).join('') || item.text || '' })
        else if (method === 'item/started' && item.type !== undefined) thread.push({ type: 'activity', text: `▸ ${activityOf(item)}` })
        break
      }
      case 'turn/completed': {
        if (thread === undefined) break
        const turn = params?.turn ?? {}
        if (turn.status === 'failed') thread.push({ type: 'error', error: new Error(turn.error?.message ?? 'the turn failed') })
        else thread.push({ type: 'done', reason: 'stop' })
        break
      }
      case 'thread/tokenUsage/updated': {
        if (thread === undefined) break
        const usage = params?.tokenUsage ?? params?.usage
        if (usage !== undefined) thread.push({ type: 'usage', usage: { inputTokens: usage.inputTokens ?? usage.input_tokens ?? 0, outputTokens: usage.outputTokens ?? usage.output_tokens ?? 0 } })
        break
      }
      default: break
    }
  }

  // Server-initiated approval requests bridge to the approval tool.
  onRequest(method, params) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'execCommandApproval' || method === 'patchApproval') {
      const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
      const options = (params?.availableDecisions ?? params?.decisions ?? ['accept', 'decline']).map(decision => ({ optionId: decision, kind: decision === 'accept' || decision === 'acceptForSession' ? 'allow_once' : 'reject_once', name: decision }))
      return new Promise((resolve) => {
        const reply = (decision) => resolve({ decision: decision ?? 'decline' })
        thread?.push({
          type: 'permission', id: `perm-${Math.random().toString(36).slice(2)}`, reply,
          action: params?.reason ?? params?.command ?? 'The agent asks to run an action',
          detail: detailText(params),
          options,
        })
      })
    }
    // Codex asks before every MCP tool call under `on-request`. A refusal reads as
    // "user rejected MCP tool call", so DS Bot's own loopback server is approved
    // here: toolsFor() already narrowed what the Bot may call. Other servers and
    // real form elicitations keep the refusal; they are not DS Bot's to approve.
    if (method === 'mcpServer/elicitation/request' && params?.serverName === MCP_SERVER && params?._meta?.codex_approval_kind === 'mcp_tool_call') {
      return Promise.resolve({ action: 'accept', content: null, _meta: null })
    }
    return Promise.reject({ code: -32601, message: `method not found: ${method}` })
  }

  async open(dshSessionId, { cwd, mcp, resumeId, mode, instructions, model }) {
    const peer = await this.ensure()
    const thread = this.threadFor(dshSessionId)
    if (resumeId !== undefined) thread.threadId = resumeId
    const config = {
      cwd,
      ...(instructions ? { developer_instructions: instructions } : {}),
      ...(mode ? { sandbox_mode: mode, approval_policy: mode === 'danger-full-access' ? 'never' : 'on-request' } : {}),
      ...(model && model !== 'default' ? { model } : {}),
      ...(mcp !== undefined ? { mcp_servers: { [MCP_SERVER]: { url: mcp.url, http_headers: { Authorization: `Bearer ${mcp.token}` } } } } : {}),
    }
    if (thread.threadId !== undefined) {
      try {
        await peer.request('thread/resume', { threadId: thread.threadId, config }, { timeout: 30_000 })
        return thread
      } catch {
        thread.threadId = undefined
      }
    }
    const reply = await peer.request('thread/start', config, { timeout: 60_000 })
    thread.threadId = reply?.thread?.id ?? reply?.threadId
    return thread
  }

  // Follow-up instructions while a thread lives (Codex injects a developer item).
  async instruct(thread, text) {
    if (text === '') return
    await this.peer?.request('thread/inject_items', { threadId: thread.threadId, items: [{ type: 'developerMessage', text }] }, { timeout: 15_000 }).catch(() => {})
  }

  async prompt(thread, blocks, { signal }) {
    const peer = await this.ensure()
    const reply = await peer.request('turn/start', {
      threadId: thread.threadId,
      input: blocks.map(block => block.type === 'image' ? { type: 'image', url: block.url ?? block.data } : { type: 'text', text: block.text ?? '' }),
    }, { signal, timeout: 0 })
    thread.turnId = reply?.turn?.id ?? reply?.id
    return thread.turnId
  }

  async steer(thread, text) {
    await this.peer?.request('turn/steer', { threadId: thread.threadId, input: [{ type: 'text', text }] }, { timeout: 15_000 }).catch(() => {})
  }

  cancel(thread) {
    this.peer?.request('turn/interrupt', { threadId: thread.threadId, turnId: thread.turnId }, { timeout: 15_000 }).catch(() => {})
  }

  async listModels() {
    const peer = await this.ensure()
    const reply = await peer.request('model/list', {}, { timeout: 30_000 })
    return (reply?.data ?? reply?.models ?? []).map(entry => ({ id: String(entry.id ?? entry.model), name: String(entry.displayName ?? entry.name ?? entry.id ?? entry.model) }))
  }

  async close() {
    const child = this.child
    this.child = undefined
    this.peer = undefined
    if (child !== undefined) {
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5_000).unref?.()
    }
  }
}

const activityOf = item => {
  const kind = item.type === 'commandExecution' ? (item.command ?? 'command')
    : item.type === 'fileChange' ? 'edit'
      : item.type === 'mcpToolCall' ? (item.tool ?? 'tool')
        : (item.title ?? item.type)
  return String(kind).split('\n')[0].slice(0, 120)
}
const detailText = params => [params?.command, params?.reason, JSON.stringify(params?.changes ?? params?.patch ?? '')].filter(Boolean).join('\n').slice(0, 4_000)
