import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { manualDirectory } from '../src/host/manual-skills.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'

let rt

// A Bot's id is a Session id, which a path may hold.
const P = 'd1a40000-1111-4222-8333-444444444444'

// Chief (Main), Writer in the group Ops, and Diary, a Bot with a folder of its own.
function seed({ diary, privateBot, archives = [], picked, openPart = false }) {
  return {
    version: 1,
    mainBotIds: ['a'],
    privateArchives: archives,
    workspaceId: 'w1',
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
      [P]: { id: P, name: 'Diary', role: 'Notes', sessionId: P, createdAt: 3, instructions: 'Keep the diary of the user.', workDir: diary, ...(privateBot ? { private: true } : {}), ...(openPart ? { openParts: [{ sessionId: 'p-bg', segments: [] }] } : {}) },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' }, ...(picked === undefined ? {} : { memberDirs: { b: picked } }) } },
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

async function start({ services = {}, privateBot = true, archives, memberPick = false, openPart = false } = {}) {
  // The native realpath, as fs/promises uses: on Windows the JS one keeps 8.3 short names.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-privacy-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  const diary = join(root, 'diary')
  const picked = join(root, 'picked')
  for (const dir of [team, project, diary, ...(memberPick ? [picked] : [])]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(diary, 'notes.txt'), 'secret')
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed({ diary, privateBot, archives, picked: memberPick ? picked : undefined, openPart })))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh

  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, header: { cwd: sessionId === P ? diary : team }, requestHeader: () => undefined, deriveMessages: () => [] },
        status: 'idle',
        followup() {},
        steer() {},
        inject() {},
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  const registry = new Map([['w1', { id: 'w1', path: team, title: 'DS Bot' }]])
  let created = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: 'w-new', path, title: 'DS Bot' }
        registry.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      // Ids shaped like real Session ids: a short one would match any path it lands in.
      create: async () => ({ sessionId: `0000000${++created}-1111-4222-8333-444444444444` }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  // The privacy listener alone, which runs first; the last step stands for the tool.
  const guard = ctx.listeners.get('tools/execute')[0]
  const run = async (name, args, sessionId, agent = agentOf(sessionId)) => {
    let ran = false
    const exec = { name, arguments: args, agent, callId: 'c1', signal: AbortSignal.timeout(60_000) }
    try {
      await guard(exec, async () => { ran = true })
      return { ran }
    } catch (error) {
      return { ran, error: error.message }
    }
  }
  const stop = async () => {
    await ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes.
  await tool('list_bots', {}, 'a')
  return { rt, ctx, root, dsh, home, team, project, diary, picked, agentOf, call, tool, run, state, stop }
}

const CLOSED = /private Bot/

for (const child of [false, true]) test('private relative file approvals include their actual destination; child=' + child, async t => {
  const env = await start({ services: { approval: fakeApproval() } })
  t.after(env.stop)
  const evidence = []
  env.rt.requestActionApproval = async (_request, action) => { evidence.push(action); return 'allowed-once' }
  const agent = env.agentOf(child ? 'private-child' : P)
  if (child) Object.assign(agent.session.header, { parentSession: P, origin: 'subagent' })
  for (const cwd of [env.project, env.team]) {
    agent.session.header.cwd = cwd
    assert.equal((await env.run('write', { file_path: 'report.txt', content: 'report' }, agent.id, agent)).ran, true)
  }
  assert.equal(evidence[0].cwd, env.project)
  assert.equal(evidence[0].path, join(env.project, 'report.txt'))
  assert.equal(evidence[0].resolvedPath, join(env.project, 'report.txt'))
  assert.equal(evidence[1].path, join(env.team, 'report.txt'))
  assert.notDeepEqual(evidence[0], evidence[1])
})

test('private file approval cannot be reused after a link target changes', async t => {
  const env = await start({ services: { approval: fakeApproval() } })
  t.after(env.stop)
  const agent = env.agentOf(P)
  agent.session.header.cwd = env.project
  const path = join(env.project, 'report.txt')
  const realBeyond = env.rt.realBeyond
  let moved = false
  env.rt.realBeyond = value => value === path && moved ? Promise.resolve(join(env.team, 'report.txt')) : realBeyond(value)
  env.rt.requestActionApproval = async () => { moved = true; return 'allowed-once' }
  const result = await env.run('write', { file_path: 'report.txt', content: 'report' }, P)
  assert.equal(result.ran, false)
  assert.match(result.error, /destination changed/)
})

test('private file approval cannot be reused after its effective directory changes', async t => {
  const env = await start({ services: { approval: fakeApproval() } })
  t.after(env.stop)
  const agent = env.agentOf(P)
  agent.session.header.cwd = env.project
  env.rt.requestActionApproval = async () => { agent.session.header.cwd = env.team; return 'allowed-once' }
  const result = await env.run('write', { file_path: 'report.txt', content: 'report' }, P)
  assert.equal(result.ran, false)
  assert.match(result.error, /destination changed/)
})


test('only the user makes a Bot private, and the Bot needs a folder of its own', async (t) => {
  const { rt, project, team, state, stop } = await start({ privateBot: false })
  t.after(stop)
  await assert.rejects(rt.updateBot(P, { private: true }, 'a'), /Only the user can make Diary private/)
  await assert.rejects(rt.updateBot('b', { private: true }), /needs a folder of its own/)
  await assert.rejects(rt.updateBot('b', { private: true, workDir: team }), /needs a folder of its own/)
  await assert.rejects(rt.updateBot('a', { private: true, workDir: project }), /Main Bot/)
  // Writer is in the group Ops, where every member reads what is said.
  await assert.rejects(rt.updateBot('b', { private: true, workDir: project }), /group chat/)
  assert.equal(state().bots.b.private, undefined)
  await rt.updateBot(P, { private: true })
  assert.equal(state().bots.p, undefined)
  assert.equal(state().bots[P].private, true)
  await rt.updateBot(P, { private: false })
  assert.equal(state().bots[P].private, undefined)
})

test('the user makes a Bot private through the client channel', async (t) => {
  const { call, state, stop } = await start({ privateBot: false })
  t.after(stop)
  await call('update-bot', { id: P, private: true })
  assert.equal(state().bots[P].private, true)
  await call('update-bot', { id: P, private: false })
  assert.equal(state().bots[P].private, undefined)
})

test('a private Bot has a folder that no other folder is in or around', async (t) => {
  const { rt, team, project, diary, state, stop } = await start({ privateBot: false })
  t.after(stop)
  mkdirSync(join(team, 'inside'))
  mkdirSync(join(diary, 'inside'))
  await rt.updateBot(P, { workDir: join(team, 'inside') })
  await assert.rejects(rt.updateBot(P, { private: true }), /team workspace/)
  await rt.updateBot(P, { workDir: diary })
  // Writer's folder lies in Diary's, so Diary cannot be private there.
  await rt.updateBot('b', { workDir: join(diary, 'inside') })
  await assert.rejects(rt.updateBot(P, { private: true }), /folder of Writer/)
  await rt.updateBot('b', { workDir: project })
  await rt.updateBot(P, { private: true })
  assert.equal(state().bots[P].private, true)
  // Once Diary is private, no other Bot, group or team workspace goes in or around its folder.
  await assert.rejects(rt.updateBot('b', { workDir: diary }), CLOSED)
  await assert.rejects(rt.updateBot('b', { workDir: join(diary, 'inside') }), CLOSED)
  await assert.rejects(rt.updateRoom('r1', { workDir: join(diary, 'inside') }), CLOSED)
  await assert.rejects(rt.createBot({ name: 'Third', workDir: diary }), CLOSED)
  await assert.rejects(rt.setTeamWorkspace(diary), CLOSED)
  await assert.rejects(rt.updateBot(P, { workDir: project }), /folder of Writer/)
  assert.equal(state().bots.b.workDir, project)
})

test('a member\'s folder pick in a group counts as that member\'s folder for a private Bot', async (t) => {
  const { rt, picked, diary, run, state, stop } = await start({ privateBot: false, memberPick: true })
  t.after(stop)
  mkdirSync(join(picked, 'inside'))
  // Writer picked this folder for its conversation in Ops, so it is closed to Diary too.
  await assert.rejects(rt.updateBot(P, { private: true, workDir: picked }), /folder of Writer in "Ops"/)
  await assert.rejects(rt.updateBot(P, { private: true, workDir: join(picked, 'inside') }), /folder of Writer in "Ops"/)
  await rt.updateBot(P, { private: true, workDir: diary })
  assert.equal(state().bots[P].private, true)
  // The other way around too: the member cannot move that conversation into a
  // private Bot's folder.
  const moved = await run('working_directory', { cd: diary }, 'gb')
  assert.equal(moved.ran, false)
  assert.match(moved.error, CLOSED)
})

test('a private Bot is no Main Bot, no member of a group and no copy', async (t) => {
  const { rt, stop } = await start()
  t.after(stop)
  await assert.rejects(rt.setMain(P, true), /private/)
  await assert.rejects(rt.createRoom({ members: ['a', P], createdBy: 'a' }), /cannot be in a group chat/)
  await assert.rejects(rt.updateRoom('r1', { add: [P] }, 'a'), /cannot be in a group chat/)
  await assert.rejects(rt.duplicateBot(P), /cannot be copied/)
})

test('the others only see the name and role of a private Bot', async (t) => {
  const { tool, stop } = await start()
  t.after(stop)
  const others = await tool('list_bots', {}, 'b')
  assert.match(others, /- Diary \(Notes, private Bot, closed to other Bots\)/)
  assert.doesNotMatch(others, /Keep the diary|works in/)
  assert.doesNotMatch(others, /Diary[^\n]*\n\s+now:/)
  const own = await tool('list_bots', {}, P)
  assert.match(own, /Diary \(Notes, .*private, you\) — Keep the diary of the user\./)
})

test('other Bots cannot reach a private Bot through the tools between Bots', async (t) => {
  const { run, stop } = await start()
  t.after(stop)
  for (const [name, args, from] of [
    ['message_bot', { to: 'Diary', message: 'hi' }, 'a'],
    ['message_bot', { to: '@diary', message: 'hi' }, 'b'],
    ['message_bot', { to: P, message: 'hi' }, 'b'],
    ['stop_bot', { bot: 'Diary' }, 'a'],
    ['attach_capability', { bot: 'Diary', name: 'x' }, 'a'],
    ['detach_capability', { bot: 'Diary', name: 'x' }, 'a'],
    ['update_bot', { bot: 'Diary', instructions: 'x' }, 'a'],
    ['bot_recall', { scope: 'Diary', query: 'x' }, 'a'],
    ['bot_recall', { scope: '"Diary"' }, 'b'],
    ['bot_remember', { scope: 'Diary', text: 'x' }, 'a'],
    ['bot_forget', { scope: 'Diary', entry: 'x' }, 'a'],
  ]) {
    const result = await run(name, args, from)
    assert.equal(result.ran, false, `${name} from ${from}`)
    assert.match(result.error, CLOSED)
  }
  // The others still reach each other and the shared scopes.
  assert.deepEqual(await run('message_bot', { to: 'Writer', message: 'hi' }, 'a'), { ran: true })
  assert.deepEqual(await run('bot_recall', { scope: 'team', query: 'x' }, 'b'), { ran: true })
  assert.deepEqual(await run('bot_recall', { scope: 'own' }, P), { ran: true })
  assert.deepEqual(await run('update_bot', { bot: 'Diary', role: 'x' }, P), { ran: true })
})

// #1501: a private Bot may keep a part live in the background while the user reads
// another. What that part says and reads is the private Bot's as much as its chat is.
test('a private Bot\'s background part stays closed to other Bots', async (t) => {
  const { run, stop } = await start({ openPart: true })
  t.after(stop)
  const denied = await run('session_trace', { session_id: 'p-bg' }, 'b')
  assert.equal(denied.ran, false)
  assert.match(denied.error, CLOSED)
  // Its own Bot still reads that part, and so does a search that names it.
  assert.deepEqual(await run('session_trace', { session_id: 'p-bg' }, P), { ran: true })
  assert.deepEqual(await run('session_search', { query: 'x', session_ids: ['p-bg'] }, P), { ran: true })
})

test('pruned private task history stays protected after reloading state and deleting its Bot', async (t) => {
  const { rt, run, state, stop } = await start()
  t.after(stop)
  const bot = rt.botOf(P)
  bot.tasks = Array.from({ length: 51 }, (_, n) => ({
    id: `task-${n}`, sessionId: `retired-private-${n}`, status: 'completed',
  }))
  bot.tasks[0].segments = [{ sessionId: 'retired-private-earlier' }]
  await rt.reconcileTasksAfterRestart()
  const saved = state().bots[P]
  assert.equal(saved.tasks.length, 50)
  assert.deepEqual(saved.retiredTaskSessions, ['retired-private-0', 'retired-private-earlier'])
  rt.state.bots[P] = saved
  const ids = { session_ids: saved.retiredTaskSessions }
  assert.match((await run('session_search', ids, 'b')).error, CLOSED)
  assert.deepEqual(await run('session_search', ids, P), { ran: true })
  await rt.deleteBot(P)
  assert.match((await run('session_search', ids, 'b')).error, CLOSED)
  assert.ok(ids.session_ids.every(id => state().privateArchives[0].sessionIds.includes(id)))
})

test('other Bots cannot read, write or search what a private Bot keeps', async (t) => {
  const { run, root, dsh, home, diary, team, project, stop } = await start()
  t.after(stop)
  const notes = join(diary, 'notes.txt')
  const posix = path => path.replace(/\\/g, '/')
  const gitBash = /^[a-z]:/i.test(diary) ? `/${diary[0].toLowerCase()}${posix(diary).slice(2)}` : posix(diary)
  const refused = async (name, args, from = 'b') => {
    const result = await run(name, args, from)
    assert.equal(result.ran, false, `${name} ${JSON.stringify(args)}`)
    assert.match(result.error, CLOSED)
  }
  await refused('read', { file_path: notes })
  await refused('read', { file_path: relative(team, notes) })
  if (process.platform !== 'linux') await refused('read', { file_path: notes.toUpperCase() })
  await refused('write', { file_path: notes, content: 'x' })
  await refused('edit', { file_path: join(diary, 'new.txt'), old_string: 'a', new_string: 'b' })
  await refused('str_replace_editor', { command: 'view', path: notes })
  await refused('read_image', { file_path: join(diary, 'a.png') })
  await refused('read', { file_path: join(home, 'memory', 'bots', P, 'MEMORY.md') })
  await refused('read', { file_path: join(home, 'memory', 'journal.jsonl') })
  await refused('read', { file_path: join(home, 'state.json') })
  await refused('read', { file_path: join(home, 'chat-index.sqlite') })
  await refused('read', { file_path: join(home, 'usage.sqlite') })
  await refused('read', { file_path: join(home, 'secrets.json') })
  await refused('read', { file_path: join(home, 'learning', 'state.json') })
  await refused('read', { file_path: join(home, 'memory', 'pending.json') })
  await refused('glob', { pattern: '**/*', path: diary })
  await refused('glob', { pattern: '**/*.txt', path: root })
  await refused('grep', { pattern: 'secret', path: root })
  await refused('glob', { pattern: `${posix(diary)}/**` })
  await refused('glob', { pattern: '**/*', path: home })
  await refused('bash', { command: `cat ${posix(notes)}` })
  await refused('bash', { command: `cat ${gitBash}/notes.txt` })
  await refused('pwsh', { command: `Get-Content '${notes}'`, workdir: project })
  await refused('bash', { command: 'ls', workdir: diary })
  await refused('bash', { command: `cat ${posix(join(home, 'state.json'))}` })
  await refused('bash', { command: `cat ${posix(join(home, 'chat-index.sqlite'))}` })
  await refused('working_directory', { cd: diary })
  await refused('working_directory', { cd: root })
  await refused('subagent', { cwd: diary, prompt: 'read notes.txt' })
  await refused('subagent_fork', { cwd: relative(team, diary), prompt: 'read notes.txt' })
  await refused('session_search', { query: 'x' })
  await refused('session_search', { query: 'x', session_id: P })
  await refused('session_trace', { session_ids: ['b', P] })
  await refused('session_event_read', { parent_session_ids: [P] })
  // What is open stays open.
  for (const [name, args] of [
    ['read', { file_path: join(project, 'a.txt') }],
    ['read', { file_path: 'a.txt' }],
    ['write', { file_path: join(team, 'a.txt'), content: 'x' }],
    ['read', { file_path: join(dsh, 'sessions', 'b.jsonl') }],
    ['read', { file_path: join(home, 'memory', 'team', 'MEMORY.md') }],
    ['glob', { pattern: '**/*', path: join(home, 'memory', 'team') }],
    ['glob', { pattern: '**/*', path: project }],
    ['glob', { pattern: '**/*', path: team }],
    ['grep', { pattern: 'x' }],
    ['bash', { command: 'ls', workdir: project }],
    ['subagent', { cwd: project, prompt: 'work in the open folder' }],
    ['working_directory', { cd: join(team, 'sub') }],
    ['session_search', { query: 'x', session_ids: ['b'] }],
  ]) {
    assert.deepEqual(await run(name, args, 'b'), { ran: true }, `${name} ${JSON.stringify(args)}`)
  }
})

test('bundled skill references stay readable under a data root with a private Bot present', async (t) => {
  const { rt, run, home, stop } = await start()
  t.after(stop)
  const reader = (await rt.createBot({ name: 'Reader' })).id
  rt.dshHome = dirname(dirname(manualDirectory()))
  const reference = join(manualDirectory(), 'references', 'settings.md')
  assert.ok(readFileSync(reference, 'utf8').includes('# Settings reference'))
  assert.deepEqual(await run('read', { file_path: reference }, reader), { ran: true })
  for (const file of [join(rt.dshHome, 'private-data.json'), join(home, 'state.json')]) {
    const result = await run('read', { file_path: file }, reader)
    assert.equal(result.ran, false)
    assert.match(result.error, CLOSED)
  }
})

test('a link into the folder of a private Bot is closed too', async (t) => {
  const { run, project, diary, stop } = await start()
  t.after(stop)
  const link = join(project, 'link')
  try {
    symlinkSync(diary, link, 'junction')
  } catch {
    t.skip('no links here')
    return
  }
  try {
    const result = await run('read', { file_path: join(project, 'link', 'notes.txt') }, 'b')
    assert.equal(result.ran, false)
    assert.match(result.error, CLOSED)
    // The file does not exist yet: the link above it still has to be resolved.
    const created = await run('write', { file_path: join(project, 'link', 'new.txt'), content: 'x' }, 'b')
    assert.equal(created.ran, false)
    assert.match(created.error, CLOSED)
  } finally {
    unlinkSync(link)
  }
})

test('the private Bot reads its own and the team\'s files; a Session it starts speaks for it', async (t) => {
  const { run, diary, project, team, home, stop } = await start()
  t.after(stop)
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, P), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: diary }, P), { ran: true })
  assert.equal((await run('glob', { pattern: '**/*', path: home }, P)).ran, false)
  assert.deepEqual(await run('read', { file_path: join(project, 'a.txt') }, P), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: team }, P), { ran: true })
  assert.deepEqual(await run('read', { file_path: join(home, 'memory', 'team', 'MEMORY.md') }, P), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: join(home, 'memory', 'team') }, P), { ran: true })
  assert.deepEqual(await run('subagent', { cwd: diary, prompt: 'work in my folder' }, P), { ran: true })
  const sub = parent => ({ id: 'sub1', session: { id: 'sub1', header: { cwd: team, parentSession: parent } } })
  const fromWriter = await run('read', { file_path: join(diary, 'notes.txt') }, 'b', sub('b'))
  assert.equal(fromWriter.ran, false)
  assert.match(fromWriter.error, CLOSED)
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, P, sub(P)), { ran: true })
})

