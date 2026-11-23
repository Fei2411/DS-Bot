package io.github.fei2411.dsbot.system

import android.app.job.JobParameters
import android.app.job.JobService
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Handles both periodic notice catch-up (every 15 min) and expedited UnifiedPush
 * E2E decrypt-and-notify jobs when the app is killed or backgrounded.
 */
class DsBotSyncJobService : JobService() {
  override fun onStartJob(params: JobParameters?): Boolean {
    if (params == null) return false
    val kind = params.extras.getString("kind") ?: "sync"
    val rawPayload = params.extras.getString("rawPayload")

    // Skip periodic poll when the UI is actively connected in the foreground.
    if (kind == "sync" && DsBotNotifyHelper.uiActive) {
      return false
    }

    val finished = AtomicBoolean(false)
    val done = {
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
      onDone = done,
    )
    return true
  }

  override fun onNetworkChanged(params: JobParameters) {
    // Periodic sync and push decryption use NETWORK_TYPE_ANY and handle connectivity transitions naturally.
  }

  override fun onStopJob(params: JobParameters?): Boolean = false
}
