package io.github.fei2411.dsbot.system

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Registers DS Bot's Android updater and notification native modules via React Native's interop layer. */
class DsBotAndroidPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    when (name) {
      DsBotUpdaterModule.NAME -> DsBotUpdaterModule(reactContext)
      DsBotNotificationsModule.NAME -> DsBotNotificationsModule(reactContext)
      else -> null
    }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      DsBotUpdaterModule.NAME to ReactModuleInfo(
        DsBotUpdaterModule.NAME,
        DsBotUpdaterModule::class.java.name,
        false,
        false,
        false,
        false,
      ),
      DsBotNotificationsModule.NAME to ReactModuleInfo(
        DsBotNotificationsModule.NAME,
        DsBotNotificationsModule::class.java.name,
        false,
        false,
        false,
        false,
      ),
    )
  }
}
