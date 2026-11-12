import { useState } from 'react'
import * as Haptics from 'expo-haptics'
import { ChevronRightIcon } from '../../ui/icons.tsx'
import { ViewCard } from './view.tsx'
import { ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View, Pressable } from 'react-native'
import Animated, { useReducedMotion, useAnimatedStyle, withRepeat, withTiming, withSpring, useSharedValue, withSequence } from 'react-native-reanimated'
import { useEffect } from 'react'
import type { Approval, Question, ShownView } from '../../connection.ts'
import { t } from '../../ui/i18n.ts'
import { radius, shadow, SPRING_TAP, type as typeScale, type Palette } from '../../ui/tokens.ts'
import { Avatar } from '../../ui/marks.tsx'
import type { Bot } from '../../connection.ts'

type Call = (endpoint: string, payload?: unknown) => Promise<unknown>

// The pending dock above the composer: question card (ui-standard 10.8), then
// approval cards. Taller than 50% of the screen, the dock scrolls inside.
function useChevron(expanded: boolean) {
  const progress = useSharedValue(expanded ? 1 : 0)
  const reduced = useReducedMotion()
  useEffect(() => {
    progress.value = reduced ? (expanded ? 1 : 0) : withSpring(expanded ? 1 : 0, SPRING_TAP)
  }, [expanded])
  return useAnimatedStyle(() => ({ transform: [{ rotate: `${progress.value * 90}deg` }] }))
}

function AccordionCard({ title, dot, expanded, onToggle, p, children }: { title: string; dot?: boolean; expanded: boolean; onToggle: () => void; p: Palette; children: React.ReactNode }) {
  const chevron = useChevron(expanded)
  return (
    <View style={[styles.accordion, { backgroundColor: p.card, borderColor: p.line }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => { void Haptics.selectionAsync(); onToggle() }}
        style={{ flexDirection: 'row', alignItems: 'center', minHeight: 46, paddingHorizontal: 16, paddingVertical: 10, gap: 8 }}>
        <Text style={[typeScale.settingsRow, { color: p.ink, fontWeight: '600', flex: 1, minWidth: 0 }]} numberOfLines={expanded ? 4 : 1}>{title}</Text>
        {dot === true ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.accent, flexShrink: 0 }} /> : null}
        <Animated.View style={[chevron, { flexShrink: 0 }]}><ChevronRightIcon size={16} color={p.ink3} /></Animated.View>
      </Pressable>
      {expanded ? <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>{children}</View> : null}
    </View>
  )
}

