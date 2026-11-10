// Bot and group management screens, mirroring the desktop details drawer and
// settings forms: Bot details, Edit Bot, Create Bot, group settings, and the
// "new" sheet. Every write goes through the same endpoints the desktop calls.
import { useCallback, useContext, useEffect, useState } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { confirmDanger, Sheet, SheetHeader, useInSheet } from '../nav/sheet.tsx'
import * as Crypto from 'expo-crypto'
import { listComputers, removeComputer, type StoredComputer } from '../store.ts'
import { ComputersCtx } from '../nav/computers.ts'
import * as ImagePicker from 'expo-image-picker'
import { useTeam } from '../team/context.tsx'
import { t, timeLabel } from '../ui/i18n.ts'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, GearIcon } from '../ui/icons.tsx'
import { Avatar, COLOR_PAINT, RoomAvatar } from '../ui/marks.tsx'
import { inkColor, radius, shadow, type as typeScale, useTheme, type Palette } from '../ui/tokens.ts'
import type { Bot, Room, TeamState } from '../connection.ts'
import { capabilityStatusText } from './settings-pages.tsx'
import { ModelMenu, ModelPicker } from './model-menu.tsx'

export const SHAPES = ['acorn', 'berry', 'bunny', 'gem', 'gumdrop', 'kitty', 'moon', 'peanut', 'star', 'wave']
export const COLORS = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray', 'aurora']

export const pickPhoto = async (): Promise<string | null> => {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8, base64: true })
  const asset = result.canceled ? null : result.assets?.[0]
  if (!asset?.base64) return null
  const mime = asset.mimeType ?? 'image/jpeg'
  return `data:${mime};base64,${asset.base64}`
}

const botOf = (team: TeamState | null, id: string) => team?.bots?.find(b => b.id === id)
export const roomOf = (team: TeamState | null, id: string) => team?.rooms?.find(r => r.id === id)
const mainsOf = (team: TeamState | null) => new Set(team?.mainBotIds ?? (team?.mainBotId ? [team.mainBotId] : []))
const isMain = (team: TeamState | null, id: string) => mainsOf(team).has(id)

function Screen({ title, children }: { title: string; children: React.ReactNode }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  const inSheet = useInSheet()
  return (
    <View style={{ flex: 1, backgroundColor: p.main, paddingTop: inSheet ? 0 : insets.top }}>
      {children}
    </View>
  )
}

export function BackRow({ title, onBack, end }: { title: string; onBack: () => void; end?: React.ReactNode }) {
  const { p } = useTheme()
  return (
    <View style={styles.backRow}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={onBack} hitSlop={8} style={styles.backBtn}>
        <ChevronLeftIcon size={20} color={p.ink2} />
      </Pressable>
      <Text style={[typeScale.rowName, { color: p.ink, flex: 1, textAlign: 'center' }]} numberOfLines={1}>{title}</Text>
      <View style={styles.backBtn}>{end}</View>
    </View>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const { p } = useTheme()
  return (
    <View style={{ marginTop: 18 }}>
      <Text style={[typeScale.caption, { color: p.ink3, paddingHorizontal: 18, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6, fontSize: 11 }]}>{label}</Text>
      <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>{children}</View>
    </View>
  )
}

function Row({ label, hint, value, onPress, disabled, end }: { label: string; hint?: string; value?: string; onPress?: () => void; disabled?: boolean; end?: React.ReactNode }) {
  const { p } = useTheme()
  const body = (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={[typeScale.settingsRow, { color: p.ink }]}>{label}</Text>
        {hint ? <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]}>{hint}</Text> : null}
      </View>
      {value !== undefined ? <Text style={[typeScale.settingsRow, { color: p.ink2 }]} numberOfLines={1}>{value}</Text> : null}
      {end}
      {onPress ? <ChevronRightIcon size={16} color={p.ink3} /> : null}
    </View>
  )
  if (!onPress || disabled) return <View style={disabled ? { opacity: 0.45 } : null}>{body}</View>
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed ? { backgroundColor: p.hover } : null}>{body}</Pressable>
}

function Field({ label, value, placeholder, multiline, onSave }: { label: string; value?: string; placeholder?: string; multiline?: boolean; onSave: (next: string) => void }) {
  const { p } = useTheme()
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={[typeScale.settingsRow, { color: p.ink3, fontSize: 13 }]}>{label}</Text>
        <TextInput
          style={[typeScale.settingsRow, { color: p.ink, paddingVertical: 4 }, multiline ? { minHeight: 90, textAlignVertical: 'top' } : null]}
          value={draft ?? value ?? ''}
          placeholder={placeholder}
          placeholderTextColor={p.ink3}
          multiline={multiline}
          onChangeText={setDraft}
          onBlur={() => { const next = (draft ?? '').trim(); setDraft(null); if (next !== (value ?? '')) onSave(next) }}
        />
      </View>
    </View>
  )
}

function SwitchRow({ label, hint, on, disabled, onChange }: { label: string; hint?: string; on: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  const { p } = useTheme()
  return (
    <View style={[styles.row, disabled ? { opacity: 0.45 } : null]}>
      <View style={{ flex: 1 }}>
        <Text style={[typeScale.settingsRow, { color: p.ink }]}>{label}</Text>
        {hint ? <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]}>{hint}</Text> : null}
      </View>
      <Pressable accessibilityRole="switch" accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={() => onChange(!on)}
        style={[styles.switch, { backgroundColor: on ? p.accent : p.line }]}>
        <View style={[styles.knob, { backgroundColor: p.accentInk, alignSelf: on ? 'flex-end' : 'flex-start' }]} />
      </Pressable>
    </View>
  )
}

