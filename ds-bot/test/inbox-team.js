// The team the inbox tests share, and a host over it (test/inbox.test.js for the host's
// list, test/inbox-client.test.js for the page drawn from that host's answer).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The team as state.json holds it. Each waiting thing has the shape the module that
// records it writes (tools.js ask_user, secrets.js, connectors/index.js, the mail
// connector, turns.js blockBot, groups.js idle pause, goals.js, handoffs.js).
export const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2 },
    // Its chat moved on to a second part (parts.js).
    coder: {
      id: 'coder', sessionId: 'coder-p2', name: 'Coder', role: 'Code', instructions: '', createdAt: 3,
      segments: [{ sessionId: 'coder', endedAt: 8 }],
      blocked: { code: 'RATE_LIMIT', status: 429, provider: 'deepseek', at: 50 },
    },
  },
  rooms: {
    desk: {
      id: 'desk', name: 'Desk', named: true, members: ['chief', 'writer'], admin: 'chief', mode: 'everyone', sessions: { writer: 'desk-writer' },
      idlePaused: { from: 'writer', count: 40, limit: 40, cause: 'relay', noticed: false, at: 40 },
      goal: { id: 'goal-1', status: 'active', idle: true, current: 0, revision: 3, nudges: 2, updatedAt: 60, stages: [{ title: 'Ship the release', status: 'active', tasks: [] }] },
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {
    writer: { id: 'q-own', question: 'Top or bottom?', options: [{ label: 'Top' }, { label: 'Bottom' }], multiSelect: false, askedAt: 30 },
    'desk-writer': { id: 'q-group', question: 'Which branch?', options: [{ label: 'dev' }, { label: 'main' }], multiSelect: false, askedAt: 35 },
    coder: { id: 'q-old', question: 'Left in the first part', options: [{ label: 'Ok' }], multiSelect: false, askedAt: 7 },
  },
  views: {},
  secretRequests: {
    writer: [
      { id: 'sec-old', sessionId: 'writer', name: 'OLD_TOKEN', purpose: '', kind: 'allow', status: 'allowed', askedAt: 5, settledAt: 6 },
      { id: 'sec-1', sessionId: 'writer', name: 'XHS_COOKIE', purpose: 'Post the note', kind: 'fill', status: 'pending', askedAt: 20 },
    ],
  },
  connectorRequests: { chief: [{ id: 'con-1', sessionId: 'chief', connectorId: 'gmail', name: 'Gmail', purpose: 'Read the invoices', status: 'pending', askedAt: 10 }] },
  mailRequests: { chief: [{ id: 'mail-1', sessionId: 'chief', account: 'acc', to: 'team@example.com', cc: '', bcc: '', subject: 'Weekly report', body: 'Numbers', attachments: [], status: 'pending', askedAt: 70 }] },
  works: {
    'work-1': {
      state: 'paused', from: 'chief', to: 'writer', goal: 'Write the release note', rounds: 3, worked: false, open: [], results: [], at: 44,
      paused: { reason: 'ask_back_limit', kind: 'ask_back', question: 'Which version is this for?', rounds: 3, at: 45 },
    },
  },
})

export function openHost(t, state = team(), { services } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-inbox-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext({ services })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home, github: false })
  const call = async (endpoint, payload = {}) => (await (await ctx.route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    body: JSON.stringify({ endpoint, payload }),
  }))).json())
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { ctx, rt, call }
}

