package io.github.fei2411.dsbot.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.net.URL
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * UnifiedPush v2 connector receiver. Works with ntfy, NextPush, Sunup, and any
 * UnifiedPush distributor without requiring Google Play Services or FCM.
 */
class DsBotUnifiedPushReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT"
    const val ACTION_UNREGISTERED = "org.unifiedpush.android.connector.UNREGISTERED"
    const val ACTION_REGISTRATION_FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED"
    const val ACTION_MESSAGE = "org.unifiedpush.android.connector.MESSAGE"
    private const val MAX_ENDPOINT_LENGTH = 1024
    private const val MAX_MESSAGE_BYTES = 8192
  }

  private fun isSafeEndpoint(raw: String): Boolean {
    if (raw.isEmpty() || raw.length > MAX_ENDPOINT_LENGTH) return false
    return try {
      val parsed = URL(raw)
      parsed.protocol.lowercase(Locale.US) == "https" && parsed.userInfo == null && !parsed.host.isNullOrBlank()
    } catch (_: Exception) {
      false
    }
  }

  override fun onReceive(context: Context, intent: Intent?) {
    if (intent == null) return
    val prefs = DsBotNotifyHelper.prefs(context)
    val expectedDistributor = prefs.getString(DsBotNotifyHelper.KEY_UP_DISTRIBUTOR, null)
    val expectedToken = prefs.getString(DsBotNotifyHelper.KEY_UP_TOKEN, null)
    val token = intent.getStringExtra("token")
    if (expectedDistributor.isNullOrBlank() || expectedToken.isNullOrBlank() || token != expectedToken) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      val sender = sentFromPackage
      if (sender != null && sender != expectedDistributor) return
    }

    when (intent.action) {
      ACTION_NEW_ENDPOINT -> {
        val endpoint = intent.getStringExtra("endpoint")?.trim().orEmpty()
        if (!isSafeEndpoint(endpoint)) return
        prefs.edit()
          .putString(DsBotNotifyHelper.KEY_UP_ENDPOINT, endpoint)
          .putBoolean(DsBotNotifyHelper.KEY_UP_DISABLED, false)
          .remove(DsBotNotifyHelper.KEY_UP_ERROR)
          .apply()
        DsBotNotificationsModule.emitUnifiedPush("endpoint", endpoint, null)
      }
      ACTION_UNREGISTERED -> {
        prefs.edit()
          .remove(DsBotNotifyHelper.KEY_UP_ENDPOINT)
          .remove(DsBotNotifyHelper.KEY_UP_ERROR)
          .putBoolean(DsBotNotifyHelper.KEY_UP_DISABLED, true)
          .apply()
        DsBotNotificationsModule.emitUnifiedPush("unregistered", null, null)
      }
      ACTION_REGISTRATION_FAILED -> {
        val reason = intent.getStringExtra("message") ?: "Registration failed"
        prefs.edit()
          .putString(DsBotNotifyHelper.KEY_UP_ERROR, reason)
          .apply()
        DsBotNotificationsModule.emitUnifiedPush("failed", null, reason)
      }
      ACTION_MESSAGE -> {
        val bytes = intent.getByteArrayExtra("bytesMessage")
        val raw = when {
          bytes != null && bytes.isNotEmpty() -> {
            if (bytes.size > MAX_MESSAGE_BYTES) return
            String(bytes, Charsets.UTF_8)
          }
          else -> {
            val text = intent.getStringExtra("message")
            if (text != null && text.length > MAX_MESSAGE_BYTES) return
            text
          }
        }
        if (raw.isNullOrBlank()) return
        // Schedule an expedited JobService (safe on Android 12–16 even when process was killed).
        if (!DsBotNotifyHelper.enqueuePushJob(context, raw)) {
          val pending = goAsync()
          val finished = AtomicBoolean(false)
          val finishOnce = {
            if (finished.compareAndSet(false, true)) {
              try { pending.finish() } catch (_: Exception) {}
            }
          }
          Handler(Looper.getMainLooper()).postDelayed({ finishOnce() }, 14_000L)
          DsBotHeadlessRunner.runTask(
            context = context,
            data = DsBotHeadlessRunner.taskArgs("push", raw),
            timeoutMs = 13_000L,
            onDone = finishOnce,
          )
        }
      }
    }
  }
}
