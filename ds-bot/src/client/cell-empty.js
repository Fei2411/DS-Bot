import { createElement as h, useLayoutEffect, useRef } from 'react'

// A cell that draws nothing marks itself, so the row or seat wrapping it can tell a
// cell DS Bot emptied from one another renderer filled — a cell holding only text has
// no element child for a descendant check to see. The mark also reaches the slot that
// carries it: :has() cannot nest, so no selector can ask whether every node in a seat
// holds just the mark; the slot's own attribute can say it.
export function CellEmpty({ className }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const slot = ref.current?.closest('[data-slot]')
    if (!slot) return undefined
    slot.dataset.btEmptied = ''
    return () => { if (slot.querySelectorAll('[data-bt-empty]').length <= 1) delete slot.dataset.btEmptied }
  }, [])
  return h('span', { ref, className, hidden: true, 'data-bt-empty': true })
}
