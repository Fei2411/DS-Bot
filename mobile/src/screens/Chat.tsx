import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { Approval, Bot, Question, Room } from '../connection.ts'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { useTheme } from '../ui/tokens.ts'
import { workPhrase } from '../ui/phrases.ts'
import { ActionRow, Dock } from './chat/dock.tsx'
import { Composer } from './chat/composer.tsx'
import { Item, itemKey, type ChatItem } from './chat/items.tsx'

const POLL_MS = 2_500

interface ChatPage { sessionId: string; items: ChatItem[]; cursor: unknown }

// The shared chat body for both shells: inverted list, older pages on top,
// pending dock and composer. `header` is the shell's own (back row or pill).
export function ChatView({ bot, room, header }: { bot?: Bot; room?: Room; header: React.ReactNode }) {
  const { team, call } = useTeam()
  const { p, dark } = useTheme()
  const id = bot?.id ?? room?.id ?? ''
  const [page, setPage] = useState<ChatPage | null>(null)
  const [older, setOlder] = useState<ChatItem[]>([])
  const [cursor, setCursor] = useState<unknown>(undefined)
  const [gone, setGone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const stopped = useRef(false)
  const scroller = useRef<{ scrollToEnd: (o: { animated: boolean }) => void } | null>(null)
  const loading = useRef(false)
  const atBottom = useRef(true)
  const seen = useRef(0)

  const refresh = useCallback(async () => {
    if (stopped.current || id === '') return
    try {
      const next = await call('chat', { botId: id }) as ChatPage
      if (!stopped.current) setPage(next)
    } catch (failure) {
      const code = (failure as { code?: string })?.code
      if (code === 'bot/not-found') setGone(true)
    }
  }, [call, id])

  useEffect(() => {
    stopped.current = false
    setPage(null); setOlder([]); setCursor(undefined); setGone(false); setLoaded(false)
    const loop = async () => {
      await refresh()
      if (!stopped.current) setTimeout(() => void loop(), POLL_MS)
    }
    void loop()
    return () => { stopped.current = true }
  }, [refresh])

  const loadMore = useCallback(async () => {
    if (cursor == null || id === '' || loading.current) return
    loading.current = true
    atBottom.current = false
    try {
      const next = await call('chat', { botId: id, cursor }) as ChatPage
      setOlder(prev => [...next.items, ...prev])
      setCursor(next.cursor)
    } catch { /* keep the page we have */ }
    finally { loading.current = false }
  }, [call, cursor, id])

  useEffect(() => { if (page !== null) setCursor(page.cursor) }, [page?.sessionId])

  const sessionId = page?.sessionId ?? bot?.sessionId ?? room?.id ?? id
  const question: Question | undefined = team?.questions?.[sessionId]
  const approvals = (team?.work?.approvals ?? []).filter((entry: Approval) => entry.sessionId === sessionId || (entry.roomId !== undefined && entry.roomId === room?.id))
  const doing = bot !== undefined ? team?.work?.bots?.[bot.id] ?? team?.activity?.[bot.id] : undefined
  const roomWork = room !== undefined ? (team?.work?.rooms?.[room.id] ?? []) : []
  const running = doing !== undefined || roomWork.length > 0
  const doingBot = bot ?? (roomWork[0] !== undefined ? team?.bots?.find(b => b.id === roomWork[0].botId) : undefined)
  const doingText = doing !== undefined ? workPhrase(doing) : roomWork[0] !== undefined ? `${doingBot?.name ?? ''} · ${workPhrase(roomWork[0])}` : ''
  const flat = team?.prefs?.layout === 'flat'
  const width = Math.min(100, Math.max(50, team?.prefs?.width ?? 80))
  const [chatWidth, setChatWidth] = useState(0)
  // Bubble caps in px — RN cannot parse the CSS min() expression.
  const botMax = chatWidth === 0 ? 0 : Math.min(chatWidth * width / 100, chatWidth - 40)
  const userMax = chatWidth * width / 100

  const send = async (text: string) => {
    try {
      await call('send', { sessionId, text })
      setError(null); void refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const stop = () => {
    if (room !== undefined) void call('stop-room-work', { roomId: room.id }).catch(() => {})
  }

  // Inverted list: index 0 sits at the bottom, so newest items come first.
  // Chronological order (oldest first); the list starts scrolled to the newest item.
  const items = useMemo(() => [...older, ...(page?.items ?? [])], [page, older])
  const canStop = room !== undefined && roomWork.length > 0

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0} style={[styles.screen, { backgroundColor: p.main }]}>
      {header}
      {gone
        ? <Text style={[type.caption, { color: p.ink3, textAlign: 'center', marginTop: 24 }]}>{t('No messages yet')}</Text>
        : page === null
          ? <ActivityIndicator style={styles.loading} color={p.accent} />
          : <ScrollView
              ref={scroller as never}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled"
              onLayout={event => setChatWidth(event.nativeEvent.layout.width)}
              maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
              onContentSizeChange={() => {
                if (!loaded) { setLoaded(true); scroller.current?.scrollToEnd({ animated: false }); return }
                // Follow new messages only while pinned near the bottom.
                if (items.length > seen.current && atBottom.current) scroller.current?.scrollToEnd({ animated: true })
                seen.current = items.length
              }}
              onScroll={event => {
                const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
                atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80
                if (contentOffset.y < 120) void loadMore()
              }}
              scrollEventThrottle={100}>
              {items.map((item, index) => <Item key={itemKey(item, index)} item={item} p={p} flat={flat} maxWidth={item.kind === 'bot' ? botMax : userMax} inRoom={room !== undefined} />)}
              {items.length === 0 ? <Text style={[type.caption, { color: p.ink3, textAlign: 'center' }]}>{t('No messages yet')}</Text> : null}
            </ScrollView>}
      {running && doingBot ? <ActionRow bot={doingBot} doing={doingText} p={p} dark={dark} /> : null}
      <Dock question={question} sessionId={sessionId} approvals={approvals} call={call} p={p} />
      {error ? <Text style={[type.small, { color: p.danger, textAlign: 'center', marginBottom: 4 }]} accessibilityRole="alert">{error}</Text> : null}
      <Composer name={bot?.name ?? room?.name ?? ''} running={running} canStop={canStop} onSend={send} onStop={stop} p={p} />
    </KeyboardAvoidingView>
  )
}

const type = { caption: { fontSize: 12, lineHeight: 16 }, small: { fontSize: 13, lineHeight: 18 } }
const styles = StyleSheet.create({
  screen: { flex: 1 },
  loading: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingVertical: 8, paddingHorizontal: 12 },
})
