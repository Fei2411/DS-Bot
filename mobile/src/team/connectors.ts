/**
 * One connector as the computer lists it (ds-bot/src/host/connectors/index.js `rowFor`). The
 * phone reads only these fields; the row carries more (category, auth, tools, offFor…).
 * `account` is null until someone signs in, and `error` exists only after a failure.
 */
export interface ConnectorRow { id: string; name: string; state?: string; account?: string | null; error?: string }

/**
 * What the computer's `state` answer carries under `connectors`: the rows and, beside them,
 * the mailbox. It is an object, not the list itself.
 */
export interface ConnectorsView { connectors?: ConnectorRow[]; mail?: { accounts?: unknown[]; google?: boolean } }

/**
 * The connector rows out of whatever `state.connectors` holds. The screen draws them with
 * `.map`; an object there ends the app, since a release build has nothing to catch the
 * TypeError. A bare list is read too, for a computer that sends one.
 */
export function connectorRows(view: unknown): ConnectorRow[] {
  const rows = Array.isArray(view) ? view : (view as ConnectorsView | null | undefined)?.connectors
  return Array.isArray(rows) ? rows.filter((row): row is ConnectorRow => row !== null && typeof row === 'object') : []
}
