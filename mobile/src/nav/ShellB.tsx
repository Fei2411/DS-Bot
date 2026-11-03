import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { useNavigation } from '@react-navigation/native'
import { useEffect, useState } from 'react'
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as SecureStore from 'expo-secure-store'
import { Drawer, useDrawer } from './Drawer.tsx'
import { ForgetCtx } from './forget.ts'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { shadow, type as typeScale, useTheme } from '../ui/tokens.ts'
import { Avatar, RoomAvatar, YouMark } from '../ui/marks.tsx'
import { GearIcon, SidebarIcon, SideIcon } from '../ui/icons.tsx'
import { ChatView } from '../screens/Chat.tsx'
import { NeedsYou } from '../screens/NeedsYou.tsx'
import { Settings } from '../screens/Settings.tsx'
import { TeamList, type ChatTarget } from '../screens/TeamList.tsx'
import { BotDetails, BotEdit, NewBot, NewMenu, NewGroup, GroupSettings, Memory, Schedules, Folder, Usage, Computers, Secrets } from '../screens/manage.tsx'
import { Providers, Connectors, Capabilities, TeamUsage, Location, Updates, About } from '../screens/settings-pages.tsx'
import { Side } from '../screens/side.tsx'
import { BotBrowser } from '../screens/manage.tsx'
import type { Bot, Room } from '../connection.ts'
import { pendingCountOf } from './pending.ts'

const Stack = createNativeStackNavigator()
const LAST_KEY = 'dsbot.lastChat'

// Drawer content = the desktop sidebar as a drawer: "Needs you" row on top when
// anything is pending, the team list, and a footer with the You mark + gear.
function DrawerContent() {
  const { p } = useTheme()
  const { team } = useTeam()
  const insets = useSafeAreaInsets()
  const navigation = useNavigation<any>()
  const drawer = useDrawer()
  const pending = pendingCountOf(team)
  const open = (target: ChatTarget | { kind: 'needs' } | { kind: 'settings' }) => {
    drawer.close()
    if (target.kind === 'needs') navigation.navigate('Needs')
    else if (target.kind === 'settings') navigation.navigate('Settings')
    else navigation.navigate('Chat', target)
  }
  return (
    <View style={{ flex: 1, backgroundColor: p.sidebar }}>
      {pending > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => open({ kind: 'needs' })}
          style={({ pressed }) => [styles.needsRow, { backgroundColor: pressed ? p.hover : 'transparent', marginTop: insets.top + 8 }]}>
          <Text style={[typeScale.rowName, { color: p.accent, flex: 1 }]}>{t('Needs you')}</Text>
          <View style={[styles.badge, { backgroundColor: p.accent }]}><Text style={{ color: p.accentInk, fontSize: 12, fontWeight: '600' }}>{pending}</Text></View>
        </Pressable>
      ) : <View style={{ height: insets.top + 8 }} />}
      <View style={{ flex: 1 }}>
        <TeamList onOpen={open} />
      </View>
      <Pressable accessibilityRole="button" onPress={() => { drawer.close(); navigation.navigate('NewMenu') }}
        style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 12, backgroundColor: pressed ? p.hover : 'transparent' }]}>
        <Text style={[typeScale.rowName, { color: p.accent }]}>+ {t('New')}</Text>
      </Pressable>
      <View style={[styles.foot, { borderTopColor: p.line, paddingBottom: insets.bottom + 8 }]}>
        <View style={styles.you}><YouMark dark={useTheme().dark} size={24} /><Text style={[typeScale.rowName, { color: p.ink }]}>{t('You')}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Settings')} onPress={() => open({ kind: 'settings' })} hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <GearIcon size={20} color={p.ink2} />
        </Pressable>
      </View>
    </View>
  )
}

