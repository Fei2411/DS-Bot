import { createInterface } from 'node:readline'

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const tools = [{
  name: 'echo',
  description: 'Return the supplied text.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
}]

for await (const line of createInterface({ input: process.stdin })) {
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (!request || request.id === undefined) continue
  let result
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'ds-bot-echo', version: '1.0.0' },
      }
      break
    case 'ping':
      result = {}
      break
    case 'tools/list':
      result = { tools }
      break
    case 'tools/call':
      result = { content: [{ type: 'text', text: String(request.params?.arguments?.text ?? '') }] }
      break
    default:
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
      continue
  }
  send({ jsonrpc: '2.0', id: request.id, result })
}
