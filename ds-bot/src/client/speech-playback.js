// Cloud text-to-speech playback for the voice pane. The Bot's reply is spoken
// in chunks: every chunk stays far under the TTS request limit (10,000 billed
// characters — a Chinese character bills as 2 — and 64 KiB of body), and the
// next chunk is requested only when the previous clip ended, so stopping never
// pays for audio the user did not hear.
// Han script, supplementary planes included — the same rule the host bills by.
const CJK = /\p{Script=Han}/u
const EDGE = /^\s+|\s+$/g
const SENTENCE = /[^.!?。！？…；;]+[.!?。！？…；;"'"''」』）)]*/g
// A cut inside a long run steps back to the last pause in its tail when one is
// near the end, so chunks break at clause bounds instead of mid-word.
const SOFT = /[\s,，、：:—–-][^,，、：:—–-\s]*$/

// The billing unit of the TTS endpoint: Han characters count double.
export const billedLength = (text) => {
  let count = 0
  for (const char of text) count += CJK.test(char) ? 2 : 1
  return count
}

const billedSlice = (text, limit) => {
  let count = 0
  let end = 0
  for (const char of text) {
    count += CJK.test(char) ? 2 : 1
    if (count > limit) break
    end += char.length
  }
  if (end === 0) return [...text][0]
  const soft = SOFT.exec(text.slice(0, end))
  // Only a break late in the window wins; an early comma would leave the chunk
  // too short to be worth the extra request.
  return soft !== null && soft.index >= Math.floor(end / 2) ? text.slice(0, soft.index + 1) : text.slice(0, end)
}

// Paragraphs first (blank lines), then sentence ends; a run over the limit is
// cut at it. Whitespace between chunks is dropped — silence needs no audio.
export const splitSpeech = (text, limit = 800) => {
  const chunks = []
  const push = (piece) => {
    let rest = piece.replace(EDGE, '')
    while (rest !== '') {
      const part = billedLength(rest) <= limit ? rest : billedSlice(rest, limit)
      chunks.push(part.replace(EDGE, ''))
      rest = rest.slice(part.length).replace(EDGE, '')
    }
  }
  for (const paragraph of text.split(/\n\s*\n/)) {
    const sentences = paragraph.match(SENTENCE)
    if (sentences === null) { push(paragraph); continue }
    for (const sentence of sentences) push(sentence)
  }
  return chunks
}

export const bytesOf = (base64) => {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index)
  return bytes
}

// One clip: an object URL on an audio element, 'done' | 'failed' | 'aborted'.
// The URL is revoked at every outcome — none survives its clip.
export const playClip = ({ audioBase64, mediaType }, signal) => new Promise((resolve) => {
  if (signal?.aborted || typeof Audio !== 'function') { resolve(signal?.aborted ? 'aborted' : 'failed'); return }
  let url
  try {
    url = URL.createObjectURL(new Blob([bytesOf(audioBase64)], { type: mediaType || 'audio/wav' }))
  } catch {
    resolve('failed')
    return
  }
  const audio = new Audio()
  let settled = false
  const finish = (outcome) => {
    if (settled) return
    settled = true
    signal?.removeEventListener('abort', onAbort)
    audio.onended = audio.onerror = null
    audio.pause()
    audio.removeAttribute('src')
    URL.revokeObjectURL(url)
    resolve(outcome)
  }
  const onAbort = () => finish('aborted')
  audio.onended = () => finish('done')
  audio.onerror = () => finish('failed')
  signal?.addEventListener('abort', onAbort, { once: true })
  audio.src = url
  audio.play().catch(() => finish('failed'))
})

// The team pref `prefs.deepseekServices` picks the reply voice: 'deepseek'
// plays the answer through the TTS endpoint, anything else keeps the browser's
// own synthesizer. The pane trusts the choice the settings page gated on a
// configured service — a key that went away since then answers as a service
// error, never a silent switch to another paid path. Returns the voice name or
// null for the system engine.
export const replyVoice = (prefs) => (prefs?.deepseekServices?.tts === 'deepseek'
  ? (prefs.deepseekServices?.voice === 'tide' ? 'tide' : 'stella')
  : null)

// A say's completion is a pane event only while that say is still the current
// speech: a replaced or stopped say resolves 'aborted' and touches nothing —
// its 'failed' must not write a note nor move the phase under a newer speech.
export const settleSpeech = async (said, current, { failed, done } = {}) => {
  const outcome = await said
  if (current() && outcome !== 'aborted') {
    if (outcome === 'failed') failed?.()
    done?.()
  }
  return outcome
}

// Serial speaker. say() replaces the current speech (each reply is spoken
// once). At most one synthesize request is in flight: the next chunk goes out
// only after the current clip ends. stop() aborts that request — a late answer
// is dropped — silences the current clip and revokes its URL.
export const createSpeechPlayer = (synthesize) => {
  let generation = 0
  let active = null
  let playing = Promise.resolve('done')
  const run = async (text, voice, own) => {
    for (const chunk of splitSpeech(text)) {
      if (own !== generation) return 'aborted'
      const abort = new AbortController()
      active = abort
      let clip
      try {
        clip = await synthesize(chunk, voice, abort.signal)
      } catch {
        if (active === abort) active = null
        return own === generation ? 'failed' : 'aborted'
      }
      // A stop that raced the answer still discards it: nothing plays and no
      // URL is made. active is cleared only while it still names this run's
      // controller — a late answer may land after a newer say installed its own.
      if (own !== generation) {
        if (active === abort) active = null
        return 'aborted'
      }
      const outcome = await playClip(clip, abort.signal)
      if (active === abort) active = null
      if (own !== generation || outcome === 'aborted') return 'aborted'
      if (outcome === 'failed') return 'failed'
    }
    return 'done'
  }
  return {
    say(text, voice) {
      generation += 1
      active?.abort()
      active = null
      const own = generation
      playing = run(text, voice, own)
      return playing
    },
    stop() {
      generation += 1
      active?.abort()
      active = null
    },
    wait() { return playing },
  }
}
