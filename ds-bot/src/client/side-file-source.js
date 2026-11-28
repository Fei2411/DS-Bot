// What the Side Apps know about a workspace file: its text and revision, kept per tab
// while the tab lives. A session reads through the host's `side-app-read` with the
// revision it already holds, so an unchanged file costs no text; answers are ordered
// per session so an older one never replaces a newer one. Nothing here is stored.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { call } from './api.js'
import { fileOf } from './side-apps.js'

export const POLL_MS = 2000
const BACKOFF_MAX_MS = 30_000
// Edits that land close together read as one change.
export const MERGE_MS = 400

/**
 * @param {(known: string|undefined) => Promise<object>} read the host read for this file
 */
export function createFileSession(read) {
  const listeners = new Set()
  let state = { status: 'loading', text: null, revision: null, base: null, baseRevision: null, reviewed: false, error: null, truncated: false, updatedAt: 0 }
  let order = 0
  let applied = 0
  let failures = 0
  let running = null
  const publish = (next) => { state = { ...state, ...next }; for (const listener of listeners) listener() }

  const classify = (error) => {
    const code = String(error?.code ?? '')
    if (code === 'bot/not-found') return 'missing'
    return 'error'
  }

  async function poll() {
    // Reads of one file never overlap: a second ask while one is out waits for it.
    if (running !== null) return running
    const mine = ++order
    running = (async () => {
      try {
        const answer = await read(state.revision ?? undefined)
        if (mine < applied) return state
        applied = mine
        failures = 0
        if (answer?.kind === 'unchanged') {
          if (state.status !== 'ready') publish({ status: 'ready', error: null })
          return state
        }
        if (answer?.kind !== 'text') throw Object.assign(new Error('unexpected answer'), { code: 'bot/error' })
        const first = state.revision === null
        publish({
          status: 'ready', text: answer.text, revision: answer.revision, error: null, updatedAt: Date.now(),
          // The first text read is the baseline until the user marks a later one reviewed.
          ...(first ? { base: answer.text, baseRevision: answer.revision } : {}),
        })
      } catch (error) {
        if (mine < applied) return state
        applied = mine
        failures += 1
        // A vanished file keeps its last text so a Diff against it survives the gap.
        publish({ status: classify(error), error: { code: error?.code ?? 'bot/error', message: String(error?.message ?? '') } })
      } finally { running = null }
      return state
    })()
    return running
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    poll,
    markReviewed: () => { if (state.revision !== null) publish({ base: state.text, baseRevision: state.revision, reviewed: true }) },
    setBase: (base, baseRevision) => publish({ base, baseRevision }),
    // The wait before the next read: the tick, stretched after misses.
    delay: () => Math.min(POLL_MS * 2 ** Math.min(failures, 4), BACKOFF_MAX_MS),
    stop: () => { listeners.clear() },
  }
}

// One session per tab and conversation, for as long as the tab is open. The conversation
// is part of the key: the same file opened from another conversation (or from an older
// part with another root) must not inherit what this one read.
const sessions = new Map()
const KEY_SEP = '\u0001'
export const sessionKey = tab => `${tab.sessionId ?? ''}${KEY_SEP}${tab.key}`
export function sessionFor(tab, readFile = (file, subject, known) => call('side-app-read', { sessionId: subject, file, ...(known ? { knownRevision: known } : {}) })) {
  const key = sessionKey(tab)
  let session = sessions.get(key)
  if (session === undefined) {
    session = createFileSession(known => readFile(fileOf(tab), tab.sessionId, known))
    sessions.set(key, session)
  }
  return session
}
// Closing a tab drops the reading state of that tab in its own conversation only: the
// same file open in another conversation keeps what it read and what was reviewed.
export function dropSession(tabKey, sessionId) {
  const own = key => key.endsWith(`${KEY_SEP}${tabKey}`) && (sessionId === undefined || key.startsWith(`${sessionId}${KEY_SEP}`))
  for (const key of [...sessions.keys()]) {
    if (own(key)) { sessions.get(key)?.stop(); sessions.delete(key) }
  }
}
/**
 * Keep `tick` going while `active`: once at once, then after each `delay`; paused while
 * the window is hidden, with an immediate check when it returns. Returns the stop.
 * The default timers wrap the globals in arrows: a browser's setTimeout/clearTimeout
 * throw Illegal invocation when they are invoked as properties of some other object
 * (`timers.set(...)`), so capturing them bare would kill the loop in a real browser.
 */
