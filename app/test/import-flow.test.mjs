// The first run's import on the start page's cards: what each card says, the order of the cards,
// and what the copy does with the answers. The disk, the engine and the window are test doubles.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arcShare, copySize, defaultOptions, etaMinutes, ImportFlow, modelChoices } from '../src/import-flow.mjs'

const GB = 2 ** 30
const tick = () => new Promise((resolve) => { setImmediate(resolve) })

// An import of six Bots with 1.2 GB of chats and 3.4 GB of work files, 0.4 GB of them regenerable.
function harness({ inUse = () => false, free = 100 * GB, check = async () => 0, copy, sizes, profiles } = {}) {
  const cards = []
  const shown = []
  const answers = []
  let respond
  const io = {
    offer: {
      from: '/home/user/.dsh', bots: 6, rooms: 2, names: ['Chief', 'Writer', 'Coder', 'Tester'], sessions: 3,
      sizes: sizes ?? { sessions: 3, chats: 1.2 * GB, work: 3.4 * GB, regen: 0.4 * GB },
      profiles: profiles ?? [{ name: 'web', rows: [{ id: 'llm-deepseek' }] }, { name: 'desktop', rows: [{ id: 'agent-default-model', config: { model: 'deepseek/v4' } }] }],
    },
    ask: (card, options) => {
      cards.push(card)
      return new Promise((resolve) => {
        respond = resolve
        void options?.settle?.then(() => { resolve('settled') })
        if (answers.length > 0) resolve(answers.shift())
      })
    },
    show: (card) => { shown.push(card) },
    room: () => ({ free, drive: 'C' }),
    inUse,
    until: async (check, signal) => { while (!signal.aborted && !check()) await tick() },
    check: async (signal, onProgress) => { onProgress(3, 3); return check(signal) },
    warmed: async () => {},
    copy: copy ?? (async ({ onProgress }) => { onProgress(2.6 * GB); return { bots: 6, sessions: 3, from: '/home/user/.dsh' } }),
    reasonOf: () => 'other',
    lang: 'zh',
    signal: new AbortController().signal,
  }
  return { io, cards, shown, answer: (value) => { if (respond) { const r = respond; respond = undefined; r(value) } else answers.push(value) } }
}

test('the model settings of DSH Desktop come first, then DSH Web, then the profile with most rows', () => {
  const choices = modelChoices([
    { name: 'other', rows: [{}, {}, {}] },
    { name: 'web', rows: [{}] },
    { name: 'spare', rows: [{}] },
    { name: 'desktop', rows: [{ id: 'agent-default-model', config: { model: 'deepseek/v4' } }] },
  ])
  assert.deepEqual(choices.map(choice => choice.id), ['desktop', 'web', 'other', 'spare'])
  assert.equal(choices[0].label, 'DSH Desktop · deepseek/v4')
  assert.equal(choices[1].label, 'DSH Web')
})

test('the regenerable folders stay behind by default from 200 MB on, and the sizes follow the options', () => {
  const sizes = { chats: 1.2 * GB, work: 3.4 * GB, regen: 0.4 * GB }
  assert.deepEqual(defaultOptions(sizes), { regen: true, skipWork: false })
  assert.deepEqual(defaultOptions({ ...sizes, regen: 0.1 * GB }), { regen: false, skipWork: false })
  assert.equal(copySize(sizes, { regen: true, skipWork: false }).work, 3 * GB)
  assert.equal(copySize(sizes, { regen: false, skipWork: false }).total, 4.6 * GB)
  assert.equal(copySize(sizes, { regen: true, skipWork: true }).total, 1.2 * GB)
  assert.equal(copySize({ chats: 1 }, { regen: false, skipWork: false }), undefined, 'sizes that ran out of time are not guessed')
})

test('the time left is in whole minutes, moves a full minute at a time and never counts down to 0', () => {
  assert.equal(etaMinutes(null, { done: 1, total: 10, elapsedMs: 1000 }), null, 'no rate in the first 3 s')
  assert.equal(etaMinutes(null, { done: 1, total: 10, elapsedMs: 60_000 }), 9)
  assert.equal(etaMinutes(9, { done: 1.05, total: 10, elapsedMs: 60_000 }), 9, 'under a minute of change keeps the number')
  assert.equal(etaMinutes(9, { done: 2, total: 10, elapsedMs: 60_000 }), 4)
  assert.equal(etaMinutes(4, { done: 99, total: 100, elapsedMs: 600_000 }), 0, 'under a minute is 「不到 1 分钟」')
})

