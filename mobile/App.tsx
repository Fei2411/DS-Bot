import 'react-native-gesture-handler'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, Linking, Platform, Text, useColorScheme, View } from 'react-native'
import { takePairingFragment } from './src/team/pair-fragment.ts'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { DefaultTheme, NavigationContainer, type NavigationState } from '@react-navigation/native'
import { setLang } from './src/ui/i18n.ts'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { listComputers, loadComputer, loadIdentityWithMeta, onPrefsChange, readPrefs, setActiveComputer, type PhoneIdentity, type SavedComputer } from './src/store.ts'
import { ComputersCtx, type ComputerActions } from './src/nav/computers.ts'
import { startAppUpdateMonitor } from './src/team/app-update-store.ts'
import { currentAppVersion } from './src/team/app-version.ts'
import { checkMobileReleaseNotes, openMobileReleaseNotes, seedFreshInstallReleaseNotes } from './src/team/release-notes.ts'
import { ReleaseNotesModal } from './src/ui/ReleaseNotesModal.tsx'
import { stopHeadlessKeepalive } from './src/team/background-task.ts'
import { errorText } from './src/team/link.ts'
import { applyBackgroundDeliveryPrefs } from './src/team/notification-bridge.ts'
import { parseOpenChatUrl, type OpenChatLink } from './src/team/notifications.ts'
import { setNativeUiState } from './src/team/notifications-native'
import { loadSeen } from './src/team/seen.ts'
import { DEMO, DemoProvider, TeamProvider, useTeam } from './src/team/context.tsx'
import { ErrorBoundary } from './src/ui/error-boundary.tsx'
import { avatarClock, noteInput } from './src/ui/avatar/host.ts'
import { palette, ThemeContext, useTheme } from './src/ui/tokens.ts'
import { Pair } from './src/screens/Pair.tsx'
import ShellB from './src/nav/ShellB.tsx'
import { BrowserSession } from './src/team/BrowserSession'

// Colors follow the computer's prefs plus the phone's light/dark mode. The
// local appearance pref overrides the system scheme.
function useDark(): boolean {
  const system = useColorScheme() === 'dark'
  const [override, setOverride] = useState<string | null>(null)
  useEffect(() => {
    const read = () => void readPrefs().then(prefs => setOverride(prefs.theme ?? 'system')).catch(() => setOverride('system'))
    read()
    return onPrefsChange(read)
  }, [])
  return override === 'dark' || (override !== 'light' && system)
}

// The phone's language pref; undefined until read, so the first frame is not in the wrong language.
function useLang(): string | undefined {
  const [lang, setLangState] = useState<string | undefined>(undefined)
  useEffect(() => {
    const apply = (prefs: Record<string, string>) => {
      const next = prefs.lang === 'zh' || prefs.lang === 'en' ? prefs.lang : 'system'
      setLang(next)
      setLangState(next)
    }
    const read = () => void readPrefs().then(apply).catch(() => apply({}))
    read()
    return onPrefsChange(read)
  }, [])
  return lang
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const dark = useDark()
  const { team } = useTeam()
  const value = useMemo(() => ({ dark, p: palette(dark, team?.prefs?.theme, team?.prefs?.accent) }), [dark, team?.prefs?.theme, team?.prefs?.accent])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

// The navigator lives inside the palette provider so its container theme can
// follow the computer's theme instead of flashing the default white.
function ThemedShell({ lang, openLink, onOpenLinkHandled }: { lang?: string; openLink?: OpenChatLink | null; onOpenLinkHandled?: () => void }) {
  const dark = useDark()
  // A language change re-mounts the navigator so every screen reads the new
  // strings; the saved navigation state keeps the user where they were.
  const navState = useRef<NavigationState | undefined>(undefined)
  const { team } = useTeam()
  const value = useMemo(() => ({ dark, p: palette(dark, team?.prefs?.theme, team?.prefs?.accent) }), [dark, team?.prefs?.theme, team?.prefs?.accent])
  // The marks move at the computer's motion levels (Settings → Appearance there), set
  // before the marks below are made (their effects run after this one).
  useLayoutEffect(() => { avatarClock.setPrefs(team?.prefs) }, [team?.prefs])
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
      <NavigationContainer key={lang} theme={navTheme} initialState={navState.current} onStateChange={state => { navState.current = state }}>
        <ErrorBoundary>
          <ShellB openLink={openLink} onOpenLinkHandled={onOpenLinkHandled} />
          <ReleaseNotesModal host="auto" />
        </ErrorBoundary>
      </NavigationContainer>
    </ThemeContext.Provider>
  )
}

