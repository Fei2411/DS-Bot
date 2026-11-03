import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/store.js'

function patch(method, replace) {
  const original = fsp[method]
  fsp[method] = replace(original)
  syncBuiltinESMExports()
  return () => {
    fsp[method] = original
    syncBuiltinESMExports()
  }
}

function patchSync(method, replace) {
  const original = fs[method]
  fs[method] = replace(original)
  syncBuiltinESMExports()
  return () => {
    fs[method] = original
    syncBuiltinESMExports()
  }
}

function runtime(t, saved) {
  const home = fs.mkdtempSync(join(tmpdir(), 'ds-bot-store-'))
  const statePath = join(home, 'state.json')
  if (saved !== undefined) fs.writeFileSync(statePath, typeof saved === 'string' ? saved : JSON.stringify(saved))
  const warnings = []
  const disposers = []
  let disposed
  const ctx = {
    logger: { warn: (...args) => warnings.push(args) },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  const rt = {
    ctx,
    home,
    statePath,
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    warn: (...args) => warnings.push(args),
  }
  install(rt)
  const dispose = () => {
    disposed ??= Promise.all(disposers.splice(0).map(cleanup => cleanup()))
    return disposed
  }
  t.after(async () => {
    await dispose()
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, home, statePath, warnings, dispose }
}

test('a failed state write rejects and leaves the saved file unchanged', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  const original = fs.readFileSync(statePath)
  fs.mkdirSync(`${statePath}.${process.pid}.tmp`)
  rt.state.prefs.marker = 'not saved'
  await assert.rejects(rt.save(), { code: 'EISDIR' })
  assert.deepEqual(fs.readFileSync(statePath), original)
})

test('a failed migration write warns but load() still resolves', async (t) => {
  const { rt, statePath, warnings } = runtime(t, { version: 1, mainBotId: 'chief', bots: { chief: { id: 'chief', name: 'Chief' } } })
  // The migrated team's first write fails: a directory takes the temp file's path.
  fs.mkdirSync(`${statePath}.${process.pid}.tmp`)
  await rt.load()
  assert.equal(rt.readOnly(), undefined)
  assert.ok(warnings.some(args => /saving the migrated Bot team failed/.test(String(args))))
  // Once the disk is free the next save() writes the migrated state.
  fs.rmSync(`${statePath}.${process.pid}.tmp`, { recursive: true })
  await rt.save()
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(saved.mainBotId, undefined)
  assert.ok(saved.mainBotIds.includes('chief'))
})

test('a failed state rename rejects and preserves the saved file', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  const original = fs.readFileSync(statePath)
  const restore = patch('rename', originalRename => async (from, to) => {
    if (to === statePath) throw Object.assign(new Error('synthetic rename failure'), { code: 'ENOSPC' })
    return originalRename(from, to)
  })
  try {
    rt.state.prefs.marker = 'not saved'
    await assert.rejects(rt.save(), { code: 'ENOSPC' })
    assert.deepEqual(fs.readFileSync(statePath), original)
  } finally {
    restore()
  }
})

test('malformed state is backed up before a later save', async (t) => {
  const original = '{"version":1,'
  const { rt, statePath } = runtime(t, original)
  await rt.load()
  const backups = fs.readdirSync(rt.home).filter(name => name.startsWith('state.json.broken-'))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(join(rt.home, backups[0]), 'utf8'), original)
  rt.state.prefs.marker = 'recovered'
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'recovered')
})

test('malformed state stays read-only when its backup cannot be copied', async (t) => {
  const original = '{"version":1,'
  const { rt, statePath } = runtime(t, original)
  const restore = patchSync('copyFileSync', () => () => {
    throw Object.assign(new Error('synthetic copy failure'), { code: 'EACCES' })
  })
  try {
    await rt.load()
    assert.match(rt.readOnly(), /could not be read/)
    rt.state.prefs.marker = 'not saved'
    await rt.save()
    assert.equal(fs.readFileSync(statePath, 'utf8'), original)
    assert.deepEqual(fs.readdirSync(rt.home).filter(name => name.startsWith('state.json.broken-')), [])
  } finally {
    restore()
  }
})

