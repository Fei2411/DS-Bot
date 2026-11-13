import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpIcon, ChevronDownIcon } from './icons.js'
import { t } from './i18n.js'
import { reducedMotion, stepMenuFocus, useLinger } from './motion.js'

// A Bot reply taller than the chat's visible height is read by scrolling through it. Once
// its start has scrolled away, a pill under the header takes the reader back there; when
// the reply has sections, the pill names the one being read and lists them all.

// The pill sits GAP below DS Bot's header; a section counts as being read once its heading
// is within SLACK of the pill's bottom edge.
const GAP = 8
const PILL = 28
const MAX_WIDTH = 360
const SLACK = 24
// The pill leaves while less than this much of the reply is still below it.
const TAIL = 96
const HEADINGS = 'h1,h2,h3,h4'

// The reply's own headings, in order: not the ones in a quote, a table or a folded
// detail it embeds.
export function headingsIn(root) {
  return Array.from(root.querySelectorAll(HEADINGS)).filter(node => !node.closest('blockquote,table,details') && node.textContent.trim() !== '')
}

// The sections a reply lists: its headings' text, indented by level from the highest one
// it uses (at most two steps). Fewer than two headings make no list.
export function outlineOf(headings) {
  if (headings.length < 2) return []
  const levels = headings.map(node => Number(node.tagName.slice(1)))
  const top = Math.min(...levels)
  return headings.map((node, index) => ({ text: node.textContent.trim().replace(/\s+/g, ' '), depth: Math.min(levels[index] - top, 2) }))
}

// The section the reader is in: the last heading at or above `line`, -1 before the first.
export function sectionAt(tops, line) {
  let at = -1
  for (let index = 0; index < tops.length; index += 1) {
    if (tops[index] > line) break
    at = index
  }
  return at
}

// The band of `scroller` the reader sees: below DS Bot's floating header, which lies over
// the scroller's top in DSH and in the desktop app alike, and above DSH's composer, which
// sits inside the scroller (the desktop app's sits below it).
export function readingBand(scroller) {
  const box = scroller.getBoundingClientRect()
  const head = Array.from(document.querySelectorAll('.bt-head'), node => node.getBoundingClientRect())
    .find(rect => rect.height > 0 && rect.left < box.right && rect.right > box.left)
  const top = head && head.bottom > box.top && head.bottom < box.bottom ? head.bottom : box.top
  const composer = parseFloat(getComputedStyle(scroller).getPropertyValue('--dsh-composer-height')) || 0
  return { top: top + GAP, bottom: box.bottom - composer, left: box.left, right: box.right }
}

// Where the pill goes for a reply at `rect`, or null when the reply's start is in view,
// the reply fits the band, or too little of it is left below the pill. `above`, the rect
// of the "N new messages ↑" pill at the same height, moves this one under it when the
// two would meet.
export function pillPlace(rect, band, above) {
  if (rect.height <= band.bottom - band.top) return null
  const left = Math.max(rect.left, band.left + GAP)
  const top = above && above.left < left + MAX_WIDTH && above.right > left && above.bottom > band.top ? above.bottom + GAP : band.top
  if (rect.top >= band.top - GAP || rect.bottom < top + PILL + TAIL) return null
  return { top: Math.round(top), left: Math.round(left) }
}

// Whether a reply `height` tall follows the scroll. Three quarters of the band is enough:
// DSH's composer can grow and leave a band shorter than the reply without a size change
// here to say so.
export const fillsBand = (height, band) => height > (band.bottom - band.top) * 0.75

// Replies are many and few are long, so one observer watches every reply's size, and the
// scroller's for the band they are measured against; only a long reply follows the scroll.
let sizes = null
const sized = new WeakMap()
function watchSize(node, onSize) {
  if (typeof ResizeObserver !== 'function') return () => {}
  sizes ??= new ResizeObserver((entries) => {
    for (const entry of entries) sized.get(entry.target)?.forEach(listener => listener())
  })
  const listeners = sized.get(node) ?? new Set()
  sized.set(node, listeners)
  listeners.add(onSize)
  if (listeners.size === 1) sizes.observe(node)
  return () => {
    listeners.delete(onSize)
    if (listeners.size === 0) { sized.delete(node); sizes.unobserve(node) }
  }
}

const glide = (scroller, by) => scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + by), behavior: reducedMotion() ? 'auto' : 'smooth' })

