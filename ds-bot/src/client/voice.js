import { createElement as h, useEffect, useRef, useState } from 'react'
import { stripHeader } from './text.js'
import { MicIcon, CloseIcon } from './icons.js'
import { BotMark, RoomAvatar } from './mark.js'
import { speechApi, useDictation } from './composer.js'
import { Shimmer } from './cells.js'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'
import { openCapture, preparationStep, speechCatalog, transcribeWave, turnDetector } from './speech.js'
import { createSpeechPlayer, replyVoice, settleSpeech } from './speech-playback.js'

// Voice chat: listen, send what the user said, read the Bot's answer aloud, listen
// again. With DSH's Voice Input plugin on, its recognizer hears the user: one
// recording ends after a pause and is transcribed whole. Otherwise the browser's
// own speech recognition does. The team picks who reads the answer: the
// browser's speech synthesis, or DeepSeek's TTS endpoint in chunks.
const plainSpeech = text => stripHeader(text).replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>|~-]+/g, ' ').replace(/\s+/g, ' ').trim()
const VOICE_LABELS = {
  listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', paused: 'Paused',
  setup: 'Voice input needs its speech model', preparing: 'Preparing voice input…',
  unsupported: 'Voice chat is not available in this browser',
}
const CAPTURE_NOTES = { blocked: 'Microphone access is blocked', unavailable: 'Voice chat is not available in this browser', 'too-long': 'That was too long to recognize', service: "Couldn't reach the speech service" }

// One utterance: finish the recording, transcribe it, submit the text.
// isCurrent() is the pane's turn guard — a pause, close or session switch that
// ran since the recording began makes a late transcript drop instead of
// submitting to a Session the pane left. `ctl` is the shared transcription
// slot: the abort that pause/close/unmount sends lands on it, and only the
// utterance that installed it may clear it.
export async function transcribeUtterance({ speech, catalog, capture, isCurrent, ctl, submit, resume, fail }) {
  const controller = new AbortController()
  try {
    const wave = await capture.finish(catalog.maxDurationSeconds)
    if (!wave || !isCurrent() || controller.signal.aborted) { if (isCurrent()) resume(); return }
    ctl.current = controller
    const text = await transcribeWave(speech, catalog, wave, controller.signal)
    if (!isCurrent() || controller.signal.aborted) return
    if (text) submit(text)
    else resume()
  } catch (error) {
    if (!isCurrent() || controller.signal.aborted) return
    fail(error)
  } finally {
    if (ctl.current === controller) ctl.current = null
  }
}

// Reads the reply until it lands, then consumes it once. The chat target can
// publish synchronously inside `watch`, before it returns the disposer, so the
// consumed flag — not the disposer — is what stops a second pass: a reply
// already spoken is never spoken again.
export function watchReply(read, watch, consume) {
  let off = () => {}
  let consumed = false
  const attempt = () => {
    if (consumed) return
    const text = read()
    if (text === undefined) return
    consumed = true
    off()
    consume(text)
  }
  off = watch(attempt)
  attempt()
  return () => { consumed = true; off() }
}

function useMicLevel(enabled) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!enabled || !navigator.mediaDevices?.getUserMedia) return undefined
    let stream = null
    let audio = null
    let frame = 0
    let stopped = false
    navigator.mediaDevices.getUserMedia({ audio: true }).then((media) => {
      if (stopped) { media.getTracks().forEach(track => track.stop()); return }
      stream = media
      audio = new AudioContext()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 256
      audio.createMediaStreamSource(media).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      let smooth = 0
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const value of data) sum += ((value - 128) / 128) ** 2
        smooth = smooth * 0.8 + Math.min(1, Math.sqrt(sum / data.length) * 4) * 0.2
        setLevel(Math.round(smooth * 100) / 100)
        frame = requestAnimationFrame(tick)
      }
      tick()
    }).catch(() => {})
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach(track => track.stop())
      void audio?.close().catch(() => {})
      setLevel(0)
    }
  }, [enabled])
  return level
}

