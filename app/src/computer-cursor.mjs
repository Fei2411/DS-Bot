// The on-screen Bot cursor: one small click-through overlay per active Bot that
// draws the Bot's arrow + avatar where its last computer action pointed, with a
// ring ripple on clicks. It fades ~2.5 s after the last event and is destroyed.
// It draws only when the point is genuinely visible: the target window has to
// own the top-most layer-0 window at that point on the current Space — the
// "window at point" check runs in a long-lived helper so reading it stays off
// the main thread and a failure simply means "don't draw".

import { spawn as realSpawn } from 'node:child_process'

const SIZE = 64
const TIP = { x: 7, y: 3 }           // where the arrow's tip sits inside the page
const FADE_MS = 2500                 // gone this long after the last event
const FADE_AT = FADE_MS - 450        // the CSS fade starts here
const CHECK_MS = 300                 // a slow visibility answer means "don't draw"

/**
 * @param {{
 *   BrowserWindow: new (options: object) => object,
 *   screen: object,
 *   platform: string,
 *   ownPid?: number,
 *   spawn?: typeof realSpawn,
 *   log?: Pick<Console, 'warn'>,
 * }} options
 */
export function createComputerCursor({ BrowserWindow, screen, platform, ownPid = process.pid, spawn = realSpawn, log = console }) {
  const windows = new Map()
  const checker = createPointChecker({ platform, ownPid, spawn, log })
  const destroy = (botId) => {
    const held = windows.get(botId)
    if (held === undefined) return
    windows.delete(botId)
    clearTimeout(held.fadeAt)
    clearTimeout(held.goneAt)
    try { held.win.close() } catch {}
  }
  const overlay = (botId) => {
    const held = windows.get(botId)
    if (held !== undefined) return held
    const win = new BrowserWindow({
      width: SIZE, height: SIZE, x: -1000, y: -1000,
      frame: false, transparent: true, alwaysOnTop: true, focusable: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, hasShadow: false, show: false,
      webPreferences: { sandbox: true },
    })
    // Floats over full-screen apps too, not just the regular window level.
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch {}
    try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch {}
    // macOS cua captures a single window, so the Bot never screenshots its own
    // cursor and the user's recordings may show it — no protection here. The
    // driver may capture the whole screen on Windows, so it is hidden there.
    if (platform === 'win32') { try { win.setContentProtection(true) } catch {} }
    win.on('closed', () => { if (windows.get(botId)?.win === win) windows.delete(botId) })
    const held2 = { win, fadeAt: undefined, goneAt: undefined }
    windows.set(botId, held2)
    return held2
  }
  return {
    /** Move the Bot's cursor to a fresh point; hides it when the point is covered. */
    async update(event) {
      if (event === null || typeof event !== 'object' || !Number.isFinite(event.x) || !Number.isFinite(event.y)) return
      const botId = String(event.botId ?? '')
      if (botId === '') return
      const seen = await checker.check(event.x, event.y, event.pid)
      if (!seen) { destroy(botId); return }
      const held = overlay(botId)
      const page = cursorHtml({ color: event.color, avatar: event.avatar, ripple: event.ripple === true })
      try { held.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`) } catch (error) { log.warn(`DS Bot: the cursor did not load: ${error instanceof Error ? error.message : String(error)}`) }
      try { held.win.setBounds({ x: Math.round(event.x - TIP.x), y: Math.round(event.y - TIP.y), width: SIZE, height: SIZE }) } catch {}
      try { if (!held.win.isVisible?.()) held.win.showInactive?.() } catch {}
      clearTimeout(held.fadeAt)
      clearTimeout(held.goneAt)
      held.fadeAt = setTimeout(() => { try { held.win.webContents?.executeJavaScript("document.body.classList.add('fade')") } catch {} }, FADE_AT)
      held.goneAt = setTimeout(() => destroy(botId), FADE_MS)
    },
    dispose() {
      checker.dispose?.()
      for (const botId of [...windows.keys()]) destroy(botId)
    },
  }
}

// The arrow and avatar page. The arrow's tip lands on the reported point; the
// ring ripple replays on every click-type event; .fade dims the whole page out.
export function cursorHtml({ color = '#4d6bfe', avatar, ripple = false } = {}) {
  const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(String(color)) ? color : '#4d6bfe'
  const safeAvatar = typeof avatar === 'string' && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-zA-Z0-9+/=]+$/.test(avatar) && avatar.length <= 12000 ? avatar : undefined
  const face = safeAvatar !== undefined
    ? `<img class="ava" src="${safeAvatar}" alt="">`
    : `<span class="ava" style="background:${safeColor}"></span>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
body{transition:opacity .4s ease}
body.fade{opacity:0}
svg{position:absolute;left:0;top:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.ava{position:absolute;left:13px;top:16px;width:18px;height:18px;border-radius:50%;border:2px solid #fff;object-fit:cover;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.ring{position:absolute;left:1px;top:-1px;width:14px;height:14px;border-radius:50%;border:2px solid ${safeColor};opacity:.85;animation:ripple .5s ease-out forwards}
@keyframes ripple{from{transform:scale(.6);opacity:.85}to{transform:scale(2.6);opacity:0}}
</style></head><body>
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<path d="M7 3 L7 25 L12 20.5 L15.5 27.5 L18.5 26.2 L15 19.5 L22 19.5 Z" fill="${safeColor}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
</svg>
${face}
${ripple ? '<span class="ring"></span>' : ''}
</body></html>`
}

// The "is this point really on the target window" check. A long-lived helper
// reads `x y pid` lines and answers y/n; anything over CHECK_MS counts as no.
export function createPointChecker({ platform, ownPid = process.pid, spawn = realSpawn, log = console }) {
  if (platform !== 'darwin' && platform !== 'win32') return { check: async () => false, dispose() {} } // Linux: no on-screen cursor
  let child = null
  let pending = null
  let queue = Promise.resolve()
  const ensure = () => {
    if (child !== null) return child
    const script = platform === 'darwin' ? JXA_CHECKER : PS_CHECKER
    // The script travels on the command line so stdin stays free for the `x y pid`
    // line protocol: osascript takes -e, PowerShell a base64 -EncodedCommand.
    const file = platform === 'darwin' ? 'osascript' : 'powershell'
    const args = platform === 'darwin'
      ? ['-l', 'JavaScript', '-e', script]
      : ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    try {
      child = spawn(file, args, { env: { ...process.env, DSBOT_OWN_PID: String(ownPid) }, stdio: ['pipe', 'pipe', 'ignore'] })
      let buffer = ''
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (line === 'y' || line === 'n') { pending?.resolve(line === 'y'); pending = null }
        }
      })
      child.on('error', (error) => { log.warn(`DS Bot: the point checker failed: ${error instanceof Error ? error.message : String(error)}`); pending?.resolve(false); pending = null })
      child.on('exit', () => { child = null; pending?.resolve(false); pending = null })
    } catch (error) { log.warn(`DS Bot: the point checker did not start: ${error instanceof Error ? error.message : String(error)}`); child = null }
    return child
  }
  const check = (x, y, pid) => {
    const running = ensure()
    // One check in flight at a time keeps the line protocol in order.
    queue = queue.then(() => new Promise((resolve) => {
      if (running === null || !Number.isInteger(pid)) { resolve(false); return }
      const timer = setTimeout(() => { pending = null; resolve(false) }, CHECK_MS)
      pending = { resolve: (value) => { clearTimeout(timer); resolve(value) } }
      try { running.stdin.write(`${Math.round(x)} ${Math.round(y)} ${pid}\n`) } catch { clearTimeout(timer); pending = null; resolve(false) }
    }))
    return queue
  }
  return { check, dispose() { try { child?.kill() } catch {} child = null } }
}

// macOS: walk the on-screen window list front-to-back; the point is visible
// when the first layer-0 window containing it belongs to the target pid. Our
// own overlay windows never block the answer — they are skipped by owner pid.
const JXA_CHECKER = String.raw`
ObjC.import('Foundation')
ObjC.import('CoreGraphics')
var input = $.NSFileHandle.fileHandleWithStandardInput
var output = $.NSFileHandle.fileHandleWithStandardOutput
var buf = ''
function answer(s) {
  var d = $.NSString.alloc.initWithUTF8String(s).dataUsingEncoding($.NSUTF8StringEncoding)
  output.writeData(d)
}
while (true) {
  var data = input.availableData
  if (!data || data.length === 0) break
  buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
  var nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    var line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    var parts = line.trim().split(/\s+/)
    var x = Number(parts[0]), y = Number(parts[1]), pid = Number(parts[2])
    var yes = false
    try {
      var ref = $.CGWindowListCopyWindowInfo(1, 0)
      var list = ObjC.castRefToObject(ref)
      var count = list ? list.count : 0
      for (var i = 0; i < count && !yes; i++) {
        var win = list.objectAtIndex(i)
        var owner = ObjC.unwrap(win.objectForKey('kCGWindowOwnerPID'))
        var layer = ObjC.unwrap(win.objectForKey('kCGWindowLayer'))
        if (Number(layer) !== 0) continue
        var b = win.objectForKey('kCGWindowBounds')
        if (!b) continue
        var bx = Number(ObjC.unwrap(b.objectForKey('X'))), by = Number(ObjC.unwrap(b.objectForKey('Y')))
        var bw = Number(ObjC.unwrap(b.objectForKey('Width'))), bh = Number(ObjC.unwrap(b.objectForKey('Height')))
        if (x >= bx && x < bx + bw && y >= by && y < by + bh) { yes = (Number(owner) === pid); break }
      }
    } catch (e) {}
    answer(yes ? 'y\n' : 'n\n')
  }
}
`

// Windows: the top-most root window at the point decides visibility; the
// click-through overlays are skipped by their own process id.
const PS_CHECKER = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PointCheck {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][PointCheck]::SetProcessDPIAware()
# WindowFromPoint already skips our click-through (WS_EX_TRANSPARENT) overlays.
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $parts = $line.Trim() -split '\s+'
  if ($parts.Count -lt 3) { continue }
  $p = New-Object PointCheck+POINT
  $p.X = [int]$parts[0]; $p.Y = [int]$parts[1]
  $h = [PointCheck]::WindowFromPoint($p)
  $root = [PointCheck]::GetAncestor($h, 2)
  [uint32]$pid2 = 0
  [void][PointCheck]::GetWindowThreadProcessId($root, [ref]$pid2)
  if ($pid2 -eq [uint32]$parts[2]) { [Console]::Out.WriteLine('y') } else { [Console]::Out.WriteLine('n') }
}
`
