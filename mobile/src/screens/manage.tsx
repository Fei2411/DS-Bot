// Bot and group management screens, mirroring the desktop details drawer and
// settings forms: Bot details, Edit Bot, Create Bot, group settings, and the
// "new" sheet. Every write goes through the same endpoints the desktop calls.
import { useState } from 'react'
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as ImagePicker from 'expo-image-picker'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons.tsx'
import { Avatar, RoomAvatar } from '../ui/marks.tsx'
import { radius, shadow, type as typeScale, useTheme, type Palette } from '../ui/tokens.ts'
import type { Bot, Room, TeamState } from '../connection.ts'

export const SHAPES = ['acorn', 'berry', 'bunny', 'gem', 'gumdrop', 'kitty', 'moon', 'peanut', 'star', 'wave']
export const COLORS = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray', 'aurora']
const COLOR_PAINT: Record<string, string> = {
  black: '#3c4048', brown: '#8d6e57', red: '#e5484d', orange: '#f76b15', yellow: '#d4a017',
  green: '#30a46c', cyan: '#12a5b4', blue: '#4f7df3', violet: '#7d5aff', magenta: '#d3458b', gray: '#8b8f98',
  aurora: '#5cc8a0',
}

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
  return (
    <View style={{ flex: 1, backgroundColor: p.main, paddingTop: insets.top }}>
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

function Segmented({ options, value, onPick }: { options: { id: string; label: string }[]; value: string; onPick: (id: string) => void }) {
  const { p } = useTheme()
  return (
    <View style={[styles.segRow, { borderColor: p.line }]}>
      {options.map(option => (
        <Pressable key={option.id} accessibilityRole="button" accessibilityState={{ selected: option.id === value }} onPress={() => onPick(option.id)}
          style={[styles.seg, option.id === value ? { backgroundColor: p.accent } : null]}>
          <Text style={[typeScale.caption, { color: option.id === value ? p.accentInk : p.ink2, fontWeight: '500' }]} numberOfLines={1}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

function DangerRow({ label, confirm, busy, onConfirm }: { label: string; confirm: string; busy?: boolean; onConfirm: () => void }) {
  const { p } = useTheme()
  const [armed, setArmed] = useState(false)
  return (
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => { if (armed) { setArmed(false); onConfirm() } else setArmed(true) }} style={styles.row}>
      <Text style={[typeScale.settingsRow, { color: p.danger, flex: 1 }]}>{armed ? confirm : label}</Text>
      {armed ? <ChevronRightIcon size={16} color={p.danger} /> : null}
    </Pressable>
  )
}

function EffortRow({ bot, model, onSaved }: { bot: Bot; model?: { key?: string; name: string; ref?: string }; onSaved?: () => void }) {
  const { p } = useTheme()
  const { call } = useTeam()
  const { run } = useWrite(null)
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<{ efforts: { id: string; name: string }[]; defaultEffort?: string } | null>(null)
  const ref = model?.ref ?? model?.key ?? bot.model
  const load = () => { setOpen(true); if (ref !== undefined) void call('efforts', { ref }).then(value => setList(value as { efforts: { id: string; name: string }[]; defaultEffort?: string })).catch(() => setList(null)) }
  if (list === null && !open) {
    // cheap probe: show the row whenever the bot has a model; hide only after efforts come back empty
    if (bot.model !== undefined) void call('efforts', { ref }).then(value => setList(value as { efforts: { id: string; name: string }[]; defaultEffort?: string })).catch(() => {})
  }
  if (list !== null && (list.efforts ?? []).length === 0) return null
  const current = (list?.efforts ?? []).find(e => e.id === bot.effort)?.name ?? (bot.effort ?? (list !== null ? t('Default') : '—'))
  return (
    <>
      <Row label={t('Effort')} value={current} onPress={load} />
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setOpen(false)} />
        <View style={[styles.sheet, { backgroundColor: p.card, borderColor: p.line }]}>
          {(list?.efforts ?? []).map(e => (
            <Pressable key={e.id} accessibilityRole="button" onPress={() => { setOpen(false); void run('update-bot', { id: bot.id, effort: e.id }) }} style={styles.menuRow}>
              <Text style={[typeScale.settingsRow, { color: e.id === bot.effort ? p.accent : p.ink }]}>{e.name}</Text>
            </Pressable>
          ))}
        </View>
      </Modal>
    </>
  )
}

function useWrite(navigation: any) {
  const { call } = useTeam()
  const [error, setError] = useState<string | null>(null)
  const run = async (name: string, body: Record<string, unknown>, done?: () => void) => {
    try { await call(name, body); setError(null); done?.() }
    catch (failure) { setError((failure as Error)?.message ?? String(failure)) }
  }
  return { run, error }
}

// ------------------------------------------------------------ Bot details

export function BotDetails({ route, navigation }: any) {
  const { p, dark } = useTheme()
  const { team } = useTeam()
  const { run, error } = useWrite(navigation)
  const bot = botOf(team, route.params?.botId ?? '')
  if (bot === undefined) return <Screen title=""><BackRow title="" onBack={() => navigation.goBack()} /></Screen>
  const main = isMain(team, bot.id)
  const model = (team?.models ?? []).find(m => m.key === bot.model || m.name === bot.model)
  return (
    <Screen title={bot.name}>
      <BackRow title={t('Details')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ alignItems: 'center', paddingTop: 12 }}>
          <Avatar bot={bot} dark={dark} size={64} ring={p.main} main={main} />
          <Text style={[typeScale.rowName, { color: p.ink, marginTop: 10 }]}>{bot.name}</Text>
          <Text style={[typeScale.caption, { color: p.ink3, marginTop: 2 }]}>{[bot.role, main ? t('Main Bot') : ''].filter(Boolean).join(' · ') || t('Bot')}</Text>
        </View>
        {error ? <Text style={[typeScale.small, { color: p.danger, marginHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
        <Section label={t('Model')}>
          <Row label={t('Model')} value={model?.name ?? bot.model ?? '—'} onPress={() => navigation.navigate('BotEdit', { botId: bot.id })} />
          <EffortRow bot={bot} model={model} onSaved={undefined} />
        </Section>
        <Section label={t('Working folder')}>
          <Row label={t('Folder')} value={bot.workDir ?? '—'} onPress={() => navigation.navigate('Folder', { current: bot.workDir, onPick: 'bot', botId: bot.id })} />
        </Section>
        <Section label={t('More')}>
          {team?.memory === false ? null : <Row label={t('Memory')} onPress={() => navigation.navigate('Memory', { id: bot.id, name: bot.name, group: false })} />}
          <Row label={t('Schedules')} onPress={() => navigation.navigate('Schedules', { botId: bot.id, name: bot.name, sessionId: bot.sessionId })} />
          <Row label={t('Usage')} onPress={() => navigation.navigate('Usage', { botId: bot.id, name: bot.name, sessionId: bot.sessionId })} />
        </Section>
        <Section label={t('Actions')}>
          <Row label={t('Edit Bot')} onPress={() => navigation.navigate('BotEdit', { botId: bot.id })} />
          {bot.private === true ? null : (
            <SwitchRow label={t('Main Bot')} hint={t('Can create and change Bots, and runs every group chat.')}
              on={main} onChange={next => void run('set-main', { id: bot.id, main: next })} />
          )}
          <Row label={t('Duplicate')} onPress={() => void run('duplicate-bot', { id: bot.id })} />
          <DangerRow label={t('Delete')} confirm={t('Tap again to delete this Bot')} onConfirm={() => void run('delete-bot', { id: bot.id }, () => navigation.goBack())} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

// ------------------------------------------------------------ Edit Bot

export function BotEdit({ route, navigation }: any) {
  const { p, dark } = useTheme()
  const { team } = useTeam()
  const { run, error } = useWrite(navigation)
  const [modelsOpen, setModelsOpen] = useState(false)
  const bot = botOf(team, route.params?.botId ?? '')
  if (bot === undefined) return <Screen title=""><BackRow title="" onBack={() => navigation.goBack()} /></Screen>
  const save = (patch: Record<string, unknown>) => void run('update-bot', { id: bot.id, ...patch })
  const shape = bot.avatar?.shape ?? 'star'
  const color = bot.color ?? 'blue'
  const models = team?.models ?? []
  return (
    <Screen title={bot.name}>
      <BackRow title={t('Edit Bot')} onBack={() => navigation.goBack()} />
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
          <View style={styles.grid}>
            {SHAPES.map(id => (
              <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: shape === id }} onPress={() => save({ avatar: { ...bot.avatar, shape: id } })}
                style={[styles.cell, shape === id ? { borderColor: p.accent, borderWidth: 2 } : { borderColor: p.line }]}>
                <Avatar bot={{ ...bot, avatar: { ...bot.avatar, shape: id }, color } as Bot} dark={dark} size={40} ring={p.card} />
                {shape === id ? <View style={[styles.tick, { backgroundColor: p.accent }]}><Text style={{ color: p.accentInk, fontSize: 10, fontWeight: '700' }}>✓</Text></View> : null}
              </Pressable>
            ))}
          </View>
        </Section>
        <Section label={t('Character color')}>
          <View style={styles.grid}>
            {COLORS.map(id => (
              <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: color === id }} onPress={() => save({ color: id })}
                style={[styles.cell, color === id ? { borderColor: p.accent, borderWidth: 2 } : { borderColor: p.line }]}>
                <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: COLOR_PAINT[id] ?? p.accent, alignItems: 'center', justifyContent: 'center' }}>
                  {color === id ? <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>✓</Text> : null}
                </View>
              </Pressable>
            ))}
          </View>
        </Section>
        <Section label={t('Photo')}>
          <Row label={t('Upload photo')} onPress={() => { void pickPhoto().then(image => { if (image !== null) save({ avatar: { ...bot.avatar, image } }) }) }} />
          {bot.avatar?.image ? <Row label={t('Remove photo')} onPress={() => save({ avatar: { shape: bot.avatar?.shape } })} /> : null}
        </Section>
        <Section label={t('Model')}>
          {models.length === 0 ? <Row label={t('Model')} value={bot.model ?? '—'} disabled /> : (
            <Row label={t('Model')} value={models.find(m => m.key === bot.model || m.name === bot.model)?.name ?? bot.model ?? '—'} onPress={() => setModelsOpen(true)} />
          )}
        </Section>
        <Section label={t('Instructions')}>
          <Field label={t('What this Bot does')} value={bot.instructions} multiline placeholder={t('What this Bot is responsible for…')} onSave={instructions => save({ instructions })} />
        </Section>
        <Section label={t('Privacy')}>
          <SwitchRow label={t('Private')} hint={t('Other Bots cannot read its folder, memory or chats, and you approve what it shares with them.')}
            on={bot.private === true} onChange={next => save({ private: next })} />
        </Section>
      </ScrollView>
      <Modal visible={modelsOpen} transparent animationType="fade" onRequestClose={() => setModelsOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setModelsOpen(false)} />
        <View style={[styles.sheet, { backgroundColor: p.card, borderColor: p.line }]}>
          <FlatList data={models} keyExtractor={item => String(item.key ?? item.name)} renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => { setModelsOpen(false); save({ model: item.key ?? item.name }) }} style={styles.menuRow}>
              <Text style={[typeScale.settingsRow, { color: (item.key ?? item.name) === bot.model ? p.accent : p.ink }]}>{item.name}</Text>
            </Pressable>
          )} />
        </View>
      </Modal>
    </Screen>
  )
}

