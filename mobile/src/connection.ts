import { Platform } from 'react-native'
import { RelayTransport, RpcClient, SecureTransport } from '../../link/src/index.ts'
import type { PhoneIdentity, SavedComputer } from './store.ts'

type BotResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export interface Bot {
  id: string
  name: string
  role?: string
  color?: string
  avatar?: { shape?: string; image?: string }
  sessionId?: string
  waiting?: boolean
}

export interface Room {
  id: string
  name: string
  preview?: string
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
  tool: string
  reason: string
  detail?: { text?: string; code?: string }
  answerable?: boolean
}

export interface TeamState {
  revision: number
  unchanged?: boolean
  bots: Bot[]
  rooms?: Room[]
  mainBotIds?: string[]
  questions?: Record<string, Question>
  work?: {
    bots?: Record<string, { tool?: string }>
    approvals?: Approval[]
    turns?: Record<string, number>
  }
  prefs?: { theme?: string; accent?: string }
}

function phoneName(): string {
  const constants = Platform.constants as { Manufacturer?: string; Model?: string; interfaceIdiom?: string }
  if (Platform.OS === 'android') return [constants.Manufacturer, constants.Model].filter(Boolean).join(' ') || 'Android phone'
  return constants.interfaceIdiom === 'pad' ? 'iPad' : 'iPhone'
}

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
