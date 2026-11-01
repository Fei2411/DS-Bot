import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Constants from 'expo-constants'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { themeLabel, type as typeScale, radius, useTheme } from '../ui/tokens.ts'

export function Settings({ onForget }: { onForget: () => void }) {
  const { team, online, error, computer } = useTeam()
  const { p } = useTheme()
  const [confirm, setConfirm] = useState(false)
  const version = Constants.expoConfig?.version ?? '0.1.0'

  return (
    <ScrollView style={{ flex: 1, backgroundColor: p.main }} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={[typeScale.small, { color: p.ink2, fontWeight: '600', marginHorizontal: 20, marginTop: 20, marginBottom: 8 }]}>{t('Computer').toUpperCase()}</Text>
      <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
        <View style={styles.row}><Text style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]}>{computer?.name || computer?.hostDeviceId || '—'}</Text></View>
        <View style={[styles.row, styles.sep, { borderTopColor: p.line }]}>
          <Text style={[typeScale.settingsRow, { color: online ? p.green : p.ink2 }]}>{online ? t('Connected') : t('Not connected')}</Text>
        </View>
        {error ? <View style={[styles.row, styles.sep, { borderTopColor: p.line }]}><Text style={[typeScale.small, { color: p.danger }]}>{error}</Text></View> : null}
        <Pressable accessibilityRole="button" onPress={() => { if (confirm) { setConfirm(false); onForget() } else setConfirm(true) }}
          style={[styles.row, styles.sep, { borderTopColor: p.line }]}>
          <Text style={[typeScale.settingsRow, { color: p.danger }]}>{confirm ? t('Tap again to forget') : t('Forget this computer')}</Text>
        </Pressable>
      </View>
      <Text style={[typeScale.small, { color: p.ink2, fontWeight: '600', marginHorizontal: 20, marginTop: 24, marginBottom: 8 }]}>{t('Appearance').toUpperCase()}</Text>
      <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
        <View style={styles.row}>
          <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]}>{t('Theme')}</Text>
          <Text style={[typeScale.settingsRow, { color: p.ink2 }]}>{themeLabel(team?.prefs?.theme)}</Text>
        </View>
      </View>
      <Text style={[typeScale.caption, { color: p.ink3, textAlign: 'center', marginTop: 32 }]}>DS Bot {version}</Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, borderRadius: radius.card, borderWidth: 1, overflow: 'hidden' },
  row: { paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  sep: { borderTopWidth: StyleSheet.hairlineWidth },
})
