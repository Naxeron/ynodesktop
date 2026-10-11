const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  minimize: () => ipcRenderer.send("minimize"),
  maximize: () => ipcRenderer.send("maximize"),
  toggleDiscordRpc: () => ipcRenderer.invoke("toggleDiscordRpc"),
  getDiscordRpcEnabled: () => ipcRenderer.invoke("getDiscordRpcEnabled"),
  navbotState: () => ipcRenderer.invoke("navbot:state"),
  navbotCommand: (command) => ipcRenderer.invoke("navbot:command", command),
  navbotMaps: () => ipcRenderer.invoke("navbot:maps"),
});

ipcRenderer.on("zoomin", () => {
  webFrame.setZoomFactor(webFrame.getZoomFactor() + 0.1);
});

ipcRenderer.on("zoomout", () => {
  webFrame.setZoomFactor(webFrame.getZoomFactor() - 0.1);
});
