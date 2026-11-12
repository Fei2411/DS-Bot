import { createContext } from 'react'

// Callbacks must not ride route params (non-serializable). These change which
// computer the app links to; Boot owns that state.
export interface ComputerActions {
  /** Show pairing for another computer, keeping the current ones. */
  add: () => void
  /** Link to another saved computer now. */
  switchTo: (hostDeviceId: string) => void
  /** Re-read the saved list after it changed elsewhere. */
  reload: () => void
}

const noop = () => {}
export const ComputersCtx = createContext<ComputerActions>({ add: noop, switchTo: noop, reload: noop })
