import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CommonActions, StackRouter, type NavigationAction } from '@react-navigation/routers'
import { canBackOpenDrawer, handleDrawerBack } from './drawer-back.ts'

const ROUTE_NAMES = ['Chat', 'BotDetails', 'Memory', 'Settings', 'Needs', 'NewBot', 'NewGroup']
const SETTINGS_NAMES = ['SettingsHome', 'Computers', 'Providers']
const OPTIONS = { routeNames: ROUTE_NAMES, routeParamList: {}, routeGetIdList: {} }
const SETTINGS_OPTIONS = { routeNames: SETTINGS_NAMES, routeParamList: {}, routeGetIdList: {} }

// Simulates NavigationContainer + Stack.Navigator + Drawer BackHandler LIFO dispatch
// (react-native/Libraries/Utilities/BackHandler.android.js + @react-navigation/native/src/useBackButton.native.tsx).
function createHarness() {
  const rootRouter = StackRouter({})
  const settingsRouter = StackRouter({})
  let state = rootRouter.getInitialState(OPTIONS)

  const canGoBack = (): boolean => {
    const top = state.routes[state.index]
    if (top?.name === 'Settings' && top.state !== undefined && (top.state.index ?? 0) > 0) return true
    return state.index > 0
  }

  const dispatch = (action: NavigationAction) => {
    const top = state.routes[state.index]
    if (top?.name === 'Settings' && top.state !== undefined) {
      const nextChild = settingsRouter.getStateForAction(top.state as any, action as any, SETTINGS_OPTIONS)
      if (nextChild !== null) {
        const fullChild = settingsRouter.getRehydratedState(nextChild, SETTINGS_OPTIONS)
        state = {
          ...state,
          routes: state.routes.map((route, i) => (i === state.index ? { ...route, state: fullChild } : route)),
        }
        return
      }
    }
    const next = rootRouter.getStateForAction(state, action as any, OPTIONS)
    if (next !== null) state = rootRouter.getRehydratedState(next, OPTIONS)
  }

  let drawerOpen = false
  let opens = 0
  let closes = 0
  let minimized = 0

  const listeners: Array<() => boolean> = [
    // Registered first by NavigationContainer's useBackButton.
    () => {
      if (canGoBack()) {
        dispatch(CommonActions.goBack())
        return true
      }
      return false
    },
    // Registered second by Drawer after ShellB finishes loading saved chat.
    () => handleDrawerBack({
      isOpen: drawerOpen,
      backOpens: canBackOpenDrawer(state),
      open: () => { drawerOpen = true; opens += 1 },
    }),
  ]

  return {
    getState: () => state,
    isDrawerOpen: () => drawerOpen,
    counts: () => ({ opens, closes, minimized }),
    openDrawerByUi: () => { drawerOpen = true; opens += 1 },
    closeDrawerByUi: () => { drawerOpen = false; closes += 1 },
    navigate: (name: string) => dispatch(CommonActions.navigate(name)),
    openSettingsSubpage: (name: string) => {
      const next = rootRouter.getRehydratedState(
        rootRouter.getStateForAction(state, CommonActions.navigate('Settings'), OPTIONS)!,
        OPTIONS,
      )
      const childInit = settingsRouter.getInitialState(SETTINGS_OPTIONS)
      const childNext = settingsRouter.getRehydratedState(
        settingsRouter.getStateForAction(childInit, CommonActions.navigate(name), SETTINGS_OPTIONS)!,
        SETTINGS_OPTIONS,
      )
      state = {
        ...next,
        routes: next.routes.map(route => (route.name === 'Settings' ? { ...route, state: childNext } : route)),
      }
    },
    pressHardwareBack: () => {
      for (let i = listeners.length - 1; i >= 0; i -= 1) {
        if (listeners[i]()) return
      }
      minimized += 1
    },
  }
}

