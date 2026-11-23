package io.github.fei2411.dsbot.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

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
  }

  override fun onReceive(context: Context, intent: Intent?) {
    if (intent == null) return
    val prefs = DsBotNotifyHelper.prefs(context)
    val expectedToken = prefs.getString(DsBotNotifyHelper.KEY_UP_TOKEN, null)
    val token = intent.getStringExtra("token")
    if (expectedToken.isNullOrBlank() || token != expectedToken) return

    when (intent.action) {
      ACTION_NEW_ENDPOINT -> {
        val endpoint = intent.getStringExtra("endpoint")?.trim().orEmpty()
        if (endpoint.isEmpty()) return
        prefs.edit()
          .putString(DsBotNotifyHelper.KEY_UP_ENDPOINT, endpoint)
          .remove(DsBotNotifyHelper.KEY_UP_ERROR)
          .apply()
        DsBotNotificationsModule.emitUnifiedPush("endpoint", endpoint, null)
      }
      ACTION_UNREGISTERED -> {
        prefs.edit()
          .remove(DsBotNotifyHelper.KEY_UP_ENDPOINT)
          .remove(DsBotNotifyHelper.KEY_UP_ERROR)
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
          bytes != null && bytes.isNotEmpty() -> String(bytes, Charsets.UTF_8)
          else -> intent.getStringExtra("message")
        }
        if (raw.isNullOrBlank()) return
        // Schedule an expedited JobService (safe on Android 12–16 even when process was killed).
        if (!DsBotNotifyHelper.enqueuePushJob(context, raw)) {
          DsBotHeadlessRunner.runTask(
            context = context,
            data = DsBotHeadlessRunner.taskArgs("push", raw),
            timeoutMs = 15_000L,
          )
        }
      }
    }
  }
}
