package io.github.fei2411.dsbot.system

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.github.fei2411.dsbot.MainActivity
import io.github.fei2411.dsbot.R
import java.util.Locale
import java.util.UUID

object DsBotNotifyHelper {
  const val CHANNEL_NEEDS_YOU = "dsbot_needs_you"
  const val CHANNEL_REPLIES = "dsbot_replies"
  const val CHANNEL_BACKGROUND = "dsbot_background"
  const val BG_NOTIFICATION_ID = 4100
  const val SYNC_JOB_ID = 4201
  private const val PUSH_JOB_ID_START = 4300
  private const val PUSH_JOB_SLOTS = 32
  private const val PREFS_NAME = "dsbot_native_notifications"

  const val KEY_BG_MODE = "bg_mode" // "off" | "periodic" | "instant"
  const val KEY_BG_TITLE = "bg_title"
  const val KEY_BG_SUBTITLE = "bg_subtitle"
  const val KEY_UP_DISTRIBUTOR = "up_distributor"
  const val KEY_UP_TOKEN = "up_token"
  const val KEY_UP_ENDPOINT = "up_endpoint"
  const val KEY_UP_ERROR = "up_error"
  const val KEY_UP_DISABLED = "up_disabled"
  private const val KEY_PUSH_SLOT = "push_slot"

  @Volatile var uiMounted: Boolean = false
  @Volatile var uiForeground: Boolean = false

  fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  fun smallIconRes(): Int = R.drawable.ic_dsbot_notification

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    val zh = Locale.getDefault().language.startsWith("zh")

    val needsYou = NotificationChannel(
      CHANNEL_NEEDS_YOU,
      if (zh) "等你处理" else "Needs you",
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = if (zh) "审批、提问、密钥与浏览器接管提醒" else "Approvals, questions, secrets, and browser handoffs"
      enableVibration(true)
      setShowBadge(true)
    }

    val replies = NotificationChannel(
      CHANNEL_REPLIES,
      if (zh) "回复与完成" else "Replies & updates",
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = if (zh) "Bot 私聊回复、群聊消息与任务完成提醒" else "Bot replies, group messages, and finished tasks"
      setShowBadge(true)
    }

    val background = NotificationChannel(
      CHANNEL_BACKGROUND,
      if (zh) "后台连接" else "Background connection",
      NotificationManager.IMPORTANCE_MIN,
    ).apply {
      description = if (zh) "保持实时后台提醒连接" else "Keeps real-time background notifications connected"
      setShowBadge(false)
      setSound(null, null)
      enableVibration(false)
    }

    manager.createNotificationChannel(needsYou)
    manager.createNotificationChannel(replies)
    manager.createNotificationChannel(background)
  }

  fun buildBackgroundNotification(context: Context, title: String, subtitle: String): Notification {
    ensureChannels(context)
    val openIntent = Intent(context, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val pending = PendingIntent.getActivity(
      context,
      BG_NOTIFICATION_ID,
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(context, CHANNEL_BACKGROUND)
      .setSmallIcon(smallIconRes())
      .setColor(0xFF4D6BFE.toInt())
      .setContentTitle(title)
      .setContentText(subtitle)
      .setOngoing(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(pending)
      .build()
  }

  fun postNoticeNotification(
    context: Context,
    tag: String,
    title: String,
    body: String,
    channel: String,
    targetKind: String,
    targetId: String,
    hostId: String,
    silent: Boolean,
  ): Boolean {
    ensureChannels(context)
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false

    val channelId = if (channel == "needs_you") CHANNEL_NEEDS_YOU else CHANNEL_REPLIES
    val uriBuilder = Uri.Builder()
      .scheme("dsbot")
      .authority("open")
      .appendQueryParameter("kind", targetKind)
    if (targetId.isNotEmpty()) uriBuilder.appendQueryParameter("id", targetId)
    if (hostId.isNotEmpty()) uriBuilder.appendQueryParameter("host", hostId)

    val launchIntent = Intent(Intent.ACTION_VIEW, uriBuilder.build(), context, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val notifId = if (channelId == CHANNEL_NEEDS_YOU) 2 else 1
    val requestCode = (tag.hashCode() * 31) + notifId
    val pending = PendingIntent.getActivity(
      context,
      requestCode,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val builder = NotificationCompat.Builder(context, channelId)
      .setSmallIcon(smallIconRes())
      .setColor(0xFF4D6BFE.toInt())
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(if (channelId == CHANNEL_NEEDS_YOU) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
      .setContentIntent(pending)
      .setSilent(silent)

    return try {
      NotificationManagerCompat.from(context).notify(tag, notifId, builder.build())
      true
    } catch (_: SecurityException) {
      false
    }
  }

  fun cancelByTag(context: Context, tag: String) {
    val nm = NotificationManagerCompat.from(context)
    nm.cancel(tag, 1)
    nm.cancel(tag, 2)
  }

  fun schedulePeriodicSync(context: Context, enabled: Boolean): Boolean {
    val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return false
    if (!enabled) {
      scheduler.cancel(SYNC_JOB_ID)
      return false
    }
    val extras = PersistableBundle().apply { putString("kind", "sync") }
    val info = JobInfo.Builder(SYNC_JOB_ID, ComponentName(context, DsBotSyncJobService::class.java))
      .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
      .setPeriodic(15L * 60L * 1000L)
      .setPersisted(true)
      .setExtras(extras)
      .build()
    return try {
      scheduler.schedule(info) == JobScheduler.RESULT_SUCCESS
    } catch (_: Exception) {
      false
    }
  }

  fun isPeriodicSyncScheduled(context: Context): Boolean {
    val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return false
    return scheduler.getPendingJob(SYNC_JOB_ID) != null
  }

  fun enqueuePushJob(context: Context, rawPayload: String): Boolean {
    val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return false
    val p = prefs(context)
    val slot = (p.getInt(KEY_PUSH_SLOT, 0) + 1) and (PUSH_JOB_SLOTS - 1)
    p.edit().putInt(KEY_PUSH_SLOT, slot).apply()
    val jobId = PUSH_JOB_ID_START + slot
    val extras = PersistableBundle().apply {
      putString("kind", "push")
      putString("rawPayload", rawPayload)
    }
    val builder = JobInfo.Builder(jobId, ComponentName(context, DsBotSyncJobService::class.java))
      .setExtras(extras)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setExpedited(true)
    } else {
      builder.setOverrideDeadline(1_000L)
    }
    return try {
      scheduler.schedule(builder.build()) == JobScheduler.RESULT_SUCCESS
    } catch (_: Exception) {
      false
    }
  }

  fun rotateUnifiedPushToken(context: Context): String {
    val created = UUID.randomUUID().toString()
    prefs(context).edit().putString(KEY_UP_TOKEN, created).apply()
    return created
  }
}
