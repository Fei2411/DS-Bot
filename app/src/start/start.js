// The start page: binds window.dsBotStart and applies each full snapshot to the page (the
// whale's line and the hint row, which speak only when the user is needed, the sheet and its
// cards, focus and the live region). The whale, the ring of arcs that is the progress and the
// hidden stage list belong to the director in whale.js. Text is set only through textContent
// (and text nodes), never as markup.
import { fill as fillIn, t } from './text.mjs'
import { createDirector, reduced, play, spring, sleep, clamped } from './whale.js'

const root = document.documentElement
const asked = new URLSearchParams(location.search).get('start')
const START = ['first', 'later', 'moving'].includes(asked) ? asked : 'first'
const resume = performance.getEntriesByType('navigation')[0]?.type === 'reload'
const bridge = window.dsBotStart
if (resume) root.dataset.resume = ''
// The page shows nothing but the empty band (html:not([data-start])) without the preload's bridge.
if (bridge) root.dataset.start = START
const first = START === 'first'
root.dataset.sheet = 'none'

const $ = selector => document.querySelector(selector)
const sheet = $('.sheet'), edge = $('.sheet-edge'), fill = $('.sheet-fill'), stage = $('.stage'), pond = $('.pond'), live = $('.live')
const voiceEl = $('.voice'), voiceText = $('.voice>span')
const captionText = $('.caption-text'), logs = $('.caption .btn')
const placeEl = $('.place'), placeText = $('.place-text')
const CODE = new Set(['path', 'dataDir', 'workspace'])
let lang = 'zh'
let s = null
const say = (key, vars) => t(lang, key, vars)

// ---- text ----
const sigs = new WeakMap()
function render(el, vars = {}) {
  const key = el.dataset.t.replace(/\{(\w+)\}/gu, (all, name) => vars[name] ?? '')
  // Odd parts are placeholders: {name}, or {name|one|many} for an English count.
  const parts = say(key).split(/\{(\w+(?:\|[^}]*)?)\}/u)
  const valueOf = (part) => {
    const value = vars[part.split('|')[0]]
    if (value === undefined || value === null) return ''
    return part.includes('|') ? fillIn(`{${part}}`, vars) : String(value)
  }
  const sig = parts.map((part, i) => (i % 2 ? `\u0001${valueOf(part)}` : part)).join('')
  if (sigs.get(el) === sig) return
  sigs.set(el, sig)
  el.replaceChildren(...parts.map((part, i) => {
    if (i % 2 === 0) return part
    const value = valueOf(part)
    return CODE.has(part) ? Object.assign(document.createElement('code'), { textContent: value }) : value
  }))
}
function renderStatic() {
  root.lang = lang === 'zh' ? 'zh-CN' : 'en'
  for (const el of document.querySelectorAll('.track [data-t], .footrow [data-t], .caption [data-t]')) render(el)
  $('.track').setAttribute('aria-label', say('status.track'))
  for (const st of document.querySelectorAll('.station')) st.querySelector('.sr').textContent = say(`status.state.${st.dataset.state}`)
  if (s) { fillBlock(shown); placeUI(s.place); timeUI() }
}
// Where the data goes, at the footer's right end with 「换个位置…」 (first starts; the main
// process sends no place on a reinstall or once a copied team lives there). The drive and its
// free space on Windows, the folder elsewhere.
function placeUI(place) {
  // The failure page has its own buttons; the 180 s question still lets the place change.
  const on = first && place !== null && typeof place === 'object' && !['failed', 'viewFailed'].includes(s?.view)
  placeEl.hidden = !on
  if (!on) return
  const key = place.drive ? (place.free ? 'foot.place.drive' : 'foot.place.driveOnly') : place.free ? 'foot.place.path' : 'foot.place.pathOnly'
  placeText.textContent = say(key, place)
}
function varsOf(snap) {
  const card = snap.card ?? {}
  const update = snap.update ?? {}
  const vars = { ...card }
  if (snap.view === 'failed' || snap.view === 'viewFailed') vars.reason = snap.failure?.reason ?? 'other'
  if (card.kind === 'importFailed') vars.reason = say(`reason.copy.${card.reason}`)
  if (card.kind === 'newerUpdating') vars.p = card.percent ?? 0
  if (update.version) Object.assign(vars, { version: update.version, p: update.percent ?? 0, a: update.received ?? 0, b: update.total ?? 0 })
  return vars
}
function announce(text) { if (text) live.textContent = text }

