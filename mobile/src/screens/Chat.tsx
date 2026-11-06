import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Approval, Bot, Question, Room } from '../connection.ts'
import { useTeam } from '../team/context.tsx'
import { markSeen } from '../team/seen.ts'
import { messageClock, t } from '../ui/i18n.ts'
import { useTheme } from '../ui/tokens.ts'
import { workPhrase } from '../ui/phrases.ts'
import { ActionRow, Dock } from './chat/dock.tsx'
import { Composer } from './chat/composer.tsx'
import { Actions, Item, itemKey, type ChatItem } from './chat/items.tsx'

// Feed events refresh the chat as things happen; the poll only catches what a
// dropped event missed, so it runs rarely.
const POLL_MS = 15_000

// A refreshed page reuses the item objects that did not change, so the memoized
// rows keep their identity and only new or changed rows render again.
function keepSame(prev: ChatItem[], next: ChatItem[]): ChatItem[] {
  const known = new Map(prev.map((item, index) => [itemKey(item, index), item]))
  let same = prev.length === next.length
  const merged = next.map((item, index) => {
    const old = known.get(itemKey(item, index))
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(item)) { if (prev[index] !== old) same = false; return old }
    same = false
    return item
  })
  return same ? prev : merged
}

interface ChatPage { sessionId: string; items: ChatItem[]; cursor: unknown }

