#!/usr/bin/env node
// ds-bot-mcp: the stdio side of DS Bot's MCP access, for MCP clients that only start a
// command (Claude Desktop and others). It forwards each JSON-RPC line to the MCP server
// that DS Bot runs on 127.0.0.1 while dsh is open. Settings → MCP access shows the
// address and makes the token.
//   DSBOT_MCP_TOKEN=<token> npx -p ds-bot ds-bot-mcp [--url http://127.0.0.1:8797/mcp]
const args = process.argv.slice(2)
const at = args.indexOf('--url')
if (at >= 0 && args[at + 1] === undefined) {
  console.error('ds-bot-mcp: --url needs a value.')
  process.exit(2)
}
if (!process.env.DSBOT_MCP_TOKEN) {
  console.error('ds-bot-mcp: set DSBOT_MCP_TOKEN to the token from Settings → MCP access in DS Bot.')
  process.exit(2)
}
process.env.DSBOT_MCP_URL = at >= 0 ? args[at + 1] : (process.env.DSBOT_MCP_URL || 'http://127.0.0.1:8797/mcp')
process.argv.splice(2)
await import('../src/host/local-agents/mcp-stdio.js')