test('what a private Bot sends to the others waits for the user', async (t) => {
  const approval = fakeApproval('allowed-once')
  const { run, stop } = await start({ services: { approval } })
  t.after(stop)
  assert.deepEqual(await run('message_bot', { to: 'Writer', message: 'My secret plan' }, P), { ran: true })
  assert.equal(approval.requests.length, 1)
  assert.equal(approval.requests[0].toolName, 'message_bot')
  assert.equal(approval.requests[0].privacy, true)
  assert.match(approval.requests[0].reason, /Diary[\s\S]*Writer[\s\S]*My secret plan/)
  assert.match(approval.requests[0].displayReason.zh, /My secret plan/)
  // The Bots that are not private send as before.
  await run('message_bot', { to: 'Chief', message: 'hi' }, 'b')
  assert.equal(approval.requests.length, 1)
  const content = 'secret step '.repeat(80)
  assert.deepEqual(await run('save_capability', { name: 'plan', kind: 'skill', content }, P), { ran: true })
  assert.equal(approval.requests.length, 2)
  assert.match(approval.requests[1].reason, /share this with the team/)
  assert.ok(approval.requests[1].reason.includes(content), 'the approval shows the whole skill, not a prefix')
  assert.deepEqual(await run('save_capability', { name: 'search', kind: 'mcp', command: 'secret-command', args: ['--private'] }, P), { ran: true })
  assert.equal(approval.requests.length, 3)
  assert.match(approval.requests[2].reason, /secret-command/)
  assert.match(approval.requests[2].reason, /--private/)
})

