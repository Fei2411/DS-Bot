package io.github.fei2411.dsbot.system

import android.app.job.JobParameters
import android.app.job.JobService
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Handles both periodic notice catch-up (every 15 min) and expedited UnifiedPush
 * E2E decrypt-and-notify jobs when the app is killed or backgrounded.
 */
class DsBotSyncJobService : JobService() {
  private class JobState(
    val stopped: AtomicBoolean = AtomicBoolean(false),
    val taskId: AtomicInteger = AtomicInteger(-1),
  )

  private val activeJobs = ConcurrentHashMap<Int, JobState>()

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
    val state = JobState()
    activeJobs.put(jobId, state)?.let { prev ->
      prev.stopped.set(true)
      val prevTask = prev.taskId.getAndSet(-1)
      if (prevTask >= 0) DsBotHeadlessRunner.cancelTask(this, prevTask)
    }

    val finished = AtomicBoolean(false)
    val done = {
      activeJobs.remove(jobId, state)
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
      shouldRun = { !finished.get() && !state.stopped.get() },
      onStarted = { taskId ->
        state.taskId.set(taskId)
        if (finished.get() || state.stopped.get()) {
          if (state.taskId.compareAndSet(taskId, -1)) {
            DsBotHeadlessRunner.cancelTask(this, taskId)
          }
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
      val state = activeJobs.remove(params.jobId)
      if (state != null) {
        state.stopped.set(true)
        val taskId = state.taskId.getAndSet(-1)
        if (taskId >= 0) {
          DsBotHeadlessRunner.cancelTask(this, taskId)
        }
      }
    }
    return false
  }
}