// ------------------------------------------------------------ Create Bot

export function NewBot({ navigation }: any) {
  const { p } = useTheme()
  const { team } = useTeam()
  const { run, error } = useWrite(navigation)
  const [name, setName] = useState('')
  const [shape, setShape] = useState('star')
  const [color, setColor] = useState('blue')
  const [model, setModel] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const models = team?.models ?? []
  const finalName = name.trim() || t('New Bot')
  const clash = (team?.bots ?? []).some(bot => bot.name.toLowerCase() === finalName.toLowerCase())
  const create = async () => {
    if (busy || clash) return
    setBusy(true)
    await run('create-bot', { name: finalName, color, avatar: { shape }, ...(model !== undefined ? { model } : {}) },
      () => navigation.goBack())
    setBusy(false)
  }
  return (
    <Screen title={t('New Bot')}>
      <BackRow title={t('Create new Bot')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {error ? <Text style={[typeScale.small, { color: p.danger, marginHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
        <Section label={t('Character shape')}>
          <View style={styles.grid}>
            {SHAPES.map(id => (
              <Pressable key={id} onPress={() => setShape(id)} style={[styles.cell, shape === id ? { borderColor: p.accent, borderWidth: 2 } : { borderColor: p.line }]}>
                <Avatar bot={{ id: '', name: finalName, avatar: { shape: id }, color } as Bot} dark={false} size={40} ring={p.card} />
              </Pressable>
            ))}
          </View>
        </Section>
        <Section label={t('Character color')}>
          <View style={styles.grid}>
            {COLORS.map(id => (
              <Pressable key={id} onPress={() => setColor(id)} style={[styles.cell, color === id ? { borderColor: p.accent, borderWidth: 2 } : { borderColor: p.line }]}>
                <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: COLOR_PAINT[id] ?? p.accent }} />
              </Pressable>
            ))}
          </View>
        </Section>
        <Section label={t('Profile')}>
          <View style={styles.row}>
            <TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} value={name} onChangeText={setName}
              placeholder={t('New Bot')} placeholderTextColor={p.ink3} autoCapitalize="none" />
          </View>
          {clash ? <Text style={[typeScale.small, { color: p.danger, paddingHorizontal: 16, paddingBottom: 10 }]}>{t('Another Bot has this name.')}</Text> : null}
        </Section>
        <Section label={t('Model')}>
          {models.map(item => (
            <Pressable key={item.key ?? item.name} onPress={() => setModel(String(item.key ?? item.name))} style={styles.row}>
              <Text style={[typeScale.settingsRow, { color: (item.key ?? item.name) === model ? p.accent : p.ink, flex: 1 }]}>{item.name}</Text>
            </Pressable>
          ))}
          {models.length === 0 ? <Row label={t('Model')} value="—" disabled /> : null}
        </Section>
        <View style={{ paddingHorizontal: 18, marginTop: 24 }}>
          <Pressable accessibilityRole="button" disabled={busy || clash} onPress={() => void create()}
            style={({ pressed }) => [styles.cta, { backgroundColor: p.accent, opacity: busy || clash ? 0.5 : pressed ? 0.85 : 1 }]}>
            <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Create')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  )
}

// ------------------------------------------------------------ Group settings

const ROOM_MODES: [string, string][] = [['admin', 'Admin leads'], ['everyone', 'Everyone']]

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
        <Section label={t('Members · {count}', { count: members.size })}>
          {bots.map(bot => {
            const inRoom = members.has(bot.id)
            return (
              <Pressable key={bot.id} accessibilityRole="button" onPress={() => update({ members: inRoom ? [...members].filter(id => id !== bot.id) : [...members, bot.id] })} style={styles.row}>
                <Avatar bot={bot} dark={dark} size={28} ring={p.card} />
                <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1, marginLeft: 10 }]}>{bot.name}</Text>
                {room.admin === bot.id ? <Text style={[typeScale.small, { color: p.ink3, marginRight: 8 }]}>{t('Admin')}</Text> : null}
                <View style={[styles.check, { borderColor: inRoom ? p.accent : p.line, backgroundColor: inRoom ? p.accent : 'transparent' }]}>
                  {inRoom ? <Text style={{ color: p.accentInk, fontSize: 12, fontWeight: '700' }}>✓</Text> : null}
                </View>
              </Pressable>
            )
          })}
        </Section>
        <Section label={t('Admin')}>
          {bots.filter(b => members.has(b.id)).map(bot => (
            <Pressable key={bot.id} accessibilityRole="button" onPress={() => update({ admin: room.admin === bot.id ? null : bot.id })} style={styles.row}>
              <Text style={[typeScale.settingsRow, { color: room.admin === bot.id ? p.accent : p.ink, flex: 1 }]}>{bot.name}</Text>
              {room.admin === bot.id ? <Text style={{ color: p.accent }}>●</Text> : null}
            </Pressable>
          ))}
        </Section>
        <Section label={t('Danger')}>
          <DangerRow label={t('Delete group')} confirm={t('Tap again to delete this group')} onConfirm={() => void run('delete-room', { id: room.id }, () => navigation.goBack())} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