export function Dock({ question, sessionId, approvals, secrets = [], btw = [], handoff, onViewBrowser, view, call, p, maxHeight, expanded, onExpand }: {
  view?: ShownView
  secrets?: SecretRequest[]; btw?: BtwCardData[]; handoff?: HandoffData; onViewBrowser?: () => void
  maxHeight?: number; expanded: string | null; onExpand: (key: string | null) => void
  question?: Question; sessionId: string; approvals: Approval[]; call: Call; p: Palette
}) {
  interface CardEntry { key: string; title: string; needs: boolean; order: number; body: React.ReactNode }
  const { height: windowHeight } = useWindowDimensions()
  const cap = maxHeight ?? Math.round(windowHeight * 0.52)
  const cards: CardEntry[] = []
  for (const approval of approvals) cards.push({ key: `approval-${approval.id}`, title: approval.tool ?? t('Approval'), needs: true, order: 0, body: <ApprovalCard approval={approval} call={call} p={p} bare /> })
  if (question !== undefined) cards.push({ key: 'question', title: question.question ?? t('Question'), needs: true, order: 1, body: <QuestionCard question={question} sessionId={sessionId} call={call} p={p} bare /> })
  for (const secret of secrets) cards.push({ key: `secret-${secret.id}`, title: secret.kind === 'allow' ? t('Allow a secret') : (secret.name ? t('{name} needs a key', { name: secret.name }) : t('A secret is needed')), needs: true, order: 2, body: <SecretCard secret={secret} call={call} p={p} bare /> })
  if (handoff !== undefined) cards.push({ key: 'handoff', title: t('Browser handoff'), needs: true, order: 3, body: <HandoffCard handoff={handoff} botId={sessionId.split(':')[0]} onView={onViewBrowser} call={call} p={p} bare /> })
  if (view !== undefined) cards.push({ key: `view-${view.id ?? 'view'}`, title: view.title || t('Card'), needs: true, order: 4, body: <ViewCard sessionId={sessionId} id={view.id} title={view.title} root={view.view} p={p} bare /> })
  for (const card of btw) cards.push({ key: `btw-${card.id}`, title: card.question ?? t('Aside'), needs: false, order: 5, body: <BtwCard card={card} sessionId={sessionId} call={call} p={p} bare /> })
  if (cards.length === 0) return null
  const chosen = cards.find(card => card.key === expanded)
  const active = chosen ?? cards.slice().sort((a, b) => a.order - b.order).find(card => card.needs) ?? cards[0]
  return (
    <ScrollView style={[styles.dock, { maxHeight: cap }]} contentContainerStyle={{ paddingBottom: 4 }} keyboardShouldPersistTaps="handled">
      {cards.map(card => (
        <AccordionCard key={card.key} title={card.title} dot={card.needs && card.key !== active.key && chosen === undefined} p={p}
          expanded={card.key === active.key} onToggle={() => onExpand(card.key === active.key && chosen !== undefined ? null : card.key)}>
          {card.body}
        </AccordionCard>
      ))}
    </ScrollView>
  )
}

