// The first run's import on the start page's cards (windows-onboarding §4, start-window §6): the
// import card, the space and in-use cards, the check of the chats, the copy with its steps, its
// stop and its failure. What touches the disk, the engine and the window comes in as `io`, so
// that the order of the cards can be tested without any of them.
import { REGENERABLE_DEFAULT_BYTES } from './import.mjs'
import { formatBytes } from './place.mjs'

// The first stage needs this much more room than it copies (windows-onboarding §4).
export const SPARE_BYTES = 500e6
const CARD_EVERY_MS = 200
// The rate is not told before the copy has run this long.
const ETA_AFTER_MS = 3000
// The share of the ring's import arc that the check of the chats fills; the copy fills the rest.
const CHECK_SHARE = 0.15

/** How far the import arc is filled at a step of the copy (start-window §6). */
export function arcShare(step, fraction) {
  const f = Math.max(0, Math.min(1, fraction || 0))
  return step <= 1 ? CHECK_SHARE * f : step === 2 ? CHECK_SHARE + (1 - CHECK_SHARE) * f : 1
}

/**
 * The model settings an import offers, best first: those of DSH Desktop, then DSH Web, then the
 * profile with the most rows.
 * @param {{ name: string, rows: any[] }[]} profiles
 * @returns {{ id: string, label: string }[]}
 */
export function modelChoices(profiles) {
  const rank = name => ({ desktop: 0, web: 1 })[name] ?? 2
  const sorted = [...profiles].sort((a, b) => rank(a.name) - rank(b.name) || b.rows.length - a.rows.length)
  return sorted.map(profile => ({ id: profile.name, label: modelLabel(profile) }))
}

const PROFILE_NAMES = { desktop: 'DSH Desktop', web: 'DSH Web' }

function modelLabel({ name, rows }) {
  const model = rows.find(row => row?.id === 'agent-default-model')?.config?.model
  const from = PROFILE_NAMES[name] ?? name
  return typeof model === 'string' && model !== '' ? `${from} · ${model}` : from
}

/**
 * What the card counts and how much the copy takes with the options as they stand: the work files
 * without the regenerable folders when those are left out, and none when the work files wait.
 * @param {{ chats?: number, work?: number, regen?: number }} sizes
 * @param {{ regen: boolean, skipWork: boolean }} options
 */
export function copySize(sizes, options) {
  if (sizes.chats === undefined || sizes.work === undefined) return undefined
  const work = options.skipWork ? 0 : sizes.work - (options.regen ? sizes.regen ?? 0 : 0)
  return { chats: sizes.chats, work, total: sizes.chats + work }
}

/** The options the card starts with: regenerable folders of 200 MB and more stay behind. */
export const defaultOptions = sizes => ({ regen: (sizes.regen ?? 0) >= REGENERABLE_DEFAULT_BYTES, skipWork: false })

/**
 * The time left, in whole minutes: it changes only once it is a full minute away from the one on
 * the card, and under a minute it is 0 (「不到 1 分钟」), never counted down to nothing.
 * @param {number | null} shown the minutes on the card, null before there was a rate
 */
export function etaMinutes(shown, { done, total, elapsedMs }) {
  if (elapsedMs < ETA_AFTER_MS || done <= 0 || total <= 0) return shown
  const left = (Math.max(0, total - done) / done) * elapsedMs
  if (left < 60_000) return 0
  const minutes = Math.ceil(left / 60_000)
  return shown === null || shown === 0 || Math.abs(minutes - shown) >= 1 ? minutes : shown
}

/**
 * @typedef {{
 *   from: string, bots: number, rooms: number, names: string[], sessions: number,
 *   sizes: { chats?: number, work?: number, regen?: number }, profiles: { name: string, rows: any[] }[],
 * }} Offer
 * @typedef {{
 *   offer: Offer,
 *   ask: (card: object, options?: { settle?: Promise<unknown> }) => Promise<string | undefined>,
 *   show: (card: object) => void,
 *   room: () => { free?: number, drive?: string },
 *   inUse: () => boolean,
 *   until: (check: () => boolean, signal: AbortSignal) => Promise<void>,
 *   check: (signal: AbortSignal, onProgress: (done: number, total: number) => void) => Promise<number>,
 *   warmed: () => Promise<unknown>,
 *   copy: (options: { profile?: string, leaveRegenerable: boolean, skipWork: boolean, signal: AbortSignal, onProgress: (bytes: number) => void }) => Promise<any>,
 *   reasonOf: (error: unknown) => string,
 *   progress?: (fraction: number) => void,
 *   now?: () => number,
 *   lang?: string,
 *   signal: AbortSignal,
 * }} ImportIo
 */

