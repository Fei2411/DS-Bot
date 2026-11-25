// Shared IM chat origin helpers used across IM routing, hand-offs, and group report-back.

export const sameImOrigin = (a, b) => a !== undefined && b !== undefined
  && a.connId === b.connId && a.chatKey === b.chatKey
  && a.senderId === b.senderId && a.binding === b.binding

export const sameImChat = (a, b) => a !== undefined && b !== undefined
  && a.connId === b.connId && a.chatKey === b.chatKey

export const normalizeImOrigin = (entry) => (entry?.connId === undefined || entry?.chatKey === undefined
  ? undefined
  : {
      connId: entry.connId,
      chatKey: entry.chatKey,
      ...(entry.senderId !== undefined ? { senderId: entry.senderId } : {}),
      ...(entry.binding !== undefined ? { binding: entry.binding } : {}),
    })
