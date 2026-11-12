import * as Haptics from 'expo-haptics'
import * as ImagePicker from 'expo-image-picker'
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator'
import { useState } from 'react'
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '../../ui/i18n.ts'
import { ArrowUpIcon, CloseIcon, PlusIcon, StopIcon } from '../../ui/icons.tsx'
import { radius, shadow, type as typeScale, type Palette } from '../../ui/tokens.ts'

// A photo ready to send: shown from `uri`, sent as base64 JPEG.
export interface Photo { uri: string; mediaType: string; data: string }

// Photos are made smaller on the phone before they go: the long side at most
// 2048 px as JPEG, which keeps one photo well under what the link carries in a
// message and is as much as the models look at.
const LONG_SIDE = 2048
async function prepare(asset: ImagePicker.ImagePickerAsset): Promise<Photo> {
  const long = Math.max(asset.width ?? 0, asset.height ?? 0)
  const resize = long > LONG_SIDE ? [{ resize: asset.width >= asset.height ? { width: LONG_SIDE } : { height: LONG_SIDE } }] : []
  const out = await manipulateAsync(asset.uri, resize, { compress: 0.82, format: SaveFormat.JPEG, base64: true })
  return { uri: out.uri, mediaType: 'image/jpeg', data: out.base64 ?? '' }
}

// The composer card: min height 44, radius 22 (18 when multi-line), level-1
// shadow; send is a 36px accent circle. While the Bot runs and the draft is
// empty a stop button shows instead of send. "+" adds photos when the
// computer takes them.
export function Composer({ name, running, canStop, canAttach, onSend, onStop, p }: {
  name: string; running: boolean; canStop: boolean; canAttach: boolean
  onSend: (text: string, photos: Photo[]) => Promise<void>; onStop: () => void; p: Palette
}) {
  const [text, setText] = useState('')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [preparing, setPreparing] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  // Float above the home indicator (iOS) or the gesture bar (Android, drawn edge to
  // edge). The matching negative keyboardVerticalOffset in ChatView keeps the card
  // hugging the keyboard.
  const insets = useSafeAreaInsets()
  const bottom = Math.max(insets.bottom, 10)
  const draft = text.trim()
  const ready = (draft !== '' || photos.length > 0) && !preparing
  // The message shows in the chat at once; the composer is free for the next one.
  const send = () => {
    if (!ready) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    const sending = photos
    setText(''); setPhotos([])
    void onSend(draft, sending)
  }
  const pick = async () => {
    setPickError(null)
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 0, quality: 1, orderedSelection: true })
    if (result.canceled || result.assets.length === 0) return
    setPreparing(true)
    try {
      const ready = await Promise.all(result.assets.map(prepare))
      setPhotos(prev => [...prev, ...ready.filter(photo => photo.data !== '')])
    } catch (failure) {
      setPickError(failure instanceof Error ? failure.message : String(failure))
    } finally { setPreparing(false) }
  }
  const multi = text.includes('\n') || text.length > 80 || photos.length > 0
  return (
    <View style={{ marginBottom: bottom }}>
      {pickError !== null ? <Text style={[typeScale.small, { color: p.danger, textAlign: 'center', marginBottom: 4 }]}>{pickError}</Text> : null}
      <View style={[styles.card, { backgroundColor: p.card, borderRadius: multi ? radius.composerLong : radius.composer, borderColor: p.line2 }]}>
        {photos.length > 0 || preparing ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.photos} keyboardShouldPersistTaps="handled">
            {photos.map(photo => (
              <View key={photo.uri}>
                <Image source={{ uri: photo.uri }} style={[styles.photo, { backgroundColor: p.hover }]} />
                <Pressable accessibilityRole="button" accessibilityLabel={t('Remove')} hitSlop={8} onPress={() => setPhotos(prev => prev.filter(entry => entry !== photo))}
                  style={[styles.unpick, { backgroundColor: p.ink }]}>
                  <CloseIcon size={10} color={p.main} />
                </Pressable>
              </View>
            ))}
            {preparing ? <View style={[styles.photo, { backgroundColor: p.hover, alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator color={p.ink3} /></View> : null}
          </ScrollView>
        ) : null}
        <View style={styles.line}>
          {canAttach ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t('Add photos')} onPress={() => void pick()} hitSlop={6} style={styles.attach}>
              <PlusIcon size={20} color={p.ink2} />
            </Pressable>
          ) : null}
          <TextInput value={text} onChangeText={setText} placeholder={t('Message {name}', { name })} placeholderTextColor={p.ink3}
            multiline style={[styles.input, { color: p.ink, paddingLeft: canAttach ? 2 : 6 }]} accessibilityLabel={t('Message {name}', { name })} />
          {running && canStop && !ready
            ? <Pressable accessibilityRole="button" accessibilityLabel={t('Stop')} onPress={onStop} hitSlop={6}
                style={[styles.send, { backgroundColor: p.accent }]}>
                <StopIcon size={14} />
              </Pressable>
            : <Pressable accessibilityRole="button" accessibilityLabel={t('Send')} disabled={!ready} onPress={send} hitSlop={6}
                style={[styles.send, { backgroundColor: p.accent, opacity: ready ? 1 : 0.35 }]}>
                <ArrowUpIcon size={18} />
              </Pressable>}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 12, paddingHorizontal: 7.5, paddingVertical: 7.5, borderWidth: 0.5, ...shadow(1) },
  line: { flexDirection: 'row', alignItems: 'flex-end' },
  photos: { gap: 8, paddingHorizontal: 6, paddingTop: 6, paddingBottom: 8 },
  photo: { width: 64, height: 64, borderRadius: 12 },
  unpick: { position: 'absolute', top: -5, right: -5, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  attach: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, fontSize: 16, lineHeight: 22, paddingTop: 7, paddingBottom: 7, paddingRight: 6, maxHeight: 130 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
})
