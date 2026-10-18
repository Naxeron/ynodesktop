// Opt-in, same-user control socket. No HTTP listener, Node renderer access, or arbitrary evaluation.
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCommandQueue } = require('./command-queue');
const { runRoute, at, settled } = require('./route-runner');
const { ensureBike } = require('./bike');
const { currentExpedition, catalogMaps, chooseDestination, planetariumStarts } = require('./expedition');
const { loadMapCatalog } = require('./map-catalog');
const { createPlanner } = require('./official-path');
const { routeOptions } = require('./official');

const BUTTONS = Object.freeze({ up: 0, down: 1, left: 2, right: 3, decision: 4, cancel: 5, shift: 6 });
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}

function engineCommand(command) {
  switch (command.op) {
    case 'state': return null;
    case 'reconnect': return ['reconnect', []];
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

function rendererScript(call, game, expiresAt = Date.now() + 4500, generation = 0, backend = 'official') {
  return `(() => {
    const official = ${backend === 'official'};
    const m = official ? window.__ynoOfficialController : window.Module;
    const exports = m ? Object.keys(m).filter(k => k.startsWith('_Navbot_')) : [];
    const page = { title: document.title, pathname: location.pathname, hidden: document.hidden, focused: document.hasFocus?.(), debugClock: !!m?.navbotDebug, status: document.getElementById('status')?.textContent?.slice(0, 300) || null };
    if (official && !m?.read().ready) page.startup = {
      factoryAvailable: typeof window.createEasyRpgPlayer === 'function',
      lastScript: Array.from(document.scripts || []).filter(s => s.src).slice(-1).map(s => new URL(s.src).pathname)[0] || null,
      moduleStarted: typeof easyrpgPlayer !== 'undefined' && !!easyrpgPlayer.HEAPU8,
    };
    // Read only connection, location and expedition UI; never collect chat or account data.
    const text = element => element?.textContent?.trim().slice(0, 300) || null;
    page.loggedIn = typeof loggedIn === 'boolean' ? loggedIn : null;
    page.connectionState = typeof connStatus !== 'undefined' && Number.isInteger(connStatus) && connStatus >= 0 && connStatus <= 4 ? connStatus : null;
    page.sessionSocketState = typeof sessionWs !== 'undefined' && Number.isInteger(sessionWs?.readyState) && sessionWs.readyState >= 0 && sessionWs.readyState <= 3 ? sessionWs.readyState : null;
    page.cachedMapId = typeof cachedMapId === 'string' && /^[0-9]{4}$/.test(cachedMapId) ? cachedMapId : null;
    page.cachedLocationNames = typeof cachedLocations !== 'undefined' && Array.isArray(cachedLocations)
      ? cachedLocations.slice(0, 16).map(entry => typeof entry?.title === 'string' ? entry.title.slice(0, 300) : null).filter(Boolean) : null;
    page.connectionStatus = text(document.getElementById('connStatusText'));
    const locationElement = document.getElementById('locationText');
    page.location = text(locationElement);
    page.locationNames = Array.from(locationElement?.querySelectorAll('.wikiLink') || []).slice(0, 16).map(text).filter(Boolean);
    const expeditionList = document.getElementById('eventLocationsList');
    page.expeditions = expeditionList ? [] : null;
    let expeditionType = null;
    const weeklyLabel = typeof localizedMessages !== 'undefined' ? localizedMessages?.events?.types?.[1] : 'Weekly';
    const freeLabel = typeof localizedMessages !== 'undefined' ? localizedMessages?.events?.types?.['-1'] : 'Free Expedition';
    for (const element of Array.from(expeditionList?.children || []).slice(0, 100)) {
      if (!element.classList.contains('eventLocationListEntry')) {
        expeditionType = text(element.querySelector('h3')) || expeditionType;
        continue;
      }
      const nameElement = element.querySelector('.detailsContainer > div:first-of-type');
      page.expeditions.push({
        title: text(nameElement?.querySelector('.wikiLink')) || text(nameElement),
        type: expeditionType,
        kind: expeditionType === weeklyLabel ? 'weekly' : expeditionType && expeditionType === freeLabel ? 'free' : null,
        complete: element.classList.contains('complete'),
      });
      if (page.expeditions.length >= 40) break;
    }
    const expectedGame = ${JSON.stringify(game || null)};
    if (typeof eventsCache !== 'undefined' && Array.isArray(eventsCache.locations)) {
      const currentGame = expectedGame || location.pathname.split('/')[1];
      page.expeditions = eventsCache.locations.filter(entry => typeof entry?.title === 'string' && (entry.game || currentGame) === currentGame).slice(0, 40).map(entry => ({
        title: entry.title.slice(0, 300),
        type: typeof localizedMessages !== 'undefined' ? String(localizedMessages?.events?.types?.[entry.type] || '').slice(0, 300) : null,
        kind: entry.type === 1 ? 'weekly' : entry.type === -1 ? 'free' : null,
        complete: entry.complete === true,
      }));
    }
    if (expectedGame && (location.hostname !== 'ynoproject.net' || location.pathname.split('/')[1] !== expectedGame)) {
      ${call ? 'throw new Error("The current page does not match the debug session game");' : 'return { ready: false, page, exports, error: "game_mismatch" };'}
    }
    if (!m || (official ? !m.read().ready : typeof m._Navbot_GetState !== 'function' || typeof m.UTF8ToString !== 'function')) {
      ${call ? 'throw new Error("Navbot engine is not ready");' : 'return { ready: false, page, exports, ...(official ? { state: m?.read(), error: m ? m.read().error : "official_controller_unavailable" } : {}) };'}
    }
    const call = ${JSON.stringify(call)};
    let reconnectClicked;
    if (call) {
      const generation = ${generation};
      if (generation < (m.navbotDebugCommandGeneration || 0)) throw new Error('Command cancelled by Stop');
      if (call[0] !== '_Navbot_Stop' && Date.now() > ${expiresAt}) throw new Error('Command expired before the renderer could execute it');
      if (!official && call[0] !== 'reconnect' && typeof m[call[0]] !== 'function') throw new Error('Missing engine export: ' + call[0]);
      m.navbotDebugCommandGeneration = generation;
      if (call[0] === 'reconnect') {
        const button = document.getElementById('reconnectButton');
        reconnectClicked = !!button && typeof button.click === 'function' && !button.disabled && !button.classList?.contains('disabled') && page.connectionState !== 2;
        if (reconnectClicked) button.click();
      } else {
        if (official) m.execute(call);
        else m[call[0]](...call[1]);
      }
    }
    const state = official ? m.read() : JSON.parse(m.UTF8ToString(m._Navbot_GetState()));
    if (official && expectedGame === '2kki' && typeof m.query === 'function') {
      // The same switch, inventory and visited-map reads, from verified engine memory.
      const q = m.query({ switches: [132, 14, 39], items: [12], skills: [[2, 512]] });
      if (q) {
        const skill = q.skills?.['2:512'];
        state.forest_pier_visited = typeof skill === 'boolean' ? skill : null;
        state.bike_item_index = Number.isInteger(q.items?.[12]) ? q.items[12] : -1;
        const readSwitch = id => q.switches?.[id] === 0 ? false : q.switches?.[id] === 1 ? true : null;
        state.bike_active = readSwitch(132);
        const ladder = readSwitch(14), boat = readSwitch(39);
        state.bike_blocked = ladder === null || boat === null ? null : ladder || boat;
      }
    }
    if (!official && expectedGame === '2kki') {
      state.forest_pier_visited = typeof m._Navbot_HasSkill === 'function' && !!m._Navbot_HasSkill(2, 512);
      state.bike_item_index = typeof m._Navbot_GetItemIndex === 'function' ? m._Navbot_GetItemIndex(12) : -1;
      const readSwitch = id => {
        const value = typeof m._Navbot_GetSwitch === 'function' ? m._Navbot_GetSwitch(id) : -1;
        return value === 0 ? false : value === 1 ? true : null;
      };
      state.bike_active = readSwitch(132);
      const ladder = readSwitch(14), boat = readSwitch(39);
      state.bike_blocked = ladder === null || boat === null ? null : ladder || boat;
    }
    return { ready: true, page, exports, state, ...(call?.[0] === 'reconnect' ? { reconnectClicked } : {}) };
  })()`;
}

// Map IDs for an expedition title from the page's location cache and, for 2kki,
// the Explorer lookup the page itself uses when nothing else knows the title.
// Only validated map IDs leave the page. The Explorer wait stays short so the
// reply fits inside the control socket's 10-second idle timeout.
function expeditionLookupScript(title, game, explorerAllowed = true) {
  return `(async () => {
    const title = ${JSON.stringify(title)}, game = ${JSON.stringify(game)}, explorerAllowed = ${explorerAllowed === true};
    if (location.hostname !== 'ynoproject.net' || location.pathname.split('/')[1] !== game) throw new Error('The current page does not match the debug session game');
    const valid = id => /^\\d{1,4}$/.test(String(id)) && Number(id) >= 1 && Number(id) <= 9999;
    const cached = new Set();
    if (typeof locationCache === 'object' && locationCache) {
      for (const [key, locations] of Object.entries(locationCache)) {
        const match = /^\\d{4}_(\\d{4})$/.exec(key);
        if (match && valid(match[1]) && Array.isArray(locations) && locations.some(entry => entry?.title === title)) cached.add(Number(match[1]));
      }
    }
    let explorer = null, error = null;
    if (explorerAllowed && !cached.size && game === '2kki' && typeof send2kkiApiRequest === 'function') {
      try {
        const response = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Explorer lookup timed out')), 4000);
          send2kkiApiRequest('https://explorer.yume.wiki/getLocationInfo?locationName=' + encodeURIComponent(title), result => { clearTimeout(timeout); resolve(result); });
        });
        if (response?.title === title && Array.isArray(response.mapIds)) explorer = response.mapIds.filter(valid).map(Number).slice(0, 64);
        else error = 'Explorer lookup failed';
      } catch (cause) { error = cause.message; }
    }
    return { cached: [...cached].slice(0, 64), explorer, error };
  })()`;
}

// Resolves the loaded game's first unfinished expedition to a destination.
async function planExpedition({ read, lookup, game, catalog = loadMapCatalog(game), graph, planner = createPlanner() }) {
  const current = await read();
  const s = current?.state;
  if (!current?.ready || !s || !Number.isInteger(s.map_id) || s.map_id < 1 || s.map_known === false
    || !Number.isInteger(s.player_x) || !Number.isInteger(s.player_y)) {
    throw new Error('Load a game map before choosing the current expedition.');
  }
  const list = current.page?.expeditions;
  const entry = currentExpedition(current.page);
  if (!entry) {
    // The page's list markup exists before the session sends any expeditions.
    throw new Error(current.page?.loggedIn === false ? 'Sign in to load expeditions.'
      : Array.isArray(list) && list.length ? 'Every expedition for this game is complete.'
      : 'No expeditions are listed for this game yet. Let the game page load them, then try again.');
  }
  const named = catalogMaps(catalog, entry.title);
  const found = await lookup(entry.title, { explorer: !named.length });
  const mapIds = [...named.map(item => item.mapId), ...(found?.cached || []), ...(found?.explorer || [])];
  if (!mapIds.length) throw new Error(`No map is known for ${entry.title}${found?.error ? ` (${found.error})` : ''}.`);
  // Region restrictions apply only to maps that no unrestricted source names.
  const others = new Set([...(found?.cached || []), ...(found?.explorer || [])]);
  const regions = new Map(named.filter(item => item.regions && !others.has(item.mapId)).map(item => [item.mapId, item.regions]));
  const destination = chooseDestination({ graph: graph(), planner, routeOptions: () => routeOptions(game), game, title: entry.title, mapIds, state: s,
    regions, locationNames: Array.isArray(current.page?.cachedLocationNames) ? current.page.cachedLocationNames : null });
  return { current, expedition: { title: entry.title, type: entry.type || null, kind: entry.kind || null, ...destination } };
}

function createEngineSender(evaluate, { game, generation = () => 0, snapshot = result => result,
  record = () => {}, prepare = ensureBike, now = Date.now } = {}) {
  let preparations = 0;
  const direct = async (command, control) => {
    const call = engineCommand(command);
    if (call) record('command', { command });
    const result = await evaluate(call, control);
    record('state', snapshot(result));
    return result;
  };
  const send = async (command, control = {}) => {
    engineCommand(command);
    if (game !== '2kki' || !['goto', 'goto-map'].includes(command.op)) return direct(command, control);
    const acceptedGeneration = control.generation ?? generation();
    const check = () => {
      if (acceptedGeneration !== generation()) throw new Error('Command cancelled by Stop');
    };
    check();
    if (control.expiresAt !== undefined && now() > control.expiresAt) throw new Error('Command expired before Bike preparation');
    // Once accepted, each ordinary input gets its own dispatch deadline. The
    // same generation protects the entire preparation, including its reads.
    let interrupts;
    const guarded = async input => {
      check();
      const result = await direct(input, { ...control, generation: acceptedGeneration, expiresAt: now() + 4500 });
      check();
      const seen = result?.state?.user_interrupts;
      if (Number.isInteger(interrupts) && Number.isInteger(seen) && seen !== interrupts) throw new Error('Bike preparation cancelled by keyboard input');
      return result;
    };
    ++preparations;
    try {
      await guarded({ op: 'stop' });
      const initial = await guarded({ op: 'state' });
      interrupts = initial?.state?.user_interrupts;
      await prepare(guarded, { game, snapshot: initial, target: [command.map ?? initial.state?.map_id, command.x, command.y] });
      return await guarded(command);
    } finally {
      --preparations;
    }
  };
  Object.defineProperty(send, 'preparing', { get: () => preparations > 0 });
  return send;
}

function createRouteController(send, { game, run = runRoute, load = name => require(`./routes/${name}.json`), record = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let current = null;
  const snapshot = result => {
    if (!current || !result.state) return result;
    const { status, error, step, total, label, command, expeditionComplete, variant } = current;
    return { ...result, state: { ...result.state,
      engine_active: result.state.active, engine_status: result.state.status, engine_last_error: result.state.last_error,
      active: status === 'navigating', status, last_error: error || '',
      recipe: { name: 'Planetarium', step, total, label, status, map: command.map, x: command.x, y: command.y, expeditionComplete, variant },
    } };
  };
  function cancel() {
    const running = current?.status === 'navigating';
    current?.abort.abort();
    current = null;
    return running;
  }
  async function start(command, control) {
    if (command.map === 567) throw new Error('Choose Planetarium map 568 for the supported route.');
    const route = { abort: new AbortController(), command, status: 'navigating', error: '', step: 0, total: 0, label: 'Preparing route', expeditionComplete: null };
    current = route;
    let interrupts;
    const guarded = async input => {
      if (current !== route || route.abort.signal.aborted) throw new Error('Route cancelled');
      const result = await send(input, { generation: control.generation, expiresAt: Date.now() + 4500 });
      if (current !== route || route.abort.signal.aborted) throw new Error('Route cancelled');
      // The official page counts real keyboard input on the game canvas.
      const seen = result?.state?.user_interrupts;
      if (Number.isInteger(interrupts) && Number.isInteger(seen) && seen !== interrupts) throw new Error('Route cancelled by keyboard input');
      return result;
    };
    try {
      const initial = await guarded({ op: 'state' });
      const s = initial.state;
      interrupts = s?.user_interrupts;
      if (s?.backend === 'official' && s.capabilities?.recipes !== true) {
        throw new Error(`The Planetarium recipe requires verified official-engine state (${s.engine_state_error || 'unavailable'}).`);
      }
      if (!initial.ready || !s || !settled(s)) throw new Error('Wait until the player is standing on the map before starting the Planetarium route.');
      if (![...planetariumStarts, 568].includes(s.map_id)) throw new Error('Start the Planetarium route from the Nexus or the starting room.');
      const weekly = page => page?.expeditions?.find(entry => entry.title === 'Planetarium' && entry.kind === 'weekly');
      const needsExpedition = weekly(initial.page)?.complete === false;
      route.expeditionComplete = needsExpedition ? false : null;
      // shortcut: these waypoints follow inspected 2kki scripts; revalidate after game updates.
      let steps = s.map_id === 568 ? [] : [...load('2kki-planetarium')];
      route.variant = s.map_id === 568 ? 'local' : 'normal';
      if (s.map_id !== 568 && s.forest_pier_visited === true) {
        const join = steps.findIndex(step => step.map === 524 && step.walk?.[0] === 6 && step.walk[1] === 47);
        if (join < 0) throw new Error('The Planetarium shortcut is missing its Forest Pier connection.');
        steps = [...load('2kki-planetarium-shortcut'), ...steps.slice(join)];
        route.variant = 'forest-pier-shortcut';
      }
      if ([2, 4, 5].includes(s.map_id)) steps.unshift({ map: s.map_id, travel: [10, 3, 4], label: 'Reach the Nexus' });
      steps.push({ map: 568, walk: [command.x, command.y], label: 'Reach the requested Planetarium tile' });
      route.total = steps.length;
      void run(guarded, steps, { signal: route.abort.signal, onStep(index, step) {
        if (current !== route) return;
        route.step = index + 1;
        route.label = step.label || `Map ${step.map}`;
        record('route-step', { step: route.step, total: route.total, label: route.label });
      } }).then(async result => {
        if (current !== route) return;
        route.label = needsExpedition ? 'Confirm weekly expedition completion' : 'Confirm Planetarium location';
        const deadline = now() + 15000;
        for (;;) {
          if (!result.ready || !result.state || !at(result.state, [command.map, command.x, command.y]) || !settled(result.state)) throw new Error('The requested Planetarium tile was not reached.');
          const locationConfirmed = result.page?.locationNames?.includes('Planetarium');
          const hasRoomState = ['room_connected', 'room_sync_pending', 'room_synced_id'].some(key => Object.hasOwn(result.state, key));
          const roomConfirmed = !hasRoomState || (result.state.room_connected === true && result.state.room_sync_pending === false && result.state.room_synced_id === command.map);
          if (needsExpedition) route.expeditionComplete = weekly(result.page)?.complete === true;
          if (locationConfirmed && roomConfirmed && (!needsExpedition || route.expeditionComplete)) break;
          if (now() >= deadline) throw new Error(!roomConfirmed
            ? 'Reached the requested Planetarium tile, but the server room did not synchronize.'
            : locationConfirmed
            ? 'Reached Planetarium, but weekly expedition completion was not confirmed by the server.'
            : 'Reached the requested tile, but the exact Planetarium location was not confirmed.');
          await sleep(250);
          result = await guarded({ op: 'state' });
        }
        route.status = 'arrived';
        record('route-complete', { map: command.map, x: command.x, y: command.y, expeditionComplete: route.expeditionComplete });
      }).catch(error => {
        if (current !== route) return;
        route.status = 'error';
        route.error = error.message;
        record('route-error', { message: error.message });
      });
      return snapshot(initial);
    } catch (error) {
      if (current === route) cancel();
      throw error;
    }
  }
  return { start, cancel, snapshot, accepts: command => game === '2kki' && command.op === 'goto-map' && [567, 568].includes(command.map) };
}

async function startBridge(win, options, quit) {
  const engine = options.engine || 'official';
  fs.mkdirSync(options.runDir, { recursive: true, mode: 0o700 });
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yno-navbot-'));
  fs.chmodSync(socketDir, 0o700);
  const socketPath = path.join(socketDir, 'control.sock');
  const tracePath = path.join(options.runDir, 'trace.jsonl');
  const events = [];
  let sequence = 0;
  let closed = false;
  let rendererGeneration = 0;
  const record = (type, data) => {
    const event = { seq: ++sequence, time: new Date().toISOString(), type, ...data };
    events.push(event);
    if (events.length > 1000) events.shift();
    fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  };
  const evaluate = async (call, control = {}) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('Window has closed');
    if (official && call?.[0] === '_Navbot_GoToMap') {
      const current = await evaluate(null);
      call = official.route(call, current.state || {});
    }
    let timer;
    try {
      const result = await Promise.race([
        win.webContents.executeJavaScript(rendererScript(call, options.game, control.expiresAt, control.generation, engine), true),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer did not respond within 5 seconds')), 5000); }),
      ]);
      return official ? official.snapshot(result) : result;
    } finally { clearTimeout(timer); }
  };
  const official = engine === 'official'
    ? await require('./official').setupOfficialNavbot(win, options, record) : null;
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
  // Official mode prepares Bike and runs recipes only while its engine state is
  // verified; ensureBike and the route controller check the reported fields.
  const sendEngine = createEngineSender(evaluate, { game: options.game, generation: () => rendererGeneration,
    record, snapshot: result => routes.snapshot(result) });
  const routes = createRouteController(sendEngine, { game: options.game, record });
  let routeGraph;
  const graph = () => {
    if (routeGraph === undefined) {
      try { routeGraph = JSON.parse(fs.readFileSync(options.graphPath, 'utf8')); } catch { routeGraph = null; }
    }
    return routeGraph;
  };
  // Read-only, so it neither waits behind nor cancels queued movement.
  async function expedition() {
    const { current, expedition } = await planExpedition({
      read: async () => routes.snapshot(await evaluate(null)),
      lookup: async (title, { explorer }) => {
        let timer;
        try {
          return await Promise.race([
            win.webContents.executeJavaScript(expeditionLookupScript(title, options.game, explorer), true),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expedition lookup did not respond')), 4500); }),
          ]);
        } finally { clearTimeout(timer); }
      },
      game: options.game, graph,
    });
    record('expedition', { expedition });
    return { ...current, expedition };
  }
  const interruptsRoute = command => ['stop', 'goto', 'goto-map', 'hold', 'reload', 'close'].includes(command?.op);
  async function dispatch(command, control) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('Expected a command object');
    if (interruptsRoute(command)) {
      control = { ...control, generation: ++rendererGeneration };
      if (routes.cancel() && command.op !== 'stop') await evaluate(['_Navbot_Stop', []], control);
    }
    // Manual reconnects share Stop's renderer guard without cancelling travel.
    if (command.op === 'reconnect') control = { ...control, generation: rendererGeneration };
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
    engineCommand(command);
    if (routes.accepts(command)) return routes.start(command, control);
    return routes.snapshot(await sendEngine(command, control));
  }
  const queue = createCommandQueue(dispatch);
  const schedule = (command, control) => {
    if (command?.op === 'expedition') return expedition();
    if (interruptsRoute(command)) {
      if (!['reload', 'close'].includes(command.op)) engineCommand(command);
      const interrupted = routes.cancel() || sendEngine.preparing;
      if (interrupted && command.op !== 'stop') void queue({ op: 'stop' }, control).catch(error => record('error', { message: error.message }));
    }
    return queue(command, control);
  };
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
  const session = { version: 1, pid: process.pid, game: options.game, engine, socketPath, runDir: options.runDir, profileDir: options.profileDir, engineDir: official ? null : options.engineDir, graphPath: options.graphPath, sourceGraphPath: options.sourceGraphPath, graphProvenancePath: options.graphProvenancePath, startedAt: new Date().toISOString() };
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
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) routes.cancel();
  });
  let sampling = false;
  const timer = setInterval(async () => {
    if (closed || sampling) return;
    sampling = true;
    try {
      if (official) await official.refresh();
      record('state', routes.snapshot(await evaluate(null)));
    }
    catch (error) { record('sample-error', { message: error.message }); }
    finally { sampling = false; }
  }, 1000);
  function close() {
    if (closed) return;
    closed = true;
    routes.cancel();
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

module.exports = { startBridge, engineCommand, rendererScript, createEngineSender, createRouteController, planExpedition, expeditionLookupScript, BUTTONS };
