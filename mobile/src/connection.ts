import { Platform } from 'react-native'
import { RelayTransport, RpcClient, SecureTransport } from '../../link/src/index.ts'
import type { PhoneIdentity, SavedComputer } from './store.ts'

type BotResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export interface Bot {
  id: string
  name: string
  role?: string
  // The DSH permission preset the Bot runs with; unset runs on the default one.
  permission?: string
  // A credential or balance failure that stops the Bot until the user fixes it (turns.js).
  blocked?: { code: string; status?: number; provider?: string; at?: number }
  color?: string
  avatar?: { shape?: string; image?: string; imageRef?: string }
  model?: string
  appliedModel?: string
  capabilities?: string[]
  browser?: boolean
  effort?: string
  workDir?: string
  main?: boolean
  private?: boolean
  instructions?: string
  sessionId?: string
  parts?: string[]
  waiting?: boolean
  pinned?: boolean
  hidden?: boolean
  createdAt?: number
  lastAt?: number
  preview?: string
}

export interface Room {
  id: string
  name: string
  preview?: string
  lastAt?: number
  members?: string[]
  admin?: string
  mode?: string
  notice?: string
  named?: boolean
  sessionId?: string
  pinned?: boolean
  hidden?: boolean
  createdAt?: number
}

export interface Question {
  id: string
  question: string
  detail?: string
  options?: { label: string }[]
  multiSelect?: boolean
}

export interface Approval {
  id: string
  sessionId: string
  botId: string
  roomId?: string
  at?: number
  tool: string
  reason: string
  detail?: { text?: string; code?: string }
  answerable?: boolean
}

export interface SecretRequest {
  id: string
  name?: string
  scope?: string | string[]
  status?: string
}

export interface TeamState {
  revision: number
  unchanged?: boolean
  liveKey?: string
  bots: Bot[]
  rooms?: Room[]
  mainBotId?: string | null
  mainBotIds?: string[]
  models?: { ref: string; name: string; provider?: string; providerName?: string }[]
  defaultModel?: string
  memory?: boolean
  questions?: Record<string, Question>
  views?: Record<string, ShownView>
  secretRequests?: Record<string, SecretRequest[]>
  connectors?: { id: string; name: string; state?: string; account?: string; error?: string }[]
  capabilities?: { name: string; description?: string; kind?: string; transport?: string; command?: string; url?: string; content?: string; items?: string[]; status?: string }[]
  browserHolds?: Record<string, { by?: string; reason?: string; note?: string; callId?: string }>
  btwCards?: Record<string, { id: string; partId?: string; question?: string; answer?: string; failure?: string; status?: string }[]>
  sideChats?: Record<string, { chatId: string; entries?: { id: string; question?: string; answer?: string; status?: string; failure?: string }[] }[]>
  capabilityStatuses?: Record<string, Record<string, { state?: string; error?: string }> | { state?: string; error?: string }>
  workspace?: string
  dataPath?: string
  version?: string
  work?: {
    bots?: Record<string, { tool?: string; said?: string; note?: string; target?: string; switching?: boolean; folder?: boolean }>
    rooms?: Record<string, { botId: string; tool?: string; said?: string; note?: string; target?: string }[]>
    approvals?: Approval[]
    waiting?: Record<string, { bots?: string[]; rooms?: string[] }>
    turns?: Record<string, number>
  }
  activity?: Record<string, { tool?: string; said?: string; note?: string; target?: string; switching?: boolean }>
  exchangeTurns?: Record<string, number[]>
  prefs?: { theme?: string; accent?: string; layout?: string; width?: number; flatWidth?: number }
}

function phoneName(): string {
  const constants = Platform.constants as { Manufacturer?: string; Model?: string; interfaceIdiom?: string }
  if (Platform.OS === 'android') return [constants.Manufacturer, constants.Model].filter(Boolean).join(' ') || 'Android phone'
  return constants.interfaceIdiom === 'pad' ? 'iPad' : 'iPhone'
}

/** A card as the computer keeps it: `view` is the root node of the blueprint. */
export interface ShownView { id?: string; title?: string; view?: unknown }

/** Opens the encrypted link to the computer. The pairing code goes only with the first connection. */
export async function openLink(computer: SavedComputer, identity: PhoneIdentity, pairingCode?: string): Promise<RpcClient> {
  const relay = new RelayTransport(computer.server, {
    deviceId: identity.deviceId,
    identityKey: identity.publicKey,
    accessToken: identity.accessToken,
    targetDeviceId: computer.hostDeviceId,
  })
  const secure = new SecureTransport(relay, identity, { deviceId: computer.hostDeviceId, identityKey: computer.hostKey }, {
    hello: { name: phoneName(), ...(pairingCode === undefined ? {} : { pairingCode }) },
  })
  const client = new RpcClient(secure)
  await client.connect()
  return client
}

/** Calls one DS Bot endpoint on the computer, the same one its window calls. */
export async function callBot<T>(client: RpcClient, endpoint: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> {
  const result = await client.rpc<BotResult<T>>('bot', { endpoint, payload }, { signal })
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  return result.value
}

/**
 * Same call, but the request carries `state` (the payload the `state` endpoint
 * would take). A write that moved the team answers with the new state in the
 * same reply, so the phone needs no second round trip.
 */
export async function callBotState<T>(client: RpcClient, endpoint: string, payload: unknown, state: unknown, signal?: AbortSignal): Promise<{ value: T; state?: TeamState }> {
  const result = await client.rpc<BotResult<T> & { state?: TeamState }>('bot', { endpoint, payload, state }, { signal })
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  return { value: result.value, state: result.state }
}
