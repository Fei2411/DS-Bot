import { createContext } from 'react'

// Callbacks must not ride route params (non-serializable). onForget unlinks the
// computer and returns to the pairing screen.
export const ForgetCtx = createContext<() => void>(() => {})
