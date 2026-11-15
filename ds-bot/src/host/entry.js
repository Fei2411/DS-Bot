// The host entry's name and required services, kept apart from the host's modules so
// the entry DSH loads (plugin.js) can declare them without importing any of them.
export const name = 'ds-bot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']
