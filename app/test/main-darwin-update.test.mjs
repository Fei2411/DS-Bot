// A packaged macOS start in the test harness must never fetch GitHub Releases from the
// network or pop an update card over unrelated main-process tests.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { handOff, startApp, waitFor, window, windowCards } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

Object.defineProperty(process, 'platform', { value: 'darwin' })

test('startApp on darwin never fetches GitHub Releases or pops a live update card', async () => {
  const fetched = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    fetched.push(target)
    if (target.startsWith('https://')) {
      return new Response(JSON.stringify([{
        tag_name: 'v9.9.9',
        html_url: 'https://github.com/Fei2411/DS-Bot/releases/tag/v9.9.9',
        draft: false,
        prerelease: false,
        assets: [{ name: `DS-Bot-9.9.9-mac-${process.arch}.zip` }],
      }]), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return origFetch(url, init)
  }

  try {
    await startApp()
    await waitFor(() => window() !== undefined, 'open the window')
    await waitFor(() => state.tray !== undefined, 'build the tray')
    hostState.release()
    await handOff()
    await new Promise(resolve => { setTimeout(resolve, 50) })
    assert.equal(fetched.some(url => url.startsWith('https://api.github.com/')), false, `unexpected live release fetch: ${fetched.join(', ')}`)
    assert.deepEqual(windowCards(window()), [], 'no live update card should appear')
  } finally {
    globalThis.fetch = origFetch
    app.quit()
    await waitFor(() => state.tray?.destroyed === true, 'take the tray away')
  }
})
