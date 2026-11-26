import { CameraView, useCameraPermissions } from 'expo-camera'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { t } from '../ui/i18n.ts'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'

export function PairCamera({ busy, onScan }: { busy: boolean; onScan: (uri: string) => void }) {
  const { p } = useTheme()
  const [permission, requestPermission] = useCameraPermissions()
  return <View style={{ marginTop: 20, width: 260, height: 260, maxWidth: '100%', borderRadius: radius.card, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, backgroundColor: p.sidebar, borderColor: p.line }}>
    {permission?.granted
      ? <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={busy ? undefined : ({ data }) => onScan(data)} />
      : <Pressable accessibilityRole="button" onPress={() => void requestPermission()} style={{ minHeight: 44, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: p.accent }}>
          <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Use the camera')}</Text>
        </Pressable>}
  </View>
}
