import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, before, test } from 'node:test'
import { hasActiveTransferHolds } from './transfer-hold.ts'

let hooks: ReturnType<typeof registerHooks> | undefined
let downloadFileFn: (call: (endpoint: string, payload: object) => Promise<unknown>, target: object) => Promise<{ uri: string; name: string; mime: string }>

interface MockFsControl {
  dirCreateThrows?: Error
  dirDeleteThrows?: Error
  deletedDirs: number
  closedHandles: number
  writtenChunks: Uint8Array[]
}

const fsControl: MockFsControl = {
  deletedDirs: 0,
  closedHandles: 0,
  writtenChunks: [],
}

before(async () => {
  ;(globalThis as any).__fileDownloadTestFs = fsControl
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'expo-file-system') {
        return { url: 'mock:expo-file-system', shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'mock:expo-file-system') {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            export const Paths = { cache: '/mock-cache' }
            export const FileMode = { Truncate: 'truncate' }
            export class Directory {
              constructor(...parts) { this.uri = parts.join('/') }
              create() {
                if (globalThis.__fileDownloadTestFs.dirCreateThrows) {
                  throw globalThis.__fileDownloadTestFs.dirCreateThrows
                }
              }
              delete() {
                globalThis.__fileDownloadTestFs.deletedDirs += 1
                if (globalThis.__fileDownloadTestFs.dirDeleteThrows) {
                  throw globalThis.__fileDownloadTestFs.dirDeleteThrows
                }
              }
            }
            export class File {
              constructor(dir, name) {
                this.name = name
                this.uri = dir.uri + '/' + name
              }
              create() {}
              open() {
                return {
                  async writeBytes(bytes) {
                    globalThis.__fileDownloadTestFs.writtenChunks.push(bytes)
                  },
                  close() {
                    globalThis.__fileDownloadTestFs.closedHandles += 1
                  },
                }
              }
            }
          `,
        }
      }
      return nextLoad(url, context)
    },
  })
  const mod = await import('./file-download.ts')
  downloadFileFn = mod.downloadFile
})

after(() => {
  hooks?.deregister()
  delete (globalThis as any).__fileDownloadTestFs
})

test('downloadFile does not leak a transfer hold if dir.create throws', async () => {
  fsControl.dirCreateThrows = new Error('ENOSPC: no space left on device')
  fsControl.dirDeleteThrows = undefined
  fsControl.deletedDirs = 0
  try {
    await assert.rejects(
      () => downloadFileFn(async () => { assert.fail('call should not run after dir.create throws') }, { id: 'f1' }),
      /ENOSPC/,
    )
    assert.equal(hasActiveTransferHolds(), false)
  } finally {
    fsControl.dirCreateThrows = undefined
  }
})

test('downloadFile holds transfer during streaming, cleans up on error even if dir.delete throws, and releases hold', async () => {
  fsControl.dirCreateThrows = undefined
  fsControl.dirDeleteThrows = new Error('delete failed')
  fsControl.deletedDirs = 0
  fsControl.closedHandles = 0
  fsControl.writtenChunks = []

  let sawHoldDuringCall = false
  await assert.rejects(
    () => downloadFileFn(async () => {
      sawHoldDuringCall = hasActiveTransferHolds()
      throw new Error('network dropped')
    }, { id: 'f2' }),
    /network dropped/,
  )
  assert.equal(sawHoldDuringCall, true)
  assert.equal(fsControl.deletedDirs, 1)
  assert.equal(hasActiveTransferHolds(), false)

  // Happy path writes chunks and releases hold cleanly.
  fsControl.dirDeleteThrows = undefined
  fsControl.deletedDirs = 0
  let sawHoldOnSuccess = false
  const result = await downloadFileFn(async () => {
    sawHoldOnSuccess = hasActiveTransferHolds()
    return { name: 'report.txt', mime: 'text/plain', bytes: btoa('hello'), nextOffset: 5, done: true, version: 'v1' }
  }, { id: 'f3' })
  assert.equal(sawHoldOnSuccess, true)
  assert.equal(hasActiveTransferHolds(), false)
  assert.equal(result.name, 'report.txt')
  assert.equal(result.mime, 'text/plain')
  assert.equal(fsControl.writtenChunks.length, 1)
  assert.equal(fsControl.closedHandles, 1)
})
