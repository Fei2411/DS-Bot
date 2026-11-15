import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// The client reads DSH's UI primitives at run time. A name DSH drops does not fail
// the build: the call site sees undefined, and a feature gated on it switches off
// with no error (#1616: `projectUserText` went in DSH 0.2.1-alpha.3, and the user
// bubble, with its fold, time and IM tag, stopped mounting). Here every name the
// client reads is checked against what the DSH the tests run on really exports.

// Names the client reads only behind a fallback, for DSH releases on either side of
// a change. Each needs a reason, so a stale entry is easy to spot and drop.
const OPTIONAL = {
  // Releases before 0.2.1-alpha.3 drew user text with it; later ones by the
  // conversation.user.text factory (user-message.js draws with either).
  projectUserText: 'user text before DSH 0.2.1-alpha.3',
}

const harness = process.env.DSH_HARNESS
const frontend = harness === undefined ? undefined
  : [join(harness, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets'), join(harness, 'packages/web/frontend/dist/assets')].find(existsSync)

// The browser bundle hands plugins the primitives module as a frozen namespace object:
// `"@deepseek-ai/dsh-client-ui-primitives":X`, with `X=Object.freeze(...{__proto__:null,A:a,...})`.
function hostExports() {
  for (const file of readdirSync(frontend).filter(name => /^index-.*\.js$/.test(name))) {
    const source = readFileSync(join(frontend, file), 'utf8')
    const binding = /"@deepseek-ai\/dsh-client-ui-primitives":([\w$]+)/.exec(source)?.[1]
    if (binding === undefined) continue
    const start = source.indexOf(`${binding}=Object.freeze(`)
    const body = source.slice(start, source.indexOf('},Symbol.toStringTag', start))
    return new Set([...body.matchAll(/(?:\{__proto__:null,|,)([A-Za-z_$][\w$]*):/g)].map(match => match[1]))
  }
  return undefined
}

// `import * as ui from '…primitives'` then `ui.Name`, and `import { Name } from '…primitives'`.
function clientReads() {
  const dir = new URL('../src/client/', import.meta.url)
  const reads = new Map()
  const note = (name, file) => reads.set(name, [...(reads.get(name) ?? []), file])
  for (const file of readdirSync(dir).filter(name => name.endsWith('.js'))) {
    const source = readFileSync(new URL(file, dir), 'utf8')
    for (const [, ns] of source.matchAll(/import \* as (\w+) from '@deepseek-ai\/dsh-client-ui-primitives'/g)) {
      for (const [, name] of source.matchAll(new RegExp(`\\b${ns}\\.([A-Za-z_$][\\w$]*)`, 'g'))) note(name, file)
    }
    for (const [, list] of source.matchAll(/import \{([^}]*)\} from '@deepseek-ai\/dsh-client-ui-primitives'/g)) {
      for (const part of list.split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]
        if (name) note(name, file)
      }
    }
  }
  return reads
}

test('every UI primitive the client reads is one the DSH under test exports, or a listed fallback', { skip: frontend === undefined && 'no DSH web frontend in the harness' }, () => {
  const exported = hostExports()
  assert.ok(exported?.size > 100, 'the primitives namespace was not found in the DSH web bundle')
  const reads = clientReads()
  assert.ok(reads.size > 0)
  const missing = [...reads].filter(([name]) => !exported.has(name) && !(name in OPTIONAL))
  assert.deepEqual(missing.map(([name, files]) => `${name} (${[...new Set(files)].join(', ')})`), [])
  // A fallback the client no longer reads is no longer one. A DSH release older than the
  // change (the matrix still runs 0.2.0-rc.2) exports the name, so that is not checked.
  for (const name of Object.keys(OPTIONAL)) assert.ok(reads.has(name), `${name} is listed as optional but the client does not read it`)
})
