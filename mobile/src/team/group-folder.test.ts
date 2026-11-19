import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

type Node = { type: unknown; props: Record<string, any> }

const source = ts.transpileModule(readFileSync(new URL('../screens/manage.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function screen(room: Record<string, unknown>, call = async (_name: string, _body: any): Promise<unknown> => ({}), runEffects = false) {
  const states: unknown[] = []
  const effects: (() => void)[] = []
  let mounted = false
  let cursor = 0
  const jsx = (type: unknown, props: Node['props']) => ({ type, props })
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: {
      useState: (initial: unknown) => {
        const index = cursor++
        if (!(index in states)) states[index] = initial
        return [states[index], (value: unknown) => { states[index] = value }]
      },
      useEffect: (effect: () => void) => { if (runEffects && !mounted) effects.push(effect) },
    },
    'react-native': { StyleSheet: { create: (styles: unknown) => styles }, Platform: { OS: 'android' } },
    '../team/context.tsx': { useTeam: () => ({ team: { rooms: [room], bots: [] }, call }) },
    '../ui/tokens.ts': { useTheme: () => ({ p: {}, dark: false }), type: {}, radius: {}, shadow: () => ({}) },
    '../ui/i18n.ts': { t: (value: string) => value },
  }
  const exports: Record<string, any> = {}
  runInNewContext(source, { exports, require: (name: string) => modules[name] ?? {} })
  const render = (name: string, props: unknown) => {
    cursor = 0
    const tree = exports[name](props) as Node
    mounted = true
    for (const effect of effects.splice(0)) effect()
    return tree
  }
  return { render }
}

function nodes(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as Node
  return [element, ...nodes(element.props.children)]
}

test('group settings opens the shared folder picker with the group and saved path', () => {
  for (const workDir of ['/work/project', undefined]) {
    const { render } = screen({ id: 'room-1', name: 'Project', workDir })
    const visits: unknown[] = []
    const tree = render('GroupSettings', { route: { params: { roomId: 'room-1' } }, navigation: { navigate: (...args: unknown[]) => visits.push(args) } })
    const row = nodes(tree).find(node => node.props.label === 'Folder')!
    assert.ok(row)
    assert.equal(row.props.value, workDir ?? "Each Bot's own folder")
    row.props.onPress()
    assert.deepEqual(JSON.parse(JSON.stringify(visits)), [['Folder', { ...(workDir ? { current: workDir } : {}), onPick: 'room', roomId: 'room-1' }]])
  }
})

test('the group folder picker saves or clears through update-room and returns only on success', async () => {
  for (const clear of [false, true]) {
    const calls: unknown[] = []
    let back = 0
    const { render } = screen({}, async (name, body) => {
      if (name === 'folders') return { folders: [] }
      if (name === 'folder-list') return { path: '/work/project', crumbs: [], entries: [] }
      calls.push([name, body]); return {}
    }, true)
    const props = { route: { params: { current: '/work/project', onPick: 'room', roomId: 'room-1' } }, navigation: { goBack: () => { back++ } } }
    render('Folder', props)
    await new Promise(setImmediate)
    const tree = render('Folder', props)
    const row = nodes(tree).find(node => clear ? node.props.label === "Each Bot's own folder" : node.props.accessibilityRole === 'button')!
    assert.notEqual(row.props.disabled, true)
    row.props.onPress()
    await new Promise(setImmediate)
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['update-room', { id: 'room-1', workDir: clear ? '' : '/work/project' }]])
    assert.equal(back, 1)
  }
})

test('the group folder picker keeps the screen open and shows a rejected write', async () => {
  let back = 0
  const { render } = screen({}, async name => {
    if (name === 'folders') return { folders: [] }
    if (name === 'folder-list') return { path: '/missing', crumbs: [], entries: [] }
    throw new Error('Folder is not accessible')
  }, true)
  const props = { route: { params: { current: '/missing', onPick: 'room', roomId: 'room-1' } }, navigation: { goBack: () => { back++ } } }
  render('Folder', props)
  await new Promise(setImmediate)
  const tree = render('Folder', props)
  nodes(tree).find(node => node.props.accessibilityRole === 'button')!.props.onPress()
  await new Promise(setImmediate)
  assert.equal(back, 0)
  assert.ok(nodes(render('Folder', props)).some(node => node.props.children === 'Folder is not accessible'))
})

test('folder navigation uses host crumbs to reach the parent and a sibling', async () => {
  const calls: unknown[] = []
  const { render } = screen({}, async (name, body) => {
    if (name === 'folders') return { folders: [] }
    calls.push(body.path)
    return body.path === '/work/project'
      ? { path: '/work/project', crumbs: [{ path: '/' }, { path: '/work' }, { path: '/work/project' }], entries: [] }
      : { path: '/work', crumbs: [{ path: '/' }, { path: '/work' }], entries: [{ name: 'sibling', path: '/work/sibling' }] }
  }, true)
  const props = { route: { params: { current: '/work/project', onPick: 'room', roomId: 'room-1' } }, navigation: {} }
  render('Folder', props)
  await new Promise(setImmediate)
  nodes(render('Folder', props)).find(node => node.props.label === 'Up one level')!.props.onPress()
  await new Promise(setImmediate)
  nodes(render('Folder', props)).find(node => node.props.label === 'sibling')!.props.onPress()
  await new Promise(setImmediate)
  assert.deepEqual(calls, ['/work/project', '/work', '/work/sibling'])
})

