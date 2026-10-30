import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { RpcClient } from '../../link/src/index.ts'
import { callBot, type Approval, type Bot, type Question } from './connection.ts'
import { BotMark } from './mark.tsx'
import type { Palette } from './theme.ts'

const POLL_MS = 2_500

export interface ChatItem {
  kind: 'bot' | 'user' | 'event' | 'answer' | 'view' | 'divider'
  text?: string
  time?: number
  seq?: number
  turn?: number
  role?: string
  name?: string
  images?: number
  title?: string
  questions?: { question: string }[]
  answers?: { selected?: string[]; custom?: string }[]
}

interface ChatPage {
  sessionId: string
  items: ChatItem[]
  cursor: unknown
}

const itemKey = (item: ChatItem, index: number) => `${item.kind}-${item.seq ?? item.time ?? index}-${index}`

// A fenced block keeps its own mono box; the rest is one paragraph per line.
function MessageText({ text, color, mono }: { text: string; color: string; mono: string }) {
  const parts = text.split(/```(?:[^\n]*)\n?/)
  return (
    <View>
      {parts.map((part, index) => index % 2 === 1
        ? <Text key={index} style={[styles.code, { color, backgroundColor: mono }]}>{part.replace(/\n$/, '')}</Text>
        : part !== '' && <Text key={index} style={[styles.bubbleText, { color }]} selectable>{part}</Text>)}
    </View>
  )
}

function QuestionCard({ question, sessionId, call, palette }: { question: Question; sessionId: string; call: (endpoint: string, payload: unknown) => Promise<unknown>; palette: Palette }) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const options = question.options ?? []

  const send = async (selected: string[]) => {
    setBusy(true)
    setFailed(false)
    try {
      await call('answer-question', { sessionId, questionId: question.id, answer: { selected, custom: custom.trim() } })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (label: string) => {
    if (question.multiSelect !== true) { void send([label]); return }
    const next = new Set(picked)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    setPicked(next)
  }

  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.line2 }]}>
      <Text style={[styles.cardTitle, { color: palette.ink }]}>{question.question}</Text>
      {question.detail ? <Text style={[styles.cardHint, { color: palette.ink2 }]}>{question.detail}</Text> : null}
      {options.map(option => (
        <Pressable key={option.label} accessibilityRole="button" disabled={busy} onPress={() => toggle(option.label)}
          style={[styles.option, { borderColor: picked.has(option.label) ? palette.accent : palette.line2, opacity: busy ? 0.5 : 1 }]}>
          <Text style={{ color: picked.has(option.label) ? palette.accent : palette.ink, fontSize: 14 }}>{option.label}</Text>
        </Pressable>
      ))}
      {question.multiSelect === true || options.length === 0
        ? <View style={styles.row}>
            <TextInput value={custom} onChangeText={setCustom} placeholder="Your answer" placeholderTextColor={palette.ink3}
              style={[styles.input, { color: palette.ink, backgroundColor: palette.hover }]} />
            <Pressable accessibilityRole="button" disabled={busy || (picked.size === 0 && custom.trim() === '')} onPress={() => void send([...picked])}
              style={[styles.send, { backgroundColor: palette.accent, opacity: busy || (picked.size === 0 && custom.trim() === '') ? 0.4 : 1 }]}>
              <Text style={{ color: palette.accentInk, fontSize: 15, fontWeight: '600' }}>↑</Text>
            </Pressable>
          </View>
        : null}
      {failed ? <Text style={[styles.cardHint, { color: palette.danger }]}>This question is no longer open.</Text> : null}
    </View>
  )
}

function ApprovalCard({ approval, call, palette }: { approval: Approval; call: (endpoint: string, payload: unknown) => Promise<unknown>; palette: Palette }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const answer = async (choice: 'allow' | 'reject') => {
    setBusy(true)
    setFailed(false)
    try {
      await call('approval-answer', { id: approval.id, choice })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.line2 }]}>
      <Text style={[styles.cardTitle, { color: palette.ink }]} numberOfLines={2}>{approval.tool || 'Approval'}</Text>
      {approval.reason !== '' ? <Text style={[styles.cardHint, { color: palette.ink2 }]} numberOfLines={4}>{approval.reason}</Text> : null}
      {approval.answerable === true
        ? <View style={styles.row}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void answer('allow')}
              style={[styles.choice, { backgroundColor: palette.accent, opacity: busy ? 0.5 : 1 }]}>
              <Text style={{ color: palette.accentInk, fontSize: 14, fontWeight: '600' }}>Allow</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void answer('reject')}
              style={[styles.choice, { backgroundColor: palette.hover, opacity: busy ? 0.5 : 1 }]}>
              <Text style={{ color: palette.ink, fontSize: 14 }}>Reject</Text>
            </Pressable>
          </View>
        : <Text style={[styles.cardHint, { color: palette.ink2 }]}>Answer on the computer.</Text>}
      {failed ? <Text style={[styles.cardHint, { color: palette.danger }]}>This approval is no longer open.</Text> : null}
    </View>
  )
}

function Item({ item, palette }: { item: ChatItem; palette: Palette }) {
  if (item.kind === 'divider') {
    return <Text style={[styles.divider, { color: palette.ink3 }]}>{typeof item.time === 'number' ? new Date(item.time).toLocaleDateString() : ''}</Text>
  }
  if (item.kind === 'event') {
    const label = { request: 'asked for work', reply: 'replied', report: 'reported back', stopped: 'stopped' }[item.role ?? ''] ?? item.role ?? 'event'
    return <Text style={[styles.event, { color: palette.ink3 }]}>{item.name ?? 'Bot'} {label}</Text>
  }
  if (item.kind === 'view') {
    return (
      <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.line2 }]}>
        <Text style={[styles.cardTitle, { color: palette.ink }]}>{item.title ?? 'View'}</Text>
      </View>
    )
  }
  if (item.kind === 'answer') {
    const text = item.answers?.map(answer => [...(answer.selected ?? []), ...(answer.custom ? [answer.custom] : [])].join(', ')).join('\n') ?? item.text ?? 'Answered'
    return (
      <View style={[styles.bubble, styles.userBubble, { backgroundColor: palette.user }]}>
        <Text style={[styles.bubbleText, { color: palette.userInk }]} selectable>{text}</Text>
      </View>
    )
  }
  if (item.kind === 'user') {
    return (
      <View style={[styles.bubble, styles.userBubble, { backgroundColor: palette.user }]}>
        <MessageText text={item.text ?? ''} color={palette.userInk} mono={palette.line2} />
        {item.images ? <Text style={[styles.cardHint, { color: palette.userInk }]}>{item.images} image{item.images > 1 ? 's' : ''}</Text> : null}
      </View>
    )
  }
  return (
    <View style={[styles.bubble, styles.botBubble, { backgroundColor: palette.bubble }]}>
      <MessageText text={item.text ?? ''} color={palette.ink} mono={palette.line2} />
    </View>
  )
}

export function ChatScreen({ client, bot, team, palette, dark, onBack, call }: {
  client: RpcClient | undefined
  bot: Bot
  team: { questions?: Record<string, Question>; work?: { approvals?: Approval[] } }
  palette: Palette
  dark: boolean
  onBack: () => void
  call: (endpoint: string, payload: unknown) => Promise<unknown>
}) {
  const [page, setPage] = useState<ChatPage | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const stopped = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const refresh = useCallback(async () => {
    const current = client
    if (current === undefined || stopped.current) return
    try {
      const next = await callBot<ChatPage>(current, 'chat', { botId: bot.id })
      if (!stopped.current) setPage(next)
    } catch { /* history stays; the link error shows in the header */ }
  }, [client, bot.id])

  useEffect(() => {
    stopped.current = false
    const loop = async () => {
      await refresh()
      if (!stopped.current) timer.current = setTimeout(() => void loop(), POLL_MS)
    }
    void loop()
    return () => { stopped.current = true; clearTimeout(timer.current) }
  }, [refresh])

  const send = async () => {
    const draft = text.trim()
    if (draft === '' || sending) return
    setSending(true)
    setError(null)
    try {
      await call('send', { sessionId: bot.sessionId ?? bot.id, text: draft })
      setText('')
      void refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSending(false)
    }
  }

  const sessionId = page?.sessionId ?? bot.sessionId ?? bot.id
  const question = sessionId !== undefined ? team.questions?.[sessionId] : undefined
  const approvals = (team.work?.approvals ?? []).filter(entry => entry.sessionId === sessionId)
  const items = [...(page?.items ?? [])].reverse()

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.screen, { backgroundColor: palette.main }]}>
      <View style={[styles.header, { backgroundColor: palette.sidebar, borderBottomColor: palette.line }]}>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}>
          <Text style={{ color: palette.accent, fontSize: 28, marginTop: -4 }}>‹</Text>
        </Pressable>
        <BotMark bot={bot} dark={dark} size={36} />
        <View style={styles.headerCopy}>
          <Text style={[styles.headerName, { color: palette.ink }]} numberOfLines={1}>{bot.name}</Text>
          <Text style={[styles.headerStatus, { color: palette.ink2 }]} numberOfLines={1}>{bot.role ?? ''}</Text>
        </View>
      </View>
      {question ? <QuestionCard question={question} sessionId={sessionId} call={call} palette={palette} /> : null}
      {approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} call={call} palette={palette} />)}
      {page === null
        ? <ActivityIndicator style={styles.loading} color={palette.accent} />
        : <FlatList
            style={styles.list}
            contentContainerStyle={styles.listContent}
            data={items}
            inverted
            keyExtractor={itemKey}
            renderItem={({ item }) => <Item item={item} palette={palette} />}
            ListEmptyComponent={<Text style={[styles.event, { color: palette.ink3, transform: [{ scaleY: -1 }] }]}>No messages yet</Text>}
          />}
      {error ? <Text style={[styles.error, { color: palette.danger }]} accessibilityRole="alert">{error}</Text> : null}
      <View style={[styles.composer, { backgroundColor: palette.sidebar, borderTopColor: palette.line }]}>
        <TextInput value={text} onChangeText={setText} placeholder={`Message ${bot.name}`} placeholderTextColor={palette.ink3}
          multiline style={[styles.composerInput, { color: palette.ink, backgroundColor: palette.hover }]} accessibilityLabel="Message" />
        <Pressable accessibilityRole="button" disabled={sending || text.trim() === ''} onPress={() => void send()}
          style={[styles.send, { backgroundColor: palette.accent, opacity: sending || text.trim() === '' ? 0.4 : 1 }]}>
          <Text style={{ color: palette.accentInk, fontSize: 15, fontWeight: '600' }}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 56, paddingBottom: 10, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  headerName: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  headerStatus: { fontSize: 12, lineHeight: 16 },
  loading: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingVertical: 8, paddingHorizontal: 12, gap: 4 },
  bubble: { maxWidth: '82%', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7, marginVertical: 2 },
  botBubble: { alignSelf: 'flex-start' },
  userBubble: { alignSelf: 'flex-end' },
  bubbleText: { fontSize: 14, lineHeight: 24 },
  code: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 20, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, marginVertical: 3 },
  divider: { alignSelf: 'center', fontSize: 12, lineHeight: 16, marginVertical: 8 },
  event: { alignSelf: 'center', fontSize: 12, lineHeight: 16, marginVertical: 4, textAlign: 'center' },
  card: { marginHorizontal: 12, marginVertical: 6, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12 },
  cardTitle: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  cardHint: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  option: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  input: { flex: 1, minHeight: 40, borderRadius: 10, paddingHorizontal: 12, fontSize: 15 },
  choice: { flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  error: { marginHorizontal: 16, marginBottom: 4, fontSize: 13, textAlign: 'center' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24, borderTopWidth: StyleSheet.hairlineWidth },
  composerInput: { flex: 1, borderRadius: 18, paddingHorizontal: 14, paddingTop: 9, paddingBottom: 9, fontSize: 15, maxHeight: 110 },
})
