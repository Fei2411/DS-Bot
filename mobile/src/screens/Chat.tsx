import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, Dimensions, FlatList, KeyboardAvoidingView, Linking, Modal, Pressable, StyleSheet, Text, View, ScrollView, type ListRenderItem } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import type { Approval, Bot, Question, Room } from '../connection.ts'
import { createChatCache } from '../team/chat-cache.ts'
import { useTeam } from '../team/context.tsx'
import { markSeen } from '../team/seen.ts'
import { messageClock, t } from '../ui/i18n.ts'
import { shadow, useTheme } from '../ui/tokens.ts'
import { Avatar, RoomAvatar } from '../ui/marks.tsx'
import { ArrowDownIcon } from '../ui/icons.tsx'
import { workPhrase } from '../ui/phrases.ts'
import { ActionRow, Dock } from './chat/dock.tsx'
import { Composer, type Photo } from './chat/composer.tsx'
import { Actions, Item, keysOf, PhotoViewer, PhotoViewerCtx, type ChatItem, type ImageRef } from './chat/items.tsx'

// Feed events refresh the chat as things happen; the poll only catches what a
// dropped event missed, so it runs rarely.
const POLL_MS = 15_000
// Room between the composer and an open keyboard; the composer's own bottom margin
// is the safe area, which the keyboard covers.
const KEYBOARD_GAP = 6

interface ChatPage { sessionId?: string; items: ChatItem[]; cursor: unknown }
interface Row { item: ChatItem; key: string; stamp?: string }

// A refreshed page reuses the item objects that did not change, so the memoized
// rows keep their identity and only new or changed rows render again.
function keepSame(prev: ChatItem[], next: ChatItem[]): ChatItem[] {
  const prevKeys = keysOf(prev)
  const known = new Map(prev.map((item, index) => [prevKeys[index], item]))
  const nextKeys = keysOf(next)
  let same = prev.length === next.length
  const merged = next.map((item, index) => {
    const old = known.get(nextKeys[index])
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(item)) { if (prev[index] !== old) same = false; return old }
    same = false
    return item
  })
  return same ? prev : merged
}

// The last page of each chat opened in this run, so going back to a chat shows it at
// once and the read only brings what changed. Kept in memory only.
const PAGES_KEPT = 16
const pages = createChatCache<ChatPage, ChatItem>(PAGES_KEPT)

// A chat read started before the chat is on screen: on launch the last chat is asked
// for while the team state is still on its way, and the chat takes that answer.
const reads = new Map<string, Promise<ChatPage>>()
const readChat = (call: (endpoint: string, payload?: unknown) => Promise<unknown>, room: boolean, id: string) =>
  (room ? call('room-chat', { roomId: id, steps: true }) : call('chat', { botId: id, steps: true })) as Promise<ChatPage>
export function prefetchChat(call: (endpoint: string, payload?: unknown) => Promise<unknown>, computerId: string, target: { kind: 'bot' | 'room'; id: string }) {
  const key = `${computerId}:${target.kind}:${target.id}`
  if (pages.has(key) || reads.has(key)) return
  const read = readChat(call, target.kind === 'room', target.id)
  reads.set(key, read)
  read.catch(() => {}).finally(() => { if (reads.get(key) === read) setTimeout(() => reads.delete(key), 5000) })
}

// Messages the phone sent that the chat has not shown back yet, per chat. They live
// outside the screen so a send keeps going, and stays visible, across chat switches.
interface Outgoing { item: ChatItem; photos: Photo[]; sessionId: string; known?: Set<string> }
const outbox = new Map<string, Outgoing[]>()
const outboxListeners = new Set<() => void>()
const EMPTY: Outgoing[] = []
const outboxOf = (key: string) => outbox.get(key) ?? EMPTY
function setOutbox(key: string, update: (list: Outgoing[]) => Outgoing[]) {
  const next = update(outboxOf(key))
  if (next.length === 0) outbox.delete(key); else outbox.set(key, next)
  for (const listener of outboxListeners) listener()
}
const subscribeOutbox = (listener: () => void) => { outboxListeners.add(listener); return () => { outboxListeners.delete(listener) } }