test('a message of a private Bot that the user does not allow is not sent', async (t) => {
  for (const outcome of ['rejected', 'cancelled']) {
    const { run, stop } = await start({ services: { approval: fakeApproval(outcome) } })
    t.after(stop)
    const result = await run('message_bot', { to: 'Writer', message: 'My secret plan' }, P)
    assert.equal(result.ran, false, outcome)
    assert.match(result.error, /not done/)
  }
  // With no way to ask, nothing goes either.
  const { run, stop } = await start()
  t.after(stop)
  const result = await run('message_bot', { to: 'Writer', message: 'x' }, P)
  assert.equal(result.ran, false)
  assert.match(result.error, /no way to ask/)
})

test('a private Bot changes files outside its folder only with the user\'s approval', async (t) => {
  const approval = fakeApproval('allowed-once')
  const { run, ctx, diary, project, stop } = await start({ services: { approval } })
  t.after(stop)
  assert.deepEqual(await run('write', { file_path: join(diary, 'today.txt'), content: 'x' }, P), { ran: true })
  assert.deepEqual(await run('write', { file_path: 'today.txt', content: 'x' }, P), { ran: true })
  assert.equal(approval.requests.length, 0)
  assert.deepEqual(await run('edit', { file_path: join(project, 'a.txt'), old_string: 'a', new_string: 'b' }, P), { ran: true })
  assert.equal(approval.requests.length, 1)
  assert.match(approval.requests[0].reason, /outside its own folder/)
  // A path that leaves the folder by `..` is outside it.
  assert.deepEqual(await run('write', { file_path: join(diary, '..', 'project', 'b.txt'), content: 'x' }, P), { ran: true })
  assert.equal(approval.requests.length, 2)
  // Reading is free.
  assert.deepEqual(await run('read', { file_path: join(project, 'a.txt') }, P), { ran: true })
  assert.equal(approval.requests.length, 2)
  // A subagent can have no cwd of its own; an absolute path still needs no TypeError.
  const getWorkspace = ctx.workspaceRegistry.get
  try {
    ctx.workspaceRegistry.get = () => undefined
    const noCwd = { id: 'sub-no-cwd', session: { id: 'sub-no-cwd', header: { parentSession: P } } }
    assert.deepEqual(await run('write', { file_path: join(diary, 'no-cwd.txt'), content: 'x' }, P, noCwd), { ran: true })
  } finally {
    ctx.workspaceRegistry.get = getWorkspace
  }
})

test('a write of a private Bot outside its folder that the user does not allow is not made', async (t) => {
  const { run, project, stop } = await start({ services: { approval: fakeApproval('rejected') } })
  t.after(stop)
  const result = await run('write', { file_path: join(project, 'a.txt'), content: 'x' }, P)
  assert.equal(result.ran, false)
  assert.match(result.error, /not done/)
})

test('one private Bot reads its own data but not another private Bot\'s', async (t) => {
  const { rt, run, dsh, home, diary, project, stop } = await start()
  t.after(stop)
  const other = await rt.createBot({ name: 'Other', workDir: project })
  await rt.updateBot(other.id, { private: true })
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, P), { ran: true })
  assert.deepEqual(await run('read', { file_path: join(home, 'memory', 'bots', P, 'MEMORY.md') }, P), { ran: true })
  assert.deepEqual(await run('read', { file_path: join(dsh, 'sessions', `${P}.jsonl`) }, P), { ran: true })
  assert.deepEqual(await run('session_search', { query: 'x', session_ids: [P] }, P), { ran: true })
  assert.deepEqual(await run('session_search', { query: 'x', session_ids: ['b'] }, P), { ran: true })
  const search = await run('session_search', { query: 'x' }, P)
  assert.equal(search.ran, false)
  assert.match(search.error, CLOSED)
  const otherSearch = await run('session_search', { query: 'x', session_ids: [other.id] }, P)
  assert.equal(otherSearch.ran, false)
  assert.match(otherSearch.error, CLOSED)
  const result = await run('read', { file_path: join(home, 'memory', 'bots', other.id, 'MEMORY.md') }, P)
  assert.equal(result.ran, false)
  assert.match(result.error, CLOSED)
  const folder = await run('read', { file_path: join(project, 'notes.txt') }, P)
  assert.equal(folder.ran, false)
  assert.match(folder.error, CLOSED)
})

test('a private Bot reads public memory and keeps its own journal out of the shared log', async (t) => {
  const { tool, run, home, stop } = await start()
  t.after(stop)
  await tool('bot_remember', { text: 'a public fact', scope: 'own' }, 'b')
  await tool('bot_remember', { text: 'a private fact', scope: 'own' }, P)
  const recalled = await tool('bot_recall', { scope: 'Writer', query: 'public fact' }, P)
  assert.match(recalled, /a public fact/)
  assert.match(await tool('bot_recall', { scope: 'Diary' }, 'a'), /That Bot is private/)
  const denied = await run('bot_recall', { scope: 'Diary' }, 'a')
  assert.equal(denied.ran, false)
  assert.match(denied.error, CLOSED)
  const shared = readFileSync(join(home, 'memory', 'journal.jsonl'), 'utf8')
  assert.match(shared, /a public fact/)
  assert.doesNotMatch(shared, /a private fact/)
  const own = readFileSync(join(home, 'memory', 'bots', P, 'journal.jsonl'), 'utf8')
  assert.match(own, /a private fact/)
})

