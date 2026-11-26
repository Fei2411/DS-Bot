import type { NavigationState, PartialState } from '@react-navigation/core'

type StateLike = NavigationState | PartialState<NavigationState> | undefined

// Only the root Chat screen should turn a hardware back press into opening
// the sidebar; pushed screens and modal sheets must let the navigator pop them.
export function canBackOpenDrawer(state: StateLike): boolean {
  const routes = state?.routes
  if (routes === undefined || routes.length === 0) return false
  const top = routes[state?.index ?? 0]
  return top?.name === 'Chat'
}

// On Android Chat, a single back press with the sidebar closed opens it and
// consumes the event; a press while the sidebar is already open returns false
// so the system handler minimizes the app instead of closing the drawer.
export function handleDrawerBack({
  isOpen,
  backOpens,
  open,
}: {
  isOpen: boolean
  backOpens: boolean
  open: () => void
}): boolean {
  if (!backOpens || isOpen) return false
  open()
  return true
}
