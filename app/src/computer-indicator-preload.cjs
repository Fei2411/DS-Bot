// The floating computer-use indicator's only window API: send a button's
// action to the main process. The main process accepts the channel from this
// window alone.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('computerIndicator', {
  act: (kind, botId) => ipcRenderer.send('ds-bot:computer-indicator:act', kind, botId),
})
