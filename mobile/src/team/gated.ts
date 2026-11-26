// Endpoints that require a native device unlock before leaving the phone.
// Must remain disjoint from BROWSER_ALLOWED in ds-bot/src/shared/browser-endpoints.js.
export const GATED = new Set([
  'provider-key', 'provider-add', 'provider-remove',
  'secret-set', 'secret-update', 'secret-delete', 'secret-allow',
  'connector-connect', 'connector-disconnect', 'connector-retry',
  'connector-client', 'connector-sign-in-code',
  'capability-save', 'capability-delete', 'capability-approve', 'bot-capability',
  'learning-answer',
  'update-install', 'dsh-update-install',
])
