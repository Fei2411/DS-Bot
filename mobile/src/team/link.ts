import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { RpcClient } from '../../../link/src/index.ts'
import { callBot, openLink, type TeamState } from '../connection.ts'
import type { PhoneIdentity, SavedComputer } from '../store.ts'

// Feed events keep the app live; the poll only stays as a foreground fallback.
const POLL_MS = 15_000
const RETRY_MS = 2_000

export interface Hello { api: number | null; capabilities: string[]; boot: string; seq: number }
export type FeedHandler = (event: string, data: any) => void

export function rejected(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return code === 'NOT_PAIRED' || code === 'PAIRING_REJECTED'
}

// Keeps the link up and the team state fresh. `call` runs one /api/bot endpoint.
export function useTeamLink(computer: SavedComputer, identity: PhoneIdentity) {
  const [team, setTeam] = useState<TeamState | null>(null)
  const [online, setOnline] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hello, setHello] = useState<Hello | null>(null)
  const clientRef = useRef<RpcClient | undefined>(undefined)
  const revision = useRef<number>(-1)
  const feedHandlers = useRef(new Set<FeedHandler>())
  const onFeed = useCallback((handler: FeedHandler) => {
    feedHandlers.current.add(handler)
    return () => { feedHandlers.current.delete(handler) }
  }, [])

  const call = useCallback(async (endpoint: string, payload: unknown = {}) => {
    const client = clientRef.current
    if (client === undefined) throw new Error('Not connected to the computer yet.')
    return callBot(client, endpoint, payload)
  }, [])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = (run: () => void, ms: number) => { if (!stopped) timer = setTimeout(run, ms) }
    const poll = async () => {
      if (stopped || clientRef.current === undefined) return
      try {
        const next = await callBot<TeamState>(clientRef.current, 'state', { since: revision.current })
        revision.current = next.revision
        setTeam(prev => next.unchanged === true && prev !== null ? { ...prev, ...next } : next)
        setError(null)
        later(() => void poll(), POLL_MS)
      } catch (failure) {
        setError(errorText(failure))
      }
    }
    const connect = async () => {
      try {
        const client = await openLink(computer, identity)
        if (stopped) { void client.close(); return }
        clientRef.current = client
        // The handshake before anything else: its api is null when the computer's
        // DS Bot is too old for this app.
        const helloResult = await callBot<Hello>(client, 'hello', {}).catch(() => null)
        if (stopped) { void client.close(); return }
        if (helloResult === null || helloResult.api === null) {
          setError('Update DS Bot on the computer to use this phone.')
          void client.close()
          later(() => void connect(), RETRY_MS)
          return
        }
        setHello(helloResult)
        setOnline(true)
        setError(null)
        client.onEvent(({ event, data }: { event: string; data: any }) => {
          if (event === 'revision' || event === 'live') void poll()
          for (const handler of feedHandlers.current) handler(event, data)
        })
        void callBot(client, 'notices', { boot: helloResult.boot, since: 0 }).then(answer => {
          const notices = answer as { reset?: boolean }
          if (notices.reset === true) void poll()
        }).catch(() => {})
        client.onClose(() => {
          clientRef.current = undefined
          setOnline(false)
          clearTimeout(timer)
          later(() => void connect(), RETRY_MS)
        })
        void poll()
      } catch (failure) {
        setError(errorText(failure))
        if (rejected(failure)) setTeam(null)
        else later(() => void connect(), RETRY_MS)
      }
    }
    void connect()
    const foreground = AppState.addEventListener('change', status => {
      if (status === 'active') void poll()
      else clearTimeout(timer)
    })
    return () => { stopped = true; clearTimeout(timer); foreground.remove(); void clientRef.current?.close(); clientRef.current = undefined }
  }, [computer, identity])

  return { team, online, error, call, clientRef, hello, onFeed }
}

export function errorText(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  if (rejected(error)) return 'The computer did not accept this phone. Show a new QR code on the computer and scan it again.'
  if (code === 'HOST_OFFLINE') return 'The computer is not connected to the Server. Check that DS Bot is open and phone access is on.'
  return error instanceof Error ? error.message : String(error)
}
