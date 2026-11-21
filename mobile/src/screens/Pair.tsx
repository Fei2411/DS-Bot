import { PairCamera } from './PairCamera'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { parsePhonePairingInput, parseWebPairingInput } from '../team/pair-input.ts'
import { openLink } from '../connection.ts'
import { addComputer, type PhoneIdentity, type SavedComputer } from '../store.ts'
import { errorText } from '../team/link.ts'
import { t } from '../ui/i18n.ts'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'

export function Pair({ identity, offer, onPaired, onCancel }: { identity: PhoneIdentity; offer?: string | null; onPaired: (computer: SavedComputer) => void; onCancel?: () => void }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  const pair = useCallback(async (uri: string) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try {
      const offer = Platform.OS === 'web' ? parseWebPairingInput(uri) : parsePhonePairingInput(uri)
      const client = await openLink(offer, identity, offer.code)
      await client.close()
      onPaired(await addComputer(offer))
    } catch (failure) { setError(errorText(failure)) }
    finally { busyRef.current = false; setBusy(false) }
  }, [identity, onPaired])

  useEffect(() => {
    if (offer === null || offer === undefined) return
    setLink(offer)
    void pair(offer)
  }, [offer, pair])

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, backgroundColor: p.main }}>
      <ScrollView contentContainerStyle={[styles.center, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <Text style={[typeScale.largeTitle, { color: p.ink, textAlign: 'center' }]}>{t('Pair with your computer')}</Text>
        <Text style={[typeScale.settingsRow, { color: p.ink2, marginTop: 12, textAlign: 'center' }]}>{Platform.OS === 'web' ? t('On the computer, open DS Bot, go to Settings → Phone and copy the pairing link. Paste it here.') : t('On the computer, open DS Bot, go to Settings → Phone and show a QR code. Then scan it here.')}</Text>
        <PairCamera busy={busy} onScan={uri => void pair(uri)} />
        {Platform.OS !== 'web' ? <Text style={[typeScale.settingsRow, { color: p.ink2, marginTop: 16, textAlign: 'center' }]}>{t('No camera? Paste the pairing link.')}</Text> : null}
        <View style={styles.pairRow}>
          <TextInput value={link} onChangeText={setLink} placeholder="dsbot://pair?…" placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false}
            returnKeyType="go" onSubmitEditing={() => { if (link.trim() !== '') void pair(link) }}
            style={[styles.input, { color: p.ink, backgroundColor: p.hover }]} accessibilityLabel={t('Pairing link')} />
          <Pressable accessibilityRole="button" disabled={busy || link.trim() === ''} onPress={() => void pair(link)}
            style={[styles.button, { backgroundColor: p.accent, opacity: busy || link.trim() === '' ? 0.35 : 1 }]}>
            <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Pair')}</Text>
          </Pressable>
        </View>
        {busy ? <ActivityIndicator style={{ marginTop: 20 }} color={p.accent} /> : null}
        {error ? <Text style={[typeScale.settingsRow, { color: p.danger, marginTop: 12, textAlign: 'center' }]} accessibilityRole="alert">{error}</Text> : null}
        {onCancel !== undefined ? (
          <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={8} style={{ marginTop: 20, minHeight: 44, justifyContent: 'center' }}>
            <Text style={[typeScale.settingsRow, { color: p.ink2 }]}>{t('Cancel')}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  pairRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, alignSelf: 'stretch' },
  input: { flex: 1, minHeight: 44, borderRadius: radius.input, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  button: { minHeight: 44, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
})
