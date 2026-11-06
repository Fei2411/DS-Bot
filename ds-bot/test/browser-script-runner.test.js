import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runIsolatedScript } from '../src/host/browser/script-runner.js'

const helpers = () => {
  const calls = []
  const record = name => async (...args) => {
    calls.push([name, ...args])
    return name === 'tabs' ? [{ index: 0, url: 'https://example.com/', current: true }] : `${name} ok`
  }
  return { calls, helpers: { goto: record('goto'), snapshot: record('snapshot'), click: record('click'), tabs: record('tabs') } }
}

test('helpers reach the host and their results come back as values', async () => {
  const { calls, helpers: h } = helpers()
  const answer = await runIsolatedScript(`
    await goto('https://example.com/')
    const page = await snapshot()
    await click('e3', { confirm: true })
    const open = await tabs('list')
    done(page + ' / ' + open[0].url)
  `, h)
  assert.equal(answer, 'snapshot ok / https://example.com/')
  assert.deepEqual(calls, [['goto', 'https://example.com/'], ['snapshot'], ['click', 'e3', { confirm: true }], ['tabs', 'list']])
})

test('the return value stands in for done(), and no answer is null', async () => {
  assert.equal(await runIsolatedScript('return 42', {}), '42')
  assert.equal(await runIsolatedScript('const x = 1', {}), null)
})

test('a helper error rejects inside the script and can be caught there', async () => {
  const answer = await runIsolatedScript(`
    try { await goto('x') } catch (error) { done('caught: ' + error.message) }
  `, { goto: async () => { throw new Error('The browser has no open tabs.') } })
  assert.equal(answer, 'caught: The browser has no open tabs.')
})

test('a script error rejects the run with its message', async () => {
  await assert.rejects(runIsolatedScript('throw new Error("boom")', {}), /boom/)
  await assert.rejects(runIsolatedScript('this is not javascript', {}), /Unexpected|SyntaxError|identifier/i)
})

test('the script cannot reach Node: process, require, import(), fetch and constructor escapes all fail', async () => {
  const probes = {
    process: 'return typeof process',
    require: 'return typeof require',
    fetch: 'return typeof fetch',
    globalProcess: 'return typeof globalThis.process',
    getBuiltinModule: 'return typeof globalThis.process?.getBuiltinModule',
    thisEscape: 'try { return typeof this.constructor.constructor("return process")() } catch { return "blocked" }',
    helperEscape: 'try { return typeof goto.constructor("return process")() } catch { return "blocked" }',
    promiseEscape: 'try { return typeof goto("x").constructor.constructor("return process")() } catch { return "blocked" }',
    resultEscape: 'const r = await tabs("list"); try { return typeof r.constructor.constructor("return process")() } catch { return "blocked" }',
    errorEscape: 'try { await click() } catch (e) { try { return typeof e.constructor.constructor("return process")() } catch { return "blocked" } }',
  }
  const { helpers: h } = helpers()
  h.click = async () => { throw new Error('no') }
  for (const [name, body] of Object.entries(probes)) {
    const answer = await runIsolatedScript(body, h)
    assert.ok(answer === 'undefined' || answer === 'blocked', `${name}: got ${answer}`)
  }
  await assert.rejects(runIsolatedScript('await import("node:fs")', {}))
})

test('a script that never yields is killed at the timeout and the host keeps running', async () => {
  const started = Date.now()
  await assert.rejects(runIsolatedScript('while (true) {}', {}, { timeout: 500 }), /longer than 0.5 seconds/)
  assert.ok(Date.now() - started < 5_000)
  // The host event loop was never blocked: a later script still runs.
  assert.equal(await runIsolatedScript('done("alive")', {}), 'alive')
})

test('an async loop stops at the timeout and makes no more helper calls afterwards', async () => {
  let calls = 0
  await assert.rejects(runIsolatedScript('for (;;) await snapshot()', { snapshot: async () => { calls += 1; return 'x' } }, { timeout: 300 }), /longer than/)
  const seen = calls
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(calls, seen, 'no helper call after the script was terminated')
})

test('setTimeout waits inside the script', async () => {
  const answer = await runIsolatedScript('await new Promise(r => setTimeout(r, 50)); done("waited")', {})
  assert.equal(answer, 'waited')
})

test('rewriting the built-ins the bridge uses does not let a worker object back into the script', async () => {
  const escaped = 'try { return typeof e.constructor.constructor("return process")() } catch { return "blocked" }'
  const probes = {
    badJsonForWait: `JSON.stringify = () => '{'; try { setTimeout(() => {}, 0) } catch (e) { ${escaped} } return "no throw"`,
    numberForWait: `JSON.stringify = () => '5'; try { setTimeout(() => {}, 0) } catch (e) { ${escaped} } return "no throw"`,
    uncloneable: `JSON.stringify = () => (() => 1); try { await goto('x') } catch (e) { ${escaped} } return "no throw"`,
    objectArgs: `JSON.stringify = () => ({}); try { await goto('x') } catch (e) { ${escaped} } return "no throw"`,
    badParse: `JSON.parse = () => { throw new Error('x') }; try { await goto('x') } catch (e) { ${escaped} } return "no throw"`,
  }
  for (const [name, body] of Object.entries(probes)) {
    const answer = await runIsolatedScript(body, { goto: async () => 'ok' })
    assert.ok(['undefined', 'blocked', 'no throw'].includes(answer), `${name}: got ${answer}`)
  }
})

test('a rewritten String cannot make the answer anything but text', async () => {
  const answer = await runIsolatedScript('String = () => ({ a: 1 }); return "x"', {})
  assert.equal(answer, 'x')
})

test('no stack hook can be installed in the script', async () => {
  const answer = await runIsolatedScript('try { Error.prepareStackTrace = () => 1 } catch { return "locked" } return String(Error.prepareStackTrace)', {})
  assert.ok(answer === 'locked' || answer === 'undefined', answer)
})

test('a trailing undefined argument keeps the helper default', async () => {
  const seen = []
  await runIsolatedScript('await click("e3", undefined); done("ok")', { click: async (...args) => { seen.push(args); return 'clicked' } })
  assert.deepEqual(seen, [['e3']])
})

test('a helper result that is not JSON reaches the script as undefined, and an unawaited rejection does not end the run', async () => {
  assert.equal(await runIsolatedScript('const v = await snapshot(); done(typeof v)', { snapshot: async () => () => 1 }), 'undefined')
  assert.equal(await runIsolatedScript('goto("x"); await new Promise(r => setTimeout(r, 50)); done("still here")', { goto: async () => { throw new Error('no') } }), 'still here')
})

test('a script that exhausts its heap ends only its own process', async () => {
  await assert.rejects(runIsolatedScript("const a = 'A'.repeat(60 * 1024 * 1024); const parts = []; for (;;) parts.push(a + parts.length)", {}, { timeout: 15_000 }))
  assert.equal(await runIsolatedScript('done("alive")', {}), 'alive')
})

test('an oversized helper argument is refused inside the script', async () => {
  const answer = await runIsolatedScript("try { await goto('q=' + 'A'.repeat(5 * 1024 * 1024)) } catch (error) { done(error.message) }", { goto: async () => 'ok' })
  assert.match(answer, /larger than 4 MB/)
})

test('error stacks carry no frames, so no host paths', async () => {
  const answer = await runIsolatedScript('try { null.x } catch (error) { return error.stack + " | " + new Error("m").stack }', {})
  assert.doesNotMatch(answer, /script-child|node:internal|[A-Za-z]:[\\/]/)
})