// The pill for the reply in `box`; `active` is false while it streams or is folded.
export function ReplyGuide({ box, active }) {
  const [scroller, setScroller] = useState(null)
  const [long, setLong] = useState(false)
  const [view, setView] = useState(null)
  const [menu, setMenu] = useState(false)
  const pop = useRef(null)
  const trigger = useRef(null)
  useEffect(() => {
    const node = box.current
    const own = active && node ? node.closest('[data-conversation-scroll]') : null
    setScroller(own)
    if (!own) { setLong(false); return undefined }
    const check = () => setLong(fillsBand(node.getBoundingClientRect().height, readingBand(own)))
    const stops = [watchSize(node, check), watchSize(own, check)]
    return () => stops.forEach(stop => stop())
  }, [active])
  useEffect(() => {
    if (!long || !scroller) { setView(null); return undefined }
    let frame = 0
    const measure = () => {
      frame = 0
      const node = box.current
      if (!node) return
      const news = document.querySelector('.bt-news[data-direction=up]')?.getBoundingClientRect()
      const place = pillPlace(node.getBoundingClientRect(), readingBand(scroller), news)
      const headings = place ? headingsIn(node) : []
      const current = sectionAt(headings.map(heading => heading.getBoundingClientRect().top), place ? place.top + PILL + SLACK : 0)
      const next = place && { ...place, current }
      setView(prev => (prev && next && Object.keys(next).every(key => prev[key] === next[key]) ? prev : next))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [long, scroller])
  useEffect(() => { if (view === null) setMenu(false) }, [view === null])
  useEffect(() => {
    if (!menu) return undefined
    const onDown = (event) => {
      if (pop.current?.contains(event.target) || trigger.current?.contains(event.target)) return
      setMenu(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); setMenu(false); trigger.current?.focus() }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('touchstart', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('touchstart', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [menu])
  useLayoutEffect(() => {
    if (menu) (pop.current?.querySelector('[aria-current=true]') ?? pop.current?.querySelector('button'))?.focus()
  }, [menu])
  const [shown, leaving] = useLinger(view, 120)
  if (!shown || !scroller) return null
  const headings = box.current ? headingsIn(box.current) : []
  const outline = outlineOf(headings)
  const toStart = () => {
    setMenu(false)
    if (box.current) glide(scroller, box.current.getBoundingClientRect().top - readingBand(scroller).top + GAP)
  }
  const toSection = (index) => {
    setMenu(false)
    const heading = headings[index]
    // The heading lands under the pill, which stays while the reader is inside the reply.
    if (heading) glide(scroller, heading.getBoundingClientRect().top - shown.top - PILL - GAP)
  }
  const label = outline[shown.current]?.text ?? t('Contents')
  return createPortal(h('div', { className: 'bt-reading', 'data-leaving': leaving || undefined, style: { top: shown.top, left: shown.left } },
    outline.length === 0
      ? h('button', { type: 'button', className: 'bt-reading-start', onClick: toStart }, h(ArrowUpIcon), t('Start of reply'))
      : [
        h('button', { key: 'start', type: 'button', className: 'bt-reading-up', 'aria-label': t('Back to the start of this reply'), title: t('Back to the start of this reply'), onClick: toStart }, h(ArrowUpIcon)),
        h('button', {
          key: 'sections', ref: trigger, type: 'button', className: 'bt-reading-section', 'aria-haspopup': 'menu', 'aria-expanded': menu,
          'aria-label': t('Sections in this reply: {section}', { section: label }), title: label,
          onClick: () => setMenu(value => !value),
          onKeyDown: (event) => { if (event.key === 'ArrowDown' && !menu) { event.preventDefault(); setMenu(true) } },
        }, h('span', { className: 'bt-reading-label' }, label), h(ChevronDownIcon)),
      ],
    menu && !leaving ? h('div', {
      ref: pop, className: 'bt-menu bt-reading-menu', role: 'menu', 'aria-label': t('Sections in this reply'),
      onKeyDown: event => stepMenuFocus(pop.current, event, trigger.current),
    }, outline.map((entry, index) => h('button', {
      key: index, type: 'button', role: 'menuitem', 'data-depth': entry.depth || undefined, 'aria-current': index === shown.current || undefined, onClick: () => toSection(index),
    }, h('span', { className: 'bt-menu-label' }, entry.text)))) : null),
  document.body)
}