// The shared chat body for both shells: inverted list, older pages on top,
// pending dock and composer. `header` is the shell's own (back row or pill).
export function ChatView({ bot, room, header, onMissing }: { bot?: Bot; room?: Room; header: React.ReactNode; onMissing?: () => void }) {
  const { team, call } = useTeam()
  const { p, dark } = useTheme()
  const insets = useSafeAreaInsets()
  const id = bot?.id ?? room?.id ?? ''
  const [page, setPage] = useState<ChatPage | null>(null)
  const [older, setOlder] = useState<ChatItem[]>([])
  const cursor = useRef<unknown>(undefined)
  const [gone, setGone] = useState(false)
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  // A failed load clears itself on the next good one; a failed send stays until the next send.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // Each poll loop owns a generation number; a chat switch bumps it so stale
  // loops and in-flight refreshes stop writing instead of fighting the new chat.
  const generation = useRef(0)
  const scroller = useRef<{ scrollToEnd: (o: { animated: boolean }) => void } | null>(null)
  const loading = useRef(false)
  const atBottom = useRef(true)
  const seen = useRef(0)

  // One chat read at a time, like the team state: a burst of messages becomes one
  // read now and at most one more after it.
  const reading = useRef(false)
  const again = useRef(false)
  const refresh = useCallback(async (gen: number): Promise<void> => {
    if (id === '' || generation.current !== gen) return
    if (reading.current) { again.current = true; return }
    reading.current = true
    try {
      const next = (room !== undefined
        ? await call('room-chat', { roomId: room.id, steps: true })
        : await call('chat', { botId: id, steps: true })) as ChatPage
      if (generation.current === gen) { setPage(prev => prev !== null && prev.sessionId === next.sessionId ? { ...next, items: keepSame(prev.items, next.items) } : next); setLoadError(null) }
    } catch (failure) {
      if (generation.current !== gen) return
      const code = (failure as { code?: string })?.code
      if (code === 'bot/not-found') { setGone(true); onMissing?.() }
      // Offline is the link's state, not this chat's; the reconnect refreshes.
      else if (code !== 'link/offline') setLoadError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      reading.current = false
      // The latest refresh, not this closure's: the chat may have changed meanwhile.
      if (again.current) { again.current = false; void latest.current(generation.current) }
    }
  }, [call, id])
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => {
    const gen = ++generation.current
    setPage(null); setOlder([]); cursor.current = undefined; setGone(false); setLoaded(false)
    const loop = async () => {
      await refresh(gen)
      if (generation.current === gen) setTimeout(() => void loop(), POLL_MS)
    }
    void loop()
    return () => { if (generation.current === gen) generation.current += 1 }
  }, [refresh])

  // cursor lives in a ref: onScroll can fire again before the setState from
  // the previous load commits, and a stale closure would re-request the same
  // page forever at the top.
  const loadMore = useCallback(async () => {
    if (cursor.current == null || id === '' || loading.current) return
    const gen = generation.current
    loading.current = true
    atBottom.current = false
    try {
      const next = (room !== undefined
        ? await call('room-chat', { roomId: room.id, cursor: cursor.current, steps: true })
        : await call('chat', { botId: id, cursor: cursor.current, steps: true })) as ChatPage
      if (generation.current !== gen) return
      cursor.current = next.cursor
      setOlder(prev => [...next.items, ...prev])
    } catch { /* keep the page we have */ }
    finally { loading.current = false }
  }, [call, id])

  useEffect(() => { if (page !== null) cursor.current = page.cursor }, [page?.sessionId])

  const sessionId = page?.sessionId ?? bot?.sessionId ?? room?.id ?? id
  const question: Question | undefined = team?.questions?.[sessionId]
  const approvals = (team?.work?.approvals ?? []).filter((entry: Approval) => entry.sessionId === sessionId || (entry.roomId !== undefined && entry.roomId === room?.id))
  const doing = bot !== undefined ? team?.work?.bots?.[bot.id] ?? team?.activity?.[bot.id] : undefined
  const secrets = (team?.secretRequests?.[bot?.id ?? ''] ?? []).filter((r: { status?: string }) => r.status === 'pending')
  const handoff = (team as { browserHolds?: Record<string, { callId?: string; reason?: string; note?: string }> } | null)?.browserHolds?.[bot?.id ?? '']
  const browserHold = handoff !== undefined && handoff.callId !== undefined ? { callId: handoff.callId, reason: handoff.reason, note: handoff.note } : undefined
  const btw = ((team as { btwCards?: Record<string, { id: string; partId?: string; question?: string; answer?: string; failure?: string }[]> } | null)?.btwCards?.[bot?.id ?? ''] ?? []).filter(card => card.partId === undefined || card.partId === sessionId)
  const roomWork = room !== undefined ? (team?.work?.rooms?.[room.id] ?? []) : []
  const running = doing !== undefined || roomWork.length > 0
  const doingBot = bot ?? (roomWork[0] !== undefined ? team?.bots?.find(b => b.id === roomWork[0].botId) : undefined)
  const doingText = doing !== undefined ? workPhrase(doing) : roomWork[0] !== undefined ? `${doingBot?.name ?? ''} · ${workPhrase(roomWork[0])}` : ''
  const flat = team?.prefs?.layout === 'flat'
  const width = Math.min(100, Math.max(50, team?.prefs?.width ?? 80))
  const [chatWidth, setChatWidth] = useState(0)
  const [chatHeight, setChatHeight] = useState(0)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [menuText, setMenuText] = useState<string | null>(null)
  const [readerText, setReaderText] = useState<string | null>(null)
  const [readerTitle, setReaderTitle] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const openFile = useCallback((file: { name: string; attachmentId?: string }) => {
    void call('file-text', { file }).then(result => {
      const read = result as { text?: string; truncated?: boolean } | string
      setReaderTitle(file.name)
      setReaderText(typeof read === 'string' ? read : read?.text ?? '')
    }, (failure: { code?: string; message?: string }) => setFileError(failure?.message ?? t('This file cannot be read here')))
  }, [call])
  const onLongPress = setMenuText
  // One stable toggle per steps row, so a memoized row is not redrawn for a new closure.
  const toggles = useRef(new Map<string, () => void>())
  const toggleOf = (key: string) => {
    let toggle = toggles.current.get(key)
    if (toggle === undefined) { toggle = () => setOpenSteps(prev => ({ ...prev, [key]: !prev[key] })); toggles.current.set(key, toggle) }
    return toggle
  }
  const { onFeed, online } = useTeam()
  useEffect(() => { markSeen(id) }, [id])
  useEffect(() => { if (online) void refresh(generation.current) }, [online, refresh])
  useEffect(() => {
    if (onFeed === undefined) return
    const gen = generation.current
    return onFeed((event, data) => {
      if (generation.current !== gen) return
      if (event === 'room' && room !== undefined && data?.roomId === room.id) void refresh(gen)
      if (event === 'message' && data?.sessionId === sessionId) {
        const item = data.item
        if (item !== undefined) setPage(prev => prev === null || prev.items.some(it => it.seq !== undefined && it.seq === item.seq) ? prev : { ...prev, items: [...prev.items, item] })
        markSeen(id)
        void refresh(gen)
      }
    })
  }, [onFeed, room, sessionId, refresh, id])
  // Bubble caps in px — RN cannot parse the CSS min() expression.
  const botMax = chatWidth === 0 ? 0 : Math.min(chatWidth * width / 100, chatWidth - 40)
  const userMax = chatWidth * width / 100

  const send = async (text: string) => {
    try {
      await call('send', { sessionId, text })
      setError(null); void refresh(generation.current)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const stop = () => {
    if (room !== undefined) void call('stop-room-work', { roomId: room.id }).catch(() => {})
    else if (bot !== undefined) void call('stop-chat', { botId: bot.id }).catch(() => {})
  }

  // Inverted list: index 0 sits at the bottom, so newest items come first.
  // Chronological order (oldest first); the list starts scrolled to the newest item.
  const items = useMemo(() => [...older, ...(page?.items ?? [])], [page, older])
  const canStop = room !== undefined ? roomWork.length > 0 : running

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={Platform.OS === 'ios' ? -insets.bottom : 0} style={[styles.screen, { backgroundColor: p.main }]}>
      {header}
      {gone
        ? <Text style={[type.caption, { color: p.ink3, textAlign: 'center', marginTop: 24 }]}>{t('No messages yet')}</Text>
        : page === null && loadError !== null
          ? <View style={{ alignItems: 'center', marginTop: 24 }}>
              <Text style={[type.caption, { color: p.ink3, textAlign: 'center' }]}>{loadError}</Text>
              <Text accessibilityRole="button" style={[type.caption, { color: p.accent, marginTop: 8 }]} onPress={() => { setLoadError(null); void refresh(generation.current) }}>{t('Retry')}</Text>
            </View>
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
              {items.map((item, index) => { const key = itemKey(item, index); const skey = item.kind === 'steps' ? `steps-${item.turn ?? index}` : key; return <Item key={key} stamp={stampOf(items, index)} item={item} p={p} flat={flat} maxWidth={item.kind === 'bot' ? botMax : userMax} inRoom={room !== undefined} sessionId={sessionId} onLongPress={onLongPress} onOpenFile={openFile} open={openSteps[skey]} onToggle={toggleOf(skey)} /> })}
              <Streaming key={sessionId} sessionId={sessionId} p={p} flat={flat} maxWidth={botMax} inRoom={room !== undefined} />
              {items.length === 0 ? <Text style={[type.caption, { color: p.ink3, textAlign: 'center' }]}>{t('No messages yet')}</Text> : null}
            </ScrollView>}
      {running && doingBot ? <ActionRow bot={doingBot} doing={doingText} p={p} dark={dark} /> : null}
      <Dock question={question} sessionId={sessionId} approvals={approvals} secrets={secrets} btw={btw} handoff={browserHold} view={team?.views?.[sessionId]} call={call} p={p} maxHeight={chatHeight === 0 ? undefined : chatHeight * 0.55} expanded={expandedKey} onExpand={setExpandedKey} />
      {fileError ? <Text style={[type.small, { color: p.danger, textAlign: 'center', marginBottom: 4 }]} accessibilityRole="alert">{fileError}</Text> : null}
      {error ?? (page !== null ? loadError : null) ? <Text style={[type.small, { color: p.danger, textAlign: 'center', marginBottom: 4 }]} accessibilityRole="alert">{error ?? loadError}</Text> : null}
      <Composer name={bot?.name ?? room?.name ?? ''} running={running} canStop={canStop} onSend={send} onStop={stop} p={p} />
      <Actions visible={menuText !== null} text={menuText ?? ''} p={p}
        onClose={() => setMenuText(null)}
        onSelect={() => { setReaderTitle(null); setReaderText(menuText); setMenuText(null) }} />
      <Modal visible={readerText !== null} animationType="fade" onRequestClose={() => setReaderText(null)}>
        <View style={[styles.reader, { backgroundColor: p.main }]}>
          <ScrollView contentContainerStyle={{ padding: 20, paddingTop: insets.top + 20, paddingBottom: 80 }}>
            {readerTitle !== null ? <Text style={[type.caption, { color: p.ink3, marginBottom: 10 }]}>{readerTitle}</Text> : null}
            <Text selectable style={[type.bubble, { color: p.ink, fontFamily: readerTitle?.match(/\.(md|markdown)$/i) ? undefined : 'monospace' }]}>{readerText ?? ''}</Text>
          </ScrollView>
          <Pressable accessibilityRole="button" onPress={() => setReaderText(null)} style={[styles.readerClose, { backgroundColor: p.card, borderColor: p.line }]}>
            <Text style={[type.settingsRow, { color: p.accent }]}>{t('Done')}</Text>
          </Pressable>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  )
}

