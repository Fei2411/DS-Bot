import * as SecureStore from 'expo-secure-store'
import { deviceIdFor, generateKeyPair, randomToken, type DeviceIdentity, type PairingOffer } from '../../link/src/index.ts'

export interface PhoneIdentity extends DeviceIdentity {
  accessToken: string
}

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
  const saved = await read(COMPUTER) as Partial<SavedComputer> | undefined
  if (typeof saved?.server !== 'string' || typeof saved.hostDeviceId !== 'string' || typeof saved.hostKey !== 'string') return undefined
  return { server: saved.server, hostDeviceId: saved.hostDeviceId, hostKey: saved.hostKey, name: saved.name ?? '' }
}

export async function saveComputer({ server, hostDeviceId, hostKey, name }: PairingOffer): Promise<SavedComputer> {
  const computer = { server, hostDeviceId, hostKey, name }
  await SecureStore.setItemAsync(COMPUTER, JSON.stringify(computer), LOCAL)
  return computer
}

export async function forgetComputer(): Promise<void> {
  await SecureStore.deleteItemAsync(COMPUTER, LOCAL)
}
