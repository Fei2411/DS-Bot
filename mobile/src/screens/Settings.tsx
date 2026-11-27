import { useCallback, useEffect, useState } from 'react'
import { AppState, PermissionsAndroid, Platform, ScrollView, Switch } from 'react-native'
import { useTeam } from '../team/context.tsx'
import { useAppUpdate } from '../team/app-update-store.ts'
import { androidNotificationStatus, readNotifyPrefsFromRecord } from '../team/notifications.ts'
import { areSystemNotificationsEnabled } from '../team/notifications-native'
import { t, getLang, setLang } from '../ui/i18n.ts'
import { onPrefsChange, readPrefs, writePrefs } from '../store.ts'
import { enterMode } from './chat/enter-key.ts'
import { useTheme } from '../ui/tokens.ts'
import { SettingsChoice as Choice, SettingsRow as Row, SettingsSection as Section } from './settings-primitives.tsx'

export function Settings({ navigation }: { navigation?: any }) {
  const { p } = useTheme()
  const { computer } = useTeam()
  const appUpdate = useAppUpdate()
  const [prefs, setPrefs] = useState<Record<string, string>>({})
  const [, bump] = useState(0)
  const androidSdk = Platform.OS === 'android' ? Number(Platform.Version) : 0
  const [notifAllowed, setNotifAllowed] = useState<boolean | undefined>(undefined)
  const [systemNotifEnabled, setSystemNotifEnabled] = useState<boolean | undefined>(undefined)
  const refreshNotif = useCallback(() => {
    if (Platform.OS !== 'android') return
    if (androidSdk >= 33) {
      void PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).then(setNotifAllowed, () => {})
    } else {
      setNotifAllowed(true)
    }
    void areSystemNotificationsEnabled().then(setSystemNotifEnabled, () => {})
  }, [androidSdk])
  useEffect(() => {
    const load = () => void readPrefs().then(setPrefs)
    load()
    refreshNotif()
    const offPrefs = onPrefsChange(load)
    const offFocus = typeof navigation?.addListener === 'function' ? navigation.addListener('focus', refreshNotif) : undefined
    if (Platform.OS !== 'android') return () => { offPrefs(); offFocus?.() }
    const sub = AppState.addEventListener('change', next => { if (next === 'active') refreshNotif() })
    return () => { offPrefs(); offFocus?.(); sub.remove() }
  }, [navigation, refreshNotif])
  const set = (key: string, value: string) => { const next = { ...prefs, [key]: value }; setPrefs(next); void writePrefs({ [key]: value }) }
  const theme = prefs.theme ?? 'system'
  const lang = getLang()
  const notifyPrefs = readNotifyPrefsFromRecord(prefs)
  const permStatus = Platform.OS === 'android' ? androidNotificationStatus(androidSdk, notifAllowed, systemNotifEnabled) : undefined
  const notifSummary = (() => {
    if (!notifyPrefs.enabled) return t('Off')
    if (Platform.OS === 'android') {
      if (permStatus === 'Allow' || permStatus === 'Off') return t(permStatus)
      if (notifyPrefs.bgMode === 'instant') return t('Instant')
      if (notifyPrefs.bgMode === 'periodic') return t('Periodic')
      return t('On')
    }
    return notifyPrefs.banners ? t('On') : t('Off')
  })()
  const updateSummary = (() => {
    if (appUpdate.phase === 'ready') return t('Ready to install')
    if (appUpdate.phase === 'downloading') {
      const pct = appUpdate.progress >= 0 ? Math.round(appUpdate.progress * 100) : null
      return pct !== null ? t('Downloading {pct}%', { pct }) : t('Downloading…')
    }
    if (appUpdate.hasUpdate && appUpdate.release) return t('{version} available', { version: appUpdate.release.version })
    return `v${appUpdate.currentVersion}`
  })()
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      <Section label={t('Phone')}>
        <Row label={t('Computers')} value={computer?.name ?? ''} onPress={() => navigation?.navigate('Computers')} />
        <Choice label={t('Appearance')} value={theme as 'system' | 'light' | 'dark'} onPick={next => set('theme', next)}
          options={[{ id: 'system', label: t('System') }, { id: 'light', label: t('Light') }, { id: 'dark', label: t('Dark') }]} />
        <Choice label={t('Language')} value={lang as 'system' | 'zh' | 'en' | 'ru'} onPick={next => { set('lang', next); setLang(next); bump(v => v + 1) }}
          options={[{ id: 'system', label: t('Follow system') }, { id: 'zh', label: '简体中文' }, { id: 'ru', label: 'Русский' }, { id: 'en', label: 'English' }]} />
        {Platform.OS === 'android' ? (
          <>
            <Row
              label={t('Notifications')}
              value={notifSummary}
              valueColor={(permStatus === 'Allow' || permStatus === 'Off') && notifyPrefs.enabled ? p.danger : undefined}
              onPress={() => navigation?.navigate('NotificationsSettings')}
            />
            <Row
              label={t('App update')}
              value={updateSummary}
              valueColor={appUpdate.hasUpdate || appUpdate.phase === 'ready' ? p.accent : undefined}
              onPress={() => navigation?.navigate('AppUpdate')}
            />
          </>
        ) : (
          <Row
            label={t('In-app banners')}
            end={<Switch value={notifyPrefs.banners} onValueChange={on => set('banners', on ? 'on' : 'off')} trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />}
          />
        )}
        <Choice label={t('Enter sends message')} value={enterMode(prefs, Platform.OS)} onPick={next => set('enterToSend', next)}
          options={[{ id: 'follow', label: t('Follow computer') }, { id: 'send', label: t('Always send') }, { id: 'newline', label: t('Always newline') }]} />
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