test('a state from a newer version remains untouched', async (t) => {
  const original = JSON.stringify({ version: 999, revision: 77, recoveryMarker: 'keep' })
  const { rt, statePath } = runtime(t, original)
  await rt.load()
  assert.match(rt.readOnly(), /saved by a newer DS Bot; update DS Bot/)
  rt.state.prefs.marker = 'not saved'
  await rt.save()
  assert.equal(fs.readFileSync(statePath, 'utf8'), original)
})

test('a read error keeps the existing state read-only', async (t) => {
  const original = JSON.stringify({ version: 1, revision: 77, recoveryMarker: 'keep' })
  const { rt, statePath } = runtime(t, original)
  const restore = patchSync('readFileSync', originalRead => (path, ...args) => {
    if (path === statePath) throw Object.assign(new Error('synthetic read failure'), { code: 'EACCES' })
    return originalRead(path, ...args)
  })
  try {
    await rt.load()
  } finally {
    restore()
  }
  assert.match(rt.readOnly(), /could not be read \(EACCES\)/)
  await rt.save()
  assert.equal(fs.readFileSync(statePath, 'utf8'), original)
})

test('refresh adopts a fixed state file and clears read-only mode', async (t) => {
  const { rt, statePath } = runtime(t, { version: 999, revision: 77 })
  await rt.load()
  assert.match(rt.readOnly(), /could not be read/)
  const fixed = { version: 1, revision: 78, recoveryMarker: 'fixed file' }
  fs.writeFileSync(statePath, JSON.stringify(fixed))
  await rt.refresh()
  assert.equal(rt.readOnly(), undefined)
  assert.equal(rt.state.recoveryMarker, 'fixed file')
  rt.state.prefs.marker = 'saved after repair'
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'saved after repair')
})

test('a state file changed while the lock was gone is adopted, this host\'s state kept aside', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t)
  await rt.load()
  rt.state.prefs.marker = 'ours'
  await rt.save()
  // A lock that only went missing changes nothing: the file is still this host's.
  fs.rmSync(join(home, 'state.lock'))
  await rt.refresh()
  assert.deepEqual(fs.readdirSync(home).filter(name => name.startsWith('state.json.replaced-')), [])
  // A tool with full file access can edit the team file and remove the lock.
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'outside edit' } }))
  fs.rmSync(join(home, 'state.lock'))
  await rt.refresh()
  assert.equal(rt.state.prefs.marker, 'outside edit')
  assert.equal(rt.readOnly(), undefined)
  assert.ok(warnings.some(args => /adopted/.test(String(args)) && /kept as/.test(String(args))))
  const backups = fs.readdirSync(home).filter(name => name.startsWith('state.json.replaced-'))
  assert.equal(backups.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(join(home, backups[0]), 'utf8')).prefs.marker, 'ours')
  // The next save writes the adopted state, so the outside edit is not lost.
  rt.state.prefs.after = 'saved'
  await rt.save()
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(saved.prefs.marker, 'outside edit')
  assert.equal(saved.prefs.after, 'saved')
})

test('a changed file is still adopted when keeping this host\'s state aside fails', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t)
  await rt.load()
  rt.state.prefs.marker = 'ours'
  await rt.save()
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'outside edit' } }))
  fs.rmSync(join(home, 'state.lock'))
  const restore = patch('writeFile', originalWrite => async (path, ...args) => {
    if (String(path).startsWith(`${statePath}.replaced-`)) throw Object.assign(new Error('synthetic write failure'), { code: 'EACCES' })
    return originalWrite(path, ...args)
  })
  try {
    await rt.refresh()
  } finally {
    restore()
  }
  assert.equal(rt.state.prefs.marker, 'outside edit')
  assert.ok(warnings.some(args => /is lost because/.test(String(args))))
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'outside edit')
})

