import assert from 'node:assert/strict'
import sharp from 'sharp'

assert.equal(process.versions.electron, undefined)
const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer()
const { data, info } = await sharp(png).resize(2, 2).removeAlpha().raw().toBuffer({ resolveWithObject: true })
assert.deepEqual([...data], Array.from({ length: 4 }, () => [255, 0, 0]).flat())
process.send({
  type: 'ready', url: 'http://127.0.0.1/',
  injections: [{ executable: process.argv0, electron: process.versions.electron ?? null, width: info.width, height: info.height }],
})
process.on('message', message => {
  if (message?.type === 'shutdown') process.disconnect()
})
