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

test('legacy review switches migrate into the permission mode and keep the team model', async t => {
  const { rt, statePath } = runtime(t, { version: 1,
    bots: { b: { id: 'b', autoApprove: true, permission: 'danger-full-access' }, c: { id: 'c', autoApprove: false, permission: 'read-only' } },
    rooms: { r: { id: 'r', members: ['b'], autoApprove: true }, s: { id: 's', members: ['b'], autoApprove: false } },
    prefs: { approvalModel: 'mock/reviewer' }, approvalPolicies: { child: 'never' },
  })
  await rt.load()
  assert.equal(rt.state.bots.b.permission, 'review')
  assert.equal(rt.state.bots.c.permission, 'read-only')
  assert.equal(rt.state.rooms.r.permission, 'review')
  assert.equal(rt.state.rooms.s.permission, undefined)
  for (const target of [...Object.values(rt.state.bots), ...Object.values(rt.state.rooms)]) assert.equal(Object.hasOwn(target, 'autoApprove'), false)
  assert.equal(rt.state.prefs.approvalModel, 'mock/reviewer')
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).bots.b.permission, 'review')
  assert.equal(rt.state.approvalPolicies.child, 'never')
})

test('a previously repairable null-map and null-entry team still loads', async t => {
  const { rt } = runtime(t, { version: 1,
    bots: { ghost: null, chief: { id: 'chief', name: 'Chief', autoApprove: true } },
    rooms: null,
  })
  await rt.load()
  assert.equal(rt.state.bots.ghost, undefined)
  assert.equal(rt.state.bots.chief.permission, 'review')
  assert.equal(Object.hasOwn(rt.state.bots.chief, 'autoApprove'), false)
  assert.deepEqual(rt.state.rooms, {})
})

test('a failed state write rejects and leaves the saved file unchanged', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  const original = fs.readFileSync(statePath)
  const restore = patch('writeFile', originalWrite => async (path, ...args) => {
    if (String(path).startsWith(`${statePath}.`)) throw Object.assign(new Error('synthetic write failure'), { code: 'EISDIR' })
    return originalWrite(path, ...args)
  })
  try {
    rt.state.prefs.marker = 'not saved'
    await assert.rejects(rt.save(), { code: 'EISDIR' })
    assert.deepEqual(fs.readFileSync(statePath), original)
  } finally {
    restore()
  }
})

test('saves made while a write is in flight share one queued write', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const writes = []
  const restore = patch('writeFile', originalWrite => async (path, data, ...args) => {
    if (String(path).startsWith(`${statePath}.`)) {
      writes.push(JSON.parse(data).prefs.marker)
      if (writes.length === 1) await gate
    }
    return originalWrite(path, data, ...args)
  })
  try {
    const revision = rt.state.revision
    rt.state.prefs.marker = 'first'
    const first = rt.save()
    await new Promise(resolve => setTimeout(resolve, 20))
    const later = ['a', 'b', 'c'].map(marker => {
      rt.state.prefs.marker = marker
      return rt.save({ required: marker === 'b' })
    })
    release()
    await Promise.all([first, ...later])
    assert.deepEqual(writes, ['first', 'c'])
    assert.equal(rt.state.revision, revision + 2)
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'c')
  } finally {
    restore()
  }
})

test('saves that joined a failed write get one more write', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const writes = []
  const restore = patch('writeFile', originalWrite => async (path, data, ...args) => {
    if (String(path).startsWith(`${statePath}.`)) {
      writes.push(JSON.parse(data).prefs.marker)
      if (writes.length === 1) await gate
      if (writes.length === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }
    return originalWrite(path, data, ...args)
  })
  try {
    rt.state.prefs.marker = 'first'
    const first = rt.save()
    await new Promise(resolve => setTimeout(resolve, 20))
    const later = ['a', 'b', 'c'].map(marker => {
      rt.state.prefs.marker = marker
      return rt.save({ required: marker === 'b' })
    })
    release()
    await first
    await assert.rejects(later[0], /busy/)
    await Promise.all(later.slice(1))
    assert.deepEqual(writes, ['first', 'c', 'c'])
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'c')
  } finally {
    restore()
  }
})

test('a joined required save that failed is not retried onto an adopted file', async (t) => {
  const { rt, home, statePath } = runtime(t)
  await rt.load()
  await rt.save()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const writes = []
  const restore = patch('writeFile', originalWrite => async (path, data, ...args) => {
    if (String(path).startsWith(`${statePath}.`)) {
      writes.push(JSON.parse(data).prefs.marker)
      if (writes.length === 1) await gate
      if (writes.length === 2) {
        // The team file is replaced and its lock removed while this write fails.
        fs.writeFileSync(statePath, JSON.stringify({ version: 1, revision: 900, prefs: { marker: 'outside edit' } }))
        fs.rmSync(join(home, 'state.lock'))
        throw Object.assign(new Error('disk error'), { code: 'EIO' })
      }
    }
    return originalWrite(path, data, ...args)
  })
  try {
    rt.state.prefs.marker = 'first'
    const first = rt.save()
    await new Promise(resolve => setTimeout(resolve, 20))
    rt.state.prefs.marker = 'queued'
    const queued = rt.save()
    rt.state.prefs.marker = 'mine'
    const joined = rt.save({ required: true })
    release()
    await first
    await assert.rejects(queued, /disk error/)
    // Its change is not in the adopted state, so the required save must fail.
    await assert.rejects(joined, /disk error/)
    await rt.save()
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'outside edit')
  } finally {
    restore()
  }
})

