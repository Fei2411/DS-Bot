import { startRelayServer } from './server.ts'

const server = await startRelayServer({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  dataFile: process.env.DSBOT_LINK_DATA,
})
console.log(`DS Bot link Server: ${server.url}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().then(() => process.exit(0)) })
}
