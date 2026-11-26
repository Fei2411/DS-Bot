// Browser only: react-native-web decides whether Enter submits by `blurOnSubmit`,
// not `submitBehavior` (its keydown handler calls onSubmitEditing only when
// blurOnSubmit is true, and a multiline input defaults to false). So Enter is
// handled here instead, before that check. The native props would do nothing.
import type { TextInputKeyPressEvent } from 'react-native'

export const submitProps = (_sends: boolean): Record<string, never> => ({})

// Enter sends and never inserts a newline; Shift+Enter keeps the newline. A CJK IME
// ends a composition with Enter and reports keyCode 229, which must not send.
export function enterHandler(sends: boolean, send: () => void): ((event: TextInputKeyPressEvent) => void) | undefined {
  if (!sends) return undefined
  return event => {
    const native = event.nativeEvent as typeof event.nativeEvent & { isComposing?: boolean; keyCode?: number; shiftKey?: boolean }
    if (native.key !== 'Enter' || native.shiftKey || native.isComposing || native.keyCode === 229) return
    event.preventDefault()
    send()
  }
}
