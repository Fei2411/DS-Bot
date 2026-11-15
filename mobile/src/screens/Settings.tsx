import { Children, Fragment, useCallback, useEffect, useState } from 'react'
import { AppState, Linking, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useTeam } from '../team/context.tsx'
import { androidNotificationStatus } from '../team/notifications.ts'
import { t, getLang, setLang } from '../ui/i18n.ts'
import { ChevronRightIcon } from '../ui/icons.tsx'
import { readPrefs, writePrefs } from '../store.ts'
import { radius, shadow, type as typeScale, useTheme } from '../ui/tokens.ts'

function Row({ label, value, onPress, end }: { label: string; value?: string; onPress?: () => void; end?: React.ReactNode }) {
  const { p } = useTheme()
  const body = (
    <View style={styles.row}>
      <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1, minWidth: 96 }]}>{label}</Text>
      {value !== undefined ? <Text style={[typeScale.settingsRow, { color: p.ink2, flexShrink: 1, maxWidth: '52%', textAlign: 'right' }]} numberOfLines={1}>{value}</Text> : null}
      {end}
      {onPress ? <View style={{ flexShrink: 0 }}><ChevronRightIcon size={16} color={p.ink3} /></View> : null}
    </View>
  )
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed ? { backgroundColor: p.hover } : null}>{body}</Pressable> : body
}

// A choice of a few values, all in view: the iOS segmented control's shape.
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

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const { p } = useTheme()
  const items = Children.toArray(children).filter(Boolean)
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

export function Settings({ navigation }: { navigation?: any }) {
  const { p } = useTheme()
  const { team, computer } = useTeam()
  const [prefs, setPrefs] = useState<Record<string, string>>({})
  const [, bump] = useState(0)
  const androidSdk = Platform.OS === 'android' ? Number(Platform.Version) : 0
  const [notifAllowed, setNotifAllowed] = useState(false)
  const refreshNotif = useCallback(() => {
    if (Platform.OS !== 'android' || androidSdk < 33) return
    void PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).then(setNotifAllowed, () => {})
  }, [androidSdk])
  useEffect(() => {
    void readPrefs().then(setPrefs)
    refreshNotif()
    if (Platform.OS !== 'android') return
    const sub = AppState.addEventListener('change', next => { if (next === 'active') refreshNotif() })
    return () => sub.remove()
  }, [refreshNotif])
  const set = (key: string, value: string) => { const next = { ...prefs, [key]: value }; setPrefs(next); void writePrefs({ [key]: value }) }
  const openNotifications = () => {
    if (Platform.OS !== 'android') return
    if (notifAllowed || androidSdk < 33) { void Linking.openSettings(); return }
    void PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).then(result => {
      if (result === PermissionsAndroid.RESULTS.GRANTED) setNotifAllowed(true)
      else if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) void Linking.openSettings()
    }, () => void Linking.openSettings())
  }
  const theme = prefs.theme ?? 'system'
  const lang = getLang()
  const notifStatus = androidNotificationStatus(androidSdk, notifAllowed)
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      <Section label={t('Phone')}>
        <Row label={t('Computers')} value={computer?.name ?? ''} onPress={() => navigation?.navigate('Computers')} />
        <Choice label={t('Appearance')} value={theme as 'system' | 'light' | 'dark'} onPick={next => set('theme', next)}
          options={[{ id: 'system', label: t('System') }, { id: 'light', label: t('Light') }, { id: 'dark', label: t('Dark') }]} />
        <Choice label={t('Language')} value={lang as 'system' | 'zh' | 'en'} onPick={next => { set('lang', next); setLang(next); bump(v => v + 1) }}
          options={[{ id: 'system', label: t('Follow system') }, { id: 'zh', label: '简体中文' }, { id: 'en', label: 'English' }]} />
        <Row label={t('In-app banners')} end={<Switch value={prefs.banners !== 'off'} onValueChange={on => set('banners', on ? 'on' : 'off')} trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />} />
        {Platform.OS === 'android' ? <Row label={t('Notifications')} value={notifStatus !== undefined ? t(notifStatus) : undefined} onPress={openNotifications} /> : null}
      </Section>
      {/* The desktop settings pages, in the desktop's order. */}
      <Section label={t('Team')}>
        <Row label={t('Models')} onPress={() => navigation?.navigate('Providers')} />
        <Row label={t('Connectors')} onPress={() => navigation?.navigate('Connectors')} />
        <Row label={t('Capabilities')} onPress={() => navigation?.navigate('Capabilities')} />
        <Row label={t('Usage')} onPress={() => navigation?.navigate('TeamUsage')} />
        <Row label={t('Secrets')} onPress={() => navigation?.navigate('Secrets')} />
        <Row label={t('Location')} onPress={() => navigation?.navigate('Location')} />
        <Row label={t('Updates & diagnostics')} onPress={() => navigation?.navigate('Updates')} />
        <Row label={t('About DS Bot')} onPress={() => navigation?.navigate('About')} />
      </Section>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 14, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', ...shadow(1) },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, minHeight: 50, gap: 10 },
  choice: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  segments: { flexDirection: 'row', borderRadius: 9, padding: 2 },
  segment: { flex: 1, minHeight: 34, paddingVertical: 5, borderRadius: 7, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
})
