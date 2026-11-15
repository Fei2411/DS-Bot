/**
 * One connector as the computer lists it (ds-bot/src/host/connectors/index.js `rowFor`). The
 * phone reads only these fields; the row carries more (category, auth, tools, offFor…).
 * `account` is null until someone signs in, and `error` exists only after a failure.
 */
export interface ConnectorAuth {
  kind?: string
  keyUrl?: string
  token?: boolean
  client?: { id?: string; deviceFlow?: boolean }
}

export type ConnectorPending =
  | { kind: 'browser'; url: string; userCode?: never; verificationUri?: never }
  | { kind: 'device'; userCode: string; verificationUri: string; url?: never }
  | { kind: string; url?: string; userCode?: string; verificationUri?: string }

export interface ConnectorRow {
  id: string
  name: string
  about?: string
  state?: string
  account?: string | null
  error?: string
  tools?: number
  custom?: unknown
  readOnly?: boolean
  auth?: ConnectorAuth
  pending?: ConnectorPending
}

/**
 * What the computer's `state` answer carries under `connectors`: the rows and, beside them,
 * the mailbox. It is an object, not the list itself.
 */
export interface ConnectorsView { connectors?: ConnectorRow[]; mail?: { accounts?: unknown[]; google?: boolean } }

export type ConnectorConnectAction = 'connect-now' | 'oauth-signin' | 'key-form' | 'token-form'

export function connectorActionOf(row: ConnectorRow): ConnectorConnectAction {
  if (row.auth?.kind === 'none') return 'connect-now'
  if (row.auth?.kind === 'key') return 'key-form'
  if (row.auth?.kind === 'oauth') {
    return row.auth.client?.id || !row.auth.token ? 'oauth-signin' : 'token-form'
  }
  return 'token-form'
}

/**
 * Whether the mobile Connectors screen can set up this connector ID directly.
 * Mailbox ('mail') setup lives on the computer because it configures IMAP/SMTP
 * or desktop localhost Google OAuth outside the connector catalog rows.
 */
export const connectorCanConnectOnMobile = (connectorId: string): boolean => connectorId !== 'mail'

/**
 * The connector rows out of whatever `state.connectors` holds. The screen draws them with
 * `.map`; an object there ends the app, since a release build has nothing to catch the
 * TypeError. A bare list is read too, for a computer that sends one.
 */
export function connectorRows(view: unknown): ConnectorRow[] {
  const rows = Array.isArray(view) ? view : (view as ConnectorsView | null | undefined)?.connectors
  return Array.isArray(rows) ? rows.filter((row): row is ConnectorRow => row !== null && typeof row === 'object') : []
}