test('a nested subagent speaks for the private Bot at its root', async (t) => {
  const approval = fakeApproval('allowed-once')
  const { run, diary, agentOf, stop } = await start({ services: { approval } })
  t.after(stop)
  agentOf('sub1').session.header.parentSession = P
  const nested = agentOf('sub2')
  nested.session.header.cwd = diary
  nested.session.header.parentSession = 'sub1'
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, P, nested), { ran: true })
  assert.deepEqual(await run('message_bot', { to: 'Writer', message: 'from a nested subagent' }, P, nested), { ran: true })
  assert.equal(approval.requests.length, 1)
  assert.match(approval.requests[0].reason, /from a nested subagent/)
  for (const id of ['sub1', 'sub2']) {
    const result = await run('session_trace', { session_id: id }, 'b')
    assert.equal(result.ran, false, id)
    assert.match(result.error, CLOSED)
  }
})

test('deleting a private Bot keeps its folder and archived memory closed', async (t) => {
  const { rt, run, home, diary, project, state, stop } = await start()
  t.after(stop)
  const memory = join(home, 'memory', 'bots', P)
  mkdirSync(memory, { recursive: true })
  writeFileSync(join(memory, 'MEMORY.md'), 'private memory')
  await rt.deleteBot(P)
  assert.equal(state().bots[P], undefined)
  const archived = state().privateArchives
  assert.equal(archived.length, 1)
  assert.equal(archived[0].id, P)
  assert.equal(typeof archived[0].archivePath, 'string')
  for (const [name, args] of [
    ['read', { file_path: join(diary, 'notes.txt') }],
    ['read', { file_path: join(archived[0].archivePath, 'MEMORY.md') }],
    ['glob', { pattern: '**/*', path: home }],
    ['session_trace', { session_id: P }],
  ]) {
    const result = await run(name, args, 'b')
    assert.equal(result.ran, false, name)
    assert.match(result.error, CLOSED)
  }
  await assert.rejects(rt.createBot({ name: 'Third', workDir: diary }), CLOSED)
  const third = await rt.createBot({ name: 'Third', workDir: project })
  await assert.rejects(rt.updateBot(third.id, { workDir: diary, private: true }), CLOSED)
})

test('the user lifts what a deleted private Bot left closed, one Bot at a time', async (t) => {
  const { rt, call, run, root, diary, state, stop } = await start()
  t.after(stop)
  const ledgerDir = join(root, 'ledger')
  mkdirSync(ledgerDir)
  writeFileSync(join(ledgerDir, 'books.txt'), 'secret')
  const ledger = await rt.createBot({ name: 'Ledger', workDir: ledgerDir })
  await rt.updateBot(ledger.id, { private: true })
  await rt.deleteBot(P)
  await rt.deleteBot(ledger.id)

  // The list names each place and keeps Session ids and the archive path on the host.
  const listed = (await call('state', {})).value.privateArchives
  assert.deepEqual(listed, [{ id: P, name: 'Diary', workDir: diary }, { id: ledger.id, name: 'Ledger', workDir: ledgerDir }])
  assert.equal((await run('read', { file_path: join(diary, 'notes.txt') }, 'b')).ran, false)
  await assert.rejects(rt.createBot({ name: 'Third', workDir: diary }), CLOSED)

  const lifted = await call('private-release', { id: P })
  assert.equal(lifted.ok, true)
  assert.deepEqual(lifted.value.privateArchives.map(entry => entry.id), [ledger.id])
  assert.deepEqual(state().privateArchives.map(entry => entry.id), [ledger.id])
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, 'b'), { ran: true })
  assert.deepEqual(await run('session_trace', { session_id: P }, 'b'), { ran: true })
  assert.equal((await rt.createBot({ name: 'Third', workDir: diary })).workDir, diary)

  // The other Bot's places stay closed.
  const kept = await run('read', { file_path: join(ledgerDir, 'books.txt') }, 'b')
  assert.equal(kept.ran, false)
  assert.match(kept.error, CLOSED)

  const again = await call('private-release', { id: P })
  assert.equal(again.ok, false)
  assert.match(again.error.message, /Nothing kept closed/)
})

test('the archived memory of a Bot whose protection is lifted opens; another archive stays closed', async (t) => {
  const { rt, ctx, call, run, home, root, project, state, stop } = await start()
  t.after(stop)
  // Ids shaped like real Session ids: a one-letter id would match any path.
  let created = 0
  ctx.sessionController.create = async () => ({ sessionId: `0000000${++created}-1111-4222-8333-444444444444` })
  const ledgerDir = join(root, 'ledger')
  mkdirSync(ledgerDir)
  const ledger = await rt.createBot({ name: 'Ledger', workDir: ledgerDir })
  await rt.updateBot(ledger.id, { private: true })
  const scratch = await rt.createBot({ name: 'Scratch', workDir: project })
  const reader = (await rt.createBot({ name: 'Reader' })).id
  for (const id of [P, ledger.id, scratch.id]) {
    mkdirSync(join(home, 'memory', 'bots', id), { recursive: true })
    writeFileSync(join(home, 'memory', 'bots', id, 'MEMORY.md'), `memory of ${id}`)
  }
  await rt.deleteBot(P)
  await rt.deleteBot(ledger.id)
  await rt.deleteBot(scratch.id)
  const archives = Object.fromEntries(state().privateArchives.map(entry => [entry.id, entry.archivePath]))
  const memoryOf = id => ({ file_path: join(archives[id], 'MEMORY.md') })
  const archiveRoot = join(home, 'memory', 'archive')
  const scratchRead = { file_path: join(archiveRoot, readdirSync(archiveRoot).find(name => name.startsWith(scratch.id)), 'MEMORY.md') }

  // While both are kept, neither archive is read; the archive of a Bot that was never private is.
  for (const id of [P, ledger.id]) {
    const result = await run('read', memoryOf(id), reader)
    assert.equal(result.ran, false, id)
    assert.match(result.error, CLOSED)
  }
  assert.deepEqual(await run('read', scratchRead, reader), { ran: true })

  await call('private-release', { id: P })
  assert.deepEqual(await run('read', memoryOf(P), reader), { ran: true })
  const kept = await run('read', memoryOf(ledger.id), reader)
  assert.equal(kept.ran, false)
  assert.match(kept.error, /Ledger/)
  // A walk of the archive folder would reach the kept one, so it stays closed.
  assert.equal((await run('glob', { pattern: '**/*', path: archiveRoot }, reader)).ran, false)

  await call('private-release', { id: ledger.id })
  assert.deepEqual(await run('read', memoryOf(ledger.id), reader), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: archiveRoot }, reader), { ran: true })
})

test('an archive whose log row could not be written is still kept closed to a walk', async (t) => {
  const { rt, ctx, run, home, root, state, stop } = await start({ privateBot: false })
  t.after(stop)
  let created = 0
  ctx.sessionController.create = async () => ({ sessionId: `0000000${++created}-1111-4222-8333-444444444444` })
  const ledgerDir = join(root, 'ledger')
  mkdirSync(ledgerDir)
  const ledger = await rt.createBot({ name: 'Ledger', workDir: ledgerDir })
  await rt.updateBot(ledger.id, { private: true })
  const reader = (await rt.createBot({ name: 'Reader' })).id
  mkdirSync(join(home, 'memory', 'bots', ledger.id), { recursive: true })
  writeFileSync(join(home, 'memory', 'bots', ledger.id, 'MEMORY.md'), 'books')
  // A change log that cannot be read stops the archive's row, after the memory has moved.
  mkdirSync(join(home, 'memory', 'journal.jsonl'), { recursive: true })
  await rt.deleteBot(ledger.id)

  const archiveRoot = join(home, 'memory', 'archive')
  const [entry] = state().privateArchives
  assert.ok(entry.archivePath?.startsWith(archiveRoot), 'the path of the archive is kept')
  assert.equal(entry.archiving, undefined)
  assert.equal(readFileSync(join(entry.archivePath, 'MEMORY.md'), 'utf8'), 'books')
  const read = await run('read', { file_path: join(entry.archivePath, 'MEMORY.md') }, reader)
  assert.equal(read.ran, false)
  assert.match(read.error, /Ledger/)
  assert.equal((await run('glob', { pattern: '**/*', path: archiveRoot }, reader)).ran, false)
  assert.equal((await run('grep', { pattern: 'books', path: archiveRoot }, reader)).ran, false)
})

test('a walk of the archive stays closed while a private Bot\'s memory is still on its way there', async (t) => {
  const GHOST = 'e2b60000-1111-4222-8333-444444444444'
  const { call, run, home, stop } = await start({ privateBot: false, archives: [{ id: GHOST, name: 'Ghost', sessionIds: [], archiving: true }] })
  t.after(stop)
  const archiveRoot = join(home, 'memory', 'archive')
  mkdirSync(join(archiveRoot, `${GHOST}-2026-10-28`), { recursive: true })
  writeFileSync(join(archiveRoot, `${GHOST}-2026-10-28`, 'MEMORY.md'), 'ghost')

  const walk = await run('glob', { pattern: '**/*', path: archiveRoot }, 'b')
  assert.equal(walk.ran, false)
  assert.match(walk.error, /Ghost/)
  // Once the user lifts the protection there is nothing left to hide.
  assert.equal((await call('private-release', { id: GHOST })).ok, true)
  assert.deepEqual(await run('glob', { pattern: '**/*', path: archiveRoot }, 'b'), { ran: true })
})