// A choice of a few values, all in view: the same control as the phone's own settings.
function Segmented({ options, value, onPick }: { options: { id: string; label: string }[]; value: string; onPick: (id: string) => void }) {
  const { p } = useTheme()
  return (
    <View style={[styles.segRow, { backgroundColor: p.hover }]} accessibilityRole="radiogroup">
      {options.map(option => {
        const on = option.id === value
        return (
          <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onPick(option.id)}
            style={[styles.seg, on && [{ backgroundColor: p.card }, shadow(1)]]}>
            <Text style={[typeScale.small, { color: on ? p.ink : p.ink2, fontWeight: on ? '600' : '400' }]} numberOfLines={1}>{option.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function DangerRow({ label, confirm, busy, onConfirm }: { label: string; confirm: string; busy?: boolean; onConfirm: () => void }) {
  const { p } = useTheme()
  return (
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => confirmDanger(confirm, label, onConfirm)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.hover }]}>
      <Text style={[typeScale.settingsRow, { color: p.danger, flex: 1 }]}>{label}</Text>
    </Pressable>
  )
}

type Model = NonNullable<TeamState['models']>[number]

function useWrite(navigation: any) {
  const { call } = useTeam()
  const [error, setError] = useState<string | null>(null)
  const run = async (name: string, body: Record<string, unknown>, done?: (value: unknown) => void) => {
    try { const value = await call(name, body); setError(null); done?.(value) }
    catch (failure) {
      const code = (failure as { code?: string })?.code
      if (code === 'unlock/canceled') return
      setError((failure as Error)?.message ?? String(failure))
    }
  }
  return { run, error }
}

// Like the desktop, a Bot or group the user just made (or duplicated) opens
// its chat, once the team lists it.
function useOpenWhenListed(navigation: any) {
  const { team } = useTeam()
  const [target, setTarget] = useState<{ kind: 'bot' | 'room'; id: string } | null>(null)
  useEffect(() => {
    if (target === null) return
    const listed = target.kind === 'bot' ? botOf(team, target.id) !== undefined : (team?.rooms ?? []).some(room => room.id === target.id)
    if (!listed) return
    setTarget(null)
    navigation.popTo('Chat', target)
  }, [target, team])
  return setTarget
}

// ------------------------------------------------------------ Bot details

export function BotDetails({ route, navigation }: any) {
  const { p, dark } = useTheme()
  const { team } = useTeam()
  const { run, error } = useWrite(navigation)
  const bot = botOf(team, route.params?.botId ?? '')
  if (bot === undefined) return <Screen title=""><BackRow title="" onBack={() => navigation.goBack()} /></Screen>
  const main = isMain(team, bot.id)
  const permissions = (team as { permissions?: { options?: { value: string; name: string }[]; defaultPreset?: string } } | null)?.permissions
  // The desktop's details pane (details-drawer.js): who it is, then model,
  // permission, folder, instructions, memory, usage and scheduled tasks. Its gear
  // opens the Bot settings.
  return (
    <Screen title={bot.name}>
      <View style={[styles.detailTop, { paddingTop: 8 }]}>
        <RoundButton label={t('Back')} onPress={() => navigation.goBack()}><ChevronLeftIcon color={p.ink2} /></RoundButton>
        <View style={{ flex: 1 }} />
        <RoundButton label={t('Edit Bot')} onPress={() => navigation.navigate('BotEdit', { botId: bot.id })}><GearIcon size={18} color={p.ink2} /></RoundButton>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 40, paddingHorizontal: 18 }}>
        <View style={{ alignItems: 'center', paddingTop: 4 }}>
          <Avatar bot={bot} dark={dark} size={64} ring={p.main} main={main} />
          <Text style={[typeScale.rowName, { color: p.ink, marginTop: 10, fontSize: 18 }]}>{bot.name}</Text>
          {bot.role ? <Text style={[typeScale.caption, { color: p.ink3, marginTop: 2 }]}>{bot.role}</Text> : null}
        </View>
        <View style={[styles.tabs, { backgroundColor: p.hover }]}>
          <View style={[styles.tab, { backgroundColor: p.card }]}><Text style={[typeScale.small, { color: p.ink, fontWeight: '500' }]}>{t('Details')}</Text></View>
          <Pressable accessibilityRole="tab" onPress={() => navigation.navigate('BotBrowser', { bot })} style={styles.tab}><Text style={[typeScale.small, { color: p.ink2 }]}>{t('Browser')}</Text></Pressable>
        </View>
        {error ? <Text style={[typeScale.small, { color: p.danger, marginTop: 10 }]}>{error}</Text> : null}
        <DetailTitle text={t('Model')} />
        <ModelMenu bot={bot} onManage={() => navigation.navigate('Settings', { screen: 'Providers', initial: false })} />
        {permissions?.options && permissions.options.length > 0 ? (
          <>
            <DetailTitle text={t('Permissions')} />
            <PermissionPicker options={permissions.options} saved={bot.permission ?? permissions.defaultPreset} onPick={permission => void run('update-bot', { id: bot.id, permission })} />
          </>
        ) : null}
        <DetailTitle text={t('Working folder')} />
        <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Folder', { current: bot.workDir, onPick: 'bot', botId: bot.id })}
          style={[styles.dropdown, { backgroundColor: p.card, borderColor: p.line }]}>
          <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} numberOfLines={1}>{bot.workDir ? bot.workDir.split(/[\\/]/).filter(Boolean).pop() : t('Team workspace')}</Text>
          <Text style={{ color: p.ink3, fontSize: 12 }}>⌄</Text>
        </Pressable>
        {bot.instructions
          ? <Text style={[typeScale.small, { color: p.ink2, marginTop: 14 }]} numberOfLines={5}>{bot.instructions}</Text>
          : <Pressable accessibilityRole="button" onPress={() => navigation.navigate('BotEdit', { botId: bot.id })} style={{ alignItems: 'center', paddingVertical: 14 }}>
              <Text style={[typeScale.small, { color: p.ink3 }]}>{t('Add instructions in Bot settings')}</Text>
            </Pressable>}
        {team?.memory === false ? null : <MemorySummary bot={bot} onOpen={() => navigation.navigate('Memory', { id: bot.id, name: bot.name, group: false })} />}
        <UsageSummary bot={bot} onOpen={() => navigation.navigate('Usage', { botId: bot.id, name: bot.name, sessionId: bot.sessionId })} />
        <ScheduleSummary bot={bot} onOpen={() => navigation.navigate('Schedules', { botId: bot.id, name: bot.name, sessionId: bot.sessionId })} />
      </ScrollView>
    </Screen>
  )
}

function RoundButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  const { p } = useTheme()
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6}
      style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: p.line, backgroundColor: p.card }}>
      {children}
    </Pressable>
  )
}

function DetailTitle({ text }: { text: string }) {
  const { p } = useTheme()
  return <Text style={[typeScale.caption, { color: p.ink2, marginTop: 18, marginBottom: 8 }]}>{text}</Text>
}

const PRESET_LABELS: Record<string, string> = { 'read-only': 'Read only', 'workspace-write': 'Workspace', 'danger-full-access': 'Full access' }

// The presets DeepSeek Harness offers, as one segmented choice (permission-picker.js);
// a pick shows at once and the saved value catches up.
function PermissionPicker({ options, saved, onPick }: { options: { value: string; name: string }[]; saved?: string; onPick: (value: string) => void }) {
  const { p } = useTheme()
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => { if (pending === saved) setPending(null) }, [saved, pending])
  const current = pending ?? saved
  return (
    <View style={[styles.segments, { backgroundColor: p.hover }]} accessibilityRole="radiogroup">
      {options.map(option => {
        const on = option.value === current
        const danger = option.value === 'danger-full-access'
        return (
          <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => { if (!on) { setPending(option.value); onPick(option.value) } }}
            style={[styles.segment, on ? { backgroundColor: p.card } : null]}>
            <Text style={[typeScale.small, { color: danger ? p.danger : on ? p.ink : p.ink2, fontWeight: on ? '500' : '400' }]} numberOfLines={1}>
              {PRESET_LABELS[option.value] ? t(PRESET_LABELS[option.value]) : option.name}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// memory-panel.js MemoryRow: how much the Bot keeps, and the way in.
function MemorySummary({ bot, onOpen }: { bot: Bot; onOpen: () => void }) {
  const { p } = useTheme()
  const { call, team } = useTeam()
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    call('memory-view', { botId: bot.id }).then(view => { if (live) setCount((view as { entries?: unknown[] })?.entries?.length ?? 0) }).catch(() => {})
    return () => { live = false }
  }, [bot.id, team?.revision])
  const label = count === null ? t('Loading…') : count === 0 ? t('Nothing saved yet') : count === 1 ? t('1 entry') : t('{count} entries', { count })
  return (
    <>
      <DetailTitle text={t('Memory')} />
      <Pressable accessibilityRole="button" accessibilityLabel={t("Manage {name}'s memory", { name: bot.name })} onPress={onOpen}
        style={[styles.dropdown, { backgroundColor: p.card, borderColor: p.line }]}>
        <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]}>{label}</Text>
        <Text style={[typeScale.small, { color: p.ink3 }]}>{t('Manage')}</Text>
        <ChevronRightIcon color={p.ink3} />
      </Pressable>
    </>
  )
}

