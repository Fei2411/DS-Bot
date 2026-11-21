// Local text-to-speech: a voice-packs service on loopback can read a reply with
// its own voice instead of the browser's synthesizer or the paid endpoint. The
// adapter is inert unless that service answers a short health probe, so a
// checkout without one keeps reading through the pref's engine as before.
//
// Contract of the service used here (this project's own voice packs expose it):
//   GET  /v1/health      -> { ok: true, … }
//   POST /v1/speak/file  -> WAV bytes
//        { text, voice, format: 'wav', sr, cache }
//
// The request is cross-origin from the app shell, so the service has to allow
// the origin — a browser rejects the answer before any of this code sees it.
export const LOCAL_TTS_ORIGIN = 'http://127.0.0.1:8765'

// Which voice the local service should use; it names a pack under /v1/voices.
export const LOCAL_TTS_VOICE = 'loli12-gsv'

// A local engine runs a model per request, so every piece costs a pass: the
// player is asked for shorter chunks than the cloud budget (where one request
// carries many sentences). Roughly one sentence per clip.
export const LOCAL_TTS_CHUNK = 80

// The probe must not hold a reply hostage: a service that is down refuses the
// connection at once, a service that hangs gets this budget and then loses.
const PROBE_MS = 900

const base64Of = (bytes) => {
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(text)
}

// One probe per pane, never throwing: false means "use the configured engine".
export const probeLocalTts = async () => {
  if (typeof fetch !== 'function') return false
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_MS)
  try {
    const response = await fetch(`${LOCAL_TTS_ORIGIN}/v1/health`, { signal: abort.signal })
    if (!response.ok) return false
    const body = await response.json()
    return body?.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// One clip in the shape createSpeechPlayer plays. A rejected request leaves the
// player reporting 'failed', which the pane turns into a note — never silence.
export const synthesizeLocal = async (text, signal) => {
  const response = await fetch(`${LOCAL_TTS_ORIGIN}/v1/speak/file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice: LOCAL_TTS_VOICE, format: 'wav', sr: 24000, cache: true }),
    signal,
  })
  if (!response.ok) throw new Error(`local tts ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('local tts: empty clip')
  return { audioBase64: base64Of(bytes), mediaType: response.headers.get('content-type') || 'audio/wav' }
}
