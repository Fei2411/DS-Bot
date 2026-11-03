// Endpoints that can hand out or change secrets/capabilities need a device
// unlock, every time. Cancel means the call was never sent.
import * as LocalAuth from 'expo-local-authentication'
import { t } from '../ui/i18n.ts'

export const GATED = new Set([
  'provider-key', 'provider-add', 'provider-remove',
  'secret-set', 'secret-update', 'secret-delete', 'secret-allow',
  'connector-connect', 'connector-disconnect', 'connector-retry',
  'capability-save', 'capability-delete', 'capability-approve', 'bot-capability',
  'update-install', 'dsh-update-install',
])

export async function ensureUnlock(endpoint: string): Promise<void> {
  if (!GATED.has(endpoint)) return
  const level = await LocalAuth.getEnrolledLevelAsync()
  if (level === LocalAuth.SecurityLevel.NONE) {
    throw Object.assign(new Error(t('Set a screen lock on this phone to do this')), { code: 'unlock/unavailable' })
  }
  const result = await LocalAuth.authenticateAsync({ promptMessage: t('Unlock to continue'), cancelLabel: t('Cancel'), disableDeviceFallback: false })
  if (!result.success) throw Object.assign(new Error(t('Canceled')), { code: 'unlock/canceled' })
}
