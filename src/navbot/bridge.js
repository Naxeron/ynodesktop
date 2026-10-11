// Opt-in, same-user control socket. No HTTP listener, Node renderer access, or arbitrary evaluation.
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCommandQueue } = require('./command-queue');

const BUTTONS = Object.freeze({ up: 0, down: 1, left: 2, right: 3, decision: 4, cancel: 5, shift: 6 });
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}

function engineCommand(command) {
  switch (command.op) {
    case 'state': return null;
    case 'stop': return ['_Navbot_Stop', []];
    case 'goto': return ['_Navbot_GoTo', [integer(command.x, 'x', 0, 9999), integer(command.y, 'y', 0, 9999)]];
    case 'goto-map': return ['_Navbot_GoToMap', [integer(command.map, 'map', 1, 9999), integer(command.x, 'x', 0, 9999), integer(command.y, 'y', 0, 9999)]];
    case 'hold': {
      const button = BUTTONS[command.key];
      if (!Object.hasOwn(BUTTONS, command.key)) throw new Error(`key must be one of ${Object.keys(BUTTONS).join(', ')}`);
      return ['_Navbot_HoldKey', [button, integer(command.frames ?? 1, 'frames', 1, 600)]];
    }
    default: throw new Error(`Unknown operation: ${command.op}`);
  }
}

function rendererScript(call, game, expiresAt = Date.now() + 4500, generation = 0) {
  return `(() => {
    const m = window.Module;
    const exports = m ? Object.keys(m).filter(k => k.startsWith('_Navbot_')) : [];
    const page = { title: document.title, pathname: location.pathname, hidden: document.hidden, focused: document.hasFocus?.(), debugClock: !!m?.navbotDebug, status: document.getElementById('status')?.textContent?.slice(0, 300) || null };
    // Read only connection, location and expedition UI; never collect chat or account data.
    const text = element => element?.textContent?.trim().slice(0, 300) || null;
    page.connectionStatus = text(document.getElementById('connStatusText'));
    const locationElement = document.getElementById('locationText');
    page.location = text(locationElement);
    page.locationNames = Array.from(locationElement?.querySelectorAll('.wikiLink') || []).slice(0, 16).map(text).filter(Boolean);
    const expeditionList = document.getElementById('eventLocationsList');
    page.expeditions = expeditionList ? [] : null;
    let expeditionType = null;
    for (const element of Array.from(expeditionList?.children || []).slice(0, 100)) {
      if (!element.classList.contains('eventLocationListEntry')) {
        expeditionType = text(element.querySelector('h3')) || expeditionType;
        continue;
      }
      const nameElement = element.querySelector('.detailsContainer > div:first-of-type');
      page.expeditions.push({
        title: text(nameElement?.querySelector('.wikiLink')) || text(nameElement),
        type: expeditionType,
        complete: element.classList.contains('complete'),
      });
      if (page.expeditions.length >= 40) break;
    }
    const expectedGame = ${JSON.stringify(game || null)};
    if (expectedGame && (location.hostname !== 'ynoproject.net' || location.pathname.split('/')[1] !== expectedGame)) {
      ${call ? 'throw new Error("The current page does not match the debug session game");' : 'return { ready: false, page, exports, error: "game_mismatch" };'}
    }
    if (!m || typeof m._Navbot_GetState !== 'function' || typeof m.UTF8ToString !== 'function') {
      ${call ? 'throw new Error("Navbot engine is not ready");' : 'return { ready: false, page, exports };'}
    }
    const call = ${JSON.stringify(call)};
    if (call) {
      const generation = ${generation};
      if (generation < (m.navbotDebugCommandGeneration || 0)) throw new Error('Command cancelled by Stop');
      if (call[0] !== '_Navbot_Stop' && Date.now() > ${expiresAt}) throw new Error('Command expired before the renderer could execute it');
      if (typeof m[call[0]] !== 'function') throw new Error('Missing engine export: ' + call[0]);
      m.navbotDebugCommandGeneration = generation;
      m[call[0]](...call[1]);
    }
    return { ready: true, page, exports, state: JSON.parse(m.UTF8ToString(m._Navbot_GetState())) };
  })()`;
}

