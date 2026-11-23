package io.github.fei2411.dsbot.system

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.internal.featureflags.ReactNativeNewArchitectureFeatureFlags
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Starts headless JS tasks directly from a JobService or Foreground Service without
 * launching a background Service (avoiding Android 12+ BackgroundServiceStartNotAllowedException).
 */
object DsBotHeadlessRunner {
  const val TASK_NAME = "DsBotBackgroundTask"
  private val mainHandler = Handler(Looper.getMainLooper())
  private val listeners = ConcurrentHashMap<Int, () -> Unit>()
  private val registered = ConcurrentHashMap<ReactContext, HeadlessJsTaskEventListener>()
  private val keepaliveTaskId = AtomicInteger(-1)

  fun runTask(
    context: Context,
    data: WritableMap,
    timeoutMs: Long,
    isKeepalive: Boolean = false,
    onDone: (() -> Unit)? = null,
  ) {
    mainHandler.post {
      val app = context.applicationContext as? ReactApplication
      if (app == null) {
        onDone?.invoke()
        return@post
      }
      val config = HeadlessJsTaskConfig(TASK_NAME, data, timeoutMs, true)
      val current = currentReactContext(app)
      if (current != null) {
        startOnContext(current, config, isKeepalive, onDone)
      } else {
        startReactContextAndRun(app, config, isKeepalive, onDone)
      }
    }
  }

  fun stopKeepalive(context: Context) {
    mainHandler.post {
      val id = keepaliveTaskId.getAndSet(-1)
      if (id < 0) return@post
      val app = context.applicationContext as? ReactApplication ?: return@post
      val reactCtx = currentReactContext(app) ?: return@post
      try {
        HeadlessJsTaskContext.getInstance(reactCtx).finishTask(id)
      } catch (_: Exception) {
        // Task may already have finished.
      }
    }
  }

  private fun startOnContext(
    reactContext: ReactContext,
    config: HeadlessJsTaskConfig,
    isKeepalive: Boolean,
    onDone: (() -> Unit)?,
  ) {
    try {
      val taskCtx = HeadlessJsTaskContext.getInstance(reactContext)
      ensureEventListener(reactContext, taskCtx)
      if (isKeepalive) {
        val prev = keepaliveTaskId.getAndSet(-1)
        if (prev >= 0) {
          try { taskCtx.finishTask(prev) } catch (_: Exception) {}
        }
      }
      val taskId = taskCtx.startTask(config)
      if (isKeepalive) keepaliveTaskId.set(taskId)
      if (onDone != null) listeners[taskId] = onDone
    } catch (_: Exception) {
      onDone?.invoke()
    }
  }

  private fun ensureEventListener(reactContext: ReactContext, taskCtx: HeadlessJsTaskContext) {
    if (registered.containsKey(reactContext)) return
    val listener = object : HeadlessJsTaskEventListener {
      override fun onHeadlessJsTaskStart(taskId: Int) {}
      override fun onHeadlessJsTaskFinish(taskId: Int) {
        keepaliveTaskId.compareAndSet(taskId, -1)
        listeners.remove(taskId)?.invoke()
      }
    }
    if (registered.putIfAbsent(reactContext, listener) == null) {
      taskCtx.addTaskEventListener(listener)
    }
  }

  @Suppress("DEPRECATION")
  private fun currentReactContext(app: ReactApplication): ReactContext? {
    return if (ReactNativeNewArchitectureFeatureFlags.enableBridgelessArchitecture()) {
      app.reactHost?.currentReactContext
    } else {
      app.reactNativeHost.reactInstanceManager.currentReactContext
    }
  }

  @Suppress("DEPRECATION")
  private fun startReactContextAndRun(
    app: ReactApplication,
    config: HeadlessJsTaskConfig,
    isKeepalive: Boolean,
    onDone: (() -> Unit)?,
  ) {
    try {
      if (ReactNativeNewArchitectureFeatureFlags.enableBridgelessArchitecture()) {
        val host = app.reactHost
        if (host == null) {
          onDone?.invoke()
          return
        }
        host.addReactInstanceEventListener(object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            host.removeReactInstanceEventListener(this)
            startOnContext(context, config, isKeepalive, onDone)
          }
        })
        host.start()
      } else {
        val manager = app.reactNativeHost.reactInstanceManager
        manager.addReactInstanceEventListener(object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            manager.removeReactInstanceEventListener(this)
            startOnContext(context, config, isKeepalive, onDone)
          }
        })
        manager.createReactContextInBackground()
      }
    } catch (_: Exception) {
      onDone?.invoke()
    }
  }

  fun taskArgs(kind: String, rawPayload: String? = null): WritableMap {
    val map = Arguments.createMap()
    map.putString("kind", kind)
    if (rawPayload != null) map.putString("rawPayload", rawPayload)
    return map
  }
}