// ---- the whale's line ----
// One short line under the ring, and only when the user is needed: a start that runs past 45 s,
// the 180 s question, a failure. A data move (which the user started, and which takes a while)
// keeps its line. A card speaks with its own first line, so the whale's line is empty while a
// card is up (the 180 s question is the exception: its card holds only the buttons). A new line
// fades in once the old one has faded out.
const VOICES = { failed: 'voice.failed', viewFailed: 'voice.viewFailed', watchdog: 'voice.watchdog' }
const FADE_MS = 160
// key/text: the line chosen (on screen, or coming in once the old one has faded out).
const v = { key: '', text: '', swap: 0 }
// Past 45 s with the engine not up yet: the whale says why it takes so long.
const late = () => ['boot', 'moving'].includes(s.view) && !(s.done ?? []).includes('engine') && bootMs() >= 45000
function voiceWant() {
  if (VOICES[s.view]) return VOICES[s.view]
  if (s.view === 'card') return ''
  if (late()) return first ? 'voice.slow45' : 'voice.slowLater'
  return START === 'moving' ? 'voice.moving' : ''
}
function speak() {
  if (!s) return
  const key = voiceWant()
  const text = key ? say(key) : ''
  if (key === v.key) { if (text !== v.text) { v.text = text; if (!v.swap) voiceText.textContent = text } return }
  v.key = key
  v.text = text
  // The old line is already fading out: the new choice simply takes its place.
  if (v.swap) return
  if (!voiceEl.hasAttribute('data-on')) { put(); return }
  delete voiceEl.dataset.on
  v.swap = setTimeout(put, reduced() ? 120 : FADE_MS)
}
function put() {
  v.swap = 0
  voiceText.textContent = v.text
  voiceEl.toggleAttribute('data-on', Boolean(v.text))
  if (v.key === 'voice.failed' || v.key === 'voice.viewFailed') announce(v.text)
}

// ---- the hint row ----
// Empty unless the user is needed: a short drive's one-line note for the first 10 s, and from
// 45 s 〔打开日志文件夹〕 alone, since the whale's line says why. Nothing shows while a card, the
// 180 s question or a failure is up.
function hintWant() {
  if (s.view !== 'boot' && s.view !== 'moving') return ['', {}, false]
  if (late()) return ['', {}, true]
  return [s.hint && bootMs() < 10000 ? 'hint.space' : '', { ...s.hint }, false]
}
let shimmerReady = false
if (!first) setTimeout(() => { shimmerReady = true; if (s) shimmer() }, resume ? 0 : 1000)
const shimmer = () => root.toggleAttribute('data-shimmer', shimmerReady && (s.view === 'boot' || s.view === 'moving'))
// The main process's boot clock: ms at the wall time `at`, paused while a card waits on the user.
const bootMs = () => { const c = s?.clock; if (!c) return 0; return c.running ? c.ms + Math.max(0, Date.now() - c.at) : c.ms }
let tick = 0
// Runs on every snapshot and on each second of the boot clock: the 10 s and 45 s marks.
function timeUI() {
  clearTimeout(tick)
  if (!s) return
  const ms = bootMs()
  const sec = Math.floor(ms / 1000)
  const booting = s.view === 'boot' || s.view === 'moving'
  const engineDone = (s.done ?? []).includes('engine')
  hint()
  speak()
  if (booting) director.slow(first && engineDone ? 0 : ms >= 45000 ? 2 : ms >= 10000 ? 1 : 0)
  if (booting && s.clock?.running) tick = setTimeout(timeUI, (sec + 1) * 1000 - ms + 4)
}
const hint = () => { const [key, vars, withLogs] = hintWant(); caption(key, vars, withLogs) }
let captionKey = ''
let captionTimer = 0
function caption(key, vars, withLogs) {
  const text = key ? say(key, vars) : ''
  if (key !== captionKey) {
    const had = captionKey
    captionKey = key
    clearTimeout(captionTimer)
    const show = () => { captionText.textContent = text; captionText.toggleAttribute('data-on', Boolean(key)) }
    if (had) { delete captionText.dataset.on; captionTimer = setTimeout(show, 160) } else show()
  } else if (key && captionText.textContent !== text) captionText.textContent = text
  if (withLogs && logs.hidden) { logs.hidden = false; logs.dataset.on = '' }
  if (!withLogs && !logs.hidden) { delete logs.dataset.on; setTimeout(() => { if (!logs.dataset.on) logs.hidden = true }, 160) }
}

