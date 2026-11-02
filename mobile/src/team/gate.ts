// Endpoints that can hand out or change secrets/capabilities need a device
// unlock, every time. Cancel means the call was never sent.
import * as LocalAuth from 'expo-local-authentication'

export const GATED = new Set([
  'provider-key', 'provider-add', 'provider-remove',
  'secret-set', 'secret-update', 'secret-delete', 'secret-allow',
  'connector-connect', 'connector-disconnect', 'connector-retry',
  'capability-save', 'capability-delete', 'capability-approve', 'bot-capability',
  'update-install', 'dsh-update-install',
])

export async function ensureUnlock(endpoint: string): Promise<void> {
  if (!GATED.has(endpoint)) return
  const [hardware, enrolled] = await Promise.all([LocalAuth.hasHardwareAsync(), LocalAuth.isEnrolledAsync()])
  if (!hardware || !enrolled) {
    const code = Object.assign(new Error('Set a screen lock on this phone to do this'), { code: 'unlock/unavailable' })
    throw code
  }
  const result = await LocalAuth.authenticateAsync({ promptMessage: 'DS Bot', disableDeviceFallback: false })
  if (!result.success) throw Object.assign(new Error('Canceled'), { code: 'unlock/canceled' })
}