// The same message as the phone sent: the text the computer keeps (trimmed) and as many photos.
const sameMessage = (item: ChatItem, sent: ChatItem) =>
  item.kind === 'user' && (item.text ?? '').trim() === (sent.text ?? '').trim()
  && (item.imageRefs?.length ?? item.images ?? 0) === (sent.localImages?.length ?? 0)

// The shared chat body for both shells: an inverted list (newest at the bottom, older
// pages load as it scrolls up), the pending dock and the composer. `header` is the
// shell's own (back row or pill).
export function ChatView({ bot, room, header, onMissing }: { bot?: Bot; room?: Room; header: React.ReactNode; onMissing?: () => void }) {
  const { team, call, computer, hello } = useTeam()
  const { p, dark } = useTheme()
  const insets = useSafeAreaInsets()
  const id = bot?.id ?? room?.id ?? ''
  const chatKey = `${computer?.hostDeviceId ?? ''}:${room !== undefined ? 'room' : 'bot'}:${id}`
  const cached = pages.get(chatKey)
  const [pageState, setPageState] = useState<{ key: string; page: ChatPage | null; older: ChatItem[] }>(() => ({
    key: chatKey,
    page: cached?.page ?? null,
    older: cached?.older ?? [],
  }))
  const page = pageState.key === chatKey ? pageState.page : (cached?.page ?? null)
  const older = pageState.key === chatKey ? pageState.older : (cached?.older ?? [])
  const cursor = useRef<unknown>(cached?.cursor)
  const [gone, setGone] = useState(false)
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({})
  // A failed load clears itself on the next good one.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [awayFromLatest, setAwayFromLatest] = useState(false)
  // Each poll loop owns a generation number; a chat switch bumps it so stale
  // loops and in-flight refreshes stop writing instead of fighting the new chat.
  const generation = useRef(0)
  const list = useRef<FlatList<Row>>(null)
  const loading = useRef(false)

  // One chat read at a time, like the team state: a burst of messages becomes one
  // read now and at most one more after it.
  const reading = useRef(false)
  const again = useRef(false)
  const refresh = useCallback(async (gen: number): Promise<void> => {
    if (id === '' || generation.current !== gen) return
    if (reading.current) { again.current = true; return }
    reading.current = true
    try {
      const early = reads.get(chatKey)
      reads.delete(chatKey)
      const next = await (early ?? readChat(call, room !== undefined, id))
      if (generation.current === gen) {
        setPageState(prev => ({
          key: chatKey,
          older: prev.key === chatKey ? prev.older : [],
          page: prev.key === chatKey && prev.page !== null && prev.page.sessionId === next.sessionId
            ? { ...next, items: keepSame(prev.page.items, next.items) }
            : next,
        }))
        if (cursor.current === undefined) cursor.current = next.cursor
        setLoadError(null)
      }
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
  }, [call, id, chatKey])
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => {
    const gen = ++generation.current
    const kept = pages.get(chatKey)
    setPageState({ key: chatKey, page: kept?.page ?? null, older: kept?.older ?? [] })
    cursor.current = kept?.cursor
    setGone(false)
    setAwayFromLatest(false)
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = async () => {
      await refresh(gen)
      if (generation.current === gen) timer = setTimeout(() => void loop(), POLL_MS)
    }
    void loop()
    return () => { clearTimeout(timer); if (generation.current === gen) generation.current += 1 }
  }, [refresh, chatKey])

  // What this chat shows is kept for the next visit.
  useEffect(() => {
    if (pageState.page !== null) pages.keep(chatKey, pageState.key, { page: pageState.page, older: pageState.older, cursor: cursor.current })
  }, [pageState, chatKey])

  // The page before the oldest one shown. cursor lives in a ref: the list can ask
  // again before the state from the previous load commits.
  const loadMore = useCallback(async () => {
    if (cursor.current == null || id === '' || loading.current) return
    const gen = generation.current
    loading.current = true
    setLoadingOlder(true)
    try {
      const next = (room !== undefined
        ? await call('room-chat', { roomId: room.id, cursor: cursor.current, steps: true })
        : await call('chat', { botId: id, cursor: cursor.current, steps: true })) as ChatPage
      if (generation.current !== gen) return
      cursor.current = next.cursor
      setPageState(prev => (prev.key !== chatKey ? prev : { ...prev, older: [...next.items, ...prev.older] }))
    } catch { /* keep the page we have */ }
    finally { loading.current = false; setLoadingOlder(false) }
  }, [call, id, room?.id, chatKey])

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
  const [chatWidth, setChatWidth] = useState(() => Math.max(0, Dimensions.get('window').width - 24))
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [menuText, setMenuText] = useState<string | null>(null)
  const [readerText, setReaderText] = useState<string | null>(null)
  const [readerTitle, setReaderTitle] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [photos, setPhotos] = useState<{ sessionId: string; refs: ImageRef[]; index: number } | null>(null)
  const openFile = useCallback((file: { name: string; attachmentId?: string }) => {
    void call('file-text', { file }).then(result => {
      const read = result as { text?: string; truncated?: boolean } | string
      setReaderTitle(file.name)
      setReaderText(typeof read === 'string' ? read : read?.text ?? '')
    }, (failure: { code?: string; message?: string }) => setFileError(failure?.message ?? t('This file cannot be read here')))
  }, [call])
  // One stable toggle per steps row, so a memoized row is not redrawn for a new closure.
  const toggles = useRef(new Map<string, () => void>())
  const toggleOf = (key: string) => {
    let toggle = toggles.current.get(key)
    if (toggle === undefined) { toggle = () => setOpenSteps(prev => ({ ...prev, [key]: !prev[key] })); toggles.current.set(key, toggle) }
    return toggle
  }
  const { onFeed, online } = useTeam()
  useEffect(() => { markSeen(id) }, [id])
  // Back online after a drop: read what was missed. Not on mount, which reads already.
  const wasOnline = useRef(online)
  useEffect(() => {
    if (online && !wasOnline.current) void refresh(generation.current)
    wasOnline.current = online
  }, [online, refresh])
  useEffect(() => {
    if (onFeed === undefined) return
    const gen = generation.current
    return onFeed((event, data) => {
      if (generation.current !== gen) return
      if (event === 'room' && room !== undefined && data?.roomId === room.id) void refresh(gen)
      if (event === 'message' && data?.sessionId === sessionId) {
        const item = data.item
        if (item !== undefined) {
          setPageState(prev => prev.key !== chatKey || prev.page === null || prev.page.items.some(it => it.seq !== undefined && it.seq === item.seq)
            ? prev
            : { ...prev, page: { ...prev.page, items: [...prev.page.items, item] } })
        }
        markSeen(id)
        void refresh(gen)
      }
    })
  }, [onFeed, room, sessionId, refresh, id])
  // Bubble caps in px — RN cannot parse CSS min(). Narrow phone screens ignore the
  // desktop's wide-window column slider so bubbles do not waste a third of the screen;
  // group rows reserve 30px (22px avatar + 8px gap) on the left.
  const narrow = chatWidth < 520
  const roomOffset = room !== undefined && !flat ? 30 : 0
  const botSpan = Math.max(0, chatWidth - roomOffset)
  const botMax = chatWidth === 0 ? 0 : Math.round(Math.min(botSpan * (narrow ? 0.93 : width / 100), botSpan - (narrow ? 8 : 40)))
  const userMax = Math.round(chatWidth * (narrow ? 0.86 : width / 100))

  // Sending: the message shows at once and the composer clears; photos travel one
  // by one, then the message names them. It stays until the chat shows it back.
  const pending = useSyncExternalStore(subscribeOutbox, () => outboxOf(chatKey))
  const deliver = useCallback(async (key: string, entry: Outgoing) => {
    const localId = entry.item.localId!
    const mark = (local: ChatItem['local'], known?: Set<string>) => setOutbox(key, list => list.map(o => o.item.localId === localId ? { ...o, item: { ...o.item, local }, known: known ?? o.known } : o))
    mark('sending')
    try {
      const images: string[] = []
      for (const photo of entry.photos) images.push(((await call('stage-image', { mediaType: photo.mediaType, data: photo.data })) as { id: string }).id)
      await call('send', { sessionId: entry.sessionId, text: entry.item.text ?? '', ...(images.length > 0 ? { images } : {}) })
      // What the chat already holds, so only a new row of the same text counts as this one.
      const kept = pages.get(key)
      const all = [...(kept?.older ?? []), ...(kept?.page.items ?? [])]
      const keys = keysOf(all)
      mark('sending', new Set(all.map((item, index) => keys[index])))
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      if (key === latestKey.current) void latest.current(generation.current)
    } catch (failure) {
      mark('failed')
      if (key === latestKey.current) setLoadError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [call])
  const latestKey = useRef(chatKey)
  latestKey.current = chatKey
  const send = async (text: string, photos: Photo[]) => {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const entry: Outgoing = { item: { kind: 'user', text, local: 'sending', localId, time: Date.now(), ...(photos.length > 0 ? { localImages: photos.map(photo => photo.uri) } : {}) }, photos, sessionId }
    setOutbox(chatKey, list => [...list, entry])
    // Once the new row is laid out, bring the latest messages into view.
    setTimeout(() => list.current?.scrollToOffset({ offset: 0, animated: true }), 60)
    void deliver(chatKey, entry)
  }
  const retry = useCallback((localId: string, discard?: boolean) => {
    const entry = outboxOf(chatKey).find(o => o.item.localId === localId)
    if (entry === undefined) return
    if (discard === true) { setOutbox(chatKey, list => list.filter(o => o !== entry)); return }
    setLoadError(null)
    void deliver(chatKey, entry)
  }, [chatKey, deliver])
  const stop = () => {
    if (room !== undefined) void call('stop-room-work', { roomId: room.id }).catch(() => {})
    else if (bot !== undefined) void call('stop-chat', { botId: bot.id }).catch(() => {})
  }

  // Chronological rows (oldest first) with stable keys and the desktop's time stamps.
  const items = useMemo(() => [...older, ...(page?.items ?? [])], [page, older])
  // A sent message leaves the outbox once the chat shows a new row with its text.
  useEffect(() => {
    if (pending.length === 0) return
    const keys = keysOf(items)
    const shown = pending.filter(o => o.known !== undefined && items.some((item, index) => !o.known!.has(keys[index]) && sameMessage(item, o.item)))
    if (shown.length > 0) setOutbox(chatKey, list => list.filter(o => !shown.includes(o)))
  }, [items, pending, chatKey])
  const rows = useMemo<Row[]>(() => {
    const all = [...items, ...pending.map(o => o.item)]
    const keys = keysOf(all)
    // Inverted list: index 0 sits at the bottom, so the newest row comes first.
    return all.map((item, index) => ({ item, key: keys[index], stamp: room !== undefined || item.local !== undefined ? undefined : stampOf(all, index) })).reverse()
  }, [items, pending, room !== undefined])
  // Group rows show each member's name, color and mark; a team refresh that changes
  // none of these keeps the same map, so the rows are not drawn again.
  const memberKey = JSON.stringify((team?.bots ?? []).map(entry => [entry.id, entry.name, entry.color, entry.avatar?.shape, entry.avatar?.imageRef ?? entry.avatar?.image?.length]))
  const botsById = useMemo(() => new Map((team?.bots ?? []).map(entry => [entry.id, entry])), [memberKey])
  const canStop = room !== undefined ? roomWork.length > 0 : running
  const inRoom = room !== undefined
  const admin = room?.admin

  const renderRow = useCallback<ListRenderItem<Row>>(({ item: row }) => {
    const { item } = row
    const skey = item.kind === 'steps' ? row.key : row.key
    return <Item stamp={row.stamp} author={inRoom && item.botId !== undefined ? botsById.get(item.botId) : undefined} admin={inRoom && item.botId !== undefined && item.botId === admin}
      item={item} p={p} flat={flat} maxWidth={item.kind === 'bot' || item.kind === 'post' ? botMax : userMax} inRoom={inRoom} sessionId={sessionId}
      onLongPress={setMenuText} onOpenFile={openFile} onRetry={retry} open={openSteps[skey]} onToggle={toggleOf(skey)} />
  }, [inRoom, botsById, admin, p, flat, botMax, userMax, sessionId, openFile, retry, openSteps])

  const empty = page !== null && rows.length === 0
  return (
    <PhotoViewerCtx.Provider value={setPhotos}>
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={KEYBOARD_GAP - insets.bottom} style={[styles.screen, { backgroundColor: p.main }]}>
      {header}
      {room !== undefined && (room as { goal?: Goal }).goal ? <GoalBar goal={(room as { goal?: Goal }).goal!} p={p} /> : null}
      <View style={styles.list} onLayout={event => setChatWidth(event.nativeEvent.layout.width - 24)}>
        {gone
          ? <Text style={[type.caption, { color: p.ink3, textAlign: 'center', marginTop: 24 }]}>{t('No messages yet')}</Text>
          : page === null && loadError !== null
            ? <View style={{ alignItems: 'center', marginTop: 24 }}>
                <Text style={[type.caption, { color: p.ink3, textAlign: 'center' }]}>{loadError}</Text>
                <Text accessibilityRole="button" style={[type.caption, { color: p.accent, marginTop: 8 }]} onPress={() => { setLoadError(null); void refresh(generation.current) }}>{t('Retry')}</Text>
              </View>
          : page === null || chatWidth <= 0
            ? <ActivityIndicator style={styles.loading} color={p.accent} />
            : <FlatList
                ref={list}
                inverted
                data={rows}
                keyExtractor={row => row.key}
                renderItem={renderRow}
                extraData={openSteps}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
                initialNumToRender={14}
                maxToRenderPerBatch={10}
                windowSize={11}
                onEndReached={() => void loadMore()}
                onEndReachedThreshold={0.6}
                maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 120 }}
                onScroll={event => { const away = event.nativeEvent.contentOffset.y > 600; if (away !== awayFromLatest) setAwayFromLatest(away) }}
                scrollEventThrottle={100}
                ListHeaderComponent={<Streaming key={sessionId} sessionId={sessionId} p={p} flat={flat} maxWidth={botMax} inRoom={inRoom} />}
                ListFooterComponent={loadingOlder ? <ActivityIndicator style={{ marginVertical: 12 }} color={p.ink3} /> : undefined}
              />}
        {empty && !gone ? <EmptyChat bot={bot} room={room} bots={team?.bots ?? []} p={p} dark={dark} /> : null}
        {awayFromLatest ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('Latest messages')} onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
            style={[styles.toLatest, { backgroundColor: p.card, borderColor: p.line2 }, shadow(2)]}>
            <ArrowDownIcon size={18} color={p.ink2} />
          </Pressable>
        ) : null}
      </View>
      {bot?.blocked !== undefined ? <BlockedCard bot={bot} p={p} /> : null}
      {bot !== undefined ? <ComputerCards bot={bot} p={p} /> : null}
      {running && doingBot ? <ActionRow bot={doingBot} doing={doingText} p={p} dark={dark} /> : null}
      <Dock question={question} sessionId={sessionId} approvals={approvals} secrets={secrets} btw={btw} handoff={browserHold} view={team?.views?.[sessionId]} call={call} p={p} expanded={expandedKey} onExpand={setExpandedKey} />
      {fileError ? <Text style={[type.small, { color: p.danger, textAlign: 'center', marginBottom: 4 }]} accessibilityRole="alert">{fileError}</Text> : null}
      {page !== null && loadError !== null ? <Text style={[type.small, { color: p.danger, textAlign: 'center', marginBottom: 4, marginHorizontal: 16 }]} accessibilityRole="alert">{loadError}</Text> : null}
      <Composer name={bot?.name ?? room?.name ?? ''} running={running} canStop={canStop} canAttach={hello?.capabilities?.includes('send-images') === true} onSend={send} onStop={stop} p={p} />
      <Actions visible={menuText !== null} text={menuText ?? ''} p={p}
        onClose={() => setMenuText(null)}
        onSelect={() => { setReaderTitle(null); setReaderText(menuText); setMenuText(null) }} />
      <Modal visible={readerText !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setReaderText(null)}>
        <View style={[styles.reader, { backgroundColor: p.main }]}>
          <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 24, paddingBottom: 100 }}>
            {readerTitle !== null ? <Text style={[type.caption, { color: p.ink3, marginBottom: 10 }]}>{readerTitle}</Text> : null}
            <Text selectable style={[type.bubble, { color: p.ink, fontFamily: readerTitle === null || readerTitle.match(/\.(md|markdown|txt)$/i) ? undefined : 'monospace' }]}>{readerText ?? ''}</Text>
          </ScrollView>
          <Pressable accessibilityRole="button" onPress={() => setReaderText(null)} style={[styles.readerClose, { backgroundColor: p.card, borderColor: p.line, bottom: insets.bottom + 16 }]}>
            <Text style={[type.settingsRow, { color: p.accent }]}>{t('Done')}</Text>
          </Pressable>
        </View>
      </Modal>
      <PhotoViewer open={photos} onClose={() => setPhotos(null)} />
    </KeyboardAvoidingView>
    </PhotoViewerCtx.Provider>
  )
}

