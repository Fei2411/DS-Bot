import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { type as typeScale, useTheme } from '../ui/tokens.ts'
import { Avatar, RoomAvatar } from '../ui/marks.tsx'
import { ChevronLeftIcon, GearIcon, PeopleIcon, UnreadIcon } from '../ui/icons.tsx'
import { ChatView } from '../screens/Chat.tsx'
import { NeedsYou } from '../screens/NeedsYou.tsx'
import { Settings } from '../screens/Settings.tsx'
import { TeamList, type ChatTarget } from '../screens/TeamList.tsx'

const Tab = createBottomTabNavigator()
const Stack = createNativeStackNavigator()

function pendingCount(team: ReturnType<typeof useTeam>['team']): number {
  const questions = Object.keys(team?.questions ?? {}).length
  const approvals = (team?.work?.approvals ?? []).filter(a => a.answerable !== false).length
  const secrets = Object.values(team?.secretRequests ?? {}).flat().filter(r => r.status !== 'settled').length
  return questions + approvals + secrets
}

function TeamTab({ navigation }: { navigation: { navigate: (name: string, params?: unknown) => void } }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: p.main, paddingTop: insets.top }}>
      <TeamList largeTitle onOpen={target => navigation.navigate('Chat', target)} />
    </View>
  )
}
function NeedsTab({ navigation }: { navigation: { navigate: (name: string, params?: unknown) => void } }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: p.main, paddingTop: insets.top }}>
      <Text style={[typeScale.largeTitle, { color: p.ink, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10 }]}>{t('Needs you')}</Text>
      <NeedsYou onOpen={target => navigation.navigate('Chat', target)} />
    </View>
  )
}

function Tabs({ onForget }: { onForget: () => void }) {
  const { p, dark } = useTheme()
  const { team } = useTeam()
  const insets = useSafeAreaInsets()
  const pending = pendingCount(team)
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: p.accent,
        tabBarInactiveTintColor: p.ink3,
        tabBarStyle: { backgroundColor: p.sidebar, borderTopColor: p.line, paddingBottom: Math.max(insets.bottom, 6), paddingTop: 6, height: 56 + Math.max(insets.bottom, 6) },
        tabBarLabelStyle: { fontSize: 11 },
      }}>
      <Tab.Screen name="Team" options={{ title: t('Team'), tabBarIcon: ({ color }) => <PeopleIcon size={20} color={color} /> }}>
        {props => <TeamTab {...props} />}
      </Tab.Screen>
      <Tab.Screen name="NeedsYou" options={{ title: t('Needs you'), tabBarBadge: pending > 0 ? pending : undefined, tabBarIcon: ({ color }) => <UnreadIcon size={20} color={color} /> }}>
        {props => <NeedsTab {...props} />}
      </Tab.Screen>
      <Tab.Screen name="Settings" options={{ title: t('Settings'), tabBarIcon: ({ color }) => <GearIcon size={20} color={color} /> }}>
        {() => <View style={{ flex: 1, backgroundColor: p.main, paddingTop: insets.top }}>
          <Text style={[typeScale.largeTitle, { color: p.ink, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10 }]}>{t('Settings')}</Text>
          <Settings onForget={onForget} />
        </View>}
      </Tab.Screen>
    </Tab.Navigator>
  )
}

function ChatScreenA({ route, navigation }: any) {
  const { p, dark } = useTheme()
  const { team } = useTeam()
  const insets = useSafeAreaInsets()
  const { kind, id } = route.params as ChatTarget
  const bot = kind === 'bot' ? team?.bots?.find(b => b.id === id) : undefined
  const room = kind === 'room' ? team?.rooms?.find(r => r.id === id) : undefined
  const running = bot ? team?.work?.bots?.[bot.id] !== undefined : (team?.work?.rooms?.[id] ?? []).length > 0
  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: insets.top + 4, paddingBottom: 8, paddingHorizontal: 8, backgroundColor: p.sidebar, borderBottomWidth: 0.5, borderBottomColor: p.line2 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => navigation.goBack()} hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <ChevronLeftIcon size={22} color={p.accent} />
      </Pressable>
      {bot ? <Avatar bot={bot} dark={dark} size={36} ring={p.sidebar} main={(team?.mainBotIds ?? []).includes(bot.id)} working={running} /> : room ? <RoomAvatar room={room} bots={team?.bots ?? []} dark={dark} size={36} ring={p.sidebar} /> : null}
      <View style={{ flex: 1, minWidth: 0, marginLeft: 6 }}>
        <Text style={[typeScale.headerTitle, { color: p.ink }]} numberOfLines={1}>{bot?.name ?? room?.name ?? ''}</Text>
        <Text style={{ color: p.ink2, fontSize: 13, lineHeight: 18 }} numberOfLines={1}>{running ? t('Working') : (bot?.role ?? '')}</Text>
      </View>
    </View>
  )
  return <ChatView bot={bot} room={room} header={header} />
}

export default function ShellA({ onForget }: { onForget: () => void }) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="Home">{() => <Tabs onForget={onForget} />}</Stack.Screen>
      <Stack.Screen name="Chat" component={ChatScreenA} />
    </Stack.Navigator>
  )
}