export function startPolling({ tick, delay, active, doc = typeof document === 'undefined' ? undefined : document, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) } }) {
  let timer = null
  let stopped = false
  const schedule = () => {
    if (stopped) return
    timers.clear(timer)
    timer = timers.set(run, delay())
  }
  const run = async () => {
    timer = null
    if (stopped || !active() || doc?.hidden === true) { schedule(); return }
    try { await tick() } catch { /* the session records its own failure */ }
    schedule()
  }
  const onVisible = () => { if (doc?.hidden !== true && !stopped) { timers.clear(timer); void run() } }
  doc?.addEventListener?.('visibilitychange', onVisible)
  void run()
  return () => {
    stopped = true
    timers.clear(timer)
    doc?.removeEventListener?.('visibilitychange', onVisible)
  }
}

/**
 * The live view of a tab's file. `active` is whether the tab is the one on screen and
 * not paused; the file is read only then, so a hidden tab costs nothing.
 */
export function useWorkspaceFile(tab, active) {
  const session = useMemo(() => sessionFor(tab), [tab.key, tab.sessionId])
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const on = useRef(active)
  on.current = active
  useEffect(() => {
    if (!active) return undefined
    return startPolling({ tick: session.poll, delay: session.delay, active: () => on.current })
  }, [session, active])
  return { ...snapshot, refresh: session.poll, markReviewed: session.markReviewed, session }
}

// ---- the host's diff base ------------------------------------------------------------

/**
 * What the host kept of the Bot's last write to this file, for the revision on screen.
 * Asked once per revision while `wanted`; `unavailable` leaves the client snapshot to it.
 */
export function useHostBase(tab, revision, wanted, request = (body) => call('side-app-diff', body)) {
  const [answer, setAnswer] = useState(null)
  // An answer belongs to the conversation and tab it was asked for, as well as the revision:
  // the same file at the same revision in another part has its own base.
  const owner = sessionKey(tab)
  useEffect(() => {
    if (!wanted || typeof revision !== 'string') return undefined
    let current = true
    request({ sessionId: tab.sessionId, file: fileOf(tab), revision }).then(
      (value) => { if (current) setAnswer({ ...value, forRevision: revision, forOwner: owner }) },
      () => { if (current) setAnswer({ kind: 'unavailable', forRevision: revision, forOwner: owner }) },
    )
    return () => { current = false }
  }, [tab.key, tab.sessionId, revision, wanted])
  return answer?.forRevision === revision && answer?.forOwner === owner ? answer : null
}

// ---- pictures beside an article ---------------------------------------------------------

// The only types an article's picture may be, checked again here whatever the host sends.
export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif'])
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024

function decodeBase64(data) {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * One picture from the host's `side-app-bytes`, as a Blob and its revision. `unchanged`
 * answers a revision the caller holds; anything outside the allowed types or size is refused.
 * @returns {Promise<{kind:'unchanged'}|{kind:'image', blob: Blob, revision: string, mime: string}>}
 */
export async function fetchImage(tab, path, known, request = (body) => call('side-app-bytes', body)) {
  // The host only serves images inside the article's own directory, so the request
  // names that article: the picture's path alone would read as a general workspace read.
  const answer = await request({ sessionId: tab.sessionId, file: { ...fileOf(tab), displayPath: path, article: fileOf(tab).displayPath }, ...(known ? { knownRevision: known } : {}) })
  if (answer?.kind === 'unchanged') return { kind: 'unchanged' }
  const mime = String(answer?.mime ?? '').toLowerCase()
  if (answer?.kind !== 'bytes' || !IMAGE_MIMES.has(mime) || typeof answer.data !== 'string') throw Object.assign(new Error('unexpected answer'), { code: 'bot/invalid' })
  const bytes = decodeBase64(answer.data)
  if (bytes.length > IMAGE_MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'bot/too-large' })
  return { kind: 'image', blob: new Blob([bytes], { type: mime }), revision: String(answer.revision ?? ''), mime }
}