// A chat with nothing in it yet: who it is with, large, where the messages will be.
function EmptyChat({ bot, room, bots, p, dark }: { bot?: Bot; room?: Room; bots: Bot[]; p: ReturnType<typeof useTheme>['p']; dark: boolean }) {
  return (
    <View pointerEvents="none" style={styles.empty}>
      {bot !== undefined ? <Avatar bot={bot} dark={dark} size={64} ring={p.main} /> : room !== undefined ? <RoomAvatar room={room} bots={bots} dark={dark} size={64} ring={p.main} /> : null}
      <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600', marginTop: 12 }]} numberOfLines={1}>{bot?.name ?? room?.name ?? ''}</Text>
      {bot?.role ? <Text style={[type.small, { color: p.ink3, marginTop: 2 }]} numberOfLines={1}>{bot.role}</Text> : null}
      <Text style={[type.caption, { color: p.ink3, marginTop: 10 }]}>{t('No messages yet')}</Text>
    </View>
  )
}

// As on the desktop, a run of one Bot's bubbles ends with the time of its last one,
// and each user message carries its own.
function stampOf(items: ChatItem[], index: number): string | undefined {
  const item = items[index]
  if (typeof item.time !== 'number') return undefined
  if (item.kind === 'user') return messageClock(item.time)
  if (item.kind !== 'bot' && item.kind !== 'post') return undefined
  const next = items[index + 1]
  if (next !== undefined && (next.kind === 'bot' || next.kind === 'post') && (next.name ?? '') === (item.name ?? '')) return undefined
  return messageClock(item.time)
}