test('a kept Bot whose memory never moved does not close the archive folder', async (t) => {
  const GHOST = 'e2b60000-1111-4222-8333-444444444444'
  const { run, home, stop } = await start({ privateBot: false, archives: [{ id: GHOST, name: 'Ghost', sessionIds: [] }] })
  t.after(stop)
  const archiveRoot = join(home, 'memory', 'archive')
  mkdirSync(archiveRoot, { recursive: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: archiveRoot }, 'b'), { ran: true })
})

test('another Bot cannot glob or read a private OCR spill that names the Session in its path', async (t) => {
  const { run, diary, stop } = await start()
  t.after(stop)
  const spill = join(diary, '.ocr', P, P, 'scan.ocr.txt')
  mkdirSync(join(diary, '.ocr', P, P), { recursive: true })
  writeFileSync(spill, 'private ocr text')
  const otherRead = await run('read', { file_path: spill }, 'b')
  assert.equal(otherRead.ran, false)
  assert.match(otherRead.error, CLOSED)
  const otherGlob = await run('glob', { pattern: '**/*.ocr.txt', path: diary }, 'b')
  assert.equal(otherGlob.ran, false)
  assert.match(otherGlob.error, CLOSED)
  assert.deepEqual(await run('read', { file_path: spill }, P), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*.ocr.txt', path: diary }, P), { ran: true })
})

test('with no private Bot the tools run as they did', async (t) => {
  const { run, diary, stop } = await start({ privateBot: false })
  t.after(stop)
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, 'b'), { ran: true })
  assert.deepEqual(await run('message_bot', { to: 'Diary', message: 'hi' }, 'a'), { ran: true })
  assert.equal((await run('glob', { pattern: '*', path: join(diary, '..') }, 'b')).ran, false)
})

test('temporary secret files and secret-refs are isolated per Bot even when no Bot is marked private', async (t) => {
  const { rt, run, home, stop } = await start({ privateBot: false })
  t.after(stop)
  const posix = path => path.replace(/\\/g, '/')

  // Bot A gets a delivery='file' secret file AND a Shell File Mode file; Bot B is a regular (non-private) Bot.
  const secretVal = 'cross-bot-secret-value-123456'
  const writtenA = await rt.secrets.writeSecretFile({ botId: 'a', sessionId: 'a', name: 'DEPLOY_KEY', value: secretVal })
  const writtenB = await rt.secrets.writeSecretFile({ botId: 'b', sessionId: 'b', name: 'OWN_KEY', value: 'bot-b-secret-value-123456' })
  const shellFileA = join(home, 'secret-files', 'a', 'env-deadbeef01234567-abcdef012345-1.secret')
  writeFileSync(shellFileA, 'bot-a-scoped-shell-secret-123456')
  const refA = await rt.secrets.issueRef({ botId: 'a', sessionId: 'a', requestId: 'req-iso', field: 'TOKEN', value: 'one-time-ref-secret-123456' })
  const refFileA = join(home, 'secret-refs', `${refA.slice('secret-ref:'.length)}.json`)
  const opDir = join(home, 'secret-files', '_op')
  mkdirSync(opDir, { recursive: true, mode: 0o700 })
  const opTpl = join(opDir, 'dsbot-op-1-abc.tpl')
  writeFileSync(opTpl, '{{ op://Vault/Item/field }}')

  // Bot A can read its own delivery='file' and Shell File Mode secret files via read and bash,
  // and can reference $DSH_SECRET_FILE_* normally.
  assert.deepEqual(await run('read', { file_path: writtenA.filePath }, 'a'), { ran: true })
  assert.deepEqual(await run('read', { file_path: shellFileA }, 'a'), { ran: true })
  assert.deepEqual(await run('bash', { command: `cat "${posix(writtenA.filePath)}"` }, 'a'), { ran: true })
  assert.deepEqual(await run('bash', { command: `cat "${posix(shellFileA)}"` }, 'a'), { ran: true })
  assert.deepEqual(await run('bash', { command: 'cat "$DSH_SECRET_FILE_DEPLOY_KEY"' }, 'a'), { ran: true })
  assert.deepEqual(await run('read', { file_path: writtenB.filePath }, 'b'), { ran: true })
  assert.deepEqual(await run('bash', { command: `cat "${posix(writtenB.filePath)}"` }, 'b'), { ran: true })

  // Bot B (ordinary non-private Bot) is strictly blocked from reading Bot A's files,
  // listing secret-files root, reading _op templates, or touching secret-refs.
  const blockedForB = [
    ['read', { file_path: writtenA.filePath }],
    ['read', { file_path: shellFileA }],
    ['read', { file_path: opTpl }],
    ['read', { file_path: refFileA }],
    ['write', { file_path: writtenB.filePath, content: 'tamper' }],
    ['glob', { pattern: '**/*', path: join(home, 'secret-files') }],
    ['glob', { pattern: '**/*', path: join(home, 'secret-files', 'a') }],
    ['glob', { pattern: '**/*', path: opDir }],
    ['glob', { pattern: '**/*', path: join(home, 'secret-refs') }],
    ['grep', { pattern: 'secret', path: join(home, 'secret-files') }],
    ['working_directory', { cd: join(home, 'secret-files') }],
    ['working_directory', { cd: join(home, 'secret-files', 'a') }],
    ['working_directory', { cd: join(home, 'secret-refs') }],
    ['bash', { command: `cat "${posix(writtenA.filePath)}"` }],
    ['bash', { command: `cat "${posix(shellFileA)}"` }],
    ['pwsh', { command: `Get-Content '${writtenA.filePath}'` }],
    ['bash', { command: `ls "${posix(join(home, 'secret-files'))}"` }],
    ['bash', { command: `ls "${posix(join(home, 'secret-files'))}/"` }],
    ['bash', { command: `cat "${posix(join(home, 'secret-files', 'b'))}/../a/sf-x.secret"` }],
    ['bash', { command: `cat "${posix(join(home, 'secret-files'))}/*/sf-*.secret"` }],
    ['bash', { command: `cat "${posix(opTpl)}"` }],
    ['bash', { command: `cat "${posix(refFileA)}"` }],
    ['bash', { command: `ls "${posix(join(home, 'secret-refs'))}"` }],
    ['bash', { command: 'ls ../secret-files' }],
    ['bash', { command: 'ls ../secret-refs' }],
    ['bash', { command: 'ls', workdir: join(home, 'secret-files', 'a') }],
    ['bash', { command: 'ls "$(dirname "$DSH_SECRET_FILE_OWN_KEY")/.."' }],
  ]
  for (const [toolName, args] of blockedForB) {
    const res = await run(toolName, args, 'b')
    assert.equal(res.ran, false, `expected blocked for b: ${toolName} ${JSON.stringify(args)}`)
    assert.match(res.error, /secret/i)
  }

  // Bot A is ALSO blocked from accessing secret-refs, _op, or listing secret-files root.
  for (const [toolName, args] of [
    ['read', { file_path: refFileA }],
    ['read', { file_path: opTpl }],
    ['bash', { command: `ls "${posix(join(home, 'secret-files'))}"` }],
    ['bash', { command: `cat "${posix(opTpl)}"` }],
    ['bash', { command: `cat "${posix(refFileA)}"` }],
  ]) {
    const res = await run(toolName, args, 'a')
    assert.equal(res.ran, false, `expected blocked for a: ${toolName} ${JSON.stringify(args)}`)
    assert.match(res.error, /secret/i)
  }
})