test('model selection witnesses survive a saved store reload', async (t) => {
  const first = runtime(t)
  await first.rt.load()
  const selections = { s1: { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' } }
  first.rt.state.sessionModelSelections = selections
  await first.rt.save()
  await first.dispose()
  const cleanups = []
  const second = { ...first.rt, ctx: { effect: execute => cleanups.push(execute()) } }
  t.after(async () => { for (const cleanup of cleanups) await cleanup() })
  install(second)
  await second.load()
  assert.deepEqual(second.state.sessionModelSelections, selections)
})

test('a failed migration write warns but load() still resolves', async (t) => {
  const { rt, statePath, warnings } = runtime(t, { version: 1, mainBotId: 'chief', bots: { chief: { id: 'chief', name: 'Chief' } } })
  // The migrated team's first write fails.
  const restore = patch('writeFile', originalWrite => async (path, ...args) => {
    if (String(path).startsWith(`${statePath}.`)) throw Object.assign(new Error('synthetic write failure'), { code: 'EISDIR' })
    return originalWrite(path, ...args)
  })
  try {
    await rt.load()
  } finally {
    restore()
  }
  assert.equal(rt.readOnly(), undefined)
  assert.ok(warnings.some(args => /saving the migrated Bot team failed/.test(String(args))))
  // Once the disk is free the next save() writes the migrated state.
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

// After a crash or power loss, a renamed file whose data never reached the disk can come
// back empty, and an empty state.json loads as an empty team (#2238).
test('a state write reaches the disk before it replaces state.json and uses unique per-write temp names', async (t) => {
  const { rt, statePath } = runtime(t)
  await rt.load()
  const steps = []
  const restoreWrite = patch('writeFile', original => async (path, data, options) => {
    const result = await original(path, data, options)
    if (String(path).startsWith(`${statePath}.`)) {
      steps.push(['write-done', path, typeof options === 'object' && options?.flush === true])
    }
    return result
  })
  const restoreRename = patch('rename', original => async (from, to) => {
    if (to === statePath) steps.push(['rename', from])
    return original(from, to)
  })
  try {
    rt.state.prefs.marker = 'saved-1'
    await rt.save()
    rt.state.prefs.marker = 'saved-2'
    await rt.save()
  } finally {
    restoreRename()
    restoreWrite()
  }
  assert.equal(steps.length, 4)
  const [[write1, temp1, flushed1], [rename1, from1], [write2, temp2, flushed2], [rename2, from2]] = steps
  assert.deepEqual([write1, rename1, from1], ['write-done', 'rename', temp1])
  assert.deepEqual([write2, rename2, from2], ['write-done', 'rename', temp2])
  assert.equal(flushed1, true, 'first temp file is flushed before rename')
  assert.equal(flushed2, true, 'second temp file is flushed before rename')
  assert.notEqual(temp1, temp2, 'consecutive writes must use unique temp paths')
  assert.match(temp1, new RegExp(`\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`))
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).prefs.marker, 'saved-2')
})

test('load() sweeps stale temp files from dead PIDs while keeping current PID temp files intact', async (t) => {
  const { rt, home } = runtime(t)
  const otherPid = process.pid + 1
  const staleLegacy = join(home, `state.json.${otherPid}.tmp`)
  const staleUnique = join(home, `state.json.${otherPid}.deadbeef.tmp`)
  const ownTemp = join(home, `state.json.${process.pid}.12345678.tmp`)
  const unrelated = join(home, 'state.json.broken-123')
  fs.writeFileSync(staleLegacy, 'stale')
  fs.writeFileSync(staleUnique, 'stale')
  fs.writeFileSync(ownTemp, 'in-flight')
  fs.writeFileSync(unrelated, 'keep-backup')
  await rt.load()
  // Cleanup runs fire-and-forget; wait briefly for unlink completion.
  for (let i = 0; i < 40 && (fs.existsSync(staleLegacy) || fs.existsSync(staleUnique)); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(fs.existsSync(staleLegacy), false, 'stale legacy temp file must be removed')
  assert.equal(fs.existsSync(staleUnique), false, 'stale unique temp file must be removed')
  assert.equal(fs.existsSync(ownTemp), true, 'current PID temp file must not be touched')
  assert.equal(fs.existsSync(unrelated), true, 'unrelated backup files must not be touched')
})

test('read-only load() does not sweep another host temp files', async (t) => {
  const { rt, home } = runtime(t)
  const otherPid = process.ppid
  const otherTemp = join(home, `state.json.${otherPid}.cafebabe.tmp`)
  fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: otherPid, host: hostname(), token: 'new-owner' }))
  fs.writeFileSync(otherTemp, 'active-write')
  await rt.load()
  assert.match(rt.readOnly(), /another dsh/)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(fs.existsSync(otherTemp), true, 'read-only host must leave active owner temp files untouched')
})