// A group's goal, as the desktop's goal island (goal.js goalView) shows it: the goal
// and the stage it is at, the stage bar, and on a tap every stage with its state.
interface Goal { status?: string; idle?: boolean; title?: string; current?: number; stages?: { title?: string; status?: string; tasks?: { status?: string }[] }[] }
const REPORTED = new Set(['reported', 'done'])
const RUNNING = new Set(['active', 'paused'])
function GoalBar({ goal, p }: { goal: Goal; p: ReturnType<typeof useTheme>['p'] }) {
  const [open, setOpen] = useState(false)
  const stages = goal.stages ?? []
  const at = goal.current ?? 0
  const current = RUNNING.has(goal.status ?? '') ? stages[at] : undefined
  const checking = current !== undefined && (current.tasks ?? []).every(task => REPORTED.has(task.status ?? ''))
  const number = goal.status === 'drafting' ? undefined : goal.status === 'stopped' ? stages.filter(stage => stage.status === 'passed').length : current !== undefined ? at + 1 : stages.length
  const label = goal.status === 'drafting' ? t('Aligning the goal with you')
    : goal.status === 'stopped' ? t('Stopped')
      : goal.status === 'complete' ? t('Goal reached')
        : goal.status === 'paused' ? (current ? t('Paused · {title}', { title: current.title ?? '' }) : t('Paused'))
          : goal.idle === true ? (current ? t('Waiting for you · {title}', { title: current.title ?? '' }) : t('Waiting for you'))
            : current === undefined ? t('Final check')
              : checking ? t('Checking · {title}', { title: current.title ?? '' }) : current.title ?? ''
  const segment = (i: number) => stages[i].status === 'passed' ? p.green : i === at && RUNNING.has(goal.status ?? '') ? p.accent : p.line
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(on => !on)}
      style={[styles.goal, { backgroundColor: p.card, borderColor: p.line }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600', flex: 1 }]} numberOfLines={1}>{goal.title ?? ''}</Text>
        {number !== undefined ? <Text style={[type.caption, { color: p.ink3 }]}>{`${number}/${stages.length}`}</Text> : null}
      </View>
      <Text style={[type.small, { color: p.ink2, marginTop: 2 }]} numberOfLines={open ? undefined : 1}>{label}</Text>
      {stages.length > 0 ? <View style={{ flexDirection: 'row', gap: 3, marginTop: 8 }}>{stages.map((_, i) => <View key={i} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: segment(i) }} />)}</View> : null}
      {open ? stages.map((stage, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <Text style={[type.small, { color: p.ink3, minWidth: 18, fontVariant: ['tabular-nums'] }]}>{i + 1}</Text>
          <Text style={[type.small, { color: stage.status === 'passed' ? p.ink3 : p.ink, flex: 1, minWidth: 0 }]}>{stage.title ?? ''}</Text>
          {stage.status === 'passed' ? <Text style={{ color: p.green, fontSize: 13 }}>✓</Text> : null}
        </View>
      )) : null}
    </Pressable>
  )
}

