// The remote boundary of the api/bot channel. A paired phone or browser acts on the
// team; endpoints that open OS dialogs, expose or operate the computer's own windows,
// files, terminals or computer-only settings stay in the computer's window.
// Every channel endpoint must be classified here: the unit test in test/phone.test.js
// fails when channel.js gains an endpoint that is neither team nor computer-only.

// Endpoints that act on the team and may be called by a paired phone. Browsers are
// narrower still: BROWSER_ALLOWED in browser-endpoints.js must be a subset of these.
export const TEAM_ENDPOINTS = new Set([
  'abandon-work', 'add-agent', 'agent-adopt', 'agent-archive',
  'agent-chat', 'agent-rename', 'agent-session', 'answer-question',
  'approval-answer', 'avatar', 'avatar-delete', 'avatar-import',
  'avatar-library', 'background-add', 'background-picture', 'bot-capability',
  'bot-move-to-background', 'bot-steer-queue', 'bot-stop-task', 'bot-task-read',
  'bot-task-send', 'browser-frame', 'browser-give-back', 'browser-stop',
  'browser-takeover', 'btw-delete', 'cancel-work', 'capability-approve',
  'capability-delete', 'capability-save', 'changes-check', 'chat',
  'chatgpt', 'chatgpt-cancel', 'chatgpt-models', 'chatgpt-sign-out',
  'computer-app-answer', 'computer-stop', 'connector-add', 'connector-cancel', 'connector-client',
  'connector-connect', 'connector-disconnect',
  'connector-remove', 'connector-request-cancel', 'connector-retry', 'connector-set',
  'connector-sign-in-code', 'create-bot', 'create-room', 'deepseek-services',
  'deepseek-services-config', 'deepseek-synthesize', 'delete-bot', 'delete-room',
  'diagnostics', 'diagnostics-clear', 'diagnostics-log', 'dismiss-question',
  'dismiss-view', 'dsh-update-install', 'duplicate-bot', 'earlier',
  'efforts', 'exchange', 'exchange-text', 'file-download',
  'file-text', 'folder-list', 'folders', 'goal-control',
  'goal-draft', 'group-relay-replies', 'group-rows', 'group-search',
  'hello', 'im-add', 'im-chat', 'im-login-start',
  'im-login-wait', 'im-pair', 'im-remove', 'im-retry',
  'im-unpair', 'im-update', 'image', 'learning-answer',
  'local-agent-add', 'local-agent-models', 'local-agent-profile-add', 'local-agent-profile-remove',
  'local-agent-profile-update', 'local-agent-refresh', 'local-agent-remove', 'local-agent-update',
  'local-agents', 'mail-account-add', 'mail-account-remove', 'mail-rule-set',
  'mail-send-answer', 'mail-sign-in-code', 'markdown-image', 'memory-add',
  'memory-ask', 'memory-edit', 'memory-forget', 'memory-history',
  'memory-layer', 'memory-move', 'memory-pin', 'memory-restore',
  'memory-tidy-undo', 'memory-view', 'models', 'new-part',
  'notices', 'presets', 'private-release', 'provider-add',
  'provider-key', 'provider-models', 'provider-models-save', 'provider-remove',
  'providers', 'push-register', 'push-unregister', 'remove-agent',
  'repo-stars', 'recover-session', 'resume', 'resume-room-pause', 'resume-work',
  'room-chat', 'room-progress', 'room-todo', 'run-stats',
  'schedule-create', 'schedule-delete', 'schedule-pause', 'schedules',
  'secret-allow', 'secret-cancel', 'secret-decrypt', 'secret-delete',
  'secret-encrypt', 'secret-refresh-external', 'secret-set', 'secret-store',
  'secret-unlock', 'secret-update', 'section-delete', 'section-order',
  'section-save', 'send', 'set-chat-background', 'set-flags',
  'set-main', 'set-prefs', 'side-ask', 'side-cancel',
  'side-close', 'side-new', 'stage-file', 'stage-image',
  'state', 'stop-agent', 'stop-chat', 'stop-member-work',
  'stop-room-work', 'task-cancel', 'task-note', 'team-workspace',
  'thinking', 'update-bot', 'update-check', 'update-install',
  'update-room', 'usage', 'usage-summary', 'view-reply',
])

