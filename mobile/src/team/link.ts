import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { RpcClient } from '../../../link/src/index.ts'
import { callBot, callBotState, openLink, type TeamState } from '../connection.ts'
import { ensureUnlock } from './gate.ts'
import { OPTIMISTIC, optimistic, withWrites, type Write } from './optimistic.ts'
import { t } from '../ui/i18n.ts'
import type { PhoneIdentity, SavedComputer } from '../store.ts'

// Feed events keep the app live; the poll only stays as a foreground fallback.
const POLL_MS = 15_000
const RETRY_MS = 2_000

// Profile photos travel by reference and are fetched once per content hash
// (`avatars: 'ref'` on `state`, then the `avatar` endpoint per new ref).
const photoCache = new Map<string, string>()
const photoFetching = new Set<string>()

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
  // The encrypted link is up (calls can go), before the handshake says the computer is current.
  const [linked, setLinked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hello, setHello] = useState<Hello | null>(null)
  const clientRef = useRef<RpcClient | undefined>(undefined)
  const revision = useRef<number>(-1)
  const writes = useRef<Write[]>([])
  const liveKey = useRef<string | undefined>(undefined)
  const pollRef = useRef<() => void>(() => {})
  const feedHandlers = useRef(new Set<FeedHandler>())
  const onFeed = useCallback((handler: FeedHandler) => {
    feedHandlers.current.add(handler)
    return () => { feedHandlers.current.delete(handler) }
  }, [])

  function fetchPhoto(botId: string, ref: string) {
    if (photoFetching.has(ref)) return
    const client = clientRef.current
    if (client === undefined) return
    photoFetching.add(ref)
    void callBot<{ ref?: string | null; image?: string | null }>(client, 'avatar', { botId })
      .then(answer => {
        if (typeof answer.image === 'string') photoCache.set(typeof answer.ref === 'string' ? answer.ref : ref, answer.image)
        // Re-fill the current team now that this photo is cached.
        setTeam(prev => (prev === null ? prev : fillPhotos(prev, prev)))
      })
      .catch(() => {})
      .finally(() => photoFetching.delete(ref))
  }

  // Every bot whose photo came as a ref gets the cached image, or keeps the
  // previous team's photo while the fetch runs — never a blank avatar.
  function fillPhotos(team: TeamState, prev: TeamState | null): TeamState {
    if (!Array.isArray(team.bots)) return team
    const bots = team.bots.map(bot => {
      const ref = bot.avatar?.imageRef
      if (ref === undefined) return bot
      const cached = photoCache.get(ref)
      if (cached !== undefined) return bot.avatar?.image === cached ? bot : { ...bot, avatar: { ...bot.avatar, image: cached } }
      fetchPhoto(bot.id, ref)
      const kept = prev?.bots.find(entry => entry.id === bot.id)?.avatar?.image
      return kept !== undefined && kept !== bot.avatar?.image ? { ...bot, avatar: { ...bot.avatar, image: kept } } : bot
    })
    return bots.every((bot, index) => bot === team.bots[index]) ? team : { ...team, bots }
  }

  // One place every state answer goes through. An older in-flight poll must
  // not overwrite a newer write reply.
  const apply = useCallback((next: TeamState) => {
    if (next.revision < revision.current) return
    revision.current = next.revision
    if (typeof next.liveKey === 'string') liveKey.current = next.liveKey
    setTeam(prev => {
      const merged = next.unchanged === true && prev !== null ? { ...prev, ...next } : next
      return fillPhotos(withWrites(merged, writes.current), prev)
    })
  }, [])

  const call = useCallback(async (endpoint: string, payload: unknown = {}) => {
    const client = clientRef.current
    if (client === undefined) throw offline()
    await ensureUnlock(endpoint)
    try {
      if (endpoint === 'state' || endpoint === 'hello' || endpoint === 'notices') {
        return await callBot(client, endpoint, payload)
      }
      // Show the write's effect at once; the reply's state (or a full reload
      // on failure) puts the computer's truth back over it.
      const write: Write = { endpoint, payload: payload as Record<string, unknown> }
      if (OPTIMISTIC.has(endpoint)) writes.current.push(write)
      setTeam(prev => optimistic(prev, endpoint, write.payload))
      try {
        const answer = await callBotState<unknown>(client, endpoint, payload, { since: revision.current, avatars: 'ref', live: liveKey.current })
        writes.current = writes.current.filter(entry => entry !== write)
        if (answer.state !== undefined) apply(answer.state)
        return answer.value
      } finally {
        writes.current = writes.current.filter(entry => entry !== write)
      }
    } catch (failure) {
      // Snap back to the computer's truth: forget the revision and re-read all.
      if (OPTIMISTIC.has(endpoint)) {
        revision.current = -1
        pollRef.current()
      }
      throw localized(failure)
    }
  }, [apply])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // One pending timer: every feed event polls, and each poll would otherwise start another loop.
    const later = (run: () => void, ms: number) => { clearTimeout(timer); if (!stopped) timer = setTimeout(run, ms) }
    // One read at a time: a burst of feed events while a Bot works becomes one
    // read now and at most one more after it, not a pile of reads over a slow link.
    let reading = false
    let again = false
    const poll = async () => {
      if (stopped || clientRef.current === undefined) return
      if (reading) { again = true; return }
      reading = true
      try {
        const next = await callBot<TeamState>(clientRef.current, 'state', { since: revision.current, avatars: 'ref', live: liveKey.current })
        apply(next)
        setError(null)
        later(() => void poll(), POLL_MS)
      } catch (failure) {
        setError(errorText(failure))
      } finally {
        reading = false
        if (again) { again = false; void poll() }
      }
    }
    pollRef.current = () => void poll()
    const connect = async () => {
      try {
        const client = await openLink(computer, identity)
        if (stopped) { void client.close(); return }
        clientRef.current = client
        setLinked(true)
        // The handshake: its api is null when the computer's DS Bot is too old for
        // this app. The team read goes out with it, not after it: each is a round
        // trip through the relay.
        void poll()
        const helloResult = await callBot<Hello>(client, 'hello', {}).catch(() => null)
        if (stopped) { void client.close(); return }
        if (helloResult === null || helloResult.api === null) {
          setError(t('Update DS Bot on the computer to use this phone.'))
          setLinked(false)
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
          setLinked(false)
          clearTimeout(timer)
          later(() => void connect(), RETRY_MS)
        })
      } catch (failure) {
        setError(errorText(failure))
        if (rejected(failure)) setTeam(null)
        else later(() => void connect(), RETRY_MS)
      }
    }
    void connect()
    const foreground = AppState.addEventListener('change', status => {
      // Waking is the common half-open case: probe first so a dead socket
      // declares itself instead of letting the poll hang.
      if (status === 'active') { clientRef.current?.probe(); void poll() }
      else clearTimeout(timer)
    })
    return () => { stopped = true; clearTimeout(timer); foreground.remove(); void clientRef.current?.close(); clientRef.current = undefined }
  }, [computer, identity, apply])

  return { team, online, linked, error, call, clientRef, hello, onFeed }
}

export function errorText(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  if (rejected(error)) return t('The computer did not accept this phone. Show a new QR code on the computer and scan it again.')
  if (code === 'HOST_OFFLINE') return t('The computer is not connected to the Server. Check that DS Bot is open and phone access is on.')
  if (code === 'SERVER_UNREACHABLE') return t('Could not reach the Server. Check the network. If the computer\'s Server address changed, pair again under Computers.')
  return t(error instanceof Error ? error.message : String(error))
}

export const offline = () => Object.assign(new Error(t('Not connected to the computer yet.')), { code: 'link/offline' })

// Host errors arrive in the plugin's English; screens show error.message as is.
function localized(failure: unknown): unknown {
  // The link dropping mid-call is the same state as being offline.
  if ((failure as { code?: unknown })?.code === 'TRANSPORT_CLOSED') return offline()
  if (failure instanceof Error) failure.message = t(failure.message)
  return failure
}
