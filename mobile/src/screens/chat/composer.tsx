import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import * as Haptics from 'expo-haptics'
import * as ImagePicker from 'expo-image-picker'
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator'
import { useState } from 'react'
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { sizeText } from '../../team/files.ts'
import { t } from '../../ui/i18n.ts'
import { ArrowUpIcon, CloseIcon, FileIcon, PlusIcon, StopIcon } from '../../ui/icons.tsx'
import { radius, shadow, type as typeScale, type Palette } from '../../ui/tokens.ts'

// A photo ready to send: shown from `uri`, sent as base64 JPEG.
export interface Photo { uri: string; mediaType: string; data: string }

// A file picked from the phone: read as base64 when the message is sent.
export interface PickedFile { uri: string; name: string; size: number; mediaType?: string }

// An older computer names no limit. One link message carries 4 MiB of plaintext,
// so base64 leaves just under 3 MiB for the file itself.
const DEFAULT_FILE_BYTES = 3121152

async function fileOf(asset: DocumentPicker.DocumentPickerAsset): Promise<PickedFile> {
  let size = asset.size
  if (size === undefined) {
    const info = await FileSystem.getInfoAsync(asset.uri).catch(() => null)
    size = info !== null && info.exists ? info.size : 0
  }
  return { uri: asset.uri, name: asset.name, size, ...(asset.mimeType !== undefined ? { mediaType: asset.mimeType } : {}) }
}

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
// empty a stop button shows instead of send. "+" adds photos or files when the
// computer takes photos.
export function Composer({ name, running, canStop, canAttach, canFiles, maxFileBytes, onSend, onStop, p }: {
  name: string; running: boolean; canStop: boolean; canAttach: boolean; canFiles: boolean; maxFileBytes?: number
  onSend: (text: string, photos: Photo[], files: PickedFile[]) => Promise<void>; onStop: () => void; p: Palette
}) {
  const [text, setText] = useState('')
  const [photos, setPhotos] = useState<Photo[]>([])
  const [files, setFiles] = useState<PickedFile[]>([])
  const [preparingPhotos, setPreparingPhotos] = useState(false)
  const [preparingFiles, setPreparingFiles] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  // Float above the home indicator (iOS) or the gesture bar (Android, drawn edge to
  // edge). The matching negative keyboardVerticalOffset in ChatView keeps the card
  // hugging the keyboard.
  const insets = useSafeAreaInsets()
  const bottom = Math.max(insets.bottom, 10)
  const draft = text.trim()
  const ready = (draft !== '' || photos.length > 0 || files.length > 0) && !preparingPhotos && !preparingFiles
  // The message shows in the chat at once; the composer is free for the next one.
  const send = () => {
    if (!ready) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    const sending = photos
    const sendingFiles = files
    setText(''); setPhotos([]); setFiles([])
    void onSend(draft, sending, sendingFiles)
  }
  const pickPhotos = async () => {
    setPickError(null)
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 0, quality: 1, orderedSelection: true })
    if (result.canceled || result.assets.length === 0) return
    setPreparingPhotos(true)
    try {
      const ready = await Promise.all(result.assets.map(prepare))
      setPhotos(prev => [...prev, ...ready.filter(photo => photo.data !== '')])
    } catch (failure) {
      setPickError(failure instanceof Error ? failure.message : String(failure))
    } finally { setPreparingPhotos(false) }
  }
  const pickFiles = async () => {
    setPickError(null)
    const limit = Number.isSafeInteger(maxFileBytes) && maxFileBytes! > 0 ? maxFileBytes! : DEFAULT_FILE_BYTES
    let result: DocumentPicker.DocumentPickerResult
    try {
      result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true })
    } catch (failure) {
      setPickError(failure instanceof Error ? failure.message : String(failure))
      return
    }
    if (result.canceled || result.assets.length === 0) return
    setPreparingFiles(true)
    try {
      const picked = await Promise.all(result.assets.map(fileOf))
      const tooBig = picked.find(file => file.size > limit)
      if (tooBig !== undefined) setPickError(t('{name} is larger than {size}', { name: tooBig.name, size: sizeText(limit) }))
      const accepted = picked.filter(file => file.size <= limit)
      setFiles(prev => {
        const seen = new Set(prev.map(file => file.uri))
        return [...prev, ...accepted.filter(file => !seen.has(file.uri))]
      })
    } catch (failure) {
      setPickError(failure instanceof Error ? failure.message : String(failure))
    } finally { setPreparingFiles(false) }
  }
  const attach = () => {
    // An older computer takes photos only: keep its one-tap flow.
    if (!canFiles) { void pickPhotos(); return }
    if (!canAttach) { void pickFiles(); return }
    Alert.alert(t('Add photos or files'), undefined, [
      { text: t('Photo'), onPress: () => void pickPhotos() },
      { text: t('File'), onPress: () => void pickFiles() },
      { text: t('Cancel'), style: 'cancel' },
    ])
  }
  const multi = text.includes('\n') || text.length > 80 || photos.length > 0 || files.length > 0
  return (
    <View style={{ marginBottom: bottom }}>
      {pickError !== null ? <Text style={[typeScale.small, { color: p.danger, textAlign: 'center', marginBottom: 4 }]}>{pickError}</Text> : null}
      <View style={[styles.card, { backgroundColor: p.card, borderRadius: multi ? radius.composerLong : radius.composer, borderColor: p.line2 }]}>
        {photos.length > 0 || preparingPhotos ? (
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
            {preparingPhotos ? <View style={[styles.photo, { backgroundColor: p.hover, alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator color={p.ink3} /></View> : null}
          </ScrollView>
        ) : null}
        {files.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.files} keyboardShouldPersistTaps="handled">
            {files.map(file => (
              <View key={file.uri} style={[styles.fileChip, { backgroundColor: p.hover, borderColor: p.line2 }]}>
                <FileIcon size={14} color={p.ink2} />
                <Text style={[typeScale.small, { color: p.ink, maxWidth: 150 }]} numberOfLines={1}>{file.name}</Text>
                {file.size > 0 ? <Text style={[typeScale.caption, { color: p.ink3 }]}>{sizeText(file.size)}</Text> : null}
                <Pressable accessibilityRole="button" accessibilityLabel={t('Remove file')} hitSlop={8} onPress={() => setFiles(prev => prev.filter(entry => entry !== file))}>
                  <CloseIcon size={12} color={p.ink3} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.line}>
          {canAttach || canFiles ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t('Add photos or files')} onPress={attach} hitSlop={6} style={styles.attach}>
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
  files: { flexDirection: 'row', gap: 6, paddingHorizontal: 6, paddingTop: 6, paddingBottom: 2 },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 240, paddingLeft: 10, paddingRight: 8, paddingVertical: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  photo: { width: 64, height: 64, borderRadius: 12 },
  unpick: { position: 'absolute', top: -5, right: -5, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  attach: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, fontSize: 16, lineHeight: 22, paddingTop: 7, paddingBottom: 7, paddingRight: 6, maxHeight: 130 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
})
