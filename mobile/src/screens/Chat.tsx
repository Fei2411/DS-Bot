import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
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
  const botsById = useMemo(() => new Map((team?.bots ?? []).map(entry => [entry.id, entry])), [team?.bots])
  const canStop = room !== undefined ? roomWork.length > 0 : running

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={Platform.OS === 'ios' ? -insets.bottom : 0} style={[styles.screen, { backgroundColor: p.main }]}>
      {header}
      {room !== undefined && (room as { goal?: Goal }).goal ? <GoalBar goal={(room as { goal?: Goal }).goal!} p={p} /> : null}
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
              {items.map((item, index) => { const key = itemKey(item, index); const skey = item.kind === 'steps' ? `steps-${item.turn ?? index}` : key; return <Item key={key} stamp={room !== undefined ? undefined : stampOf(items, index)} author={room !== undefined && item.botId !== undefined ? botsById.get(item.botId) : undefined} admin={room !== undefined && item.botId !== undefined && item.botId === room.admin} item={item} p={p} flat={flat} maxWidth={item.kind === 'bot' ? botMax : userMax} inRoom={room !== undefined} sessionId={sessionId} onLongPress={onLongPress} onOpenFile={openFile} open={openSteps[skey]} onToggle={toggleOf(skey)} /> })}
              <Streaming key={sessionId} sessionId={sessionId} p={p} flat={flat} maxWidth={botMax} inRoom={room !== undefined} />
              {items.length === 0 ? <Text style={[type.caption, { color: p.ink3, textAlign: 'center' }]}>{t('No messages yet')}</Text> : null}
            </ScrollView>}
      {bot?.blocked !== undefined ? <BlockedCard bot={bot} p={p} /> : null}
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

// As on the desktop, a run of one Bot's bubbles ends with the time of its last one,
// and each user message carries its own.
function stampOf(items: ChatItem[], index: number): string | undefined {
  const item = items[index]
  if (typeof item.time !== 'number') return undefined
  if (item.kind === 'user') return messageClock(item.time)
  if (item.kind !== 'bot') return undefined
  const next = items[index + 1]
  if (next !== undefined && next.kind === 'bot' && (next.name ?? '') === (item.name ?? '')) return undefined
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
          <Text style={[type.small, { color: p.ink3, width: 18 }]}>{i + 1}</Text>
          <Text style={[type.small, { color: stage.status === 'passed' ? p.ink3 : p.ink, flex: 1 }]}>{stage.title ?? ''}</Text>
          {stage.status === 'passed' ? <Text style={{ color: p.green, fontSize: 13 }}>✓</Text> : null}
        </View>
      )) : null}
    </Pressable>
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
        {key ? <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Providers')} style={[styles.fix, { backgroundColor: p.accent }]}><Text style={{ color: p.accentInk, fontWeight: '600' }}>{blocked.code === 'MISSING_CREDENTIAL' ? t('Enter API key') : t('Enter the key again')}</Text></Pressable> : null}
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
  goal: { marginHorizontal: 12, marginBottom: 6, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 10 },
  blocked: { marginHorizontal: 12, marginBottom: 8, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  fix: { minHeight: 40, borderRadius: 20, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  readerClose: { position: 'absolute', bottom: 30, alignSelf: 'center', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20, borderWidth: 1 },
})