async function startBridge(win, options, quit) {
  fs.mkdirSync(options.runDir, { recursive: true, mode: 0o700 });
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yno-navbot-'));
  fs.chmodSync(socketDir, 0o700);
  const socketPath = path.join(socketDir, 'control.sock');
  const tracePath = path.join(options.runDir, 'trace.jsonl');
  const events = [];
  let sequence = 0;
  let closed = false;
  const record = (type, data) => {
    const event = { seq: ++sequence, time: new Date().toISOString(), type, ...data };
    events.push(event);
    if (events.length > 1000) events.shift();
    fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  };
  const evaluate = async (call, control = {}) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Window has closed');
    let timer;
    try {
      return await Promise.race([
        win.webContents.executeJavaScript(rendererScript(call, options.game, control.expiresAt, control.generation), true),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer did not respond within 5 seconds')), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const capture = async () => {
    const filename = `capture-${Date.now()}-${sequence}.png`;
    const output = path.join(options.runDir, filename);
    let timer;
    let image;
    try {
      image = await Promise.race([
        win.webContents.capturePage(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Capture timed out')), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
    if (image.isEmpty()) throw new Error('Window capture is empty');
    fs.writeFileSync(output, image.toPNG(), { mode: 0o600 });
    record('capture', { path: output });
    return { path: output };
  };
  async function dispatch(command, control) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Expected a command object');
    if (command.op === 'events') return { events: events.filter(e => e.seq > integer(command.after ?? 0, 'after', 0, Number.MAX_SAFE_INTEGER)) };
    if (command.op === 'capture') return capture();
    if (command.op === 'reload') {
      await evaluate(['_Navbot_Stop', []], control);
      record('reload', {});
      win.webContents.reloadIgnoringCache();
      return { reloading: true };
    }
    if (command.op === 'close') {
      await evaluate(['_Navbot_Stop', []], control).catch(() => {});
      setTimeout(quit, 100);
      return { closing: true };
    }
    const call = engineCommand(command);
    if (call) record('command', { command });
    const result = await evaluate(call, control);
    record('state', result);
    return result;
  }
  const schedule = createCommandQueue(dispatch);
  const server = net.createServer(socket => {
    const receivedAt = Date.now();
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16384) return socket.destroy();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.removeAllListeners('data');
      const respond = async () => {
        try {
          const command = JSON.parse(buffer.slice(0, end));
          const result = await schedule(command, {
            receivedAt,
            disconnected: () => socket.destroyed || Date.now() - receivedAt >= 10000,
          });
          if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: true, result })}\n`);
        } catch (error) {
          record('error', { message: error.message });
          if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`);
        }
      };
      void respond();
    });
  });
  server.maxConnections = 32;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  const session = { version: 1, pid: process.pid, game: options.game, socketPath, runDir: options.runDir, profileDir: options.profileDir, engineDir: options.engineDir, graphPath: options.graphPath, sourceGraphPath: options.sourceGraphPath, graphProvenancePath: options.graphProvenancePath, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(options.runDir, 'session.json'), JSON.stringify(session, null, 2), { mode: 0o600 });
  const latest = path.resolve(__dirname, '../../.navbot/latest.json');
  fs.mkdirSync(path.dirname(latest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(latest, JSON.stringify(session, null, 2), { mode: 0o600 });
  record('session', session);
  console.log(`[Navbot Debug] Control ready: ${socketPath}`);
  win.webContents.on('console-message', (event, ...args) => {
    const details = event.message !== undefined ? event : (typeof args[0] === 'object' ? args[0] : { level: args[0], message: args[1] });
    // Avoid collecting routine chat, cookie or account data from the live page.
    if (String(details.message).includes('[Navbot]')) record('console', { level: details.level, message: String(details.message).slice(0, 4000) });
  });
  win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame) record('load-error', { code, description });
  });
  win.webContents.on('render-process-gone', (_event, details) => record('renderer-gone', details));
  let sampling = false;
  const timer = setInterval(async () => {
    if (closed || sampling) return;
    sampling = true;
    try { record('state', await evaluate(null)); }
    catch (error) { record('sample-error', { message: error.message }); }
    finally { sampling = false; }
  }, 1000);
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    server.close();
    fs.rmSync(socketPath, { force: true });
    fs.rmdirSync(socketDir);
  }
  win.once('closed', close);
  return {
    close,
    session,
    // Both the local socket and desktop UI must use this queue so their Stop
    // commands invalidate each other's pending movement.
    schedule(command, control) {
      if (closed) return Promise.reject(new Error('Navbot session has closed'));
      return schedule(command, control);
    },
  };
}

module.exports = { startBridge, engineCommand, rendererScript, BUTTONS };
