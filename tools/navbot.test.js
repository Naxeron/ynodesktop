const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { engineCommand, rendererScript } = require('../src/navbot/bridge');
const { readOptions } = require('../src/navbot/options');
const { runScenario } = require('./navbot-scenario');

test('the game renderer retains its sandbox, context isolation and disabled Node integration', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/createApp'), 'utf8');
  const preferences = source.match(/webPreferences:\s*\{([^}]+)\}/)?.[1];
  assert.ok(preferences, 'BrowserWindow webPreferences are explicit');
  assert.match(preferences, /\bsandbox:\s*true\b/);
  assert.match(preferences, /\bcontextIsolation:\s*true\b/);
  assert.match(preferences, /\bnodeIntegration:\s*false\b/);
});

test('normal windows have no legacy console-triggered capture or page logging', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/createApp'), 'utf8');
  assert.doesNotMatch(source, /Navbot Automated Test|navbot_stuck_|\.on\(['"]console-message['"]/);
});

test('desktop packaging retains runtime data and excludes local diagnostics and developer tools', () => {
  const path = require('node:path');
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
  const root = path.resolve(__dirname, '..');
  const filter = new FileMatcher(root, root, value => value, require('../package.json').build.files).createFilter();
  for (const file of [
    'src/main.js', 'src/scripts/navbot-panel.js', 'src/navbot/map-names/2kki.json', 'src/navbot/overlays/2kki-reflections-route.json',
    'src/navbot/overlays/2kki-start-route.json', 'src/navbot/routes/2kki-planetarium.json', 'src/navbot/routes/2kki-planetarium-shortcut.json', 'src/navbot/route-runner.js', 'src/navbot/bike.js', 'assets/logo.png', 'LICENSE', 'map_graph.json', 'graphs/yume/map_graph.json',
    'node_modules/sweetalert2/dist/sweetalert2.all.min.js',
  ]) assert.equal(filter(path.join(root, file), { isDirectory: () => false }), true, file);
  for (const file of [
    '.navbot/profiles/2kki/Cookies', 'scratch/lmu_parser.cpp', 'scratch/lmu_parser.wasm', 'tools/navbot.test.js',
    'check_store.js', 'dump_html.js', 'inject_2kki_nexus_routes.js', 'inject_nexus_route.js',
    'regenerate_graph.js', 'scratch_parse.js', 'scratch_dump.js', 'test_electron4.js',
    'test_csp.js', 'test_script_inject2.js', 'map_scraper.js', 'page.html', 'Map0900.lmu',
  ]) assert.equal(filter(path.join(root, file), { isDirectory: () => false }), false, file);
});

test('debug is opt-in and other games never silently share the 2kki graph', () => {
  assert.equal(readOptions([]).enabled, false);
  assert.equal(readOptions(['--navbot-debug']).enabled, true);
  assert.match(readOptions(['--navbot-game', 'yume']).graphPath, /graphs\/yume\/map_graph.json$/);
  assert.throws(() => readOptions(['--navbot-game', '../2kki']));
});

test('commands reject injection, invalid coordinates, unbounded input and unknown keys', () => {
  for (const command of [
    { op: 'eval', code: 'process.exit()' }, { op: 'hold', key: 'constructor' },
    { op: 'hold', key: 'up', frames: 601 }, { op: 'hold', key: 'up', frames: 0 },
    { op: 'goto', x: '1);alert(1)', y: 0 }, { op: 'goto-map', map: 0, x: 1, y: 2 },
  ]) assert.throws(() => engineCommand(command));
  assert.deepEqual(engineCommand({ op: 'hold', key: 'decision', frames: 3 }), ['_Navbot_HoldKey', [4, 3]]);
});

test('renderer reads fresh WASM state and dispatches a bounded key command', () => {
  const calls = [];
  const context = { window: { Module: {
    _Navbot_GetState: () => 123,
    UTF8ToString: ptr => { assert.equal(ptr, 123); return '{"scene":"Map","map_id":224}'; },
    _Navbot_HoldKey: (...args) => calls.push(args),
  } }, document: { title: '2kki', getElementById: () => null }, location: { pathname: '/2kki/' } };
  const result = vm.runInNewContext(rendererScript(engineCommand({ op: 'hold', key: 'up', frames: 6 }), undefined, undefined, undefined, 'local'), context);
  assert.equal(result.state.map_id, 224);
  assert.deepEqual(calls, [[0, 6]]);
  context.window.Module = undefined;
  assert.equal(vm.runInNewContext(rendererScript(null, undefined, undefined, undefined, 'local'), context).ready, false);
  assert.throws(() => vm.runInNewContext(rendererScript(['_Navbot_Stop', []], undefined, undefined, undefined, 'local'), context), /not ready/);
});

test('renderer uses the official controller by default even when a local Module is available', () => {
  const calls = [];
  const context = { window: {
    Module: { _Navbot_GetState() { throw new Error('Local engine must be explicitly selected'); }, UTF8ToString() {} },
    __ynoOfficialController: { read: () => ({ ready: true, backend: 'official', map_id: 10 }), execute: call => calls.push(call) },
  }, document: { title: '2kki', getElementById: () => null }, location: { pathname: '/2kki/' } };
  const command = engineCommand({ op: 'hold', key: 'up', frames: 6 });
  const result = vm.runInNewContext(rendererScript(command), context);
  assert.equal(result.state.backend, 'official');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [command]);
});

test('a session cannot drive another game with the selected graph', () => {
  const context = { window: {}, document: { title: 'Yume Nikki', getElementById: () => null }, location: { hostname: 'ynoproject.net', pathname: '/yume/' } };
  assert.equal(vm.runInNewContext(rendererScript(null, '2kki'), context).error, 'game_mismatch');
  assert.throws(() => vm.runInNewContext(rendererScript(['_Navbot_Stop', []], '2kki'), context), /does not match/);
});

test('renderer reports connection, location and expedition state without unrelated page text', () => {
  const element = (textContent, selectors = {}, classes = []) => ({
    textContent,
    querySelector: selector => selectors[selector] || null,
    querySelectorAll: selector => selectors[selector] || [],
    classList: { contains: name => classes.includes(name) },
  });
  const expedition = (title, complete) => element('unrelated row text', {
    '.detailsContainer > div:first-of-type': element(`${title} localized title`, { '.wikiLink': element(title) }),
  }, ['eventLocationListEntry', ...(complete ? ['complete'] : [])]);
  const entries = [
    element('', { h3: element('Daily') }), expedition('Nexus', true),
    element('', { h3: element('Weekly') }), expedition('Planetarium', false),
  ];
  const elements = {
    connStatusText: element(' Connected '),
    locationText: element(' Planetarium (プラネタリウム) ', { '.wikiLink': [element('Planetarium'), element('プラネタリウム')] }),
    eventLocationsList: { children: entries },
  };
  const requestedIds = [];
  const context = {
    window: {}, location: { pathname: '/2kki/' },
    document: { title: '2kki', getElementById: id => { requestedIds.push(id); return elements[id]; } },
  };
  const result = vm.runInNewContext(rendererScript(null), context);
  assert.equal(result.page.connectionStatus, 'Connected');
  assert.equal(result.page.location, 'Planetarium (プラネタリウム)');
  assert.deepEqual(Array.from(result.page.locationNames), ['Planetarium', 'プラネタリウム']);
  assert.deepEqual(JSON.parse(JSON.stringify(result.page.expeditions)), [
    { title: 'Nexus', type: 'Daily', kind: null, complete: true },
    { title: 'Planetarium', type: 'Weekly', kind: 'weekly', complete: false },
  ]);
  entries[3] = expedition('Planetarium', true);
  elements.connStatusText = element('Disconnected');
  assert.equal(vm.runInNewContext(rendererScript(null), context).page.expeditions[1].complete, true);
  assert.equal(vm.runInNewContext(rendererScript(null), context).page.connectionStatus, 'Disconnected');
  assert.deepEqual([...new Set(requestedIds)], ['status', 'connStatusText', 'locationText', 'eventLocationsList']);

  elements.connStatusText = element('x'.repeat(500));
  elements.locationText = element('x'.repeat(500), { '.wikiLink': Array(50).fill(element('x'.repeat(500))) });
  elements.eventLocationsList.children = Array(200).fill(expedition('Planetarium', true));
  const bounded = vm.runInNewContext(rendererScript(null), context).page;
  assert.equal(bounded.connectionStatus.length, 300);
  assert.equal(bounded.location.length, 300);
  assert.equal(bounded.locationNames.length, 16);
  assert.equal(bounded.locationNames[0].length, 300);
  assert.equal(bounded.expeditions.length, 40);

  delete elements.connStatusText;
  delete elements.locationText;
  delete elements.eventLocationsList;
  const unavailable = vm.runInNewContext(rendererScript(null), context).page;
  assert.equal(unavailable.connectionStatus, null);
  assert.equal(unavailable.location, null);
  assert.equal(unavailable.expeditions, null);
});

test('a stalled renderer cannot execute an expired movement command later', () => {
  let moved = false;
  const context = { window: { Module: { _Navbot_GetState() {}, UTF8ToString() {}, _Navbot_GoTo() { moved = true; } } }, document: { title: '2kki', getElementById: () => null }, location: { pathname: '/2kki/' } };
  assert.throws(() => vm.runInNewContext(rendererScript(['_Navbot_GoTo', [1, 2]], null, 0, undefined, 'local'), context), /expired/);
  assert.equal(moved, false);
});

function harness(states, options) {
  let tick = 0, index = 0;
  const commands = [];
  return runScenario(async command => {
    commands.push(command);
    if (command.op === 'state') return states[Math.min(index++, states.length - 1)];
    if (command.op === 'capture') return { path: '/test/capture.png' };
    return {};
  }, options, { now: () => tick, sleep: async ms => { tick += ms; } }).then(result => ({ result, commands }));
}
const state = (extra = {}) => ({ ready: true, state: { scene: 'Map', map_id: 224, player_x: 9, player_y: 10, active: false, graph_loaded: true, ...extra } });
const target = { map: 10, x: 9, y: 27 };

test('boot works without a Continue slot, and uses frame-held decisions', async () => {
  const title = { ready: true, state: { scene: 'Title' } };
  const { result, commands } = await harness([title, title, title, title, title, state()], { timeoutMs: 10000 });
  assert.equal(result.outcome, 'map-ready');
  assert.deepEqual(commands.find(c => c.op === 'hold'), { op: 'hold', key: 'decision', frames: 1 });
  assert.deepEqual(commands.slice(-2).map(c => c.op), ['stop', 'capture']);
});

test('tile arrival does not pass on map arrival alone', async () => {
  const { result } = await harness([state(), state({ map_id: 10, active: true }), state({ map_id: 10, player_y: 27 })], { target, timeoutMs: 5000 });
  assert.equal(result.outcome, 'arrived');
  assert.equal(result.lastState.player_y, 27);
});

test('stationary active bot fails, then releases input and captures evidence', async () => {
  const { result, commands } = await harness([state(), state({ active: true })], { target, timeoutMs: 5000, stallMs: 1000 });
  assert.equal(result.outcome, 'stalled');
  assert.equal(result.ok, false);
  assert.deepEqual(commands.slice(-2).map(c => c.op), ['stop', 'capture']);
});

test('unready engine times out; inactive navigation fails instead of reporting success', async () => {
  const timeout = await harness([{ ready: false }], { timeoutMs: 1000 });
  assert.equal(timeout.result.outcome, 'timeout');
  const stopped = await harness([state()], { target, timeoutMs: 2000 });
  assert.equal(stopped.result.outcome, 'navigation-stopped');
});

test('malformed/missing graph stops scenario before issuing a route', async () => {
  const { result, commands } = await harness([state({ graph_loaded: false, graph_error: 'invalid_graph' })], { target, timeoutMs: 2000 });
  assert.equal(result.outcome, 'graph-unavailable');
  assert.equal(commands.some(c => c.op === 'goto-map'), false);
});

test('renderer/transport error still attempts cleanup and capture', async () => {
  const commands = [];
  const result = await runScenario(async command => {
    commands.push(command.op);
    if (command.op === 'state') throw new Error('Renderer crashed');
    return {};
  }, {});
  assert.equal(result.outcome, 'error');
  assert.equal(result.error, 'Renderer crashed');
  assert.deepEqual(commands, ['state', 'stop', 'capture']);
});

test('interrupting a scenario releases input and captures evidence', async () => {
  const controller = new AbortController();
  controller.abort();
  const { result, commands } = await harness([state()], { target, signal: controller.signal });
  assert.equal(result.outcome, 'interrupted');
  assert.deepEqual(commands.map(c => c.op), ['stop', 'capture']);
});

test('boot handles the first-run language selection before title', async () => {
  const language = { ready: true, state: { scene: 'Language' } };
  const { result, commands } = await harness([language, language, language, language, language, state()], { timeoutMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(commands.filter(c => c.op === 'hold').length, 1);
});

test('official startup reports unavailable menu state without sending blind inputs', async () => {
  const startup = state({ backend: 'official', scene: null, map_known: false, map_id: null, player_x: null, player_y: null });
  for (const requestedTarget of [null, target]) {
    const { result, commands } = await harness([startup], { target: requestedTarget, timeoutMs: 10000, startupGraceMs: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'error');
    assert.match(result.error, /Continue or start a game/);
    assert.equal(result.targetSent, false);
    assert.deepEqual(commands.map(command => command.op), ['state', 'stop', 'capture']);
  }
  // By default it waits while the page is still verifying engine state, sending no input.
  const { result, commands } = await harness([startup], { target, timeoutMs: 60000 });
  assert.equal(result.outcome, 'error');
  assert.ok(result.elapsedMs >= 20000, String(result.elapsedMs));
  assert.ok(commands.every(command => ['state', 'stop', 'capture'].includes(command.op)));
  // Engine state verified during the grace period lets boot continue.
  const verified = await harness([startup, startup, { ready: true, state: { backend: 'official', scene: 'Title', title_index: 0,
    title_new_game_index: 0, title_continue_index: 1, map_known: false, map_id: null } }], { timeoutMs: 5000 });
  assert.equal(verified.result.error, null);
  assert.ok(verified.commands.some(command => command.op === 'hold'));
});

test('official navigation uses observed tiles and waits for stationary arrival without inventing scene/event state', async () => {
  const official = extra => state({ backend: 'official', scene: null, map_known: true,
    moving: null, event_running: null, message_active: null, async_pending: null,
    observed_stationary: true, ...extra });
  const { result, commands } = await harness([
    official(), official(), official(),
    official({ map_id: 10, player_y: 27, active: true, observed_stationary: false }),
    official({ map_id: 10, player_y: 27, active: true, observed_stationary: false }),
    official({ map_id: 10, player_y: 27 }),
  ], { target, timeoutMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'arrived');
  assert.equal(result.elapsedMs, 3000);
  assert.deepEqual(result.visitedMaps, [224, 10]);
  assert.equal(result.lastState.scene, null);
  assert.equal(result.lastState.event_running, null);
  assert.deepEqual(commands.filter(command => ['goto-map', 'hold'].includes(command.op)), [{ op: 'goto-map', ...target }]);
  assert.deepEqual(commands.slice(-2).map(command => command.op), ['stop', 'capture']);
});

test('official scenario waits for the controller to finish teleport settling', async () => {
  const official = extra => state({ backend: 'official', scene: null, map_known: true, observed_stationary: true, ...extra });
  const settling = official({ map_id: 10, player_y: 27, active: true, status: 'settling_after_teleport' });
  const { result } = await harness([
    official(), official(), official(), settling, settling, settling, settling,
    official({ map_id: 10, player_y: 27, status: 'arrived' }),
  ], { target, timeoutMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.elapsedMs, 4000);
  assert.equal(result.lastState.status, 'arrived');
});

test('official boot does not accept unavailable coordinates or unobserved stationarity as map readiness', async () => {
  for (const patch of [{ player_x: null, player_y: null }, { observed_stationary: false }]) {
    const { result, commands } = await harness([state({ backend: 'official', scene: null, map_known: true,
      observed_stationary: true, ...patch })], { timeoutMs: 2000 });
    assert.equal(result.outcome, 'timeout');
    assert.equal(commands.some(command => ['hold', 'goto-map'].includes(command.op)), false);
  }
});

test('boot waits through in-map events, messages and invalid transition positions', async () => {
  for (const blocked of [{ event_running: true }, { message_active: true }, { async_pending: true }, { player_x: -1, player_y: -1 }]) {
    const { result } = await harness([state(blocked)], { timeoutMs: 1000 });
    assert.equal(result.outcome, 'timeout');
  }
});

test('boot does not mistake the idle map-load frame for the end of an autorun event', async () => {
  const { result } = await harness([state(), state({ event_running: true })], { timeoutMs: 2000 });
  assert.equal(result.outcome, 'timeout');
});

test('arrival waits for the foreground event to finish and records the observed route', async () => {
  const { result } = await harness([
    state(), state(), state(),
    state({ map_id: 900, active: true, event_running: true }),
    state({ map_id: 10, player_y: 27, active: true, event_running: true }),
    state({ map_id: 10, player_y: 27 }),
  ], { target, timeoutMs: 10000 });
  assert.equal(result.outcome, 'arrived');
  assert.deepEqual(result.visitedMaps, [224, 900, 10]);
  assert.equal(result.lastState.event_running, undefined);
});

test('a frozen engine clock has a distinct outcome from a pathfinding stall', async () => {
  const { result, commands } = await harness([
    state({ frame: 20 }), state({ frame: 20 }), state({ frame: 20 }), state({ frame: 20, active: true }),
  ], { target, timeoutMs: 5000, stallMs: 1000 });
  assert.equal(result.outcome, 'engine-stalled');
  assert.deepEqual(commands.slice(-2).map(c => c.op), ['stop', 'capture']);
});

test('stationary recipe scripts and confirmation waits outlive the ordinary position stall', async () => {
  for (const status of ['navigating', 'confirming']) {
    const position = status === 'confirming' ? { map_id: target.map, player_x: target.x, player_y: target.y } : {};
    const { result, commands } = await harness([
      state({ frame: 0 }), state({ frame: 1 }), state({ frame: 2 }),
      ...Array.from({ length: 8 }, (_, index) => state({
        ...position, frame: index + 3, active: false,
        event_running: status === 'navigating', recipe: { step: 7, status },
      })),
      state({ map_id: target.map, player_y: target.y, frame: 11, recipe: { step: 8, status: 'arrived' } }),
    ], { target, timeoutMs: 10000, stallMs: 1000 });
    assert.equal(result.outcome, 'arrived', status);
    assert.ok(result.elapsedMs >= 5500, status);
    assert.equal(result.lastState.recipe.status, 'arrived', status);
    assert.deepEqual(commands.slice(-2).map(command => command.op), ['stop', 'capture']);
  }
});

test('recipe waits preserve engine-stall detection and the overall scenario timeout', async () => {
  const frozen = await harness([
    state({ frame: 20 }), state({ frame: 21 }), state({ frame: 22 }),
    state({ frame: 23, active: true, recipe: { step: 7, status: 'navigating' } }),
  ], { target, timeoutMs: 10000, stallMs: 1000 });
  assert.equal(frozen.result.outcome, 'engine-stalled');
  assert.deepEqual(frozen.commands.slice(-2).map(command => command.op), ['stop', 'capture']);

  const advancing = await harness([
    state({ frame: 0 }), state({ frame: 1 }), state({ frame: 2 }),
    ...Array.from({ length: 10 }, (_, index) => state({
      frame: index + 3, active: true, recipe: { step: 7, status: 'navigating' },
    })),
  ], { target, timeoutMs: 4000, stallMs: 1000 });
  assert.equal(advancing.result.outcome, 'timeout');
  assert.deepEqual(advancing.commands.slice(-2).map(command => command.op), ['stop', 'capture']);
});

test('failed recipe confirmation is not successful tile arrival', async () => {
  const { result } = await harness([
    state(), state(), state(),
    state({ map_id: target.map, player_y: target.y, recipe: { step: 7, status: 'error' } }),
  ], { target, timeoutMs: 5000 });
  assert.equal(result.outcome, 'navigation-stopped');
  assert.equal(result.ok, false);
});

const BIKE_QUERY = { switches: [132, 14, 39], items: [12], skills: [[2, 512]] };
function officialPage(controller, pathname = '/2kki/') {
  return { window: { __ynoOfficialController: controller }, document: { title: '2kki', getElementById: () => null },
    location: { hostname: 'ynoproject.net', pathname } };
}
const unknownBike = { forest_pier_visited: null, bike_item_index: null, bike_active: null, bike_blocked: null };
const bikeFields = state => ({ forest_pier_visited: state.forest_pier_visited, bike_item_index: state.bike_item_index,
  bike_active: state.bike_active, bike_blocked: state.bike_blocked });

test('official 2kki renderer fills Forest Pier and Bike fields from verified controller queries', () => {
  const requests = [];
  let answer = { switches: { 132: 1, 14: 0, 39: 0 }, items: { 12: 3 }, skills: { '2:512': true } };
  const controller = {
    read: () => ({ ready: true, backend: 'official', map_id: 10, ...unknownBike }),
    query: request => { requests.push(JSON.parse(JSON.stringify(request))); return answer; },
  };
  const context = officialPage(controller);
  const read = (game = '2kki') => bikeFields(vm.runInNewContext(rendererScript(null, game), context).state);
  assert.deepEqual(read(), { forest_pier_visited: true, bike_item_index: 3, bike_active: true, bike_blocked: false });
  assert.deepEqual(requests, [BIKE_QUERY], 'only the fixed switches, Bike item and Forest Pier skill are read');
  for (const [switches, blocked] of [[{ 132: 0, 14: 1, 39: 0 }, true], [{ 132: 0, 14: 0, 39: 1 }, true], [{ 132: 0, 14: 1, 39: 1 }, true]]) {
    answer = { switches, items: { 12: 0 }, skills: { '2:512': false } };
    assert.deepEqual(read(), { forest_pier_visited: false, bike_item_index: 0, bike_active: false, bike_blocked: blocked });
  }
  // Unreadable switches (null), out-of-range switches (-1), unowned or unreadable items and actors stay unknown.
  answer = { switches: { 132: null, 14: -1, 39: 0 }, items: { 12: null }, skills: { '2:512': null } };
  assert.deepEqual(read(), { forest_pier_visited: null, bike_item_index: -1, bike_active: null, bike_blocked: null });
  answer = { switches: { 132: 2, 14: 0, 39: null }, items: { 12: -1 }, skills: { '2:512': 1 } };
  assert.deepEqual(read(), { forest_pier_visited: null, bike_item_index: -1, bike_active: null, bike_blocked: null });
  answer = {};
  assert.deepEqual(read(), { forest_pier_visited: null, bike_item_index: -1, bike_active: null, bike_blocked: null });
  // Without verified memory the controller answers null and reported fields are kept.
  answer = null;
  assert.deepEqual(read(), unknownBike);
  const count = requests.length;
  context.location.pathname = '/yume/';
  assert.deepEqual(read('yume'), unknownBike);
  assert.equal(requests.length, count, 'other games never query 2kki memory');
  context.location.pathname = '/2kki/';
  delete controller.query;
  assert.deepEqual(read(), unknownBike, 'an older controller without query() keeps unknown fields');
});

test('official renderer turns the real controller query into Bike fields only while memory is verified', () => {
  const { createOfficialController } = require('../src/navbot/official-controller');
  const { createPlanner } = require('../src/navbot/official-path');
  let memory = { available: true, scene: 'Map', moving: false, event_running: false, message_active: false, async_pending: false,
    menu_allowed: true, vehicle_type: 0, direction: 2 };
  const requests = [];
  const input = {
    read: () => ({ ready: true, map_known: true, map_id: 10, player_x: 3, player_y: 4, frame: 5, time_ms: 1000, position_changed_ms: 0,
      teleport_sequence: 0, held_key: null, hold_remaining: 0, error: null, input_timing: 'logical-frames', memory: { ...memory } }),
    subscribe() {}, stop() {},
    query: request => { requests.push(request); return memory.available ? { switches: { 132: 0, 14: 0, 39: 0 }, items: { 12: 0 }, skills: { '2:512': true } } : null; },
  };
  const context = officialPage(createOfficialController(input, createPlanner()));
  const verified = vm.runInNewContext(rendererScript(null, '2kki'), context).state;
  assert.deepEqual(bikeFields(verified), { forest_pier_visited: true, bike_item_index: 0, bike_active: false, bike_blocked: false });
  assert.equal(verified.capabilities.recipes, true);
  assert.equal(verified.scene, 'Map');
  assert.equal(verified.menu_allowed, true);
  assert.deepEqual(requests.map(request => JSON.parse(JSON.stringify(request))), [BIKE_QUERY]);
  memory = { available: false, error: 'Game_Player typeinfo not found' };
  const unverified = vm.runInNewContext(rendererScript(null, '2kki'), context).state;
  assert.deepEqual(bikeFields(unverified), unknownBike);
  assert.equal(unverified.capabilities.recipes, false);
  assert.equal(unverified.engine_state_error, 'Game_Player typeinfo not found');
  assert.equal(unverified.scene, null);
});

// Official sessions with verified memory report a string scene and the Title choice.
const officialTitle = (extra = {}) => ({ ready: true, state: { backend: 'official', scene: 'Title', map_known: false, map_id: null,
  player_x: null, player_y: null, title_index: 0, title_new_game_index: 0, title_continue_index: 1, async_pending: false,
  moving: null, event_running: null, message_active: null, observed_stationary: false, active: false, ...extra } });
const officialMap = (extra = {}) => state({ backend: 'official', scene: 'Map', map_known: true, moving: false, event_running: false,
  message_active: false, async_pending: false, observed_stationary: true, status: 'idle', ...extra });
const statesBeforeHold = commands => commands.slice(0, commands.findIndex(command => command.op === 'hold')).filter(command => command.op === 'state').length;

test('official boot confirms Title only on the New Game or Continue choice', async () => {
  for (const [title_index, expected] of [[0, 5], [1, 5]]) {
    const { result, commands } = await harness([...Array(5).fill(officialTitle({ title_index })), officialMap()], { timeoutMs: 10000 });
    assert.equal(result.outcome, 'map-ready');
    assert.equal(commands.filter(command => command.op === 'hold').length, 1);
    assert.equal(statesBeforeHold(commands), expected, 'the first press still waits two seconds after the scene appears');
  }
  // Language, Import and Exit choices are never confirmed; the press follows the cursor reaching New Game.
  for (const title_index of [2, 3, null]) {
    const states = [...Array(8).fill(officialTitle({ title_index })), officialTitle({ title_index: 0 }), officialMap()];
    const { result, commands } = await harness(states, { timeoutMs: 10000 });
    assert.equal(result.outcome, 'map-ready', String(title_index));
    if (title_index === null) {
      // An unreadable index falls back to the local engine's behaviour.
      assert.equal(statesBeforeHold(commands), 5);
    } else {
      assert.equal(statesBeforeHold(commands), 9, String(title_index));
      assert.equal(commands.filter(command => command.op === 'hold').length, 1);
    }
  }
  const exit = await harness([officialTitle({ title_index: 3, title_new_game_index: 0, title_continue_index: 1 })], { timeoutMs: 10000 });
  assert.equal(exit.result.outcome, 'timeout');
  assert.equal(exit.commands.some(command => command.op === 'hold'), false);
  assert.equal(exit.result.lastState.scene, 'Title');
});

test('official boot never presses while the engine has an asynchronous request pending', async () => {
  for (const scene of ['Title', 'Logo', 'Language', 'File', 'Load']) {
    const pending = officialTitle({ scene, async_pending: true });
    const blocked = await harness([pending], { timeoutMs: 6000 });
    assert.equal(blocked.result.outcome, 'timeout', scene);
    assert.equal(blocked.commands.some(command => command.op === 'hold'), false, scene);
    const { result, commands } = await harness([...Array(8).fill(pending), officialTitle({ scene }), officialMap()], { timeoutMs: 10000 });
    assert.equal(result.outcome, 'map-ready', scene);
    assert.equal(statesBeforeHold(commands), 9, scene);
    assert.deepEqual(commands.find(command => command.op === 'hold'), { op: 'hold', key: 'decision', frames: 1 });
  }
});

test('official boot with engine scenes uses local stationary rules plus observed stillness', async () => {
  const ready = await harness([officialMap()], { timeoutMs: 10000 });
  assert.equal(ready.result.outcome, 'map-ready');
  assert.equal(ready.result.elapsedMs, 1000);
  assert.deepEqual(ready.result.visitedMaps, [224]);
  for (const blocked of [{ observed_stationary: false }, { moving: true }, { event_running: true }, { message_active: true },
    { async_pending: true }, { status: 'waiting_for_teleport' }, { status: 'settling_after_teleport' }, { map_known: false },
    { scene: 'Menu' }, { scene: 'Item' }, { player_x: null }, { player_x: -1, player_y: -1 }]) {
    const { result, commands } = await harness([officialMap(blocked)], { timeoutMs: 2000 });
    assert.equal(result.outcome, 'timeout', JSON.stringify(blocked));
    assert.equal(commands.some(command => ['hold', 'goto-map'].includes(command.op)), false, JSON.stringify(blocked));
  }
  // An autorun event after the idle map-load frame restarts the readiness wait.
  const autorun = await harness([officialMap(), officialMap({ event_running: true }), officialMap()], { timeoutMs: 10000 });
  assert.equal(autorun.result.outcome, 'map-ready');
  assert.equal(autorun.result.elapsedMs, 2000);
});

test('official arrival with engine scenes waits for events and observed stillness at the target tile', async () => {
  const destination = { map_id: 10, player_y: 27 };
  const { result, commands } = await harness([
    officialMap(), officialMap(), officialMap(),
    officialMap({ ...destination, active: true, event_running: true }),
    officialMap({ ...destination, observed_stationary: false }),
    officialMap({ ...destination, status: 'settling_after_teleport', active: true }),
    officialMap(destination),
  ], { target, timeoutMs: 10000 });
  assert.equal(result.outcome, 'arrived');
  // Route sent at 1000 ms; three unsettled samples, then 500 ms of settled arrival.
  assert.equal(result.elapsedMs, 3500);
  assert.equal(result.lastState.status, 'idle');
  assert.deepEqual(commands.filter(command => ['goto-map', 'hold'].includes(command.op)), [{ op: 'goto-map', ...target }]);
});

test('official startup without engine scenes reports the memory reader error', async () => {
  const startup = extra => state({ backend: 'official', scene: null, map_known: false, map_id: null, player_x: null, player_y: null, ...extra });
  const failed = await harness([startup({ engine_state_error: 'Game_Player typeinfo not found' })], { target, timeoutMs: 10000, startupGraceMs: 0 });
  assert.equal(failed.result.outcome, 'error');
  assert.match(failed.result.error, /cannot report startup menus \(Game_Player typeinfo not found\)\. Continue or start a game/);
  assert.equal(failed.result.targetSent, false);
  assert.deepEqual(failed.commands.map(command => command.op), ['state', 'stop', 'capture']);
  for (const extra of [{}, { engine_state_error: null }, { scene: undefined }]) {
    const { result } = await harness([startup(extra)], { timeoutMs: 10000, startupGraceMs: 0 });
    assert.match(result.error, /\(engine state unavailable\)/);
  }
  // A string scene is engine-reported: an off-map Title is a startup menu, not an error.
  const title = await harness([officialTitle({ title_index: 3 })], { timeoutMs: 1000 });
  assert.equal(title.result.outcome, 'timeout');
  assert.equal(title.result.error, null);
});