function Pill({ title, bot, room, bots }: { title: string; bot?: Parameters<typeof Avatar>[0]['bot']; room?: Room; bots: Bot[] }) {
  const { p, dark } = useTheme()
  return (
    <View style={[styles.pill, { backgroundColor: p.card, borderColor: p.line2 }]}>
      {bot ? <Avatar bot={bot} dark={dark} size={24} ring={p.card} /> : room ? <RoomAvatar room={room} bots={bots} dark={dark} size={24} ring={p.card} /> : null}
      <Text style={{ color: p.ink, fontSize: 14, lineHeight: 20, fontWeight: '500', marginLeft: bot || room ? 8 : 0 }} numberOfLines={1}>{title}</Text>
    </View>
  )
}

function Header({ title, bot, room, bots = [], onMenu, onPill, onSide }: { title: string; bot?: Parameters<typeof Avatar>[0]['bot']; room?: Room; bots?: Bot[]; onMenu: () => void; onPill?: () => void; onSide?: () => void }) {
  const { p } = useTheme()
  const { team } = useTeam()
  const pending = pendingCountOf(team) > 0
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: insets.top + 4, paddingBottom: 8, paddingHorizontal: 10, backgroundColor: p.main }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Open team list" onPress={onMenu} hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <SidebarIcon size={20} color={p.ink2} />
        {pending ? <View style={{ position: 'absolute', top: 8, right: 8, width: 8, height: 8, borderRadius: 4, backgroundColor: p.accent }} /> : null}
      </Pressable>
      <View style={{ flex: 1, alignItems: 'center' }}>
        {onPill !== undefined ? <Pressable accessibilityRole="button" onPress={onPill}><Pill title={title} bot={bot} room={room} bots={bots} /></Pressable> : <Pill title={title} bot={bot} room={room} bots={bots} />}
      </View>
      {onSide !== undefined ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t('Side chat')} onPress={onSide} hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <SideIcon size={20} color={p.ink2} />
        </Pressable>
      ) : <View style={{ width: 44 }} />}
    </View>
  )
}

function ChatScreenB({ route, navigation }: any) {
  const { team } = useTeam()
  const { p, dark } = useTheme()
  const drawer = useDrawer()
  const params = route.params as ChatTarget | undefined
  useEffect(() => { if (params) void SecureStore.setItemAsync(LAST_KEY, JSON.stringify(params)) }, [params])
  const fallback = team?.bots?.find(b => b.id === team?.mainBotId) ?? team?.bots?.[0]
  const kind = params?.kind ?? 'bot'
  const id = params?.id ?? fallback?.id ?? ''
  const bot = kind === 'bot' ? team?.bots?.find(b => b.id === id) : undefined
  const room = kind === 'room' ? team?.rooms?.find(r => r.id === id) : undefined
  // A saved chat that the team no longer has is dropped and falls back to the
  // first Main Bot instead of opening an empty screen.
  const missing = team !== null && params !== undefined && ((kind === 'bot' && bot === undefined) || (kind === 'room' && room === undefined))
  useEffect(() => {
    if (!missing) return
    void SecureStore.deleteItemAsync(LAST_KEY)
    if (fallback !== undefined) navigation.replace('Chat', { kind: 'bot', id: fallback.id })
  }, [missing])
  const header = <Header title={bot?.name ?? room?.name ?? ''} bot={bot} room={room} bots={team?.bots ?? []} onMenu={() => drawer.open()} onPill={() => { if (bot) navigation.navigate('BotDetails', { botId: bot.id }); else if (room) navigation.navigate('GroupSettings', { roomId: room.id }) }} onSide={bot !== undefined && bot.sessionId !== undefined ? () => navigation.navigate('Side', { bot, sessionId: bot.sessionId }) : undefined} />
  if (team === null) return <View style={{ flex: 1, backgroundColor: p.main }}>{header}</View>
  const onMissing = () => { void SecureStore.deleteItemAsync(LAST_KEY); if (fallback !== undefined) navigation.replace('Chat', { kind: 'bot', id: fallback.id }) }
  return <ChatView bot={bot} room={room} header={header} onMissing={onMissing} />
}