test('dispose waits for startup temp sweep and aborted or lock-lost sweep never deletes another host active temp file', async (t) => {
  // Case 1: dispose() awaits in-flight startup sweep before releasing state.lock and stops unlinking once stopped.
  {
    const { rt, home, dispose } = runtime(t)
    const otherPid = process.pid + 1
    const otherTemp = join(home, `state.json.${otherPid}.deadbeef.tmp`)
    fs.writeFileSync(otherTemp, 'other-write')
    const atReaddir = Promise.withResolvers()
    const gate = Promise.withResolvers()
    const restore = patch('readdir', original => async (dir, ...args) => {
      if (dir === home) {
        atReaddir.resolve()
        await gate.promise
      }
      return original(dir, ...args)
    })
    try {
      await rt.load()
      await atReaddir.promise
      const disposing = dispose()
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(fs.existsSync(join(home, 'state.lock')), true, 'state.lock must stay held until startup sweep finishes')
      gate.resolve()
      await disposing
      assert.equal(fs.existsSync(join(home, 'state.lock')), false, 'state.lock is released after sweep exits')
      assert.equal(fs.existsSync(otherTemp), true, 'disposed host must not unlink temp files after stopping')
    } finally {
      gate.resolve()
      restore()
    }
  }
  // Case 2: another host takes over state.lock while readdir is pending -> sweep skips unlinking the new owner temp file.
  {
    const { rt, home, dispose } = runtime(t)
    const newOwnerPid = process.ppid
    const activeTemp = join(home, `state.json.${newOwnerPid}.11223344.tmp`)
    const atReaddir = Promise.withResolvers()
    const gate = Promise.withResolvers()
    const restore = patch('readdir', original => async (dir, ...args) => {
      if (dir === home) {
        atReaddir.resolve()
        await gate.promise
      }
      return original(dir, ...args)
    })
    try {
      await rt.load()
      await atReaddir.promise
      fs.writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: newOwnerPid, host: hostname(), token: 'new-owner' }))
      fs.writeFileSync(activeTemp, 'in-flight-write')
      gate.resolve()
      await dispose()
      assert.equal(fs.existsSync(activeTemp), true, 'lock-lost host must not unlink replacement host active temp file')
    } finally {
      gate.resolve()
      restore()
    }
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

test('indexSessions normalizes missing ids, empty sessionId, switched segments, openParts, and group sessions', async (t) => {
  const { rt } = runtime(t, {
    version: 1,
    mainBotIds: ['main'],
    bots: {
      main: { id: 'main', name: 'Chief', main: true },
      'empty-sid': { id: 'empty-sid', name: 'Empty', sessionId: '' },
      noId: { name: 'NoId', sessionId: '' },
      coder: {
        id: 'coder',
        name: 'Coder',
        sessionId: 'sess-coder-2',
        segments: [null, {}, { sessionId: '' }, { sessionId: 'sess-coder-1', workDir: '/a' }],
        openParts: [
          { sessionId: '' },
          { sessionId: 'sess-coder-open', segments: [{ sessionId: '' }, { sessionId: 'sess-coder-open-old' }] },
        ],
      },
    },
    rooms: {
      r1: {
        id: 'r1',
        name: 'SecRoom',
        sessionId: '',
        members: ['main', 'coder'],
        sessions: { main: 'grp-main-1', bad: '' },
        segments: { coder: [{ sessionId: '' }, { sessionId: 'grp-coder-old' }] },
        parts: [{ sessionId: '' }, { sessionId: 'room-old' }],
      },
    },
  })
  await rt.load()
  assert.equal(rt.chatOf('main'), 'main')
  assert.equal(rt.chatOf('empty-sid'), 'empty-sid')
  assert.equal(rt.chatOf('noId'), 'noId')
  assert.equal(rt.selfOf('main'), 'main')
  assert.equal(rt.selfOf('empty-sid'), 'empty-sid')
  assert.equal(rt.selfOf('noId'), 'noId')
  assert.equal(rt.selfOf('sess-coder-2'), 'coder')
  assert.equal(rt.selfOf('sess-coder-1'), 'coder')
  assert.equal(rt.selfOf('sess-coder-open'), 'coder')
  assert.equal(rt.selfOf('sess-coder-open-old'), 'coder')
  assert.equal(rt.selfOf('grp-main-1'), 'main')
  assert.equal(rt.selfOf('grp-coder-old'), 'coder')
  assert.equal(rt.roomOf('r1')?.id, 'r1')
  assert.equal(rt.selfOf(''), undefined)
  assert.equal(rt.selfOf(undefined), undefined)
  assert.equal(rt.roomOf(''), undefined)
})
