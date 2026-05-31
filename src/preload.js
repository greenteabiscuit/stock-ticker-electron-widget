const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('widgetWindow', {
  resize(width, height) {
    ipcRenderer.send('resize-widget', { width, height })
  },
  getBounds() {
    return ipcRenderer.invoke('get-widget-bounds')
  },
  move(x, y) {
    ipcRenderer.send('move-widget', { x, y })
  },
  setCompactMode(compact) {
    ipcRenderer.send('set-compact-mode', compact)
  },
  getSeededStocks() {
    return ipcRenderer.invoke('get-seeded-stocks')
  },
  fetchQuotes() {
    return ipcRenderer.invoke('fetch-quotes')
  },
  onCompactModeChanged(callback) {
    const listener = (_event, compact) => callback(Boolean(compact))

    ipcRenderer.on('compact-mode-changed', listener)

    return () => {
      ipcRenderer.removeListener('compact-mode-changed', listener)
    }
  },
  onRefreshQuotes(callback) {
    const listener = () => callback()

    ipcRenderer.on('refresh-quotes', listener)

    return () => {
      ipcRenderer.removeListener('refresh-quotes', listener)
    }
  },
})
