// Native only: submitting on Enter is React Native's own behavior. `submitBehavior`
// is what clears Android's IME_FLAG_NO_ENTER_ACTION, so the IME draws its send key
// instead of a plain newline; iOS reads the same prop. react-native-web ignores it,
// so the web build handles Enter itself (composer.enter.web.ts) and never needs a
// key handler here.
export const submitProps = (sends: boolean): { returnKeyType?: 'send'; submitBehavior?: 'submit' } =>
  sends ? { returnKeyType: 'send', submitBehavior: 'submit' } : {}

export const enterHandler = (_sends: boolean, _send: () => void): undefined => undefined
