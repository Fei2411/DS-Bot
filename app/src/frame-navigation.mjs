// A sandboxed srcdoc preview is the only subframe the shell expects to stay on an
// inert document. App-owned loopback frames may navigate inside the app origin;
// everything else a subframe tries to reach is stopped rather than opened anywhere.
export function subframeNavigationAllowed(url, origin) {
  if (url === 'about:blank' || url === 'about:srcdoc') return true
  return typeof origin === 'string' && origin !== '' && url.startsWith(`${origin}/`)
}
