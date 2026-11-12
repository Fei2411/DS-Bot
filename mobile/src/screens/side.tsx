import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { ArrowUpIcon, ChevronLeftIcon, CloseIcon } from '../ui/icons.tsx'
import { radius, shadow, type as typeScale, useTheme } from '../ui/tokens.ts'
import { Avatar } from '../ui/marks.tsx'
import type { Bot } from '../connection.ts'
import { Markdown } from './chat/markdown.tsx'

interface SideEntry { id: string; question?: string; answer?: string; status?: string; failure?: string }
interface SideChat { chatId: string; entries?: SideEntry[] }

export function Side({ bot, sessionId, navigation }: { bot: Bot; sessionId: string; navigation: any }) {
  const { p, dark } = useTheme()
  const insets = useSafeAreaInsets()
  const { team, call } = useTeam()
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chats = ((team as { sideChats?: Record<string, SideChat[]> } | null)?.sideChats?.[bot.id] ?? [])
  const chat = chats.find(c => c.chatId === openId)
  const entries = chat?.entries ?? []
  const running = entries.some(e => e.status === 'answering')
  const send = async () => {
    const text = draft.trim()
    if (text === '' || busy) return
    setBusy(true)
    try {
      if (chat === undefined) {
        const created = await call('side-new', { sessionId }) as { chatId?: string }
        if (created?.chatId !== undefined) setOpenId(created.chatId)
        await call('side-ask', { sessionId, chatId: created?.chatId, recent: true, text })
      } else {
        await call('side-ask', { sessionId, chatId: chat.chatId, recent: true, text })
      }
      setDraft('')
      setError(null)
    } catch (f) { setError((f as Error)?.message ?? String(f)) } finally { setBusy(false) }
  }
  // While an answer streams, keep asking for fresh state; the link's own poll
  // refreshes team on revision, this just shortens the gap.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { void call('state', { since: -1 }).catch(() => {}) }, 1500)
    return () => clearInterval(timer)
  }, [running, call])
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.main }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={insets.top}>
      <View style={{ paddingTop: insets.top }}>
        <View style={styles.head}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={() => navigation.goBack()} hitSlop={8} style={styles.headBtn}><ChevronLeftIcon size={20} color={p.ink2} /></Pressable>
          <Avatar bot={bot} dark={dark} size={28} ring={p.main} />
          <View style={{ flex: 1 }}>
            <Text style={[typeScale.rowName, { color: p.ink }]}>{bot.name}</Text>
            <Text style={[typeScale.caption, { color: p.ink3 }]}>{t('Side chat')}</Text>
          </View>
          {chat !== undefined ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} onPress={() => { void call('side-close', { chatId: chat.chatId }).then(() => setOpenId(null)).catch(() => {}) }} style={styles.headBtn}>
              <CloseIcon size={18} color={p.ink2} />
            </Pressable>
          ) : <View style={styles.headBtn} />}
        </View>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 10 }}>
        {chat === undefined ? (
          <>
            {chats.map(item => {
              const last = (item.entries ?? []).at(-1)
              return (
                <Pressable key={item.chatId} accessibilityRole="button" onPress={() => setOpenId(item.chatId)}
                  style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
                  <Text style={[typeScale.settingsRow, { color: p.ink }]} numberOfLines={1}>{last?.question ?? t('New side chat')}</Text>
                  <Text style={[typeScale.small, { color: p.ink3, marginTop: 3 }]}>{t('{count} questions', { count: (item.entries ?? []).length })}</Text>
                </Pressable>
              )
            })}
            {chats.length === 0 ? <Text style={[typeScale.small, { color: p.ink3, textAlign: 'center', marginTop: 30 }]}>{t('Ask about the work so far')}</Text> : null}
          </>
        ) : (
          <>
            {entries.map(entry => (
              <View key={entry.id} style={{ marginBottom: 12 }}>
                <View style={[styles.bubble, { backgroundColor: p.hover, alignSelf: 'flex-end' }]}>
                  <Text style={[typeScale.settingsRow, { color: p.ink }]}>{entry.question}</Text>
                </View>
                {entry.status === 'answering' ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 }}>
                    <Text style={[typeScale.small, { color: p.ink3 }]}>{t('Answering…')}</Text>
                    <Pressable onPress={() => void call('side-cancel', { chatId: chat.chatId, entryId: entry.id })}><Text style={{ color: p.ink2, fontSize: 13 }}>{t('Cancel this side question')}</Text></Pressable>
                  </View>
                ) : (
                  <View style={{ marginTop: 6 }}>
                    {entry.status === 'cancelled' ? <Text style={[typeScale.small, { color: p.ink3 }]}>{t('Cancelled')}</Text> : null}
                    {entry.status === 'failed' ? <Text style={[typeScale.small, { color: p.danger }]}>{entry.failure ?? t('The side answer failed.')}</Text> : null}
                    {entry.answer ? <Markdown text={entry.answer} p={p} textColor={p.ink} /> : null}
                  </View>
                )}
              </View>
            ))}
            <Text style={[typeScale.caption, { color: p.ink3, marginTop: 4 }]}>{t('Answered from progress so far; nothing was run')}</Text>
          </>
        )}
        {error ? <Text style={[typeScale.small, { color: p.danger, marginTop: 8 }]}>{error}</Text> : null}
      </ScrollView>
      <View style={[styles.composer, { borderTopColor: p.line, backgroundColor: p.main, paddingBottom: insets.bottom + 8 }]}>
        <TextInput style={[styles.input, { color: p.ink, borderColor: p.line }]} value={draft} onChangeText={setDraft}
          placeholder={t('Ask about the work so far')} placeholderTextColor={p.ink3} multiline />
        <Pressable accessibilityRole="button" disabled={draft.trim() === '' || busy} onPress={() => void send()}
          style={[styles.send, { backgroundColor: p.accent, opacity: draft.trim() === '' || busy ? 0.4 : 1 }]}>
          <ArrowUpIcon size={18} color={p.accentInk} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8 },
  headBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  card: { borderRadius: radius.card, borderWidth: 1, padding: 14, marginBottom: 10, ...shadow(1) },
  bubble: { borderRadius: radius.card, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '85%' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: 1 },
  input: { flex: 1, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, maxHeight: 120, fontSize: 15 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
})