test('guardSecretFiles allows text searches for secret-refs/secret-files in unrelated workspaces while blocking path operands and traversals', async (t) => {
  const { run, home, root, stop } = await start({ privateBot: false })
  t.after(stop)
  const posix = path => path.replace(/\\/g, '/')
  const repoDir = join(root, 'unrelated-repo')
  mkdirSync(join(repoDir, 'docs'), { recursive: true })
  writeFileSync(join(repoDir, 'README.md'), 'secret-refs and secret-files documentation\n')
  const workspaceDir = join(home, 'workspace')
  mkdirSync(workspaceDir, { recursive: true })

  // Content searches in unrelated workspaces must NOT be blocked.
  for (const [toolName, args] of [
    ['grep', { pattern: 'secret-refs', path: repoDir }],
    ['grep', { pattern: 'secret-files/_op', path: repoDir }],
    ['glob', { pattern: '**/*secret-refs*', path: repoDir }],
    ['glob', { pattern: 'src/host/secret-refs.js', path: repoDir }],
    ['bash', { command: "grep 'secret-refs' README.md", workdir: repoDir }],
    ['bash', { command: 'rg "secret-refs" docs/', workdir: repoDir }],
    ['bash', { command: "grep -rn 'secret-files' README.md", workdir: repoDir }],
    ['bash', { command: "grep -e 'secret-refs' README.md", workdir: repoDir }],
    ['bash', { command: "grep --regexp='secret-refs' README.md", workdir: repoDir }],
    ['bash', { command: "git grep 'secret-refs'", workdir: repoDir }],
    ['pwsh', { command: "Select-String -Pattern 'secret-refs' README.md", workdir: repoDir }],
    ['pwsh', { command: 'Split-Path -Leaf $env:DSH_SECRET_FILE_DEPLOY_KEY', workdir: repoDir }],
    ['pwsh', { command: 'Split-Path -LeafBase -Path $env:DSH_SECRET_FILE_DEPLOY_KEY', workdir: repoDir }],
  ]) {
    assert.deepEqual(await run(toolName, args, 'b'), { ran: true }, `expected allowed: ${toolName} ${JSON.stringify(args)}`)
  }

  // Path operands, traversals, redirections, command substitutions, and home-overlapping cwd remain strictly blocked.
  for (const [toolName, args] of [
    ['grep', { pattern: 'token', path: workspaceDir, glob: '../secret-refs/*.json' }],
    ['glob', { pattern: '../secret-refs/*', path: workspaceDir }],
    ['glob', { pattern: '*/../secret-refs/*', path: workspaceDir }],
    ['glob', { pattern: `${posix(home)}/secret-refs/*`, path: repoDir }],
    ['bash', { command: 'grep foo ../secret-refs/x', workdir: repoDir }],
    ['bash', { command: `grep foo "${posix(join(home, 'secret-refs'))}"`, workdir: repoDir }],
    ['bash', { command: "grep 'secret-refs' ../secret-refs/x", workdir: repoDir }],
    ['bash', { command: "grep -f ../secret-refs/x README.md", workdir: repoDir }],
    ['bash', { command: "grep 'secret-refs' < ../secret-refs/x", workdir: repoDir }],
    ['bash', { command: 'grep "$(cat ../secret-refs/x)" README.md', workdir: repoDir }],
    ['bash', { command: "grep 'secret-refs' README.md; ls ../secret-refs", workdir: repoDir }],
    ['bash', { command: "grep 'secret-refs' .", workdir: home }],
    ['bash', { command: 'ls "$(dirname "$DSH_SECRET_FILE_OWN_KEY")/.."', workdir: repoDir }],
    ['bash', { command: 'ls "$(DIRNAME "$DSH_SECRET_FILE_OWN_KEY")/.."', workdir: repoDir }],
    ['pwsh', { command: 'Split-Path $env:DSH_SECRET_FILE_DEPLOY_KEY', workdir: repoDir }],
    ['pwsh', { command: 'Split-Path -Parent $env:DSH_SECRET_FILE_DEPLOY_KEY', workdir: repoDir }],
    ['pwsh', { command: 'Split-Path -Leaf -Parent $env:DSH_SECRET_FILE_DEPLOY_KEY', workdir: repoDir }],
    ['pwsh', { command: 'Split-Path -Leaf "$env:DSH_SECRET_FILE_DEPLOY_KEY/.."', workdir: repoDir }],
    ['pwsh', { command: 'Split-Path $env:DSH_SECRET_FILE_DEPLOY_KEY > -Leaf', workdir: repoDir }],
    ['pwsh', { command: "Split-Path '-Leaf' $env:DSH_SECRET_FILE_DEPLOY_KEY", workdir: repoDir }],
    ['pwsh', { command: 'Split-Path -Path -Leaf $env:DSH_SECRET_FILE_DEPLOY_KEY', workdir: repoDir }],
    ['pwsh', { command: 'Split-Path -- -Leaf $env:DSH_SECRET_FILE_DEPLOY_KEY', workdir: repoDir }],
    ['pwsh', { command: 'Split-Path $env:DSH_SECRET_FILE_DEPLOY_KEY # -Leaf', workdir: repoDir }],
    ['pwsh', { command: "Split-Path $env:DSH_SECRET_FILE_DEPLOY_KEY #'x' -Leaf", workdir: repoDir }],
    ['pwsh', { command: 'Split-Path $env:DSH_SECRET_FILE_DEPLOY_KEY <# -Leaf #>', workdir: repoDir }],
    ['pwsh', { command: "Split-Path $env:DSH_SECRET_FILE_DEPLOY_KEY <#'x' -Leaf #>", workdir: repoDir }],
  ]) {
    const res = await run(toolName, args, 'b')
    assert.equal(res.ran, false, `expected blocked: ${toolName} ${JSON.stringify(args)}`)
    assert.match(res.error, /secret/i)
  }
})

test('guardSecretFiles preserves isolation when secret-files is symlinked outside home', { skip: process.platform === 'win32' }, async (t) => {
  const { run, home, root, stop } = await start({ privateBot: false })
  t.after(stop)
  const externalStore = join(root, 'external-secret-files')
  const externalRefs = join(root, 'external-vault')
  const siblingFiles = join(root, 'external-secret-files-tools')
  const siblingRefs = join(root, 'external-vault-tools')
  mkdirSync(join(externalStore, 'a'), { recursive: true })
  mkdirSync(externalRefs, { recursive: true })
  mkdirSync(siblingFiles, { recursive: true })
  mkdirSync(siblingRefs, { recursive: true })
  const secretA = join(externalStore, 'a', 'sf-linked.secret')
  writeFileSync(secretA, 'linked-bot-a-secret-123456')
  symlinkSync(externalStore, join(home, 'secret-files'))
  symlinkSync(externalRefs, join(home, 'secret-refs'))

  // Sibling directories sharing a prefix with symlinked secret storage must NOT be blocked.
  assert.deepEqual(await run('bash', { command: 'pwd', workdir: siblingFiles }, 'b'), { ran: true })
  assert.deepEqual(await run('bash', { command: 'pwd', workdir: siblingRefs }, 'b'), { ran: true })

  // Bot A can read its own file via either symlink or real target; Bot B is blocked on both,
  // including PowerShell comma path lists and shell wildcard/brace/variable expansions.
  assert.deepEqual(await run('read', { file_path: secretA }, 'a'), { ran: true })
  for (const [toolName, args] of [
    ['read', { file_path: secretA }],
    ['bash', { command: `cat "${secretA}"` }],
    ['bash', { command: `ls "${externalRefs}"` }],
    ['bash', { command: `cat ${externalRefs}*/*.json` }],
    ['bash', { command: `ls ${externalRefs}{,/}` }],
    ['bash', { command: `ls ${externalRefs}$x` }],
    ['bash', { command: `cat ${externalStore}*/a/sf-linked.secret` }],
    ['pwsh', { command: `Get-ChildItem ${externalRefs},${siblingRefs}` }],
    ['pwsh', { command: `Get-ChildItem ${externalStore},${siblingFiles}` }],
  ]) {
    const blocked = await run(toolName, args, 'b')
    assert.equal(blocked.ran, false, `expected blocked: ${toolName} ${JSON.stringify(args)}`)
    assert.match(blocked.error, /secret/i)
  }
})

test('telemetry consent file stays protected from Bots even when no Bot is private', async (t) => {
  const { run, home, project, agentOf, stop } = await start({ privateBot: false })
  t.after(stop)
  const telFile = join(home, 'telemetry.json')
  writeFileSync(telFile, JSON.stringify({ noticeAccepted: false, usage: false, errors: false }))
  for (const [toolName, args] of [
    ['read', { file_path: telFile }],
    ['write', { file_path: telFile, content: '{"noticeAccepted":true,"usage":true}' }],
    ['write', { file_path: `${telFile}.tmp`, content: '{}' }],
    ['edit', { file_path: telFile, old_string: 'false', new_string: 'true' }],
    ['grep', { pattern: 'telemetry.json', path: home }],
    ['glob', { pattern: '*', path: home }],
    ['bash', { command: `cat "${telFile}"` }],
    ['bash', { command: 'cat ../telemetry.json' }],
  ]) {
    const res = await run(toolName, args, 'b')
    assert.equal(res.ran, false, `${toolName} must not access telemetry.json`)
    assert.match(res.error, /telemetry consent/)
  }
  // Searching an unrelated workspace for references to `telemetry.json` stays allowed.
  const agent = agentOf('b')
  agent.session.header.cwd = project
  assert.deepEqual(await run('grep', { pattern: 'telemetry.json', path: project }, 'b', agent), { ran: true })
  assert.deepEqual(await run('bash', { command: 'rg telemetry.json src/' }, 'b', agent), { ran: true })
  // Direct host path in bash is still blocked even from an unrelated cwd.
  assert.equal((await run('bash', { command: `cat "${telFile}"` }, 'b', agent)).ran, false)
})

