import { useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View, Pressable } from 'react-native'
import Animated, { useReducedMotion, useAnimatedStyle, withRepeat, withTiming, useSharedValue, withSequence } from 'react-native-reanimated'
import { useEffect } from 'react'
import type { Approval, Question } from '../../connection.ts'
import { t } from '../../ui/i18n.ts'
import { radius, shadow, type as typeScale, type Palette } from '../../ui/tokens.ts'
import { Avatar } from '../../ui/marks.tsx'
import type { Bot } from '../../connection.ts'

type Call = (endpoint: string, payload?: unknown) => Promise<unknown>

// The pending dock above the composer: question card (ui-standard 10.8), then
// approval cards. Taller than 50% of the screen, the dock scrolls inside.
export function Dock({ question, sessionId, approvals, call, p }: {
  question?: Question; sessionId: string; approvals: Approval[]; call: Call; p: Palette
}) {
  const has = question !== undefined || approvals.length > 0
  if (!has) return null
  return (
    <ScrollView style={styles.dock} contentContainerStyle={{ paddingBottom: 4 }} keyboardShouldPersistTaps="handled">
      {question ? <QuestionCard question={question} sessionId={sessionId} call={call} p={p} /> : null}
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
    try { await call('answer-question', { sessionId, questionId: question.id, answer: { selected, custom: custom.trim() } }) }
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
    try { await call('approval-answer', { id: approval.id, choice }) }
    catch { setFailed(true) } finally { setBusy(false) }
  }
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
      <Text style={[type.settingsRow, { color: p.ink, fontWeight: '600' }]} numberOfLines={2}>{approval.tool || 'Approval'}</Text>
      {approval.reason !== '' ? <Text style={[type.small, { color: p.ink2, marginTop: 4 }]} numberOfLines={4}>{approval.reason}</Text> : null}
      {approval.detail?.code ? <Text style={[type.small, { color: p.ink3, marginTop: 6, fontFamily: 'monospace' }]} numberOfLines={3}>{approval.detail.code}</Text> : null}
      {approval.answerable === true
        ? <View style={styles.answerRow}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void answer('allow')}
              style={[styles.choice, { backgroundColor: p.accent, opacity: busy ? 0.35 : 1 }]}>
              <Text style={{ color: p.accentInk, fontSize: 14, fontWeight: '600' }}>{t('Allow')}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void answer('reject')}
              style={[styles.choice, { backgroundColor: p.hover, opacity: busy ? 0.35 : 1 }]}>
              <Text style={{ color: p.ink, fontSize: 14 }}>{t('Reject')}</Text>
            </Pressable>
          </View>
        : <Text style={[type.small, { color: p.ink2, marginTop: 8 }]}>{t('Answer on the computer.')}</Text>}
      {failed ? <Text style={[type.small, { color: p.danger, marginTop: 8 }]}>{t('This approval is no longer open.')}</Text> : null}
    </View>
  )
}

// "X is doing…" while a Bot works: 28px avatar + shimmering text (off under
// reduced motion).
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
const styles = StyleSheet.create({
  dock: { maxHeight: '50%', flexGrow: 0 },
  card: { marginHorizontal: 12, marginVertical: 6, borderRadius: radius.card, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, ...shadow(1) },
  option: { paddingHorizontal: 10, paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  answerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  answerInput: { flex: 1, minHeight: 40, borderRadius: radius.input, paddingHorizontal: 12, fontSize: 15 },
  submit: { height: 40, borderRadius: radius.pill, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  choice: { flex: 1, height: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  action: { flexDirection: 'row', alignItems: 'center', height: 36, marginHorizontal: 12 },
})
