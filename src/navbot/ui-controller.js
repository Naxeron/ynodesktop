'use strict';

const { engineCommand } = require('./bridge');
const { loadMapCatalog } = require('./map-catalog');

function officialGamePage(url, game) {
  try {
    const page = new URL(url);
    return page.origin === 'https://ynoproject.net' && !page.username && !page.password
      && (!game || page.pathname.split('/')[1] === game);
  } catch {
    return false;
  }
}

// The preload is present on every navigation. Never trust the renderer to decide
// which window, frame, origin or game is allowed to control the local engine.
function authorized(event, win, options) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  const contents = win.webContents;
  const frame = event?.senderFrame;
  const game = options.enabled ? options.game : null;
  return event?.sender === contents && frame === contents.mainFrame
    && !!frame && officialGamePage(frame.url, game) && officialGamePage(contents.getURL(), game);
}

function uiCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Expected a command object');
  let clean;
  switch (command.op) {
    // Read-only: chooses the destination for the loaded game's current expedition.
    case 'expedition': return { op: command.op };
    case 'state':
    case 'stop': clean = { op: command.op }; break;
    case 'goto': clean = { op: command.op, x: command.x, y: command.y }; break;
    case 'goto-map': clean = { op: command.op, map: command.map, x: command.x, y: command.y }; break;
    default: throw new Error('Unsupported Navbot UI command');
  }
  engineCommand(clean);
  return clean;
}

function createNavbotUiController({ getWindow, getOptions, getBridge, getMapCatalog = loadMapCatalog }) {
  async function maps(event) {
    const options = getOptions();
    if (!authorized(event, getWindow(), options)) throw new Error('Navbot is only available in the main game window');
    if (!options.enabled) throw new Error('Navbot requires a Navbot session');
    return getMapCatalog(options.game);
  }
  async function command(event, input) {
    const win = getWindow();
    const options = getOptions();
    if (!authorized(event, win, options)) throw new Error('Navbot is only available in the main game window');
    const request = uiCommand(input);
    if (!options.enabled) {
      if (request.op !== 'state') throw new Error('Navbot requires a Navbot session');
      return { enabled: false, game: null, ready: false, message: 'Start a Navbot session to use navigation.' };
    }
    const bridge = getBridge(win);
    if (!bridge) {
      if (request.op !== 'state') throw new Error('Navbot is still starting');
      return { enabled: true, game: options.game, ready: false, message: 'Starting Navbot…' };
    }
    // This is the same queue used by the control socket. Stop cancels movement
    // from either source, and queued commands cannot follow a page navigation.
    const snapshot = await bridge.schedule(request, {
      disconnected: () => getWindow() !== win || !authorized(event, win, getOptions()),
    });
    return { ...snapshot, enabled: true, game: options.game };
  }
  return { state: event => command(event, { op: 'state' }), command, maps };
}

module.exports = { createNavbotUiController };
