// Worker Bridge: routes turns for type=remote-worker Bots to the remote hub via
// dsh-remote-agent's hub API, then delivers the task result back as a Bot reply.
//
// Phase 4 additions:
//   - Load balancing: bot.worker.nodes[] array; pickNode() selects least-loaded node.
//   - Event-driven task wait: listens to hub registry emit('taskEnd') instead of tight polling.
//   - Token minting: mintEnrollToken() calls /api/relay/token for new node enrollment.
import { randomUUID } from 'node:crypto'

// How long to wait for a remote task to complete before timing out.
const REMOTE_TASK_TIMEOUT_MS = 60 * 60 * 1000   // 1 hour (matches AGENT_DEFAULT_TIMEOUT_MS)
// Fallback polling interval (used when hub doesn't support event emission).
const POLL_INTERVAL_MS = 5_000

// Worker fleet default group name (auto-created on first Worker Bot creation).
export const WORKER_GROUP_NAME = '执行机'

export function install(rt) {
  const { ctx } = rt

  // ── Hub tool accessor ─────────────────────────────────────────────────────
  function hubTools() {
    try {
      const tools = ctx.get?.('tools')
      if (tools === undefined) return undefined
      const dispatch = tools.get?.('remote_task')
      const status = tools.get?.('remote_status')
      const handoff = tools.get?.('remote_handoff')
      if (!dispatch || !status || !handoff) return undefined
      return { dispatch, status, handoff }
    } catch {
      return undefined
    }
  }

  // ── Load balancing: pick least-loaded node from a Worker Bot's fleet ──────
  //
  // Supports two modes:
  //   Single-node: bot.worker.nodeId (legacy, Phase 2 behavior)
  //   Fleet: bot.worker.nodes = [{ nodeId, relayUrl?, hubUrl? }, ...]
  //
  // Picks by lowest taskCount, then random to break ties.
  function pickNode(worker) {
    const nodes = Array.isArray(worker.nodes) && worker.nodes.length > 0
      ? worker.nodes.filter(n => n?.nodeId && n.online !== false)
      : worker.nodeId ? [{ nodeId: worker.nodeId }] : []
    if (nodes.length === 0) return null
    if (nodes.length === 1) return nodes[0]
    // Sort by taskCount ascending (undefined treated as 0), break ties randomly.
    const sorted = [...nodes].sort((a, b) => {
      const ca = typeof a.taskCount === 'number' ? a.taskCount : 0
      const cb = typeof b.taskCount === 'number' ? b.taskCount : 0
      return ca - cb || Math.random() - 0.5
    })
    return sorted[0]
  }

  // ── Event-driven task wait with polling fallback ───────────────────────────
  //
  // Waits for the remote task to reach a terminal status. If the hub registry
  // exposes an event emitter (emit 'taskEnd'), we subscribe to it for zero-
  // latency notification; otherwise fall back to polling every POLL_INTERVAL_MS.
  async function waitForTask(tools, nodeId, taskId) {
    const deadline = Date.now() + REMOTE_TASK_TIMEOUT_MS

    // Try event-driven path first: hub registry emits 'taskEnd' (Phase 4 remote-agent).
    const registry = ctx.get?.('remote-agent:registry')
    if (registry && typeof registry.on === 'function') {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          registry.off?.('taskEnd', onEnd)
          resolve(undefined)
        }, REMOTE_TASK_TIMEOUT_MS)

        function onEnd({ taskId: tid, status }) {
          if (tid !== taskId) return
          clearTimeout(timer)
          registry.off?.('taskEnd', onEnd)
          resolve({ status })
        }

        registry.on('taskEnd', onEnd)
      })
    }

    // Fallback: poll remote_status every POLL_INTERVAL_MS.
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
      const statusResult = await tools.status.execute({ nodeId, taskId })
      if (statusResult?.isError) continue
      const s = statusResult?.value
      const status = s?.status
      if (status === 'COMPLETED' || status === 'FAILED' || status === 'ABORTED' ||
          status === 'INTERRUPTED' || status === 'REJECTED') {
        return { status }
      }
    }
    return undefined  // timed out
  }

  // ── Token minting: get a one-time enrollToken for a new worker node ────────
  //
  // Calls the relay server's /api/relay/token endpoint via the hub's HTTP client.
  // Returns the minted token string, or null if minting is not available.
  async function mintEnrollToken({ nodeId, ttlMs = 15 * 60 * 1000 } = {}) {
    try {
      const hubClient = ctx.get?.('remote-agent:hub-client')
      if (!hubClient || typeof hubClient.mintToken !== 'function') return null
      const result = await hubClient.mintToken({ nodeId, ttlMs })
      return result?.token ?? null
    } catch {
      return null
    }
  }

  // ── Main intercept ────────────────────────────────────────────────────────
  async function handleRemoteTurn({ fromId, toId, text, role, exchangeId, replyTo, work }) {
    const to = rt.botOf(toId)
    if (to?.type !== 'remote-worker') return exchangeId

    const node = pickNode(to.worker ?? {})
    if (!node) {
      rt.warn('ds-bot: worker-bridge: Bot %s has no available node, dropping turn', toId)
      void rt.deliver?.({
        fromId: toId, toId: fromId ?? toId,
        text: `[Worker Bot ${to.name} is not configured: no nodeId or all nodes offline.]`,
        role: 'reply', replyTo: exchangeId, ...(work ? { work } : {}),
      }).catch(() => {})
      return exchangeId
    }

    const tools = hubTools()
    if (tools === undefined) {
      void rt.deliver?.({
        fromId: toId, toId: fromId ?? toId,
        text: `[Worker Bot ${to.name} is not reachable: hub tools are not loaded. Make sure dsh-remote-agent is running in hub mode.]`,
        role: 'reply', replyTo: exchangeId, ...(work ? { work } : {}),
      }).catch(() => {})
      return exchangeId
    }

    const taskId = randomUUID()
    const nodeId = node.nodeId

    try {
      const dispatchResult = await tools.dispatch.execute({
        nodeId, taskId, prompt: text,
        mode: 'agent', workDir: to.workDir ?? undefined,
      })
      if (dispatchResult?.isError) {
        throw new Error(`dispatch failed: ${dispatchResult.value ?? 'unknown error'}`)
      }

      const result = await waitForTask(tools, nodeId, taskId)

      let replyText
      if (result !== undefined) {
        const handoffResult = await tools.handoff.execute({ nodeId, taskId })
        replyText = handoffResult?.isError
          ? `[Task ${result.status.toLowerCase()}: ${result.summary ?? 'no summary'}]`
          : (handoffResult?.value?.text ?? `[Task ${result.status.toLowerCase()}]`)
      } else {
        replyText = `[Worker Bot ${to.name}: task timed out after ${Math.round(REMOTE_TASK_TIMEOUT_MS / 60000)} minutes]`
      }

      // Update runtime state.
      if (to.worker) {
        to.worker.lastSeen = Date.now()
        to.worker.online = true
        to.worker.taskCount = (to.worker.taskCount ?? 0) + 1
      }
      // Also update the individual node record in nodes[].
      if (Array.isArray(to.worker?.nodes)) {
        const rec = to.worker.nodes.find(n => n.nodeId === nodeId)
        if (rec) { rec.lastSeen = Date.now(); rec.online = true; rec.taskCount = (rec.taskCount ?? 0) + 1 }
      }

      void rt.deliver?.({
        fromId: toId, toId: fromId ?? toId,
        text: replyText, role: 'reply', replyTo: exchangeId,
        ...(work ? { work } : {}),
      }).catch(err => rt.warn('ds-bot: worker-bridge: reply delivery failed: %s', err))
    } catch (error) {
      rt.warn('ds-bot: worker-bridge: task dispatch failed for %s: %s', to.name, error)
      void rt.deliver?.({
        fromId: toId, toId: fromId ?? toId,
        text: `[Worker Bot ${to.name} error: ${error?.message ?? String(error)}]`,
        role: 'reply', replyTo: exchangeId, ...(work ? { work } : {}),
      }).catch(() => {})
    }

    return exchangeId
  }

  Object.assign(rt, { handleRemoteTurn, mintEnrollToken, pickWorkerNode: pickNode })
}
