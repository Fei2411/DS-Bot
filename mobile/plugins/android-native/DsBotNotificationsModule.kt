package io.github.fei2411.dsbot.system

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference

/**
 * Native Android bridge for notification channels, system notifications with chat deep links,
 * Foreground Service / JobScheduler background modes, battery exemption, and UnifiedPush v2.
 */
class DsBotNotificationsModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  companion object {
    const val NAME = "DsBotNotifications"
    private const val UP_EVENT = "dsbotUnifiedPushEvent"
    private const val ACTION_UP_REGISTER = "org.unifiedpush.android.distributor.REGISTER"
    private const val ACTION_UP_UNREGISTER = "org.unifiedpush.android.distributor.UNREGISTER"
    private const val FEATURE_BYTES = "org.unifiedpush.android.distributor.feature.BYTES_MESSAGE"

    @Volatile
    private var activeContext: WeakReference<ReactApplicationContext>? = null

    fun emitUnifiedPush(type: String, endpoint: String?, error: String?) {
      val ctx = activeContext?.get() ?: return
      if (!ctx.hasActiveReactInstance()) return
      val map = Arguments.createMap().apply {
        putString("type", type)
        if (endpoint != null) putString("endpoint", endpoint)
        if (error != null) putString("error", error)
      }
      try {
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(UP_EVENT, map)
      } catch (_: Exception) {
        // Ignore if JS bridge is tearing down.
      }
    }
  }

  init {
    activeContext = WeakReference(reactContext)
    DsBotNotifyHelper.ensureChannels(reactContext)
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun ensureChannels(promise: Promise) {
    DsBotNotifyHelper.ensureChannels(reactApplicationContext)
    promise.resolve(true)
  }

  @ReactMethod
  fun areNotificationsEnabled(promise: Promise) {
    promise.resolve(NotificationManagerCompat.from(reactApplicationContext).areNotificationsEnabled())
  }

  @ReactMethod
  fun setUiState(mounted: Boolean, foreground: Boolean, promise: Promise) {
    DsBotNotifyHelper.uiMounted = mounted
    DsBotNotifyHelper.uiForeground = mounted && foreground
    if (mounted) {
      DsBotHeadlessRunner.stopKeepalive(reactApplicationContext)
    }
    promise.resolve(true)
  }

  @ReactMethod
  fun notify(payload: ReadableMap, promise: Promise) {
    try {
      val tag = payload.getString("tag") ?: "dsbot"
      val title = payload.getString("title") ?: "DS Bot"
      val body = payload.getString("body") ?: ""
      val channel = payload.getString("channel") ?: "replies"
      val targetKind = payload.getString("targetKind") ?: "bot"
      val targetId = payload.getString("targetId") ?: ""
      val hostId = payload.getString("hostId") ?: ""
      val silent = if (payload.hasKey("silent") && !payload.isNull("silent")) payload.getBoolean("silent") else false
      val posted = DsBotNotifyHelper.postNoticeNotification(
        context = reactApplicationContext,
        tag = tag,
        title = title,
        body = body,
        channel = channel,
        targetKind = targetKind,
        targetId = targetId,
        hostId = hostId,
        silent = silent,
      )
      promise.resolve(posted)
    } catch (error: Exception) {
      promise.reject("NOTIFY_FAILED", error)
    }
  }

  @ReactMethod
  fun cancelTag(tag: String, promise: Promise) {
    DsBotNotifyHelper.cancelByTag(reactApplicationContext, tag)
    promise.resolve(true)
  }

  @ReactMethod
  fun openChannelSettings(channel: String?, promise: Promise) {
    try {
      val ctx = reactApplicationContext
      DsBotNotifyHelper.ensureChannels(ctx)
      val channelId = when (channel) {
        "needs_you" -> DsBotNotifyHelper.CHANNEL_NEEDS_YOU
        "replies" -> DsBotNotifyHelper.CHANNEL_REPLIES
        "background" -> DsBotNotifyHelper.CHANNEL_BACKGROUND
        else -> null
      }
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && channelId != null) {
        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).apply {
          putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
          putExtra(Settings.EXTRA_CHANNEL_ID, channelId)
        }
      } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
          putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        }
      } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))
      }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("SETTINGS_FAILED", error)
    }
  }

  private fun isIgnoringBattery(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
    val pm = reactApplicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return pm.isIgnoringBatteryOptimizations(reactApplicationContext.packageName)
  }

  @SuppressLint("BatteryLife")
  @ReactMethod
  fun requestIgnoreBatteryOptimizations(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        promise.resolve(true)
        return
      }
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        ctx.startActivity(intent)
      } catch (_: Exception) {
        val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(fallback)
      }
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("BATTERY_SETTINGS_FAILED", error)
    }
  }

  @ReactMethod
  fun setBackgroundConfig(config: ReadableMap, promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val mode = config.getString("mode") ?: "off"
      val title = config.getString("title") ?: "DS Bot"
      val subtitle = config.getString("subtitle") ?: ""
      DsBotNotifyHelper.prefs(ctx).edit()
        .putString(DsBotNotifyHelper.KEY_BG_MODE, mode)
        .putString(DsBotNotifyHelper.KEY_BG_TITLE, title)
        .putString(DsBotNotifyHelper.KEY_BG_SUBTITLE, subtitle)
        .apply()

      when (mode) {
        "instant" -> {
          val started = DsBotBackgroundService.start(ctx, title, subtitle, headless = false)
          val scheduled = DsBotNotifyHelper.schedulePeriodicSync(ctx, true)
          promise.resolve(Arguments.createMap().apply {
            putBoolean("serviceStarted", started)
            putBoolean("jobScheduled", scheduled)
          })
        }
        "periodic" -> {
          DsBotBackgroundService.stop(ctx)
          val scheduled = DsBotNotifyHelper.schedulePeriodicSync(ctx, true)
          promise.resolve(Arguments.createMap().apply {
            putBoolean("serviceStarted", false)
            putBoolean("jobScheduled", scheduled)
          })
        }
        else -> {
          DsBotBackgroundService.stop(ctx)
          DsBotNotifyHelper.schedulePeriodicSync(ctx, false)
          promise.resolve(Arguments.createMap().apply {
            putBoolean("serviceStarted", false)
            putBoolean("jobScheduled", false)
          })
        }
      }
    } catch (error: Exception) {
      promise.reject("BG_CONFIG_FAILED", error)
    }
  }

  @ReactMethod
  fun updateBackgroundStatus(subtitle: String, promise: Promise) {
    DsBotNotifyHelper.prefs(reactApplicationContext).edit()
      .putString(DsBotNotifyHelper.KEY_BG_SUBTITLE, subtitle)
      .apply()
    DsBotBackgroundService.update(reactApplicationContext, subtitle)
    promise.resolve(true)
  }

  private fun queryDistributors(): List<Pair<String, String>> {
    val pm = reactApplicationContext.packageManager
    val intent = Intent(ACTION_UP_REGISTER)
    val resolved = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      pm.queryBroadcastReceivers(intent, PackageManager.ResolveInfoFlags.of(0L))
    } else {
      @Suppress("DEPRECATION")
      pm.queryBroadcastReceivers(intent, 0)
    }
    val seen = LinkedHashSet<String>()
    val result = ArrayList<Pair<String, String>>()
    for (info in resolved) {
      val pkg = info.activityInfo?.packageName ?: continue
      if (pkg == reactApplicationContext.packageName || !seen.add(pkg)) continue
      val label = try {
        info.loadLabel(pm).toString().ifBlank { pkg }
      } catch (_: Exception) {
        pkg
      }
      result.add(pkg to label)
    }
    return result
  }

  @ReactMethod
  fun registerUnifiedPush(distributorPackage: String, promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val prefs = DsBotNotifyHelper.prefs(ctx)
      val prevPkg = prefs.getString(DsBotNotifyHelper.KEY_UP_DISTRIBUTOR, null)
      val prevToken = prefs.getString(DsBotNotifyHelper.KEY_UP_TOKEN, null)
      if (!prevPkg.isNullOrBlank() && !prevToken.isNullOrBlank()) {
        val unreg = Intent(ACTION_UP_UNREGISTER).apply {
          `package` = prevPkg
          putExtra("token", prevToken)
        }
        ctx.sendBroadcast(unreg)
      }
      val token = DsBotNotifyHelper.rotateUnifiedPushToken(ctx)
      prefs.edit()
        .putString(DsBotNotifyHelper.KEY_UP_DISTRIBUTOR, distributorPackage)
        .putBoolean(DsBotNotifyHelper.KEY_UP_DISABLED, false)
        .remove(DsBotNotifyHelper.KEY_UP_ENDPOINT)
        .remove(DsBotNotifyHelper.KEY_UP_ERROR)
        .apply()
      val intent = Intent(ACTION_UP_REGISTER).apply {
        `package` = distributorPackage
        putExtra("token", token)
        putExtra("application", ctx.packageName)
        putStringArrayListExtra("features", arrayListOf(FEATURE_BYTES))
      }
      ctx.sendBroadcast(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("UP_REGISTER_FAILED", error)
    }
  }

  @ReactMethod
  fun unregisterUnifiedPush(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val prefs = DsBotNotifyHelper.prefs(ctx)
      val pkg = prefs.getString(DsBotNotifyHelper.KEY_UP_DISTRIBUTOR, null)
      val token = prefs.getString(DsBotNotifyHelper.KEY_UP_TOKEN, null)
      if (!pkg.isNullOrBlank() && !token.isNullOrBlank()) {
        val intent = Intent(ACTION_UP_UNREGISTER).apply {
          `package` = pkg
          putExtra("token", token)
        }
        ctx.sendBroadcast(intent)
      }
      prefs.edit()
        .remove(DsBotNotifyHelper.KEY_UP_DISTRIBUTOR)
        .remove(DsBotNotifyHelper.KEY_UP_TOKEN)
        .remove(DsBotNotifyHelper.KEY_UP_ENDPOINT)
        .remove(DsBotNotifyHelper.KEY_UP_ERROR)
        .putBoolean(DsBotNotifyHelper.KEY_UP_DISABLED, true)
        .apply()
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("UP_UNREGISTER_FAILED", error)
    }
  }

  @ReactMethod
  fun getBackgroundStatus(promise: Promise) {
    val ctx = reactApplicationContext
    val prefs = DsBotNotifyHelper.prefs(ctx)
    val distributors = Arguments.createArray()
    for ((pkg, label) in queryDistributors()) {
      distributors.pushMap(Arguments.createMap().apply {
        putString("packageName", pkg)
        putString("label", label)
      })
    }
    val map = Arguments.createMap().apply {
      putBoolean("notificationsEnabled", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
      putBoolean("ignoringBattery", isIgnoringBattery())
      putBoolean("serviceRunning", DsBotBackgroundService.running.get())
      putBoolean("jobScheduled", DsBotNotifyHelper.isPeriodicSyncScheduled(ctx))
      putString("mode", prefs.getString(DsBotNotifyHelper.KEY_BG_MODE, "off") ?: "off")
      putArray("unifiedPushDistributors", distributors)
      val dist = prefs.getString(DsBotNotifyHelper.KEY_UP_DISTRIBUTOR, null)
      val ep = prefs.getString(DsBotNotifyHelper.KEY_UP_ENDPOINT, null)
      val err = prefs.getString(DsBotNotifyHelper.KEY_UP_ERROR, null)
      putBoolean("unifiedPushDisabled", prefs.getBoolean(DsBotNotifyHelper.KEY_UP_DISABLED, false))
      if (dist != null) putString("unifiedPushDistributor", dist) else putNull("unifiedPushDistributor")
      if (ep != null) putString("unifiedPushEndpoint", ep) else putNull("unifiedPushEndpoint")
      if (err != null) putString("unifiedPushError", err) else putNull("unifiedPushError")
    }
    promise.resolve(map)
  }

  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}
}
