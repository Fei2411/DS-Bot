const owners = new Map()

export function registerPopupOwner(owner, popup) {
  owners.set(popup, owner)
  return () => { owners.delete(popup) }
}

export function ownedPopups(roots) {
  const allowed = [...roots]
  for (let index = 0; index < allowed.length; index += 1) {
    for (const [popup, owner] of owners) {
      const element = popup.current
      if (element?.isConnected && !element.hasAttribute('data-leaving') && allowed[index].contains(owner.current) && !allowed.some(root => root.contains(element))) allowed.push(element)
    }
  }
  return allowed.slice(roots.length)
}