test('the import card says what it found, what the copy takes and which model settings go along', async () => {
  const { io, cards, answer } = harness()
  const flow = new ImportFlow(io)
  const run = flow.run()
  await tick()
  const card = cards[0]
  assert.equal(card.kind, 'import')
  assert.deepEqual([card.bots, card.groups, card.sessions, card.path], [6, 2, 3, '/home/user/.dsh'])
  assert.equal(card.names, 'Chief、Writer、Coder')
  assert.deepEqual([card.chats, card.work, card.total, card.bare], ['1.2 GB', '3.0 GB', '4.2 GB', ''])
  assert.equal(card.model, 'DSH Desktop · deepseek/v4')
  assert.deepEqual(card.models.map(model => model.id), ['desktop', 'web'])
  assert.deepEqual(card.options, { regen: true, skipWork: false })
  answer('skip')
  assert.deepEqual(await run, { outcome: 'skipped' })
})

test('the card follows a changed model and options, and the copy takes them', async () => {
  let taken
  const { io, shown, answer } = harness({ copy: async (options) => { taken = options; return { bots: 6, sessions: 3 } } })
  const flow = new ImportFlow(io)
  const run = flow.run()
  await tick()
  flow.act('importModel', 'web')
  flow.act('importOption', { option: 'skipWork', value: true })
  flow.act('importOption', { option: 'elsewhere', value: true })
  flow.act('importModel', 'nowhere')
  assert.equal(shown.length, 2, 'unknown models and options change nothing')
  assert.equal(shown.at(-1).model, 'DSH Web')
  assert.equal(shown.at(-1).total, '1.2 GB')
  answer('copy')
  const result = await run
  assert.equal(result.outcome, 'copied')
  assert.equal(taken.profile, 'web')
  assert.equal(taken.skipWork, true)
  assert.equal(taken.leaveRegenerable, true)
})

test('sizes that took too long leave the numbers out of the card instead of guessing', async () => {
  const { io, cards, answer } = harness({ sizes: { sessions: 3 } })
  const run = new ImportFlow(io).run()
  await tick()
  assert.equal(cards[0].bare, 'Bare')
  assert.equal(cards[0].total, undefined)
  answer('copy')
  assert.equal((await run).outcome, 'copied', 'no space check without sizes')
})

test('a drive without room for the copy and 500 MB says how much is missing', async () => {
  const { io, cards, answer } = harness({ free: 4 * GB })
  const run = new ImportFlow(io).run()
  await tick()
  answer('copy')
  await tick()
  assert.equal(cards[1].kind, 'importSpace')
  assert.deepEqual([cards[1].need, cards[1].free, cards[1].short, cards[1].drive], ['4.6 GB', '4.0 GB', '681 MB', 'C'])
  answer('pick')
  assert.deepEqual(await run, { outcome: 'pick' })
})

test('「换个位置…」 on the import card picks another place for the import', async () => {
  const { io, answer } = harness()
  const run = new ImportFlow(io).run()
  await tick()
  answer('pick')
  assert.deepEqual(await run, { outcome: 'pick' })
})

test('a team that DSH holds waits on its card and the copy goes on by itself once DSH lets go', async () => {
  let held = true
  let checks = 0
  const { io, cards, answer } = harness({ inUse: () => held, check: async () => { checks += 1; return 0 } })
  const run = new ImportFlow(io).run()
  await tick()
  assert.equal(checks, 0, 'chats that DSH is writing are not checked')
  answer('copy')
  while (cards.length < 2) await tick()
  assert.equal(cards[1].kind, 'inUse')
  held = false
  assert.equal((await run).outcome, 'copied')
  assert.equal(checks, 1, 'the chats are checked once DSH let go')
})

test('a holder that comes while the card checks the chats makes that check count for nothing', async () => {
  let held = false
  let checks = 0
  const { io, cards, answer } = harness({
    inUse: () => held,
    check: async (signal) => {
      checks += 1
      if (checks === 1) await new Promise((resolve) => { signal.addEventListener('abort', resolve) })
      return 0
    },
  })
  const run = new ImportFlow(io).run()
  await tick()
  held = true
  await tick()
  await tick()
  answer('copy')
  while (cards.length < 2) await tick()
  assert.equal(cards[1].kind, 'inUse')
  held = false
  assert.equal((await run).outcome, 'copied')
  assert.equal(checks, 2)
})

