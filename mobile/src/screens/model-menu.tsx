import { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Bot, TeamState } from '../connection.ts'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { CheckIcon, ChevronRightIcon } from '../ui/icons.tsx'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'

// The desktop's model menu (ds-bot/src/client/model-menu.js) as a bottom sheet:
// models grouped by provider, the default one marked, and the thinking-level
// slider of the picked model under them.

type Model = NonNullable<TeamState['models']>[number] & { provider?: string; providerName?: string; reasoning?: Reasoning }
interface Reasoning { efforts?: { id: string; name: string }[]; defaultEffort?: string }

export function groupModels(models: Model[]): [string, Model[]][] {
  const groups = new Map<string, Model[]>()
  for (const model of models) {
    const provider = model.provider ?? model.providerName ?? model.ref.split('/')[0]
    if (!groups.has(provider)) groups.set(provider, [])
    groups.get(provider)!.push(model)
  }
  const names = new Map<string, number>()
  for (const list of groups.values()) {
    const name = list[0].providerName ?? list[0].ref.split('/')[0]
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  return [...groups].map(([provider, list]) => {
    const name = list[0].providerName ?? provider
    return [(names.get(name) ?? 0) > 1 ? `${name} (${provider})` : name, list]
  })
}

// What a Bot runs on, for display: the chosen model, else the one it last ran on.
export function modelOf(bot: Bot, models: Model[]): { ref: string; name: string; provider: string } | undefined {
  const ref = bot.model ?? bot.appliedModel
  if (!ref) return undefined
  const served = models.find(model => model.ref === ref)
  const [provider, ...rest] = ref.split('/')
  return { ref, name: served?.name ?? rest.join('/'), provider: served?.providerName ?? provider }
}

// The thinking levels of one model. The catalog carries them for models Bots use;
// any other ref asks the computer once.
const effortCache = new Map<string, Reasoning | null>()
export function useReasoning(ref: string | undefined, models: Model[]): Reasoning | null | undefined {
  const { call } = useTeam()
  const served = models.find(model => model.ref === ref)?.reasoning
  const [fetched, setFetched] = useState<Reasoning | null | undefined>(ref === undefined ? undefined : effortCache.get(ref))
  useEffect(() => {
    if (ref === undefined || served !== undefined) return
    if (effortCache.has(ref)) { setFetched(effortCache.get(ref)); return }
    let live = true
    setFetched(undefined)
    call('efforts', { ref }).then(value => {
      const reasoning = (value as Reasoning)?.efforts ? value as Reasoning : null
      effortCache.set(ref, reasoning)
      if (live) setFetched(reasoning)
    }).catch(() => {})
    return () => { live = false }
  }, [ref, served !== undefined])
  return served ?? fetched
}

export function effortLabel(reasoning: Reasoning | null | undefined, effort: string | undefined): string | undefined {
  const efforts = reasoning?.efforts ?? []
  if (efforts.length === 0) return undefined
  const picked = efforts.some(e => e.id === effort) ? effort : undefined
  const current = picked ?? reasoning?.defaultEffort
  return current === undefined ? t('Default') : efforts.find(e => e.id === current)?.name ?? current
}

// When the model names its default level the stops are the levels and a reset
// clears back to Default; otherwise Default sits at the first stop.
function effortStops(reasoning: Reasoning | null | undefined): { effort?: string; label: string }[] {
  const efforts = reasoning?.efforts ?? []
  if (efforts.length === 0) return []
  const hasDefault = efforts.some(effort => effort.id === reasoning?.defaultEffort)
  const levels = efforts.map(effort => ({ effort: effort.id, label: effort.name }))
  return hasDefault ? levels : [{ label: t('Default') }, ...levels]
}

const KNOB = 18
const INSET = 11

export function EffortBar({ reasoning, current, onPick }: { reasoning: Reasoning | null | undefined; current?: string; onPick: (effort: string | undefined) => void }) {
  const { p } = useTheme()
  const stops = effortStops(reasoning)
  const [picked, setPicked] = useState(current)
  const [width, setWidth] = useState(0)
  const dragging = useRef(false)
  useEffect(() => { if (!dragging.current) setPicked(current) }, [current])
  if (stops.length === 0) return null
  const hasDefault = (reasoning?.efforts ?? []).some(effort => effort.id === reasoning?.defaultEffort)
  const activeEffort = picked ?? (hasDefault ? reasoning?.defaultEffort : undefined)
  const activeIndex = Math.max(0, stops.findIndex(stop => (stop.effort ?? null) === (activeEffort ?? null)))
  const ratio = stops.length <= 1 ? 1 : activeIndex / (stops.length - 1)
  const span = Math.max(1, width - INSET * 2)
  const stopAt = (event: GestureResponderEvent) => {
    const r = Math.max(0, Math.min(1, (event.nativeEvent.locationX - INSET) / span))
    return stops[Math.round(r * (stops.length - 1))] ?? stops[0]
  }
  const commit = (effort: string | undefined) => {
    setPicked(effort)
    if ((effort ?? null) !== (current ?? null)) onPick(effort)
  }
  return (
    <View style={{ gap: 6, paddingHorizontal: 16, paddingVertical: 10 }} accessibilityRole="adjustable" accessibilityLabel={t('Thinking level')}
      accessibilityValue={{ text: stops[activeIndex].label }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={event => commit(stops[Math.max(0, Math.min(stops.length - 1, activeIndex + (event.nativeEvent.actionName === 'increment' ? 1 : -1)))].effort)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 28 }}>
        <Text style={[typeScale.caption, { color: p.ink3, fontWeight: '500' }]}>{t('Thinking level')}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
          {picked === undefined && hasDefault ? <Text style={[typeScale.caption, { color: p.ink3 }]}>{t('Default')}</Text> : null}
          <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: '600', color: p.accent, flexShrink: 1 }} numberOfLines={1}>{stops[activeIndex].label}</Text>
          {picked !== undefined || !hasDefault ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t('Default')} disabled={picked === undefined} onPress={() => commit(undefined)} hitSlop={10}
              style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.hover, opacity: picked === undefined ? 0.35 : 1 }}>
              <Text style={{ color: p.ink2, fontSize: 13 }}>↺</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ height: 32, justifyContent: 'center' }}
        onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true} onResponderTerminationRequest={() => false}
        onResponderGrant={event => { dragging.current = true; setPicked(stopAt(event).effort) }}
        onResponderMove={event => setPicked(stopAt(event).effort)}
        onResponderRelease={event => { dragging.current = false; commit(stopAt(event).effort) }}
        onResponderTerminate={() => { dragging.current = false; setPicked(current) }}>
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 6, bottom: 6, borderRadius: 999, backgroundColor: p.hover, borderWidth: StyleSheet.hairlineWidth, borderColor: p.line }} />
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: INSET * 2 + span * ratio, borderRadius: 999, backgroundColor: p.accent }} />
        {stops.map((stop, index) => {
          const at = stops.length <= 1 ? 1 : index / (stops.length - 1)
          return <View key={stop.effort ?? 'default'} pointerEvents="none" style={{ position: 'absolute', left: INSET + span * at - 2, width: 4, height: 4, borderRadius: 2, backgroundColor: at <= ratio + 0.001 ? 'rgba(255,255,255,0.65)' : p.ink3, opacity: at <= ratio + 0.001 ? 1 : 0.45 }} />
        })}
        <View pointerEvents="none" style={{ position: 'absolute', left: INSET + span * ratio - KNOB / 2, width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2 }} />
      </View>
    </View>
  )
}

