import type { Approval, Bot, Question, Room, SecretRequest, TeamState } from '../connection.ts'
import type { ChatItem } from '../screens/chat/items.tsx'

export interface DemoChatPage { sessionId: string; items: ChatItem[]; cursor: { part: number; beforeSeq?: number } | null }

export interface DemoData {
  state: TeamState
  chats: Record<string, DemoChatPage[]>
}

const T = 1_762_000_000_000 // fixed demo clock
const seq = () => { let n = 0; return () => { n += 1; return n } }

const BOTS: Bot[] = [
  { id: 'b-chief', name: 'Chief', role: 'Main Bot', capabilities: ['Run shell commands', 'Read files'], color: 'deepseek', avatar: { shape: 'whale' }, model: 'deepseek-official/deepseek-v4.1', effort: 'medium', workDir: '~/ds-bot', instructions: 'Keep the team moving, review every diff before it lands.', sessionId: 's-chief', parts: ['s-chief-0'], createdAt: T - 90 * 86400e3, lastAt: T - 600e3, preview: 'Here is the plan, in order' },
  { id: 'b-writer', name: 'Writer', role: 'Words and docs', color: 'violet', avatar: { shape: 'moon' }, model: 'deepseek-official/deepseek-flash', workDir: '~/ds-bot/docs', sessionId: 's-writer', createdAt: T - 60 * 86400e3, lastAt: T - 2400e3, preview: 'Draft is attached for review' },
  { id: 'b-coder', name: 'Coder', role: 'Builds and fixes', color: 'cyan', avatar: { shape: 'hex' }, sessionId: 's-coder', createdAt: T - 55 * 86400e3 },
  { id: 'b-researcher', name: 'Researcher', role: 'Reads and compares', color: 'green', avatar: { shape: 'pebbles' }, sessionId: 's-researcher', createdAt: T - 50 * 86400e3 },
  { id: 'b-designer', name: 'Designer', role: 'Interface and brand', color: 'magenta', avatar: { shape: 'star' }, sessionId: 's-designer', pinned: true, createdAt: T - 45 * 86400e3, lastAt: T - 7200e3, preview: 'New avatar set is in' },
]

const ROOMS: Room[] = [
  { id: 'r-launch', name: 'Launch plan', members: ['b-chief', 'b-coder', 'b-writer'], admin: 'b-chief', mode: 'admin', notice: 'Ship the release with green tests.', named: true, preview: 'Coder：Landing page draft is up', lastAt: T - 900e3, createdAt: T - 20 * 86400e3 },
  { id: 'r-weekly', name: 'Weekly review', members: ['b-researcher', 'b-designer'], preview: 'Researcher：Notes for Friday', lastAt: T - 86400e3, createdAt: T - 30 * 86400e3 },
]

const QUESTIONS: Record<string, Question> = {
  's-researcher': {
    id: 'q-1',
    question: 'Which comparison should I send to Chief?',
    detail: 'I finished all three drafts.',
    options: [{ label: 'The short one-page summary' }, { label: 'The full table with sources' }, { label: 'Both, summary first' }],
  },
}

const APPROVALS: Approval[] = [
  { id: 'a-1', sessionId: 's-coder', botId: 'b-coder', tool: 'run_command', reason: 'Coder wants to run the migration script on the staging database.', detail: { code: 'node scripts/migrate.mjs --env staging' }, answerable: true, at: T - 600e3 },
]