const formatTokens = (count: number) => (count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${(count / 1e3).toFixed(1)}K` : String(count))

// text.js usageOf: every prompt-side bucket plus output, and the cache hit share.
function UsageSummary({ bot, onOpen }: { bot: Bot; onOpen: () => void }) {
  const { p } = useTheme()
  const { call, team } = useTeam()
  const [text, setText] = useState('')
  useEffect(() => {
    let live = true
    call('run-stats', { botId: bot.id }).then(value => {
      const usage = (value as { tokenUsage?: { uncachedInputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number } } | null)?.tokenUsage
      if (!live || !usage) return
      const input = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      const output = usage.outputTokens ?? 0
      setText(input + output === 0 ? '' : t('{tokens} tok · Cache hit {hit}%', { tokens: formatTokens(input + output), hit: input > 0 ? Math.round((usage.cacheReadTokens ?? 0) / input * 100) : 0 }))
    }).catch(() => {})
    return () => { live = false }
  }, [bot.id, team?.revision])
  if (text === '') return null
  return (
    <>
      <DetailTitle text={t('Usage')} />
      <Pressable accessibilityRole="button" onPress={onOpen} style={{ flexDirection: 'row', justifyContent: 'space-between', minHeight: 32, alignItems: 'center' }}>
        <Text style={[typeScale.small, { color: p.ink2 }]}>{bot.name}</Text>
        <Text style={[typeScale.small, { color: p.ink }]}>{text}</Text>
      </Pressable>
    </>
  )
}

// schedules.js ScheduleSummary: the Bot's active tasks, or the way to add one.
function ScheduleSummary({ bot, onOpen }: { bot: Bot; onOpen: () => void }) {
  const { p } = useTheme()
  const { call, team } = useTeam()
  const [view, setView] = useState<{ available?: boolean; tasks?: { id: string; botId?: string; status?: string; title?: string }[] } | null>(null)
  useEffect(() => {
    let live = true
    call('schedules').then(value => { if (live) setView(value as typeof view) }).catch(() => {})
    return () => { live = false }
  }, [team?.revision])
  const tasks = view?.available ? (view.tasks ?? []).filter(task => task.botId === bot.id && task.status === 'active') : []
  return (
    <>
      <DetailTitle text={tasks.length === 0 ? t('Scheduled tasks') : t('Scheduled tasks · {count}', { count: tasks.length })} />
      {tasks.length === 0
        ? <Pressable accessibilityRole="button" onPress={onOpen} style={{ minHeight: 32, justifyContent: 'center' }}>
            <Text style={[typeScale.small, { color: p.ink3 }]}>{view?.available === false ? t('Switch on Automation tasks on the Plugins page in Harness settings.') : t('No scheduled tasks yet. Add one')}</Text>
          </Pressable>
        : tasks.slice(0, 3).map(task => (
            <Pressable key={task.id} accessibilityRole="button" onPress={onOpen} style={{ minHeight: 36, justifyContent: 'center' }}>
              <Text style={[typeScale.small, { color: p.ink }]} numberOfLines={1}>{task.title}</Text>
            </Pressable>
          ))}
    </>
  )
}

// The desktop's BotCapabilitiesCard: packs first, then by name; a switch per
// library item, with its status for this Bot while attached.
function BotCapabilities({ bot, team, run }: { bot: Bot; team: TeamState | null; run: (endpoint: string, body: Record<string, unknown>) => Promise<void> }) {
  const library = (team as { capabilities?: { name: string; kind?: string }[] } | null)?.capabilities ?? []
  if (library.length === 0) return null
  const items = [...library].sort((a, b) => Number(b.kind === 'pack') - Number(a.kind === 'pack') || a.name.localeCompare(b.name))
  const attached = new Set(bot.capabilities ?? [])
  const statuses = (team as { capabilityStatuses?: Record<string, Record<string, { state?: string; error?: string }>> } | null)?.capabilityStatuses?.[bot.id] ?? {}
  return (
    <Section label={t('Capabilities')}>
      {items.map(item => (
        <SwitchRow key={item.name} label={item.name} hint={attached.has(item.name) ? capabilityStatusText(statuses[item.name]) : undefined}
          on={attached.has(item.name)} onChange={next => void run('bot-capability', { botId: bot.id, name: item.name, attached: next })} />
      ))}
    </Section>
  )
}

// ------------------------------------------------------------ Edit Bot

export function BotEdit({ route, navigation }: any) {
  const { p, dark } = useTheme()
  const { team } = useTeam()
  const { run, error } = useWrite(navigation)
  const open = useOpenWhenListed(navigation)
  const bot = botOf(team, route.params?.botId ?? '')
  if (bot === undefined) return <Screen title=""><BackRow title="" onBack={() => navigation.goBack()} /></Screen>
  const save = (patch: Record<string, unknown>) => void run('update-bot', { id: bot.id, ...patch })
  const shape = bot.avatar?.shape ?? 'star'
  const color = bot.color ?? 'blue'
  const main = isMain(team, bot.id)
  return (
    <Screen title={bot.name}>
      <BackRow title={t('Settings')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ alignItems: 'center', paddingTop: 12 }}>
          <Avatar bot={bot} dark={dark} size={56} ring={p.main} />
        </View>
        {error ? <Text style={[typeScale.small, { color: p.danger, marginHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
        <Section label={t('Profile')}>
          <Field label={t('Name')} value={bot.name} placeholder="Bob" onSave={name => { if (name) save({ name }) }} />
          <Field label={t('Label')} value={bot.role} placeholder={t('Research, admin…')} onSave={role => save({ role })} />
        </Section>
        <Section label={t('Character shape')}>
          <PickGrid columns={5} ids={SHAPES} picked={shape} onPick={id => save({ avatar: { ...bot.avatar, shape: id } })}
            draw={(id, size) => <Avatar bot={{ ...bot, avatar: { ...bot.avatar, shape: id }, color } as Bot} dark={dark} size={size * 0.72} ring={p.card} />} />
        </Section>
        <Section label={t('Character color')}>
          <PickGrid columns={6} ids={COLORS} picked={color} onPick={id => save({ color: id })}
            draw={(id, size) => <View style={{ width: size * 0.52, height: size * 0.52, borderRadius: size, backgroundColor: COLOR_PAINT[id] ?? inkColor(id, dark) }} />} />
        </Section>
        <Section label={t('Photo')}>
          <Row label={t('Upload photo')} onPress={() => { void pickPhoto().then(image => { if (image !== null) save({ avatar: { ...bot.avatar, image } }) }) }} />
          {bot.avatar?.image ? <Row label={t('Remove photo')} onPress={() => save({ avatar: { shape: bot.avatar?.shape } })} /> : null}
        </Section>
        <Section label={t('Model')}>
          <View style={{ padding: 12 }}><ModelMenu bot={bot} onManage={() => navigation.navigate('Settings', { screen: 'Providers', initial: false })} /></View>
        </Section>
        <Section label={t('Instructions')}>
          <Field label={t('What this Bot does')} value={bot.instructions} multiline placeholder={t('What this Bot is responsible for…')} onSave={instructions => save({ instructions })} />
        </Section>
        <Section label={t('Privacy')}>
          <SwitchRow label={t('Private')} hint={t('Other Bots cannot read its folder, memory or chats, and you approve what it shares with them.')}
            on={bot.private === true} onChange={next => save({ private: next })} />
        </Section>
        {bot.private === true ? null : (
          <Section label={t('Main Bot')}>
            <SwitchRow label={t('Main Bot')} hint={t('Can create and change Bots, and runs every group chat.')}
              on={main} onChange={next => void run('set-main', { id: bot.id, main: next })} />
          </Section>
        )}
        <BotCapabilities bot={bot} team={team} run={run} />
        <Section label={t('Bot')}>
          {bot.private === true ? null : <Row label={t('Duplicate')} hint={t('A copy with the same job and model, and fresh memory.')} onPress={() => void run('duplicate-bot', { id: bot.id }, value => open({ kind: 'bot', id: (value as Bot).id }))} />}
          <DangerRow label={t('Delete Bot')} confirm={t('Delete {name}?', { name: bot.name })} onConfirm={() => void run('delete-bot', { id: bot.id }, () => navigation.popTo('Chat'))} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

// ------------------------------------------------------------ Create Bot

// Square choices in even columns that fill the card's width.
function PickGrid({ columns, ids, picked, onPick, draw }: { columns: number; ids: string[]; picked: string; onPick: (id: string) => void; draw: (id: string, size: number) => React.ReactNode }) {
  const { p } = useTheme()
  const [width, setWidth] = useState(0)
  const gap = 8
  const size = width === 0 ? 0 : Math.floor((width - gap * (columns - 1)) / columns)
  return (
    <View onLayout={event => setWidth(event.nativeEvent.layout.width - 24)} style={[styles.grid, { gap }]}>
      {size > 0 ? ids.map(id => (
        <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: picked === id }} onPress={() => onPick(id)}
          style={[styles.cell, { width: size, height: size }, picked === id ? { borderColor: p.accent, borderWidth: 2 } : { borderColor: p.line }]}>
          {draw(id, size)}
        </Pressable>
      )) : null}
    </View>
  )
}

export function NewBot({ navigation }: any) {
  const { p, dark } = useTheme()
  const { team } = useTeam()
  const { run, error } = useWrite(navigation)
  const [name, setName] = useState('')
  const [shape, setShape] = useState('star')
  const [color, setColor] = useState('blue')
  const models = team?.models ?? []
  const [model, setModel] = useState<string | undefined>(() => (models.find(m => m.ref === team?.defaultModel) ?? models[0])?.ref)
  const [busy, setBusy] = useState(false)
  const open = useOpenWhenListed(navigation)
  const finalName = name.trim() || t('New Bot')
  const clash = (team?.bots ?? []).some(bot => bot.name.toLowerCase() === finalName.toLowerCase())
  const create = async () => {
    if (busy || clash) return
    setBusy(true)
    await run('create-bot', { name: finalName, color, avatar: { shape }, ...(model !== undefined ? { model } : {}) },
      value => open({ kind: 'bot', id: (value as Bot).id }))
    setBusy(false)
  }
  return (
    <Sheet>
      <SheetHeader title={t('Create new Bot')} left={{ label: t('Cancel'), onPress: () => navigation.goBack() }}
        right={{ label: t('Create'), onPress: () => void create(), disabled: busy || clash, strong: true }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive">
        {error ? <Text style={[typeScale.small, { color: p.danger, marginHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
        {/* The Bot as it will look, over its name, as the picks change. */}
        <View style={{ alignItems: 'center', marginTop: 8 }}>
          <Avatar bot={{ id: '', name: finalName, avatar: { shape }, color } as Bot} dark={dark} size={72} ring={p.main} />
        </View>
        <Section label={t('Name')}>
          <View style={styles.row}>
            <TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} value={name} onChangeText={setName}
              placeholder={t('New Bot')} placeholderTextColor={p.ink3} autoCapitalize="none" />
          </View>
          {clash ? <Text style={[typeScale.small, { color: p.danger, paddingHorizontal: 16, paddingBottom: 10 }]}>{t('Another Bot has this name.')}</Text> : null}
        </Section>
        <Section label={t('Character shape')}>
          <PickGrid columns={5} ids={SHAPES} picked={shape} onPick={setShape}
            draw={(id, size) => <Avatar bot={{ id: '', name: finalName, avatar: { shape: id }, color } as Bot} dark={dark} size={size * 0.72} ring={p.card} />} />
        </Section>
        <Section label={t('Character color')}>
          <PickGrid columns={6} ids={COLORS} picked={color} onPick={setColor}
            draw={(id, size) => <View style={{ width: size * 0.52, height: size * 0.52, borderRadius: size, backgroundColor: COLOR_PAINT[id] ?? inkColor(id, dark) }} />} />
        </Section>
        <View style={{ marginHorizontal: 14, marginTop: 18 }}>
          <Text style={[typeScale.caption, { color: p.ink3, marginBottom: 6, marginLeft: 4 }]}>{t('Model')}</Text>
          <ModelPicker current={model} onPick={setModel} />
        </View>
      </ScrollView>
    </Sheet>
  )
}

// ------------------------------------------------------------ Group settings

const ROOM_MODES: [string, string][] = [['admin', 'Admin leads'], ['everyone', 'Everyone']]

// The desktop's group overview (details-drawer.js GroupOverview): members with the
// admin marked, the goal, who answers, memory and usage. Its gear opens the group settings.
export function GroupDetails({ route, navigation }: any) {
  const { p, dark } = useTheme()
  const { team } = useTeam()
  const room = roomOf(team, route.params?.roomId ?? '')
  if (room === undefined) return <Screen title=""><BackRow title="" onBack={() => navigation.goBack()} /></Screen>
  const bots = team?.bots ?? []
  const members = (room.members ?? []).map(id => botOf(team, id)).filter((bot): bot is Bot => bot !== undefined)
  const admin = botOf(team, room.admin ?? '')
  const mode = admin !== undefined ? (room.mode ?? 'admin') : 'everyone'
  const notice = (room as { notice?: string }).notice
  return (
    <Screen title={room.name}>
      <View style={[styles.detailTop, { paddingTop: 8 }]}>
        <RoundButton label={t('Back')} onPress={() => navigation.goBack()}><ChevronLeftIcon color={p.ink2} /></RoundButton>
        <View style={{ flex: 1 }} />
        <RoundButton label={t('Group settings')} onPress={() => navigation.navigate('GroupSettings', { roomId: room.id })}><GearIcon size={18} color={p.ink2} /></RoundButton>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 40, paddingHorizontal: 18 }}>
        <View style={{ alignItems: 'center', paddingTop: 4 }}>
          <RoomAvatar room={room} bots={bots} dark={dark} size={56} ring={p.main} />
          <Text style={[typeScale.rowName, { color: p.ink, marginTop: 10, fontSize: 18, textAlign: 'center' }]}>{room.name}</Text>
          <Text style={[typeScale.caption, { color: p.ink3, marginTop: 2 }]}>{[t('{count} members', { count: members.length }), admin ? t('Admin {name}', { name: admin.name }) : t('No admin')].join(' · ')}</Text>
        </View>
        {notice
          ? <Text style={[typeScale.small, { color: p.ink2, marginTop: 14 }]} numberOfLines={5}>{notice}</Text>
          : <Pressable accessibilityRole="button" onPress={() => navigation.navigate('GroupSettings', { roomId: room.id })} style={{ alignItems: 'center', paddingVertical: 14 }}>
              <Text style={[typeScale.small, { color: p.ink3 }]}>{t('Add a notice in group settings')}</Text>
            </Pressable>}
        <DetailTitle text={t('Members · {count}', { count: members.length })} />
        {members.map(member => (
          <Pressable key={member.id} accessibilityRole="button" onPress={() => navigation.navigate('BotDetails', { botId: member.id })} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 }}>
            <Avatar bot={member} dark={dark} size={32} ring={p.main} />
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={[typeScale.settingsRow, { color: p.ink }]} numberOfLines={1}>{member.name}</Text>
                {member.id === room.admin ? <Text style={{ fontSize: 11, lineHeight: 16, paddingHorizontal: 6, borderRadius: 6, overflow: 'hidden', backgroundColor: p.hover, color: p.ink3 }}>{t('Admin')}</Text> : null}
              </View>
              {member.role ? <Text style={[typeScale.caption, { color: p.ink3 }]} numberOfLines={1}>{member.role}</Text> : null}
            </View>
          </Pressable>
        ))}
        <DetailTitle text={t('Who answers')} />
        <Text style={[typeScale.small, { color: p.ink }]}>{mode === 'admin' ? t('Admin leads') : t('Everyone')}</Text>
        {team?.memory === false ? null : (
          <>
            <DetailTitle text={t('Memory')} />
            <Pressable accessibilityRole="button" onPress={() => navigation.navigate('Memory', { id: room.id, name: room.name, group: true })}
              style={[styles.dropdown, { backgroundColor: p.card, borderColor: p.line }]}>
              <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]}>{t('Memory')}</Text>
              <Text style={[typeScale.small, { color: p.ink3 }]}>{t('Manage')}</Text>
              <ChevronRightIcon color={p.ink3} />
            </Pressable>
          </>
        )}
      </ScrollView>
    </Screen>
  )
}

export function GroupSettings({ route, navigation }: any) {
  const { p, dark } = useTheme()
  const { team } = useTeam()
  const { run, error } = useWrite(navigation)
  const room = roomOf(team, route.params?.roomId ?? '')
  if (room === undefined) return <Screen title=""><BackRow title="" onBack={() => navigation.goBack()} /></Screen>
  const bots = team?.bots ?? []
  const members = new Set(room.members ?? [])
  const update = (patch: Record<string, unknown>) => void run('update-room', { id: room.id, ...patch })
  const mode = room.admin !== undefined && bots.some(b => b.id === room.admin) ? (room.mode ?? 'admin') : 'everyone'
  return (
    <Screen title={room.name}>
      <BackRow title={t('Group settings')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {error ? <Text style={[typeScale.small, { color: p.danger, marginHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
        <Section label={t('Profile')}>
          <Field label={t('Name')} value={room.named === true ? room.name : ''} placeholder={t('Name after members')} onSave={name => update({ name })} />
          <Field label={t('Notice')} value={room.notice} multiline placeholder={t('Shared instructions every member reads before speaking…')} onSave={notice => update({ notice })} />
        </Section>
        <Section label={t('Who answers')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Segmented value={mode} onPick={id => update({ mode: id })}
              options={ROOM_MODES.map(([id, label]) => ({ id, label: t(label) }))} />
          </View>
        </Section>
        {/* Tick to add or remove a member; among members, the admin is marked and
            another member can take the role. */}
        <Section label={t('Members · {count}', { count: members.size })}>
          {bots.map(bot => {
            const inRoom = members.has(bot.id)
            const leads = room.admin === bot.id
            return (
              <Pressable key={bot.id} accessibilityRole="checkbox" accessibilityState={{ checked: inRoom }} onPress={() => update({ members: inRoom ? [...members].filter(id => id !== bot.id) : [...members, bot.id] })}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.hover }]}>
                <Avatar bot={bot} dark={dark} size={32} ring={p.card} />
                <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1, marginLeft: 10 }]} numberOfLines={1}>{bot.name}</Text>
                {leads ? <Text accessibilityRole="button" onPress={() => update({ admin: null })} suppressHighlighting style={[typeScale.caption, styles.adminTag, { color: p.accent, backgroundColor: p.hover }]}>{t('Admin')}</Text>
                  : inRoom ? <Text accessibilityRole="button" onPress={() => update({ admin: bot.id })} suppressHighlighting style={[typeScale.caption, { color: p.ink3, paddingHorizontal: 6, paddingVertical: 10 }]}>{t('Make admin')}</Text> : null}
                <View style={[styles.check, { marginLeft: 8, borderColor: inRoom ? p.accent : p.line2, backgroundColor: inRoom ? p.accent : 'transparent' }]}>
                  {inRoom ? <CheckIcon size={14} color={p.accentInk} /> : null}
                </View>
              </Pressable>
            )
          })}
        </Section>
        <Section label={t('Danger')}>
          <DangerRow label={t('Delete group')} confirm={t('Delete {name}?', { name: room.name })} onConfirm={() => void run('delete-room', { id: room.id }, () => navigation.popTo('Chat'))} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

export function NewGroup({ navigation }: any) {
  const { p, dark } = useTheme()
  const { team } = useTeam()
  const { run, error } = useWrite(navigation)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [admin, setAdmin] = useState<string | null>(null)
  const bots = team?.bots ?? []
  const open = useOpenWhenListed(navigation)
  // As on the desktop: an admin and at least one more Bot, and the admin opens
  // by asking what the group is for. The first Bot picked leads until another is chosen.
  const lead = admin !== null && picked.has(admin) ? admin : [...picked][0] ?? null
  const ready = lead !== null && picked.size >= 2
  const create = () => {
    if (!ready) return
    const members = [lead, ...[...picked].filter(id => id !== lead)]
    void run('create-room', { members, admin: lead, greet: true }, value => open({ kind: 'room', id: (value as Room).id }))
  }
  return (
    <Sheet>
      <SheetHeader title={t('Create group chat')} left={{ label: t('Cancel'), onPress: () => navigation.goBack() }}
        right={{ label: t('Create'), onPress: create, disabled: !ready, strong: true }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={[typeScale.small, { color: p.ink3, marginHorizontal: 18, marginTop: 14 }]}>{t('Pick at least two Bots. The admin leads the group.')}</Text>
        {error ? <Text style={[typeScale.small, { color: p.danger, marginHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
        {/* One list: tick the members; among them, the admin is marked and another
            member can take the role. */}
        <Section label={t('Members')}>
          {bots.map(bot => {
            const on = picked.has(bot.id)
            const leads = on && lead === bot.id
            return (
              <Pressable key={bot.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                onPress={() => setPicked(prev => { const next = new Set(prev); if (next.has(bot.id)) next.delete(bot.id); else next.add(bot.id); return next })}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.hover }]}>
                <Avatar bot={bot} dark={dark} size={32} ring={p.card} />
                <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1, marginLeft: 10 }]} numberOfLines={1}>{bot.name}</Text>
                {leads ? <Text style={[typeScale.caption, styles.adminTag, { color: p.accent, backgroundColor: p.hover }]}>{t('Admin')}</Text>
                  : on && picked.size > 1 ? <Text accessibilityRole="button" onPress={() => setAdmin(bot.id)} suppressHighlighting style={[typeScale.caption, { color: p.ink3, paddingHorizontal: 6, paddingVertical: 10 }]}>{t('Make admin')}</Text> : null}
                <View style={[styles.check, { marginLeft: 8, borderColor: on ? p.accent : p.line2, backgroundColor: on ? p.accent : 'transparent' }]}>
                  {on ? <CheckIcon size={14} color={p.accentInk} /> : null}
                </View>
              </Pressable>
            )
          })}
        </Section>
      </ScrollView>
    </Sheet>
  )
}


// ------------------------------------------------------------ Memory

export function Memory({ route, navigation }: any) {
  const { p } = useTheme()
  const { call } = useTeam()
  const id = String(route.params?.id ?? '')
  const name = String(route.params?.name ?? '')
  const [view, setView] = useState<{ summary?: string; entries?: { scope: string; topic: string | null; text: string; added?: string; by?: string | null }[]; error?: string } | null>(null)
  const [asking, setAsking] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ index: number | null; scope: string; topic: string; text: string } | null>(null)
  const owner = route.params?.group === true ? { roomId: id } : { botId: id }
  const load = () => void call('memory-view', owner).then(v => setView(v as typeof view)).catch(() => {})
  useState(() => { load(); return null })
  const forget = (entry: { scope: string; topic: string | null; text: string }) =>
    confirmDanger(t('Remove from memory'), t('Remove'), () => void call('memory-forget', { ...owner, scope: entry.scope, topic: entry.topic, text: entry.text }).then(load).catch(() => {}), entry.text)
  const saveEditor = () => {
    if (editor === null || !editor.text.trim()) return
    const existing = editor.index !== null ? view?.entries?.[editor.index] : undefined
    const body = { ...owner, scope: editor.scope, topic: editor.topic.trim() || null, text: existing?.text ?? '', next: editor.text.trim() }
    const endpoint = existing === undefined ? 'memory-add' : 'memory-edit'
    const payload = existing === undefined ? { ...owner, scope: editor.scope, topic: editor.topic.trim() || null, text: editor.text.trim() } : body
    setEditor(null)
    void call(endpoint, payload).then(load).catch(() => {})
  }
  const ask = () => { if (!question.trim()) return; setAsking(true); void call('memory-ask', { ...owner, text: question.trim() }).then(v => { const r = v as { reply?: string; view?: typeof view }; setAnswer(r.reply ?? null); if (r.view !== undefined) setView(r.view) }).catch(() => {}).finally(() => setAsking(false)) }
  return (
    <Screen title={name}>
      <BackRow title={t('Memory')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {view?.summary ? <Text style={[typeScale.caption, { color: p.ink3, margin: 18 }]}>{view.summary}</Text> : null}
        <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line, marginTop: 14 }]}>
          <View style={styles.row}>
            <TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} value={question} onChangeText={setQuestion}
              placeholder={t('Ask memory')} placeholderTextColor={p.ink3} onSubmitEditing={ask} />
            <Pressable accessibilityRole="button" onPress={ask}><Text style={[typeScale.settingsRow, { color: p.accent }]}>{asking ? '…' : t('Ask')}</Text></Pressable>
          </View>
          {answer !== null ? <Text style={[typeScale.settingsRow, { color: p.ink, paddingHorizontal: 16, paddingBottom: 12 }]}>{answer}</Text> : null}
        </View>
        <Section label={t('{count} entries', { count: view?.entries?.length ?? 0 })}>
          {(view?.entries ?? []).map((entry, i) => (
            <Pressable key={i} accessibilityRole="button" onPress={() => setEditor({ index: i, scope: entry.scope, topic: entry.topic ?? '', text: entry.text })} style={styles.row}>
              <View style={{ flex: 1 }}>
                {entry.topic ? <Text style={[typeScale.small, { color: p.ink3 }]}>{entry.topic}</Text> : null}
                <Text style={[typeScale.settingsRow, { color: p.ink }]}>{entry.text}</Text>
                <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]}>{[entry.added, entry.by ? t('by {name}', { name: entry.by }) : null].filter(Boolean).join(' · ')}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={t('Remove from memory')} onPress={() => forget(entry)} hitSlop={8}
                style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: p.ink3, fontSize: 17 }}>×</Text>
              </Pressable>
            </Pressable>
          ))}
          {view !== null && (view.entries ?? []).length === 0 ? <Row label={t('Nothing saved yet')} disabled /> : null}
          <Row label={t('Add')} onPress={() => setEditor({ index: null, scope: 'own', topic: '', text: '' })} />
        </Section>
      </ScrollView>
      <Modal visible={editor !== null} transparent animationType="fade" onRequestClose={() => setEditor(null)}>
        <Pressable style={styles.scrim} onPress={() => setEditor(null)} />
        <View style={[styles.sheet, { backgroundColor: p.card, borderColor: p.line }]}>
          <View style={styles.row}><TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} value={editor?.topic ?? ''} onChangeText={topic => setEditor(prev => prev === null ? null : { ...prev, topic })} placeholder={t('Topic')} placeholderTextColor={p.ink3} /></View>
          <View style={styles.row}><TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1, minHeight: 80, textAlignVertical: 'top' }]} value={editor?.text ?? ''} onChangeText={text => setEditor(prev => prev === null ? null : { ...prev, text })} placeholder={t('Text')} placeholderTextColor={p.ink3} multiline autoFocus /></View>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" onPress={() => setEditor(null)} style={{ flex: 1, alignItems: 'center' }}><Text style={[typeScale.settingsRow, { color: p.ink2 }]}>{t('Cancel')}</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={saveEditor} style={{ flex: 1, alignItems: 'center' }}><Text style={[typeScale.settingsRow, { color: p.accent, fontWeight: '600' }]}>{t('Save')}</Text></Pressable>
          </View>
        </View>
      </Modal>
    </Screen>
  )
}

// ------------------------------------------------------------ Schedules

const KINDS: [string, string][] = [['at', 'Once'], ['daily', 'Every day'], ['weekly', 'Every week'], ['every', 'Repeat']]
const UNITS: [string, number, string][] = [['minutes', 1, 'minutes'], ['hours', 60, 'hours'], ['days', 1440, 'days']]

const DAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日']
const todayString = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

const whenText = (task: { kind: string; time?: string; everySeconds?: number; minutes?: number; weekdays?: number[]; expression?: string; scheduledAt?: number }) => {
  switch (task.kind) {
    case 'at': return t('Once, {time}', { time: timeLabel(task.scheduledAt ?? 0) })
    case 'every': { const s = task.everySeconds ?? (task.minutes ?? 0) * 60; if (s % 86400 === 0) return s === 86400 ? t('Every day') : t('Every {count} days', { count: s / 86400 }); if (s % 3600 === 0) return s === 3600 ? t('Every hour') : t('Every {count} hours', { count: s / 3600 }); return t('Every {count} minutes', { count: Math.round(s / 60) }) }
    case 'daily': return t('Every day at {time}', { time: task.time ?? '' })
    case 'weekly': { const d = (task.weekdays ?? []).join(); return d === '1,2,3,4,5' ? t('Every weekday at {time}', { time: task.time ?? '' }) : d === '6,7' ? t('Every weekend at {time}', { time: task.time ?? '' }) : d === '1,2,3,4,5,6,7' ? t('Every day at {time}', { time: task.time ?? '' }) : t('Every {days} at {time}', { days: (task.weekdays ?? []).map(day => t('周{d}', { d: DAY_NAMES[day] ?? String(day) })).join('、'), time: task.time ?? '' }) }
    case 'cron': return t('On the schedule {expression}', { expression: task.expression ?? '' })
    default: return ''
  }
}

export function Schedules({ route, navigation }: any) {
  const { p } = useTheme()
  const { call } = useTeam()
  const { run, error } = useWrite(navigation)
  const botId = String(route.params?.botId ?? '')
  const sessionId = String(route.params?.sessionId ?? '')
  const [tasks, setTasks] = useState<{ id: string; botId?: string; sessionId: string; title: string; prompt?: string; kind: string; status: string; time?: string; everySeconds?: number; weekdays?: number[]; expression?: string; scheduledAt?: number }[]>([])
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState('daily')
  const [time, setTime] = useState('09:00')
  const [atDate, setAtDate] = useState(todayString)
  const [atTime, setAtTime] = useState('09:00')
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5])
  const [count, setCount] = useState('1')
  const [unit, setUnit] = useState('hours')
  const [adding, setAdding] = useState(false)
  const load = () => void call('schedules').then(v => setTasks(((v as { tasks?: typeof tasks })?.tasks ?? []).filter(t2 => t2.botId === undefined || t2.botId === botId))).catch(() => {})
  useState(() => { load(); return null })
  const when = () => {
    if (kind === 'at') { const at = new Date(`${atDate}T${atTime}`); return Number.isNaN(at.getTime()) ? null : { kind, at: at.toISOString() } }
    if (kind === 'every') { const minutes = Math.round(Number(count) * (UNITS.find(([id]) => id === unit)?.[1] ?? 60)); return minutes > 0 ? { kind, minutes } : null }
    return { kind, time, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(kind === 'weekly' ? { weekdays } : {}) }
  }
  const create = () => {
    const timing = when()
    if (!title.trim() || !prompt.trim() || timing === null) return
    setAdding(true)
    void run('schedule-create', { target: botId, title: title.trim(), prompt: prompt.trim(), when: timing }, () => { setTitle(''); setPrompt(''); load() })
    setAdding(false)
  }
  return (
    <Screen title={String(route.params?.name ?? '')}>
      <BackRow title={t('Schedules')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Schedules')}>
          {tasks.map(task => (
            <View key={task.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={[typeScale.settingsRow, { color: p.ink }]}>{task.title}</Text>
                <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]}>{whenText(task)}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={t('Delete task')} onPress={() => void run('schedule-delete', { sessionId: task.sessionId ?? sessionId, id: task.id }, load)} hitSlop={8}>
                <Text style={{ color: p.ink3, fontSize: 17 }}>×</Text>
              </Pressable>
            </View>
          ))}
          {tasks.length === 0 ? <Row label={t('Nothing saved yet')} disabled /> : null}
        </Section>
        <Section label={t('New task')}>
          <View style={styles.row}><TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} value={title} onChangeText={setTitle} placeholder={t('Morning briefing')} placeholderTextColor={p.ink3} /></View>
          <View style={styles.row}><TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1, minHeight: 70, textAlignVertical: 'top' }]} value={prompt} onChangeText={setPrompt} placeholder={t('Sum up what changed since yesterday and what needs me today.')} placeholderTextColor={p.ink3} multiline /></View>
          <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
            <Text style={[typeScale.small, { color: p.ink3, marginBottom: 6 }]}>{t('When')}</Text>
            <Segmented value={kind} onPick={id => setKind(id)} options={KINDS.map(([id, label]) => ({ id, label: t(label) }))} />
          </View>
          {kind === 'at' ? (
            <View style={styles.row}>
              <TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} value={atDate} onChangeText={setAtDate} placeholder="YYYY-MM-DD" placeholderTextColor={p.ink3} autoCapitalize="none" />
              <TextInput style={[typeScale.settingsRow, { color: p.ink, width: 70 }]} value={atTime} onChangeText={setAtTime} placeholder="09:00" placeholderTextColor={p.ink3} autoCapitalize="none" />
            </View>
          ) : null}
          {kind === 'weekly' ? (
            <View style={[styles.row, { flexWrap: 'wrap', gap: 6 }]}>
              {[1, 2, 3, 4, 5, 6, 7].map(day => (
                <Pressable key={day} accessibilityRole="button" accessibilityState={{ selected: weekdays.includes(day) }} onPress={() => setWeekdays(days => days.includes(day) ? days.filter(d => d !== day) : [...days, day].sort())}
                  style={[styles.dayBtn, { borderColor: weekdays.includes(day) ? p.accent : p.line, backgroundColor: weekdays.includes(day) ? p.accent : 'transparent' }]}>
                  <Text style={[typeScale.caption, { color: weekdays.includes(day) ? p.accentInk : p.ink2 }]}>{DAY_NAMES[day]}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {kind === 'daily' || kind === 'weekly' ? (
            <View style={styles.row}><Text style={[typeScale.settingsRow, { color: p.ink3 }]}>{t('Time')}</Text>
              <TextInput style={[typeScale.settingsRow, { color: p.ink, minWidth: 70 }]} value={time} onChangeText={setTime} placeholder="09:00" placeholderTextColor={p.ink3} autoCapitalize="none" /></View>
          ) : null}
          {kind === 'every' ? (
            <View style={styles.row}>
              <Text style={[typeScale.settingsRow, { color: p.ink3 }]}>{t('Every')}</Text>
              <TextInput style={[typeScale.settingsRow, { color: p.ink, width: 56, textAlign: 'center' }]} value={count} onChangeText={setCount} placeholder="1" placeholderTextColor={p.ink3} keyboardType="number-pad" />
              <View style={{ flex: 1 }}>
                <Segmented value={unit} onPick={setUnit} options={UNITS.map(([id, , label]) => ({ id, label: t(label) }))} />
              </View>
            </View>
          ) : null}
        </Section>
        <View style={{ paddingHorizontal: 18, marginTop: 14 }}>
          {error !== null ? <Text style={[typeScale.caption, { color: p.danger, marginTop: 6 }]}>{error}</Text> : null}
          <Pressable accessibilityRole="button" disabled={!title.trim() || !prompt.trim() || adding} onPress={create} style={({ pressed }) => [styles.cta, { backgroundColor: p.accent, opacity: !title.trim() || !prompt.trim() ? 0.5 : pressed ? 0.85 : 1 }]}>
            <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Create task')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  )
}

// ------------------------------------------------------------ Folder browser

export function Folder({ route, navigation }: any) {
  const { p } = useTheme()
  const { call } = useTeam()
  const { run } = useWrite(navigation)
  const [path, setPath] = useState(String(route.params?.current ?? ''))
  const [listing, setListing] = useState<{ path: string; parent: string | null; entries: { name: string; path: string }[]; truncated?: boolean } | null>(null)
  const [recent, setRecent] = useState<{ path: string; title: string }[]>([])
  const load = (next: string) => { setPath(next); void call('folder-list', { path: next }).then(v => setListing(v as typeof listing)).catch(() => {}) }
  useState(() => { void call('folders').then(v => setRecent((v as { folders?: { path: string; title: string }[] })?.folders ?? [])).catch(() => {}); load(path); return null })
  const choose = (picked: string) => {
    const target = route.params?.onPick === 'room' ? ['update-room', { id: route.params?.roomId, workDir: picked }]
      : route.params?.onPick === 'team' ? ['team-workspace', { path: picked }]
      : ['update-bot', { id: route.params?.botId, workDir: picked }]
    void run(target[0] as string, target[1] as Record<string, unknown>, () => navigation.goBack())
  }
  return (
    <Screen title="">
      <BackRow title={t('Working folder')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {recent.length > 0 ? (
          <Section label={t('Folders')}>
            {recent.map(folder => <Row key={folder.path} label={folder.title} value={folder.path} onPress={() => load(folder.path)} />)}
          </Section>
        ) : null}
        <Section label={path || '/'}>
          {listing?.parent ? <Row label={t('Up one level')} onPress={() => load(listing.parent ?? '')} /> : null}
          {(listing?.entries ?? []).map(entry => <Row key={entry.path} label={entry.name} onPress={() => load(entry.path)} />)}
          {listing !== null && listing.entries.length === 0 ? <Row label={t('No folders inside.')} disabled /> : null}
          {listing?.truncated ? <Row label={t('Some folders are not shown.')} disabled /> : null}
        </Section>
        <View style={{ paddingHorizontal: 18, marginTop: 14 }}>
          <Pressable accessibilityRole="button" onPress={() => choose(path)} style={({ pressed }) => [styles.cta, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}>
            <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Use this folder')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  )
}

// ------------------------------------------------------------ Usage

export function Usage({ route, navigation }: any) {
  const { p } = useTheme()
  const { call } = useTeam()
  const botId = String(route.params?.botId ?? '')
  type Totals = { input: number; cacheRead?: number; cacheWrite?: number; output: number }
  const [summary, setSummary] = useState<{ day?: Totals; week?: Totals; month?: Totals; models?: ({ key?: string; name: string } & Totals)[] } | null>(null)
  // The Bot's chat Session projections (channel.js RUN_STATS).
  const [stats, setStats] = useState<{ sessionStats?: { turns?: number; steps?: number }; contextPressure?: { pressureTokens?: number; contextWindow?: number } } | null>(null)
  useState(() => {
    void call('usage-summary', { botId }).then(v => setSummary(v as typeof summary)).catch(() => {})
    void call('run-stats', { botId }).then(v => setStats(v as typeof stats)).catch(() => {})
    return null
  })
  const sum = (t2: Totals) => t2.input + (t2.cacheRead ?? 0) + (t2.cacheWrite ?? 0) + t2.output
  const total = (t2?: Totals) => t2 === undefined ? '—' : sum(t2).toLocaleString()
  const pressure = stats?.contextPressure
  const context = pressure?.pressureTokens !== undefined && pressure.contextWindow ? `${Math.round(pressure.pressureTokens / pressure.contextWindow * 100)}%` : '—'
  return (
    <Screen title={String(route.params?.name ?? '')}>
      <BackRow title={t('Usage')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Usage')}>
          <Row label={t('Day')} value={total(summary?.day)} />
          <Row label={t('Week')} value={total(summary?.week)} />
          <Row label={t('Month')} value={total(summary?.month)} />
        </Section>
        <Section label={t('Model')}>
          {(summary?.models ?? []).map(m => <Row key={m.key ?? m.name} label={m.name} value={sum(m).toLocaleString()} />)}
        </Section>
        <Section label={t('Runs')}>
          <Row label={t('Turns')} value={String(stats?.sessionStats?.turns ?? '—')} />
          <Row label={t('Steps')} value={String(stats?.sessionStats?.steps ?? '—')} />
          <Row label={t('Context used')} value={context} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

// ------------------------------------------------------------ Computers

const fingerprint = async (key: string): Promise<string> => {
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key)
  return hex.slice(0, 16).toUpperCase().match(/.{4}/g)?.join(' ') ?? hex.slice(0, 16).toUpperCase()
}

export function Computers({ navigation }: any) {
  const { p } = useTheme()
  const { online, computer } = useTeam()
  const [list, setList] = useState<StoredComputer[]>([])
  const [prints, setPrints] = useState<Record<string, string>>({})
  useState(() => {
    void listComputers().then(({ computers }) => {
      setList(computers)
      computers.forEach(item => void fingerprint(item.hostKey).then(text => setPrints(prev => ({ ...prev, [item.hostDeviceId]: text }))).catch(() => {}))
    })
    return null
  })
  const actions = useContext(ComputersCtx)
  const forget = (id: string, name: string) => confirmDanger(t('Forget {name}?', { name }), t('Forget'), () => { void removeComputer(id).then(next => { setList(next); if (computer?.hostDeviceId === id) actions.reload() }) })
  return (
    <Screen title="">
      <BackRow title={t('Computers')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Computers')}>
          {list.map(item => {
            const active = item.hostDeviceId === computer?.hostDeviceId
            return (
              <View key={item.hostDeviceId} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={[typeScale.settingsRow, { color: p.ink }]}>{item.name || item.server}</Text>
                  <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]}>{active ? (online ? t('Connected') : t('Connecting…')) : t('Not connected')} · {prints[item.hostDeviceId] ?? '…'}</Text>
                </View>
                {active ? null : (
                  <Pressable accessibilityRole="button" onPress={() => actions.switchTo(item.hostDeviceId)} hitSlop={8}>
                    <Text style={[typeScale.settingsRow, { color: p.accent }]}>{t('Switch')}</Text>
                  </Pressable>
                )}
                <Pressable accessibilityRole="button" onPress={() => forget(item.hostDeviceId, item.name || item.server)} hitSlop={8} style={{ minWidth: 44, alignItems: 'flex-end' }}>
                  <Text style={[typeScale.settingsRow, { color: p.ink3 }]}>{t('Forget')}</Text>
                </Pressable>
              </View>
            )
          })}
          <Row label={t('Add a computer')} onPress={actions.add} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

// ------------------------------------------------------------ Secrets

export function Secrets({ navigation }: any) {
  const { p } = useTheme()
  const { team } = useTeam()
  const { run, error } = useWrite(navigation)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const secrets = (team as { secrets?: { name: string; description?: string; scope?: string | string[] }[] } | null)?.secrets ?? []
  const save = () => { if (!name.trim() || !value) return; const next = value; setValue(''); void run('secret-set', { name: name.trim(), value: next }, () => setName('')) }
  return (
    <Screen title="">
      <BackRow title={t('Secrets')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {error ? <Text style={[typeScale.small, { color: p.danger, marginHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
        <Section label={t('Secrets')}>
          {secrets.map(secret => (
            <View key={secret.name} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={[typeScale.settingsRow, { color: p.ink }]}>{secret.name}</Text>
                {secret.scope !== undefined ? <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]}>{secret.scope === 'all' ? t('All Bots') : (Array.isArray(secret.scope) ? secret.scope : [secret.scope]).map(id => botOf(team, id)?.name ?? id).join(', ')}</Text> : null}
              </View>
              <Pressable accessibilityRole="button" onPress={() => confirmDanger(t('Delete {name}?', { name: secret.name }), t('Delete'), () => void run('secret-delete', { name: secret.name }))} hitSlop={8} style={{ minWidth: 44, alignItems: 'flex-end' }}>
                <Text style={[typeScale.settingsRow, { color: p.ink3 }]}>{t('Delete')}</Text>
              </Pressable>
            </View>
          ))}
          {secrets.length === 0 ? <Row label={t('Nothing saved yet')} disabled /> : null}
        </Section>
        <Section label={t('Add')}>
          <View style={styles.row}><TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} value={name} onChangeText={setName} placeholder={t('Name')} placeholderTextColor={p.ink3} autoCapitalize="characters" /></View>
          <View style={styles.row}><TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} value={value} onChangeText={setValue} placeholder={t('Paste or type the key')} placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false} secureTextEntry /></View>
        </Section>
        <View style={{ paddingHorizontal: 18, marginTop: 14 }}>
          <Pressable accessibilityRole="button" disabled={!name.trim() || !value} onPress={save} style={({ pressed }) => [styles.cta, { backgroundColor: p.accent, opacity: !name.trim() || !value ? 0.5 : pressed ? 0.85 : 1 }]}>
            <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Save')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  detailTop: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 4 },
  tabs: { flexDirection: 'row', alignSelf: 'center', borderRadius: 10, padding: 2, marginTop: 14 },
  tab: { minWidth: 64, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  segments: { flexDirection: 'row', borderRadius: 10, padding: 2 },
  segment: { flex: 1, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  dropdown: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14 },
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  card: { marginHorizontal: 14, borderRadius: radius.card, borderWidth: 1, overflow: 'hidden', ...shadow(1) },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  cell: { width: 52, height: 52, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  segRow: { flexDirection: 'row', borderRadius: 9, padding: 2 },
  seg: { flex: 1, height: 32, borderRadius: 7, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  switch: { width: 46, height: 28, borderRadius: 14, padding: 3, justifyContent: 'center' },
  knob: { width: 22, height: 22, borderRadius: 11 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  adminTag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  pillBtn: { borderRadius: 20, paddingHorizontal: 18, height: 40, alignItems: 'center', justifyContent: 'center' },
  cta: { height: 48, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { position: 'absolute', left: 24, right: 24, top: '25%', maxHeight: '55%', borderRadius: radius.card, borderWidth: 1, overflow: 'hidden' },
  menuRow: { paddingHorizontal: 18, paddingVertical: 14 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dayBtn: { minWidth: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  tick: { position: 'absolute', top: 3, right: 3, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
})

interface BrowserFrame { mime: string; data: string; url?: string; title?: string }

export function BotBrowser({ bot, navigation }: { bot: Bot; navigation: { goBack: () => void } }) {
  const { p, dark } = useTheme()
  const { team, call } = useTeam()
  const focused = useIsFocused()
  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hold = (team as { browserHolds?: Record<string, { by?: string; reason?: string; note?: string; callId?: string }> } | null)?.browserHolds?.[bot.id]
  const refresh = useCallback(() => {
    void call('browser-frame', { botId: bot.id }).then(v => { setFrame(v as BrowserFrame); setError(null) },
      (f: { code?: string; message?: string }) => setError(f?.code === 'bot/not-found' ? t('This Bot has no open browser') : f?.message ?? String(f)))
  }, [call, bot.id])
  useEffect(() => {
    if (!focused) return
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [focused, refresh])
  const act = (endpoint: string, payload: Record<string, unknown>) => void call(endpoint, payload).catch(() => {}).then(refresh)
  return (
    <Screen title={t('Browser')}>
      <BackRow title={t('Browser')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 14 }}>
        {frame?.data ? (
          <Image source={{ uri: `data:${frame.mime};base64,${frame.data}` }} style={{ width: '100%', aspectRatio: 0.62, borderRadius: radius.card, backgroundColor: p.hover }} resizeMode="contain" />
        ) : null}
        {frame?.title ? <Text style={[typeScale.settingsRow, { color: p.ink, marginTop: 10 }]}>{frame.title}</Text> : null}
        {frame?.url ? <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]} numberOfLines={1}>{frame.url}</Text> : null}
        {error ? <Text style={[typeScale.small, { color: p.danger, marginTop: 12 }]}>{error}</Text> : null}
        {hold?.note ? <Text style={[typeScale.small, { color: p.ink2, marginTop: 12 }]}>{hold.note}</Text> : null}
        {/* A host with Bot browsers off has nothing to take over or stop. */}
        {(team as { browser?: unknown } | null)?.browser === false ? null : <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          {hold?.callId !== undefined ? (
            <>
              <Pressable accessibilityRole="button" onPress={() => act('browser-give-back', { botId: bot.id, outcome: 'done', callId: hold.callId })} style={[styles.pillBtn, { backgroundColor: p.accent }]}><Text style={{ color: p.accentInk, fontWeight: '600' }}>{t('Done')}</Text></Pressable>
              <Pressable accessibilityRole="button" onPress={() => act('browser-give-back', { botId: bot.id, outcome: 'skip', callId: hold.callId })} style={[styles.pillBtn, { backgroundColor: p.hover }]}><Text style={{ color: p.ink }}>{t('Skip')}</Text></Pressable>
            </>
          ) : hold?.by === 'user' ? (
            <Pressable accessibilityRole="button" onPress={() => act('browser-give-back', { botId: bot.id })} style={[styles.pillBtn, { backgroundColor: p.accent }]}><Text style={{ color: p.accentInk, fontWeight: '600' }}>{t('Give back')}</Text></Pressable>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => act('browser-takeover', { botId: bot.id })} style={[styles.pillBtn, { backgroundColor: p.hover }]}><Text style={{ color: p.ink }}>{t('Take over')}</Text></Pressable>
          )}
          <Pressable accessibilityRole="button" onPress={() => act('browser-stop', { botId: bot.id })} style={[styles.pillBtn, { backgroundColor: p.hover }]}><Text style={{ color: p.danger }}>{t('Stop')}</Text></Pressable>
        </View>}
      </ScrollView>
    </Screen>
  )
}
