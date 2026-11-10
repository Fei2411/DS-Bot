import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropCarriedDraft, keepCarriedDraft, takeCarriedDraft } from '../src/client/draft-carry.js'

const storage = () => {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
}

test('an unsent draft follows the Bot to the part the chat moved on to', () => {
  const fake = storage()
  keepCarriedDraft({ botId: 'b2', part: 'p1', currentPart: 'p1', text: 'unfinished sentence', attachments: 0 }, fake)
  assert.deepEqual(takeCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: '' }, fake), { text: 'unfinished sentence', attachments: 0 })
  // It is carried once: the new part now owns it.
  assert.equal(takeCarriedDraft({ botId: 'b2', part: 'p3', currentPart: 'p3', text: '' }, fake), undefined)
})

test('a draft saved before a reload is still carried afterwards', () => {
  const fake = storage()
  keepCarriedDraft({ botId: 'b2', part: 'p1', currentPart: 'p1', text: 'half typed', attachments: 0 }, fake)
  assert.deepEqual(takeCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: '' }, fake), { text: 'half typed', attachments: 0 })
})

test('a draft the new part already has is not overwritten, and is not dropped', () => {
  const fake = storage()
  keepCarriedDraft({ botId: 'b2', part: 'p1', currentPart: 'p1', text: 'old', attachments: 0 }, fake)
  assert.equal(takeCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: 'newer text' }, fake), undefined)
  assert.deepEqual(takeCarriedDraft({ botId: 'b2', part: 'p3', currentPart: 'p3', text: '' }, fake), { text: 'old', attachments: 0 })
})

test('an earlier part the user opens takes nothing', () => {
  const fake = storage()
  keepCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: 'current draft', attachments: 0 }, fake)
  // p1 is not the Bot's current part, and p2 is where it was typed.
  assert.equal(takeCarriedDraft({ botId: 'b2', part: 'p1', currentPart: 'p2', text: '' }, fake), undefined)
  assert.equal(takeCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: '' }, fake), undefined)
})

test('nothing is kept for a part that is not the current one, or for an empty draft', () => {
  const fake = storage()
  keepCarriedDraft({ botId: 'b2', part: 'p1', currentPart: 'p2', text: 'draft of an older part', attachments: 0 }, fake)
  assert.equal(takeCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: '' }, fake), undefined)
  keepCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: '', attachments: 0 }, fake)
  assert.equal(takeCarriedDraft({ botId: 'b2', part: 'p3', currentPart: 'p3', text: '' }, fake), undefined)
})

test('images alone are carried as their count, so the user can be told', () => {
  const fake = storage()
  keepCarriedDraft({ botId: 'b2', part: 'p1', currentPart: 'p1', text: '', attachments: 2 }, fake)
  assert.deepEqual(takeCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: '' }, fake), { text: '', attachments: 2 })
})

test('unreadable storage is no draft, and writing still works', () => {
  const broken = { getItem: () => '{not json', setItem: () => {} }
  assert.equal(takeCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: '' }, broken), undefined)
  const absent = { getItem: () => null, setItem: () => {} }
  assert.equal(takeCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: '' }, absent), undefined)
})

test('a deleted Bot leaves no carried draft behind', () => {
  const fake = storage()
  keepCarriedDraft({ botId: 'b2', part: 'p1', currentPart: 'p1', text: 'writer draft', attachments: 0 }, fake)
  keepCarriedDraft({ botId: 'b3', part: 'p1', currentPart: 'p1', text: 'coder draft', attachments: 0 }, fake)
  dropCarriedDraft('b2', fake)
  assert.equal(takeCarriedDraft({ botId: 'b2', part: 'p2', currentPart: 'p2', text: '' }, fake), undefined)
  assert.deepEqual(takeCarriedDraft({ botId: 'b3', part: 'p2', currentPart: 'p2', text: '' }, fake), { text: 'coder draft', attachments: 0 })
  // Dropping one that has no draft, or no id, changes nothing.
  dropCarriedDraft('b9', fake)
  dropCarriedDraft('', fake)
  assert.deepEqual(takeCarriedDraft({ botId: 'b3', part: 'p3', currentPart: 'p3', text: '' }, fake), undefined)
})
