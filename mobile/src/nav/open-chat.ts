import { StackActions, type NavigationAction, type NavigationState, type PartialState } from '@react-navigation/core'
import type { ChatTarget } from '../screens/TeamList.tsx'

// Components outside Stack.Navigator (the drawer and the notice banner) receive the
// NavigationContainer ref, which exposes CommonActions and dispatch but not stack
// helpers like popTo. Dispatching StackActions.popTo works from both the container
// and any screen or modal sheet inside the stack.
export function openChat(navigation: { dispatch: (action: NavigationAction) => void }, target?: ChatTarget) {
  navigation.dispatch(StackActions.popTo('Chat', target, target === undefined ? { merge: true } : undefined))
}

type StateLike = NavigationState | PartialState<NavigationState> | undefined

// Which chat is currently visible on top of the root stack, accounting for the
// launch state before explicit route params are set (where Chat falls back to the
// first Main Bot).
export function activeChatTarget(state: StateLike, fallbackBotId?: string): ChatTarget | undefined {
  const index = state?.index ?? 0
  const top = state?.routes?.[index]
  if (top?.name !== 'Chat') return undefined
  const params = top.params as Partial<ChatTarget> | undefined
  if ((params?.kind === 'bot' || params?.kind === 'room') && typeof params.id === 'string' && params.id !== '') {
    return { kind: params.kind, id: params.id }
  }
  return fallbackBotId ? { kind: 'bot', id: fallbackBotId } : undefined
}