// ------------------------------------------------------------ New sheet

export function NewMenu({ navigation }: any) {
  const { p } = useTheme()
  return (
    <Screen title="">
      <BackRow title={t('New')} onBack={() => navigation.goBack()} />
      <View style={{ marginTop: 18 }}>
        <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
          <Row label={t('Create new Bot')} onPress={() => navigation.navigate('NewBot')} />
          <Row label={t('Create group chat')} onPress={() => navigation.navigate('NewGroup')} />
        </View>
      </View>
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
  const create = () => {
    const members = [...(admin !== null ? [admin] : []), ...[...picked].filter(id => id !== admin)]
    if (members.length === 0) return
    void run('create-room', { members }, () => navigation.goBack())
  }
  return (
    <Screen title={t('New group')}>
      <BackRow title={t('Create group chat')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {error ? <Text style={[typeScale.small, { color: p.danger, marginHorizontal: 18, marginTop: 10 }]}>{error}</Text> : null}
        <Section label={t('Members')}>
          {bots.map(bot => {
            const on = picked.has(bot.id)
            return (
              <Pressable key={bot.id} onPress={() => setPicked(prev => { const next = new Set(prev); if (next.has(bot.id)) next.delete(bot.id); else next.add(bot.id); return next })} style={styles.row}>
                <Avatar bot={bot} dark={dark} size={28} ring={p.card} />
                <Text style={[typeScale.settingsRow, { color: p.ink, flex: 1, marginLeft: 10 }]}>{bot.name}</Text>
                <View style={[styles.check, { borderColor: on ? p.accent : p.line, backgroundColor: on ? p.accent : 'transparent' }]}>
                  {on ? <Text style={{ color: p.accentInk, fontSize: 12, fontWeight: '700' }}>✓</Text> : null}
                </View>
              </Pressable>
            )
          })}
        </Section>
        <Section label={t('Admin')}>
          {[...picked].map(id => {
            const bot = bots.find(b => b.id === id)
            return bot === undefined ? null : (
              <Pressable key={id} onPress={() => setAdmin(admin === id ? null : id)} style={styles.row}>
                <Text style={[typeScale.settingsRow, { color: admin === id ? p.accent : p.ink, flex: 1 }]}>{bot.name}</Text>
                {admin === id ? <Text style={{ color: p.accent }}>●</Text> : null}
              </Pressable>
            )
          })}
        </Section>
        <View style={{ paddingHorizontal: 18, marginTop: 24 }}>
          <Pressable accessibilityRole="button" disabled={picked.size === 0} onPress={create}
            style={({ pressed }) => [styles.cta, { backgroundColor: p.accent, opacity: picked.size === 0 ? 0.5 : pressed ? 0.85 : 1 }]}>
            <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Create')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
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
  const owner = route.params?.group === true ? { roomId: id } : { botId: id }
  const load = () => void call('memory-view', owner).then(v => setView(v as typeof view)).catch(() => {})
  useState(() => { load(); return null })
  const forget = (entry: { scope: string; topic: string | null; text: string }) => void call('memory-forget', { ...owner, scope: entry.scope, topic: entry.topic, text: entry.text }).then(load).catch(() => {})
  const ask = () => { if (!question.trim()) return; setAsking(true); void call('memory-ask', { ...owner, text: question.trim() }).then(v => setAnswer((v as { answer?: string })?.answer ?? null)).catch(() => {}).finally(() => setAsking(false)) }
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
            <View key={i} style={styles.row}>
              <View style={{ flex: 1 }}>
                {entry.topic ? <Text style={[typeScale.small, { color: p.ink3 }]}>{entry.topic}</Text> : null}
                <Text style={[typeScale.settingsRow, { color: p.ink }]}>{entry.text}</Text>
                <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]}>{[entry.added, entry.by ? t('by {name}', { name: entry.by }) : null].filter(Boolean).join(' · ')}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={t('Remove from memory')} onPress={() => forget(entry)} hitSlop={8}>
                <Text style={{ color: p.ink3, fontSize: 17 }}>×</Text>
              </Pressable>
            </View>
          ))}
          {view !== null && (view.entries ?? []).length === 0 ? <Row label={t('Nothing saved yet')} disabled /> : null}
        </Section>
      </ScrollView>
    </Screen>
  )
}

