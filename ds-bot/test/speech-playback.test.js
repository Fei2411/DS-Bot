import { test } from 'node:test'
import assert from 'node:assert/strict'
import { billedLength, bytesOf, createSpeechPlayer, playClip, replyVoice, settleSpeech, splitSpeech } from '../src/client/speech-playback.js'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

// An audio element stub: play() does not end on its own, so the test drives
// ended/failed/abort in the order it wants.
class FakeAudio {
  static all = []
  constructor() { FakeAudio.all.push(this); this.paused = true; this.src = '' }
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
  removeAttribute() { this.src = '' }
  end() { this.onended?.() }
  fail() { this.onerror?.() }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10))
const urls = []
const setup = () => {
  FakeAudio.all = []
  urls.length = 0
  globalThis.Audio = FakeAudio
  const made = []
  globalThis.URL.createObjectURL = () => { const url = `blob:${made.length}`; made.push(url); return url }
  globalThis.URL.revokeObjectURL = url => urls.push(url)
  return made
}
const clip = base64 => ({ audioBase64: base64, mediaType: 'audio/wav' })

test('billedLength counts Han characters double, on every plane', () => {
  assert.equal(billedLength('hello world'), 11)
  assert.equal(billedLength('你好'), 4)
  assert.equal(billedLength('a好b'), 4)
  // Extension B (supplementary plane, a surrogate pair) is still one character
  // that bills as 2; an emoji is not Han and bills as 1.
  assert.equal(billedLength('𠀀'), 2)
  assert.equal(billedLength('𠀀𠀀𠀀'), 6)
  assert.equal(billedLength('😀'), 1)
  assert.equal(billedLength('한'), 1)
  assert.equal(billedLength('あ'), 1)
})

test('splitSpeech keeps short text whole and splits on sentence ends', () => {
  assert.deepEqual(splitSpeech('Hello there.'), ['Hello there.'])
  assert.deepEqual(splitSpeech('One. Two! Three?'), ['One.', 'Two!', 'Three?'])
  assert.deepEqual(splitSpeech('第一句。第二句！'), ['第一句。', '第二句！'])
  assert.deepEqual(splitSpeech('Para one.\n\nPara two.'), ['Para one.', 'Para two.'])
  assert.deepEqual(splitSpeech('  \n \n'), [])
})

test('splitSpeech never exceeds the billed limit, Chinese included', () => {
  const limit = 20
  const long = 'word '.repeat(30)
  for (const chunk of splitSpeech(long, limit)) assert.ok(billedLength(chunk) <= limit, chunk)
  // A Chinese run has no gaps: it cuts at the limit without dropping text.
  const chinese = '汉'.repeat(15)
  const pieces = splitSpeech(chinese, limit)
  assert.equal(pieces.join(''), chinese)
  for (const chunk of pieces) assert.ok(billedLength(chunk) <= limit, chunk)
  // The first oversize character still goes alone rather than being dropped.
  assert.deepEqual(splitSpeech('汉', 1), ['汉'])
})

test('splitSpeech prefers a clause break over a mid-word cut', () => {
  const text = `${'a'.repeat(10)}, ${'b'.repeat(30)}`
  const pieces = splitSpeech(text, 20)
  assert.equal(pieces[0], `${'a'.repeat(10)},`)
  assert.ok(billedLength(pieces.join(' ')) >= billedLength(text) - 1)
})

test('replyVoice names the cloud voice only for the deepseek pref', () => {
  assert.equal(replyVoice({ deepseekServices: { tts: 'deepseek', voice: 'tide' } }), 'tide')
  assert.equal(replyVoice({ deepseekServices: { tts: 'deepseek' } }), 'stella')
  assert.equal(replyVoice({ deepseekServices: { tts: 'deepseek', voice: 'other' } }), 'stella')
  assert.equal(replyVoice({ deepseekServices: { tts: 'system', voice: 'tide' } }), null)
  assert.equal(replyVoice({}), null)
  assert.equal(replyVoice(undefined), null)
})

test('bytesOf decodes base64', () => {
  assert.deepEqual([...bytesOf('AQID')], [1, 2, 3])
})

test('playClip plays, then revokes its URL', async () => {
  const made = setup()
  const done = playClip(clip('AQID'), new AbortController().signal)
  await tick()
  const audio = FakeAudio.all[0]
  assert.equal(audio.paused, false)
  assert.equal(made.length, 1)
  audio.end()
  assert.equal(await done, 'done')
  assert.deepEqual(urls, made)
})

test('playClip aborts and revokes; a pre-aborted signal plays nothing', async () => {
  const made = setup()
  const abort = new AbortController()
  const done = playClip(clip('AQID'), abort.signal)
  await tick()
  abort.abort()
  assert.equal(await done, 'aborted')
  assert.equal(FakeAudio.all[0].paused, true)
  assert.deepEqual(urls, made)
  assert.equal(await playClip(clip('AQID'), AbortSignal.abort()), 'aborted')
  assert.equal(made.length, 1)
})

test('the player requests chunks serially, only after the previous clip ends', async () => {
  setup()
  const calls = []
  const player = createSpeechPlayer(async (text, voice, signal) => { calls.push([text, voice, signal.aborted]); return clip('AQID') })
  const said = player.say('One. Two. Three.', 'tide')
  await tick()
  assert.equal(calls.length, 1)
  FakeAudio.all[0].end()
  await tick()
  assert.equal(calls.length, 2)
  FakeAudio.all[1].end()
  await tick()
  assert.equal(calls.length, 3)
  FakeAudio.all[2].end()
  assert.equal(await said, 'done')
  assert.deepEqual(calls.map(call => call[0]), ['One.', 'Two.', 'Three.'])
  assert.deepEqual(calls.map(call => call[1]), ['tide', 'tide', 'tide'])
  // Every chunk got its own live signal; nothing arrived pre-aborted.
  assert.deepEqual(calls.map(call => call[2]), [false, false, false])
})