export function QuestionCard({ question, sessionId, call, p , bare = false }: { question: Question; sessionId: string; call: Call; p: Palette; bare?: boolean }) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const options = question.options ?? []

  const send = async (selected: string[]) => {
    setBusy(true); setFailed(false)
    try { await call('answer-question', { sessionId, questionId: question.id, answer: { selected, custom: custom.trim() } }); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success) }
    catch { setFailed(true) } finally { setBusy(false) }
  }
  const toggle = (label: string) => {
    if (question.multiSelect !== true) { void send([label]); return }
    const next = new Set(picked)
    if (next.has(label)) next.delete(label); else next.add(label)
    setPicked(next)
  }

  return (
    <View style={bare ? undefined : [styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
      {bare ? null : <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]}>{question.question}</Text>}
      {question.detail ? <Text style={[type.small, { color: p.ink2, marginTop: 4 }]}>{question.detail}</Text> : null}
      <View style={{ marginTop: 12, borderRadius: radius.option, borderWidth: 1, borderColor: p.line, overflow: 'hidden' }}>
        {options.map((option, index) => (
          <Pressable key={option.label} accessibilityRole="button" disabled={busy} onPress={() => toggle(option.label)}
            style={({ pressed }) => [styles.option, index > 0 && { borderTopWidth: 1, borderTopColor: p.line }, pressed && { backgroundColor: p.hover }]}>
            <Text style={[type.settingsRow, { color: picked.has(option.label) ? p.accent : p.ink }]}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
      {question.multiSelect === true || options.length === 0
        ? <View style={styles.answerRow}>
            <TextInput value={custom} onChangeText={setCustom} placeholder={t('Your answer')} placeholderTextColor={p.ink3}
              style={[styles.answerInput, { color: p.ink, backgroundColor: p.hover }]} />
            <Pressable accessibilityRole="button" disabled={busy || (picked.size === 0 && custom.trim() === '')} onPress={() => void send([...picked])}
              style={[styles.submit, { backgroundColor: p.accent, opacity: busy || (picked.size === 0 && custom.trim() === '') ? 0.35 : 1 }]}>
              <Text style={{ color: p.accentInk, fontSize: 13, fontWeight: '600' }}>{t('Submit')}</Text>
            </Pressable>
          </View>
        : null}
      {failed ? <Text style={[type.small, { color: p.danger, marginTop: 8 }]}>{t('This question is no longer open.')}</Text> : null}
    </View>
  )
}

export function ApprovalCard({ approval, call, p , bare = false }: { approval: Approval; call: Call; p: Palette; bare?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const answer = async (choice: 'allow' | 'reject') => {
    setBusy(true); setFailed(false)
    try { await call('approval-answer', { id: approval.id, choice }); void Haptics.notificationAsync(choice === 'allow' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning) }
    catch { setFailed(true) } finally { setBusy(false) }
  }
  return (
    <View accessibilityLabel={t('{name} is waiting for your approval', { name: '' })}
      style={bare ? undefined : [styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
      {bare ? null : <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]} numberOfLines={2}>{approval.tool || 'Approval'}</Text>}
      {typeof approval.detail?.text === 'string' && approval.detail.text !== ''
        ? <Text selectable style={[type.small, { color: p.ink, marginTop: 4 }]}>{approval.detail.text}</Text> : null}
      {approval.reason !== '' ? <Text selectable style={[type.small, { color: p.ink2, marginTop: 4 }]} numberOfLines={4}>{approval.reason}</Text> : null}
      {approval.detail?.code ? <Text selectable style={[type.small, { color: p.ink3, marginTop: 6, fontFamily: 'monospace' }]} numberOfLines={3}>{approval.detail.code}</Text> : null}
      {approval.answerable === true
        ? <View style={styles.answerRow}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void answer('reject')}
              style={[styles.choice, { backgroundColor: p.hover, opacity: busy ? 0.35 : 1 }]}>
              <Text style={{ color: p.ink, fontSize: 14 }}>{t('Reject')}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void answer('allow')}
              style={[styles.choice, { backgroundColor: p.accent, opacity: busy ? 0.35 : 1 }]}>
              <Text style={{ color: p.accentInk, fontSize: 14, fontWeight: '600' }}>{t('Allow once')}</Text>
            </Pressable>
          </View>
        : <Text style={[type.small, { color: p.ink2, marginTop: 8 }]}>{t('Answer on the computer.')}</Text>}
      {failed ? <Text style={[type.small, { color: p.danger, marginTop: 8 }]}>{t('This approval is no longer open.')}</Text> : null}
    </View>
  )
}

// "X is doing…" while a Bot works: 28px avatar + shimmering text (off under
// reduced motion).
export interface SecretRequest { id: string; name?: string; kind?: string; status?: string; scope?: string | string[] }

export function SecretCard({ secret, call, p , bare = false }: { secret: SecretRequest; call: Call; p: Palette; bare?: boolean }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const allow = secret.kind === 'allow'
  const send = async (endpoint: string, payload: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    try { await call(endpoint, { requestId: secret.id, ...payload }) } catch (failure) {
      if ((failure as { code?: string })?.code === 'unlock/canceled') { /* stay open */ }
      else if ((failure as { code?: string })?.code === 'unlock/unavailable') setFailed(true)
      else setFailed(true)
    } finally { setBusy(false) }
  }
  return (
    <View style={bare ? undefined : [styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
      {bare && !allow ? null : <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]}>{allow ? t('Let {bot} use {name}?', { bot: t('the Bot'), name: secret.name ?? "" }) : t('{name} needs a key', { name: secret.name ?? "" })}</Text>}
      {allow && secret.scope ? <Text style={[type.small, { color: p.ink2, marginTop: 6 }]}>{Array.isArray(secret.scope) ? secret.scope.join(", ") : secret.scope}</Text> : null}
      {!allow ? (
        <TextInput style={[styles.secretInput, { color: p.ink, borderColor: p.line }]} value={value} onChangeText={setValue}
          placeholder={t('Value of {name}', { name: secret.name ?? "" })} placeholderTextColor={p.ink3}
          autoCapitalize="none" autoCorrect={false} secureTextEntry />
      ) : null}
      <View style={styles.answerRow}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void send('secret-cancel', {})} style={[styles.choice, { backgroundColor: p.hover, opacity: busy ? 0.35 : 1 }]}>
          <Text style={{ color: p.ink, fontSize: 14 }}>{t('Cancel')}</Text>
        </Pressable>
        {allow ? (
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void send('secret-allow', {})} style={[styles.choice, { backgroundColor: p.accent, opacity: busy ? 0.35 : 1 }]}>
            <Text style={{ color: p.accentInk, fontSize: 14, fontWeight: '600' }}>{busy ? t('Allowing…') : t('Allow')}</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" disabled={busy || value.trim() === ''} onPress={() => { const next = value; setValue(''); void send('secret-set', { value: next }) }}
            style={[styles.choice, { backgroundColor: p.accent, opacity: busy || value.trim() === '' ? 0.35 : 1 }]}>
            <Text style={{ color: p.accentInk, fontSize: 14, fontWeight: '600' }}>{busy ? t('Saving…') : t('Save')}</Text>
          </Pressable>
        )}
      </View>
      {failed ? <Text style={[type.small, { color: p.danger, marginTop: 8 }]}>{t('This approval is no longer open.')}</Text> : null}
    </View>
  )
}