function Linked({ computer, identity, lang, openLink, onOpenLinkHandled }: { computer: SavedComputer; identity: PhoneIdentity; lang?: string; openLink?: OpenChatLink | null; onOpenLinkHandled?: () => void }) {
  return (
    <TeamProvider computer={computer} identity={identity}>
      <ThemedShell lang={lang} openLink={openLink} onOpenLinkHandled={onOpenLinkHandled} />
    </TeamProvider>
  )
}

function Boot({ lang }: { lang?: string }) {
  const { p } = useTheme()
  const [identity, setIdentity] = useState<PhoneIdentity | null>(null)
  const [hadExistingIdentity, setHadExistingIdentity] = useState<boolean | null>(null)
  const [computer, setComputer] = useState<SavedComputer | null | undefined>(undefined)
  const [bootError, setBootError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [offer, setOffer] = useState<string | null>(null)
  const [openLink, setOpenLink] = useState<OpenChatLink | null>(null)
  const [seenReady, setSeenReady] = useState(false)
  const releaseNotesCheckedRef = useRef(false)
  const uiReadyRef = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    let active = true
    void loadSeen().finally(() => setSeenReady(true))
    let appSub: { remove(): void } | undefined
    if (Platform.OS === 'android') {
      stopHeadlessKeepalive()
      const syncUiState = (state: string | null | undefined) => setNativeUiState(true, state !== 'background' && state !== 'inactive').catch(() => {})
      uiReadyRef.current = syncUiState(AppState.currentState)
      appSub = AppState.addEventListener('change', next => { void syncUiState(next) })
    }
    const stopUpdater = startAppUpdateMonitor()
    const applyDeepLink = async (url?: string | null) => {
      if (!url) return false
      if (url.startsWith('dsbot://pair')) {
        if (active) { setOffer(url); setAdding(true) }
        return true
      }
      const target = parseOpenChatUrl(url)
      if (target === null) return false
      if (!DEMO && target.hostId) {
        const { computers } = await listComputers()
        const matched = computers.find(item => item.hostDeviceId === target.hostId)
        if (matched === undefined) return false
        await setActiveComputer(matched.hostDeviceId)
        if (active) {
          setAdding(false)
          setComputer(matched)
          setOpenLink(target)
        }
        return true
      }
      if (active) {
        setAdding(false)
        setOpenLink(target)
      }
      return true
    }

    if (Platform.OS === 'web') {
      const uri = takePairingFragment(window.location, window.history)
      if (uri !== undefined) { setOffer(uri); setAdding(true) }
    }

    if (!DEMO) {
      Promise.all([
        loadIdentityWithMeta(),
        Platform.OS === 'web' ? Promise.resolve(null) : Linking.getInitialURL().catch(() => null),
      ])
        .then(async ([identityMeta, initialUrl]) => {
          if (!active) return
          setIdentity(identityMeta.identity)
          setHadExistingIdentity(identityMeta.existed)
          // Fresh installs silently record the current version right away so quitting on
          // the pairing screen does not turn the next launch into a false upgrade. Existing
          // installs wait until ThemedShell (hosting ReleaseNotesModal) is mounted before
          // claiming lastSeenVersion so an unpaired launch never swallows the popup.
          if (!identityMeta.existed) {
            void seedFreshInstallReleaseNotes({ currentVersion: currentAppVersion() })
          }
          const handledHost = initialUrl ? await applyDeepLink(initialUrl) : false
          if (!active) return
          if (!handledHost || !parseOpenChatUrl(initialUrl)?.hostId) {
            const saved = await loadComputer()
            if (active) setComputer(saved ?? null)
          }
        })
        .catch(failure => { if (active) setBootError(errorText(failure)) })
    } else if (Platform.OS !== 'web') {
      void Linking.getInitialURL().then(url => applyDeepLink(url)).catch(() => {})
    }

    const urlSub = Platform.OS === 'web'
      ? undefined
      : Linking.addEventListener('url', event => { void applyDeepLink(event.url) })

    return () => {
      active = false
      stopUpdater()
      appSub?.remove()
      urlSub?.remove()
      if (Platform.OS === 'android') void setNativeUiState(false, false)
    }
  }, [])

  const shellMounted = !DEMO && identity !== null && hadExistingIdentity !== null && computer !== null && computer !== undefined && !adding && lang !== undefined && seenReady
  useEffect(() => {
    if (!shellMounted || releaseNotesCheckedRef.current) return
    releaseNotesCheckedRef.current = true
    let active = true
    void checkMobileReleaseNotes({
      currentVersion: currentAppVersion(),
      hadExistingIdentity,
    }).then((result) => {
      if (active && result.show) {
        openMobileReleaseNotes({ mode: 'auto', current: result.current })
      }
    }).catch(() => {})
    return () => { active = false }
  }, [shellMounted, hadExistingIdentity])

  useEffect(() => {
    if (Platform.OS !== 'android') return
    if (DEMO || computer !== undefined) {
      void uiReadyRef.current.then(() => applyBackgroundDeliveryPrefs(computer?.name))
    }
  }, [computer])

  const actions = useMemo<ComputerActions>(() => ({
    add: () => setAdding(true),
    switchTo: id => void setActiveComputer(id).then(loadComputer).then(next => setComputer(next ?? null)),
    reload: () => void loadComputer().then(next => setComputer(next ?? null)),
  }), [])
  const paired = useCallback((next: SavedComputer) => { setAdding(false); setOffer(null); setComputer(next) }, [])
  const clearOpenLink = useCallback(() => setOpenLink(null), [])

  if (DEMO && lang !== undefined && seenReady) {
    return <ComputersCtx.Provider value={actions}><DemoProvider><ThemedShell lang={lang} openLink={openLink} onOpenLinkHandled={clearOpenLink} /></DemoProvider></ComputersCtx.Provider>
  }
  if (bootError !== null) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.main }}><Text style={{ color: p.danger }}>{bootError}</Text></View>
  if (identity === null || computer === undefined || lang === undefined || !seenReady) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: p.main }}><ActivityIndicator color={p.accent} /></View>
  if (computer === null || adding) return <ThemeProvider><Pair identity={identity} offer={offer} onPaired={paired} onCancel={computer !== null ? () => { setAdding(false); setOffer(null) } : undefined} /></ThemeProvider>
  return <ComputersCtx.Provider value={actions}><Linked computer={computer} identity={identity} lang={lang} openLink={openLink} onOpenLinkHandled={clearOpenLink} /></ComputersCtx.Provider>
}

export default function App() {
  const dark = useDark()
  const lang = useLang()
  const rootTheme = useMemo(() => ({ dark, p: palette(dark) }), [dark])
  return (
    // A touch anywhere keeps the marks awake (avatar/clock.ts rests them after a while).
    <GestureHandlerRootView style={{ flex: 1 }} onTouchStart={noteInput}>
      <SafeAreaProvider>
        <ThemeContext.Provider value={rootTheme}>
          <ErrorBoundary>
            <BrowserSession><Boot lang={lang} /></BrowserSession>
          </ErrorBoundary>
        </ThemeContext.Provider>
        <StatusBar style={dark ? 'light' : 'dark'} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
