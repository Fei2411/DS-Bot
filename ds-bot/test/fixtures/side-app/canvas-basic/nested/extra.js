(() => {
  const log = document.getElementById('nested-log')
  if (log) log.textContent = 'nested asset loaded'
  document.body.dataset.fixtureNested = 'loaded'
})()
