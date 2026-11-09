import { startRelayServer } from './server.ts'

const env = process.env
const number = (name: string): number | undefined => env[name] === undefined ? undefined : Number(env[name])
const ttlDays = number('DSBOT_LINK_DEVICE_TTL_DAYS')

const server = await startRelayServer({
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  dataFile: env.DSBOT_LINK_DATA,
  trustProxy: env.DSBOT_LINK_TRUST_PROXY === '1',
  maxSockets: number('DSBOT_LINK_MAX_SOCKETS'),
  maxLinks: number('DSBOT_LINK_MAX_LINKS'),
  maxSocketsPerAddress: number('DSBOT_LINK_MAX_SOCKETS_PER_ADDRESS'),
  maxNewDevicesPerHour: number('DSBOT_LINK_MAX_NEW_DEVICES_PER_HOUR'),
  deviceTtlMs: ttlDays === undefined ? undefined : ttlDays * 86_400_000,
})
console.log(`DS Bot link Server: ${server.url}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().then(() => process.exit(0)) })
}
