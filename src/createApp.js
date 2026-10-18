const {
  app,
  BrowserWindow,
  session,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  protocol,
} = require('electron');
const contextMenu = require('electron-context-menu');
const Store = require('electron-store');
const promptInjection = require('./scripts/promptinjection');
const titlebar = require('./scripts/titlebar');
const navbotPanel = require('./scripts/navbot-panel');
const path = require('path');
const { parseGameName, isDreamWorldMap } = require('./scripts/utils');
const fs = require('fs');
const { readOptions } = require('./navbot/options');
const { startBridge } = require('./navbot/bridge');
const { createNavbotUiController } = require('./navbot/ui-controller');
const { prepareDebugGraph } = require('./navbot/graph');
let debugOptions = readOptions();

const store = new Store();

let mainWindow = null;
const navbotBridges = new WeakMap();
const navbotUi = createNavbotUiController({
  getWindow: () => mainWindow,
  getOptions: () => debugOptions,
  getBridge: win => navbotBridges.get(win),
});

// --- Session helpers (safeStorage with plaintext fallback + migration) ---

function restoreSession() {
  let value;

  if (store.has('ynoproject_sessionId_enc') && safeStorage.isEncryptionAvailable()) {
    try {
      value = safeStorage.decryptString(
        Buffer.from(store.get('ynoproject_sessionId_enc'), 'base64')
      );
    } catch {
      store.delete('ynoproject_sessionId_enc');
      return;
    }
  } else if (store.has('ynoproject_sessionId')) {
    // Legacy plaintext — will be encrypted on next save
    value = store.get('ynoproject_sessionId');
  }

  if (!value) return;
  session.defaultSession.cookies.set({
    url: 'https://ynoproject.net',
    name: 'ynoproject_sessionId',
    value,
    sameSite: 'strict',
  });
}

function saveSession() {
  session.defaultSession.cookies
    .get({ url: 'https://ynoproject.net' })
    .then((cookies) => {
      const sess = cookies.find((c) => c.name === 'ynoproject_sessionId');
      if (!sess) return;

      if (safeStorage.isEncryptionAvailable()) {
        store.set(
          'ynoproject_sessionId_enc',
          safeStorage.encryptString(sess.value).toString('base64')
        );
        store.delete('ynoproject_sessionId'); // remove legacy plaintext
      } else {
        store.set('ynoproject_sessionId', sess.value); // platform fallback
      }
    });
}

// --- Context menu ---

function confirmClearIndexedDB() {
  if (!mainWindow?.webContents) return;
  dialog.showMessageBox({
    type: 'question',
    buttons: ['Yes', 'No'],
    title: 'Clear IndexedDB',
    message:
      'Are you sure you want to clear IndexedDB? This should only be used if something is broken as it will delete your local save file.\nThis will also clear the cache and Local Storage.',
  }).then(({ response }) => {
    if (response !== 0) return;
    dialog.showMessageBox({
      type: 'warning',
      buttons: ['Yes', 'No'],
      title: 'Clear IndexedDB',
      message: 'ATTENTION: THIS WILL DELETE YOUR LOCAL SAVE FILE.\nAre you sure you want to continue?',
    }).then(({ response }) => {
      if (response !== 0) return;
      session.defaultSession
        .clearStorageData({ storages: ['indexdb', 'cache', 'localstorage'] })
        .then(() => mainWindow?.webContents.reloadIgnoringCache());
    });
  });
}

function setupContextMenu() {
  contextMenu({
    showSelectAll: false,
    showSearchWithGoogle: false,
    showInspectElement: false,
    append: () => [
      {
        label: 'Force Reload',
        click: () => mainWindow?.webContents.reloadIgnoringCache(),
      },
      {
        label: 'Clear IndexedDB',
        click: () => confirmClearIndexedDB(),
      },
      {
        label: 'Open Developer Tools',
        click: () => mainWindow?.webContents.openDevTools(),
      },
      {
        label: 'Zoom In',
        click: () => mainWindow?.webContents.send('zoomin'),
      },
      {
        label: 'Zoom Out',
        click: () => mainWindow?.webContents.send('zoomout'),
      },
    ],
  });
}

