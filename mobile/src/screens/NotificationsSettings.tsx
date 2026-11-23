import { Children, Fragment, useCallback, useEffect, useState } from 'react'
import { AppState, Linking, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useInSheet } from '../nav/sheet.tsx'
import { readPrefs, writePrefs } from '../store.ts'
import { useTeam } from '../team/context.tsx'
import { applyBackgroundDeliveryPrefs, sendTestNotification } from '../team/notification-bridge.ts'
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
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons.tsx'
import { radius, shadow, type as typeScale, useTheme } from '../ui/tokens.ts'

function Screen({ children }: { children: React.ReactNode }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  const inSheet = useInSheet()
  return <View style={{ flex: 1, backgroundColor: p.main, paddingTop: inSheet ? 0 : insets.top }}>{children}</View>
}

function Back({ title, onBack }: { title: string; onBack: () => void }) {
  const { p } = useTheme()
  return (
    <View style={styles.backRow}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={onBack} hitSlop={8} style={styles.backBtn}>
        <ChevronLeftIcon size={20} color={p.ink2} />
      </Pressable>
      <Text style={[typeScale.rowName, { color: p.ink, flex: 1, textAlign: 'center' }]}>{title}</Text>
      <View style={styles.backBtn} />
    </View>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const { p } = useTheme()
  const items = Children.toArray(children).filter(Boolean)
  if (items.length === 0) return null
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={[typeScale.caption, { color: p.ink3, paddingHorizontal: 18, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6, fontSize: 11 }]}>{label}</Text>
      <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
        {items.map((child, i) => (
          <Fragment key={i}>
            {i > 0 ? <View style={[styles.divider, { backgroundColor: p.line }]} /> : null}
            {child}
          </Fragment>
        ))}
      </View>
    </View>
  )
}

function Row({ label, value, valueColor, onPress, end }: { label: string; value?: string; valueColor?: string; onPress?: () => void; end?: React.ReactNode }) {
  const { p } = useTheme()
  const body = (
    <View style={styles.row}>
      <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1, minWidth: 96 }]}>{label}</Text>
      {value !== undefined ? (
        <Text style={[typeScale.settingsRow, { color: valueColor ?? p.ink2, flexShrink: 1, maxWidth: '52%', textAlign: 'right' }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {end}
      {onPress ? <View style={{ flexShrink: 0 }}><ChevronRightIcon size={16} color={p.ink3} /></View> : null}
    </View>
  )
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed ? { backgroundColor: p.hover } : null}>{body}</Pressable> : body
}

function Choice<T extends string>({ label, options, value, onPick }: { label: string; options: { id: T; label: string }[]; value: T; onPick: (id: T) => void }) {
  const { p } = useTheme()
  return (
    <View style={styles.choice}>
      <Text style={[typeScale.settingsRow, { color: p.ink }]}>{label}</Text>
      <View style={[styles.segments, { backgroundColor: p.hover }]} accessibilityRole="radiogroup">
        {options.map(option => {
          const on = option.id === value
          return (
            <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onPick(option.id)}
              style={[styles.segment, on && [{ backgroundColor: p.card }, shadow(1)]]}>
              <Text style={[typeScale.small, { color: on ? p.ink : p.ink2, fontWeight: on ? '600' : '400', textAlign: 'center' }]} numberOfLines={1}>{option.label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

export function NotificationsSettings({ navigation }: any) {
  const { p } = useTheme()
  const { computer, call, hello } = useTeam()
  const [rawPrefs, setRawPrefs] = useState<Record<string, string>>({})
  const [granted, setGranted] = useState(false)
  const [bgStatus, setBgStatus] = useState<BackgroundStatus | null>(null)
  const [testSent, setTestSent] = useState<boolean | null>(null)
  const [pickingDistributor, setPickingDistributor] = useState(false)
  const androidSdk = Platform.OS === 'android' ? Number(Platform.Version) : 0

  const refreshStatus = useCallback(() => {
    if (Platform.OS !== 'android') return
    if (androidSdk >= 33) {
      void PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).then(setGranted, () => {})
    } else {
      setGranted(true)
    }
    void getBackgroundStatus().then(setBgStatus)
  }, [androidSdk])

  useEffect(() => {
    void readPrefs().then(setRawPrefs)
    refreshStatus()
    if (Platform.OS !== 'android') return
    const sub = AppState.addEventListener('change', next => { if (next === 'active') refreshStatus() })
    const offUp = onUnifiedPushEvent(() => refreshStatus())
    return () => { sub.remove(); offUp() }
  }, [refreshStatus])

  const prefs = readNotifyPrefsFromRecord(rawPrefs)
  const updatePref = async (patch: Record<string, string>, syncBg = false) => {
    const next = { ...rawPrefs, ...patch }
    setRawPrefs(next)
    await writePrefs(patch)
    if (syncBg) {
      await applyBackgroundDeliveryPrefs(computer?.name)
      refreshStatus()
    }
  }

  const requestOrOpenPermission = async () => {
    if (Platform.OS !== 'android') return
    if (androidSdk >= 33 && !granted) {
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
    void updatePref({ notifyBgMode: mode }, true)
  }

  const pickDistributor = async (pkg: string) => {
    setPickingDistributor(false)
    await registerUnifiedPush(pkg).catch(() => {})
    setTimeout(refreshStatus, 400)
  }

  const disableUnifiedPush = async () => {
    setPickingDistributor(false)
    await unregisterUnifiedPush()
    if (hello?.capabilities?.includes('push-register')) {
      void call('push-unregister', {}).catch(() => {})
    }
    refreshStatus()
  }

  const runTest = async () => {
    const ok = await sendTestNotification(computer?.hostDeviceId ?? '')
    setTestSent(ok)
    setTimeout(() => setTestSent(null), 2500)
  }

  const permLabel = androidNotificationStatus(androidSdk, granted, bgStatus?.notificationsEnabled)
  const distributors = bgStatus?.unifiedPushDistributors ?? []
  const activeDist = distributors.find(d => d.packageName === bgStatus?.unifiedPushDistributor)
  const pushSupportedByHost = hello?.capabilities?.includes('push-register') === true

  const upStatusText = bgStatus?.unifiedPushEndpoint
    ? (activeDist?.label ?? t('Active'))
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
          <Row
            label={t('In-app banners')}
            end={<Switch value={prefs.banners} onValueChange={on => void updatePref({ banners: on ? 'on' : 'off' })} trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />}
          />
        </Section>

        {Platform.OS === 'android' ? (
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
              valueColor={bgStatus?.unifiedPushEndpoint ? p.green : bgStatus?.unifiedPushError ? p.danger : p.ink2}
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
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  card: { marginHorizontal: 14, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', ...shadow(1) },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, minHeight: 50, gap: 10 },
  choice: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  segments: { flexDirection: 'row', borderRadius: 9, padding: 2 },
  segment: { flex: 1, minHeight: 34, paddingVertical: 5, borderRadius: 7, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  distBox: { paddingVertical: 4 },
  distRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 44, gap: 8 },
  noteRow: { paddingHorizontal: 16, paddingVertical: 10 },
})
