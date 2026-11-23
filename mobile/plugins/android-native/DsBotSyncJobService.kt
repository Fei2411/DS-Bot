package io.github.fei2411.dsbot.system

import android.app.job.JobParameters
import android.app.job.JobService
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Handles both periodic notice catch-up (every 15 min) and expedited UnifiedPush
 * E2E decrypt-and-notify jobs when the app is killed or backgrounded.
 */
class DsBotSyncJobService : JobService() {
  private val activeJobTasks = ConcurrentHashMap<Int, Int>()

  override fun onStartJob(params: JobParameters?): Boolean {
    if (params == null) return false
    val kind = params.extras.getString("kind") ?: "sync"
    val rawPayload = params.extras.getString("rawPayload")

    // Skip periodic poll only when the UI is actively in the foreground or a headless keepalive
    // already holds the live relay connection (preventing CONNECTION_REPLACED churn).
    if (kind == "sync" && (DsBotNotifyHelper.uiForeground || DsBotHeadlessRunner.isKeepaliveRunning())) {
      return false
    }

    val jobId = params.jobId
    val finished = AtomicBoolean(false)
    val done = {
      activeJobTasks.remove(jobId)
      if (finished.compareAndSet(false, true)) {
        jobFinished(params, false)
      }
    }
    val timeoutMs = if (kind == "push") 15_000L else 25_000L
    DsBotHeadlessRunner.runTask(
      context = this,
      data = DsBotHeadlessRunner.taskArgs(kind, rawPayload),
      timeoutMs = timeoutMs,
      isKeepalive = false,
      onStarted = { taskId ->
        if (finished.get()) {
          DsBotHeadlessRunner.cancelTask(this, taskId)
        } else {
          activeJobTasks[jobId] = taskId
        }
      },
      onDone = done,
    )
    return true
  }

  override fun onNetworkChanged(params: JobParameters) {
    // Periodic sync and push decryption use NETWORK_TYPE_ANY and handle connectivity transitions naturally.
  }

  override fun onStopJob(params: JobParameters?): Boolean {
    if (params != null) {
      val taskId = activeJobTasks.remove(params.jobId)
      if (taskId != null) {
        DsBotHeadlessRunner.cancelTask(this, taskId)
      }
    }
    return false
  }
}