function NeedsScreenB({ navigation }: any) {
  const { p } = useTheme()
  const drawer = useDrawer()
  return (
    <View style={{ flex: 1, backgroundColor: p.main }}>
      <Header title={t('Needs you')} onMenu={() => drawer.open()} />
      <NeedsYou onOpen={target => navigation.navigate('Chat', target)} />
    </View>
  )
}

function SettingsScreenB({ navigation }: any) {
  const { p } = useTheme()
  const drawer = useDrawer()
  return (
    <View style={{ flex: 1, backgroundColor: p.main }}>
      <Header title={t('Settings')} onMenu={() => drawer.open()} />
      <Settings navigation={navigation} />
    </View>
  )
}

// A question or approval that lands while the app is open shows as a banner at
// the top; a tap opens the chat it belongs to.
function NoticeBanner() {
  const { p } = useTheme()
  const { onFeed } = useTeam()
  const navigation = useNavigation<any>()
  const insets = useSafeAreaInsets()
  const [notice, setNotice] = useState<{ text: string; target: ChatTarget } | null>(null)
  useEffect(() => {
    if (onFeed === undefined) return
    return onFeed((event, data) => {
      if (event !== 'notice' || (data?.kind !== 'question' && data?.kind !== 'approval')) return
      const target: ChatTarget = data.roomId !== undefined && data.roomId !== null
        ? { kind: 'room', id: data.roomId }
        : { kind: 'bot', id: data.botId ?? '' }
      setNotice({ text: data.title !== undefined ? `${data.title}：${data.text ?? ''}` : (data.text ?? ''), target })
      setTimeout(() => setNotice(current => current), 8000)
    })
  }, [onFeed])
  if (notice === null) return null
  return (
    <Pressable accessibilityRole="button" onPress={() => { navigation.navigate('Chat', notice.target); setNotice(null) }}
      style={[{ position: 'absolute', top: insets.top + 8, left: 12, right: 12, zIndex: 10, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: p.card, borderColor: p.accent, borderWidth: 1 }, shadow(2)]}>
      <Text style={[typeScale.small, { color: p.ink }]} numberOfLines={2}>{notice.text}</Text>
    </Pressable>
  )
}