// ---- the sheet: one surface that every card morphs in and out of ----
const blockEl = name => (name ? $(`.card[data-kind="${name}"]`) : null)
let shown = ''
let edgeH = 0
let sheetRun = 0
function blockFor(snap) {
  if (snap.view === 'handoff') return shown
  if (snap.view === 'failed' || snap.view === 'viewFailed' || snap.view === 'watchdog') return snap.view
  if (snap.view === 'card') return snap.card?.kind === 'stopCopy' ? 'copying' : snap.card?.kind ?? ''
  return ''
}
// The edge and fill layers are pre-sized to the sheet; only their clip-path moves, so a card
// morph never lays anything out per frame.
function morph(target, jump) {
  const h = Math.max(0, Math.min(Math.round(target), sheet.clientHeight))
  if (h === edgeH) return
  const appear = edgeH === 0
  const vanish = h === 0
  edgeH = h
  const bottom = sheet.clientHeight - h
  const clips = [`inset(0px 0px ${bottom}px 0px round 12px)`, `inset(1px 1px ${bottom + 1}px 1px round 11px)`]
  ;[edge, fill].forEach((layer, k) => {
    const from = getComputedStyle(layer)
    const fromClip = from.clipPath
    const fromOpacity = Number(from.opacity)
    for (const a of layer.getAnimations()) a.cancel()
    layer.style.clipPath = clips[k]
    layer.style.opacity = vanish ? '0' : '1'
    if (jump) return
    if (reduced()) { if (appear || vanish) play(layer, [{ opacity: fromOpacity }, { opacity: vanish ? 0 : 1 }], { duration: vanish ? 160 : 120, fill: 'none' }); return }
    const shape = spring('shape')
    // A collapse is clamped at zero height: overshooting past it would only empty the clip.
    play(layer, [{ clipPath: fromClip }, { clipPath: clips[k] }], { duration: shape.duration, easing: vanish ? clamped(shape.easing) : shape.easing, fill: 'none' })
    if (appear) play(layer, [{ opacity: fromOpacity }, { opacity: 1 }], { duration: 220, easing: 'ease-out', fill: 'none' })
    // The fade-out ends before the clip area reaches zero (about half-way along the spring).
    else if (vanish) play(layer, [{ opacity: fromOpacity }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'none' })
  })
}
function resize() {
  const el = blockEl(shown)
  if (el && !el.hidden) morph(el.offsetHeight)
}
const exits = new WeakMap()
function leave(el, jump) {
  if (!el || el.hidden) return
  if (jump) { el.hidden = true; return }
  const frames = reduced() ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, translate: '0 0', scale: '1', filter: 'none' }, { opacity: 0, translate: '0 6px', scale: '.975', filter: 'blur(3px)' }]
  const a = play(el, frames, { duration: 160, easing: 'ease-in' })
  exits.set(el, a)
  el.inert = true
  // The faded card stays in layout until the edges have collapsed (100 + 420 ms after the
  // exit starts): unhiding or hiding a block mid-morph would knock the edge layers off the
  // compositor.
  a.done.then(() => sleep(380)).then(() => { if (exits.get(el) !== a) return; exits.delete(el); if (blockEl(shown) !== el) el.hidden = true; el.inert = false; a.cancel() })
}
function enter(el) {
  const a = exits.get(el)
  if (a) { exits.delete(el); a.cancel() }
  el.inert = false
  el.hidden = false
}
// The whale's line fades and veils in on CSS; shift() cancels only its scripted rise.
const rises = el => el.getAnimations().filter(a => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation))
// The stage rises to make room for the sheet; the pond (the whale and its ring) shrinks and
// rises with it on the same spring, so the ring ends above the card, and the whale's line rises
// with them so that it stays under the ring (start.css html[data-up]).
function shift(up, jump) {
  const from = getComputedStyle(stage).translate
  const pondFrom = { scale: getComputedStyle(pond).scale, translate: getComputedStyle(pond).translate }
  const voiceFrom = getComputedStyle(voiceEl).translate
  for (const a of [...stage.getAnimations(), ...pond.getAnimations(), ...rises(voiceEl)]) a.cancel()
  root.toggleAttribute('data-up', up)
  if (jump || reduced()) return
  play(stage, [{ translate: from }, { translate: up ? '0px 0px' : '0px 80px' }], { ...spring('shape'), fill: 'none' })
  play(pond, [pondFrom, { scale: up ? '.62' : '1', translate: up ? '0px -60px' : '0px 0px' }], { ...spring('shape'), fill: 'none' })
  play(voiceEl, [{ translate: voiceFrom }, { translate: up ? '0px -108px' : '0px 0px' }], { ...spring('shape'), fill: 'none' })
}
async function showBlock(name, jump) {
  if (name === shown) return
  const mine = (sheetRun += 1)
  const oldEl = blockEl(shown)
  const wasCard = Boolean(shown)
  shown = name
  if (wasCard) leave(oldEl, jump)
  const el = blockEl(name)
  if (name && el) {
    root.dataset.sheet = 'card'
    if (!root.hasAttribute('data-up')) {
      shift(true, jump)
      if (!jump) { await sleep(70); if (mine !== sheetRun) return }
    }
    enter(el)
    fillBlock(name)
    morph(el.offsetHeight, jump)
    ;[...el.querySelectorAll('.btn[data-look=primary]')].find(b => b.checkVisibility())?.focus({ preventScroll: true })
    announce(cardWords(el, name))
    return
  }
  if (!jump) await sleep(100)
  if (mine !== sheetRun) return
  morph(0, jump)
  if (!jump) await sleep(70)
  if (mine !== sheetRun) return
  root.dataset.sheet = name || 'none'
  if (document.activeElement?.closest?.('.sheet')) document.activeElement.blur()
  if (root.hasAttribute('data-up')) {
    if (!jump) await sleep(360)
    if (mine === sheetRun) shift(false, jump)
  }
}