test('folder roots, missing crumbs and failed listings do not offer a parent', async () => {
  for (const crumbs of [[{ path: '/' }], [], undefined, 'reject']) {
    const { render } = screen({}, async (name) => {
      if (name === 'folders') return { folders: [] }
      if (crumbs === 'reject') throw new Error('Cannot list folders')
      return { path: '/', crumbs, entries: [] }
    }, true)
    const props = { route: { params: { current: '/', onPick: 'room', roomId: 'room-1' } }, navigation: {} }
    render('Folder', props)
    await new Promise(setImmediate)
    assert.equal(nodes(render('Folder', props)).some(node => node.props.label === 'Up one level'), false)
  }
})

test('an unset folder selects the resolved host directory rather than clearing the group folder', async () => {
  const writes: unknown[] = []
  const { render } = screen({}, async (name, body) => {
    if (name === 'folders') return { folders: [] }
    if (name === 'folder-list') {
      assert.equal(body.path, '')
      return { path: '/home/user', crumbs: [{ path: '/' }, { path: '/home' }, { path: '/home/user' }], entries: [] }
    }
    writes.push([name, body]); return {}
  }, true)
  const props = { route: { params: { onPick: 'room', roomId: 'room-1' } }, navigation: { goBack: () => {} } }
  const loading = render('Folder', props)
  assert.equal(nodes(loading).find(node => node.props.accessibilityRole === 'button')!.props.disabled, true)
  await new Promise(setImmediate)
  const tree = render('Folder', props)
  assert.ok(nodes(tree).some(node => node.props.label === '/home/user'))
  const choose = nodes(tree).find(node => node.props.accessibilityRole === 'button')!
  assert.equal(choose.props.disabled, false)
  choose.props.onPress()
  await new Promise(setImmediate)
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [['update-room', { id: 'room-1', workDir: '/home/user' }]])
})

test('a failed initial folder listing cannot submit an unresolved path', async () => {
  const { render } = screen({}, async name => {
    if (name === 'folders') return { folders: [] }
    throw new Error('Cannot list folders')
  }, true)
  const props = { route: { params: { onPick: 'room', roomId: 'room-1' } }, navigation: {} }
  render('Folder', props)
  await new Promise(setImmediate)
  const tree = render('Folder', props)
  assert.equal(nodes(tree).find(node => node.props.accessibilityRole === 'button')!.props.disabled, true)
  nodes(tree).find(node => node.props.accessibilityRole === 'button')!.props.onPress()
  assert.ok(nodes(tree).find(node => node.props.label === "Each Bot's own folder"))
})

test('native-picker hosts can select saved and recent folders even when listing is unavailable', async () => {
  for (const onPick of ['room', 'bot', 'team']) {
    const writes: unknown[] = []
    const { render } = screen({}, async (name, body) => {
      if (name === 'folders') return { picker: 'native', folders: [{ title: 'Recent project', path: '/work/recent' }] }
      if (name === 'folder-list') throw new Error('This DeepSeek Harness cannot list folders')
      writes.push([name, body]); return {}
    }, true)
    const props = { route: { params: { current: '/work/saved', onPick, roomId: 'room-1', botId: 'bot-1' } }, navigation: { goBack: () => {} } }
    render('Folder', props)
    await new Promise(setImmediate)
    const saved = nodes(render('Folder', props)).find(node => node.props.accessibilityRole === 'button')!
    assert.equal(saved.props.disabled, false)
    saved.props.onPress()
    await new Promise(setImmediate)
    nodes(render('Folder', props)).find(node => node.props.label === 'Recent project')!.props.onPress()
    await new Promise(setImmediate)
    const tree = render('Folder', props)
    assert.ok(nodes(tree).some(node => node.props.label === '/work/recent'))
    const recent = nodes(tree).find(node => node.props.accessibilityRole === 'button')!
    assert.equal(recent.props.disabled, false)
    recent.props.onPress()
    await new Promise(setImmediate)
    const endpoint = onPick === 'room' ? 'update-room' : onPick === 'bot' ? 'update-bot' : 'team-workspace'
    const expected = ['/work/saved', '/work/recent'].map(path => [endpoint,
      onPick === 'team' ? { path } : { id: onPick === 'room' ? 'room-1' : 'bot-1', workDir: path }])
    assert.deepEqual(JSON.parse(JSON.stringify(writes)), expected)
  }
})
