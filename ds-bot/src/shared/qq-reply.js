// QQ reply metadata travels in the persisted user source's rpcId. Keep the
// im:qq: prefix used by viaOf; no credentials or message text are stored here.
export function qqRequestId(connectionId, msg, nonce) {
  const reply = { connectionId, chatKey: msg.chat.key, kind: msg.chat.kind,
    messageId: msg.messageId, senderId: msg.sender.id }
  return `im:qq:${Buffer.from(JSON.stringify(reply)).toString('base64url')}:${nonce}`
}

export function qqReplyOf(source) {
  const rpcId = source?.rpcId
  if (typeof rpcId !== 'string' || !rpcId.startsWith('im:qq:')) return undefined
  try {
    const reply = JSON.parse(Buffer.from(rpcId.split(':')[2], 'base64url').toString('utf8'))
    if (!['connectionId', 'chatKey', 'messageId', 'senderId'].every(key => typeof reply[key] === 'string' && reply[key] !== '' && reply[key].length <= 512)) return undefined
    if (reply.kind !== 'group' && reply.kind !== 'direct') return undefined
    return reply
  } catch { return undefined }
}

export function qqReplyChat(conn, chatKey, chat, reply) {
  if (conn.platform !== 'qq' || reply === undefined) return { key: chatKey, kind: chat.kind, title: chat.title }
  // A response to one QQ conversation must never acquire another chat's msg_id.
  if (reply.connectionId !== conn.id || reply.chatKey !== chatKey || reply.kind !== chat.kind) return { key: chatKey, kind: chat.kind, title: chat.title }
  return { key: chatKey, kind: chat.kind, title: chat.title,
    replyTo: { messageId: reply.messageId, senderId: reply.senderId } }
}
