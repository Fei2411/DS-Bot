import { createElement as h, useLayoutEffect, useRef } from 'react'

// A cell that draws nothing marks itself, so the row or seat wrapping it can tell a
// cell DS Bot emptied from one another renderer filled — a cell holding only text has
// no element child for a descendant check to see. The mark also reaches the slot that
// carries it: :has() cannot nest, so no selector can ask whether every node in a seat
// holds just the mark; the slot's own attribute can say it.
// The slot counts as emptied only while every child in it is a mark, `gone` aside —
// a node whose cell puts a visible event next to a mark stays shown.
const emptied = (slot, gone) => {
  let marks = 0
  for (const node of slot.childNodes) {
    if (node === gone) continue
    if (node.nodeType !== 1 || !node.hasAttribute('data-bt-empty')) return false
    marks += 1
  }
  return marks > 0
}

export function CellEmpty({ className }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const marker = ref.current
    const slot = marker?.closest('[data-slot]')
    if (!slot) return undefined
    const sync = gone => (emptied(slot, gone) ? (slot.dataset.btEmptied = '') : delete slot.dataset.btEmptied)
    sync()
    // A node's content keeps changing as its calls settle: a mark that was alone
    // stops counting once a visible part lands beside it, and marks again once
    // that part goes.
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => sync()) : null
    observer?.observe(slot, { childList: true })
    // This mark may still sit in the slot when the cleanup runs, so it is left
    // out of the count itself.
    return () => { observer?.disconnect(); sync(marker) }
  }, [])
  return h('span', { ref, className, hidden: true, 'data-bt-empty': true })
}