// Exact endpoints that belong to the computer even though their names carry no prefix.
export const COMPUTER_ONLY_ENDPOINTS = new Set([
  // Opens the native folder chooser on the computer.
  'folder-pick',
  // Opens the computer's external browser for the ChatGPT sign-in flow.
  'chatgpt-sign-in',
  // The desktop window's side of the Bot browser bridge: a remote client must not
  // impersonate the computer that serves browser reads.
  'browser-wait',
  'browser-result',
  // Reads other apps' connector configurations and secrets from this computer's home folder.
  'connector-import-scan',
  'connector-import',
])

// Endpoint families whose whole purpose is this computer: pairing, raw Session logs,
// external API tokens, MCP setup, workspace files and terminals, engine/plugin/speech/
// telemetry settings, and computer-use mediation. `computer-stop` and
// `computer-app-answer` are the exceptions: the phone may stop computer control and answer
// the access card while the computer itself stays in charge of that control.
export const COMPUTER_ONLY_PREFIXES = Object.freeze([
  'phone-',
  'session-',
  'api-',
  'mcp-',
  'workspace-',
  'terminal-',
  'engine-',
  'plugins-',
  'speech-',
  'telemetry-',
  'computer-',
])

export function isTeamEndpoint(endpoint) {
  return TEAM_ENDPOINTS.has(endpoint)
}

export function isComputerOnlyEndpoint(endpoint) {
  if (TEAM_ENDPOINTS.has(endpoint)) return false
  return COMPUTER_ONLY_ENDPOINTS.has(endpoint) || COMPUTER_ONLY_PREFIXES.some(prefix => endpoint.startsWith(prefix))
}

export function isClassifiedEndpoint(endpoint) {
  return isTeamEndpoint(endpoint) || isComputerOnlyEndpoint(endpoint)
}

export function computerOnlyError(endpoint) {
  if (!isComputerOnlyEndpoint(endpoint)) return undefined
  if (endpoint.startsWith('phone-')) return { code: 'bot/refused', message: 'Phones are paired and removed on the computer', details: {} }
  if (endpoint.startsWith('session-')) return { code: 'bot/refused', message: 'Session logs are read on the computer', details: {} }
  if (endpoint.startsWith('api-')) return { code: 'bot/refused', message: 'External API settings and tokens are managed on the computer', details: {} }
  if (endpoint.startsWith('mcp-')) return { code: 'bot/refused', message: 'MCP access is set up on the computer', details: {} }
  if (endpoint.startsWith('workspace-') || endpoint.startsWith('terminal-')) return { code: 'bot/refused', message: 'Workspace files and terminals are available on the computer', details: {} }
  if (endpoint.startsWith('engine-')) return { code: 'bot/refused', message: 'Engine settings are managed on the computer', details: {} }
  if (endpoint.startsWith('plugins-')) return { code: 'bot/refused', message: 'Plugins are managed on the computer', details: {} }
  if (endpoint.startsWith('speech-')) return { code: 'bot/refused', message: 'Voice input settings and transcription are available on the computer', details: {} }
  if (endpoint.startsWith('telemetry-')) return { code: 'bot/refused', message: 'Privacy and telemetry settings are managed on the computer', details: {} }
  if (endpoint === 'folder-pick') return { code: 'bot/refused', message: 'Folders are chosen in a window on the computer', details: {} }
  if (endpoint.startsWith('computer-')) return { code: 'bot/refused', message: 'Computer use is controlled on the computer', details: {} }
  if (endpoint === 'connector-import-scan' || endpoint === 'connector-import') return { code: 'bot/refused', message: 'Connector imports read apps on this computer', details: {} }
  return { code: 'bot/refused', message: 'This action is available in the window on the computer', details: {} }
}

export function unclassifiedRemoteError(endpoint) {
  if (isClassifiedEndpoint(endpoint)) return undefined
  return { code: 'bot/refused', message: 'This endpoint has not been approved for paired devices', details: {} }
}
