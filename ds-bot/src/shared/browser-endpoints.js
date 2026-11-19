// Endpoints that an authenticated browser device (`kind === 'browser'`) may call
// over the remote link. Everything not listed here — including all native-unlock
// GATED endpoints, phone pairing, connector/IM/mail/local-agent/computer-use
// management, secret vault controls, provider mutation/probing, and any future
// host endpoint — is refused fail-closed on both the host and the web client.
export const BROWSER_ALLOWED = new Set([
  // Team state, metadata, diagnostics, and read-only views
  'hello', 'state', 'notices', 'avatar', 'models', 'efforts', 'providers',
  'usage', 'usage-summary', 'run-stats', 'update-check',
  'diagnostics', 'diagnostics-log', 'diagnostics-clear',
  // Chat, group chat, attachments, cards, and safe pending-request cancellations
  'chat', 'room-chat', 'send', 'stage-image', 'image', 'markdown-image',
  'file-text', 'file-download', 'stop-chat', 'stop-room-work',
  'answer-question', 'dismiss-question', 'view-reply', 'dismiss-view',
  'approval-answer', 'btw-delete', 'secret-cancel', 'connector-request-cancel',
  // Side questions
  'side-new', 'side-ask', 'side-cancel', 'side-close',
  // Bot and group management
  'create-bot', 'update-bot', 'duplicate-bot', 'delete-bot', 'set-main',
  'create-room', 'update-room', 'delete-room',
  // Folders, workspace, schedules, and memory
  'folders', 'folder-list', 'team-workspace',
  'schedules', 'schedule-create', 'schedule-delete',
  'memory-view', 'memory-ask', 'memory-add', 'memory-edit', 'memory-forget',
  // Bot browser handoff controls
  'browser-frame', 'browser-takeover', 'browser-give-back', 'browser-stop',
])