test('a save that takes the lock back adopts a changed file first', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t)
  await rt.load()
  rt.state.prefs.marker = 'ours'
  await rt.save()
  // A tool with full file access edits the team file and removes the lock; the
  // next save runs before any refresh sees it.
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'outside edit' } }))
  fs.rmSync(join(home, 'state.lock'))
  rt.state.prefs.after = 'late change'
  await rt.save()
  // The file on disk was adopted, not overwritten by the old in-memory state.
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(saved.prefs.marker, 'outside edit')
  assert.equal(rt.state.prefs.marker, 'outside edit')
  assert.equal(rt.state.prefs.after, undefined)
  assert.ok(warnings.some(args => /adopted/.test(String(args)) && /kept as/.test(String(args))))
  const backups = fs.readdirSync(home).filter(name => name.startsWith('state.json.replaced-'))
  assert.equal(backups.length, 1)
  const aside = JSON.parse(fs.readFileSync(join(home, backups[0]), 'utf8'))
  assert.equal(aside.prefs.marker, 'ours')
  assert.equal(aside.prefs.after, 'late change')
})

test('a save cannot slip between a reclaim and the adopt it waits on', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  rt.state.prefs.marker = 'ours'
  await rt.save()
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'outside edit' } }))
  fs.rmSync(join(home, 'state.lock'))
  let entered
  let unblock
  const atBackup = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const restore = patch('writeFile', originalWrite => async (path, ...args) => {
    if (String(path).startsWith(`${statePath}.replaced-`)) {
      entered()
      await gate
    }
    return originalWrite(path, ...args)
  })
  try {
    const refreshing = rt.refresh()
    await atBackup
    // The reclaim already happened; this save must wait for the adopt, not write
    // the in-memory state it still holds.
    rt.state.prefs.after = 'racing save'
    const racing = rt.save()
    unblock()
    await refreshing
    await racing
    assert.equal(rt.state.prefs.marker, 'outside edit')
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'outside edit')
  } finally {
    unblock()
    restore()
  }
})

test('a save writes the unsaved change when the lock went away but the file did not', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  let entered
  let unblock
  const atMkdir = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const restore = patch('mkdir', originalMkdir => async (path, ...args) => {
    if (path === home) {
      entered()
      await gate
    }
    return originalMkdir(path, ...args)
  })
  try {
    rt.state.bots.b1 = { id: 'b1', name: 'Renamed' }
    const saving = rt.save()
    await atMkdir
    // The lock file is deleted while the save waits, but the file is unchanged:
    // the reclaim keeps the in-memory state and the save writes the change.
    fs.rmSync(join(home, 'state.lock'))
    const refreshing = rt.refresh()
    unblock()
    await saving
    await refreshing
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).bots.b1.name, 'Renamed')
    assert.deepEqual(fs.readdirSync(home).filter(name => name.startsWith('state.json.replaced-')), [])
  } finally {
    unblock()
    restore()
  }
})

test('a save writes nothing after adopting a file from a newer DS Bot', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  rt.state.prefs.marker = 'ours'
  await rt.save()
  const future = JSON.stringify({ version: 999, revision: 77, prefs: { marker: 'future' } })
  fs.writeFileSync(statePath, future)
  fs.rmSync(join(home, 'state.lock'))
  rt.state.prefs.after = 'not saved'
  await rt.save()
  assert.match(rt.readOnly(), /saved by a newer DS Bot/)
  assert.equal(fs.readFileSync(statePath, 'utf8'), future)
  // The outside edit was still kept aside before it was adopted.
  const backups = fs.readdirSync(home).filter(name => name.startsWith('state.json.replaced-'))
  assert.equal(backups.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(join(home, backups[0]), 'utf8')).prefs.marker, 'ours')
})

