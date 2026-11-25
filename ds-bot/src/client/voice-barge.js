// Talking over the Bot: while a reply is read aloud the microphone stays open,
// and a rise over the reading's own loudness stops it. What the user started
// saying is kept from just before that moment, transcribed, and submitted; the
// reading is not resumed. A transcript that matches the part of the reply being
// read is the Bot's own voice coming back through the speaker, so it is dropped
// instead of submitted — two such misses switch the listener off for the pane.
//
// This is loudness plus text matching, not speaker recognition: an echo and the
// user's voice are the same signal at the microphone. The pairing is what makes
// it usable — a false hit on the reading itself costs one dropped transcript,
// never a submitted one.
import { useEffect, useRef } from 'react'
import { t } from './i18n.js'
import { openCapture, transcribeWave } from './speech.js'

const CAPTURE_NOTES = {
  blocked: 'Microphone access is blocked',
  unavailable: 'Voice chat is not available in this browser',
  'too-long': 'That was too long to recognize',
  service: "Couldn't reach the speech service",
}

// The system engine reports boundaries; the cloud player does not, so where a
// reading got to is estimated from how long it has played. Chinese is read at
// roughly four characters a second, which is close enough for a window match.
const READ_CHARS_PER_SECOND = 4.2

// Speaker output reaching the microphone and the user speaking are both just
// loudness. What separates them is when: the reading is steady, a person
// starting to talk is a sudden sustained rise above it.
const QUIET = 0.12
const FLOOR_MIN = 0.08
const FLOOR_RATIO = 1.12
const FLOOR_MARGIN = 0.02
const HOT_MS = 160
const WARM_MS = 250
const PREROLL_SECONDS = 0.3
const END_SILENCE_MS = 1100

// Both sides of the echo check are transcripts of speech: whitespace and
// punctuation are artifacts of the recognizer, not words. Normalizing them the
// same way on both sides is what keeps a punctuated reply from matching badly
// and then being submitted as the user's.
const plain = text => String(text ?? '').replace(/[\s，。、！？,.!?；;：:“”"'’‘（）()\[\]【】…—–-]+/g, '')

/**
 * Listen while a reply is read aloud and turn that reading into an interruption.
 * Inert unless `phase` is 'speaking', the Voice Input plugin is on, and the pane
 * has not switched the listener off after two misses.
 *
 * `ctl` is the pane's shared transcription slot: the abort that pause, close and
 * unmount send lands on the interruption's own request instead of on a
 * throwaway controller nothing can reach.
 */
export function useVoiceBarge({ speech, catalog, phase, said, barge, stopSpeech, submit, setPhase, setNote, turn, ctl }) {
  // The reply being read, read when the listener starts. A ref keeps the effect
  // from re-running on every render of the text it already captured, while the
  // value it reads is always the current reply — never the previous one.
  const saidRef = useRef(said)
  saidRef.current = said
  useEffect(() => {
    if (!speech || !catalog || phase !== 'speaking' || !barge.current.armed) return undefined
    const own = turn.current
    const reading = plain(saidRef.current)
    let capture = null
    let frame = 0
    let stopped = false
    let settled = false
    let began = 0
    let floor = 0
    let hotSince = 0
    let quietSince = 0
    let hitFrom = -1
    const limit = Math.max(1, catalog.maxDurationSeconds - 1) * 1000
    const readAt = () => barge.current.boundary
      ? barge.current.pos
      : Math.min(reading.length, barge.current.base + Math.floor((performance.now() - barge.current.start) / 1000 * READ_CHARS_PER_SECOND))
    // The reading's own words coming back: the transcript overlaps the stretch
    // of the reply that was being read when the hit landed. Short interjections
    // are compared the same way — '好' during a reading is that reading.
    const isEcho = (raw) => {
      const heard = plain(raw)
      if (!heard || !reading) return false
      const at = readAt()
      const around = reading.slice(Math.max(0, at - 4), at + heard.length + 12)
      if (around.includes(heard)) return true
      if (heard.length < 4) return false
      if (reading.includes(heard)) return true
      for (let index = 0; index + 3 <= heard.length; index += 2) {
        if (around.includes(heard.slice(index, index + 3))) return true
      }
      return false
    }
    const miss = () => {
      if (++barge.current.fails < 2) return
      barge.current.armed = false
    }
    const finish = async (from) => {
      const current = capture
      capture = null
      if (!current) return
      settled = true
      setPhase('transcribing')
      const controller = new AbortController()
      ctl.current = controller
      try {
        const wave = await current.finish(catalog.maxDurationSeconds, from)
        if (controller.signal.aborted) return
        const text = wave ? await transcribeWave(speech, catalog, wave, controller.signal) : ''
        if (turn.current !== own || controller.signal.aborted) return
        if (!text || isEcho(text)) { miss(); setPhase('listening'); return }
        submit(text)
      } catch (error) {
        if (turn.current !== own || controller.signal.aborted) return
        miss()
        setPhase('listening')
        setNote(t(CAPTURE_NOTES[error?.kind] ?? "Couldn't hear that"))
      } finally {
        if (ctl.current === controller) ctl.current = null
      }
    }
    openCapture().then((opened) => {
      if (stopped) { opened.cancel(); return }
      capture = opened
      began = performance.now()
      const tick = () => {
        if (!capture || stopped) return
        const now = performance.now()
        const level = capture.level()
        if (hitFrom < 0) {
          floor = floor * 0.95 + level * 0.05
          const ready = now - barge.current.start >= WARM_MS && reading.length >= 10
          const hot = ready && level > Math.max(FLOOR_MIN, floor * FLOOR_RATIO + FLOOR_MARGIN)
          if (hot) hotSince ||= now
          else hotSince = 0
          if (hotSince && now - hotSince >= HOT_MS) {
            hitFrom = Math.max(0, (hotSince - began - PREROLL_SECONDS * 1000) / 1000)
            barge.current.hit = true
            stopSpeech()
          }
        } else {
          if (level >= QUIET) quietSince = 0
          else quietSince ||= now
          // The recognizer's limit runs on the audio that is actually kept. A
          // late interruption discards everything read before the hit, so its
          // own window starts there instead of at the first frame.
          const kept = now - began - hitFrom * 1000
          if ((quietSince && now - quietSince >= END_SILENCE_MS) || kept >= limit) {
            void finish(hitFrom)
            return
          }
        }
        frame = requestAnimationFrame(tick)
      }
      tick()
    }, (error) => {
      if (!stopped) setNote(t(CAPTURE_NOTES[error?.kind] ?? "Couldn't hear that"))
    })
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      // A finished recording owns its own teardown; the state change that ends
      // this effect must not cancel the transcript it just started.
      if (!settled) capture?.cancel()
    }
  }, [speech, catalog, phase])
}
