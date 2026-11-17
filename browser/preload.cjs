// Brücke zwischen den Oberflächen (Browserleiste, Überlagerung) und dem Hauptprogramm.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harnes', {
  send: (channel, data) => ipcRenderer.send(channel, data),
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  on: (channel, fn) => {
    const handler = (_e, data) => fn(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.off(channel, handler);
  },
});