test('a save queued before the lock was lost does not write over an outside edit', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  rt.state.prefs.marker = 'ours'
  await rt.save()
  let entered
  let unblock
  const atMkdir = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const restore = patch('mkdir', originalMkdir => async (path, ...args) => {
    if (path === home) {
      entered()
      await gate
    }
    return originalMkdir(path, ...args)
  })
  try {
    rt.state.prefs.after = 'queued save'
    const racing = rt.save()
    await atMkdir
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'outside edit' } }))
    fs.rmSync(join(home, 'state.lock'))
    const refreshing = rt.refresh()
    unblock()
    await assert.rejects(racing, { code: 'ELOCKLOST' })
    await refreshing
    assert.equal(rt.state.prefs.marker, 'outside edit')
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'outside edit')
  } finally {
    unblock()
    restore()
  }
})

test('a save paused while another host held the team does not overwrite its final state', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  rt.state.prefs.marker = 'ours'
  await rt.save()
  let entered
  let unblock
  const atMkdir = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const restore = patch('mkdir', originalMkdir => async (path, ...args) => {
    if (path === home) {
      entered()
      await gate
    }
    return originalMkdir(path, ...args)
  })
  try {
    rt.state.prefs.after = 'stale snapshot'
    const saving = rt.save()
    await atMkdir
    // Another dsh takes the lock and writes; this host turns read-only and adopts.
    fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-host', since: Date.now() }))
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'other write' } }))
    await rt.refresh()
    assert.match(rt.readOnly(), /another dsh/)
    // The other dsh writes its final state and exits; this host takes over.
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 901, prefs: { marker: 'final' } }))
    fs.rmSync(join(home, 'state.lock'))
    const refreshing = rt.refresh()
    unblock()
    await assert.rejects(saving, { code: 'ELOCKLOST' })
    await refreshing
    assert.equal(rt.state.prefs.marker, 'final')
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'final')
  } finally {
    unblock()
    restore()
  }
})

test('a changed file is adopted when another host left its lock behind', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  rt.state.prefs.marker = 'before'
  await rt.save()
  // A dsh that took over and is gone leaves its lock beside the file it wrote.
  fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 99999999, host: hostname(), token: 'other-host', since: Date.now() }))
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'taken over' } }))
  await rt.refresh()
  assert.equal(rt.state.prefs.marker, 'taken over')
  assert.equal(rt.readOnly(), undefined)
  const backups = fs.readdirSync(home).filter(name => name.startsWith('state.json.replaced-'))
  assert.equal(backups.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(join(home, backups[0]), 'utf8')).prefs.marker, 'before')
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'taken over')
})

test('a reading host takes over the team once the dsh that held it is gone', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t, { version: 1, revision: 4, prefs: { marker: 'first write' } })
  fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-host', since: Date.now() }))
  await rt.load()
  assert.match(rt.readOnly(), /another dsh/)
  // The other dsh wrote its last state and closed, releasing the lock.
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 5, prefs: { marker: 'handed over' } }))
  fs.rmSync(join(home, 'state.lock'))
  await rt.refresh()
  assert.equal(rt.readOnly(), undefined)
  assert.equal(rt.state.prefs.marker, 'handed over')
  // A normal hand-over adopts silently: no copy of this host's state, no diagnostic.
  assert.deepEqual(fs.readdirSync(home).filter(name => name.startsWith('state.json.replaced-')), [])
  assert.ok(!warnings.some(args => /adopted/.test(String(args))))
  await rt.save()
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'handed over')
})