// --- Window ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1052,
    height: 798, // 30px for titlebar
    title: 'Yume Nikki Online Project',
    icon: path.join(__dirname, '..', 'assets', 'logo.png'),
    resizable: true,
    frame: true,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      contextIsolation: true,  // explicit — renderer JS cannot access Node APIs
      sandbox: true,           // renderer process is OS-sandboxed
      nodeIntegration: false,   // explicit — never allow Node in renderer
    },
  });
  const win = mainWindow;

  mainWindow.setMenu(null);
  mainWindow.setTitle('Yume Nikki Online Project');
  mainWindow.webContents.setMaxListeners(13);

  const bounds = store.get('windowBounds');
  if (bounds) mainWindow.setBounds(bounds);
  if (store.get('isMaximized')) mainWindow.maximize();

  mainWindow.on('close', () => {
    store.set('windowBounds', mainWindow.getBounds());
    store.set('isMaximized', mainWindow.isMaximized());
    saveSession();
  });

  mainWindow.on('closed', () => {
      navbotBridges.delete(win);
      if (mainWindow === win) mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (win.webContents.getURL() === 'about:blank') return;
    titlebar(win);
    navbotPanel(win);
    promptInjection(win);
    win.webContents.executeJavaScript(`
      if (document.title !== "Yume Nikki Online Project") {
        const content = document.getElementById('content');
        if (content) content.style.overflow = 'hidden';
        document.querySelector('#content')?.scrollTo(0, 0);
      }
    `);
  });

  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.send('log-app-version', app.getVersion());
  });

  // Guard top-level navigations — only ynoproject.net is allowed in the main frame
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const u = new URL(url);
      if (u.hostname !== 'ynoproject.net') {
        event.preventDefault();
      }
      if (debugOptions.enabled && u.pathname.split('/')[1] !== debugOptions.game) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let u;
    try { u = new URL(url); } catch { return { action: 'deny' }; }

    const isMap = isDreamWorldMap(u.href);
    const gameName = parseGameName(u.href);
    const isGame = typeof gameName === 'string' && gameName.trim().length > 0;

    // Game link — load in-app
    if (isGame && !isMap) {
      if (debugOptions.enabled && gameName.trim() !== debugOptions.game) return { action: 'deny' };
      mainWindow.loadURL(`https://ynoproject.net/${encodeURIComponent(gameName.trim())}`);
      return { action: 'deny' };
    }

    // Dream-world map image — open in a new hardened window
    if (isMap) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        },
      };
    }

    // Everything else — open in the system browser (HTTPS only, no credentials)
    if (u.protocol === 'https:' && !u.username && !u.password) {
      shell.openExternal(u.href);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  if (debugOptions.enabled) {
    startBridge(win, debugOptions, () => app.quit()).then(bridge => {
      if (win.isDestroyed()) {
        bridge.close();
        return;
      }
      navbotBridges.set(win, bridge);
      win.loadURL(`https://ynoproject.net/${debugOptions.game}/`).catch(error => {
        console.error('[Navbot Debug] Page load failed:', error.message);
      });
    }).catch(error => {
      console.error('[Navbot Debug] Failed to start control bridge:', error);
      app.exit(1);
    });
  } else {
    mainWindow.loadURL('https://ynoproject.net/');
  }

  return mainWindow;
}

// --- Engine Interception ---

function setupInterceptors() {
  // Normal desktop sessions use the official engine. Local replacement is opt-in.
  if (!debugOptions.enabled) return;
  debugOptions = prepareDebugGraph(debugOptions);
  if (debugOptions.engine === 'official') return;
  const allowed = new Map([
    ['ynoengine-simd.js', path.join(debugOptions.engineDir, 'ynoengine-simd.js')],
    ['ynoengine-simd.wasm', path.join(debugOptions.engineDir, 'ynoengine-simd.wasm')],
    ['map_graph.json', debugOptions.graphPath],
  ]);
  for (const file of ['ynoengine-simd.js', 'ynoengine-simd.wasm']) {
    if (!fs.existsSync(allowed.get(file))) throw new Error(`Missing local engine: ${allowed.get(file)}`);
  }
  protocol.handle('local-engine', async (request) => {
    const url = new URL(request.url);
    const filePath = url.pathname === '/' || url.pathname === '' ? allowed.get(url.hostname) : null;
    if (!filePath) return new Response('Unknown engine asset', { status: 404 });
    try {
      let body = await fs.promises.readFile(filePath);
      if (url.hostname === 'ynoengine-simd.js') {
        // Set the WASM URL before module creation; did-finish-load was too late.
        body = body.toString('utf8') + `
;(() => {
  const originalCreate = createEasyRpgPlayer;
  createEasyRpgPlayer = function(opts = {}) {
    const originalLocate = opts.locateFile;
    const options = Object.assign({}, opts, {
      navbotDebug: true,
      locateFile(file, prefix) {
        if (file.endsWith('.wasm')) return 'local-engine://ynoengine-simd.wasm';
        return originalLocate ? originalLocate(file, prefix) : prefix + file;
      }
    });
    return originalCreate(options).then(m => { window.Module = m; return m; });
  };
  window.createEasyRpgPlayer = createEasyRpgPlayer;
})();`;
      }
      return new Response(body, { headers: {
        'Access-Control-Allow-Origin': 'https://ynoproject.net',
        'Content-Type': url.hostname.endsWith('.wasm') ? 'application/wasm' : url.hostname.endsWith('.js') ? 'text/javascript' : 'application/json',
        'Cache-Control': 'no-store',
      } });
    } catch (error) {
      console.error('[Navbot Debug] Local asset unavailable:', filePath, error.message);
      return new Response('Local engine asset unavailable', { status: 404, headers: { 'Access-Control-Allow-Origin': 'https://ynoproject.net' } });
    }
  });
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['https://ynoproject.net/*'] },
    (details, callback) => {
      const filename = path.basename(new URL(details.url).pathname);
      if (filename === 'ynoengine-simd.js' || filename === 'ynoengine.js') {
        return callback({ redirectURL: 'local-engine://ynoengine-simd.js' });
      }
      callback({});
    }
  );
}

// --- IPC ---

function setupIpc() {
  ipcMain.handle('navbot:state', event => navbotUi.state(event));
  ipcMain.handle('navbot:command', (event, command) => navbotUi.command(event, command));
  ipcMain.handle('navbot:maps', event => navbotUi.maps(event));

  // Use the trusted mainWindow reference, not getFocusedWindow()
  ipcMain.on('minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
}

function getMainWindow() {
  return mainWindow;
}

module.exports = { setupContextMenu, createWindow, setupIpc, restoreSession, getMainWindow, store, setupInterceptors };
