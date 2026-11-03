import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useTeam } from '../team/context.tsx'
import { t, getLang, setLang } from '../ui/i18n.ts'
import { ChevronRightIcon } from '../ui/icons.tsx'
import { readPrefs, writePrefs } from '../store.ts'
import { radius, shadow, type as typeScale, useTheme } from '../ui/tokens.ts'

function Row({ label, value, onPress, end }: { label: string; value?: string; onPress?: () => void; end?: React.ReactNode }) {
  const { p } = useTheme()
  const body = (
    <View style={styles.row}>
      <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]}>{label}</Text>
      {value !== undefined ? <Text style={[typeScale.settingsRow, { color: p.ink2 }]}>{value}</Text> : null}
      {end}
      {onPress ? <ChevronRightIcon size={16} color={p.ink3} /> : null}
    </View>
  )
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed ? { backgroundColor: p.hover } : null}>{body}</Pressable> : body
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const { p } = useTheme()
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={[typeScale.caption, { color: p.ink3, paddingHorizontal: 18, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6, fontSize: 11 }]}>{label}</Text>
      <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>{children}</View>
    </View>
  )
}

export function Settings({ navigation }: { navigation?: any }) {
  const { p } = useTheme()
  const { team, computer } = useTeam()
  const [prefs, setPrefs] = useState<Record<string, string>>({})
  const [, bump] = useState(0)
  useEffect(() => { void readPrefs().then(setPrefs) }, [])
  const set = (key: string, value: string) => { const next = { ...prefs, [key]: value }; setPrefs(next); void writePrefs({ [key]: value }) }
  const theme = prefs.theme ?? 'system'
  const lang = getLang()
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      <Section label={t('Phone')}>
        <Row label={t('Computers')} value={computer?.name ?? ''} onPress={() => navigation?.navigate('Computers')} />
        <Row label={t('Appearance')} value={{ light: t('Light'), dark: t('Dark'), system: t('System') }[theme] ?? t('System')}
          onPress={() => set('theme', theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')} />
        <Row label={t('Language')} value={{ system: t('Follow system'), zh: '简体中文', en: 'English' }[lang] ?? t('Follow system')}
          onPress={() => { const next = lang === 'system' ? 'zh' : lang === 'zh' ? 'en' : 'system'; set('lang', next); setLang(next); bump(v => v + 1) }} />
        <Row label={t('In-app banners')} end={<Switch value={prefs.banners !== 'off'} onValueChange={on => set('banners', on ? 'on' : 'off')} trackColor={{ true: p.accent }} />} />
      </Section>
      <Section label={t('Team')}>
        <Row label={t('Model providers')} onPress={() => navigation?.navigate('Providers')} />
        <Row label={t('Secrets')} onPress={() => navigation?.navigate('Secrets')} />
        <Row label={t('Connectors')} onPress={() => navigation?.navigate('Connectors')} />
        <Row label={t('Capabilities')} onPress={() => navigation?.navigate('Capabilities')} />
        <Row label={t('Usage')} onPress={() => navigation?.navigate('TeamUsage')} />
        <Row label={t('Location')} onPress={() => navigation?.navigate('Location')} />
        <Row label={t('Updates & diagnostics')} onPress={() => navigation?.navigate('Updates')} />
        <Row label={t('About')} onPress={() => navigation?.navigate('About')} />
      </Section>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 14, borderRadius: radius.card, borderWidth: 1, overflow: 'hidden', ...shadow(1) },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 50, gap: 8 },
})