// Computer use (computer.js): a Bot's ask to use an app, answered Deny / This time /
// Always, and a bar with Stop while it holds the computer.
function ComputerCards({ bot, p }: { bot: Bot; p: ReturnType<typeof useTheme>['p'] }) {
  const { team, call } = useTeam()
  const [error, setError] = useState<string | null>(null)
  const live = (team as { computerLive?: { bots?: Record<string, { state?: string; app?: string }>; asks?: Record<string, { id: string; botId: string; appName?: string }> } } | null)?.computerLive
  const asks = Object.values(live?.asks ?? {}).filter(ask => ask.botId === bot.id)
  const control = live?.bots?.[bot.id]
  const acting = control !== undefined && control.state !== undefined && control.state !== 'idle'
  const act = (endpoint: string, body: Record<string, unknown>) => { call(endpoint, body).then(() => setError(null), (failure: Error) => setError(failure?.message ?? String(failure))) }
  if (asks.length === 0 && !acting) return null
  return (
    <View>
      {asks.map(ask => (
        <View key={ask.id} style={[styles.blocked, { backgroundColor: p.card, borderColor: p.line }]}>
          <Text style={[type.settingsRow, { color: p.ink }]}>{t('Allow {name} to use {app}?', { name: bot.name, app: ask.appName ?? '' })}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            <Pressable accessibilityRole="button" onPress={() => act('computer-app-answer', { id: ask.id, answer: 'deny' })} style={[styles.fix, { backgroundColor: p.hover }]}><Text style={{ color: p.ink }}>{t('Deny')}</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => act('computer-app-answer', { id: ask.id, answer: 'once' })} style={[styles.fix, { backgroundColor: p.hover }]}><Text style={{ color: p.ink }}>{t('This time')}</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => act('computer-app-answer', { id: ask.id, answer: 'always' })} style={[styles.fix, { backgroundColor: p.accent }]}><Text style={{ color: p.accentInk, fontWeight: '600' }}>{t('Always')}</Text></Pressable>
          </View>
        </View>
      ))}
      {acting ? (
        <View style={[styles.blocked, { backgroundColor: p.card, borderColor: p.line, flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }]}>
          <Text style={[type.small, { color: p.ink, flex: 1 }]} numberOfLines={1}>{control?.app ? `${t('Computer use')} · ${control.app}` : t('Computer use')}</Text>
          <Pressable accessibilityRole="button" onPress={() => act('computer-stop', { botId: bot.id })} style={[styles.fix, { backgroundColor: p.hover, minHeight: 36 }]}><Text style={{ color: p.danger }}>{t('Stop')}</Text></Pressable>
        </View>
      ) : null}
      {error ? <Text style={[type.small, { color: p.danger, marginHorizontal: 16, marginBottom: 6 }]}>{error}</Text> : null}
    </View>
  )
}

