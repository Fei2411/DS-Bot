import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { install as installJobs } from '../src/host/jobs.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  questions: {},
}

// Mirrors `@deepseek-ai/dsh-jobs` & `@deepseek-ai/dsh-api-job-controller` exact wire contracts:
// JobView.output: { earliest, total, spillPaths? }
// JobChunk: { at, text, channel?: 'stdout'|'stderr'|'log', gapBefore?: true }
// JobEvent: { type: 'output', id, owner, total } | { type: 'status', job }
function makeFakeJobs() {
  const store = new Map([
    ['job-1', {
      id: 'job-1',
      owner: 'm1',
      kind: 'bash',
      label: 'npm run watch',
      status: 'running',
      startedAt: 1000,
      spillPaths: ['/tmp/job-1.log'],
      chunks: [
        { at: 1001, text: 'line 1\n', channel: 'stdout' },
        { at: 1002, text: 'warn 2\n', channel: 'stderr', gapBefore: true },
      ],
      kills: [],
      readCalls: 0,
      readAtCalls: [],
    }],
  ])
  const listeners = new Set()
  const view = (job) => ({
    id: job.id,
    owner: job.owner,
    kind: job.kind,
    label: job.label,
    status: job.status,
    detail: job.detail,
    startedAt: job.startedAt,
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    output: {
      earliest: 0,
      total: job.chunks.length,
      ...(job.spillPaths ? { spillPaths: job.spillPaths } : {}),
    },
  })
  return {
    store,
    emit(event) {
      for (const fn of listeners) fn(event)
    },
    service: {
      list: (owner) => [...store.values()].filter(j => j.owner === owner).map(view),
      get: (jobId, owner) => {
        const j = store.get(jobId)
        if (!j || j.owner !== owner) throw new Error('Job not found')
        return view(j)
      },
      // Destructive read (for model tool); host job-read must NEVER call this!
      read: (jobId, owner) => {
        const j = store.get(jobId)
        if (j && j.owner === owner) j.readCalls += 1
        return { chunks: [] }
      },
      // Non-consuming readAt (for UI inspection)
      readAt: (jobId, cursor = 0, owner) => {
        const j = store.get(jobId)
        if (!j || j.owner !== owner) throw new Error('Job not found')
        j.readAtCalls.push(cursor)
        const start = Math.max(0, Math.min(cursor, j.chunks.length))
        return {
          chunks: j.chunks.slice(start),
          next: j.chunks.length,
          lossy: j.chunks.slice(start).some(c => c.gapBefore === true),
        }
      },
      kill: (jobId, owner, reason) => {
        const j = store.get(jobId)
        if (!j || j.owner !== owner) throw new Error('Job not found')
        j.kills.push(reason)
        j.status = 'killed'
        j.detail = reason
        j.finishedAt = 2000
        for (const fn of listeners) fn({ type: 'status', job: view(j) })
        return 'stopping'
      },
      events: {
        subscribe: (_filter, fn) => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      },
    },
  }
}

function startHarness({ readOnly = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-jobs-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  if (readOnly) {
    // Hold state.lock under parent PID (a live external process) so this instance opens read-only.
    writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }))
  }
  const jobs = makeFakeJobs()
  const ctx = fakeContext({ services: { jobs: jobs.service } })
  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  return {
    ctx,
    jobs,
    call,
    stop: async () => {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('job-list, non-consuming job-read (preserving channel, gapBefore, spillPaths), and job-kill work through api/bot', async () => {
  const env = startHarness()
  try {
    const listed = await env.call('job-list', { sessionId: 'm1' })
    assert.equal(listed.ok, true)
    assert.equal(listed.value.jobs.length, 1)
    assert.equal(listed.value.jobs[0].id, 'job-1')
    assert.equal(listed.value.jobs[0].status, 'running')
    assert.deepEqual(listed.value.jobs[0].output, { earliest: 0, total: 2, spillPaths: ['/tmp/job-1.log'] })

    const read1 = await env.call('job-read', { sessionId: 'm1', jobId: 'job-1', from: 0 })
    assert.equal(read1.ok, true)
    assert.equal(read1.value.text, 'line 1\nwarn 2\n')
    assert.equal(read1.value.next, 2)
    assert.equal(read1.value.lossy, true)
    assert.deepEqual(read1.value.chunks, [
      { at: 1001, text: 'line 1\n', channel: 'stdout' },
      { at: 1002, text: 'warn 2\n', channel: 'stderr', gapBefore: true },
    ])
    const rawJob = env.jobs.store.get('job-1')
    assert.equal(rawJob.readCalls, 0, 'job-read must NEVER consume the model read cursor')
    assert.deepEqual(rawJob.readAtCalls, [0])

    // Incremental append reads only the newly added chunk.
    rawJob.chunks.push({ at: 1003, text: 'line 3\n', channel: 'log' })
    const read2 = await env.call('job-read', { sessionId: 'm1', jobId: 'job-1', from: read1.value.next })
    assert.equal(read2.ok, true)
    assert.equal(read2.value.text, 'line 3\n')
    assert.deepEqual(read2.value.chunks, [{ at: 1003, text: 'line 3\n', channel: 'log' }])
    assert.equal(read2.value.next, 3)

    const killed = await env.call('job-kill', { sessionId: 'm1', jobId: 'job-1' })
    assert.equal(killed.ok, true)
    assert.equal(killed.value.job.status, 'killed')
    assert.deepEqual(rawJob.kills, ['cancelled by the user'])
  } finally {
    await env.stop()
  }
})

test('jobs.events output notices forward event.owner and event.id into local SSE feed', async () => {
  const jobs = makeFakeJobs()
  const localEvents = []
  const disposers = []
  const ctx = {
    get: name => (name === 'jobs' ? jobs.service : undefined),
    effect: fn => { disposers.push(fn()) },
  }
  const rt = {
    ctx,
    readOnly: () => undefined,
    publishLocalFeed: (event, data) => { localEvents.push({ event, data }) },
  }
  installJobs(rt)
  try {
    // Single-job DSH output event carries owner & id at top level (not under event.job).
    jobs.emit({ type: 'output', id: 'job-1', owner: 'm1', total: 3 })
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.deepEqual(localEvents, [{ event: 'jobs', data: { sessionId: 'm1', jobId: 'job-1' } }])

    // Multiple jobs changing for the same session within the coalesce window emit session-level notice.
    localEvents.length = 0
    jobs.emit({ type: 'output', id: 'job-1', owner: 'm1', total: 4 })
    jobs.emit({ type: 'output', id: 'job-2', owner: 'm1', total: 1 })
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.deepEqual(localEvents, [{ event: 'jobs', data: { sessionId: 'm1' } }])
  } finally {
    for (const d of disposers) d?.()
  }
})

test('job-kill is refused in read-only windows and unknown jobs return bot/not-found', async () => {
  const env = startHarness({ readOnly: true })
  try {
    // Reads stay allowed in read-only windows.
    const listed = await env.call('job-list', { sessionId: 'm1' })
    assert.equal(listed.ok, true)

    // Kill is refused in read-only windows.
    const killed = await env.call('job-kill', { sessionId: 'm1', jobId: 'job-1' })
    assert.equal(killed.ok, false)
    assert.equal(killed.error.code, 'bot/read-only')
    assert.equal(env.jobs.store.get('job-1').kills.length, 0)

    const missing = await env.call('job-read', { sessionId: 'm1', jobId: 'nope' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'bot/not-found')
  } finally {
    await env.stop()
  }
})
