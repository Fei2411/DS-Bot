package io.github.fei2411.dsbot.system

import androidx.core.content.FileProvider

/** Dedicated FileProvider for verified APK updates in cacheDir/updates/. */
class ApkFileProvider : FileProvider()