// What a new card says to a screen reader: its first line and its first visible sentence (the
// 180 s card has only buttons; the whale's line asks its question).
function cardWords(el, name) {
  if (name === 'watchdog') return say('voice.watchdog')
  const title = el.querySelector('.card-title')
  const lead = [...el.querySelectorAll('.lead')].find(p => p.checkVisibility())
  return [title?.textContent, lead?.textContent].filter(Boolean).join(' ')
}

// ---- card contents ----
function fillBlock(name) {
  const el = blockEl(name)
  if (!el || !s) return
  const vars = varsOf(s)
  for (const node of el.querySelectorAll('[data-t]')) if (!node.closest('.steps, .copied')) render(node, vars)
  if (name === 'missing') missing(el)
  if (name === 'recommend' || name === 'rejected') recommend(el)
  if (name === 'import') importCard(el)
  if (name === 'copying') copying(el)
  if (name === 'failed') failed(el)
}
let missSeen = 0
let missTimer = 0
function missing(el) {
  const count = Number(s.card?.missedRetry ?? 0)
  if (!count || count === missSeen) return
  missSeen = count
  const line = el.querySelector('.miss')
  line.hidden = false
  delete line.dataset.gone
  clearTimeout(missTimer)
  missTimer = setTimeout(() => {
    const a = play(line, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 })
    a.done.then(() => { line.hidden = true; a.cancel(); resize() })
  }, 4000)
}
// The recommended-drive card: the question and 〔放到 D 盘〕 only with a drive to recommend,
// 〔仍然放在 C 盘〕 only when the default place works but its drive is short on space. A
// rejected pick keeps the buttons of the card it came from (card.keep says whether it had
// 〔仍然放在 C 盘〕).
function recommend(el) {
  const card = s.card
  const rec = Boolean(card.rec)
  const keep = card.kind === 'rejected' ? Boolean(card.keep) : card.reason === 'space'
  const ask = el.querySelector('.ask')
  if (ask) ask.hidden = !rec
  for (const node of el.querySelectorAll('[data-rec]')) node.hidden = !rec
  for (const node of el.querySelectorAll('[data-norec]')) node.hidden = rec
  for (const node of el.querySelectorAll('[data-keep]')) node.hidden = !keep
}
function toggleMore(button, open = button.getAttribute('aria-expanded') !== 'true') {
  button.setAttribute('aria-expanded', String(open))
  button.closest('.card').querySelector('.more').hidden = !open
  resize()
}
let modelsSig = ''
function importCard(el) {
  const card = s.card
  for (const box of el.querySelectorAll('input[data-opt]')) box.checked = Boolean(card.options?.[box.dataset.opt])
  const sig = JSON.stringify(card.models ?? [])
  if (sig === modelsSig) return
  modelsSig = sig
  el.querySelector('.models').replaceChildren(...(card.models ?? []).map((model) => {
    const button = Object.assign(document.createElement('button'), { className: 'btn', type: 'button', textContent: model.label })
    Object.assign(button.dataset, { look: 'soft', act: 'importModel', detail: model.id })
    const item = document.createElement('li')
    item.append(button)
    return item
  }))
}
function toggleModels(button, open = button.getAttribute('aria-expanded') !== 'true') {
  button.setAttribute('aria-expanded', String(open))
  button.closest('.card').querySelector('.models').hidden = !open
  resize()
}
const bars = new WeakMap()
function bar(el, fraction, keep) {
  let f = Math.max(0, Math.min(1, fraction || 0))
  const was = bars.get(el) ?? 0
  if (keep && f < was) f = was
  if (f === was && el.style.scale) return
  bars.set(el, f)
  const from = getComputedStyle(el).scale
  for (const a of el.getAnimations()) a.cancel()
  el.style.scale = `${f} 1`
  if (!reduced()) play(el, [{ scale: from }, { scale: `${f} 1` }], { ...spring('list'), fill: 'none' })
}
let copyStep = 0
function copying(el) {
  const card = s.card
  el.toggleAttribute('data-confirm', card.kind === 'stopCopy')
  el.querySelector('.confirm').hidden = card.kind !== 'stopCopy'
  el.style.setProperty('--step', String(Math.max(0, card.step - 1)))
  ;[...el.querySelectorAll('.steps li')].forEach((li, k) => {
    const n = k + 1
    const state = n < card.step ? 'done' : n === card.step ? 'active' : 'pending'
    const was = li.dataset.state
    li.dataset.state = state
    if (state === 'done' && was && was !== 'done') {
      const check = li.querySelector('.check')
      if (reduced()) play(check, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: 'none' })
      else { play(check, [{ transform: 'scale(.4)' }, { transform: 'none' }], { ...spring('pop'), fill: 'none' }); play(check, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: 'none' }) }
      director.nod()
    }
    render(li.querySelector('[data-t]'), card.steps?.[k] ?? {})
  })
  const fillEl = el.querySelector('.copy-steps .bar-fill')
  if (card.step !== copyStep) { copyStep = card.step; bars.set(fillEl, 0); fillEl.style.scale = '0 1' }
  bar(fillEl, card.fraction, true)
  el.querySelector('.eta').textContent = card.eta === null || card.eta === undefined ? '' : card.eta < 1 ? say('card.copying.etaSoon') : say('card.copying.eta', { n: card.eta })
}
// The recovery card. 〔换个位置…〕 and 〔用新的空白团队开始…〕 show only when the main process can
// carry them out (failure.places).
function failed(el) {
  for (const node of el.querySelectorAll('[data-places]')) node.hidden = !s.failure?.places
  const update = s.update
  const banner = el.querySelector('.banner')
  banner.hidden = !update
  if (update) for (const part of banner.querySelectorAll('[data-u]')) part.hidden = part.dataset.u !== update.state
  el.querySelector('[data-main]').dataset.look = update && update.state !== 'failed' ? 'soft' : 'primary'
  if (update?.state === 'downloading') bar(banner.querySelector('.bar-fill'), (update.percent ?? 0) / 100, true)
}
function toggleDetails(button) {
  const card = button.closest('.card')
  const log = card.querySelector('.log')
  const open = button.getAttribute('aria-expanded') !== 'true'
  button.setAttribute('aria-expanded', String(open))
  const pre = log.querySelector('pre')
  pre.textContent = ''
  log.hidden = !open
  resize()
  if (!open) return
  // The redacted log fills in after the morph, so the surface never reflows while it moves.
  setTimeout(() => {
    pre.textContent = (s.failure?.log ?? s.card?.log ?? []).slice(-200).join('\n')
    pre.parentElement.scrollTop = 1e6
    card.querySelector('.card-scroll').scrollTop = button.offsetTop - 14
  }, reduced() ? 0 : spring('shape').duration)
}
function copiedLabel(button) {
  button.classList.add('copied')
  button.textContent = say('btn.copied')
  setTimeout(() => { button.classList.remove('copied'); sigs.delete(button); render(button) }, 1600)
}

