// Meta/discovery tools of a CLI's own runtime: they search the tool catalog or
// activate deferred tools (Grok's search_tool/use_tool), and they only narrate
// the agent's plumbing, never its work on the user's behalf. Host and client use
// this one vocabulary so a demoted call cannot leak back into live status.
export const META_TOOL_NAMES = Object.freeze([
  'search_tool',
  'search_tools',
  'use_tool',
  'list_tools',
  'tool_search',
  'toolsearch',
  'load_tool',
  'discover_tool',
  'discover_tools',
])
const META_TOOL_SET = new Set(META_TOOL_NAMES)

// Bare names and the shapes ACP reports (mcp__server__tool, server__tool,
// server_tool, server:tool, server/tool) all resolve to the tool's own name.
export function bareToolName(name) {
  const text = String(name ?? '').trim()
  if (text === '') return ''
  const withoutMcp = text.replace(/^mcp(?:__|_)/i, '')
  const parts = withoutMcp.split(/__|[:/]/).map(part => part.trim()).filter(part => part !== '')
  let base = parts.length > 0 ? parts.at(-1) : ''
  if (base.toLowerCase().startsWith('dsbot_') && base.toLowerCase() !== 'dsbot') base = base.slice('dsbot_'.length)
  return base
}

export function metaToolName(name) {
  const base = bareToolName(name).toLowerCase()
  return META_TOOL_SET.has(base) ? base : undefined
}

// ACP carries no standard tool-name field on some calls: then only a compact
// title such as `search_tool(query: dsbot)` identifies the plumbing. Titles
// split on whitespace and punctuation; a namespace prefix may still hide the
// tool behind its server token, so that one leading prefix is stripped too.
export function metaToolTextName(text) {
  let value = String(text ?? '').trim()
  if (value === '') return undefined
  value = value.replace(/^mcp(?:__|_)/i, '')
  const prefixed = /^([^\s:()[\]]+?)(?:__|:|\/)/.exec(value)
  if (prefixed !== null) {
    const prefixName = metaToolName(prefixed[1])
    if (prefixName !== undefined) return prefixName
    value = value.slice(prefixed[0].length).trim()
  }
  const [first = ''] = value.split(/[\s:()[\]]+/)
  return metaToolName(first)
}
