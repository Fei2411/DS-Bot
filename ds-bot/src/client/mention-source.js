// DSH hands a chat node its inline-file resolver through its own slot injection, and
// a view that shadows the node replaces that injection. Read the shared service the
// same way DSH's own view does, so inline code of a produced file stays clickable.
export function fileMentionSource(ctx, sessionId) {
  return (owner, getFileTriggerProps) => {
    const service = ctx?.get?.('chatFileMentions')
    return service?.forClosing(owner, sessionId, getFileTriggerProps)
  }
}