test('an unusable state lock warns and keeps the team saving', async (t) => {
  const { rt, home, statePath, warnings } = runtime(t)
  const lockPath = join(home, 'state.lock')
  const restore = patchSync('writeFileSync', originalWrite => (path, ...args) => {
    if (path === lockPath) throw Object.assign(new Error('synthetic lock failure'), { code: 'EACCES' })
    return originalWrite(path, ...args)
  })
  try {
    await rt.load()
    assert.equal(rt.readOnly(), undefined)
    assert.equal(warnings.filter(([template]) => template.includes('cannot lock')).length, 1)
    rt.state.prefs.marker = 'saved without a lock'
    await rt.save()
    await rt.refresh()
    assert.equal(rt.state.prefs.marker, 'saved without a lock')
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'saved without a lock')
  } finally {
    restore()
  }
})

test('a queued save rejects after another host takes the lock', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  let entered
  let unblock
  const atMkdir = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  let paused = false
  const restore = patch('mkdir', originalMkdir => async (path, ...args) => {
    if (path === home && !paused) {
      paused = true
      entered()
      await gate
    }
    return originalMkdir(path, ...args)
  })
  try {
    rt.state.prefs.marker = 'old owner'
    const active = rt.save()
    await atMkdir
    const queued = rt.save()
    fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
    const ownerState = JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'new owner' } })
    fs.writeFileSync(statePath, ownerState)
    unblock()
    await assert.rejects(active, { code: 'ELOCKLOST' })
    await assert.rejects(queued, { code: 'ELOCKLOST' })
    assert.equal(fs.readFileSync(statePath, 'utf8'), ownerState)
    assert.equal(JSON.parse(fs.readFileSync(join(home, 'state.lock'), 'utf8')).token, 'new-owner')
  } finally {
    unblock()
    restore()
  }
})

test('a read-only host resolves awaited saves without writing', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
  const ownerState = JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'new owner' } })
  fs.writeFileSync(statePath, ownerState)
  await rt.refresh()
  assert.match(rt.readOnly(), /another dsh/)
  rt.state.prefs.marker = 'not saved'
  await rt.save()
  assert.equal(fs.readFileSync(statePath, 'utf8'), ownerState)
})

test('dispose waits for a pending save and prevents later writes', async (t) => {
  const { rt, home, statePath, dispose } = runtime(t)
  await rt.load()
  await rt.save()
  let entered
  let unblock
  const atRename = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const restore = patch('rename', originalRename => async (from, to) => {
    if (to === statePath) {
      entered()
      await gate
    }
    return originalRename(from, to)
  })
  try {
    rt.state.prefs.marker = 'pending save'
    const pending = rt.save()
    await atRename
    const disposing = dispose()
    assert.equal(fs.existsSync(join(home, 'state.lock')), true)
    const revision = rt.state.revision
    const afterDispose = rt.save()
    assert.equal(rt.state.revision, revision)
    unblock()
    await pending
    await disposing
    await afterDispose
    assert.equal(fs.existsSync(join(home, 'state.lock')), false)
    const saved = fs.readFileSync(statePath, 'utf8')
    await rt.save()
    assert.equal(rt.state.revision, revision)
    assert.equal(fs.readFileSync(statePath, 'utf8'), saved)
  } finally {
    unblock()
    restore()
  }
})

// #715: a model that quotes the Bot's name must find it, like findRooms does.
test('findBot unquotes a Bot ref before matching the name', async (t) => {
  const { rt } = runtime(t, {
    version: 1,
    mainBotIds: [],
    bots: {
      a1: { id: 'a1', name: 'Ada' },
      s2: { id: 's2', name: 'Sun Tzu' },
    },
    rooms: {},
  })
  await rt.load()
  for (const ref of ['Ada', 'ada', ' @Ada ', '"Ada"', "'Ada'", '“Ada”', '「Ada」']) {
    assert.equal(rt.findBot(ref)?.id, 'a1', ref)
  }
  assert.equal(rt.findBot('“Sun Tzu”')?.id, 's2')
  // An id still resolves itself; an unknown name still misses.
  assert.equal(rt.findBot('a1')?.id, 'a1')
  assert.equal(rt.findBot('"Nobody"'), undefined)
  assert.equal(rt.findBot(undefined), undefined)
})
