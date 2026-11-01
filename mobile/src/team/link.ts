import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../../../link/src/index.ts'
import { callBot, openLink, type TeamState } from '../connection.ts'
import type { PhoneIdentity, SavedComputer } from '../store.ts'

const POLL_MS = 3_000
const RETRY_MS = 2_000

export function rejected(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return code === 'NOT_PAIRED' || code === 'PAIRING_REJECTED'
}

// Keeps the link up and the team state fresh. `call` runs one /api/bot endpoint.
export function useTeamLink(computer: SavedComputer, identity: PhoneIdentity) {
  const [team, setTeam] = useState<TeamState | null>(null)
  const [online, setOnline] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<RpcClient | undefined>(undefined)
  const revision = useRef<number>(-1)

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
        setOnline(true)
        setError(null)
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
    return () => { stopped = true; clearTimeout(timer); void clientRef.current?.close(); clientRef.current = undefined }
  }, [computer, identity])

  return { team, online, error, call, clientRef }
}

export function errorText(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  if (rejected(error)) return 'The computer did not accept this phone. Show a new QR code on the computer and scan it again.'
  if (code === 'HOST_OFFLINE') return 'The computer is not connected to the Server. Check that DS Bot is open and phone access is on.'
  return error instanceof Error ? error.message : String(error)
}