export function VoiceMode({ sessionId, paneLeft, roster, actions, useSessions, useSessionStatus }) {
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const name = bot?.name ?? room?.name ?? t('Bot')
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const lastReply = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    const entry = Array.isArray(outline) ? outline[outline.length - 1] : undefined
    return entry ? `${outline.length}|${entry.turn}` : '0|'
  })
  // The Voice Input plugin's Remote, read once: the engine does not change mid-chat.
  const [speech] = useState(() => actions.speech())
  const [phase, setPhase] = useState(speech ? 'starting' : speechApi() ? 'listening' : 'unsupported')
  const [catalog, setCatalog] = useState(null)
  const [heard, setHeard] = useState('')
  const [said, setSaid] = useState('')
  const [note, setNote] = useState('')
  const [serviceLevel, setServiceLevel] = useState(0)
  const [cycle, setCycle] = useState(0)
  const waiting = useRef(null)
  const reply = useRef(lastReply)
  reply.current = lastReply
  // The voice pref is read when a reply is spoken, not when the pane mounted:
  // the thinking effect does not re-run on a roster poll.
  const prefs = useRef(roster.prefs)
  prefs.current = roster.prefs
  // Bumped on pause and close, so a transcript that arrives later is dropped.
  const turn = useRef(0)
  // The cloud speaker's player: one per pane, lazily made on the first reply
  // spoken through the TTS endpoint.
  const player = useRef(null)
  // The in-flight transcription's controller: pause, close and unmount abort it
  // so a late transcript neither submits to a Session the pane left nor keeps a
  // paid request running. A normal listen→transcribe cycle clears it itself;
  // the effect's own cleanup must not abort the transcription it started.
  const transcribeCtl = useRef(null)
  // Which cloud speech owns 'speaking': a say replaced or stopped resolves late
  // and must not touch the phase or write a note under a newer speech.
  const speechSeq = useRef(0)
  const stopSpeech = () => {
    speechSeq.current += 1
    window.speechSynthesis?.cancel()
    player.current?.stop()
  }
  const close = () => { turn.current += 1; transcribeCtl.current?.abort(); stopSpeech(); actions.closeVoice() }
  useEscape(close)
  const submit = (text) => {
    setHeard(text)
    setPhase('thinking')
    waiting.current = reply.current.split('|')[0]
    void actions.send(sessionId, text.trim()).catch(() => setPhase('listening'))
  }
  const dictation = useDictation((text, final) => {
    setHeard(text)
    if (!final) return
    dictation.stop()
    submit(text)
  })
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timer)
  }, [note])
  useEffect(() => {
    if (!speech) return undefined
    let live = true
    speechCatalog(speech).then(({ catalog: next, usable }) => {
      if (!live) return
      setCatalog(next)
      setPhase(usable ? 'listening' : 'setup')
    }, () => { if (live) setPhase('setup') })
    return () => { live = false }
  }, [speech])
  const listen = phase === 'listening'
  useEffect(() => {
    if (speech || !listen || dictation.listening) return undefined
    const timer = setTimeout(() => dictation.start({ continuous: false, onEnd: () => {} }), 250)
    return () => clearTimeout(timer)
  }, [listen, dictation.listening])
  // Recognition stops on silence; keep listening until the user pauses or ends.
  useEffect(() => {
    if (phase !== 'listening') dictation.stop()
  }, [phase])
  // The plugin's recognizer: record one utterance, end it after a pause, transcribe it.
  useEffect(() => {
    if (!speech || !catalog || !listen) return undefined
    const own = turn.current
    let capture = null
    let frame = 0
    let stopped = false
    let smooth = 0
    const detect = turnDetector()
    const limit = Math.max(1, catalog.maxDurationSeconds - 1) * 1000
    const finish = (current) => {
      setPhase('transcribing')
      void transcribeUtterance({
        speech, catalog, capture: current,
        isCurrent: () => turn.current === own,
        ctl: transcribeCtl,
        submit,
        resume: () => setPhase('listening'),
        fail: (error) => {
          setNote(t(CAPTURE_NOTES[error?.kind] ?? "Couldn't hear that"))
          setPhase('listening')
        },
      })
    }
    openCapture().then((opened) => {
      if (stopped) { opened.cancel(); return }
      capture = opened
      const began = performance.now()
      const tick = () => {
        const now = performance.now()
        const level = capture.level()
        smooth = smooth * 0.8 + level * 0.2
        setServiceLevel(Math.round(smooth * 100) / 100)
        const state = detect(level, now)
        if (state === 'done' || (state === 'speech' && now - began >= limit)) {
          const current = capture
          capture = null
          setServiceLevel(0)
          void finish(current)
          return
        }
        // Nothing said for a whole recording: start a fresh one.
        if (state === 'waiting' && now - began >= limit) { setCycle(value => value + 1); return }
        frame = requestAnimationFrame(tick)
      }
      tick()
    }, (error) => {
      if (stopped) return
      setNote(t(CAPTURE_NOTES[error?.kind] ?? "Couldn't hear that"))
      setPhase('paused')
    })
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      capture?.cancel()
      setServiceLevel(0)
    }
  }, [speech, catalog, listen, cycle])
  useEffect(() => {
    if (phase !== 'thinking' || running || waiting.current === null) return undefined
    const count = lastReply.slice(0, lastReply.indexOf('|'))
    const turn = Number(lastReply.slice(lastReply.indexOf('|') + 1))
    if (count === waiting.current) return undefined
    const speak = (text) => {
      waiting.current = null
      const spoken = plainSpeech(text)
      setSaid(spoken)
      setHeard('')
      if (!spoken) { setPhase('listening'); return }
      // The cloud voice does not need speechSynthesis, and a failure comes back
      // as a note — the reply text is never read as an error and nothing plays.
      const cloud = typeof actions.synthesizeSpeech === 'function' ? replyVoice(prefs.current) : null
      if (cloud) {
        // A reply spoken by the other engine (the pref changed between replies)
        // must not overlap this one.
        window.speechSynthesis?.cancel()
        // The channel takes the whole request body; the player calls per chunk.
        player.current ??= createSpeechPlayer((text, voice, signal) => actions.synthesizeSpeech({ text, voice }, signal))
        const own = ++speechSeq.current
        setPhase('speaking')
        void settleSpeech(player.current.say(spoken, cloud), () => speechSeq.current === own, {
          failed: () => setNote(t("Couldn't read the reply")),
          done: () => setPhase(current => (current === 'speaking' ? 'listening' : current)),
        })
        return
      }
      if (!window.speechSynthesis) { setPhase('listening'); return }
      // Switching to the system engine makes any cloud say still out stale.
      speechSeq.current += 1
      player.current?.stop()
      const utterance = new SpeechSynthesisUtterance(spoken)
      utterance.lang = /[\u3400-\u9fff]/.test(spoken) ? 'zh-CN' : 'en-US'
      utterance.onend = () => setPhase(current => (current === 'speaking' ? 'listening' : current))
      utterance.onerror = utterance.onend
      setPhase('speaking')
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(utterance)
    }
    // The outline commits at turn/end but only holds a bounded preview; the
    // closing Assistant text can trail it, so the answer is read through the
    // chat view's own changes until it lands (or the Session goes away).
    return watchReply(
      () => actions.closingReply(sessionId, turn),
      listener => actions.watchTurns(sessionId, listener),
      (text) => {
        if (text === null) { waiting.current = null; setPhase('listening'); return }
        speak(text)
      })
  }, [phase, running, lastReply])
  // Unmount (close, or the pane's key moving to another Session) invalidates
  // every pending completion before it settles: the late transcript drops and
  // the say's then is stale before its state writes would land.
  useEffect(() => () => { turn.current += 1; transcribeCtl.current?.abort(); stopSpeech() }, [])
  const micLevel = useMicLevel(!speech && phase === 'listening' && dictation.listening)
  const level = speech ? serviceLevel : micLevel
  const markState = phase === 'thinking' || phase === 'transcribing' ? 'thinking' : phase === 'speaking' ? 'sending' : 'idle'
  const blocked = phase === 'unsupported' || phase === 'setup' || phase === 'starting' || phase === 'preparing'
  const togglePause = () => {
    if (phase === 'paused') { setPhase('listening'); return }
    turn.current += 1
    transcribeCtl.current?.abort()
    stopSpeech()
    setPhase('paused')
  }
  // A 'preparing' phase follows the speech Remote's own catalog until the
  // provider is usable; the plugin-manager path navigates away instead.
  useEffect(() => {
    if (phase !== 'preparing' || !speech) return undefined
    let stopped = false
    let timer
    const tick = async () => {
      try {
        const { catalog: next } = await speechCatalog(speech)
        if (stopped) return
        setCatalog(next)
        const step = preparationStep(next)
        if (step.state === 'usable') { setPhase('listening'); return }
        if (step.state === 'done') {
          setPhase('setup')
          if (step.failed) setNote(t("Couldn't prepare voice input"))
          return
        }
        setNote(step.pct === undefined ? '' : t('Downloading the speech model… {pct}%', { pct: step.pct }))
      } catch { if (!stopped) { setPhase('setup'); return } }
      timer = setTimeout(tick, 1500)
    }
    timer = setTimeout(tick, 800)
    return () => { stopped = true; clearTimeout(timer) }
  }, [phase, speech])
  const openSetup = phase === 'setup' ? actions.voiceSetup(catalog?.selection?.providerId) : null
  const startSetup = () => {
    if (openSetup?.navigate) { close(); openSetup.navigate(); return }
    turn.current += 1
    setPhase('preparing')
    void Promise.resolve(openSetup.prepare()).then((started) => {
      if (started === false) { setPhase('setup'); setNote(t("Couldn't prepare voice input")) }
    })
  }
  const caption = phase === 'speaking' ? said : heard
  const shownNote = note || dictation.note
  return h('div', { className: 'bt-pane bt-voice-pane', style: { left: paneLeft } },
    h('div', { className: 'bt-voice-stage', role: 'dialog', 'aria-label': t('Voice chat with {name}', { name }), 'data-phase': phase === 'transcribing' ? 'thinking' : phase },
      h('div', { className: 'bt-voice-orb', style: { '--bt-level': level } },
        h('span', { className: 'bt-voice-ring', 'aria-hidden': true }),
        h('span', { className: 'bt-voice-ring bt-voice-ring-2', 'aria-hidden': true }),
        bot ? h(BotMark, { bot, size: 112, state: markState, live: true, gaze: phase === 'listening' }) : room ? h(RoomAvatar, { room, roster, size: 112 }) : null),
      h('div', { className: 'bt-voice-name' }, name),
      h('div', { className: 'bt-voice-status', role: 'status' },
        phase === 'thinking' ? h(Shimmer, null, t('Thinking…'))
          : phase === 'transcribing' ? h(Shimmer, null, t('Recognizing…'))
            : VOICE_LABELS[phase] ? t(VOICE_LABELS[phase]) : ''),
      h('div', { className: 'bt-voice-caption', key: `${phase}:${caption.slice(0, 12)}` }, caption),
      openSetup ? h('button', { type: 'button', className: 'bt-voice-setup', onClick: startSetup }, t('Set up voice input')) : null,
      shownNote ? h('div', { className: 'bt-voice-note' }, shownNote) : null),
    h('div', { className: 'bt-voice-bar' },
      h('button', {
        type: 'button', className: 'bt-voice-btn', 'aria-pressed': phase === 'paused', disabled: blocked,
        'aria-label': phase === 'paused' ? t('Resume listening') : t('Pause'), onClick: togglePause,
      }, h(MicIcon, { size: 20 }), phase === 'paused' ? h('span', { className: 'bt-voice-slash', 'aria-hidden': true }) : null),
      h('button', { type: 'button', className: 'bt-voice-btn bt-voice-end', 'aria-label': t('End voice chat'), onClick: close }, h(CloseIcon))))
}
