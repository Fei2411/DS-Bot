import { useState } from 'react'
import * as Haptics from 'expo-haptics'
import { ChevronRightIcon } from '../../ui/icons.tsx'
import { ViewCard } from './view.tsx'
import { ScrollView, StyleSheet, Text, TextInput, View, Pressable } from 'react-native'
import Animated, { useReducedMotion, useAnimatedStyle, withRepeat, withTiming, withSpring, useSharedValue, withSequence } from 'react-native-reanimated'
import { useEffect } from 'react'
import type { Approval, Question } from '../../connection.ts'
import { t } from '../../ui/i18n.ts'
import { radius, shadow, SPRING_TAP, type as typeScale, type Palette } from '../../ui/tokens.ts'
import { Avatar } from '../../ui/marks.tsx'
import type { Bot } from '../../connection.ts'

type Call = (endpoint: string, payload?: unknown) => Promise<unknown>

// The pending dock above the composer: question card (ui-standard 10.8), then
// approval cards. Taller than 50% of the screen, the dock scrolls inside.
export function Dock({ question, sessionId, approvals, secrets = [], view, call, p, maxHeight, collapsed, onCollapse }: {
  maxHeight?: number; collapsed?: Record<string, boolean>; onCollapse?: (id: string, value: boolean) => void
  view?: { id?: string; title?: string; children?: unknown[]; blueprint?: { id?: string; title?: string; children?: unknown[] } }
  secrets?: SecretRequest[]
  question?: Question; sessionId: string; approvals: Approval[]; call: Call; p: Palette
}) {
  const has = question !== undefined || approvals.length > 0 || secrets.length > 0 || view !== undefined
  if (!has) return null
  return (
    <ScrollView style={[styles.dock, maxHeight !== undefined ? { maxHeight } : null]} contentContainerStyle={{ paddingBottom: 4 }} keyboardShouldPersistTaps="handled">
      {view !== undefined ? <DockView sessionId={sessionId} view={view} p={p} cap={maxHeight} collapsed={collapsed?.[view.id ?? ''] ?? null} onCollapse={onCollapse} /> : null}
      {question ? <QuestionCard question={question} sessionId={sessionId} call={call} p={p} /> : null}
      {secrets.map(secret => <SecretCard key={secret.id} secret={secret} call={call} p={p} />)}
      {approvals.map(approval => <ApprovalCard key={approval.id} approval={approval} call={call} p={p} />)}
    </ScrollView>
  )
}

export function QuestionCard({ question, sessionId, call, p }: { question: Question; sessionId: string; call: Call; p: Palette }) {
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
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
      <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]}>{question.question}</Text>
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

export function ApprovalCard({ approval, call, p }: { approval: Approval; call: Call; p: Palette }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const answer = async (choice: 'allow' | 'reject') => {
    setBusy(true); setFailed(false)
    try { await call('approval-answer', { id: approval.id, choice }); void Haptics.notificationAsync(choice === 'allow' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning) }
    catch { setFailed(true) } finally { setBusy(false) }
  }
  return (
    <View accessibilityLabel={t('{name} is waiting for your approval', { name: '' })}
      style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
      <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]} numberOfLines={2}>{approval.tool || 'Approval'}</Text>
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
export interface SecretRequest { id: string; name: string; kind?: string; status?: string; scope?: string }

export function SecretCard({ secret, call, p }: { secret: SecretRequest; call: Call; p: Palette }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const allow = secret.kind === 'allow'
  const send = async (endpoint: string, payload: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    try { await call(endpoint, { id: secret.id, ...payload }) } catch { setFailed(true) } finally { setBusy(false) }
  }
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
      <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]}>{allow ? t('Let {bot} use {name}?', { bot: t('the Bot'), name: secret.name }) : t('{name} needs a key', { name: secret.name })}</Text>
      {allow && secret.scope ? <Text style={[type.small, { color: p.ink2, marginTop: 6 }]}>{secret.scope}</Text> : null}
      {!allow ? (
        <TextInput style={[styles.secretInput, { color: p.ink, borderColor: p.line }]} value={value} onChangeText={setValue}
          placeholder={t('Value of {name}', { name: secret.name })} placeholderTextColor={p.ink3}
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
function DockView({ sessionId, view, p, cap, collapsed, onCollapse }: { sessionId: string; view: { id?: string; title?: string; children?: unknown[]; blueprint?: { id?: string; title?: string; children?: unknown[] } }; p: Palette; cap?: number; collapsed: boolean | null; onCollapse?: (id: string, value: boolean) => void }) {
  const id = view.id ?? ''
  const title = (view.blueprint?.title ?? view.title) ?? 'View'
  const shut = collapsed === true
  const reduced = useReducedMotion()
  const spin = useSharedValue(shut ? 0 : 90)
  useEffect(() => { spin.value = reduced ? (shut ? 0 : 90) : withSpring(shut ? 0 : 90, SPRING_TAP) }, [shut, reduced])
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value}deg` }] }))
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line, paddingVertical: 0 }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: !shut }} onPress={() => onCollapse?.(id, !shut)} style={styles.viewHead}>
        <Text style={[typeScale.settingsRow, { color: p.ink, fontWeight: '600' }]}>{title}</Text>
        <Animated.View style={chevron}><ChevronRightIcon size={16} color={p.ink3} /></Animated.View>
      </Pressable>
      {shut ? null : (
        <View style={{ paddingBottom: 14 }} onLayout={e => { if (cap !== undefined && collapsed === null && e.nativeEvent.layout.height > cap) onCollapse?.(id, true) }}>
          <ViewCard sessionId={sessionId} view={view} p={p} bare />
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  dock: { maxHeight: '50%', flexGrow: 0 },
  card: { marginHorizontal: 12, marginVertical: 6, borderRadius: radius.card, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, ...shadow(1) },
  option: { paddingHorizontal: 10, paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  answerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  viewHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  answerInput: { flex: 1, minHeight: 40, borderRadius: radius.input, paddingHorizontal: 12, fontSize: 15 },
  submit: { height: 40, borderRadius: radius.pill, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  secretInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, height: 40, marginTop: 10, fontSize: 14 },
  choice: { flex: 1, height: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  action: { flexDirection: 'row', alignItems: 'center', height: 36, marginHorizontal: 12 },
})
