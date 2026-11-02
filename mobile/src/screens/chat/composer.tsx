import { useState } from 'react'
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { t } from '../../ui/i18n.ts'
import { ArrowUpIcon, StopIcon } from '../../ui/icons.tsx'
import { radius, shadow, type as typeScale, type Palette } from '../../ui/tokens.ts'

// The composer card: min height 44, radius 22 (18 when multi-line), level-1
// shadow; send is a 36px accent circle. While the Bot runs and the draft is
// empty a stop button shows instead of send (group chats only for now — a
// Bot's own-chat turn has no /api/bot stop endpoint yet).
export function Composer({ name, running, canStop, onSend, onStop, p }: {
  name: string; running: boolean; canStop: boolean
  onSend: (text: string) => Promise<void>; onStop: () => void; p: Palette
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  // iOS: float above the home indicator. The matching negative
  // keyboardVerticalOffset in ChatView keeps the card hugging the keyboard.
  const insets = useSafeAreaInsets()
  const bottom = Platform.OS === 'ios' ? Math.max(insets.bottom, 10) : 10
  const draft = text.trim()
  const send = async () => {
    if (draft === '' || busy) return
    setBusy(true)
    try { await onSend(draft); setText('') } finally { setBusy(false) }
  }
  const multi = text.includes('\n') || text.length > 80
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderRadius: multi ? radius.composerLong : radius.composer, borderColor: p.line2, marginBottom: bottom }]}>
      <TextInput value={text} onChangeText={setText} placeholder={t('Message {name}', { name })} placeholderTextColor={p.ink3}
        multiline style={[styles.input, { color: p.ink }]} accessibilityLabel={t('Message {name}', { name })} />
      {running && canStop && draft === ''
        ? <Pressable accessibilityRole="button" accessibilityLabel={t('Stop')} onPress={onStop} hitSlop={6}
            style={[styles.send, { backgroundColor: p.accent }]}>
            <StopIcon size={14} />
          </Pressable>
        : <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={busy || draft === ''} onPress={() => void send()} hitSlop={6}
            style={[styles.send, { backgroundColor: p.accent, opacity: busy || draft === '' ? 0.35 : 1 }]}>
            <ArrowUpIcon size={18} />
          </Pressable>}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'flex-end', minHeight: 44, marginHorizontal: 12, paddingLeft: 14, paddingRight: 7.5, paddingVertical: 7.5, borderWidth: 0.5, ...shadow(1) },
  input: { flex: 1, fontSize: 16, lineHeight: 22, paddingTop: 6, paddingBottom: 6, maxHeight: 130 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
})