/**
 * One import, from the card to the copied team. `act()` takes the card's acts that are not an
 * answer (a model, an option, the stop and its confirmation) while `run()` waits.
 */
export class ImportFlow {
  #io
  #now
  #models
  #profile
  #options
  #sizes
  // The check of the chats, started while the card is up (stale once a holder came meanwhile).
  #check
  #checkAbort
  // The copying card as it stands.
  #copyCard
  #shownAt = 0
  #timer
  #lastStep = 0

  /** @param {ImportIo} io */
  constructor(io) {
    this.#io = io
    this.#now = io.now ?? Date.now
    this.#models = modelChoices(io.offer.profiles)
    this.#profile = this.#models[0]?.id
    this.#sizes = io.offer.sizes
    this.#options = defaultOptions(this.#sizes)
  }

  /** The import card as the options stand. */
  card() {
    const { offer } = this.#io
    const size = copySize(this.#sizes, this.#options)
    const model = this.#models.find(entry => entry.id === this.#profile)
    return {
      kind: 'import', bots: offer.bots, groups: offer.rooms, sessions: offer.sessions, path: offer.from,
      names: offer.names.slice(0, 3).join(this.#io.lang === 'en' ? ', ' : '、'),
      bare: size === undefined ? 'Bare' : '',
      ...(size === undefined ? {} : { chats: formatBytes(size.chats, this.#io.lang), work: formatBytes(size.work, this.#io.lang), total: formatBytes(size.total, this.#io.lang) }),
      model: model?.label ?? '', models: this.#models.length > 1 ? this.#models : [],
      options: { ...this.#options },
    }
  }

  /**
   * The acts of the import and copying cards that do not answer them.
   * @param {string} name @param {any} value
   */
  act(name, value) {
    if (name === 'importModel' && this.#models.some(entry => entry.id === value)) {
      this.#profile = value
      this.#io.show(this.card())
    } else if (name === 'importOption' && value !== null && typeof value === 'object' && ['regen', 'skipWork'].includes(value.option)) {
      this.#options = { ...this.#options, [value.option]: value.value === true }
      this.#io.show(this.card())
    }
  }

  /**
   * @returns {Promise<{ outcome: 'copied', summary: any } | { outcome: 'skipped' | 'pick' | 'gone', newer?: true }>}
   *   'skipped': the start goes on with a new team; 'pick': another place is to be picked;
   *   'gone': the app quits, another start replaced this one, or the failure page took over
   */
  async run() {
    const io = this.#io
    try {
      this.#startCheck()
      const answer = await io.ask(this.card())
      if (answer !== 'copy') return { outcome: answer === 'skip' ? 'skipped' : answer === 'pick' ? 'pick' : 'gone' }
      const short = this.#short()
      if (short !== undefined) {
        const next = await io.ask({ kind: 'importSpace', ...short })
        return { outcome: next === 'skip' ? 'skipped' : next === 'pick' ? 'pick' : 'gone' }
      }
      return await this.#copyLoop()
    } finally {
      clearTimeout(this.#timer)
      this.#checkAbort?.abort()
      io.progress?.(-1)
    }
  }

  // The space the first stage needs and the drive has, when it has too little.
  #short() {
    const size = copySize(this.#sizes, this.#options)
    const { free, drive } = this.#io.room()
    if (size === undefined || free === undefined) return undefined
    const need = size.total + SPARE_BYTES
    if (free >= need) return undefined
    const text = bytes => formatBytes(bytes, this.#io.lang)
    return { need: text(need), free: text(free), short: text(need - free), drive: drive ?? '' }
  }

  // The chats are checked while the card is up, unless DSH holds the team: a check of chats that
  // are being written would say nothing. A holder that turns up meanwhile makes it stale.
  #startCheck() {
    this.#checkAbort?.abort()
    this.#check = undefined
    if (this.#io.inUse()) return
    const abort = new AbortController()
    this.#checkAbort = abort
    const signal = AbortSignal.any([abort.signal, this.#io.signal])
    const state = { progress: { done: 0, total: this.#io.offer.sessions }, listener: () => {}, stale: false }
    this.#check = state
    state.result = this.#io.check(signal, (done, total) => {
      state.progress = { done, total }
      state.listener(done, total)
    })
    // A rejected check that nobody waits for yet must not go unhandled.
    state.result.catch(() => {})
    void this.#io.until(() => this.#io.inUse(), signal).then(() => {
      if (signal.aborted) return
      state.stale = true
      abort.abort()
    })
  }

  // 「DeepSeek Harness 还在用这个团队」: looks again every 2 s and goes on by itself once DSH lets go.
  async #waitFree() {
    const io = this.#io
    const free = new AbortController()
    const next = await io.ask({ kind: 'inUse' }, { settle: io.until(() => !io.inUse(), AbortSignal.any([free.signal, io.signal])) })
    free.abort()
    return next === 'settled' ? undefined : { outcome: next === 'skip' ? 'skipped' : 'gone' }
  }

  async #copyLoop() {
    const io = this.#io
    for (;;) {
      const signal = io.signal
      try {
        const unreadable = await this.#checked(signal)
        if (typeof unreadable === 'object') return unreadable
        if (unreadable > 0) {
          const next = await io.ask({ kind: 'newer', n: unreadable })
          return next === 'startWithout' ? { outcome: 'skipped', newer: true } : { outcome: 'gone' }
        }
        const size = copySize(this.#sizes, this.#options)
        const total = size?.total ?? 0
        const of = size === undefined ? '…' : formatBytes(total, io.lang)
        const checkedStep = this.#copyCard?.steps?.[0] ?? {}
        let eta = null
        this.#setCopy({ step: 2, steps: [checkedStep, { a: formatBytes(0, io.lang), b: of }, {}], fraction: 0, eta: null })
        await io.warmed()
        signal.throwIfAborted()
        const started = this.#now()
        const summary = await io.copy({
          profile: this.#profile, leaveRegenerable: this.#options.regen, skipWork: this.#options.skipWork, signal,
          onProgress: (bytes) => {
            const done = total > 0 ? Math.min(bytes, total) : bytes
            eta = etaMinutes(eta, { done, total, elapsedMs: this.#now() - started })
            this.#setCopy({ step: 2, steps: [checkedStep, { a: formatBytes(done, io.lang), b: of }, {}], fraction: total > 0 ? done / total : 0, eta })
          },
        })
        this.#setCopy({ step: 3, steps: [checkedStep, { ...this.#copyCard.steps[1], a: of === '…' ? this.#copyCard.steps[1].a : of }, {}], fraction: 0, eta: null }, true)
        return { outcome: 'copied', summary }
      } catch (error) {
        // A quit or another start: the copy stopped at a safe point and nothing of it stays.
        if (io.signal.aborted) return { outcome: 'gone' }
        const message = error instanceof Error ? error.message : String(error)
        const next = await io.ask({ kind: 'importFailed', reason: io.reasonOf(error), log: message.split('\n') })
        if (next !== 'retry') return { outcome: next === 'startWithout' ? 'skipped' : 'gone' }
        this.#copyCard = undefined
      }
    }
  }

  // Step 1, the check: the one the card started while it is still good, else a new one, once DSH
  // has let go of the team. The unreadable chats, or the outcome when the user would not wait.
  async #checked(signal) {
    const step1 = (done, total) => {
      this.#setCopy({ step: 1, steps: [{ a: done, b: total }, {}, {}], fraction: total > 0 ? done / total : 0, eta: null })
    }
    for (;;) {
      if (this.#check === undefined || this.#check.stale) {
        if (this.#io.inUse()) {
          const away = await this.#waitFree()
          if (away !== undefined) return away
        }
        this.#startCheck()
        if (this.#check === undefined) continue
      }
      const check = this.#check
      check.listener = step1
      step1(check.progress.done, check.progress.total)
      const unreadable = await Promise.race([check.result, aborted(signal)])
      signal.throwIfAborted()
      if (!check.stale) return unreadable
    }
  }

  #setCopy(card, now = false) {
    this.#copyCard = card
    this.#showCopy(now)
  }

  // The copying card goes out at most every 200 ms; a new step or the stop goes at once.
  #showCopy(now) {
    const card = this.#copyCard
    if (card === undefined) return
    const send = () => {
      this.#timer = undefined
      this.#shownAt = this.#now()
      const { steps, step, fraction } = this.#copyCard
      this.#lastStep = step
      this.#io.progress?.(Math.min(1, (step - 1 + Math.max(0, Math.min(1, fraction))) / 3))
      this.#io.show({ ...this.#copyCard, kind: 'copying', steps: steps.map(entry => ({ ...entry })), arc: arcShare(step, fraction) })
    }
    const due = this.#shownAt + CARD_EVERY_MS - this.#now()
    if (now || due <= 0 || this.#lastStep !== card.step) {
      clearTimeout(this.#timer)
      send()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(send, due)
    }
  }
}

// Rejects once `signal` stops.
function aborted(signal) {
  return new Promise((resolve, reject) => {
    const away = () => { reject(signal.reason ?? new Error('stopped')) }
    if (signal.aborted) away()
    else signal.addEventListener('abort', away, { once: true })
  })
}
