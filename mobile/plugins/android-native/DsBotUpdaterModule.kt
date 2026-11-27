package io.github.fei2411.dsbot.system

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import io.github.fei2411.dsbot.BuildConfig
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Downloads verified Android release APKs to cacheDir/updates/ with streaming SHA-256
 * verification, disk-space checks, HTTPS redirect enforcement, and FileProvider install handoff.
 */
class DsBotUpdaterModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  companion object {
    const val NAME = "DsBotUpdater"
    private const val PROGRESS_EVENT = "dsbotUpdateProgress"
    private const val MAX_REDIRECTS = 5
    private const val BUFFER_BYTES = 64 * 1024
    private const val MIN_FREE_HEADROOM_BYTES = 64L * 1024 * 1024
    private const val MAX_APK_BYTES = 512L * 1024 * 1024
    private val SHA256_HEX = Regex("^[0-9a-fA-F]{64}$")
    private val SAFE_APK_NAME = Regex("^[A-Za-z0-9._-]+\\.apk$")
  }

  private class ActiveDownload(
    val id: Long,
    val partName: String,
    val cancelled: AtomicBoolean = AtomicBoolean(false),
    val conn: AtomicReference<HttpURLConnection?> = AtomicReference(null),
  ) {
    fun cancel() {
      cancelled.set(true)
      try { conn.get()?.disconnect() } catch (_: Exception) {}
    }
  }

  private val downloadExecutor = Executors.newCachedThreadPool()
  private val cacheExecutor = Executors.newSingleThreadExecutor()
  private val downloadSeq = AtomicLong(0)
  private val activeDownload = AtomicReference<ActiveDownload?>(null)
  private val cacheLock = Any()

  override fun getName(): String = NAME

  override fun invalidate() {
    activeDownload.getAndSet(null)?.cancel()
    downloadExecutor.shutdownNow()
    cacheExecutor.shutdownNow()
    super.invalidate()
  }

  private fun updatesDir(): File {
    val dir = File(reactApplicationContext.cacheDir, "updates")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  private fun isAllowedDownloadUrl(rawUrl: String): Boolean {
    val parsed = try { URL(rawUrl) } catch (_: Exception) { return false }
    if (parsed.userInfo != null || parsed.host.isNullOrBlank()) return false
    val scheme = parsed.protocol.lowercase(Locale.US)
    if (scheme == "https") return true
    if (BuildConfig.DEBUG && scheme == "http") {
      val host = parsed.host.lowercase(Locale.US)
      return host == "10.0.2.2" || host == "127.0.0.1" || host == "localhost"
    }
    return false
  }

  private fun emitProgress(download: ActiveDownload, bytesWritten: Long, totalBytes: Long) {
    if (download.cancelled.get() || activeDownload.get() !== download) return
    if (!reactApplicationContext.hasActiveReactInstance()) return
    val map = Arguments.createMap()
    map.putDouble("bytesWritten", bytesWritten.toDouble())
    map.putDouble("totalBytes", totalBytes.toDouble())
    map.putDouble("progress", if (totalBytes > 0L) (bytesWritten.toDouble() / totalBytes.toDouble()).coerceIn(0.0, 1.0) else -1.0)
    try {
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(PROGRESS_EVENT, map)
    } catch (_: Exception) {
      // Ignore if JS listener is tearing down.
    }
  }

  private fun sha256OfFile(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(BUFFER_BYTES)
    FileInputStream(file).use { input ->
      while (true) {
        val read = input.read(buf)
        if (read <= 0) break
        digest.update(buf, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun safeCompareHex(actual: String, expected: String): Boolean {
    val left = actual.lowercase(Locale.US).toByteArray(Charsets.UTF_8)
    val right = expected.lowercase(Locale.US).toByteArray(Charsets.UTF_8)
    return MessageDigest.isEqual(left, right)
  }

  private fun openFollowingRedirects(initialUrl: String, download: ActiveDownload): HttpURLConnection {
    var currentUrl = initialUrl
    for (hop in 0..MAX_REDIRECTS) {
      if (download.cancelled.get()) throw CancelledException()
      if (!isAllowedDownloadUrl(currentUrl)) throw SecurityException("Only HTTPS update URLs are allowed")
      val conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = 20_000
        readTimeout = 30_000
        requestMethod = "GET"
        setRequestProperty("User-Agent", "DS-Bot-Android/${BuildConfig.VERSION_NAME}")
        setRequestProperty("Accept", "application/vnd.android.package-archive, application/octet-stream, */*")
      }
      download.conn.set(conn)
      if (download.cancelled.get()) {
        conn.disconnect()
        throw CancelledException()
      }
      val code = conn.responseCode
      if (code in listOf(301, 302, 303, 307, 308)) {
        val loc = conn.getHeaderField("Location")
        conn.disconnect()
        if (loc.isNullOrBlank()) throw IOException("Redirect without Location header")
        currentUrl = URL(URL(currentUrl), loc).toString()
        continue
      }
      if (code !in 200..299) {
        conn.disconnect()
        throw IOException("HTTP $code")
      }
      return conn
    }
    throw IOException("Too many redirects")
  }

  @ReactMethod
  fun canInstallPackages(promise: Promise) {
    try {
      val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactApplicationContext.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
      promise.resolve(allowed)
    } catch (error: Exception) {
      promise.reject("CHECK_FAILED", error)
    }
  }

  @ReactMethod
  fun openInstallPermissionSettings(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
      } else {
        Intent(Settings.ACTION_SECURITY_SETTINGS)
      }.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      try {
        ctx.startActivity(intent)
      } catch (_: Exception) {
        val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(fallback)
      }
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("SETTINGS_FAILED", error)
    }
  }

  @ReactMethod
  fun getCachedApk(fileName: String, expectedSha256: String, promise: Promise) {
    if (!SAFE_APK_NAME.matches(fileName) || !SHA256_HEX.matches(expectedSha256)) {
      promise.resolve(null)
      return
    }
    cacheExecutor.execute {
      try {
        val result = synchronized(cacheLock) {
          val dir = updatesDir().canonicalFile
          val target = File(dir, fileName).canonicalFile
          if (target.parentFile != dir || !target.isFile) {
            return@synchronized null
          }
          val actual = sha256OfFile(target)
          if (!safeCompareHex(actual, expectedSha256)) {
            target.delete()
            return@synchronized null
          }
          Arguments.createMap().apply {
            putString("path", target.absolutePath)
            putDouble("size", target.length().toDouble())
            putString("sha256", actual)
          }
        }
        promise.resolve(result)
      } catch (_: Exception) {
        promise.resolve(null)
      }
    }
  }

  @ReactMethod
  fun downloadApk(url: String, fileName: String, expectedSha256: String, expectedSize: Double, promise: Promise) {
    if (!SAFE_APK_NAME.matches(fileName)) {
      promise.reject("INVALID_FILENAME", "Invalid APK file name")
      return
    }
    if (!SHA256_HEX.matches(expectedSha256)) {
      promise.reject("INVALID_CHECKSUM", "Expected SHA-256 checksum is required")
      return
    }
    if (!isAllowedDownloadUrl(url)) {
      promise.reject("INVALID_URL", "Only HTTPS update URLs are allowed")
      return
    }
    val current = activeDownload.get()
    if (current != null && !current.cancelled.get()) {
      promise.reject("ALREADY_DOWNLOADING", "An update download is already in progress")
      return
    }
    val id = downloadSeq.incrementAndGet()
    val partName = "$fileName.$id.part"
    val download = ActiveDownload(id = id, partName = partName)
    if (!activeDownload.compareAndSet(current, download)) {
      promise.reject("ALREADY_DOWNLOADING", "An update download is already in progress")
      return
    }
    downloadExecutor.execute {
      val dir = updatesDir().canonicalFile
      val finalFile = File(dir, fileName).canonicalFile
      val partFile = File(dir, partName).canonicalFile
      var conn: HttpURLConnection? = null
      try {
        if (finalFile.parentFile != dir || partFile.parentFile != dir) {
          throw SecurityException("Invalid update cache path")
        }
        val needed = (if (expectedSize > 0) expectedSize.toLong() else 64L * 1024 * 1024) + MIN_FREE_HEADROOM_BYTES
        val available = StatFs(dir.path).availableBytes
        if (available < needed) {
          throw InsufficientStorageException("Not enough free storage space for the update")
        }
        if (partFile.exists()) partFile.delete()

        conn = openFollowingRedirects(url, download)
        val contentLength = conn.contentLengthLong.let { if (it > 0L) it else expectedSize.toLong().coerceAtLeast(0L) }
        if (contentLength > MAX_APK_BYTES) {
          throw IOException("Update package exceeds maximum allowed size")
        }
        if (contentLength > 0L && StatFs(dir.path).availableBytes < contentLength + MIN_FREE_HEADROOM_BYTES) {
          throw InsufficientStorageException("Not enough free storage space for the update")
        }
        val digest = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(BUFFER_BYTES)
        var written = 0L
        var lastEmitMs = 0L

        emitProgress(download, 0L, contentLength)
        conn.inputStream.use { input ->
          FileOutputStream(partFile).use { output ->
            while (true) {
              if (download.cancelled.get()) throw CancelledException()
              val read = input.read(buf)
              if (read <= 0) break
              written += read.toLong()
              if (written > MAX_APK_BYTES) {
                throw IOException("Update package exceeds maximum allowed size")
              }
              output.write(buf, 0, read)
              digest.update(buf, 0, read)
              val now = System.currentTimeMillis()
              if (now - lastEmitMs >= 150L) {
                lastEmitMs = now
                emitProgress(download, written, contentLength)
              }
            }
            if (download.cancelled.get()) throw CancelledException()
            output.fd.sync()
          }
        }
        if (download.cancelled.get()) throw CancelledException()
        emitProgress(download, written, if (contentLength > 0L) contentLength else written)

        val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
        if (!safeCompareHex(actualSha, expectedSha256)) {
          partFile.delete()
          promise.reject("CHECKSUM_MISMATCH", "Downloaded APK SHA-256 verification failed")
          return@execute
        }

        // Remove older APKs and atomically place the verified APK only if this download is still current.
        val result = synchronized(cacheLock) {
          if (download.cancelled.get() || activeDownload.get() !== download) {
            throw CancelledException()
          }
          dir.listFiles()?.forEach { child ->
            val canon = child.canonicalFile
            if (canon != partFile && canon != finalFile) {
              child.delete()
            }
          }
          if (finalFile.exists()) finalFile.delete()
          if (!partFile.renameTo(finalFile)) {
            partFile.copyTo(finalFile, overwrite = true)
            partFile.delete()
          }
          Arguments.createMap().apply {
            putString("path", finalFile.absolutePath)
            putDouble("size", finalFile.length().toDouble())
            putString("sha256", actualSha)
          }
        }
        promise.resolve(result)
      } catch (_: CancelledException) {
        partFile.delete()
        promise.reject("CANCELLED", "Download cancelled")
      } catch (storage: InsufficientStorageException) {
        partFile.delete()
        promise.reject("INSUFFICIENT_STORAGE", storage.message)
      } catch (error: Exception) {
        partFile.delete()
        if (download.cancelled.get()) {
          promise.reject("CANCELLED", "Download cancelled")
        } else {
          promise.reject("DOWNLOAD_FAILED", error.message ?: "Download failed", error)
        }
      } finally {
        download.conn.set(null)
        try { conn?.disconnect() } catch (_: Exception) {}
        activeDownload.compareAndSet(download, null)
      }
    }
  }

  @ReactMethod
  fun cancelDownload(promise: Promise) {
    activeDownload.getAndSet(null)?.cancel()
    promise.resolve(true)
  }

  @ReactMethod
  fun installApk(filePath: String, expectedSha256: String, promise: Promise) {
    if (!SHA256_HEX.matches(expectedSha256)) {
      promise.reject("INVALID_CHECKSUM", "Expected SHA-256 checksum is required")
      return
    }
    cacheExecutor.execute {
      try {
        val ctx = reactApplicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
          promise.reject("INSTALL_PERMISSION_REQUIRED", "Install unknown apps permission is required")
          return@execute
        }
        val apkFile = synchronized(cacheLock) {
          val dir = updatesDir().canonicalFile
          val candidate = File(filePath).canonicalFile
          if (candidate.parentFile != dir || !candidate.name.endsWith(".apk") || !candidate.isFile) {
            promise.reject("INVALID_APK_PATH", "APK file is not in the update cache")
            return@synchronized null
          }
          val actualSha = sha256OfFile(candidate)
          if (!safeCompareHex(actualSha, expectedSha256)) {
            candidate.delete()
            promise.reject("CHECKSUM_MISMATCH", "Cached APK failed SHA-256 verification")
            return@synchronized null
          }
          candidate
        } ?: return@execute
        val contentUri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.dsbot.apkprovider", apkFile)
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(contentUri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(intent)
        promise.resolve(true)
      } catch (error: Exception) {
        promise.reject("INSTALL_FAILED", error.message ?: "Could not open the package installer", error)
      }
    }
  }

  @ReactMethod
  fun cleanupCache(keepFileName: String?, promise: Promise) {
    cacheExecutor.execute {
      try {
        synchronized(cacheLock) {
          val activePart = activeDownload.get()?.let { if (!it.cancelled.get()) it.partName else null }
          val dir = updatesDir()
          dir.listFiles()?.forEach { child ->
            val keepApk = keepFileName != null && child.name == keepFileName
            val keepPart = activePart != null && child.name == activePart
            if (!keepApk && !keepPart) {
              child.delete()
            }
          }
        }
        promise.resolve(true)
      } catch (_: Exception) {
        promise.resolve(false)
      }
    }
  }

  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  private class CancelledException : Exception()
  private class InsufficientStorageException(message: String) : Exception(message)
}