/**
 * The address of an article's picture while it is on screen. The object URL is made here
 * and revoked when the picture changes or goes away; a later read of the same revision
 * keeps it. `version` is the article's own revision: a change asks the host again.
 * @returns {{status: 'loading'|'ready'|'error', url: string|null, code: string}}
 */
export function useArticleImage(tab, path, version, request, make = typeof URL === 'undefined' ? null : URL) {
  const [state, setState] = useState({ status: 'loading', url: null, code: '' })
  const held = useRef({ url: null, revision: null })
  useEffect(() => {
    let current = true
    fetchImage(tab, path, held.current.revision, request).then((got) => {
      if (!current || got.kind === 'unchanged') return
      const next = make.createObjectURL(got.blob)
      if (held.current.url) make.revokeObjectURL(held.current.url)
      held.current = { url: next, revision: got.revision }
      setState({ status: 'ready', url: next, code: '' })
    }, (error) => {
      if (!current) return
      setState(prev => (prev.url ? prev : { status: 'error', url: null, code: String(error?.code ?? 'bot/error') }))
    })
    return () => { current = false }
  }, [tab.key, tab.sessionId, path, version])
  useEffect(() => () => {
    if (held.current.url) make.revokeObjectURL(held.current.url)
    held.current = { url: null, revision: null }
  }, [tab.key, path])
  return state
}

// ---- the Canvas preview ----------------------------------------------------------

/**
 * The preview state after a host answer. The ticket's address and the content's revision
 * move independently: a renewed ticket comes back `unchanged` with a new address, and the
 * frame has to follow it or it keeps asking an address the host has let expire.
 */
export function nextPreview(prev, answer) {
  const frameUrl = answer.frameUrl ?? prev.frameUrl
  const previewRevision = answer.previewRevision ?? prev.previewRevision
  if (prev.status === 'ready' && prev.frameUrl === frameUrl && prev.previewRevision === previewRevision && prev.error === null) return prev
  return { status: 'ready', frameUrl, previewRevision, error: null, unavailable: null }
}

/**
 * The preview frame's address and revision for a Canvas tab. `frame` changes only when
 * the host reports a new `previewRevision`, which is when the iframe should swap.
 */
export function usePreview(tab, active, request = (body) => call('side-app-preview', body)) {
  const [state, setState] = useState({ status: 'loading', frameUrl: null, previewRevision: null, error: null, unavailable: null })
  const known = useRef(null)
  const order = useRef(0)
  const pull = async () => {
    const mine = ++order.current
    try {
      const answer = await request({ sessionId: tab.sessionId, file: fileOf(tab), ...(known.current ? { knownPreviewRevision: known.current } : {}) })
      if (mine < order.current) return
      if (answer?.kind === 'preview-unavailable') { setState(prev => ({ ...prev, status: 'unavailable', unavailable: answer.reason ?? '' })); return }
      if (answer?.previewRevision) known.current = answer.previewRevision
      // The ticket's address and the content's revision move on their own: a renewed ticket
      // comes back `unchanged` with a new address, and the frame has to follow it or it keeps
      // asking an address the host has let expire.
      if (answer?.kind === 'preview' || answer?.kind === 'unchanged') setState(prev => nextPreview(prev, answer))
    } catch (error) {
      if (mine < order.current) return
      setState(prev => ({ ...prev, status: String(error?.code) === 'bot/not-found' ? 'missing' : 'error', error: { code: error?.code, message: String(error?.message ?? '') } }))
    }
  }
  const on = useRef(active)
  on.current = active
  const failures = useRef(0)
  useEffect(() => {
    if (!active) return undefined
    // The first read of a tab is not merged; later ones wait the merge window out.
    return startPolling({
      tick: async () => { await pull(); failures.current = 0 },
      delay: () => POLL_MS,
      active: () => on.current,
    })
  }, [tab.key, tab.sessionId, active])
  // Leaving the tab drops what points at the ticket.
  useEffect(() => () => { known.current = null }, [tab.key, tab.sessionId])
  return { ...state, refresh: pull }
}
