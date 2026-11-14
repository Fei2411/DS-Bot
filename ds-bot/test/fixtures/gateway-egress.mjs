// One connector gateway in its own process, started the way the launcher starts a plugin's host:
// the proxy policy from the environment is installed before the gateway makes its first request.
// The test that spawns this file owns the upstream and the proxy and talks to the gateway over
// loopback. A child keeps the process-wide dispatcher out of the test runner.
import { createRequire } from 'node:module'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { createGateway } from '../../src/host/connectors/gateway.js'

const { upstream, undiciTimeoutMs, headers = { Authorization: 'Bearer private-token' }, control } = JSON.parse(process.env.GATEWAY_EGRESS)

await installProxyFromEnvironment(new Map(Object.entries(process.env).map(([name, value]) => [name, { value }])), message => process.stderr.write(`policy: ${message}\n`))
if (undiciTimeoutMs !== undefined) {
  // Stand-in for undici's 300 s defaults, short enough for a test to reach them.
  const undici = createRequire(import.meta.resolve('@deepseek-ai/dsh-http-proxy'))('undici')
  undici.setGlobalDispatcher(new undici.Agent({ headersTimeout: undiciTimeoutMs, bodyTimeout: undiciTimeoutMs }))
}

const gateway = createGateway({
  credential: () => ({ url: upstream, headers }),
  readOnly: () => false,
  onUnauthorized: async () => false,
  log: (...args) => process.stderr.write(`gateway: ${args.join(' ')}\n`),
})
await gateway.listen()
process.stdout.write(`${JSON.stringify({ url: gateway.urlFor('svc'), headers: gateway.headers() })}\n`)
if (control !== undefined) {
  // A plain fetch to the same address, under the same process-wide limits, to show they are in force.
  const outcome = async () => {
    try {
      await (await fetch(control, { method: 'POST', body: '{}' })).arrayBuffer()
      return 'none'
    } catch (error) {
      return error.cause?.code ?? error.message
    }
  }
  outcome().then(code => process.stdout.write(`${JSON.stringify({ control: code })}\n`))
}
process.stdin.resume()
process.stdin.on('end', async () => {
  await gateway.close()
  process.exit(0)
})
