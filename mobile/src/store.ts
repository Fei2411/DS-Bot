import * as SecureStore from 'expo-secure-store'
import { deviceIdFor, generateKeyPair, randomToken, type DeviceIdentity, type PairingOffer } from '../../link/src/index.ts'

export interface PhoneIdentity extends DeviceIdentity {
  accessToken: string
}

export interface StoredComputer extends SavedComputer { addedAt: number }
interface ComputerList { activeId: string | null; computers: StoredComputer[] }

export type SavedComputer = Omit<PairingOffer, 'code'>

const IDENTITY = 'dsbot.identity'
const COMPUTER = 'dsbot.computer'
// Keychain on iOS, Keystore-backed storage on Android. The keys never leave this phone, not even in a backup.
const LOCAL = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

function validIdentity(value: unknown): value is PhoneIdentity {
  const identity = value as Partial<PhoneIdentity> | null
  if (typeof identity?.publicKey !== 'string' || typeof identity.privateKey !== 'string' || typeof identity.accessToken !== 'string') return false
  try { return deviceIdFor(identity.publicKey) === identity.deviceId } catch { return false }
}

async function read(key: string): Promise<unknown> {
  const text = await SecureStore.getItemAsync(key, LOCAL)
  if (text === null) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

export async function loadIdentity(): Promise<PhoneIdentity> {
  const saved = await read(IDENTITY)
  if (validIdentity(saved)) return saved
  const keys = generateKeyPair()
  const identity = { deviceId: deviceIdFor(keys.publicKey), ...keys, accessToken: randomToken() }
  await SecureStore.setItemAsync(IDENTITY, JSON.stringify(identity), LOCAL)
  return identity
}

export async function loadComputer(): Promise<SavedComputer | undefined> {
  const saved = await read(COMPUTERS) as { activeId: string | null; computers: StoredComputer[] } | undefined
  if (saved !== undefined && Array.isArray(saved.computers)) {
    return saved.computers.find(item => item.hostDeviceId === saved.activeId) ?? saved.computers[0]
  }
  const single = await read(COMPUTER) as Partial<SavedComputer> | undefined
  if (typeof single?.server !== 'string' || typeof single.hostDeviceId !== 'string' || typeof single.hostKey !== 'string') return undefined
  return { server: single.server, hostDeviceId: single.hostDeviceId, hostKey: single.hostKey, name: single.name ?? '' }
}

export async function saveComputer({ server, hostDeviceId, hostKey, name }: PairingOffer): Promise<SavedComputer> {
  const computer = { server, hostDeviceId, hostKey, name }
  await SecureStore.setItemAsync(COMPUTER, JSON.stringify(computer), LOCAL)
  return computer
}

export async function forgetComputer(): Promise<void> {
  await SecureStore.deleteItemAsync(COMPUTER, LOCAL)
}

const COMPUTERS = 'dsbot.computers'
const PREFS = 'dsbot.prefs'

// The older single-computer key migrates into the list on first read.
export async function listComputers(): Promise<ComputerList> {
  const saved = await read(COMPUTERS) as ComputerList | undefined
  if (saved !== undefined && Array.isArray(saved.computers)) return saved
  const single = await loadComputer()
  const list: ComputerList = single === undefined
    ? { activeId: null, computers: [] }
    : { activeId: single.hostDeviceId, computers: [{ ...single, addedAt: Date.now() }] }
  await SecureStore.setItemAsync(COMPUTERS, JSON.stringify(list), LOCAL)
  return list
}

export async function addComputer(offer: PairingOffer): Promise<SavedComputer> {
  const list = await listComputers()
  const computer: StoredComputer = { server: offer.server, hostDeviceId: offer.hostDeviceId, hostKey: offer.hostKey, name: offer.name, addedAt: Date.now() }
  list.computers = [...list.computers.filter(item => item.hostDeviceId !== computer.hostDeviceId), computer]
  list.activeId = computer.hostDeviceId
  await SecureStore.setItemAsync(COMPUTERS, JSON.stringify(list), LOCAL)
  return computer
}

export async function setActiveComputer(hostDeviceId: string): Promise<void> {
  const list = await listComputers()
  list.activeId = hostDeviceId
  await SecureStore.setItemAsync(COMPUTERS, JSON.stringify(list), LOCAL)
}

export async function removeComputer(hostDeviceId: string): Promise<StoredComputer[]> {
  const list = await listComputers()
  list.computers = list.computers.filter(item => item.hostDeviceId !== hostDeviceId)
  if (list.activeId === hostDeviceId) list.activeId = list.computers[0]?.hostDeviceId ?? null
  await SecureStore.setItemAsync(COMPUTERS, JSON.stringify(list), LOCAL)
  return list.computers
}

export async function readPrefs(): Promise<Record<string, string>> {
  if (prefsCache !== null) return prefsCache
  prefsCache = (await read(PREFS) as Record<string, string> | undefined) ?? {}
  return prefsCache
}
let prefsCache: Record<string, string> | null = null
const prefListeners = new Set<() => void>()
export function onPrefsChange(listener: () => void): () => void {
  prefListeners.add(listener)
  return () => prefListeners.delete(listener)
}
export async function writePrefs(patch: Record<string, string>): Promise<void> {
  prefsCache = { ...(await readPrefs()), ...patch }
  await SecureStore.setItemAsync(PREFS, JSON.stringify(prefsCache), LOCAL)
  prefListeners.forEach(listener => listener())
}
