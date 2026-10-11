const { app, ipcMain, protocol } = require('electron');
const { readOptions } = require('./navbot/options');
const debugOptions = readOptions();
if (debugOptions.enabled) {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  require('fs').mkdirSync(debugOptions.profileDir, { recursive: true, mode: 0o700 });
  app.setPath('userData', debugOptions.profileDir);
  // A separate profile owns separate local saves and cookies.
  app.setPath('sessionData', debugOptions.profileDir);
  if (!app.requestSingleInstanceLock()) app.exit(1);
}
const { setupContextMenu, createWindow, setupIpc, restoreSession, getMainWindow, store, setupInterceptors } = require('./createApp');

protocol.registerSchemesAsPrivileged([
  { scheme: 'local-engine', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true } }
]);
const { connectDiscordRpc, updateRichPresence, clearPresence } = require('./scripts/discordRpcUtils');

setupContextMenu();

let rpcInterval = null;

function startRpc() {
  if (rpcInterval) return;
  connectDiscordRpc().then(() => {
    rpcInterval = setInterval(() => {
      const win = getMainWindow();
      if (!win) return;
      updateRichPresence(win.webContents, win.webContents.getURL()).catch(console.error);
    }, 1500);
  }).catch((err) => {
    console.error('Failed to connect Discord RPC:', err);
  });
}

function stopRpc() {
  if (rpcInterval) {
    clearInterval(rpcInterval);
    rpcInterval = null;
  }
  clearPresence().catch(console.error);
}

app.whenReady().then(() => {
  setupInterceptors();
  restoreSession();
  setupIpc();
  createWindow();

  ipcMain.handle('getDiscordRpcEnabled', () => store.get('discordRpcEnabled', true));

  ipcMain.handle('toggleDiscordRpc', () => {
    const newState = !store.get('discordRpcEnabled', true);
    store.set('discordRpcEnabled', newState);
    console.log(`[Discord RPC] ${newState ? 'enabled' : 'disabled'} by user`);
    if (newState) startRpc();
    else stopRpc();
    return newState;
  });

  if (!debugOptions.enabled && store.get('discordRpcEnabled', true)) {
    startRpc();
  }
});

app.on('window-all-closed', () => app.quit());
