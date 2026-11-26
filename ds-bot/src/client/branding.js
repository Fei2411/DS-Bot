export function installTitle(document, Observer = globalThis.MutationObserver) {
  const update = () => {
    if (document.title !== 'DS Bot') document.title = 'DS Bot'
  }
  update()
  const title = document.head?.querySelector('title') ?? null
  const observer = new Observer(update)
  if (title !== null) observer.observe(title, { childList: true, characterData: true, subtree: true })
  return () => observer.disconnect()
}
