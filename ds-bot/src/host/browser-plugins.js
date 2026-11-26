// The whole team uses one active browser plugin in the `browser` slot.
// Built-in backends (`readonly`, `refs`, `script`, `task`) and third-party providers
// all mount through DS Bot's unified plugin runtime, with per-Bot isolated profiles,
// desktop CDP pane integration, write-action pre-grants, and handoff cards.
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountBrowserPlugin } from './browser/mount.js'
import { sessionComplete } from './browser/session-model.js'
import * as refs from './browser/refs.js'
import * as script from './browser/script.js'
import * as task from './browser/task.js'

export const browserPlugins = { refs, script, task }

export function appBrowserEndpoint(botId, downloadRoots) {
  if (typeof process.send !== 'function') throw new Error('The app browser relay is unavailable.')
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off('message', receive)
      reject(new Error('The app browser relay did not respond.'))
    }, 10_000)
    const receive = message => {
      if (message?.type !== 'ds-bot:browser-endpoint-response' || message.id !== id) return
      clearTimeout(timeout)
      process.off('message', receive)
      if (typeof message.url === 'string') resolve(message.url)
      else reject(new Error(message.error || 'The app browser relay is unavailable.'))
    }
    process.on('message', receive)
    process.send({ type: 'ds-bot:browser-endpoint', id, botId, downloadRoots }, error => {
      if (error) receive({ type: 'ds-bot:browser-endpoint-response', id, error: error.message })
    })
  })
}

const NAMES = Object.keys(browserPlugins)
const GRANT_KINDS = new Set(['post', 'upload', 'download', 'delete'])