// ------------------------------------------------------------ Schedules

const whenText = (task: { kind: string; time?: string; everySeconds?: number; weekdays?: number[]; expression?: string; scheduledAt?: number }) => {
  switch (task.kind) {
    case 'at': return t('Once, {time}', { time: new Date(task.scheduledAt ?? 0).toLocaleString() })
    case 'every': { const s = task.everySeconds ?? 0; if (s % 86400 === 0) return s === 86400 ? t('Every day') : t('Every {count} days', { count: s / 86400 }); if (s % 3600 === 0) return s === 3600 ? t('Every hour') : t('Every {count} hours', { count: s / 3600 }); return t('Every {count} minutes', { count: Math.round(s / 60) }) }
    case 'daily': return t('Every day at {time}', { time: task.time ?? '' })
    case 'weekly': { const d = (task.weekdays ?? []).join(); return d === '1,2,3,4,5' ? t('Every weekday at {time}', { time: task.time ?? '' }) : d === '6,7' ? t('Every weekend at {time}', { time: task.time ?? '' }) : t('Every day at {time}', { time: task.time ?? '' }) }
    case 'cron': return t('On the schedule {expression}', { expression: task.expression ?? '' })
    default: return ''
  }
}

export function Schedules({ route, navigation }: any) {
  const { p } = useTheme()
  const { call } = useTeam()
  const { run } = useWrite(navigation)
  const botId = String(route.params?.botId ?? '')
  const sessionId = String(route.params?.sessionId ?? '')
  const [tasks, setTasks] = useState<{ id: string; botId?: string; sessionId: string; title: string; prompt?: string; kind: string; status: string; time?: string; everySeconds?: number; weekdays?: number[]; expression?: string; scheduledAt?: number }[]>([])
  const [title, setTitle] = useState('')
  const [time, setTime] = useState('09:00')
  const [adding, setAdding] = useState(false)
  const load = () => void call('schedules').then(v => setTasks(((v as typeof tasks) ?? []).filter(t2 => t2.botId === undefined || t2.botId === botId))).catch(() => {})
  useState(() => { load(); return null })
  const create = () => { if (!title.trim()) return; setAdding(false); void run('schedule-create', { botId, title: title.trim(), kind: 'daily', time, sessionId }, () => { setTitle(''); load() }) }
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
          <View style={styles.row}><TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1 }]} value={title} onChangeText={setTitle} placeholder={t('Title')} placeholderTextColor={p.ink3} /></View>
          <View style={styles.row}><Text style={[typeScale.settingsRow, { color: p.ink3 }]}>{t('Every day at {time}', { time: '' })}</Text>
            <TextInput style={[typeScale.settingsRow, { color: p.ink, minWidth: 60 }]} value={time} onChangeText={setTime} placeholder="09:00" placeholderTextColor={p.ink3} autoCapitalize="none" /></View>
        </Section>
        <View style={{ paddingHorizontal: 18, marginTop: 14 }}>
          <Pressable accessibilityRole="button" disabled={!title.trim()} onPress={create} style={({ pressed }) => [styles.cta, { backgroundColor: p.accent, opacity: !title.trim() ? 0.5 : pressed ? 0.85 : 1 }]}>
            <Text style={[typeScale.settingsRow, { color: p.accentInk, fontWeight: '600' }]}>{t('Create')}</Text>
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
    const target = route.params?.onPick === 'room' ? ['update-room', { id: route.params?.roomId, workDir: picked }] : ['update-bot', { id: route.params?.botId, workDir: picked }]
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
  const [summary, setSummary] = useState<{ day?: { input: number; output: number }; week?: { input: number; output: number }; month?: { input: number; output: number }; models?: { key?: string; name: string; input: number; output: number }[] } | null>(null)
  const [stats, setStats] = useState<{ parts?: number; messages?: number; turns?: number; tools?: number } | null>(null)
  useState(() => {
    void call('usage-summary', { botId }).then(v => setSummary(v as typeof summary)).catch(() => {})
    void call('run-stats', { sessionId: route.params?.sessionId }).then(v => setStats(v as typeof stats)).catch(() => {})
    return null
  })
  const total = (t2?: { input: number; output: number }) => t2 === undefined ? '—' : (t2.input + t2.output).toLocaleString()
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
          {(summary?.models ?? []).map(m => <Row key={m.key ?? m.name} label={m.name} value={(m.input + m.output).toLocaleString()} />)}
        </Section>
        <Section label={t('Runs')}>
          <Row label={t('Turns')} value={String(stats?.turns ?? '—')} />
          <Row label={t('Tools')} value={String(stats?.tools ?? '—')} />
          <Row label={t('Messages')} value={String(stats?.messages ?? '—')} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  card: { marginHorizontal: 14, borderRadius: radius.card, borderWidth: 1, overflow: 'hidden', ...shadow(1) },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  cell: { width: 52, height: 52, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  segRow: { flexDirection: 'row', borderWidth: 1, borderRadius: radius.pill, overflow: 'hidden' },
  seg: { flex: 1, height: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  switch: { width: 46, height: 28, borderRadius: 14, padding: 3, justifyContent: 'center' },
  knob: { width: 22, height: 22, borderRadius: 11 },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  cta: { height: 48, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { position: 'absolute', left: 24, right: 24, top: '25%', maxHeight: '55%', borderRadius: radius.card, borderWidth: 1, overflow: 'hidden' },
  menuRow: { paddingHorizontal: 18, paddingVertical: 14 },
  tick: { position: 'absolute', top: 3, right: 3, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
})
