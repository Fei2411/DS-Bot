// Keep aligned with BROWSER_GATED in ds-bot/src/host/phone.js.
export const GATED = new Set([
  'provider-key', 'provider-add', 'provider-remove',
  'secret-set', 'secret-update', 'secret-delete', 'secret-allow',
  'connector-connect', 'connector-disconnect', 'connector-retry',
  'connector-client', 'connector-sign-in-code',
  'capability-save', 'capability-delete', 'capability-approve', 'bot-capability',
  'update-install', 'dsh-update-install',
])
