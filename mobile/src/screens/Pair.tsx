import { CameraView, useCameraPermissions } from 'expo-camera'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { parsePairingUri } from '../../../link/src/index.ts'
import { openLink } from '../connection.ts'
import { saveComputer, type PhoneIdentity, type SavedComputer } from '../store.ts'
import { errorText } from '../team/link.ts'
import { t } from '../ui/i18n.ts'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'

export function Pair({ identity, onPaired }: { identity: PhoneIdentity; onPaired: (computer: SavedComputer) => void }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  const pair = useCallback(async (uri: string) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try {
      const offer = parsePairingUri(uri.trim())
      const client = await openLink(offer, identity, offer.code)
      await client.close()
      onPaired(await saveComputer(offer))
    } catch (failure) { setError(errorText(failure)) }
    finally { busyRef.current = false; setBusy(false) }
  }, [identity, onPaired])

  useEffect(() => {
    const open = (url: string | null | undefined) => { if (url?.startsWith('dsbot://pair')) void pair(url) }
    void Linking.getInitialURL().then(open)
    const subscription = Linking.addEventListener('url', event => open(event.url))
    return () => subscription.remove()
  }, [pair])

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.center, { backgroundColor: p.main, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <Text style={[typeScale.largeTitle, { color: p.ink, textAlign: 'center' }]}>{t('Pair with your computer')}</Text>
      <Text style={[typeScale.settingsRow, { color: p.ink2, marginTop: 12, textAlign: 'center' }]}>{t('On the computer, open DS Bot, go to Settings → Phone and show a QR code. Then scan it here.')}</Text>
      <View style={[styles.camera, { backgroundColor: p.sidebar, borderColor: p.line }]}>
        {permission?.granted
          ? <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={busy ? undefined : ({ data }) => void pair(data)} />
          : <Pressable accessibilityRole="button" onPress={() => void requestPermission()} style={[styles.button, { backgroundColor: p.accent }]}>
              <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Use the camera')}</Text>
            </Pressable>}
      </View>
      <Text style={[typeScale.settingsRow, { color: p.ink2, marginTop: 16, textAlign: 'center' }]}>{t('No camera? Paste the pairing link.')}</Text>
      <View style={styles.pairRow}>
        <TextInput value={link} onChangeText={setLink} placeholder="dsbot://pair?…" placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false}
          returnKeyType="go" onSubmitEditing={() => { if (link.trim() !== '') void pair(link) }}
          style={[styles.input, { color: p.ink, backgroundColor: p.hover }]} accessibilityLabel="Pairing link" />
        <Pressable accessibilityRole="button" disabled={busy || link.trim() === ''} onPress={() => void pair(link)}
          style={[styles.button, { backgroundColor: p.accent, opacity: busy || link.trim() === '' ? 0.35 : 1 }]}>
          <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Pair')}</Text>
        </Pressable>
      </View>
      {busy ? <ActivityIndicator style={{ marginTop: 20 }} color={p.accent} /> : null}
      {error ? <Text style={[typeScale.settingsRow, { color: p.danger, marginTop: 12, textAlign: 'center' }]} accessibilityRole="alert">{error}</Text> : null}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  camera: { marginTop: 20, width: 260, height: 260, borderRadius: radius.card, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  pairRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, alignSelf: 'stretch' },
  input: { flex: 1, height: 44, borderRadius: radius.input, paddingHorizontal: 12, fontSize: 16 },
  button: { height: 44, borderRadius: radius.pill, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
})
