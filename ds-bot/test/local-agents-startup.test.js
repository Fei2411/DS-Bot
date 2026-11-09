import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { CodexEngine } from '../src/host/local-agents/codex.js'

const run = promisify(execFile)
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const makeEngine = (kind, args = []) => new (kind === 'acp' ? AcpEngine : CodexEngine)(
  'local-test', { name: 'Test CLI', command: process.execPath, args: [fixture('fake-local-startup.mjs'), ...args] },
  { findExecutable: path => path },
)

for (const kind of ['acp', 'codex']) {
  for (const failure of ['missing', 'interpreter', 'permission']) {
    test(`${kind}: ${failure} spawn failure stays in the turn and can be retried (#1222)`, { skip: process.platform === 'win32' && failure !== 'missing' }, async () => {
      const result = await run(process.execPath, [fixture('local-startup-check.mjs'), kind, failure], { timeout: 10_000 })
      assert.equal(result.stdout, 'recovered\n')
    })
  }

  test(`${kind}: concurrent opens wait for the same initialization`, async (t) => {
    const engine = makeEngine(kind)
    t.after(() => engine.close())
    const [first, second] = await Promise.all([
      engine.open('one', { cwd: process.cwd() }),
      engine.open('two', { cwd: process.cwd() }),
    ])
    assert.notEqual(first, second)
    assert.ok(kind === 'acp' ? first.acpSessionId : first.threadId)
    assert.ok(kind === 'acp' ? second.acpSessionId : second.threadId)
  })

  test(`${kind}: rejected initialization clears the process and allows a retry`, async (t) => {
    const engine = makeEngine(kind, ['--reject-initialize'])
    t.after(() => engine.close())
    await assert.rejects(engine.ensure(), /initialization refused/)
    assert.equal(engine.peer, undefined)
    assert.equal(engine.child, undefined)
    engine.engine.args.pop()
    await engine.ensure()
    assert.ok(engine.peer)
  })

  test(`${kind}: closing during initialization does not clear a replacement process`, async (t) => {
    const engine = makeEngine(kind)
    t.after(() => engine.close())
    const starting = engine.ensure()
    const child = engine.child
    const exited = once(child, 'exit')
    await engine.close()
    await assert.rejects(starting)
    const peer = await engine.ensure()
    await exited
    assert.equal(engine.peer, peer)
    assert.notEqual(engine.child, child)
  })
}
