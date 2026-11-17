import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readDraft, writeDraft } from './drafts.ts'

test('a draft comes back with its own chat and not another one', () => {
  writeDraft('bot:b1', { text: 'half a message', photos: [] })
  writeDraft('bot:b2', { text: 'another chat', photos: [] })
  assert.equal(readDraft('bot:b1')?.text, 'half a message')
  assert.equal(readDraft('bot:b2')?.text, 'another chat')
  assert.equal(readDraft('room:r1'), undefined)
  writeDraft('bot:b1', { text: '', photos: [] })
  writeDraft('bot:b2', { text: '', photos: [] })
})

test('the picked photos are kept with the draft text', () => {
  const photo = { uri: 'file:///a.jpg', mediaType: 'image/jpeg', data: 'AAA' }
  writeDraft('room:r9', { text: 'look', photos: [photo] })
  const draft = readDraft('room:r9')
  assert.deepEqual(draft?.photos, [photo])
  // The copy is the caller's: editing it does not change what the chat keeps.
  draft?.photos.push({ uri: 'file:///b.jpg', mediaType: 'image/jpeg', data: 'BBB' })
  assert.equal(readDraft('room:r9')?.photos.length, 1)
  writeDraft('room:r9', { text: '', photos: [] })
})

test('a sent or cleared box leaves no draft behind', () => {
  writeDraft('bot:b3', { text: 'sent now', photos: [] })
  writeDraft('bot:b3', { text: '', photos: [] })
  assert.equal(readDraft('bot:b3'), undefined)
})
