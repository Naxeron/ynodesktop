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
    'src/main.js', 'src/scripts/navbot-panel.js', 'src/navbot/map-names/2kki.json',
    'src/navbot/overlays/2kki-start-route.json', 'assets/logo.png', 'LICENSE', 'map_graph.json', 'graphs/yume/map_graph.json',
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
  const result = vm.runInNewContext(rendererScript(engineCommand({ op: 'hold', key: 'up', frames: 6 })), context);
  assert.equal(result.state.map_id, 224);
  assert.deepEqual(calls, [[0, 6]]);
  context.window.Module = undefined;
  assert.equal(vm.runInNewContext(rendererScript(null), context).ready, false);
  assert.throws(() => vm.runInNewContext(rendererScript(['_Navbot_Stop', []]), context), /not ready/);
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
    { title: 'Nexus', type: 'Daily', complete: true },
    { title: 'Planetarium', type: 'Weekly', complete: false },
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
  assert.throws(() => vm.runInNewContext(rendererScript(['_Navbot_GoTo', [1, 2]], null, 0), context), /expired/);
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