// As on the desktop, a run of one Bot's bubbles ends with the time of its last one.
function stampOf(items: ChatItem[], index: number): string | undefined {
  const item = items[index]
  if (item.kind !== 'bot' || typeof item.time !== 'number') return undefined
  const next = items[index + 1]
  if (next !== undefined && next.kind === 'bot' && (next.name ?? '') === (item.name ?? '')) return undefined
  return messageClock(item.time)
}

// The turn being streamed by the model, per attempt id. It holds its own state so a
// token redraws this one bubble, not the whole chat; the real item lands with the
// 'message' event when the turn's text is saved.
function Streaming({ sessionId, p, flat, maxWidth, inRoom }: { sessionId: string; p: ReturnType<typeof useTheme>['p']; flat: boolean; maxWidth: number; inRoom: boolean }) {
  const { onFeed } = useTeam()
  const [text, setText] = useState('')
  useEffect(() => {
    if (onFeed === undefined) return
    const attempts = new Map<string, string>()
    return onFeed((event, data) => {
      if (event !== 'stream' || data?.sessionId !== sessionId) return
      if (data.phase === 'start') attempts.set(data.attemptId, '')
      else if (typeof data.text === 'string') attempts.set(data.attemptId, (attempts.get(data.attemptId) ?? '') + data.text)
      else if (data.phase === 'end') attempts.delete(data.attemptId)
      setText([...attempts.values()].join(''))
    })
  }, [onFeed, sessionId])
  return text === '' ? null : <Item item={{ kind: 'bot', text }} p={p} flat={flat} maxWidth={maxWidth} inRoom={inRoom} sessionId={sessionId} />
}

const type = { caption: { fontSize: 12, lineHeight: 16 }, small: { fontSize: 13, lineHeight: 18 }, bubble: { fontSize: 16, lineHeight: 24 }, settingsRow: { fontSize: 16, lineHeight: 22 } }
const styles = StyleSheet.create({
  screen: { flex: 1 },
  loading: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingVertical: 8, paddingHorizontal: 12 },
  reader: { flex: 1, paddingTop: 60 },
  readerClose: { position: 'absolute', bottom: 30, alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20, borderWidth: 1 },
})
