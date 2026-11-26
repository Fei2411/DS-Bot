// Default plugin registry URL and offline fallback snapshot for DS Bot's plugin panel.
// The URL can be overridden via DS_BOT_PLUGIN_REGISTRY for self-hosted registries or testing.

export const DEFAULT_PLUGIN_REGISTRY_URL = 'https://raw.githubusercontent.com/Fei-Craft/ds-bot-plugins/main/registry.json'

export function defaultRegistryUrl(env = process.env) {
  const override = String(env?.DS_BOT_PLUGIN_REGISTRY ?? '').trim()
  return override || DEFAULT_PLUGIN_REGISTRY_URL
}

// Offline snapshot of official/curated first-batch plugins so the Plugins panel works
// immediately even when the network is offline or the registry has not been fetched yet.
export const BUNDLED_PLUGIN_CATALOG = [
  {
    id: 'dsh:dsh-ego-browser',
    name: 'Ego Lite Browser',
    description: 'External DSH browser automation plugin powered by Ego Lite (human + AI shared Chromium).',
    author: 'Community',
    category: 'browser',
    slot: 'browser',
    kind: 'dsh',
    execution: 'trusted-worker',
    capabilities: ['entry', 'process', 'worker'],
    featured: true,
    verified: true,
    tags: ['browser', 'ego', 'automation'],
    toolPrefixes: ['ego_', 'ego-', 'browser_'],
    install: {
      packageName: 'dsh-ego-browser',
      aliases: ['@dshworks/dsh-ego-browser'],
      spec: 'dsh-ego-browser',
    },
    homepage: 'https://github.com/Fei-Craft/ds-bot-plugins',
    locales: {
      zh: {
        name: 'Ego Lite 浏览器',
        description: '基于 Ego Lite 的外部 DSH 浏览器插件，支持人机共用 Chromium 会话。',
      },
    },
  },
  {
    id: 'mcp:playwright-mcp',
    name: 'Playwright MCP',
    description: 'Official Playwright MCP server (@playwright/mcp) for structured accessibility-tree browser control.',
    author: 'Microsoft',
    category: 'browser',
    slot: 'browser',
    kind: 'mcp',
    execution: 'trusted-worker',
    capabilities: ['entry', 'process', 'worker'],
    featured: true,
    verified: true,
    tags: ['browser', 'playwright', 'mcp'],
    toolPrefixes: ['browser_'],
    install: {
      mcp: {
        transport: 'stdio',
        packageSpec: '@playwright/mcp@latest',
        args: [],
      },
    },
    homepage: 'https://github.com/microsoft/playwright-mcp',
    locales: {
      zh: {
        name: 'Playwright MCP',
        description: '官方 Playwright MCP 服务（@playwright/mcp），基于可访问性树操控浏览器。',
      },
    },
  },
  {
    id: 'mcp:chrome-devtools-mcp',
    name: 'Chrome DevTools MCP',
    description: 'Chrome DevTools Protocol MCP server (chrome-devtools-mcp) for browser inspection, debugging, and automation.',
    author: 'ChromeDevTools',
    category: 'browser',
    slot: 'browser',
    kind: 'mcp',
    execution: 'trusted-worker',
    capabilities: ['entry', 'process', 'worker'],
    featured: true,
    verified: true,
    tags: ['browser', 'chrome', 'devtools', 'mcp'],
    toolPrefixes: ['chrome_', 'devtools_', 'browser_'],
    install: {
      mcp: {
        transport: 'stdio',
        packageSpec: 'chrome-devtools-mcp@latest',
        args: [],
      },
    },
    homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    locales: {
      zh: {
        name: 'Chrome DevTools MCP',
        description: '基于 Chrome DevTools 协议的浏览器 MCP 服务，支持调试、性能分析与页面操控。',
      },
    },
  },
]