export function demoData(): DemoData {
  const s = seq()
  const state: TeamState = {
    revision: 1,
    bots: BOTS.map(bot => ({ ...bot })),
    rooms: ROOMS.map(room => ({ ...room })),
    questions: { 's-researcher': { ...QUESTIONS['s-researcher'], options: QUESTIONS['s-researcher'].options?.map(o => ({ ...o })) } },
    secretRequests: { 'b-coder': [{ id: 'k-1', name: 'NPM_TOKEN', status: 'pending' }] as SecretRequest[] },
    work: {
      bots: { 'b-coder': { tool: 'run_command', said: 'Running the test suite' } },
      rooms: { 'r-launch': [{ botId: 'b-writer', tool: 'write_file', note: 'Drafting the release notes' }] },
      approvals: APPROVALS.map(a => ({ ...a })),
      waiting: {},
      turns: {},
    },
    activity: { 'b-coder': { tool: 'run_command', said: 'Running the test suite' } },
    browserHolds: {
      'b-coder': { by: 'bot', reason: 'handoff', note: '需要你在浏览器里登录 GitHub 才能继续。', callId: 'hc-1' },
    },
    btwCards: {
      'b-coder': [
        { id: 'btw-1', partId: 's-coder', question: '测试跑到哪了？', answer: '迁移脚本已过 80%，卡在 staging 的环境变量上。', status: 'done' },
      ],
    },
    sideChats: {
      'b-chief': [
        { chatId: 'sc-1', entries: [
          { id: 'se-1', question: '进度怎么样了？', answer: '三个 Bot 都在轨：Coder 在跑测试，Writer 起草了发布说明，Researcher 交了对比。', status: 'done' },
          { id: 'se-2', question: '哪一步最慢？', answer: '测试套件的迁移脚本，卡在 staging 环境变量上。', status: 'done' },
        ] },
        { chatId: 'sc-2', entries: [
          { id: 'se-3', question: '明天的发布能赶上吗？', answer: '', status: 'answering' },
        ] },
      ],
    },
    connectors: [
      { id: 'github', name: 'GitHub', state: 'ready', account: 'you' },
      { id: 'linear', name: 'Linear', state: 'off' },
      { id: 'notion', name: 'Notion', state: 'error', error: 'Token expired' },
    ],
    capabilityStatuses: {
      'b-chief': { 'Run shell commands': { state: 'ready' }, 'Read files': { state: 'ready' } },
      'b-coder': { 'Write files': { state: 'needs-approval' }, 'Browse the web': { state: 'error', error: 'Token expired' } },
    },
    capabilities: [
      { name: 'Run shell commands', description: 'Run terminal commands on the computer', kind: 'mcp', transport: 'stdio' },
      { name: 'Read files', description: 'Read files inside the working folder', kind: 'mcp', transport: 'stdio' },
      { name: 'Write files', description: 'Write files inside the working folder', kind: 'mcp', transport: 'stdio' },
      { name: 'Browse the web', description: 'Open pages and read them', kind: 'mcp', transport: 'streamable-http' },
    ],
    workspace: '/work',
    dataPath: '~/Library/Application Support/ds-bot',
    version: '0.1.2',
    models: [
      { ref: 'deepseek-official/deepseek-v4.1', name: 'DeepSeek v4.1' },
      { ref: 'deepseek-official/deepseek-flash', name: 'DeepSeek Flash' },
      { ref: 'openrouter/auto', name: 'OpenRouter Auto' },
    ],
    defaultModel: 'deepseek-official/deepseek-v4.1',
    mainBotId: 'b-chief',
    mainBotIds: ['b-chief'],
    views: {
      's-chief': {
        id: 'v-1', title: 'Release readiness',
        view: { type: 'stack', children: [
          { type: 'chart', kind: 'bar', categories: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], series: [{ name: 'Merged', values: [3, 5, 2, 7, 4] }, { name: 'Open', values: [6, 4, 5, 3, 2] }], unit: ' PRs' },
          { type: 'slider', id: 'days', label: 'Days to release', min: 1, max: 14, step: 1, value: 5, unit: 'd' },
          { type: 'metric', label: 'Reviews to clear', value: { '=': '18 / days' }, caption: 'reviews per day to hit the tag' },
          { type: 'options', id: 'a-1', options: [{ label: 'Ship Friday' }, { label: 'Hold for Monday' }, { label: 'Cancel the tag' }] },
        ] },
      },
    },
    exchangeTurns: {},
    prefs: { theme: 'deepseek' },
  }

  const md = [
    'Here is the plan I would take to production:',
    '',
    '- Pairing moved to the **Settings → Phone** card',
    '- The team list now polls `state` every three seconds',
    '- Writer runs on deepseek-official/deepseek-flash for drafts and summaries',
    '- Launch plan seats Chief (admin, you) and Writer together for the release checklist',
    '',
    '```ts',
    'const page = await call(\'chat\', { botId, cursor: { part: index, beforeSeq }, steps: true })',
    '```',
    '',
    'Worth a read: the [design notes](https://dsbot.app).',
    '',
    '| Screen | Variant A | Variant B | Variant C | Variant D |',
    '|---|---|---|---|---|',
    '| Team list | Tab | Drawer | Rail | Column |',
  ].join('\n')

  const chats: DemoData['chats'] = {
    'b-chief': [
      { sessionId: 's-chief', cursor: { part: 1, beforeSeq: 10 }, items: [
        { kind: 'user', text: 'Ship the list first, then the drawer comparison.', time: T - 3400e3, seq: s(), turn: 3 },
        { kind: 'view', title: 'Team pulse this week', time: T - 2800e3, seq: s(), turn: 3 },
              { kind: 'view', title: 'Coverage this week', view: { type: 'stack', children: [
        { type: 'metric', label: 'Cases passing', value: 186, caption: 'of 191 total' },
        { type: 'table', columns: ['Suite', 'Pass', 'Fail'], rows: [['Unit', 142, 2], ['Link', 20, 0], ['Mobile', 24, 3]] },
      ] }, time: T - 3000e3, seq: s(), turn: 4 },
      { kind: 'view', title: 'Draft report', view: { type: 'stack', children: [
        { type: 'html', summary: 'A rich draft with charts and interactive sections that only render fully on the computer.', html: '<div/>' },
      ] }, time: T - 2990e3, seq: s(), turn: 4 },
      { kind: 'answer', text: 'Ship Friday', views: [{ id: 'v-1', title: 'Release readiness', view: { type: 'options', id: 'a-1', options: [{ label: 'Ship Friday' }, { label: 'Hold for Monday' }, { label: 'Cancel the tag' }] } }], answers: [{ id: 'v-1', action: 'options', values: { selected: ['Ship Friday'] } }], time: T - 2500e3, seq: s(), turn: 4 },
      { kind: 'user', text: 'Here is the screenshot from the phone', images: 2, imageRefs: [{ attachmentId: 'demo-img-1', mime: 'image/png', name: 'blue.png' }, { attachmentId: 'demo-img-2', mime: 'image/png', name: 'night.png' }], time: T - 2600e3, seq: s(), turn: 4 },
        { kind: 'answer', questions: [{ question: 'Which build should the phone use?' }], answers: [{ selected: ['The debug build'], custom: 'Keep Metro on port 8081' }], time: T - 2400e3, seq: s(), turn: 4 },
        { kind: 'event', role: 'report', name: 'Writer', time: T - 2000e3, seq: s() },
      { kind: 'divider', time: T - 86400e3 / 24, seq: s() },
        { kind: 'bot', text: md, time: T - 1900e3, seq: s(), turn: 5 },
        { kind: 'event', role: 'request', name: 'Coder', time: T - 1850e3, seq: s() },
        { kind: 'bot', text: 'Release notes are in. I am holding the tag until the screenshots land.', time: T - 1800e3, seq: s(), turn: 5 },
        { kind: 'steps', turn: 5, ms: 12400, tools: [
          { name: 'read_file', label: 'Opening a file', ok: true },
          { name: 'run_command', label: 'Running shell commands', ok: true },
          { name: 'remember', label: 'Saving to memory', ok: true },
        ], time: T - 1700e3, seq: s() },
        { kind: 'user', text: '看下这个文件', files: [{ name: 'release-notes.md', bytes: 4820, attachmentId: 'att-1' }], time: T - 42 * 60e3 },
      { kind: 'event', role: 'paused', name: 'Coder', text: 'Chief and Writer', ms: 3, time: T - 40 * 60e3 },
      ] },
      { sessionId: 's-chief-0', cursor: null, items: [
        { kind: 'divider', time: T - 8 * 86400e3, seq: s() },
        { kind: 'user', text: 'Sketch the phone pairing flow for me.', time: T - 8 * 86400e3 + 60e3, seq: s(), turn: 0 },
        { kind: 'bot', text: 'Two steps: QR on the computer, camera on the phone. The link below is the fallback.', time: T - 8 * 86400e3 + 120e3, seq: s(), turn: 0 },
      ] },
    ],
    'b-writer': [
      { sessionId: 's-writer', cursor: null, items: [
        { kind: 'bot', text: 'Draft of the release notes is ready:\n\n1. What is new\n2. What changed\n3. What we removed\n\nWant the tone friendly or formal?', time: T - 7200e3, seq: s(), turn: 1 },
        { kind: 'user', text: 'Friendly, but keep the section heads.', time: T - 7000e3, seq: s(), turn: 2 },
      ] },
    ],
    'b-coder': [
      { sessionId: 's-coder', cursor: null, items: [
        { kind: 'user', text: 'Get the mobile branch building on the emulator.', time: T - 5400e3, seq: s(), turn: 1 },
        { kind: 'bot', text: 'Build is green. One thing left: the migration needs your approval before I run it on staging.', time: T - 5200e3, seq: s(), turn: 1 },
        { kind: 'event', role: 'reply', name: 'Chief', time: T - 5000e3, seq: s() },
      ] },
    ],
    'b-researcher': [
      { sessionId: 's-researcher', cursor: null, items: [
        { kind: 'user', text: 'Compare the three pairing proposals.', time: T - 9600e3, seq: s(), turn: 1 },
        { kind: 'bot', text: 'All three drafts are done. One question before I hand them over.', time: T - 9400e3, seq: s(), turn: 1 },
      ] },
    ],
    'b-designer': [
      { sessionId: 's-designer', cursor: null, items: [
        { kind: 'bot', text: 'Pinned me! I keep the palette and the mark library tidy.', time: T - 20000e3, seq: s(), turn: 0 },
      ] },
    ],
    'r-launch': [
      { sessionId: 'r-launch', cursor: null, items: [
        { kind: 'event', role: 'request', name: 'Chief', time: T - 4000e3, seq: s() },
        { kind: 'bot', text: 'Landing page draft is up for review.', name: 'Coder', time: T - 3800e3, seq: s() },
        { kind: 'user', text: 'Add the pricing row before Friday.', time: T - 3600e3, seq: s() },
      ] },
    ],
    'r-weekly': [
      { sessionId: 'r-weekly', cursor: null, items: [
        { kind: 'bot', text: 'Notes for Friday are collected.', name: 'Researcher', time: T - 60000e3, seq: s() },
      ] },
    ],
  }
  return { state, chats }
}