// The desktop's repair card (turn-error.js) for a failure only the user can fix: what
// went wrong, by DSH's failure code, and the way to the fix.
function failureText(code: string, name: string, provider: string, status?: number): string {
  switch (code) {
    case 'MISSING_CREDENTIAL': return t("{name}'s model has no API key yet.", { name })
    case 'INVALID_CREDENTIAL': return t('This API key is not in the right format.')
    case 'AUTH': return status === undefined ? t('{provider} did not accept the current API key.', { provider }) : t('{provider} did not accept the current API key ({status}).', { provider, status })
    case 'QUOTA': return status === undefined ? t('{provider} is out of balance or quota.', { provider }) : t('{provider} is out of balance or quota ({status}).', { provider, status })
    case 'ACCOUNT_QUOTA': return t('The DeepSeek account balance is too low.')
    case 'ACCOUNT_SIGN_IN_REQUIRED': case 'ACCOUNT_SIGNED_OUT': case 'ACCOUNT_TOKEN_INVALID': return t('The DeepSeek account sign-in has expired.')
    default: return t('This turn failed.')
  }
}

function BlockedCard({ bot, p }: { bot: Bot; p: ReturnType<typeof useTheme>['p'] }) {
  const navigation = useNavigation<any>()
  const { team } = useTeam()
  const blocked = bot.blocked!
  const provider = (team?.models ?? []).find(model => model.ref.split('/')[0] === blocked.provider)?.providerName ?? blocked.provider ?? ''
  const key = ['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH'].includes(blocked.code)
  const topUp = blocked.code === 'QUOTA' && blocked.provider === 'deepseek-official' || blocked.code === 'ACCOUNT_QUOTA'
  return (
    <View style={[styles.blocked, { backgroundColor: p.card, borderColor: p.line }]} accessibilityRole="alert">
      <Text style={[type.settingsRow, { color: p.ink }]}>{failureText(blocked.code, bot.name, provider, blocked.status)}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {key ? <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Settings', { screen: 'Providers', initial: false })} style={[styles.fix, { backgroundColor: p.accent }]}><Text style={{ color: p.accentInk, fontWeight: '600' }}>{blocked.code === 'MISSING_CREDENTIAL' ? t('Enter API key') : t('Enter the key again')}</Text></Pressable> : null}
        {topUp ? <Pressable accessibilityRole="button" onPress={() => void Linking.openURL('https://platform.deepseek.com/top_up')} style={[styles.fix, { backgroundColor: p.accent }]}><Text style={{ color: p.accentInk, fontWeight: '600' }}>{t('Top up ↗')}</Text></Pressable> : null}
        <Pressable accessibilityRole="button" onPress={() => navigation.navigate('BotDetails', { botId: bot.id })} style={[styles.fix, { backgroundColor: p.hover }]}><Text style={{ color: p.ink }}>{t('Pick another model')}</Text></Pressable>
      </View>
    </View>
  )
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
      // Each attempt is its own reply part; the saved message shows them as separate bubbles.
      setText([...attempts.values()].filter(part => part !== '').join('\n\n'))
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
  reader: { flex: 1 },
  empty: { position: 'absolute', left: 24, right: 24, top: '28%', alignItems: 'center' },
  toLatest: { position: 'absolute', right: 14, bottom: 10, width: 38, height: 38, borderRadius: 19, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  goal: { marginHorizontal: 12, marginBottom: 6, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 10 },
  blocked: { marginHorizontal: 12, marginBottom: 8, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  fix: { minHeight: 40, borderRadius: 20, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  readerClose: { position: 'absolute', bottom: 30, alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20, borderWidth: 1 },
})
