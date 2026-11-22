// Standard MCP Streamable HTTP endpoint (/mcp) sharing the exact same Bearer auth,
// scopes, target whitelist, privacy filters, and Run coordinator as /v1/*.
import { readFileSync } from 'node:fs'
import { httpError, readJsonBody, sendJson } from './routes.js'

const PKG = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))
const MCP_PROTOCOL_VERSION = '2025-03-26'

const TOOL_SPECS = [
  {
    name: 'dsbot_list_bots',
    scope: 'read',
    description: 'List DS Bot team members authorized for this token, including roles, workspaces, and busy state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dsbot_list_groups',
    scope: 'read',
    description: 'List DS Bot group chats authorized for this token, including members and Goal status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'dsbot_send_to_bot',
    scope: 'message',
    description: 'Send a message or start a background task for an authorized Bot. Supports waitSeconds to wait synchronously for completion or waiting_human.',
    inputSchema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot ID or exact name' },
        text: { type: 'string', description: 'Message or task instructions' },
        mode: { type: 'string', enum: ['chat', 'task'], description: 'chat (default) or task (forked background task)' },
        title: { type: 'string', description: 'Optional short title when mode is task' },
        waitSeconds: { type: 'number', description: 'Seconds to wait before returning (default 0, max 300)' },
        idempotencyKey: { type: 'string', description: 'Optional idempotency key to prevent duplicate execution on retries' },
      },
      required: ['bot', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsbot_send_to_group',
    scope: 'message',
    description: 'Post a message to an authorized group chat and track the group collaboration batch as a Run.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group ID or exact name' },
        text: { type: 'string', description: 'Message to post' },
        mentions: { type: 'array', items: { type: 'string' }, description: 'Optional member IDs or names to @mention' },
        waitSeconds: { type: 'number', description: 'Seconds to wait for the group batch to settle (default 0, max 300)' },
        idempotencyKey: { type: 'string', description: 'Optional idempotency key' },
      },
      required: ['group', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsbot_get_run',
    scope: 'read',
    description: 'Inspect a Run status, final output, deliverables, usage, and any pendingAction requiring human input.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run ID returned by dsbot_send_to_bot or dsbot_send_to_group' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsbot_cancel_run',
    scope: 'message',
    description: 'Cancel a running or queued Run (stops the Bot turn, background task, or group round).',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run ID to cancel' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsbot_respond_run',
    scope: 'message',
    description: 'Respond to a waiting_human Run (answer an ask_user question or interactive view; requires approval scope for tool approvals).',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run ID currently in waiting_human state' },
        actionId: { type: 'string', description: 'Required pendingAction.actionId to guard against stale replies' },
        choice: { type: 'string', enum: ['allow', 'reject'], description: 'For approval actions (requires approval scope)' },
        answer: { description: 'Answer text or selection for question actions' },
        action: { type: 'string', description: 'Action name for interactive view cards' },
        values: { type: 'object', description: 'Form values for interactive view cards' },
      },
      required: ['runId', 'actionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsbot_read_history',
    scope: 'read',
    description: 'Read recent conversation history of an authorized Bot or group chat.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['bot', 'group'], description: 'Target kind' },
        id: { type: 'string', description: 'Bot or group ID or exact name' },
        limit: { type: 'number', description: 'Maximum items to return (default 40, max 200)' },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsbot_read_memory',
    scope: 'memory:read',
    description: 'Read or search long-term memory of an authorized Bot, group, or the shared team.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['bot', 'group', 'team'], description: 'Memory scope kind' },
        id: { type: 'string', description: 'Bot or group ID/name (omit when kind is team)' },
        q: { type: 'string', description: 'Optional substring query filter' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsbot_write_memory',
    scope: 'memory:write',
    description: 'Add, update, or delete an entry in an authorized Bot, group, or team memory.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'edit', 'delete'], description: 'Operation to perform (default add)' },
        kind: { type: 'string', enum: ['bot', 'group', 'team'], description: 'Memory scope kind' },
        id: { type: 'string', description: 'Bot or group ID/name (omit when kind is team)' },
        entryId: { type: 'string', description: 'Entry ID required for edit and delete' },
        text: { type: 'string', description: 'Memory text required for add and edit' },
        topic: { type: 'string', description: 'Optional topic name when adding' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsbot_emit_event',
    scope: 'event:ingest',
    description: 'Submit an external untrusted event into the DS Bot event ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source identifier (e.g. ci, stock-watcher)' },
        eventId: { type: 'string', description: 'Unique event ID for deduplication' },
        type: { type: 'string', description: 'Event type name' },
        threadKey: { type: 'string', description: 'Optional thread grouping key' },
        title: { type: 'string', description: 'Short headline' },
        summary: { type: 'string', description: 'Summary text' },
        payload: { description: 'Structured external payload (treated as untrusted data)' },
        target: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['bot', 'group'] },
            id: { type: 'string' },
          },
        },
        dryRun: { type: 'boolean', description: 'Record in ledger without waking any Bot' },
      },
      required: ['source', 'type'],
      additionalProperties: false,
    },
  },
]

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

