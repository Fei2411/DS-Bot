import { GATED } from './gated.ts'
import { t } from '../ui/i18n.ts'
export { GATED } from './gated.ts'

export async function ensureUnlock(endpoint: string): Promise<void> {
  if (GATED.has(endpoint)) throw Object.assign(new Error(t('Not available from a browser. Use the phone app or the computer.')), { code: 'bot/refused' })
}
