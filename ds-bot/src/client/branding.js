export function installTitle(document, Observer = globalThis.MutationObserver) {
  const title = document.head.querySelector('title')
  const update = () => {
    if (document.title !== 'DS Bot') document.title = 'DS Bot'
  }
  update()
  const observer = new Observer(update)
  observer.observe(title, { childList: true, characterData: true, subtree: true })
  return () => observer.disconnect()
}
