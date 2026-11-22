// Whether a browser hold closes the Bot's window. A `by: 'user'` hold normally does:
// `browser-stop` hands the page over and the Bot's Chromium session goes away with it.
// A hold left behind by a part that was just deleted keeps the page in the user's hands
// but is detached from that conversation, so it must leave the window and its tabs alone
// (#1939).
export const closesBrowser = hold => hold?.by === 'user' && hold.detached !== true
