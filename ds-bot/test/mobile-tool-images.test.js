import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0XQAAAAASUVORK5CYII=',
  'base64',
)

const TEAM = {
  version: 1,
  mainBotIds: ['b1'],
  revision: 1,
  bots: { b1: { id: 'b1', sessionId: 'b1', name: 'Helper', role: 'Assistant', instructions: '', createdAt: 1 } },
  rooms: {},
  exchanges: [],
  questions: {},
}

test('image endpoint loads tool/result images (event.data.message.content) and subagent child images', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-tool-img-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const pagedAddresses = []
  const ctx = fakeContext({
    services: {
      attachments: {
        readImage: async () => ({ data: TINY_PNG }),
      },
    },
  })
  ctx.sessionController = {
    page: async ({ address }) => {
      pagedAddresses.push(address)
      if (address.kind === 'session' && address.sessionId === 'b1') {
        return {
          hasMore: false,
          records: [
            {
              event: {
                seq: 3,
                type: 'tool/result',
                data: {
                  callId: 'call-read-img',
                  message: {
                    content: [
                      { type: 'text', text: 'Read image diagram.png' },
                      {
                        type: 'image',
                        attachment: { attachmentId: 'att-tool-1', mediaType: 'image/png', width: 1, height: 1, bytes: TINY_PNG.length },
                      },
                    ],
                  },
                },
              },
            },
          ],
        }
      }
      if (address.kind === 'subagent' && address.parentSessionId === 'b1' && address.childSessionId === 'sub-9') {
        return {
          hasMore: false,
          records: [
            {
              event: {
                seq: 2,
                type: 'tool/result',
                data: {
                  callId: 'call-sub-img',
                  message: {
                    content: [
                      {
                        type: 'image',
                        attachment: { attachmentId: 'att-sub-1', mediaType: 'image/png', width: 1, height: 1, bytes: TINY_PNG.length },
                      },
                    ],
                  },
                },
              },
            },
          ],
        }
      }
      if (address.kind === 'subagent' && address.parentSessionId === 'sub-9' && address.childSessionId === 'sub-nested-2') {
        return {
          hasMore: false,
          records: [
            {
              event: {
                seq: 1,
                type: 'tool/result',
                data: {
                  callId: 'call-nested-img',
                  message: {
                    content: [
                      {
                        type: 'image',
                        attachment: { attachmentId: 'att-nested-1', mediaType: 'image/png', width: 1, height: 1, bytes: TINY_PNG.length },
                      },
                    ],
                  },
                },
              },
            },
          ],
        }
      }
      if (address.kind === 'subagent') {
        throw Object.assign(new Error('Unauthorized subagent'), { code: 'subagent/unauthorized' })
      }
      return { hasMore: false, records: [] }
    },
  }

  const routes = {}
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    routes[options.path] = options
    return register(options)
  }

  apply(ctx, { home })
  const callApi = async (endpoint, payload) => {
    const response = await routes['/api/bot'].fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }

  try {
    const res1 = await callApi('image', { sessionId: 'b1', attachmentId: 'att-tool-1', preview: true })
    assert.equal(res1.ok, true)
    assert.equal(res1.value.mime, 'image/png')
    assert.equal(res1.value.data, TINY_PNG.toString('base64'))

    const res2 = await callApi('image', { sessionId: 'sub-9', parent: 'b1', mode: 'one-shot', attachmentId: 'att-sub-1', preview: false })
    assert.equal(res2.ok, true)
    assert.equal(res2.value.mime, 'image/png')
    assert.equal(res2.value.data, TINY_PNG.toString('base64'))
    assert.deepEqual(pagedAddresses.at(-1), {
      kind: 'subagent',
      parentSessionId: 'b1',
      childSessionId: 'sub-9',
      mode: 'one-shot',
    })

    const badParent = await callApi('image', { sessionId: 'sub-9', parent: 'unknown-parent', attachmentId: 'att-sub-1' })
    assert.equal(badParent.ok, false)
    assert.equal(badParent.error.code, 'bot/not-found')

    // Nested subagent (b1 -> sub-9 -> sub-nested-2) succeeds when verified ancestors chain up to known root b1.
    const nestedRes = await callApi('image', {
      sessionId: 'sub-nested-2',
      parent: 'sub-9',
      mode: 'one-shot',
      ancestors: [{ sessionId: 'b1' }, { sessionId: 'sub-9', mode: 'one-shot' }],
      attachmentId: 'att-nested-1',
      preview: false,
    })
    assert.equal(nestedRes.ok, true)
    assert.equal(nestedRes.value.mime, 'image/png')

    // Forged ancestor hop is rejected by passive DSH hop verification.
    const forgedNested = await callApi('image', {
      sessionId: 'sub-nested-2',
      parent: 'sub-forged',
      ancestors: [{ sessionId: 'b1' }, { sessionId: 'sub-forged', mode: 'one-shot' }],
      attachmentId: 'att-nested-1',
    })
    assert.equal(forgedNested.ok, false)
    assert.equal(forgedNested.error.code, 'bot/not-found')
  } finally {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
})
