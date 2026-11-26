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
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Starts headless JS tasks directly from a JobService or Foreground Service without
 * launching a background Service (avoiding Android 12+ BackgroundServiceStartNotAllowedException).
 */
object DsBotHeadlessRunner {
  const val TASK_NAME = "DsBotBackgroundTask"
  const val STOP_KEEPALIVE_EVENT = "dsbotStopKeepalive"
  private const val START_CONTEXT_TIMEOUT_MS = 15_000L

  private val mainHandler = Handler(Looper.getMainLooper())
  private val listeners = ConcurrentHashMap<Int, () -> Unit>()
  private val registered = Collections.synchronizedMap(WeakHashMap<ReactContext, HeadlessJsTaskEventListener>())
  private val keepaliveTaskId = AtomicInteger(-1)

  fun isKeepaliveRunning(): Boolean = keepaliveTaskId.get() >= 0

  fun runTask(
    context: Context,
    data: WritableMap,
    timeoutMs: Long,
    isKeepalive: Boolean = false,
    shouldRun: (() -> Boolean)? = null,
    onStarted: ((Int) -> Unit)? = null,
    onDone: (() -> Unit)? = null,
  ) {
    mainHandler.post {
      if (shouldRun?.invoke() == false) {
        onDone?.invoke()
        return@post
      }
      val app = context.applicationContext as? ReactApplication
      if (app == null) {
        onDone?.invoke()
        return@post
      }
      val config = HeadlessJsTaskConfig(TASK_NAME, data, timeoutMs, true)
      val current = currentReactContext(app)
      if (current != null) {
        startOnContext(current, config, isKeepalive, shouldRun, onStarted, onDone)
      } else {
        startReactContextAndRun(app, config, isKeepalive, shouldRun, onStarted, onDone)
      }
    }
  }

  fun cancelTask(context: Context, taskId: Int) {
    if (taskId < 0) return
    mainHandler.post {
      listeners.remove(taskId)
      keepaliveTaskId.compareAndSet(taskId, -1)
      val app = context.applicationContext as? ReactApplication ?: return@post
      val reactCtx = currentReactContext(app) ?: return@post
      try {
        HeadlessJsTaskContext.getInstance(reactCtx).finishTask(taskId)
      } catch (_: Exception) {
        // Task may already have finished.
      }
    }
  }

  fun stopKeepalive(context: Context) {
    mainHandler.post {
      val id = keepaliveTaskId.getAndSet(-1)
      val app = context.applicationContext as? ReactApplication ?: return@post
      val reactCtx = currentReactContext(app) ?: return@post
      // Emit event so the JS keepalive loop aborts its WebSocket and exits cleanly
      // (HeadlessJsTaskContext.finishTask only clears native tracking).
      try {
        if (reactCtx.hasActiveReactInstance()) {
          reactCtx
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(STOP_KEEPALIVE_EVENT, null)
        }
      } catch (_: Exception) {
        // Ignore if JS context is tearing down.
      }
      if (id >= 0) {
        listeners.remove(id)
        try {
          HeadlessJsTaskContext.getInstance(reactCtx).finishTask(id)
        } catch (_: Exception) {
          // Task may already have finished.
        }
      }
    }
  }

  private fun startOnContext(
    reactContext: ReactContext,
    config: HeadlessJsTaskConfig,
    isKeepalive: Boolean,
    shouldRun: (() -> Boolean)?,
    onStarted: ((Int) -> Unit)?,
    onDone: (() -> Unit)?,
  ) {
    try {
      if (shouldRun?.invoke() == false) {
        onDone?.invoke()
        return
      }
      if (isKeepalive && (DsBotNotifyHelper.uiMounted || !DsBotBackgroundService.running.get())) {
        onDone?.invoke()
        return
      }
      val taskCtx = HeadlessJsTaskContext.getInstance(reactContext)
      ensureEventListener(reactContext, taskCtx)
      if (isKeepalive) {
        val prev = keepaliveTaskId.getAndSet(-1)
        if (prev >= 0) {
          listeners.remove(prev)
          try { taskCtx.finishTask(prev) } catch (_: Exception) {}
        }
      }
      val taskId = taskCtx.startTask(config)
      if (isKeepalive) keepaliveTaskId.set(taskId)
      if (onDone != null) listeners[taskId] = onDone
      onStarted?.invoke(taskId)
    } catch (_: Exception) {
      onDone?.invoke()
    }
  }

