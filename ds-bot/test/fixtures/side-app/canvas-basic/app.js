(() => {
  const button = document.getElementById('increment')
  const status = document.getElementById('status')
  let count = 0
  button?.addEventListener('click', (event) => {
    event.preventDefault()
    count += 1
    status.textContent = `Clicked ${count} time${count === 1 ? '' : 's'}.`
    document.body.dataset.fixtureClicks = String(count)
  })
  document.body.dataset.fixtureReady = 'app'
})()
