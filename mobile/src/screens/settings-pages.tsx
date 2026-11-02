import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons.tsx'
import { radius, shadow, type as typeScale, useTheme } from '../ui/tokens.ts'

function Screen({ children }: { children: React.ReactNode }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  return <View style={{ flex: 1, backgroundColor: p.main, paddingTop: insets.top }}>{children}</View>
}
function Back({ title, onBack }: { title: string; onBack: () => void }) {
  const { p } = useTheme()
  return (
    <View style={styles.backRow}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={onBack} hitSlop={8} style={styles.backBtn}><ChevronLeftIcon size={20} color={p.ink2} /></Pressable>
      <Text style={[typeScale.rowName, { color: p.ink, flex: 1, textAlign: 'center' }]}>{title}</Text>
      <View style={styles.backBtn} />
    </View>
  )
}
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const { p } = useTheme()
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={[typeScale.caption, { color: p.ink3, paddingHorizontal: 18, marginBottom: 6, fontSize: 11 }]}>{label}</Text>
      <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>{children}</View>
    </View>
  )
}
function Row({ label, hint, value, onPress, end }: { label: string; hint?: string; value?: string; onPress?: () => void; end?: React.ReactNode }) {
  const { p } = useTheme()
  const body = (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={[typeScale.settingsRow, { color: p.ink }]}>{label}</Text>
        {hint ? <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]}>{hint}</Text> : null}
      </View>
      {value !== undefined ? <Text style={[typeScale.settingsRow, { color: p.ink2 }]} numberOfLines={1}>{value}</Text> : null}
      {end}
      {onPress ? <ChevronRightIcon size={16} color={p.ink3} /> : null}
    </View>
  )
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed ? { backgroundColor: p.hover } : null}>{body}</Pressable> : body
}

// ------------------------------------------------------------ Providers

export function Providers({ navigation }: any) {
  const { p } = useTheme()
  const { call } = useTeam()
  const [list, setList] = useState<{ name: string; models?: { name: string }[]; hasKey?: boolean }[]>([])
  const [keyFor, setKeyFor] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const load = () => void call('providers').then(v => setList(v as typeof list)).catch(() => {})
  useState(() => { load(); return null })
  const saveKey = () => { if (!key.trim() || keyFor === null) return; const next = key; setKey(''); void call('provider-key', { provider: keyFor, key: next }).then(() => { setKeyFor(null); load() }, (f: Error) => setError(f.message)) }
  return (
    <Screen>
      <Back title={t('Model providers')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {error ? <Text style={[typeScale.small, { color: p.danger, margin: 18 }]}>{error}</Text> : null}
        {list.map(provider => (
          <Section key={provider.name} label={provider.name}>
            <Row label={provider.hasKey ? t('Key set') : t('No key')} onPress={() => setKeyFor(provider.name)} />
            {(provider.models ?? []).map(m => <Row key={m.name} label={m.name} />)}
          </Section>
        ))}
      </ScrollView>
      {keyFor !== null ? (
        <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line, position: 'absolute', left: 14, right: 14, top: '30%' }]}>
          <View style={styles.row}><Text style={[typeScale.settingsRow, { color: p.ink }]}>{keyFor}</Text></View>
          <View style={styles.row}><TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} value={key} onChangeText={setKey} placeholder={t('Paste or type the key')} placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false} secureTextEntry /></View>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" onPress={() => setKeyFor(null)} style={{ flex: 1, alignItems: 'center' }}><Text style={{ color: p.ink2 }}>{t('Cancel')}</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={saveKey} style={{ flex: 1, alignItems: 'center' }}><Text style={{ color: p.accent, fontWeight: '600' }}>{t('Save')}</Text></Pressable>
          </View>
        </View>
      ) : null}
    </Screen>
  )
}

// ------------------------------------------------------------ Connectors / Capabilities / Usage / Location / Updates / About