function Inner({ initial, onForget }: { initial: ChatTarget | null; onForget: () => void }) {
  const { p } = useTheme()
  return (
    <View style={{ flex: 1 }}>
    <NoticeBanner />
    <ForgetCtx.Provider value={onForget}>
    <Stack.Navigator initialRouteName="Chat" screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="Chat" component={ChatScreenB} initialParams={initial ?? undefined} />
      <Stack.Screen name="Needs">{(props: any) => <NeedsScreenB {...props} />}</Stack.Screen>
      <Stack.Screen name="Settings">{(props: any) => <SettingsScreenB onForget={onForget} {...props} />}</Stack.Screen>
      {/* Home is only a background color while Chat resolves the first Main Bot. */}
      <Stack.Screen name="BotDetails">{(props: any) => <BotDetails {...props} />}</Stack.Screen>
      <Stack.Screen name="BotEdit">{(props: any) => <BotEdit {...props} />}</Stack.Screen>
      <Stack.Screen name="NewBot">{(props: any) => <NewBot {...props} />}</Stack.Screen>
      <Stack.Screen name="NewMenu">{(props: any) => <NewMenu {...props} />}</Stack.Screen>
      <Stack.Screen name="NewGroup">{(props: any) => <NewGroup {...props} />}</Stack.Screen>
      <Stack.Screen name="GroupSettings">{(props: any) => <GroupSettings {...props} />}</Stack.Screen>
      <Stack.Screen name="Memory">{(props: any) => <Memory {...props} />}</Stack.Screen>
      <Stack.Screen name="Schedules">{(props: any) => <Schedules {...props} />}</Stack.Screen>
      <Stack.Screen name="Folder">{(props: any) => <Folder {...props} />}</Stack.Screen>
      <Stack.Screen name="Usage">{(props: any) => <Usage {...props} />}</Stack.Screen>
      <Stack.Screen name="Computers">{(props: any) => <Computers {...props} />}</Stack.Screen>
      <Stack.Screen name="Secrets">{(props: any) => <Secrets {...props} />}</Stack.Screen>
      <Stack.Screen name="Providers">{(props: any) => <Providers {...props} />}</Stack.Screen>
      <Stack.Screen name="Connectors">{(props: any) => <Connectors {...props} />}</Stack.Screen>
      <Stack.Screen name="Capabilities">{(props: any) => <Capabilities {...props} />}</Stack.Screen>
      <Stack.Screen name="TeamUsage">{(props: any) => <TeamUsage {...props} />}</Stack.Screen>
      <Stack.Screen name="Location">{(props: any) => <Location {...props} />}</Stack.Screen>
      <Stack.Screen name="Updates">{(props: any) => <Updates {...props} />}</Stack.Screen>
      <Stack.Screen name="About">{(props: any) => <About {...props} />}</Stack.Screen>
      <Stack.Screen name="BotBrowser">{({ route, navigation }: any) => <BotBrowser bot={route.params.bot} navigation={navigation} />}</Stack.Screen>
      <Stack.Screen name="Side">{({ route, navigation }: any) => <Side bot={route.params.bot} sessionId={route.params.sessionId} navigation={navigation} />}</Stack.Screen>
      <Stack.Screen name="Placeholder">{({ route, navigation }: any) => (
        <View style={{ flex: 1, backgroundColor: '#f6f8fb' }}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 14, paddingTop: 60 }}>
            <Text style={{ fontSize: 16, fontWeight: '500' }}>{String(route.params?.title ?? '')}</Text>
            <Text style={{ color: '#4f7df3', fontSize: 15, marginTop: 8 }} onPress={() => navigation.goBack()}>{'‹'}</Text>
          </View>
        </View>
      )}</Stack.Screen>
      <Stack.Screen name="Home">{() => <View style={{ flex: 1, backgroundColor: p.main }} />}</Stack.Screen>
    </Stack.Navigator>
    </ForgetCtx.Provider>
    </View>
  )
}

export default function ShellB({ onForget }: { onForget: () => void }) {
  const { p } = useTheme()
  const width = Math.min(Dimensions.get('window').width * 0.85, 340)
  // Render the navigator only once the saved chat is known, so it can start on it.
  const [saved, setSaved] = useState<ChatTarget | null | undefined>(undefined)
  useEffect(() => {
    void SecureStore.getItemAsync(LAST_KEY).then(text => {
      try { setSaved(text === null ? null : JSON.parse(text) as ChatTarget) } catch { setSaved(null) }
    })
  }, [])
  // The left edge swipe is the iOS back gesture on pushed screens, so the
  // drawer only claims it while the root Chat is on top. The shell sits
  // outside the navigator, so it tracks the top route through the container's
  // own navigation object instead of useNavigationState.
  const navigation = useNavigation<any>()
  const [top, setTop] = useState('Chat')
  useEffect(() => {
    const update = () => {
      const state = navigation.getState()
      setTop(state?.routes?.[state.index]?.name ?? 'Chat')
    }
    update()
    return navigation.addListener('state', update)
  }, [navigation])
  if (saved === undefined) return <View style={{ flex: 1, backgroundColor: p.main }} />
  return (
    <Drawer width={width} content={<DrawerContent />} edgeEnabled={top === 'Chat'}>
      <Inner initial={saved} onForget={onForget} />
    </Drawer>
  )
}

const styles = StyleSheet.create({
  needsRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginBottom: 4, borderRadius: 10, paddingHorizontal: 12, height: 44 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8 },
  you: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, height: 44 },
  pill: { flexDirection: 'row', alignItems: 'center', height: 40, borderRadius: 20, paddingHorizontal: 14, borderWidth: 0.5, maxWidth: '70%', ...shadow(1) },
})
