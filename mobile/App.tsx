import 'react-native-gesture-handler'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Text, useColorScheme, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { NavigationContainer } from '@react-navigation/native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { forgetComputer, loadComputer, loadIdentity, type PhoneIdentity, type SavedComputer } from './src/store.ts'
import { errorText } from './src/team/link.ts'
import { DEMO, DemoProvider, NAV, TeamProvider, useTeam } from './src/team/context.tsx'
import { palette, ThemeContext, useTheme } from './src/ui/tokens.ts'
import { Pair } from './src/screens/Pair.tsx'
import ShellA from './src/nav/ShellA.tsx'
import ShellB from './src/nav/ShellB.tsx'

// Colors follow the computer's prefs plus the phone's light/dark mode.
function ThemeProvider({ children }: { children: React.ReactNode }) {
  const dark = useColorScheme() === 'dark'
  const { team } = useTeam()
  const value = useMemo(() => ({ dark, p: palette(dark, team?.prefs?.theme, team?.prefs?.accent) }), [dark, team?.prefs?.theme, team?.prefs?.accent])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

function Shell({ onForget }: { onForget: () => void }) {
  return NAV === 'b' ? <ShellB onForget={onForget} /> : <ShellA onForget={onForget} />
}

function Linked({ computer, identity, onForget }: { computer: SavedComputer; identity: PhoneIdentity; onForget: () => void }) {
  return (
    <TeamProvider computer={computer} identity={identity}>
      <ThemeProvider><Shell onForget={onForget} /></ThemeProvider>
    </TeamProvider>
  )
}

function Boot() {
  const { p } = useTheme()
  const [identity, setIdentity] = useState<PhoneIdentity | null>(null)
  const [computer, setComputer] = useState<SavedComputer | null | undefined>(undefined)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([loadIdentity(), loadComputer()])
      .then(([nextIdentity, saved]) => { setIdentity(nextIdentity); setComputer(saved ?? null) })
      .catch(failure => setBootError(errorText(failure)))
  }, [])

  const forget = useCallback(() => { void forgetComputer().then(() => setComputer(null)) }, [])

  if (DEMO) {
    return <DemoProvider><ThemeProvider><Shell onForget={forget} /></ThemeProvider></DemoProvider>
  }
  if (bootError !== null) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.main }}><Text style={{ color: p.danger }}>{bootError}</Text></View>
  if (identity === null || computer === undefined) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.main }}><ActivityIndicator color={p.accent} /></View>
  if (computer === null) return <ThemeProvider><Pair identity={identity} onPaired={setComputer} /></ThemeProvider>
  return <Linked computer={computer} identity={identity} onForget={forget} />
}

export default function App() {
  const dark = useColorScheme() === 'dark'
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationContainer>
          <Boot />
        </NavigationContainer>
        <StatusBar style={dark ? 'light' : 'dark'} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