test('apply_patch enforces private Bot, shared-state, API, secret fences and private outbound approval', async (t) => {
  const approval = fakeApproval('allowed-once')
  const { rt, run, home, diary, team, project, agentOf, stop } = await start({ services: { approval } })
  t.after(stop)
  const notes = join(diary, 'notes.txt')
  const addPatch = path => `*** Begin Patch\n*** Add File: ${path}\n+hello\n*** End Patch`
  const updatePatch = path => `*** Begin Patch\n*** Update File: ${path}\n@@\n-secret\n+leaked\n*** End Patch`
  const deletePatch = path => `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`
  const movePatch = (from, to) => `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-a\n+b\n*** End Patch`

  // Non-private Bot cannot add, update, delete, or move into/out of a private Bot's folder or shared state.
  for (const input of [
    addPatch(join(diary, 'injected.txt')),
    updatePatch(notes),
    deletePatch(notes),
    movePatch(join(team, 'open.txt'), join(diary, 'moved.txt')),
    movePatch(notes, join(team, 'stolen.txt')),
    updatePatch(relative(team, notes)),
    addPatch(join(home, 'memory', 'bots', P, 'MEMORY.md')),
    updatePatch(join(home, 'state.json')),
    updatePatch(join(home, 'secrets.json')),
    deletePatch(join(home, 'chat-index.sqlite')),
  ]) {
    const res = await run('apply_patch', { input }, 'b')
    assert.equal(res.ran, false, `expected private block for:\n${input}`)
    assert.match(res.error, CLOSED)
  }

  // Symlink into private Bot's folder is also blocked for apply_patch.
  if (process.platform !== 'win32') {
    symlinkSync(diary, join(project, 'patch-link'))
    const viaLink = await run('apply_patch', { input: addPatch(join(project, 'patch-link', 'via-link.txt')) }, 'b')
    assert.equal(viaLink.ran, false)
    assert.match(viaLink.error, CLOSED)
  }

  // API, telemetry, and secret storage files are blocked for apply_patch.
  for (const file of [join(home, 'api-tokens.json'), join(home, 'mcp.json'), join(home, 'telemetry.json')]) {
    const res = await run('apply_patch', { input: addPatch(file) }, 'b')
    assert.equal(res.ran, false, `expected API/telemetry block for ${file}`)
    assert.match(res.error, /API token|telemetry|private Bot/)
  }
  for (const file of [join(home, 'secret-refs', 'ref.json'), join(home, 'secret-files', 'a', 'k.secret'), join(home, 'secret-files', 'b', 'own.secret')]) {
    const res = await run('apply_patch', { input: addPatch(file) }, 'b')
    assert.equal(res.ran, false, `expected secret block for ${file}`)
    assert.match(res.error, /secret|private Bot/i)
  }

  // Normal open files stay allowed for non-private Bots.
  assert.deepEqual(await run('apply_patch', { input: addPatch(join(team, 'ok.txt')) }, 'b'), { ran: true })
  assert.deepEqual(await run('apply_patch', { input: movePatch(join(project, 'a.txt'), join(project, 'b.txt')) }, 'b'), { ran: true })
  // Valid apply_patch whose hunk context mentions an example "*** Update File:" header for a private path must not false-positive.
  const patchWithHeaderInContext = [
    '*** Begin Patch',
    `*** Update File: ${join(project, 'doc.md')}`,
    '@@',
    ` *** Update File: ${notes}`,
    '-old line',
    '+new line',
    '*** End Patch',
  ].join('\n')
  assert.deepEqual(await run('apply_patch', { input: patchWithHeaderInContext }, 'b'), { ran: true })

  // Private Bot can apply_patch inside its own folder without approval.
  assert.deepEqual(await run('apply_patch', { input: addPatch(join(diary, 'inside.txt')) }, P), { ran: true })
  assert.deepEqual(await run('apply_patch', { input: movePatch('notes.txt', 'notes2.txt') }, P), { ran: true })
  assert.equal(approval.requests.length, 0)

  // Private Bot changing or moving files outside its folder requires user approval.
  assert.deepEqual(await run('apply_patch', { input: addPatch(join(project, 'out.txt')) }, P), { ran: true })
  assert.equal(approval.requests.length, 1)
  assert.match(approval.requests[0].reason, /outside its own folder/)
  assert.deepEqual(await run('apply_patch', { input: movePatch('notes.txt', join(project, 'exported.txt')) }, P), { ran: true })
  assert.equal(approval.requests.length, 2)

  // TOCTOU: if effective cwd changes during approval, apply_patch must fail closed.
  const privateAgent = agentOf(P)
  privateAgent.session.header.cwd = project
  rt.requestActionApproval = async () => { privateAgent.session.header.cwd = team; return 'allowed-once' }
  const shifted = await run('apply_patch', { input: addPatch('rel.txt') }, P, privateAgent)
  assert.equal(shifted.ran, false)
  assert.match(shifted.error, /destination changed/)
})

test('run_code enforces private Bot, shared-state, API, secret fences and private Bot escalation approval', async (t) => {
  const approval = fakeApproval('allowed-once')
  let standingMode = 'workspace-write'
  const { run, home, diary, team, project, agentOf, stop } = await start({
    services: {
      approval,
      sandboxPolicy: { resolve: () => ({ mode: standingMode }) },
    },
  })
  t.after(stop)
  const notes = join(diary, 'notes.txt')
  const posix = path => path.replace(/\\/g, '/')
  const writerAgent = agentOf('b')
  writerAgent.session.header.cwd = project

  // Non-private Bot cannot reference private Bot files, relative traversals, symlinks, memory, or shared files in run_code.
  for (const code of [
    `const fs = await import('node:fs'); return fs.readFileSync(${JSON.stringify(notes)}, 'utf8')`,
    `const fs = await import('node:fs'); return fs.readFileSync('${posix(notes)}', 'utf8')`,
    `const fs = await import('node:fs'); return fs.readFileSync('../diary/notes.txt', 'utf8')`,
    `return ${JSON.stringify(join(home, 'memory', 'bots', P, 'MEMORY.md'))}`,
    `return '${notes.replace(/[\\/]/g, '\\\\')}'`,
    `return '${P}'`,
    `const fs = await import('node:fs'); return fs.readFileSync(${JSON.stringify(join(home, 'state.json'))}, 'utf8')`,
    `const fs = await import('node:fs'); return fs.readFileSync(${JSON.stringify(join(home, 'chat-index.sqlite'))}, 'utf8')`,
  ]) {
    const res = await run('run_code', { code, description: 'Read file' }, 'b', writerAgent)
    assert.equal(res.ran, false, `expected private block for run_code: ${code}`)
    assert.match(res.error, CLOSED)
  }

  // Non-private Bot cannot directly import or invoke raw host filesystem/process escape modules in run_code when private Bots exist.
  for (const code of [
    "const fs = await import('node:fs'); return fs.readFileSync(['.', 'x'].join('/'), 'utf8')",
    "const fs = await import('fs'); return fs.readdirSync('.')",
    "const fsp = await import('node:fs/promises'); return await fsp.readdir('.')",
    "import cp from 'node:child_process'; return cp.execSync('pwd')",
    "const cp = require('child_process'); return cp.execSync('pwd')",
    "return process.binding('fs')",
    "return process.dlopen({}, 'x')",
    "return process.getBuiltinModule('node:fs')",
    "return `${await import('node:fs')}`",
  ]) {
    const res = await run('run_code', { code, description: 'Direct host module' }, 'b', writerAgent)
    assert.equal(res.ran, false, `expected direct host module block for run_code: ${code}`)
    assert.match(res.error, CLOSED)
  }

  if (process.platform !== 'win32') {
    symlinkSync(diary, join(project, 'code-link'))
    const viaLink = await run('run_code', { code: "return fs.readFileSync('code-link/notes.txt', 'utf8')", description: 'Read link' }, 'b', writerAgent)
    assert.equal(viaLink.ran, false)
    assert.match(viaLink.error, CLOSED)
  }

  // API, telemetry, and secret storage references are blocked in run_code (including Windows double-backslash paths and relative traversals).
  for (const code of [
    `return fs.readFileSync(${JSON.stringify(join(home, 'api-tokens.json'))}, 'utf8')`,
    `return '${join(home, 'api-tokens.json').replace(/[\\/]/g, '\\\\')}'`,
    `return fs.readFileSync(${JSON.stringify(join(home, 'mcp.json'))}, 'utf8')`,
    `return fs.readFileSync(${JSON.stringify(join(home, 'telemetry.json'))}, 'utf8')`,
  ]) {
    const res = await run('run_code', { code, description: 'Read api' }, 'b', writerAgent)
    assert.equal(res.ran, false)
    assert.match(res.error, /API token|telemetry|private Bot/)
  }
  for (const code of [
    `return fs.readFileSync(${JSON.stringify(join(home, 'secret-refs', 'ref.json'))}, 'utf8')`,
    `return '${join(home, 'secret-refs', 'ref.json').replace(/[\\/]/g, '\\\\')}'`,
    `return fs.readFileSync(${JSON.stringify(join(home, 'secret-files', 'a', 'k.secret'))}, 'utf8')`,
    `return '${join(home, 'secret-files', 'a', 'k.secret').replace(/[\\/]/g, '\\\\')}'`,
  ]) {
    const res = await run('run_code', { code, description: 'Read secret' }, 'b', writerAgent)
    assert.equal(res.ran, false)
    assert.match(res.error, /secret|private Bot/i)
  }

  // Normal open code in run_code stays allowed for non-private Bots, including workspace files named api-*/mcp.json
  // and writing JS source strings that mention node:fs via tools.write.
  for (const cwd of [project, team]) {
    writerAgent.session.header.cwd = cwd
    assert.deepEqual(await run('run_code', { code: "return await tools.read({ file_path: 'src/index.js' })", description: 'Read open file' }, 'b', writerAgent), { ran: true })
    assert.deepEqual(await run('run_code', { code: "return await tools.read({ file_path: 'src/api-client.ts' })", description: 'Read workspace api client' }, 'b', writerAgent), { ran: true })
    assert.deepEqual(await run('run_code', { code: "return await tools.read({ file_path: 'docs/api-routes.md' })", description: 'Read workspace api docs' }, 'b', writerAgent), { ran: true })
    assert.deepEqual(await run('run_code', { code: "return await tools.read({ file_path: 'config/mcp.json' })", description: 'Read workspace mcp config' }, 'b', writerAgent), { ran: true })
    assert.deepEqual(await run('run_code', { code: 'return await tools.write({ file_path: "src/helper.js", content: "import fs from \'node:fs\'\\nexport default fs\\n" })', description: 'Write JS file via tool' }, 'b', writerAgent), { ran: true })
  }
  // Relative traversal from team workspace (<home>/workspace) up to rt.home API/MCP/telemetry files stays blocked.
  writerAgent.session.header.cwd = team
  for (const rel of ['../api-tokens.json', '../mcp.json', '../telemetry.json']) {
    const res = await run('run_code', { code: `return await tools.read({ file_path: '${rel}' })`, description: 'Traverse to host api file' }, 'b', writerAgent)
    assert.equal(res.ran, false, `expected block for ${rel}`)
    assert.match(res.error, /API token|telemetry|private Bot/)
  }
  // Bare API/MCP filenames when cwd is rt.home itself stay blocked.
  writerAgent.session.header.cwd = home
  for (const bare of ['api-tokens.json', 'mcp.json', 'telemetry.json']) {
    const res = await run('run_code', { code: `return await tools.read({ file_path: '${bare}' })`, description: 'Bare host api file' }, 'b', writerAgent)
    assert.equal(res.ran, false, `expected block for bare ${bare} in home`)
    assert.match(res.error, /API token|telemetry|private Bot/)
  }
  writerAgent.session.header.cwd = project

  // Private Bot inside its own folder under workspace-write runs without extra approval.
  const privateAgent = agentOf(P)
  privateAgent.session.header.cwd = diary
  assert.deepEqual(await run('run_code', { code: 'return 1 + 1', description: 'Compute locally' }, P, privateAgent), { ran: true })
  assert.equal(approval.requests.length, 0)

  // Private Bot requesting danger-full-access requires user approval.
  assert.deepEqual(await run('run_code', { code: 'return 1', description: 'Escalate', sandbox_permissions: 'danger-full-access', justification: 'test' }, P, privateAgent), { ran: true })
  assert.equal(approval.requests.length, 1)
  assert.match(approval.requests[0].reason, /outside its own folder fence/)

  // Private Bot with standing danger-full-access requires user approval.
  standingMode = 'danger-full-access'
  assert.deepEqual(await run('run_code', { code: 'return 1', description: 'Standing full' }, P, privateAgent), { ran: true })
  assert.equal(approval.requests.length, 2)
  standingMode = 'workspace-write'

  // Private Bot with cwd outside its own folder requires user approval.
  privateAgent.session.header.cwd = team
  assert.deepEqual(await run('run_code', { code: 'return 1', description: 'Outside cwd' }, P, privateAgent), { ran: true })
  assert.equal(approval.requests.length, 3)
})