test('the copying card counts the checked chats, then the bytes, then starts the team', async () => {
  const { io, shown, answer } = harness()
  const run = new ImportFlow(io).run()
  await tick()
  answer('copy')
  const result = await run
  assert.equal(result.outcome, 'copied')
  const copying = shown.filter(card => card.kind === 'copying')
  assert.deepEqual(copying[0].steps[0], { a: 3, b: 3 })
  assert.equal(copying.at(-1).step, 3)
  assert.equal(copying.at(-1).steps[1].b, '4.2 GB')
  assert.ok(copying.some(card => card.step === 2), 'the copy shows its own step')
  // The ring's import arc fills with it and never goes back.
  const arcs = copying.map(card => card.arc)
  assert.deepEqual(arcs.slice(1).filter((arc, k) => arc < arcs[k]), [])
  assert.equal(arcs.at(-1), 1)
})

test("the check of the chats fills the import arc's first 15 %, the copy the rest", () => {
  assert.equal(arcShare(1, 0), 0)
  assert.equal(arcShare(1, 1), 0.15)
  assert.equal(arcShare(2, 0), 0.15)
  assert.equal(arcShare(2, 0.5), 0.575)
  assert.equal(arcShare(2, 2), 1)
  assert.equal(arcShare(3, 0), 1)
})

// The copy has no stop button (the user's decision, start-window §6): a quit, or closing the
// window, stops it at a safe point, and nothing of it stays.
test('a quit during the copy stops it and leaves no team', async () => {
  let release
  let stopped = false
  const quit = new AbortController()
  const { io, shown, answer } = harness({
    copy: ({ signal }) => new Promise((resolve, reject) => {
      release = () => { resolve({ bots: 6, sessions: 3 }) }
      signal.addEventListener('abort', () => { stopped = true; reject(new Error('stopped')) })
    }),
  })
  io.signal = quit.signal
  const flow = new ImportFlow(io)
  const run = flow.run()
  await tick()
  answer('copy')
  while (release === undefined) await tick()
  assert.equal(shown.at(-1).kind, 'copying')
  // The acts of the stop that the page no longer has change nothing.
  flow.act('stopCopy', 'confirm')
  await tick()
  assert.equal(stopped, false)
  quit.abort()
  assert.deepEqual(await run, { outcome: 'gone' })
  assert.equal(stopped, true, 'the copy was told to stop')
})

test('chats newer than this DSH reads say so, and the start goes on without the team', async () => {
  let copied = false
  const { io, cards, answer } = harness({ check: async () => 2, copy: async () => { copied = true } })
  const run = new ImportFlow(io).run()
  await tick()
  answer('copy')
  while (cards.length < 2) await tick()
  assert.deepEqual(cards[1], { kind: 'newer', n: 2 })
  answer('startWithout')
  assert.deepEqual(await run, { outcome: 'skipped', newer: true })
  assert.equal(copied, false)
})

test('a failed copy offers to try again, and the second copy can go through', async () => {
  let tries = 0
  const { io, cards, answer } = harness({
    copy: async () => {
      tries += 1
      if (tries === 1) throw new Error('EBUSY: resource busy\nmore')
      return { bots: 6, sessions: 3 }
    },
  })
  io.reasonOf = () => 'inUse'
  const run = new ImportFlow(io).run()
  await tick()
  answer('copy')
  while (cards.length < 2) await tick()
  assert.deepEqual(cards[1], { kind: 'importFailed', reason: 'inUse', log: ['EBUSY: resource busy', 'more'] })
  answer('retry')
  assert.equal((await run).outcome, 'copied')
  assert.equal(tries, 2)
})

test('a quit or another start while a card waits ends the import without an answer', async () => {
  const quit = new AbortController()
  const { io } = harness()
  io.signal = quit.signal
  io.ask = (card, options) => new Promise((resolve) => { quit.signal.addEventListener('abort', () => { resolve(undefined) }); void options })
  const run = new ImportFlow(io).run()
  await tick()
  quit.abort()
  assert.deepEqual(await run, { outcome: 'gone' })
})
