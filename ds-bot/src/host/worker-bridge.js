// Worker Bridge: routes turns for type=remote-worker Bots to the remote hub via
// dsh-remote-agent's hub API, then delivers the task result back as a Bot reply.
//
// Intercept point: delivery.js calls rt.handleRemoteTurn() instead of agent.followup()
// when the target Bot has type === 'remote-worker'.
import { randomUUID } from 'node:crypto'

// How long to wait for a remote task to complete before timing out.
const REMOTE_TASK_TIMEOUT_MS = 60 * 60 * 1000   // 1 hour (matches AGENT_DEFAULT_TIMEOUT_MS)
// Polling interval when waiting for task completion via remote_status.
const POLL_INTERVAL_MS = 5_000

export function install(rt) {
  const { ctx } = rt

  // Resolve the hub API tools from the registered dsh-remote-agent plugin.
  // Returns undefined when the hub is not running or not reachable.
  function hubTools() {
    try {
      // The hub registers its tools into the DSH tool registry; we call them via ctx.
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

  // Main intercept: called by delivery.js when a message is sent to a Worker Bot.
  // Dispatches the message as a remote task and delivers the result back as a reply.
  async function handleRemoteTurn({ fromId, toId, text, role, exchangeId, replyTo, work }) {
    const to = rt.botOf(toId)
    if (to?.type !== 'remote-worker' || !to.worker?.nodeId) {
      rt.warn('ds-bot: worker-bridge: Bot %s has no nodeId, dropping turn', toId)
      return exchangeId
    }
    const tools = hubTools()
    if (tools === undefined) {
      rt.warn('ds-bot: worker-bridge: hub tools not available for Worker Bot %s', to.name)
      // Fall back to a local error reply so the sender is not silently blocked.
      void rt.deliver?.({
        fromId: toId,
        toId: fromId ?? toId,
        text: `[Worker Bot ${to.name} is not reachable: hub tools are not loaded. Make sure dsh-remote-agent is running in hub mode.]`,
        role: 'reply',
        replyTo: exchangeId,
        ...(work ? { work } : {}),
      }).catch(err => rt.warn('ds-bot: worker-bridge: error-reply delivery failed: %s', err))
      return exchangeId
    }

    const taskId = randomUUID()
    const nodeId = to.worker.nodeId

    try {
      // Dispatch the task to the remote node.
      const dispatchResult = await tools.dispatch.execute({
        nodeId,
        taskId,
        prompt: text,
        mode: 'agent',
        workDir: to.workDir ?? undefined,
      })
      if (dispatchResult?.isError) {
        throw new Error(`dispatch failed: ${dispatchResult.value ?? 'unknown error'}`)
      }

      // Poll for completion.
      const deadline = Date.now() + REMOTE_TASK_TIMEOUT_MS
      let result
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
        const statusResult = await tools.status.execute({ nodeId, taskId })
        if (statusResult?.isError) continue
        const s = statusResult?.value
        if (s?.status === 'COMPLETED' || s?.status === 'FAILED' || s?.status === 'ABORTED') {
          result = s
          break
        }
      }

      // Retrieve the full handoff text from the completed task.
      let replyText
      if (result !== undefined) {
        const handoffResult = await tools.handoff.execute({ nodeId, taskId })
        replyText = handoffResult?.isError
          ? `[Task ${result.status.toLowerCase()}: ${result.summary ?? 'no summary'}]`
          : (handoffResult?.value?.text ?? `[Task ${result.status.toLowerCase()}]`)
      } else {
        replyText = `[Worker Bot ${to.name}: task timed out after ${Math.round(REMOTE_TASK_TIMEOUT_MS / 60000)} minutes]`
      }

      // Update runtime state: online flag, lastSeen, taskCount.
      if (to.worker) {
        to.worker.lastSeen = Date.now()
        to.worker.online = true
        to.worker.taskCount = (to.worker.taskCount ?? 0) + 1
      }

      // Deliver the result back as a reply from the Worker Bot.
      void rt.deliver?.({
        fromId: toId,
        toId: fromId ?? toId,
        text: replyText,
        role: 'reply',
        replyTo: exchangeId,
        ...(work ? { work } : {}),
      }).catch(err => rt.warn('ds-bot: worker-bridge: reply delivery failed: %s', err))
    } catch (error) {
      rt.warn('ds-bot: worker-bridge: task dispatch failed for %s: %s', to.name, error)
      void rt.deliver?.({
        fromId: toId,
        toId: fromId ?? toId,
        text: `[Worker Bot ${to.name} error: ${error?.message ?? String(error)}]`,
        role: 'reply',
        replyTo: exchangeId,
        ...(work ? { work } : {}),
      }).catch(err => rt.warn('ds-bot: worker-bridge: error-reply delivery failed: %s', err))
    }

    return exchangeId
  }

  Object.assign(rt, { handleRemoteTurn })
}