test('single back on Chat opens closed sidebar and consumes event; second back minimizes app', () => {
  const app = createHarness()
  assert.equal(app.isDrawerOpen(), false)

  // First back on Chat opens the sidebar and does not minimize.
  app.pressHardwareBack()
  assert.equal(app.isDrawerOpen(), true)
  assert.deepEqual(app.counts(), { opens: 1, closes: 0, minimized: 0 })

  // Second back while sidebar is open does not close it and lets Android minimize the app.
  app.pressHardwareBack()
  assert.equal(app.isDrawerOpen(), true)
  assert.deepEqual(app.counts(), { opens: 1, closes: 0, minimized: 1 })

  // Closing via scrim/swipe resets state so a later back on Chat opens the sidebar again.
  app.closeDrawerByUi()
  app.pressHardwareBack()
  assert.equal(app.isDrawerOpen(), true)
  assert.deepEqual(app.counts(), { opens: 2, closes: 1, minimized: 1 })
})

test('back while sidebar was opened via button or swipe minimizes app instead of closing drawer', () => {
  const app = createHarness()
  app.openDrawerByUi()
  app.pressHardwareBack()
  assert.equal(app.isDrawerOpen(), true)
  assert.deepEqual(app.counts(), { opens: 1, closes: 0, minimized: 1 })
})

test('back on Settings, Memory, and pushed screens navigates back instead of opening sidebar or minimizing', () => {
  const app = createHarness()

  // Pushed details -> Memory -> back -> BotDetails -> back -> Chat -> back -> opens drawer.
  app.navigate('BotDetails')
  app.navigate('Memory')
  assert.equal(canBackOpenDrawer(app.getState()), false)

  app.pressHardwareBack()
  assert.equal(app.getState().routes.at(-1)?.name, 'BotDetails')
  assert.equal(app.isDrawerOpen(), false)
  assert.deepEqual(app.counts(), { opens: 0, closes: 0, minimized: 0 })

  app.pressHardwareBack()
  assert.equal(app.getState().routes.at(-1)?.name, 'Chat')
  assert.equal(app.isDrawerOpen(), false)
  assert.deepEqual(app.counts(), { opens: 0, closes: 0, minimized: 0 })

  // Nested Settings subpage -> SettingsHome -> Chat.
  app.openSettingsSubpage('Computers')
  assert.equal(canBackOpenDrawer(app.getState()), false)

  app.pressHardwareBack()
  assert.equal(app.getState().routes.at(-1)?.name, 'Settings')
  assert.equal((app.getState().routes.at(-1)?.state as any)?.routes.at(-1)?.name, 'SettingsHome')
  assert.equal(app.isDrawerOpen(), false)
  assert.deepEqual(app.counts(), { opens: 0, closes: 0, minimized: 0 })

  app.pressHardwareBack()
  assert.equal(app.getState().routes.at(-1)?.name, 'Chat')
  assert.equal(app.isDrawerOpen(), false)
  assert.deepEqual(app.counts(), { opens: 0, closes: 0, minimized: 0 })

  // Once back on Chat, single back opens the sidebar and second back minimizes.
  app.pressHardwareBack()
  assert.equal(app.isDrawerOpen(), true)
  assert.deepEqual(app.counts(), { opens: 1, closes: 0, minimized: 0 })

  app.pressHardwareBack()
  assert.deepEqual(app.counts(), { opens: 1, closes: 0, minimized: 1 })
})

test('canBackOpenDrawer returns false before navigator state exists and for modal sheets', () => {
  assert.equal(canBackOpenDrawer(undefined), false)
  assert.equal(canBackOpenDrawer({ routes: [] }), false)
  assert.equal(canBackOpenDrawer({ routes: [{ key: 'c', name: 'Chat' }], index: 0 }), true)
  assert.equal(canBackOpenDrawer({ routes: [{ key: 'c', name: 'Chat' }, { key: 'n', name: 'Needs' }], index: 1 }), false)
})

test('Drawer.tsx and ShellB.tsx wire Android hardwareBackPress through handleDrawerBack and canBackOpenDrawer', () => {
  const drawerSource = readFileSync(new URL('./Drawer.tsx', import.meta.url), 'utf8')
  const shellSource = readFileSync(new URL('./ShellB.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(drawerSource, /if\s*\(x\.value\s*>\s*-width\)\s*\{\s*close\(\)/)
  assert.match(drawerSource, /handleDrawerBack\(/)
  assert.match(shellSource, /canBackOpenDrawer\(/)
  assert.match(shellSource, /backOpens=/)
})