// ---- input ----
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-act]')
  if (!button) return
  const name = button.dataset.act
  const value = button.dataset.detail
  if (name === 'toggleDetails') return toggleDetails(button)
  if (name === 'toggleMore') return toggleMore(button)
  if (name === 'toggleModels') return toggleModels(button)
  if (name === 'copyDetails') copiedLabel(button)
  if (name === 'importModel') toggleModels(button.closest('.card').querySelector('[data-act=toggleModels]'), false)
  if (name === 'answer' || name === 'wait' || name === 'keepCopying') director.nod()
  bridge?.act(name, value === undefined ? undefined : { value })
})
document.addEventListener('change', (event) => {
  const box = event.target.closest?.('input[data-opt]')
  if (box) bridge?.act('importOption', { option: box.dataset.opt, value: box.checked })
})
document.addEventListener('visibilitychange', () => root.toggleAttribute('data-hidden', document.hidden))
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => director.refresh())
new MutationObserver(() => director.refresh()).observe(root, { attributes: true, attributeFilter: ['data-motion'] })

// ---- snapshots ----
const director = createDirector({ start: START, resume, act: (name, detail) => bridge?.act(name, detail), label: say, announce })
let applied = false
function apply(next) {
  const jump = !applied && resume
  s = next
  if ((next.lang ?? 'zh') !== lang || !applied) { lang = next.lang ?? 'zh'; renderStatic() }
  const motion = next.motion ?? 'normal'
  if (root.dataset.motion !== motion) root.dataset.motion = motion
  // macOS and Linux draw a system title bar, so the page has no band of its own.
  if (next.frame === 'system') root.dataset.frame = 'system'
  else delete root.dataset.frame
  root.dataset.view = next.view
  shimmer()
  placeUI(next.place)
  const name = blockFor(next)
  if (name !== shown) showBlock(name, jump)
  else { fillBlock(name); resize() }
  timeUI()
  director.update(next)
  applied = true
}
renderStatic()
bridge?.onState(apply)
