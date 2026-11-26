import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
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

// Mirrors `@deepseek-ai/dsh-api-job-controller` exact method signatures:
// list(owner), get(jobId, owner), read(jobId, owner), readAt(jobId, cursor, owner),
// kill(jobId, owner, reason), events.subscribe({ owners }, fn).
function makeFakeJobs() {
  const store = new Map([
    ['job-1', {
      id: 'job-1',
      owner: 'm1',
      kind: 'bash',
      label: 'npm run watch',
      status: 'running',
      startedAt: 1000,
      chunks: [{ at: 1001, text: 'line 1\n' }, { at: 1002, text: 'line 2\n' }],
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
    output: { earliest: 0, total: job.chunks.length, retained: job.chunks.length, truncated: false },
  })
  return {
    store,
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
          lossy: false,
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

test('job-list, non-consuming job-read, and job-kill work through api/bot', async () => {
  const env = startHarness()
  try {
    const listed = await env.call('job-list', { sessionId: 'm1' })
    assert.equal(listed.ok, true)
    assert.equal(listed.value.jobs.length, 1)
    assert.equal(listed.value.jobs[0].id, 'job-1')
    assert.equal(listed.value.jobs[0].status, 'running')

    const read1 = await env.call('job-read', { sessionId: 'm1', jobId: 'job-1', from: 0 })
    assert.equal(read1.ok, true)
    assert.equal(read1.value.text, 'line 1\nline 2\n')
    assert.equal(read1.value.next, 2)
    const rawJob = env.jobs.store.get('job-1')
    assert.equal(rawJob.readCalls, 0, 'job-read must NEVER consume the model read cursor')
    assert.deepEqual(rawJob.readAtCalls, [0])

    // Incremental append reads only the newly added chunk.
    rawJob.chunks.push({ at: 1003, text: 'line 3\n' })
    const read2 = await env.call('job-read', { sessionId: 'm1', jobId: 'job-1', from: read1.value.next })
    assert.equal(read2.ok, true)
    assert.equal(read2.value.text, 'line 3\n')
    assert.equal(read2.value.next, 3)

    const killed = await env.call('job-kill', { sessionId: 'm1', jobId: 'job-1' })
    assert.equal(killed.ok, true)
    assert.equal(killed.value.job.status, 'killed')
    assert.deepEqual(rawJob.kills, ['cancelled by the user'])
  } finally {
    await env.stop()
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
