#!/usr/bin/env node
// Compatibility shim for `npx -p ds-bot ds-bot-mcp`: delegates to the unified
// `ds-bot mcp` stdio bridge while continuing to honor DSBOT_MCP_TOKEN / DSBOT_MCP_URL / --url.
import { main } from './ds-bot-cli.mjs'

const args = process.argv.slice(2)
const urlFlag = args.indexOf('--url')
if (urlFlag >= 0 && args[urlFlag + 1] === undefined) {
  console.error('ds-bot-mcp: --url needs a value.')
  process.exit(2)
}

if (!process.env.DS_BOT_API_TOKEN && process.env.DSBOT_MCP_TOKEN) {
  process.env.DS_BOT_API_TOKEN = process.env.DSBOT_MCP_TOKEN
}

const rawUrl = urlFlag >= 0 ? args[urlFlag + 1] : process.env.DSBOT_MCP_URL
const forwarded = ['mcp']
if (rawUrl) {
  const base = String(rawUrl).replace(/\/mcp\/?$/i, '')
  forwarded.push('--endpoint', base)
}
for (let i = 0; i < args.length; i += 1) {
  if (i === urlFlag) { i += 1; continue }
  forwarded.push(args[i])
}

main([process.argv[0], process.argv[1], ...forwarded]).then(code => process.exit(code))
