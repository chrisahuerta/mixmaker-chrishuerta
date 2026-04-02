const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectMusicFolder: () => ipcRenderer.invoke('select-music-folder'),
  scanMusicFolder: (folderPath) => ipcRenderer.invoke('scan-music-folder', folderPath),
  generateMix: (config) => ipcRenderer.invoke('generate-mix', config),
  exportMix: (config) => ipcRenderer.invoke('export-mix', config),
  saveMixHistory: (mixData) => ipcRenderer.invoke('save-mix-history', mixData),
  getMixHistory: () => ipcRenderer.invoke('get-mix-history'),
});