  private fun ensureEventListener(reactContext: ReactContext, taskCtx: HeadlessJsTaskContext) {
    synchronized(registered) {
      if (registered.containsKey(reactContext)) return
      val listener = object : HeadlessJsTaskEventListener {
        override fun onHeadlessJsTaskStart(taskId: Int) {}
        override fun onHeadlessJsTaskFinish(taskId: Int) {
          keepaliveTaskId.compareAndSet(taskId, -1)
          listeners.remove(taskId)?.invoke()
        }
      }
      registered[reactContext] = listener
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
    shouldRun: (() -> Boolean)?,
    onStarted: ((Int) -> Unit)?,
    onDone: (() -> Unit)?,
  ) {
    val settled = AtomicBoolean(false)
    try {
      if (ReactNativeNewArchitectureFeatureFlags.enableBridgelessArchitecture()) {
        val host = app.reactHost
        if (host == null) {
          onDone?.invoke()
          return
        }
        lateinit var timeoutRunnable: Runnable
        val listener = object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            if (!settled.compareAndSet(false, true)) return
            mainHandler.removeCallbacks(timeoutRunnable)
            host.removeReactInstanceEventListener(this)
            mainHandler.post { startOnContext(context, config, isKeepalive, shouldRun, onStarted, onDone) }
          }
        }
        timeoutRunnable = Runnable {
          if (settled.compareAndSet(false, true)) {
            host.removeReactInstanceEventListener(listener)
            onDone?.invoke()
          }
        }
        host.addReactInstanceEventListener(listener)
        val alreadyReady = currentReactContext(app)
        if (alreadyReady != null) {
          if (settled.compareAndSet(false, true)) {
            host.removeReactInstanceEventListener(listener)
            mainHandler.post { startOnContext(alreadyReady, config, isKeepalive, shouldRun, onStarted, onDone) }
          }
          return
        }
        mainHandler.postDelayed(timeoutRunnable, START_CONTEXT_TIMEOUT_MS)
        host.start()
      } else {
        val manager = app.reactNativeHost.reactInstanceManager
        lateinit var timeoutRunnable: Runnable
        val listener = object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            if (!settled.compareAndSet(false, true)) return
            mainHandler.removeCallbacks(timeoutRunnable)
            manager.removeReactInstanceEventListener(this)
            mainHandler.post { startOnContext(context, config, isKeepalive, shouldRun, onStarted, onDone) }
          }
        }
        timeoutRunnable = Runnable {
          if (settled.compareAndSet(false, true)) {
            manager.removeReactInstanceEventListener(listener)
            onDone?.invoke()
          }
        }
        manager.addReactInstanceEventListener(listener)
        val alreadyReady = currentReactContext(app)
        if (alreadyReady != null) {
          if (settled.compareAndSet(false, true)) {
            manager.removeReactInstanceEventListener(listener)
            mainHandler.post { startOnContext(alreadyReady, config, isKeepalive, shouldRun, onStarted, onDone) }
          }
          return
        }
        mainHandler.postDelayed(timeoutRunnable, START_CONTEXT_TIMEOUT_MS)
        manager.createReactContextInBackground()
      }
    } catch (_: Exception) {
      if (settled.compareAndSet(false, true)) {
        onDone?.invoke()
      }
    }
  }

  fun taskArgs(kind: String, rawPayload: String? = null): WritableMap {
    val map = Arguments.createMap()
    map.putString("kind", kind)
    if (rawPayload != null) map.putString("rawPayload", rawPayload)
    return map
  }
}
