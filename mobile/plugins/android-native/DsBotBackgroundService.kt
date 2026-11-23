package io.github.fei2411.dsbot.system

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Optional Foreground Service (type remoteMessaging) that keeps the E2E encrypted
 * relay connection alive when the app is backgrounded or swiped from recents.
 */
class DsBotBackgroundService : Service() {
  companion object {
    const val ACTION_START = "io.github.fei2411.dsbot.action.BG_START"
    const val ACTION_UPDATE = "io.github.fei2411.dsbot.action.BG_UPDATE"
    const val ACTION_STOP = "io.github.fei2411.dsbot.action.BG_STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_SUBTITLE = "subtitle"
    const val EXTRA_HEADLESS = "headless"

    val running = AtomicBoolean(false)

    fun start(context: Context, title: String? = null, subtitle: String? = null, headless: Boolean = false): Boolean {
      val intent = Intent(context, DsBotBackgroundService::class.java).apply {
        action = ACTION_START
        if (title != null) putExtra(EXTRA_TITLE, title)
        if (subtitle != null) putExtra(EXTRA_SUBTITLE, subtitle)
        putExtra(EXTRA_HEADLESS, headless)
      }
      return try {
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (_: Exception) {
        false
      }
    }

    fun update(context: Context, subtitle: String) {
      if (!running.get()) return
      val intent = Intent(context, DsBotBackgroundService::class.java).apply {
        action = ACTION_UPDATE
        putExtra(EXTRA_SUBTITLE, subtitle)
      }
      try {
        context.startService(intent)
      } catch (_: Exception) {
        // Service may already be stopping.
      }
    }

    fun stop(context: Context) {
      running.set(false)
      DsBotHeadlessRunner.stopKeepalive(context)
      try {
        context.stopService(Intent(context, DsBotBackgroundService::class.java))
      } catch (_: Exception) {
        // Ignore if not running.
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      DsBotHeadlessRunner.stopKeepalive(this)
      stopSelf()
      return START_NOT_STICKY
    }

    val prefs = DsBotNotifyHelper.prefs(this)
    val mode = prefs.getString(DsBotNotifyHelper.KEY_BG_MODE, "off")
    if (mode != "instant") {
      stopSelf()
      return START_NOT_STICKY
    }

    val zh = Locale.getDefault().language.startsWith("zh")
    val title = intent?.getStringExtra(EXTRA_TITLE)
      ?: prefs.getString(DsBotNotifyHelper.KEY_BG_TITLE, null)
      ?: "DS Bot"
    val subtitle = intent?.getStringExtra(EXTRA_SUBTITLE)
      ?: prefs.getString(DsBotNotifyHelper.KEY_BG_SUBTITLE, null)
      ?: if (zh) "后台实时通知已开启" else "Background notifications active"

    val notification = DsBotNotifyHelper.buildBackgroundNotification(this, title, subtitle)
    val serviceType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
    } else {
      0
    }
    try {
      ServiceCompat.startForeground(this, DsBotNotifyHelper.BG_NOTIFICATION_ID, notification, serviceType)
      running.set(true)
    } catch (_: Exception) {
      running.set(false)
      stopSelf()
      return START_NOT_STICKY
    }

    val requestedHeadless = intent == null || intent.getBooleanExtra(EXTRA_HEADLESS, false)
    if (requestedHeadless && !DsBotNotifyHelper.uiActive && intent?.action != ACTION_UPDATE) {
      DsBotHeadlessRunner.runTask(this, DsBotHeadlessRunner.taskArgs("keepalive"), 0L, isKeepalive = true)
    }
    return START_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    DsBotNotifyHelper.uiActive = false
    val mode = DsBotNotifyHelper.prefs(this).getString(DsBotNotifyHelper.KEY_BG_MODE, "off")
    if (mode == "instant" && running.get()) {
      DsBotHeadlessRunner.runTask(this, DsBotHeadlessRunner.taskArgs("keepalive"), 0L, isKeepalive = true)
    }
  }

  override fun onDestroy() {
    running.set(false)
    DsBotHeadlessRunner.stopKeepalive(this)
    super.onDestroy()
  }
}
