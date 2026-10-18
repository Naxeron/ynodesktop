'use strict';

const fs = require('node:fs');
const { installOfficialInput } = require('./official-input');
const { createPlanner } = require('./official-path');
const { createOfficialController } = require('./official-controller');
const { createOfficialAssets } = require('./official-assets');
const { createOfficialMemory } = require('./official-memory');

async function setupOfficialNavbot(win, options, record) {
  const graph = JSON.parse(fs.readFileSync(options.graphPath, 'utf8'));
  const planner = createPlanner();
  const assets = createOfficialAssets(win, options);
  const script = `(() => {
    if (location.origin !== 'https://ynoproject.net' || location.pathname.split('/')[1] !== ${JSON.stringify(options.game)}) return;
    (${installOfficialInput.toString()})(${JSON.stringify(options.game)}, (${createOfficialMemory.toString()})());
    window.__ynoOfficialController = (${createOfficialController.toString()})(window.__ynoOfficialInput, (${createPlanner.toString()})());
    window.__ynoOfficialController.configure({ reroute: true });
    document.addEventListener('keydown', event => {
      if (event.isTrusted && event.target === document.getElementById('canvas')) window.__ynoOfficialController.interrupt();
    }, true);
  })()`;
  // Register before navigation so the official factory receives its input hooks.
  await win.webContents.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  const roomSockets = new Set();
  const roomSocket = url => { try { return new URL(url).pathname.endsWith('/room'); } catch (_) { return false; } };
  let roomOpens = 0, roomCloses = 0;
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Network.webSocketCreated' && roomSocket(params.url)) roomSockets.add(params.requestId);
    if (roomSockets.has(params.requestId)) {
      if (method === 'Network.webSocketHandshakeResponseReceived' && params.response.status === 101) {
        ++roomOpens; record('room-transport', { event: 'open', count: roomOpens });
      }
      if (method === 'Network.webSocketClosed') {
        roomSockets.delete(params.requestId); ++roomCloses; record('room-transport', { event: 'close', count: roomCloses });
      }
    }
    if (method === 'Runtime.exceptionThrown') {
      const e = params.exceptionDetails;
      record('page-script-error', { message: e.exception?.description?.split('\n')[0]?.slice(0, 300) || e.text, line: e.lineNumber });
    }
    if (method === 'Network.loadingFailed') record('resource-error', { type: params.type, error: params.errorText });
  });
  await win.webContents.debugger.sendCommand('Runtime.enable');
  await win.webContents.debugger.sendCommand('Network.enable');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: script });
  let generation = 0, loading = false, installed = null;
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) { ++generation; installed = null; assets.reset(); }
  });
  const routeOptions = (observed = [], blocked = []) => ({
    preferredExits: options.game === '2kki' ? new Map([['4:15,7', 10]]) : new Map(),
    observedExits: new Map(observed), blockedExits: new Set(blocked),
  });
  // Answers the page controller's replanning request after an unexpected map
  // or an unreachable departure, excluding what it observed for this command.
  async function reroute(request) {
    const valid = Number.isSafeInteger(request?.id) && [request.map, request.target_map].every(id => Number.isInteger(id) && id >= 1 && id <= 9999)
      && Array.isArray(request.observed) && request.observed.length <= 128
      && request.observed.every(entry => Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length <= 32 && Number.isInteger(entry[1]))
      && Array.isArray(request.blocked) && request.blocked.length <= 128 && request.blocked.every(key => typeof key === 'string' && key.length <= 32);
    if (!valid) return;
    let edges = null, message = null;
    try {
      edges = planner.findMapRoute(graph, request.map, request.target_map, routeOptions(request.observed, request.blocked));
      if (!edges) message = `No unambiguous route remains from map ${request.map} after excluding observed departures.`;
    } catch (error) { message = error.message; }
    record('reroute', { id: request.id, from: request.map, to: request.target_map,
      route: edges ? edges.map(edge => edge.targetMapId) : null, message });
    // A failed reply is retried on the next refresh; the page times out on its own.
    await win.webContents.executeJavaScript(
      `window.__ynoOfficialController?.reroute(${request.id}, ${JSON.stringify(edges)}, ${JSON.stringify(message)})`)
      .catch(error => record('reroute-error', { id: request.id, message: error.message }));
  }
  async function refresh() {
    if (loading || win.isDestroyed()) return;
    loading = true;
    const current = generation;
    let requested;
    try {
      const s = requested = await win.webContents.executeJavaScript('window.__ynoOfficialController?.read()');
      if (s?.reroute_request && current === generation) await reroute(s.reroute_request);
      if (!s?.ready || !s.map_known || installed === `${current}:${s.map_id}`) return;
      if (s.status === 'waiting_for_teleport') return;
      const map = await assets.ensureMap(s);
      if (!map || current !== generation) return;
      const transfers = planner.usableExits(graph, map.mapId)
        .filter(edge => edge.reviewed && edge.targetMapId === map.mapId)
        .map(edge => ({ ...edge, mapId: map.mapId }));
      const accepted = await win.webContents.executeJavaScript(`(() => {
        const input = window.__ynoOfficialInput;
        if (!input || input.read().map_id !== ${map.mapId} || input.read().teleport_sequence !== ${s.teleport_sequence}) return false;
        window.__ynoOfficialController.installMap(${map.mapId}, ${JSON.stringify(map.navigation)}, ${JSON.stringify(transfers)}, ${JSON.stringify(map.exitInteractions || [])});
        return true;
      })()`);
      if (accepted) { installed = `${current}:${map.mapId}`; record('map-passages', { map: map.mapId, width: map.navigation.width, height: map.navigation.height }); }
    } catch (error) {
      record('map-error', { message: error.message });
      if (current === generation && requested) await win.webContents.executeJavaScript(`(() => {
        const s = window.__ynoOfficialInput?.read();
        if (s?.map_id === ${requested.map_id} && s.teleport_sequence === ${requested.teleport_sequence})
          window.__ynoOfficialController?.fail(${JSON.stringify(`Map data unavailable: ${error.message}`)});
      })()`).catch(() => {});
    } finally { loading = false; }
  }
  function route(call, state) {
    if (call?.[0] !== '_Navbot_GoToMap') return call;
    const [map] = call[1];
    if (!state.map_known) throw new Error('Load a game before starting navigation.');
    // The bridge runs the checked Planetarium recipe itself when engine state is verified.
    if (options.game === '2kki' && [567, 568].includes(map) && state.map_id !== map) {
      throw new Error(`The Planetarium recipe requires verified official-engine state (${state.engine_state_error || 'unavailable'}).`);
    }
    const edges = planner.findMapRoute(graph, state.map_id, map, routeOptions());
    if (!edges) throw new Error('No unambiguous map route is available. Choose a nearer destination.');
    return [call[0], call[1], edges];
  }
  return { refresh, route, snapshot(result) {
    if (result.state) Object.assign(result.state, { room_transport_opens: roomOpens, room_transport_closes: roomCloses });
    return result;
  } };
}

module.exports = { setupOfficialNavbot };
