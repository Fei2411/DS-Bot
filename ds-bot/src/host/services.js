// Reading an injected service directly throws once the host that provided it is
// disposed; get() returns undefined instead. Work the host started (a model listing, a
// greeting waiting for its model) can still be running at that point, so it reads the
// service through here and stops quietly when the host is gone.
export function serviceOf(ctx, name) {
  try {
    const found = ctx.get?.(name)
    if (found !== undefined) return found
  } catch { /* a disposed context may refuse the lookup itself */ }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}
