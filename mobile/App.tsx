import 'react-native-gesture-handler'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Linking, Text, useColorScheme, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { DefaultTheme, NavigationContainer } from '@react-navigation/native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { loadComputer, loadIdentity, onPrefsChange, readPrefs, setActiveComputer, type PhoneIdentity, type SavedComputer } from './src/store.ts'
import { ComputersCtx, type ComputerActions } from './src/nav/computers.ts'
import { errorText } from './src/team/link.ts'
import { DEMO, DemoProvider, TeamProvider, useTeam } from './src/team/context.tsx'
import { palette, ThemeContext, useTheme } from './src/ui/tokens.ts'
import { Pair } from './src/screens/Pair.tsx'
import ShellB from './src/nav/ShellB.tsx'

// Colors follow the computer's prefs plus the phone's light/dark mode. The
// local appearance pref overrides the system scheme.
function useDark(): boolean {
  const system = useColorScheme() === 'dark'
  const [override, setOverride] = useState<string | null>(null)
  useEffect(() => {
    void readPrefs().then(prefs => setOverride(prefs.theme ?? 'system'))
    return onPrefsChange(() => void readPrefs().then(prefs => setOverride(prefs.theme ?? 'system')))
  }, [])
  return override === 'dark' || (override !== 'light' && system)
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const dark = useDark()
  const { team } = useTeam()
  const value = useMemo(() => ({ dark, p: palette(dark, team?.prefs?.theme, team?.prefs?.accent) }), [dark, team?.prefs?.theme, team?.prefs?.accent])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

// The navigator lives inside the palette provider so its container theme can
// follow the computer's theme instead of flashing the default white.
function ThemedShell() {
  const dark = useDark()
  const { team } = useTeam()
  const value = useMemo(() => ({ dark, p: palette(dark, team?.prefs?.theme, team?.prefs?.accent) }), [dark, team?.prefs?.theme, team?.prefs?.accent])
  const navTheme = useMemo(() => ({
    dark,
    colors: {
      primary: value.p.accent,
      background: value.p.main,
      card: value.p.sidebar,
      text: value.p.ink,
      border: value.p.line,
      notification: value.p.accent,
    },
    fonts: DefaultTheme.fonts,
  }), [dark, value])
  return (
    <ThemeContext.Provider value={value}>
      <NavigationContainer theme={navTheme}>
        <ShellB />
      </NavigationContainer>
    </ThemeContext.Provider>
  )
}

function Linked({ computer, identity }: { computer: SavedComputer; identity: PhoneIdentity }) {
  return (
    <TeamProvider computer={computer} identity={identity}>
      <ThemedShell />
    </TeamProvider>
  )
}

function Boot() {
  const { p } = useTheme()
  const [identity, setIdentity] = useState<PhoneIdentity | null>(null)
  const [computer, setComputer] = useState<SavedComputer | null | undefined>(undefined)
  const [bootError, setBootError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [offer, setOffer] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([loadIdentity(), loadComputer()])
      .then(([nextIdentity, saved]) => { setIdentity(nextIdentity); setComputer(saved ?? null) })
      .catch(failure => setBootError(errorText(failure)))
  }, [])

  // A pairing link opened from the system camera arrives on whatever screen is showing.
  useEffect(() => {
    const open = (url?: string | null) => { if (url?.startsWith('dsbot://pair')) { setOffer(url); setAdding(true) } }
    void Linking.getInitialURL().then(open)
    const subscription = Linking.addEventListener('url', event => open(event.url))
    return () => subscription.remove()
  }, [])

  const actions = useMemo<ComputerActions>(() => ({
    add: () => setAdding(true),
    switchTo: id => void setActiveComputer(id).then(loadComputer).then(next => setComputer(next ?? null)),
    reload: () => void loadComputer().then(next => setComputer(next ?? null)),
  }), [])
  const paired = useCallback((next: SavedComputer) => { setAdding(false); setOffer(null); setComputer(next) }, [])

  if (DEMO) {
    return <ComputersCtx.Provider value={actions}><DemoProvider><ThemedShell /></DemoProvider></ComputersCtx.Provider>
  }
  if (bootError !== null) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.main }}><Text style={{ color: p.danger }}>{bootError}</Text></View>
  if (identity === null || computer === undefined) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.main }}><ActivityIndicator color={p.accent} /></View>
  if (computer === null || adding) return <ThemeProvider><Pair identity={identity} offer={offer} onPaired={paired} onCancel={computer !== null ? () => { setAdding(false); setOffer(null) } : undefined} /></ThemeProvider>
  return <ComputersCtx.Provider value={actions}><Linked computer={computer} identity={identity} /></ComputersCtx.Provider>
}

export default function App() {
  const dark = useDark()
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Boot />
        <StatusBar style={dark ? 'light' : 'dark'} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