// Every model under its provider, the default one marked.
function ModelGroups({ models, current, fallback, onPick }: { models: Model[]; current?: string; fallback?: string; onPick: (ref: string) => void }) {
  const { p } = useTheme()
  return (
    <ScrollView style={{ maxHeight: 420 }}>
      {groupModels(models).map(([provider, list]) => (
        <View key={provider}>
          <Text style={[typeScale.caption, { color: p.ink3, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }]}>{provider}</Text>
          {list.map(item => (
            <Pressable key={item.ref} accessibilityRole="radio" accessibilityState={{ checked: item.ref === current }}
              onPress={() => onPick(item.ref)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.hover }]}>
              <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} numberOfLines={1}>{item.name}</Text>
              {item.ref === fallback ? <Text style={[typeScale.caption, { color: p.ink3 }]}>{t('Default')}</Text> : null}
              {item.ref === current ? <CheckIcon color={p.accent} /> : null}
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  )
}

// A model picker for a Bot that does not exist yet (Create new Bot): the same trigger
// and sheet as a Bot's model menu, without the thinking level.
export function ModelPicker({ current, onPick }: { current?: string; onPick: (ref: string) => void }) {
  const { p } = useTheme()
  const { team } = useTeam()
  const [open, setOpen] = useState(false)
  const insets = useSafeAreaInsets()
  const models = (team?.models ?? []) as Model[]
  const model = models.find(item => item.ref === current)
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Model')} onPress={() => setOpen(true)}
        style={[styles.trigger, { backgroundColor: p.card, borderColor: p.line }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[typeScale.settingsRow, { color: p.ink, fontWeight: '500' }]} numberOfLines={1}>{model?.name ?? t('Choose a model')}</Text>
          {model ? <Text style={[typeScale.caption, { color: p.ink3 }]} numberOfLines={1}>{model.providerName ?? model.ref.split('/')[0]}</Text> : null}
        </View>
        <Text style={{ color: p.ink3, fontSize: 12 }}>⌄</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setOpen(false)} accessibilityLabel={t('Close')} />
        <View style={[styles.sheet, { backgroundColor: p.card, paddingBottom: insets.bottom + 8 }]}>
          <View style={[styles.grab, { backgroundColor: p.line }]} />
          <ModelGroups models={models} current={current} fallback={team?.defaultModel} onPick={ref => { onPick(ref); setOpen(false) }} />
        </View>
      </Modal>
    </>
  )
}

// The trigger shows the model name over its provider and thinking level, as on the desktop.
export function ModelMenu({ bot, onManage }: { bot: Bot; onManage: () => void }) {
  const { p } = useTheme()
  const { team, call } = useTeam()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const insets = useSafeAreaInsets()
  const models = (team?.models ?? []) as Model[]
  const model = modelOf(bot, models)
  const reasoning = useReasoning(model?.ref, models)
  const level = effortLabel(reasoning, bot.effort)
  const save = (patch: Record<string, unknown>) => {
    call('update-bot', { id: bot.id, ...patch }).then(() => setError(null), (failure: Error) => setError(failure?.message ?? String(failure)))
  }
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Model')} onPress={() => setOpen(true)}
        style={[styles.trigger, { backgroundColor: p.card, borderColor: p.line }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[typeScale.settingsRow, { color: p.ink, fontWeight: '500' }]} numberOfLines={1}>{model?.name ?? t('Choose a model')}</Text>
          {model ? <Text style={[typeScale.caption, { color: p.ink3 }]} numberOfLines={1}>{[model.provider, level].filter(Boolean).join(' · ')}</Text> : null}
        </View>
        <Text style={{ color: p.ink3, fontSize: 12 }}>⌄</Text>
      </Pressable>
      {model ? null : <Text style={[typeScale.small, { color: p.ink3, marginTop: 6 }]}>{t('Pick a model and {name} can start.', { name: bot.name })}</Text>}
      {error ? <Text style={[typeScale.small, { color: p.danger, marginTop: 6 }]}>{error}</Text> : null}
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setOpen(false)} accessibilityLabel={t('Close')} />
        <View style={[styles.sheet, { backgroundColor: p.card, paddingBottom: insets.bottom + 8 }]}>
          <View style={[styles.grab, { backgroundColor: p.line }]} />
          <ModelGroups models={models} current={model?.ref} fallback={team?.defaultModel} onPick={ref => { if (ref !== bot.model) save({ model: ref }) }} />
          {model && (reasoning?.efforts?.length ?? 0) > 0 ? (
            <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line, marginTop: 6 }}>
              <EffortBar reasoning={reasoning} current={reasoning?.efforts?.some(e => e.id === bot.effort) ? bot.effort : undefined} onPick={effort => save({ effort: effort ?? null })} />
            </View>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => { setOpen(false); onManage() }}
            style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line }]}>
            <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]}>{t('Models and providers…')}</Text>
            <ChevronRightIcon color={p.ink3} />
          </Pressable>
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 52, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 8 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 8 },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 16 },
})
