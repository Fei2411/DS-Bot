import { dragColumn, RAIL_WIDTH } from './frame-layout.js'
import { chatRoom, sidebarTrackWidth } from './frame-watch.js'
import { reducedMotion, SPRING_SHAPE } from './motion.js'

const remember = (style, name) => {
  const value = style.getPropertyValue(name), priority = style.getPropertyPriority(name)
  return () => { if (value) style.setProperty(name, value, priority); else style.removeProperty(name) }
}

// Like the right panel, resizing writes only the two columns' inline styles.
// React changes the content only when crossing between the wide list and rail.
export function startSidebarResize(event, { mode, width, collapsedWidth = 0, onPreview, onCommit, onDone }) {
  if (event.button !== 0) return undefined
  event.preventDefault()
  const grip = event.currentTarget
  const column = grip.closest('.bt-leftcol')
  const columns = chatRoom.columns()
  const restore = columns.flatMap(node => [remember(node.style, 'margin-left'), remember(node.style, 'transition')])
  const restoreWidth = remember(column.style, 'width')
  const restoreContent = remember(column.style, '--bt-resize-content')
  collapsedWidth = sidebarTrackWidth() ?? collapsedWidth
  column.style.width = `${width}px`
  let shown = { left: mode, width }
  let last = null
  let ended = false, disposed = false, animation = null
  const pushed = next => Math.max(0, (next.left === 'open' ? next.width : RAIL_WIDTH) - collapsedWidth)
  const placeChat = next => {
    for (const node of columns) node.style.setProperty('margin-left', `${pushed(next)}px`, 'important')
  }
  for (const node of columns) node.style.setProperty('transition', 'none', 'important')
  placeChat(shown)
  chatRoom.hold(true)
  grip.setPointerCapture?.(event.pointerId)

  const clearSnap = () => {
    const old = animation
    animation = null
    old?.cancel()
    restoreContent()
  }
  const cleanup = () => {
    disposed = true
    clearSnap()
    for (const reset of restore) reset()
    chatRoom.hold(false)
  }
  const finish = () => {
    chatRoom.setLeft(pushed(shown))
    cleanup()
    onDone()
  }
  const show = next => {
    const changed = next.left !== shown.left
    const resized = next.width !== shown.width
    if (!changed && !resized) return
    const from = changed ? column.getBoundingClientRect().width : 0
    const before = shown
    shown = next
    clearSnap()
    column.style.width = `${next.width}px`
    if (changed) onPreview(next)
    if (changed && from !== next.width && !reducedMotion()) {
      // Only the surface changes size. The content stays at its final width;
      // the chat yields once before expansion, or once after contraction.
      column.style.setProperty('--bt-resize-content', `${column.firstElementChild.getBoundingClientRect().width}px`)
      if (pushed(next) >= pushed(before)) placeChat(next)
      const snap = column.animate([{ width: `${from}px` }, { width: `${next.width}px` }], {
        duration: SPRING_SHAPE.duration, easing: SPRING_SHAPE.easing,
      })
      animation = snap
      void snap.finished.then(() => {
        if (disposed || animation !== snap) return
        clearSnap()
        placeChat(shown)
        if (ended) finish()
      }, () => {})
    } else placeChat(next)
  }
  const move = move => {
    if (move.pointerId !== event.pointerId) return
    last = dragColumn(move.clientX, window.innerWidth)
    show(last)
  }
  const ends = ['pointerup', 'pointercancel', 'lostpointercapture']
  const detach = () => {
    grip.removeEventListener('pointermove', move)
    for (const name of ends) grip.removeEventListener(name, end)
    if (grip.hasPointerCapture?.(event.pointerId)) grip.releasePointerCapture(event.pointerId)
  }
  const end = end => {
    if (ended || end.pointerId !== event.pointerId) return
    if (end.type === 'pointerup') move(end)
    ended = true
    detach()
    if (last) onCommit(last)
    if (!animation) finish()
  }
  grip.addEventListener('pointermove', move)
  for (const name of ends) grip.addEventListener(name, end)
  // Unmount (or another drag) must also release a captured pointer and discard
  // a pending animation callback; it must not save an abandoned gesture.
  return () => {
    if (disposed) return
    ended = true
    detach()
    cleanup()
    restoreWidth()
  }
}
