import { createDrawerNavigator } from '@react-navigation/drawer'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { useEffect, useRef } from 'react'
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as SecureStore from 'expo-secure-store'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { shadow, type as typeScale, useTheme } from '../ui/tokens.ts'
import { Avatar } from '../ui/marks.tsx'
import { GearIcon, SidebarIcon } from '../ui/icons.tsx'
import { ChatView } from '../screens/Chat.tsx'
import { NeedsYou } from '../screens/NeedsYou.tsx'
import { Settings } from '../screens/Settings.tsx'
import { TeamList, type ChatTarget } from '../screens/TeamList.tsx'
import { pendingCountOf } from './pending.ts'

const Drawer = createDrawerNavigator()
const Stack = createNativeStackNavigator()
const LAST_KEY = 'dsbot.lastChat'

// Drawer content = the desktop sidebar as a drawer: "Needs you" row on top when
// anything is pending, the team list, and a footer with the You mark + gear.
function DrawerContent({ navigation }: any) {
  const { p } = useTheme()
  const { team } = useTeam()
  const insets = useSafeAreaInsets()
  const pending = pendingCountOf(team)
  const open = (target: ChatTarget | { kind: 'needs' } | { kind: 'settings' }) => {
    navigation.closeDrawer()
    if (target.kind === 'needs') navigation.navigate('Needs')
    else if (target.kind === 'settings') navigation.navigate('Settings')
    else {
      void SecureStore.setItemAsync(LAST_KEY, JSON.stringify(target))
      navigation.navigate('Chat', target)
    }
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
      <View style={[styles.foot, { borderTopColor: p.line, paddingBottom: insets.bottom + 8 }]}>
        <View style={styles.you}><Text style={[typeScale.rowName, { color: p.ink }]}>{t('You')}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Settings')} onPress={() => open({ kind: 'settings' })} hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <GearIcon size={20} color={p.ink2} />
        </Pressable>
      </View>
    </View>
  )
}

function Pill({ title, bot }: { title: string; bot?: { name: string } & Parameters<typeof Avatar>[0]['bot'] }) {
  const { p, dark } = useTheme()
  return (
    <View style={[styles.pill, { backgroundColor: p.card, borderColor: p.line2 }]}>
      {bot ? <Avatar bot={bot} dark={dark} size={24} ring={p.card} /> : null}
      <Text style={{ color: p.ink, fontSize: 14, lineHeight: 20, fontWeight: '500', marginLeft: bot ? 8 : 0 }} numberOfLines={1}>{title}</Text>
    </View>
  )
}

function Header({ title, bot, onMenu }: { title: string; bot?: Parameters<typeof Avatar>[0]['bot']; onMenu: () => void }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: insets.top + 4, paddingBottom: 8, paddingHorizontal: 10, backgroundColor: p.main }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Open team list" onPress={onMenu} hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <SidebarIcon size={20} color={p.ink2} />
      </Pressable>
      <View style={{ flex: 1, alignItems: 'center' }}><Pill title={title} bot={bot} /></View>
      <View style={{ width: 44 }} />
    </View>
  )
}

function ChatScreenB({ route, navigation }: any) {
  const { team } = useTeam()
  const { p, dark } = useTheme()
  const params = route.params as ChatTarget | undefined
  const fallback = team?.bots?.find(b => b.id === team?.mainBotId) ?? team?.bots?.[0]
  const kind = params?.kind ?? 'bot'
  const id = params?.id ?? fallback?.id ?? ''
  const bot = kind === 'bot' ? team?.bots?.find(b => b.id === id) : undefined
  const room = kind === 'room' ? team?.rooms?.find(r => r.id === id) : undefined
  const header = <Header title={bot?.name ?? room?.name ?? ''} bot={bot} onMenu={() => navigation.openDrawer()} />
  if (team === null) return <View style={{ flex: 1, backgroundColor: p.main }}>{header}</View>
  return <ChatView bot={bot} room={room} header={header} />
}

function NeedsScreenB({ navigation }: any) {
  const { p } = useTheme()
  return (
    <View style={{ flex: 1, backgroundColor: p.main }}>
      <Header title={t('Needs you')} onMenu={() => navigation.openDrawer()} />
      <NeedsYou onOpen={target => { void SecureStore.setItemAsync(LAST_KEY, JSON.stringify(target)); navigation.navigate('Chat', target) }} />
    </View>
  )
}

function SettingsScreenB({ onForget, navigation }: any) {
  const { p } = useTheme()
  return (
    <View style={{ flex: 1, backgroundColor: p.main }}>
      <Header title={t('Settings')} onMenu={() => navigation.openDrawer()} />
      <Settings onForget={onForget} />
    </View>
  )
}

function Inner({ onForget }: { onForget: () => void }) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="Chat" component={ChatScreenB} />
      <Stack.Screen name="Needs">{(props: any) => <NeedsScreenB {...props} />}</Stack.Screen>
      <Stack.Screen name="Settings">{(props: any) => <SettingsScreenB onForget={onForget} {...props} />}</Stack.Screen>
    </Stack.Navigator>
  )
}

export default function ShellB({ onForget }: { onForget: () => void }) {
  const { p } = useTheme()
  const width = Math.min(Dimensions.get('window').width * 0.85, 340)
  const drawerRef = useRef<{ openDrawer: () => void; navigate: (name: string, params?: unknown) => void } | null>(null)
  // Open on the last opened chat (else the first Main Bot).
  useEffect(() => {
    void SecureStore.getItemAsync(LAST_KEY).then(saved => {
      if (saved === null) return
      try { drawerRef.current?.navigate('Main', { screen: 'Chat', params: JSON.parse(saved) }) } catch { /* malformed */ }
    })
  }, [])
  return (
    <Drawer.Navigator
      screenOptions={{
        headerShown: false,
        drawerType: 'front',
        drawerStyle: { width, backgroundColor: p.sidebar },
        overlayColor: 'rgba(0,0,0,0.32)',
        swipeEdgeWidth: 60,
      }}
      drawerContent={props => <DrawerContent {...props} />}>
      <Drawer.Screen name="Main">{() => <Inner onForget={onForget} />}</Drawer.Screen>
    </Drawer.Navigator>
  )
}

const styles = StyleSheet.create({
  needsRow: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginBottom: 4, borderRadius: 10, paddingHorizontal: 12, height: 44 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8 },
  you: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, height: 44 },
  pill: { flexDirection: 'row', alignItems: 'center', height: 40, borderRadius: 20, paddingHorizontal: 14, borderWidth: 0.5, maxWidth: '70%', ...shadow(1) },
})