function toolOk(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data }
}

function toolErr(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code: error?.code ?? 'api/error', message: error?.message ?? String(error) } }) }],
  }
}

export function createMcpHandler({ service }) {
  const legacySends = new Map()
  let legacyAfter = 0
  function allowedTools(principal) {
    return TOOL_SPECS
      .filter(spec => {
        if (spec.name === 'dsbot_respond_run') {
          return principal.hasScope('card:respond')
        }
        return principal.hasScope(spec.scope)
      })
      .map(({ scope: _scope, ...tool }) => tool)
  }

  function listResources(principal) {
    if (!principal.hasScope('read')) return []
    const { bots } = service.listBots(principal)
    const { groups } = service.listGroups(principal)
    return [
      { uri: 'dsbot://team/bots', name: 'Authorized Bots', mimeType: 'application/json' },
      { uri: 'dsbot://team/groups', name: 'Authorized Groups', mimeType: 'application/json' },
      ...(principal.hasScope('memory:read') ? bots : []).map(bot => ({
        uri: `dsbot://bots/${encodeURIComponent(bot.id)}/memory`,
        name: `${bot.name} memory`,
        mimeType: 'application/json',
      })),
      ...(principal.hasScope('memory:read') ? groups : []).map(group => ({
        uri: `dsbot://groups/${encodeURIComponent(group.id)}/memory`,
        name: `${group.name} memory`,
        mimeType: 'application/json',
      })),
    ]
  }

  async function readResource(principal, uri) {
    if (!principal.hasScope('read')) throw httpError(403, 'api/scope-required', 'The "read" scope is required')
    const raw = String(uri ?? '')
    if (raw === 'dsbot://team/bots') {
      return { contents: [{ uri: raw, mimeType: 'application/json', text: JSON.stringify(service.listBots(principal), null, 2) }] }
    }
    if (raw === 'dsbot://team/groups') {
      return { contents: [{ uri: raw, mimeType: 'application/json', text: JSON.stringify(service.listGroups(principal), null, 2) }] }
    }
    const botMatch = /^dsbot:\/\/bots\/([^/]+)\/memory$/.exec(raw)
    if (botMatch) {
      if (!principal.hasScope('memory:read')) throw httpError(403, 'api/scope-required', 'Memory access requires a newly authorized token')
      const botId = decodeURIComponent(botMatch[1])
      const mem = await service.readMemory(principal, { kind: 'bot', targetId: botId })
      return { contents: [{ uri: raw, mimeType: 'application/json', text: JSON.stringify(mem, null, 2) }] }
    }
    const groupMatch = /^dsbot:\/\/groups\/([^/]+)\/memory$/.exec(raw)
    if (groupMatch) {
      if (!principal.hasScope('memory:read')) throw httpError(403, 'api/scope-required', 'Memory access requires a newly authorized token')
      const groupId = decodeURIComponent(groupMatch[1])
      const mem = await service.readMemory(principal, { kind: 'group', targetId: groupId })
      return { contents: [{ uri: raw, mimeType: 'application/json', text: JSON.stringify(mem, null, 2) }] }
    }
    throw httpError(404, 'mcp/resource-not-found', `Unknown resource URI: ${raw}`)
  }

  async function callTool(principal, name, args = {}, audit) {
    if (name === 'send_to_bot' || name === 'send_to_group') {
      const mapped = name === 'send_to_bot' ? 'dsbot_send_to_bot' : 'dsbot_send_to_group'
      const result = await callTool(principal, mapped, args, audit)
      const run = result.structuredContent
      const after = legacyAfter = Math.max(Date.now(), legacyAfter + 1)
      const key = JSON.stringify([principal.keyId, after])
      legacySends.set(key, { runId: run.runId })
      if (legacySends.size > 1024) legacySends.delete(legacySends.keys().next().value)
      return toolOk({ sent: true, after, runId: run.runId })
    }
    if (name === 'wait_for_reply') {
      const saved = legacySends.get(JSON.stringify([principal.keyId, args.after]))
      const runId = args.runId ?? saved?.runId
      if (typeof runId !== 'string') throw httpError(400, 'mcp/legacy-handle-expired', 'Unknown legacy wait handle; use the runId returned by send_to_bot')
      if (!principal.hasScope('read')) throw httpError(403, 'api/scope-required', 'Waiting requires read access')
      const timeout = Math.min(50, Math.max(0, Number(args.timeout ?? 50) || 0)) * 1000
      const deadline = Date.now() + timeout
      let run
      do {
        if (principal.isCurrent?.() === false) throw httpError(403, 'api/token-changed', 'Token authorization changed')
        run = service.getRun(principal, runId)
        if (['completed', 'failed', 'stopped', 'waiting_human'].includes(run.status) || Date.now() >= deadline) break
        await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())))
      } while (true)
      audit.runId = runId
      return toolOk({
        done: ['completed', 'failed', 'stopped'].includes(run.status),
        working: ['queued', 'running'].includes(run.status),
        messages: run.output?.messages ?? [],
        after: args.after,
        runId,
      })
    }
    const aliases = { list_bots: 'dsbot_list_bots', list_groups: 'dsbot_list_groups' }
    name = aliases[name] ?? name
    const allowed = allowedTools(principal)
    if (!allowed.some(tool => tool.name === name)) {
      throw httpError(403, 'api/scope-required', `Tool "${name}" is not available for this token`)
    }
    audit.action = `mcp:${name}`
    switch (name) {
      case 'dsbot_list_bots':
        return toolOk(service.listBots(principal))
      case 'dsbot_list_groups':
        return toolOk(service.listGroups(principal))
      case 'dsbot_send_to_bot': {
        const { run } = await service.sendToBot(principal, args.bot, {
          text: args.text,
          mode: args.mode,
          title: args.title,
          wait: args.waitSeconds ?? 0,
        }, { idempotencyKey: args.idempotencyKey })
        audit.targetKind = 'bot'
        audit.targetId = run.target.id
        audit.targetName = run.target.name
        audit.runId = run.runId
        return toolOk(run)
      }
      case 'dsbot_send_to_group': {
        const { run } = await service.sendToGroup(principal, args.group, {
          text: args.text,
          mentions: args.mentions,
          wait: args.waitSeconds ?? 0,
        }, { idempotencyKey: args.idempotencyKey })
        audit.targetKind = 'group'
        audit.targetId = run.target.id
        audit.targetName = run.target.name
        audit.runId = run.runId
        return toolOk(run)
      }
      case 'dsbot_get_run': {
        const run = service.getRun(principal, args.runId)
        audit.runId = run.runId
        return toolOk(run)
      }
      case 'dsbot_cancel_run': {
        const run = await service.cancelRun(principal, args.runId)
        audit.runId = run.runId
        return toolOk(run)
      }
      case 'dsbot_respond_run': {
        const run = await service.respondRun(principal, args.runId, {
          actionId: args.actionId,
          choice: args.choice,
          answer: args.answer,
          action: args.action,
          values: args.values,
        })
        audit.runId = run.runId
        return toolOk(run)
      }
      case 'dsbot_read_history': {
        if (args.kind === 'group') {
          const hist = await service.readGroupHistory(principal, args.id, { limit: args.limit ?? 40 })
          audit.targetKind = 'group'
          audit.targetId = hist.groupId
          return toolOk(hist)
        }
        const hist = await service.readBotHistory(principal, args.id, { limit: args.limit ?? 40 })
        audit.targetKind = 'bot'
        audit.targetId = hist.botId
        return toolOk(hist)
      }
      case 'dsbot_read_memory': {
        const mem = await service.readMemory(principal, { kind: args.kind, targetId: args.id, q: args.q })
        return toolOk(mem)
      }
      case 'dsbot_write_memory': {
        const op = args.action ?? 'add'
        if (op === 'edit') {
          return toolOk(await service.editMemory(principal, { kind: args.kind, targetId: args.id, entryId: args.entryId, text: args.text }))
        }
        if (op === 'delete') {
          return toolOk(await service.deleteMemory(principal, { kind: args.kind, targetId: args.id, entryId: args.entryId }))
        }
        return toolOk(await service.addMemory(principal, { kind: args.kind, targetId: args.id, text: args.text, topic: args.topic }))
      }
      case 'dsbot_emit_event': {
        const out = await service.ingestEvent(principal, args, { idempotencyKey: args.eventId })
        return toolOk(out)
      }
      default:
        throw httpError(404, 'mcp/unknown-tool', `Unknown tool "${name}"`)
    }
  }

  async function processMessage(msg, principal, audit) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg?.id, -32600, 'Invalid JSON-RPC request')
    }
    const isNotification = msg.id === undefined
    const method = msg.method
    const params = msg.params ?? {}

    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return null
    }
    if (method === 'initialize') {
      return rpcResult(msg.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
        },
        serverInfo: { name: 'ds-bot', version: PKG.version },
      })
    }
    if (method === 'ping') {
      return rpcResult(msg.id, {})
    }
    if (method === 'tools/list') {
      return rpcResult(msg.id, { tools: allowedTools(principal) })
    }
    if (method === 'tools/call') {
      try {
        const result = await callTool(principal, String(params.name ?? ''), params.arguments ?? {}, audit)
        return isNotification ? null : rpcResult(msg.id, result)
      } catch (error) {
        return isNotification ? null : rpcResult(msg.id, toolErr(error))
      }
    }
    if (method === 'resources/list') {
      return rpcResult(msg.id, { resources: listResources(principal) })
    }
    if (method === 'resources/read') {
      try {
        const result = await readResource(principal, params.uri)
        return isNotification ? null : rpcResult(msg.id, result)
      } catch (error) {
        return isNotification ? null : rpcError(msg.id, -32002, error?.message ?? 'Resource error', { code: error?.code })
      }
    }
    return isNotification ? null : rpcError(msg.id, -32601, `Method not found: ${method}`)
  }

  async function handleMcp(req, res, url, principal, audit) {
    if (url.pathname !== '/mcp') return false
    if (req.method === 'DELETE') {
      res.writeHead(204)
      res.end()
      return true
    }
    if (req.method !== 'POST') {
      throw httpError(405, 'api/method-not-allowed', 'Use POST for MCP Streamable HTTP')
    }
    const raw = await readJsonBody(req)
    const response = await processMessage(raw, principal, audit)
    if (response === null) {
      res.writeHead(202)
      res.end()
      return true
    }
    sendJson(res, 200, response)
    return true
  }

  return { handleMcp }
}
