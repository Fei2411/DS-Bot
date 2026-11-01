// The first-run import reads every chat of the team once, with the app's own DSH, before it copies it.

/**
 * The Sessions that this DSH refuses to read because a newer DSH wrote them. A damaged log is
 * not one of them: the user's own DSH cannot read it either, so it does not stop the import.
 * @param {{ open: (id: string, access: 'read') => Promise<{ read: () => Promise<unknown>, close: () => Promise<void> }> }} persistence
 * @param {string[]} ids
 * @returns {Promise<string[]>}
 */
export async function unreadableSessions(persistence, ids) {
  const unreadable = []
  for (const id of ids) {
    try {
      const handle = await persistence.open(id, 'read')
      try {
        await handle.read()
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error?.name === 'SessionFormatUnsupportedError') unreadable.push(id)
      else console.warn(`DS Bot: could not read ${id} while checking the team: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return unreadable
}
