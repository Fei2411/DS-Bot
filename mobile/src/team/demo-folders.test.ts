import assert from 'node:assert/strict'
import test from 'node:test'
import { demoFolderListing, demoUpdateRoom } from './demo-folders.ts'

// The same breadcrumb contract the real host answers and the Folder screen reads.
const parentOf = (listing: ReturnType<typeof demoFolderListing>) => listing.crumbs.length > 1 ? listing.crumbs.at(-2)?.path : undefined

test('demo folder listing walks up and down with host-shaped crumbs', () => {
  const start = demoFolderListing('')
  assert.equal(start.path, '/')
  assert.equal(parentOf(start), undefined)
  assert.deepEqual(start.entries, [{ name: 'work', path: '/work' }])
  const project = demoFolderListing('/work/ds-bot')
  assert.deepEqual(project.crumbs.map(crumb => crumb.path), ['/', '/work', '/work/ds-bot'])
  assert.equal(parentOf(project), '/work')
  assert.deepEqual(project.entries.map(entry => entry.path), ['/work/ds-bot/mobile', '/work/ds-bot/ds-bot', '/work/ds-bot/app'])
  assert.equal(parentOf(demoFolderListing('/work')), '/')
  assert.equal('parent' in project, false)
})

test('demo room updates change only the given fields and an empty folder clears it', () => {
  const room: Record<string, unknown> = { id: 'r1', name: 'Team', notice: 'Hi', mode: 'admin', admin: 'b1', members: ['b1', 'b2'], workDir: '/work' }
  demoUpdateRoom(room, { id: 'r1', workDir: '/work/docs' })
  assert.deepEqual(room, { id: 'r1', name: 'Team', notice: 'Hi', mode: 'admin', admin: 'b1', members: ['b1', 'b2'], workDir: '/work/docs' })
  demoUpdateRoom(room, { id: 'r1', workDir: '' })
  assert.equal('workDir' in room, false)
  assert.equal(room.name, 'Team')
  assert.deepEqual(room.members, ['b1', 'b2'])
})
