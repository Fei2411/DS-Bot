import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { readPrefs, writePrefs } from '../store.ts'
import { useTeam } from '../team/context.tsx'
import {
  applyBackgroundDeliveryPrefs,
  getHostPushSyncState,
  resetHostPushSyncState,
  sendTestNotification,
  subscribeHostPushSyncState,
  unregisterHostPushEndpoint,
} from '../team/notification-bridge.ts'
import { androidNotificationStatus, readNotifyPrefsFromRecord, type BackgroundDeliveryMode } from '../team/notifications.ts'
import {
  getBackgroundStatus,
  onUnifiedPushEvent,
  openNotificationChannelSettings,
  registerUnifiedPush,
  requestIgnoreBatteryOptimizations,
  unregisterUnifiedPush,
  type BackgroundStatus,
} from '../team/notifications-native'
import { t } from '../ui/i18n.ts'
import { type as typeScale, useTheme } from '../ui/tokens.ts'
import {
  SettingsBack as Back,
  SettingsChoice as Choice,
  SettingsRow as Row,
  SettingsScreen as Screen,
  SettingsSection as Section,
} from './settings-primitives.tsx'

export function NotificationsSettings({ navigation }: any) {
  const { p } = useTheme()
  const { computer, call, hello, online } = useTeam()
  const [rawPrefs, setRawPrefs] = useState<Record<string, string>>({})
  const [granted, setGranted] = useState<boolean | undefined>(undefined)
  const [bgStatus, setBgStatus] = useState<BackgroundStatus | null>(null)
  const [testSent, setTestSent] = useState<boolean | null>(null)
  const [pickingDistributor, setPickingDistributor] = useState(false)
  const [, bumpPushSync] = useState(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const androidSdk = Platform.OS === 'android' ? Number(Platform.Version) : 0

  useEffect(() => () => {
    for (const id of timersRef.current) clearTimeout(id)
    timersRef.current = []
  }, [])

  const prevAllowedRef = useRef<boolean | undefined>(undefined)

  const refreshStatus = useCallback((syncIfGranted = false) => {
    if (Platform.OS !== 'android') return
    const checkGranted = androidSdk >= 33
      ? PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => undefined)
      : Promise.resolve(true)
    void Promise.all([checkGranted, getBackgroundStatus()]).then(([nextGranted, nextBg]) => {
      if (nextGranted !== undefined) setGranted(nextGranted)
      setBgStatus(nextBg)
      const nowAllowed = nextGranted === true && nextBg?.notificationsEnabled !== false
      if (syncIfGranted && prevAllowedRef.current === false && nowAllowed) {
        void applyBackgroundDeliveryPrefs(computer?.name)
      }
      if (nextGranted !== undefined) prevAllowedRef.current = nowAllowed
    })
  }, [androidSdk, computer?.name])

  useEffect(() => {
    void readPrefs().then(setRawPrefs)
    refreshStatus()
    if (Platform.OS !== 'android') return
    const sub = AppState.addEventListener('change', next => { if (next === 'active') refreshStatus(true) })
    const offUp = onUnifiedPushEvent(() => refreshStatus())
    const offSync = subscribeHostPushSyncState(() => bumpPushSync(n => n + 1))
    return () => { sub.remove(); offUp(); offSync() }
  }, [refreshStatus])

  const prefs = readNotifyPrefsFromRecord(rawPrefs)
  const updatePref = async (patch: Record<string, string>, syncBg = false) => {
    setRawPrefs(prev => ({ ...prev, ...patch }))
    await writePrefs(patch)
    if (syncBg) {
      await applyBackgroundDeliveryPrefs(computer?.name)
      refreshStatus()
    }
  }

  const requestOrOpenPermission = async () => {
    if (Platform.OS !== 'android') return
    if (androidSdk >= 33 && granted !== true) {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => null)
      if (result === PermissionsAndroid.RESULTS.GRANTED) {
        setGranted(true)
        await applyBackgroundDeliveryPrefs(computer?.name)
        refreshStatus()
        return
      }
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        await openNotificationChannelSettings(null)
        return
      }
      refreshStatus()
      return
    }
    await openNotificationChannelSettings(null).catch(() => Linking.openSettings())
  }

  const pickBgMode = (mode: BackgroundDeliveryMode) => {
    void (async () => {
      if ((mode === 'periodic' || mode === 'instant') && (granted === false || bgStatus?.notificationsEnabled === false)) {
        await requestOrOpenPermission()
      }
      await updatePref({ notifyBgMode: mode }, true)
    })()
  }

  const pickDistributor = async (pkg: string) => {
    setPickingDistributor(false)
    resetHostPushSyncState()
    await registerUnifiedPush(pkg).catch(() => {})
    timersRef.current.push(setTimeout(refreshStatus, 400))
  }

  const disableUnifiedPush = async () => {
    setPickingDistributor(false)
    await unregisterUnifiedPush()
    if (hello?.capabilities?.includes('push-register')) {
      void unregisterHostPushEndpoint(computer?.hostDeviceId ?? '', call)
    }
    refreshStatus()
  }

  const runTest = async () => {
    const ok = await sendTestNotification(computer?.hostDeviceId ?? '')
    setTestSent(ok)
    timersRef.current.push(setTimeout(() => setTestSent(null), 2500))
  }

  const permLabel = androidNotificationStatus(androidSdk, granted, bgStatus?.notificationsEnabled)
  const distributors = bgStatus?.unifiedPushDistributors ?? []
  const activeDist = distributors.find(d => d.packageName === bgStatus?.unifiedPushDistributor)
  const pushSupportedByHost = hello?.capabilities?.includes('push-register') === true
  const hostSyncState = getHostPushSyncState(computer?.hostDeviceId)
  const upSynced = Boolean(bgStatus?.unifiedPushEndpoint) && online && pushSupportedByHost && hostSyncState === 'synced'

  const upStatusText = bgStatus?.unifiedPushEndpoint
    ? (hostSyncState === 'failed'
        ? t('Failed')
        : upSynced
          ? (activeDist?.label ?? t('Active'))
          : t('Pending sync'))
    : bgStatus?.unifiedPushError
      ? t('Failed')
      : bgStatus?.unifiedPushDistributor
        ? t('Connecting…')
        : distributors.length === 0
          ? t('Not installed')
          : t('Off')

  return (
    <Screen>
      <Back title={t('Notifications')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {Platform.OS === 'android' ? (
          <Section label={t('System permission')}>
            <Row
              label={t('System notifications')}
              value={permLabel !== undefined ? t(permLabel) : undefined}
              valueColor={permLabel === 'Allowed' ? p.green : permLabel === 'Off' || permLabel === 'Allow' ? p.danger : p.ink2}
              onPress={() => void requestOrOpenPermission()}
            />
            <Row label={t('Needs you channel')} onPress={() => void openNotificationChannelSettings('needs_you')} />
            <Row label={t('Replies channel')} onPress={() => void openNotificationChannelSettings('replies')} />
          </Section>
        ) : null}

        <Section label={t('Alerts')}>
          {Platform.OS === 'android' ? (
            <>
              <Row
                label={t('Notifications')}
                end={<Switch value={prefs.enabled} onValueChange={on => void updatePref({ notifyEnabled: on ? 'on' : 'off' }, true)} trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />}
              />
              {prefs.enabled ? (
                <>
                  <Row
                    label={t('Needs you')}
                    end={<Switch value={prefs.needsYou} onValueChange={on => void updatePref({ notifyNeedsYou: on ? 'on' : 'off' })} trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />}
                  />
                  <Row
                    label={t('Replies & completions')}
                    end={<Switch value={prefs.replies} onValueChange={on => void updatePref({ notifyReplies: on ? 'on' : 'off' })} trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />}
                  />
                  <Row
                    label={t('Group messages')}
                    end={<Switch value={prefs.groups} onValueChange={on => void updatePref({ notifyGroups: on ? 'on' : 'off' })} trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />}
                  />
                  <Row
                    label={t('Show message preview')}
                    end={<Switch value={prefs.preview} onValueChange={on => void updatePref({ notifyPreview: on ? 'on' : 'off' })} trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />}
                  />
                </>
              ) : null}
            </>
          ) : null}
          <Row
            label={t('In-app banners')}
            end={<Switch value={prefs.banners} onValueChange={on => void updatePref({ banners: on ? 'on' : 'off' })} trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />}
          />
        </Section>

        {Platform.OS === 'android' && prefs.enabled ? (
          <Section label={t('Background delivery')}>
            <Choice<BackgroundDeliveryMode>
              label={t('Background mode')}
              value={prefs.bgMode}
              onPick={pickBgMode}
              options={[
                { id: 'off', label: t('Off') },
                { id: 'periodic', label: t('Periodic') },
                { id: 'instant', label: t('Instant') },
              ]}
            />
            <Row
              label={t('Unrestricted battery')}
              value={bgStatus?.ignoringBattery ? t('Allowed') : t('Allow')}
              valueColor={bgStatus?.ignoringBattery ? p.green : p.ink2}
              onPress={() => void requestIgnoreBatteryOptimizations()}
            />
            <Row
              label={t('Offline push (UnifiedPush)')}
              value={upStatusText}
              valueColor={upSynced ? p.green : (bgStatus?.unifiedPushError || hostSyncState === 'failed') ? p.danger : p.ink2}
              onPress={distributors.length > 0 || bgStatus?.unifiedPushDistributor ? () => setPickingDistributor(open => !open) : undefined}
            />
            {pickingDistributor ? (
              <View style={styles.distBox}>
                {distributors.map(dist => (
                  <Pressable
                    key={dist.packageName}
                    accessibilityRole="button"
                    onPress={() => void pickDistributor(dist.packageName)}
                    style={({ pressed }) => [styles.distRow, pressed && { backgroundColor: p.hover }]}>
                    <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]}>{dist.label}</Text>
                    {bgStatus?.unifiedPushDistributor === dist.packageName ? (
                      <Text style={[typeScale.small, { color: p.accent, fontWeight: '600' }]}>{t('Selected')}</Text>
                    ) : null}
                  </Pressable>
                ))}
                {bgStatus?.unifiedPushDistributor ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void disableUnifiedPush()}
                    style={({ pressed }) => [styles.distRow, pressed && { backgroundColor: p.hover }]}>
                    <Text style={[typeScale.settingsRow, { color: p.danger }]}>{t('Turn off offline push')}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {!pushSupportedByHost && bgStatus?.unifiedPushEndpoint ? (
              <View style={styles.noteRow}>
                <Text style={[typeScale.small, { color: p.star }]}>{t('Update DS Bot on the computer to enable offline push.')}</Text>
              </View>
            ) : null}
            <Row
              label={t('Send test notification')}
              value={testSent === true ? t('Sent') : testSent === false ? t('Blocked') : undefined}
              valueColor={testSent === true ? p.green : testSent === false ? p.danger : p.ink2}
              onPress={() => void runTest()}
            />
          </Section>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  distBox: { paddingVertical: 4 },
  distRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 44, gap: 8 },
  noteRow: { paddingHorizontal: 16, paddingVertical: 10 },
})
