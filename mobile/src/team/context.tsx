import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { PhoneIdentity, SavedComputer } from '../store.ts'
import type { TeamState } from '../connection.ts'
import { useTeamLink } from './link.ts'
import { demoLink } from './demo.ts'

export const DEMO = process.env.EXPO_PUBLIC_DSB_DEMO === '1'

export interface TeamCtx {
  team: TeamState | null
  online: boolean
  error: string | null
  call: (endpoint: string, payload?: unknown) => Promise<unknown>
  computer: SavedComputer | null
  hello?: { api: number | null; capabilities: string[]; boot: string; seq: number } | null
  onFeed?: (handler: (event: string, data: any) => void) => () => void
}

const Ctx = createContext<TeamCtx>({ team: null, online: false, error: null, call: async () => { throw new Error('Not connected to the computer yet.') }, computer: null })
export const useTeam = () => useContext(Ctx)

export function TeamProvider({ computer, identity, children }: { computer: SavedComputer; identity: PhoneIdentity; children: ReactNode }) {
  const link = useTeamLink(computer, identity)
  const value = useMemo<TeamCtx>(() => ({ team: link.team, online: link.online, error: link.error, call: link.call, computer, hello: link.hello, onFeed: link.onFeed }), [link.team, link.online, link.error, link.call, link.hello, link.onFeed, computer])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const link = demoLink()
  const computer = useMemo<SavedComputer>(() => ({ server: 'demo', hostDeviceId: 'demo', hostKey: 'demo', name: 'Demo team' }), [])
  const value = useMemo<TeamCtx>(() => ({ team: link.team, online: true, error: null, call: link.call, computer }), [link.team, link.call, computer])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