export interface BtwCardData { id: string; partId?: string; question?: string; answer?: string; failure?: string; status?: string }

export function BtwCard({ card, sessionId, call, p , bare = false }: { card: BtwCardData; sessionId: string; call: Call; p: Palette; bare?: boolean }) {
  const [busy, setBusy] = useState(false)
  const drop = () => {
    if (busy) return
    setBusy(true)
    void call('btw-delete', { sessionId, cardId: card.id }).catch(() => {}).finally(() => setBusy(false))
  }
  return (
    <View style={bare ? undefined : [styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
      {!bare ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[typeScale.small, { color: p.ink3 }]}>{t('Aside')}</Text>
            {card.question ? <Text style={[typeScale.settingsRow, { color: p.ink, fontWeight: '600', marginTop: 2 }]}>{card.question}</Text> : null}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Delete aside')} onPress={drop} hitSlop={10} disabled={busy}
            style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', opacity: busy ? 0.35 : 1 }}>
            <Text style={{ color: p.ink3, fontSize: 18 }}>×</Text>
          </Pressable>
        </View>
      ) : null}
      {card.failure ? <Text style={[typeScale.small, { color: p.danger, marginTop: bare ? 0 : 6 }]}>{card.failure}</Text> : null}
      {card.answer ? <Text style={[typeScale.settingsRow, { color: p.ink2, marginTop: bare ? 0 : 6 }]}>{card.answer}</Text> : null}
      {bare ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t('Delete aside')} onPress={drop} disabled={busy}
          style={{ alignSelf: 'flex-end', marginTop: 8, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: p.hover, opacity: busy ? 0.35 : 1 }}>
          <Text style={[typeScale.caption, { color: p.ink2 }]}>{t('Dismiss')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

export interface HandoffData { callId: string; reason?: string; note?: string }

export function HandoffCard({ handoff, botId, onView, call, p , bare = false }: { handoff: HandoffData; botId: string; onView?: () => void; call: Call; p: Palette; bare?: boolean }) {
  const [busy, setBusy] = useState(false)
  const answer = (outcome: string) => {
    if (busy) return
    setBusy(true)
    void call('browser-give-back', { botId, outcome, callId: handoff.callId }).catch(() => {}).finally(() => setBusy(false))
  }
  return (
    <View style={bare ? undefined : [styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
      {bare ? null : <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]}>{t('Browser handoff')}</Text>}
      {handoff.note || handoff.reason ? <Text style={[type.small, { color: p.ink2, marginTop: 4 }]}>{handoff.note ?? handoff.reason}</Text> : null}
      <View style={styles.answerRow}>
        {onView !== undefined ? <Pressable accessibilityRole="button" onPress={onView} style={[styles.choice, { backgroundColor: p.hover }]}><Text style={{ color: p.ink, fontSize: 14 }}>{t('Card')}</Text></Pressable> : null}
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => answer('skip')} style={[styles.choice, { backgroundColor: p.hover, opacity: busy ? 0.35 : 1 }]}><Text style={{ color: p.ink, fontSize: 14 }}>{t('Skip')}</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => answer('done')} style={[styles.choice, { backgroundColor: p.accent, opacity: busy ? 0.35 : 1 }]}><Text style={{ color: p.accentInk, fontSize: 14, fontWeight: '600' }}>{t('Done')}</Text></Pressable>
      </View>
    </View>
  )
}

export function ActionRow({ bot, doing, p, dark }: { bot: Bot; doing: string; p: Palette; dark: boolean }) {
  const reduced = useReducedMotion()
  const shimmer = useSharedValue(0.35)
  useEffect(() => {
    if (reduced) { shimmer.value = 1; return }
    shimmer.value = withRepeat(withSequence(withTiming(1, { duration: 900 }), withTiming(0.35, { duration: 900 })), -1, false)
  }, [reduced])
  const style = useAnimatedStyle(() => ({ opacity: shimmer.value }))
  return (
    <View style={styles.action}>
      <Avatar bot={bot} dark={dark} size={28} ring={p.main} working />
      <Animated.Text style={[type.rowPreview, { color: p.ink2, marginLeft: 8, flex: 1 }, style]} numberOfLines={1}>{doing}…</Animated.Text>
    </View>
  )
}

const type = typeScale
function DockView({ sessionId, view, p, cap, collapsed, onCollapse }: { sessionId: string; view: ShownView; p: Palette; cap?: number; collapsed: boolean | null; onCollapse?: (id: string, value: boolean) => void }) {
  const id = view.id ?? ''
  const title = view.title || t('Card')
  const shut = collapsed === true
  const reduced = useReducedMotion()
  const spin = useSharedValue(shut ? 0 : 90)
  useEffect(() => { spin.value = reduced ? (shut ? 0 : 90) : withSpring(shut ? 0 : 90, SPRING_TAP) }, [shut, reduced])
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value}deg` }] }))
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line, paddingVertical: 0 }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: !shut }} onPress={() => onCollapse?.(id, !shut)} style={styles.viewHead}>
        <Text style={[typeScale.settingsRow, { color: p.ink, fontWeight: '600', flex: 1, minWidth: 0 }]}>{title}</Text>
        <Animated.View style={[chevron, { flexShrink: 0 }]}><ChevronRightIcon size={16} color={p.ink3} /></Animated.View>
      </Pressable>
      {shut ? null : (
        <View style={{ paddingBottom: 14 }} onLayout={e => { if (cap !== undefined && collapsed === null && e.nativeEvent.layout.height > cap) onCollapse?.(id, true) }}>
          <ViewCard sessionId={sessionId} id={view.id} title={view.title} root={view.view} p={p} bare />
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  dock: { maxHeight: '55%', flexGrow: 0, marginBottom: 6 },
  accordion: { marginHorizontal: 12, marginVertical: 5, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', ...shadow(1) },
  card: { marginHorizontal: 12, marginVertical: 6, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 14, ...shadow(1) },
  option: { paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  answerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 },
  viewHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 44 },
  answerInput: { flex: 1, minWidth: 160, minHeight: 40, borderRadius: radius.input, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15 },
  submit: { minHeight: 40, borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  secretInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 40, paddingVertical: 8, marginTop: 10, fontSize: 14 },
  choice: { flex: 1, minWidth: 104, minHeight: 44, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  action: { flexDirection: 'row', alignItems: 'center', height: 36, marginHorizontal: 12 },
})
