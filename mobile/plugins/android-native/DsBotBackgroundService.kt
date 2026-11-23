package io.github.fei2411.dsbot.system

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationManagerCompat
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

    /** Updates the persistent notification directly without calling startService() in background. */
    fun update(context: Context, subtitle: String) {
      if (!running.get()) return
      val prefs = DsBotNotifyHelper.prefs(context)
      val title = prefs.getString(DsBotNotifyHelper.KEY_BG_TITLE, null) ?: "DS Bot"
      val notification = DsBotNotifyHelper.buildBackgroundNotification(context, title, subtitle)
      try {
        NotificationManagerCompat.from(context).notify(DsBotNotifyHelper.BG_NOTIFICATION_ID, notification)
      } catch (_: SecurityException) {
        // Ignore if user revoked POST_NOTIFICATIONS while running.
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

  private fun enterForeground(title: String, subtitle: String): Boolean {
    val notification = DsBotNotifyHelper.buildBackgroundNotification(this, title, subtitle)
    val serviceType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
    } else {
      0
    }
    return try {
      ServiceCompat.startForeground(this, DsBotNotifyHelper.BG_NOTIFICATION_ID, notification, serviceType)
      true
    } catch (_: Exception) {
      false
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val prefs = DsBotNotifyHelper.prefs(this)
    val zh = Locale.getDefault().language.startsWith("zh")
    val title = intent?.getStringExtra(EXTRA_TITLE)
      ?: prefs.getString(DsBotNotifyHelper.KEY_BG_TITLE, null)
      ?: "DS Bot"
    val subtitle = intent?.getStringExtra(EXTRA_SUBTITLE)
      ?: prefs.getString(DsBotNotifyHelper.KEY_BG_SUBTITLE, null)
      ?: if (zh) "后台实时通知已开启" else "Background notifications active"

    val mode = prefs.getString(DsBotNotifyHelper.KEY_BG_MODE, "off")
    if (intent?.action == ACTION_STOP || mode != "instant") {
      // Android 12+ requires startForeground() before stopSelf() when launched via startForegroundService().
      if (!running.get()) {
        if (enterForeground(title, subtitle)) {
          ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        }
      } else {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      }
      running.set(false)
      DsBotHeadlessRunner.stopKeepalive(this)
      stopSelf()
      return START_NOT_STICKY
    }

    if (!enterForeground(title, subtitle)) {
      running.set(false)
      stopSelf()
      return START_NOT_STICKY
    }
    running.set(true)

    val requestedHeadless = intent == null || intent.getBooleanExtra(EXTRA_HEADLESS, false)
    if (requestedHeadless && !DsBotNotifyHelper.uiMounted) {
      DsBotHeadlessRunner.runTask(this, DsBotHeadlessRunner.taskArgs("keepalive"), 0L, isKeepalive = true)
    }
    return START_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    DsBotNotifyHelper.uiMounted = false
    DsBotNotifyHelper.uiForeground = false
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