test('stop during playback aborts the clip and fetches nothing more', async () => {
  setup()
  const calls = []
  const player = createSpeechPlayer(async (text) => { calls.push(text); return clip('AQID') })
  const said = player.say('One. Two. Three.', 'stella')
  await tick()
  player.stop()
  assert.equal(await said, 'aborted')
  assert.equal(FakeAudio.all[0].paused, true)
  await tick()
  assert.equal(calls.length, 1)
})

test('stop during a request aborts it and a late answer plays nothing', async () => {
  const made = setup()
  let release
  let seenSignal
  const player = createSpeechPlayer((text, voice, signal) => { seenSignal = signal; return new Promise(resolve => { release = resolve }) })
  const said = player.say('Hello.', 'stella')
  await tick()
  player.stop()
  assert.equal(seenSignal.aborted, true)
  release(clip('AQID'))
  assert.equal(await said, 'aborted')
  await tick()
  assert.equal(FakeAudio.all.length, 0)
  assert.equal(made.length, 0)
})

test('a replaced say resolving late keeps the new speech\'s abort live', async () => {
  // say(old pending) → say(new pending) → old resolves → stop(): the late
  // answer must not clear the controller the new request is still using.
  const signals = []
  const releases = []
  const player = createSpeechPlayer((text, voice, signal) => {
    signals.push(signal)
    return new Promise(resolve => releases.push(resolve))
  })
  const first = player.say('Old reply.', 'stella')
  const second = player.say('New reply.', 'stella')
  releases[0](clip('AQID'))
  assert.equal(await first, 'aborted')
  player.stop()
  assert.equal(signals[1].aborted, true)
  releases[1](clip('AQID'))
  assert.equal(await second, 'aborted')
})

test('settleSpeech ignores a replaced or stale speech', async () => {
  const events = []
  let seq = 1
  const callbacks = { failed: () => events.push('failed'), done: () => events.push('done') }
  // A speech that is still current reports its outcome.
  seq = 1
  assert.equal(await settleSpeech(Promise.resolve('failed'), () => seq === 1, callbacks), 'failed')
  assert.deepEqual(events, ['failed', 'done'])
  events.length = 0
  assert.equal(await settleSpeech(Promise.resolve('done'), () => seq === 1, callbacks), 'done')
  assert.deepEqual(events, ['done'])
  events.length = 0
  // An aborted say (replaced or stopped) writes nothing, and neither does a
  // completion that lands after its speech went stale.
  assert.equal(await settleSpeech(Promise.resolve('aborted'), () => seq === 1, callbacks), 'aborted')
  seq = 2
  assert.equal(await settleSpeech(Promise.resolve('failed'), () => seq === 1, callbacks), 'failed')
  assert.deepEqual(events, [])
})

test('a second say replaces the first speech, not plays over it', async () => {
  setup()
  const calls = []
  const player = createSpeechPlayer(async (text) => { calls.push(text); return clip('AQID') })
  const first = player.say('Old reply. It went on. And on.', 'stella')
  await tick()
  const second = player.say('New reply.', 'stella')
  await tick()
  assert.equal(await first, 'aborted')
  FakeAudio.all.at(-1).end()
  assert.equal(await second, 'done')
  assert.equal(calls.at(-1), 'New reply.')
})

test('a service failure resolves failed and stops the speech', async () => {
  setup()
  let calls = 0
  const player = createSpeechPlayer(async () => { calls += 1; if (calls === 1) return clip('AQID'); throw Object.assign(new Error('busy'), { code: 'bot/error' }) })
  const said = player.say('One. Two. Three.', 'stella')
  await tick()
  FakeAudio.all[0].end()
  assert.equal(await said, 'failed')
  assert.equal(calls, 2)
  await tick()
  assert.equal(calls, 2)
})

test('the pane\'s adapter sends {text, voice} with a real signal through teamActions', async () => {
  // The whole chain the voice pane drives: its adapter wraps teamActions'
  // synthesizeSpeech, which posts 'deepseek-synthesize' with (body, signal).
  const sent = []
  const call = async (endpoint, body, signal) => { sent.push([endpoint, body, signal]); return clip('AQID') }
  const actions = teamActions({ call, after: promise => promise, partFor: id => id, roster: createSource({}), ui: createSource({}) })
  setup()
  // The adapter is exactly what voice.js installs into the player.
  const player = createSpeechPlayer((text, voice, signal) => actions.synthesizeSpeech({ text, voice }, signal))
  const said = player.say('Read this.', 'tide')
  await tick()
  assert.deepEqual(sent.length, 1)
  assert.equal(sent[0][0], 'deepseek-synthesize')
  assert.deepEqual(sent[0][1], { text: 'Read this.', voice: 'tide' })
  assert.ok(sent[0][2] instanceof AbortSignal)
  assert.equal(sent[0][2].aborted, false)
  FakeAudio.all[0].end()
  assert.equal(await said, 'done')
})

test('a playback failure resolves failed without paying for the next chunk', async () => {
  setup()
  const calls = []
  const player = createSpeechPlayer(async (text) => { calls.push(text); return clip('AQID') })
  const said = player.say('One. Two.', 'stella')
  await tick()
  FakeAudio.all[0].fail()
  assert.equal(await said, 'failed')
  await tick()
  assert.equal(calls.length, 1)
})
