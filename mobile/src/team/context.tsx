import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Platform } from 'react-native'
import type { PhoneIdentity, SavedComputer } from '../store.ts'
import { listComputers, onPrefsChange, readPrefs } from '../store.ts'
import * as SecureStore from '../storage'
import type { TeamState } from '../connection.ts'
import { offline, useTeamLink, type TeamLinkHooks } from './link.ts'
import { loadNoticeCursor, saveNoticeCursor } from './notice-cursor-store.ts'
import { registerHostPushEndpoint, setForegroundLinkOnline, syncBackgroundConnectionSubtitle, syncPushEndpointWithHost, unregisterHostPushEndpoint } from './notification-bridge.ts'
import { readNotifyPrefsFromRecord } from './notifications.ts'
import { onUnifiedPushEvent } from './notifications-native'
import { DEMO_HELLO, demoLink } from './demo.ts'

export const DEMO = process.env.EXPO_PUBLIC_DSB_DEMO === '1'

export interface TeamCtx {
  team: TeamState | null
  online: boolean
  linked?: boolean
  error: string | null
  call: (endpoint: string, payload?: unknown) => Promise<unknown>
  refresh?: () => void
  computer: SavedComputer | null
  hello?: { api: number | null; capabilities: string[]; boot: string; seq: number } | null
  onFeed?: (handler: (event: string, data: any) => void) => () => void
}

const Ctx = createContext<TeamCtx>({ team: null, online: false, error: null, call: async () => { throw offline() }, computer: null })
export const useTeam = () => useContext(Ctx)

export function TeamProvider({ computer, identity, children }: { computer: SavedComputer; identity: PhoneIdentity; children: ReactNode }) {
  const keepAliveBg = useRef(false)
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const sync = () => void readPrefs().then(prefs => {
      const parsed = readNotifyPrefsFromRecord(prefs)
      keepAliveBg.current = parsed.enabled && parsed.bgMode === 'instant'
    }).catch(() => {})
    sync()
    return onPrefsChange(sync)
  }, [])
  const hooks = useMemo<TeamLinkHooks>(() => ({
    keepAliveInBackground: () => Platform.OS === 'web' || keepAliveBg.current,
    onConnected: (hello, rawCall) => {
      setForegroundLinkOnline(computer.hostDeviceId, true)
      void syncBackgroundConnectionSubtitle(true, computer.name)
      void syncPushEndpointWithHost(computer.hostDeviceId, rawCall, hello.capabilities)
    },
    onDisconnected: () => {
      setForegroundLinkOnline(computer.hostDeviceId, false)
      void syncBackgroundConnectionSubtitle(false, computer.name)
    },
    loadCursor: () => loadNoticeCursor(computer.hostDeviceId),
    onCursor: (boot, seq) => {
      void saveNoticeCursor(computer.hostDeviceId, boot, seq)
    },
  }), [computer.hostDeviceId, computer.name])
  useEffect(() => () => setForegroundLinkOnline(computer.hostDeviceId, false), [computer.hostDeviceId])
  const link = useTeamLink(computer, identity, hooks)
  useEffect(() => {
    if (Platform.OS !== 'android') return
    return onUnifiedPushEvent(event => {
      if (!link.online || !link.hello?.capabilities?.includes('push-register')) return
      if (event.type === 'endpoint' && event.endpoint) {
        void registerHostPushEndpoint(computer.hostDeviceId, link.call, event.endpoint)
      } else if (event.type === 'unregistered') {
        void unregisterHostPushEndpoint(computer.hostDeviceId, link.call)
      }
    })
  }, [link.online, link.hello, link.call, computer.hostDeviceId])
  const value = useMemo<TeamCtx>(() => ({ team: link.team, online: link.online, linked: link.linked, error: link.error, call: link.call, refresh: link.refresh, computer, hello: link.hello, onFeed: link.onFeed }), [link.team, link.online, link.linked, link.error, link.call, link.refresh, link.hello, link.onFeed, computer])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const link = demoLink()
  const computer = useMemo<SavedComputer>(() => ({ server: 'demo', hostDeviceId: 'demo', hostKey: 'demo', name: 'Demo team' }), [])
  useEffect(() => { void seedDemoComputers() }, [])
  const value = useMemo<TeamCtx>(() => ({ team: link.team, online: true, error: null, call: link.call, computer, hello: DEMO_HELLO }), [link.team, link.call, computer])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

async function seedDemoComputers(): Promise<void> {
  const existing = await listComputers()
  if (existing.computers.length > 0) return
  await SecureStore.setItemAsync('dsbot.computers', JSON.stringify({
    activeId: 'demo',
    computers: [
      { server: 'demo', hostDeviceId: 'demo', hostKey: 'demo-key-alpha', name: 'Demo team', addedAt: Date.now() - 86400000 },
      { server: '10.0.0.5:9877', hostDeviceId: 'demo-2', hostKey: 'demo-key-beta', name: 'Studio Mac', addedAt: Date.now() - 3600000 },
    ],
  }), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })
}
