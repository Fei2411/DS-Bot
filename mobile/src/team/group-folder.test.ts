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
      useRef: (initial: unknown) => {
        const index = cursor++
        if (!(index in states)) states[index] = { current: initial }
        return states[index]
      },
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
  for (const workDir of ['/work/project', 'C:\\work\\project\\', undefined]) {
    const { render } = screen({ id: 'room-1', name: 'Project', workDir })
    const visits: unknown[] = []
    const tree = render('GroupSettings', { route: { params: { roomId: 'room-1' } }, navigation: { navigate: (...args: unknown[]) => visits.push(args) } })
    const row = nodes(tree).find(node => node.props.label === 'Folder')!
    assert.ok(row)
    assert.equal(row.props.value, workDir ? 'project' : "Each Bot's own folder")
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

test('hosts that cannot list folders never ask to list and take a typed or known path', async () => {
  for (const picker of ['native', null]) for (const onPick of ['room', 'bot', 'team']) {
    const writes: unknown[] = []
    const asked: string[] = []
    const { render } = screen({}, async (name, body) => {
      asked.push(name)
      if (name === 'folders') return { picker, folders: [{ title: 'Recent project', path: '/work/recent' }] }
      writes.push([name, body]); return {}
    }, true)
    const props = { route: { params: { current: '/work/saved', onPick, roomId: 'room-1', botId: 'bot-1' } }, navigation: { goBack: () => {} } }
    render('Folder', props)
    await new Promise(setImmediate)
    const first = nodes(render('Folder', props))
    // No listing is asked for, so there is no error, and nothing points at a missing list.
    assert.deepEqual(asked, ['folders'])
    assert.equal(first.some(node => node.props.children === 'This DeepSeek Harness cannot list folders'), false)
    const input = first.find(node => node.props.placeholder === 'Full path of a folder')!
    assert.ok(input)
    assert.equal(input.props.value, '/work/saved')
    const endpoint = onPick === 'room' ? 'update-room' : onPick === 'bot' ? 'update-bot' : 'team-workspace'
    const body = (path: string) => [endpoint, onPick === 'team' ? { path } : { id: onPick === 'room' ? 'room-1' : 'bot-1', workDir: path }]
    // A known folder fills the path; a new one is typed, and spaces around it are dropped.
    nodes(render('Folder', props)).find(node => node.props.label === 'Recent project')!.props.onPress()
    assert.equal(nodes(render('Folder', props)).find(node => node.props.placeholder === 'Full path of a folder')!.props.value, '/work/recent')
    nodes(render('Folder', props)).find(node => node.props.placeholder === 'Full path of a folder')!.props.onChangeText('  /work/brand-new ')
    nodes(render('Folder', props)).find(node => node.props.accessibilityRole === 'button')!.props.onPress()
    await new Promise(setImmediate)
    assert.deepEqual(JSON.parse(JSON.stringify(writes)), [body('/work/brand-new')])
    assert.deepEqual(asked, ['folders', endpoint])
  }
})

test('a host that cannot list folders and knows none offers only the path field', async () => {
  const { render } = screen({}, async name => name === 'folders' ? { picker: 'native', folders: [] } : {}, true)
  const props = { route: { params: { onPick: 'room', roomId: 'room-1' } }, navigation: {} }
  render('Folder', props)
  await new Promise(setImmediate)
  const tree = nodes(render('Folder', props))
  assert.equal(tree.some(node => node.props.children === 'Pick a folder from Folders.' || node.props.label === 'Folders'), false)
  assert.equal(tree.find(node => node.props.accessibilityRole === 'button')!.props.disabled, true)
  assert.ok(tree.some(node => node.props.placeholder === 'Full path of a folder'))
})

test('a failed listing only points at the known folders when there are some', async () => {
  for (const known of [[], [{ title: 'Project', path: '/project' }]]) {
    const { render } = screen({}, async name => {
      if (name === 'folders') return { picker: 'browse', folders: known }
      throw new Error('Unavailable')
    }, true)
    const props = { route: { params: {} }, navigation: {} }
    render('Folder', props)
    await new Promise(setImmediate)
    const tree = nodes(render('Folder', props))
    assert.ok(tree.some(node => node.props.children === 'Unavailable'))
    assert.equal(tree.some(node => node.props.children === 'Pick a folder from Folders.'), known.length > 0)
  }
})

test('a second tap while a folder write is in flight is ignored, and a failure frees it', async () => {
  for (const clear of [false, true]) {
    const writes: unknown[] = []
    let back = 0
    let release: (value: unknown) => void = () => {}
    let failNext = true
    const { render } = screen({}, async (name, body) => {
      if (name === 'folders') return { picker: 'browse', folders: [] }
      if (name === 'folder-list') return { path: '/work/project', crumbs: [], entries: [] }
      writes.push([name, body])
      if (failNext) { failNext = false; throw new Error('Not accessible') }
      return new Promise(resolve => { release = resolve })
    }, true)
    const props = { route: { params: { current: '/work/project', onPick: 'room', roomId: 'room-1' } }, navigation: { goBack: () => { back++ } } }
    render('Folder', props)
    await new Promise(setImmediate)
    const tap = () => {
      const tree = nodes(render('Folder', props))
      tree.find(node => clear ? node.props.label === "Each Bot's own folder" : node.props.accessibilityRole === 'button')!.props.onPress()
    }
    tap()
    await new Promise(setImmediate)
    assert.equal(back, 0)
    tap()
    tap()
    tap()
    await new Promise(setImmediate)
    assert.equal(writes.length, 2)
    release({})
    await new Promise(setImmediate)
    assert.equal(back, 1)
  }
})

test('group settings shows a root folder by its own name rather than blank', () => {
  for (const [workDir, shown] of [['/', '/'], ['C:\\', 'C:'], ['/work/project/', 'project']]) {
    const { render } = screen({ id: 'room-1', name: 'Project', workDir })
    const tree = render('GroupSettings', { route: { params: { roomId: 'room-1' } }, navigation: {} })
    assert.equal(nodes(tree).find(node => node.props.label === 'Folder')!.props.value, shown)
  }
})

test('a late folder listing cannot replace a newer recent-folder selection', async () => {
  const replies: ((value: unknown) => void)[] = []
  const writes: unknown[] = []
  const { render } = screen({}, async (name, body) => {
    if (name === 'folders') return { folders: [{ title: 'Project B', path: '/project-b' }] }
    if (name === 'folder-list') return new Promise(resolve => replies.push(resolve))
    writes.push([name, body]); return {}
  }, true)
  const props = { route: { params: { onPick: 'room', roomId: 'room-1' } }, navigation: { goBack: () => {} } }
  render('Folder', props)
  await new Promise(setImmediate)
  nodes(render('Folder', props)).find(node => node.props.label === 'Project B')!.props.onPress()
  replies[1]({ path: '/project-b/resolved', entries: [] })
  await new Promise(setImmediate)
  replies[0]({ path: '/home', entries: [{ name: 'stale', path: '/home/stale' }] })
  await new Promise(setImmediate)
  const tree = render('Folder', props)
  assert.ok(nodes(tree).some(node => node.props.label === '/project-b/resolved'))
  assert.equal(nodes(tree).some(node => node.props.label === 'stale'), false)
  nodes(tree).find(node => node.props.accessibilityRole === 'button')!.props.onPress()
  await new Promise(setImmediate)
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [['update-room', { id: 'room-1', workDir: '/project-b/resolved' }]])
})

test('folder listing errors clear on retry and stale failures are ignored', async () => {
  const replies: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = []
  const { render } = screen({}, async name => {
    if (name === 'folders') return { folders: [{ title: 'Retry', path: '/project' }] }
    return new Promise((resolve, reject) => replies.push({ resolve, reject }))
  }, true)
  const props = { route: { params: {} }, navigation: {} }
  render('Folder', props)
  await new Promise(setImmediate)
  replies[0].reject(new Error('Unavailable'))
  await new Promise(setImmediate)
  assert.ok(nodes(render('Folder', props)).some(node => node.props.children === 'Unavailable'))
  const retry = () => nodes(render('Folder', props)).find(node => node.props.label === 'Retry')!.props.onPress()
  retry()
  assert.equal(nodes(render('Folder', props)).some(node => node.props.children === 'Unavailable'), false)
  retry()
  replies[2].resolve({ path: '/project', entries: [] })
  await new Promise(setImmediate)
  replies[1].reject(new Error('Stale failure'))
  await new Promise(setImmediate)
  assert.equal(nodes(render('Folder', props)).some(node => node.props.children === 'Stale failure' || node.props.children === 'Pick a folder from Folders.'), false)
})