export function defaultBrowserHeadless(platform, env = process.env) {
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

function optionalNumber(config, key) {
  const value = config[key]
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new TypeError(`${key} must be a positive number`)
  return value
}

function optionalString(config, key) {
  const value = config[key]
  if (value !== undefined && typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  return value
}

function grantAllows(bot, action) {
  return (Array.isArray(bot.browserGrants) ? bot.browserGrants : []).some(grant => {
    if (!grant || typeof grant.site !== 'string' || !Array.isArray(grant.kinds)) return false
    if (grant.until !== undefined
      && (typeof grant.until !== 'number' || !Number.isFinite(grant.until) || grant.until <= Date.now())) return false
    const site = grant.site.toLowerCase()
    const host = action.host.toLowerCase()
    const siteMatches = site === '*' || host === site || host.endsWith(`.${site}`)
    return GRANT_KINDS.has(action.kind) && siteMatches && (grant.kinds.includes('*') || grant.kinds.includes(action.kind))
  })
}

// A handoff card answers into the Bot's own chat. A group turn has no card, so its
// hold keeps no call and the browser panel clears it without telling the Bot. The part
// that raised it is kept too, so the answer comes back to that thread, not to the
// foreground chat the user happens to be reading.
export function handoffHold(rt, botId, { sessionId, callId, ...hold }) {
  const own = sessionId !== undefined && rt.chatOwners.get(sessionId) === botId && !rt.taskOwners?.has(sessionId)
  return own && callId !== undefined ? { ...hold, callId, sessionId } : hold
}

async function authorizeBrowserAction(rt, exec, botId, action) {
  await rt.load()
  const bot = rt.botOf(botId)
  if (bot === undefined) throw new Error('Unknown Bot')
  if (action.kind === 'payment') {
    throw new Error(`This looks like a payment ("${action.label}" on ${action.host}). The user makes payments themselves: call browser_handoff with reason "payment" and stop. Nothing was done.`)
  }
  if (!GRANT_KINDS.has(action.kind) || grantAllows(bot, action)) return

  const approval = rt.ctx.get?.('approval')
  const agent = exec.agent
  if (approval === undefined || agent?.session === undefined) {
    throw new Error(`This action needs the user's approval, and there is no way to ask here, so nothing was done.`)
  }
  const verbs = {
    post: { en: 'post', zh: '发布内容' },
    upload: { en: 'upload files', zh: '上传文件' },
    download: { en: 'download a file', zh: '下载文件' },
    delete: { en: 'delete something', zh: '删除内容' },
  }
  const verb = verbs[action.kind]
  const reason = `Let ${bot.name} ${verb.en} on ${action.host}: "${action.label}"?`
  const displayReason = {
    en: reason,
    zh: `允许${bot.name}在 ${action.host} 上${verb.zh}“${action.label}”吗？`,
  }
  let outcome
  try {
    outcome = await (rt.requestActionApproval ?? (request => approval.request(request)))({
      agent,
      toolName: exec.name,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      displayReason,
      ...(exec.signal ? { signal: exec.signal } : {}),
    }, { kind: 'browser', action })
  } catch {
    throw new Error('The approval service was unavailable. Nothing was done.')
  }
  if (outcome === 'allowed-once') return
  if (outcome === 'rejected') {
    throw new Error(`The user did not approve ${action.label} on ${action.host}. Do not try this action again unless the user asks. Nothing was done.`)
  }
  if (outcome === 'cancelled') throw new Error('The approval was cancelled. Nothing was done.')
  throw new Error('The approval could not be obtained. Nothing was done.')
}

const BUILTIN_BROWSER_META = {
  refs: {
    name: 'Playwright (Refs)',
    description: 'Built-in Playwright browser with numbered snapshots, click/type by ref, screenshots, per-Bot profiles, and safety grants.',
    locales: {
      zh: {
        name: 'Playwright（编号操作）',
        description: '内置 Playwright 浏览器：快照编号点击与填写、截图、每 Bot 独立登录态与安全预授权。',
      },
    },
  },
  script: {
    name: 'Playwright (Script)',
    description: 'Built-in Playwright browser that runs a single JavaScript snippet per turn with helper utilities, per-Bot profiles, and safety grants.',
    locales: {
      zh: {
        name: 'Playwright（脚本执行）',
        description: '内置 Playwright 浏览器：单步提交 JS 脚本操作页面，支持每 Bot 独立登录态与安全预授权。',
      },
    },
  },
  task: {
    name: 'Playwright (Task)',
    description: 'Built-in Playwright browser that delegates multi-step browsing goals to an internal browser runner using the Bot model.',
    locales: {
      zh: {
        name: 'Playwright（子任务）',
        description: '内置 Playwright 浏览器：接收目标由内部自动执行多步浏览并交回结果，支持每 Bot 独立登录态。',
      },
    },
  },
}

export function install(rt) {
  const rawName = rt.config.browserPlugin
  const hasConfigName = rawName !== undefined && rawName !== null && rawName !== false && rawName !== ''
  const injected = rt.config.browserPluginApi
  if (hasConfigName && !injected && !browserPlugins[rawName]) {
    throw new Error(`Unknown browser plugin "${rawName}". Choose ${NAMES.join(', ')}.`)
  }
  const playwrightUrl = optionalString(rt.config, 'playwrightUrl')
  const executablePath = optionalString(rt.config, 'browserExecutablePath')
  const downloadGraceMs = optionalNumber(rt.config, 'browserDownloadGraceMs')
  const headless = typeof rt.config.browserHeadless === 'boolean'
    ? rt.config.browserHeadless
    : defaultBrowserHeadless(process.platform)
  const profileRoot = join(rt.home, 'browser-profiles')
  const downloadRoot = join(rt.home, 'browser-downloads')

  async function downloadRoots(botId) {
    await rt.load()
    const team = rt.teamFolder()
    const requested = rt.workDirOf({ botId })
    const working = requested !== undefined && await rt.isFolder(requested) ? requested : team
    return [...new Set([working, team].filter(root => typeof root === 'string' && isAbsolute(root)))]
  }
  async function uploadRoots(botId) {
    const roots = await downloadRoots(botId)
    return [...new Set([...roots, join(downloadRoot, botId)])]
  }
  async function keyOf(exec) {
    await rt.load()
    const id = rt.selfOf(exec.agent?.session?.header?.id ?? exec.agent?.id)
    if (id === undefined || rt.botOf(id) === undefined) return undefined
    return id
  }

  let activeMounted = null
  rt.browserFrame = undefined

  function mountToolsWithHost(host, { toolDefs, openSession }) {
    const mounted = {}
    mountBrowserPlugin(rt.ctx, {
      api: mounted,
      toolDefs,
      register: tool => host.registerTool(tool),
      defineTool,
      profileRoot,
      downloadRoot,
      downloadRoots,
      uploadRoots,
      headless,
      playwrightUrl,
      executablePath,
      downloadGraceMs,
      connect: process.env.DS_BOT_APP === '1' && typeof process.send === 'function' ? appBrowserEndpoint : undefined,
      getHold: botId => rt.browserChannel?.holdOf(botId) ?? null,
      onHold: (botId, hold) => rt.browserChannel?.setHold(botId, hold && handoffHold(rt, botId, hold)),
      subscribeHolds: listener => rt.browserChannel?.subscribeHolds?.(listener),
      authorize: (exec, botId, action) => authorizeBrowserAction(rt, exec, botId, action),
      completeFor: rt.config.browserComplete
        ? () => rt.config.browserComplete
        : exec => sessionComplete(rt.ctx, exec, rt),
      keyOf,
      ...(openSession ? { openSession } : {}),
    })
    activeMounted = mounted
    rt.browserFrame = botId => mounted.frame?.(botId)
    return {
      drop: botId => mounted.drop?.(botId),
      frame: botId => mounted.frame?.(botId),
      dispose: async () => {
        if (activeMounted === mounted) {
          activeMounted = null
          rt.browserFrame = undefined
        }
        await mounted.dispose?.()
      },
    }
  }

  // Provide the browser slot host context so third-party `defineBrowserProvider` plugins
  // can reuse DS Bot's per-Bot profiles, desktop CDP pane, grants, and handoff cards.
  rt.plugins?.registerSlotContext?.('browser', (_rt, _desc, host) => ({
    profileRoot,
    profileDir: botId => join(profileRoot, String(botId)),
    downloadRoot,
    downloadRoots,
    uploadRoots,
    headless,
    playwrightUrl,
    executablePath,
    downloadGraceMs,
    resolveBotId: keyOf,
    connectCdp: process.env.DS_BOT_APP === '1' && typeof process.send === 'function' ? appBrowserEndpoint : undefined,
    getHold: botId => rt.browserChannel?.holdOf(botId) ?? null,
    onHold: (botId, hold) => rt.browserChannel?.setHold(botId, hold && handoffHold(rt, botId, hold)),
    subscribeHolds: listener => rt.browserChannel?.subscribeHolds?.(listener),
    authorize: (exec, botId, action) => authorizeBrowserAction(rt, exec, botId, action),
    completeFor: rt.config.browserComplete
      ? () => rt.config.browserComplete
      : exec => sessionComplete(rt.ctx, exec, rt),
    mountBrowserTools: ({ toolDefs, openSession }) => mountToolsWithHost(host, { toolDefs, openSession }),
  }))

  // Register built-in browser plugins into the unified `browser` slot.
  rt.plugins?.registerBuiltin?.({
    id: 'builtin:readonly',
    name: 'Read-only Browser',
    description: 'Bots can read the page you have open (title, URL, visible text) via read_browser, without clicking or typing.',
    category: 'browser',
    slot: 'browser',
    supportsGrants: false,
    toolPrefixes: ['read_browser'],
    locales: {
      zh: {
        name: '只读浏览器',
        description: '默认模式：Bot 只能通过 read_browser 读取你打开的页面内容，不会点击或输入。',
      },
    },
    mount() {
      activeMounted = null
      return { dispose: () => {} }
    },
  })

  for (const name of NAMES) {
    const mod = browserPlugins[name]
    const meta = BUILTIN_BROWSER_META[name]
    const defs = mod.tools ?? mod.toolDefs ?? []
    rt.plugins?.registerBuiltin?.({
      id: `builtin:${name}`,
      name: meta.name,
      description: meta.description,
      category: 'browser',
      slot: 'browser',
      supportsGrants: true,
      toolPrefixes: defs.map(t => t.name),
      locales: meta.locales,
      mount(host) {
        return mountToolsWithHost(host, { toolDefs: defs })
      },
    })
  }

  // Test/config injected browserPluginApi: mount synchronously so existing tests that
  // read `rt.teamTools` immediately after `createRuntime()` continue to pass.
  if (injected) {
    const defs = injected.tools ?? injected.toolDefs ?? []
    rt.plugins?.registerBuiltin?.({
      id: 'builtin:injected',
      name: 'Injected Browser',
      description: 'Browser plugin provided via runtime configuration.',
      category: 'browser',
      slot: 'browser',
      supportsGrants: true,
      toolPrefixes: defs.map(t => t.name),
      mount(host) {
        return mountToolsWithHost(host, { toolDefs: defs })
      },
    })
  }

  // Synchronously pre-mount legacy `config.browserPlugin` / `config.browserPluginApi`
  // when specified at startup so callers expecting immediate tool registration work identically.
  if (injected || hasConfigName) {
    const initialTarget = injected ? 'builtin:injected' : `builtin:${rawName}`
    if (rt.plugins?.desiredSlotTarget?.('browser') === initialTarget) {
      rt.plugins.mountBuiltinSlotSync?.('browser', initialTarget)
    }
  } else if (rt.plugins?.desiredSlotTarget?.('browser') === 'builtin:readonly') {
    rt.plugins.mountBuiltinSlotSync?.('browser', 'builtin:readonly')
  }

  // A deleted Bot leaves no browser state behind: close its session and drop the profile dir.
  if (typeof rt.deleteBot === 'function') {
    const originalDelete = rt.deleteBot.bind(rt)
    rt.deleteBot = async (id) => {
      const result = await originalDelete(id)
      const activeHandle = rt.plugins?.getActiveMount?.('slot:browser')?.handle
      if (typeof activeHandle?.drop === 'function') {
        await activeHandle.drop(id).catch(() => {})
      } else if (typeof activeMounted?.drop === 'function') {
        await activeMounted.drop(id).catch(() => {})
      } else {
        await rm(join(profileRoot, String(id)), { recursive: true, force: true }).catch(() => {})
      }
      return result
    }
  }
}
