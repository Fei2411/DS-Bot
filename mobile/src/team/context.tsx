import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { PhoneIdentity, SavedComputer } from '../store.ts'
import { listComputers } from '../store.ts'
import * as SecureStore from 'expo-secure-store'
import type { TeamState } from '../connection.ts'
import { offline, useTeamLink } from './link.ts'
import { demoLink } from './demo.ts'

export const DEMO = process.env.EXPO_PUBLIC_DSB_DEMO === '1'

export interface TeamCtx {
  team: TeamState | null
  online: boolean
  linked?: boolean
  error: string | null
  call: (endpoint: string, payload?: unknown) => Promise<unknown>
  computer: SavedComputer | null
  hello?: { api: number | null; capabilities: string[]; boot: string; seq: number } | null
  onFeed?: (handler: (event: string, data: any) => void) => () => void
}

const Ctx = createContext<TeamCtx>({ team: null, online: false, error: null, call: async () => { throw offline() }, computer: null })
export const useTeam = () => useContext(Ctx)

export function TeamProvider({ computer, identity, children }: { computer: SavedComputer; identity: PhoneIdentity; children: ReactNode }) {
  const link = useTeamLink(computer, identity)
  const value = useMemo<TeamCtx>(() => ({ team: link.team, online: link.online, linked: link.linked, error: link.error, call: link.call, computer, hello: link.hello, onFeed: link.onFeed }), [link.team, link.online, link.linked, link.error, link.call, link.hello, link.onFeed, computer])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const link = demoLink()
  const computer = useMemo<SavedComputer>(() => ({ server: 'demo', hostDeviceId: 'demo', hostKey: 'demo', name: 'Demo team' }), [])
  useEffect(() => { void seedDemoComputers() }, [])
  const value = useMemo<TeamCtx>(() => ({ team: link.team, online: true, error: null, call: link.call, computer }), [link.team, link.call, computer])
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