test('run_code allows workspace api-*/mcp.json files while guardApiFiles still blocks rt.home API/MCP/telemetry files', async (t) => {
  const { run, home, team, project, agentOf, stop } = await start({ privateBot: false })
  t.after(stop)
  const agent = agentOf('b')
  for (const cwd of [project, team]) {
    agent.session.header.cwd = cwd
    for (const file of ['src/api-client.ts', 'docs/api-routes.md', 'config/mcp.json']) {
      assert.deepEqual(await run('run_code', { code: `return await tools.read({ file_path: '${file}' })`, description: 'Read workspace file' }, 'b', agent), { ran: true })
    }
  }
  // Host-owned API/MCP/telemetry files under rt.home remain blocked via absolute, Windows-escaped, relative traversal, and home-cwd paths.
  agent.session.header.cwd = project
  for (const code of [
    `return await tools.read({ file_path: ${JSON.stringify(join(home, 'api-tokens.json'))} })`,
    `return '${join(home, 'api-tokens.json').replace(/[\\/]/g, '\\\\')}'`,
    `return await tools.read({ file_path: ${JSON.stringify(join(home, 'mcp.json'))} })`,
    `return await tools.read({ file_path: ${JSON.stringify(join(home, 'telemetry.json'))} })`,
  ]) {
    const res = await run('run_code', { code, description: 'Read host api file' }, 'b', agent)
    assert.equal(res.ran, false, `expected guardApiFiles block for: ${code}`)
    assert.match(res.error, /API token|telemetry/)
  }
  agent.session.header.cwd = team
  for (const rel of ['../api-tokens.json', '../mcp.json', '../telemetry.json']) {
    const res = await run('run_code', { code: `return await tools.read({ file_path: '${rel}' })`, description: 'Traverse to host api file' }, 'b', agent)
    assert.equal(res.ran, false, `expected guardApiFiles block for: ${rel}`)
    assert.match(res.error, /API token|telemetry/)
  }
  agent.session.header.cwd = home
  for (const bare of ['api-tokens.json', 'mcp.json', 'telemetry.json']) {
    const res = await run('run_code', { code: `return await tools.read({ file_path: '${bare}' })`, description: 'Bare host api file' }, 'b', agent)
    assert.equal(res.ran, false, `expected guardApiFiles block for bare ${bare}`)
    assert.match(res.error, /API token|telemetry/)
  }
})

test('privacy shell and run_code guards normalize Windows UNC and repeated slashes consistently', async (t) => {
  const { run, rt, diary, agentOf, stop } = await start()
  t.after(stop)
  const writerAgent = agentOf('b')
  // Repeated slashes on the private Bot's real diary folder are blocked.
  const repeated = await run('bash', { command: `cat ${diary.replace(/[\\/]/g, '//')}/notes.txt` }, 'b', writerAgent)
  assert.equal(repeated.ran, false, 'expected bash block for repeated slashes on diary')
  assert.match(repeated.error, CLOSED)
  // UNC private folder matches single/double backslash, forward-slash, and JS-escaped UNC forms.
  rt.state.bots[P].workDir = process.platform === 'win32' ? '\\\\fileserver\\team\\private-vault' : '//fileserver/team/private-vault'
  for (const cmd of [
    'type \\\\fileserver\\team\\private-vault\\notes.md',
    'cat //fileserver/team/private-vault/notes.md',
    'cat //fileserver//team///private-vault/notes.md',
  ]) {
    const res = await run('bash', { command: cmd }, 'b', writerAgent)
    assert.equal(res.ran, false, `expected bash block for UNC path: ${cmd}`)
    assert.match(res.error, CLOSED)
  }
  const codeRes = await run('run_code', { code: 'return "\\\\\\\\fileserver\\\\team\\\\private-vault\\\\notes.md"' }, 'b', writerAgent)
  assert.equal(codeRes.ran, false, 'expected run_code block for escaped UNC path')
  assert.match(codeRes.error, CLOSED)
})

test('present tool cannot expose private Bot files, host API files, or secret files', async (t) => {
  const { run, rt, home, diary, agentOf, stop } = await start()
  t.after(stop)
  const writerAgent = agentOf('b')
  const privateRes = await run('present', { files: [{ path: join(diary, 'notes.txt') }] }, 'b', writerAgent)
  assert.equal(privateRes.ran, false)
  assert.match(privateRes.error, CLOSED)
  // Without any private Bot, guardApiFiles, guardSecretFiles, and guardPresentData still block present.
  rt.state.bots[P].private = false
  const apiRes = await run('present', { files: [{ path: join(home, 'api-tokens.json') }] }, 'b', writerAgent)
  assert.equal(apiRes.ran, false)
  assert.match(apiRes.error, /API token|telemetry/)
  const secretRes = await run('present', { files: [{ path: join(home, 'secret-refs', 'tok.json') }] }, 'b', writerAgent)
  assert.equal(secretRes.ran, false)
  assert.match(secretRes.error, /secret/)
  const stateRes = await run('present', { files: [{ path: join(home, 'state.json') }] }, 'b', writerAgent)
  assert.equal(stateRes.ran, false)
  assert.match(stateRes.error, /DeepSeek Harness data/)
  const secretsJsonRes = await run('present', { files: [{ path: join(home, 'secrets.json') }] }, 'b', writerAgent)
  assert.equal(secretsJsonRes.ran, false)
  assert.match(secretsJsonRes.error, /DeepSeek Harness data/)
})
