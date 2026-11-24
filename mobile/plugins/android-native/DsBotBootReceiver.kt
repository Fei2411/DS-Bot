package io.github.fei2411.dsbot.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restores channels and background delivery schedules after device reboot or APK self-update. */
class DsBotBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    DsBotNotifyHelper.ensureChannels(context)
    val mode = DsBotNotifyHelper.prefs(context).getString(DsBotNotifyHelper.KEY_BG_MODE, "off")
    if (mode == "periodic" || mode == "instant") {
      DsBotNotifyHelper.schedulePeriodicSync(context, true)
    }
    if (mode == "instant") {
      // Android 15+ may restrict foreground starts from BOOT_COMPLETED; fall back to scheduled sync safely.
      DsBotBackgroundService.start(context, headless = true)
    }
  }
}