export function Connectors({ navigation }: any) {
  const { team } = useTeam()
  const connectors = (team as { connectors?: { name: string; status?: string }[] } | null)?.connectors ?? []
  return (
    <Screen><Back title={t('Connectors')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Connectors')}>
          {connectors.map(item => <Row key={item.name} label={item.name} hint={item.status} />)}
          {connectors.length === 0 ? <Row label={t('Nothing saved yet')} /> : null}
        </Section>
      </ScrollView>
    </Screen>
  )
}

export function Capabilities({ navigation }: any) {
  const { team } = useTeam()
  const items = (team as { capabilities?: { name: string; status?: string }[] } | null)?.capabilities ?? []
  return (
    <Screen><Back title={t('Capabilities')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Capabilities')}>
          {items.map(item => <Row key={item.name} label={item.name} hint={item.status} />)}
          {items.length === 0 ? <Row label={t('Nothing saved yet')} /> : null}
        </Section>
      </ScrollView>
    </Screen>
  )
}

export function TeamUsage({ navigation }: any) {
  const { p } = useTheme()
  const { call } = useTeam()
  const [view, setView] = useState<{ total?: { input: number; output: number }; bots?: { name: string; input: number; output: number }[]; models?: { name: string; input: number; output: number }[] } | null>(null)
  useState(() => { void call('usage', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).then(v => setView(v as typeof view)).catch(() => {}); return null })
  const fmt = (n?: number) => n === undefined ? '—' : n.toLocaleString()
  return (
    <Screen><Back title={t('Usage')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Usage')}>
          <Row label={t('Tokens in')} value={fmt(view?.total?.input)} />
          <Row label={t('Tokens out')} value={fmt(view?.total?.output)} />
        </Section>
        <Section label={t('Bots')}>
          {(view?.bots ?? []).map(item => <Row key={item.name} label={item.name} value={fmt(item.input + item.output)} />)}
        </Section>
        <Section label={t('Models')}>
          {(view?.models ?? []).map(item => <Row key={item.name} label={item.name} value={fmt(item.input + item.output)} />)}
        </Section>
      </ScrollView>
    </Screen>
  )
}

export function Location({ navigation }: any) {
  const { team } = useTeam()
  const workspace = (team as { workspace?: string } | null)?.workspace ?? ''
  return (
    <Screen><Back title={t('Location')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Location')}>
          <Row label={t('Team workspace')} value={workspace} onPress={() => navigation.navigate('Folder', { current: workspace, onPick: 'team' })} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

export function Updates({ navigation }: any) {
  const { p } = useTheme()
  const { call } = useTeam()
  const [status, setStatus] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const check = () => { setChecking(true); void call('update-check').then(v => setStatus((v as { latest?: string; available?: boolean })?.latest ? `v${(v as { latest: string }).latest}` : t('Up to date'))).catch(() => setStatus(t('Could not check'))).finally(() => setChecking(false)) }
  return (
    <Screen><Back title={t('Updates & diagnostics')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Updates')}>
          <Row label={t('Status')} value={status ?? '—'} />
          <Row label={t('Check for updates')} onPress={check} />
        </Section>
        <Section label={t('Diagnostics')}>
          <Row label={t('Diagnostics log')} onPress={() => navigation.navigate('Placeholder', { title: t('Diagnostics log') })} />
          <Row label={t('Clear diagnostics')} onPress={() => void call('diagnostics-clear')} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

export function About({ navigation }: any) {
  const { team, computer } = useTeam()
  const version = (team as { version?: string } | null)?.version ?? '—'
  return (
    <Screen><Back title={t('About')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('About')}>
          <Row label={t('DS Bot')} value={version} />
          <Row label={t('Computer')} value={computer?.name ?? '—'} />
          <Row label={t('Licenses')} onPress={() => navigation.navigate('Placeholder', { title: t('Licenses') })} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  card: { marginHorizontal: 14, borderRadius: radius.card, borderWidth: 1, overflow: 'hidden', ...shadow(1) },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 50, gap: 8 },
})
