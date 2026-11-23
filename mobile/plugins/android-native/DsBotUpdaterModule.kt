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

  private val executor = Executors.newSingleThreadExecutor()
  private val cancelFlag = AtomicBoolean(false)
  private val activeConn = AtomicReference<HttpURLConnection?>(null)
  private val downloading = AtomicBoolean(false)

  override fun getName(): String = NAME

  override fun invalidate() {
    cancelFlag.set(true)
    try { activeConn.get()?.disconnect() } catch (_: Exception) {}
    executor.shutdownNow()
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

  private fun emitProgress(bytesWritten: Long, totalBytes: Long) {
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

  private fun openFollowingRedirects(initialUrl: String): HttpURLConnection {
    var currentUrl = initialUrl
    for (hop in 0..MAX_REDIRECTS) {
      if (cancelFlag.get()) throw CancelledException()
      if (!isAllowedDownloadUrl(currentUrl)) throw SecurityException("Only HTTPS update URLs are allowed")
      val conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = 20_000
        readTimeout = 30_000
        requestMethod = "GET"
        setRequestProperty("User-Agent", "DS-Bot-Android/${BuildConfig.VERSION_NAME}")
        setRequestProperty("Accept", "application/vnd.android.package-archive, application/octet-stream, */*")
      }
      activeConn.set(conn)
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
    executor.execute {
      try {
        val dir = updatesDir().canonicalFile
        val target = File(dir, fileName).canonicalFile
        if (target.parentFile != dir || !target.isFile) {
          promise.resolve(null)
          return@execute
        }
        val actual = sha256OfFile(target)
        if (!safeCompareHex(actual, expectedSha256)) {
          target.delete()
          promise.resolve(null)
          return@execute
        }
        val res = Arguments.createMap().apply {
          putString("path", target.absolutePath)
          putDouble("size", target.length().toDouble())
          putString("sha256", actual)
        }
        promise.resolve(res)
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
    if (!downloading.compareAndSet(false, true)) {
      promise.reject("ALREADY_DOWNLOADING", "An update download is already in progress")
      return
    }
    cancelFlag.set(false)
    executor.execute {
      val dir = updatesDir().canonicalFile
      val finalFile = File(dir, fileName).canonicalFile
      val partFile = File(dir, "$fileName.part").canonicalFile
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

        conn = openFollowingRedirects(url)
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

        emitProgress(0L, contentLength)
        conn.inputStream.use { input ->
          FileOutputStream(partFile).use { output ->
            while (true) {
              if (cancelFlag.get()) throw CancelledException()
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
                emitProgress(written, contentLength)
              }
            }
            if (cancelFlag.get()) throw CancelledException()
            output.fd.sync()
          }
        }
        if (cancelFlag.get()) throw CancelledException()
        emitProgress(written, if (contentLength > 0L) contentLength else written)

        val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
        if (!safeCompareHex(actualSha, expectedSha256)) {
          partFile.delete()
          promise.reject("CHECKSUM_MISMATCH", "Downloaded APK SHA-256 verification failed")
          return@execute
        }

        // Remove older APKs and atomically place the verified APK.
        dir.listFiles()?.forEach { child ->
          if (child.canonicalFile != partFile && child.canonicalFile != finalFile) {
            child.delete()
          }
        }
        if (finalFile.exists()) finalFile.delete()
        if (!partFile.renameTo(finalFile)) {
          partFile.copyTo(finalFile, overwrite = true)
          partFile.delete()
        }

        val result = Arguments.createMap().apply {
          putString("path", finalFile.absolutePath)
          putDouble("size", finalFile.length().toDouble())
          putString("sha256", actualSha)
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
        if (cancelFlag.get()) {
          promise.reject("CANCELLED", "Download cancelled")
        } else {
          promise.reject("DOWNLOAD_FAILED", error.message ?: "Download failed", error)
        }
      } finally {
        activeConn.set(null)
        try { conn?.disconnect() } catch (_: Exception) {}
        downloading.set(false)
      }
    }
  }

  @ReactMethod
  fun cancelDownload(promise: Promise) {
    cancelFlag.set(true)
    try { activeConn.get()?.disconnect() } catch (_: Exception) {}
    promise.resolve(true)
  }

  @ReactMethod
  fun installApk(filePath: String, expectedSha256: String, promise: Promise) {
    if (!SHA256_HEX.matches(expectedSha256)) {
      promise.reject("INVALID_CHECKSUM", "Expected SHA-256 checksum is required")
      return
    }
    executor.execute {
      try {
        val ctx = reactApplicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
          promise.reject("INSTALL_PERMISSION_REQUIRED", "Install unknown apps permission is required")
          return@execute
        }
        val dir = updatesDir().canonicalFile
        val apkFile = File(filePath).canonicalFile
        if (apkFile.parentFile != dir || !apkFile.name.endsWith(".apk") || !apkFile.isFile) {
          promise.reject("INVALID_APK_PATH", "APK file is not in the update cache")
          return@execute
        }
        val actualSha = sha256OfFile(apkFile)
        if (!safeCompareHex(actualSha, expectedSha256)) {
          apkFile.delete()
          promise.reject("CHECKSUM_MISMATCH", "Cached APK failed SHA-256 verification")
          return@execute
        }
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
    executor.execute {
      try {
        val dir = updatesDir()
        dir.listFiles()?.forEach { child ->
          if (keepFileName == null || child.name != keepFileName) {
            child.delete()
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
