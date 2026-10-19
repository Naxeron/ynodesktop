'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { currentExpedition, catalogMaps, chooseDestination } = require('../src/navbot/expedition');
const { planExpedition, expeditionLookupScript } = require('../src/navbot/bridge');
const { createPlanner } = require('../src/navbot/official-path');
const { applyGraphOverlay } = require('../src/navbot/graph');
const { routeOptions } = require('../src/navbot/official');

const planner = createPlanner();
const edge = (targetMapId, startX, startY, targetX, targetY) => ({ targetMapId, startX, startY, targetX, targetY });
// 10 -> 20 -> 30 (known landing), 10 -> 40 (unknown landing), 10 -> 50 -> 60 -> 70.
const graph = {
  10: [edge(20, 1, 1, 5, 6), edge(40, 2, 1, 0, 0), edge(50, 3, 1, 4, 4)],
  20: [edge(30, 1, 1, 7, 8)],
  50: [edge(60, 1, 1, 2, 2)],
  60: [edge(70, 1, 1, 9, 9)],
};
const state = { map_id: 10, player_x: 3, player_y: 4 };
const choose = (mapIds, extra = {}) => chooseDestination({ graph, planner, routeOptions: () => routeOptions('yume'), game: 'yume', title: 'World', mapIds, state, ...extra });

test('the first unfinished expedition is chosen in page order', () => {
  assert.equal(currentExpedition(null), null);
  assert.equal(currentExpedition({ expeditions: null }), null);
  assert.equal(currentExpedition({ expeditions: [{ title: 'A', complete: true }, { title: ' ', complete: false }] }), null);
  assert.deepEqual(currentExpedition({ expeditions: [{ title: 'A', complete: true }, { title: 'B', complete: false }, { title: 'C', complete: false }] }),
    { title: 'B', complete: false });
  // Missing completion flags are unknown, not unfinished.
  assert.equal(currentExpedition({ expeditions: [{ title: 'A' }] }), null);
});

test('catalog names resolve only exact titles to valid map IDs, keeping the regions that name them', () => {
  const area = { x1: 0, y1: 0, x2: 9, y2: 9 };
  const catalog = { entries: [{ mapId: 12, name: 'World' }, { mapId: 13, name: 'World: North' }, { mapId: 0, name: 'World' }, { mapId: 14, name: 'world' },
    { mapId: 15, name: 'World', regions: [area] }, { mapId: 16, name: 'World', regions: [area] }, { mapId: 16, name: 'World' }] };
  assert.deepEqual(catalogMaps(catalog, 'World'), [{ mapId: 12, regions: null }, { mapId: 15, regions: [area] }, { mapId: 16, regions: null }]);
  assert.deepEqual(catalogMaps(undefined, 'World'), []);
});

test('the destination prefers the fewest hops to a known landing tile', () => {
  assert.deepEqual(choose([30, 70]), { map: 30, x: 7, y: 8, hops: 2, route: [20, 30], mapIds: [30, 70] });
  // A one-hop route with an unknown (0,0) landing loses to a known landing.
  assert.deepEqual(choose([40, 70]), { map: 70, x: 9, y: 9, hops: 3, route: [50, 60, 70], mapIds: [40, 70] });
  assert.deepEqual(choose([40]), { map: 40, x: null, y: null, hops: 1, route: [40], mapIds: [40] });
  assert.deepEqual(choose(['0030', '30', 30]).mapIds, [30], 'duplicate and padded IDs collapse');
});

test('already standing in an expedition map keeps the current tile', () => {
  assert.deepEqual(choose([70, 10]), { map: 10, x: 3, y: 4, hops: 0, route: [], mapIds: [10, 70] });
  assert.deepEqual(choose([10], { graph: null }).map, 10, 'no graph is needed for the current map');
});

test('unknown, unreachable and unroutable destinations fail with readable reasons', () => {
  assert.throws(() => choose([]), /No map is known for World/);
  assert.throws(() => choose([0, 10000, 'x']), /No map is known for World/);
  assert.throws(() => choose([99]), /No known route reaches World \(map 99\) from map 10/);
  assert.throws(() => choose([30], { graph: null }), /Map routing is unavailable/);
});

test('2kki Planetarium uses the recipe map and its checked tile without graph edges', () => {
  // The served graph has no route into 567/568; the bridge's recipe takes over.
  const plan = (map, extra = {}) => chooseDestination({ graph: { 10: [edge(20, 1, 1, 5, 6)] }, planner, routeOptions: () => routeOptions('2kki'),
    game: '2kki', title: 'Planetarium', mapIds: [567, 568], state: { map_id: map, player_x: 1, player_y: 2 }, ...extra });
  for (const start of [2, 4, 5, 10]) assert.deepEqual(plan(start), { map: 568, x: 3, y: 75, hops: null, route: [], recipe: true, mapIds: [568] });
  assert.deepEqual(plan(568), { map: 568, x: 3, y: 75, hops: 0, route: [], mapIds: [568] });
  assert.throws(() => plan(20), /checked route to Planetarium starts from the Nexus or the starting room/);
});

test('entrances into a map named by coordinate regions must land inside them', () => {
  // Two entrances into map 30: the shorter one lands outside the title's region.
  const g = { 10: [edge(30, 1, 1, 50, 50), edge(20, 2, 1, 5, 6)], 20: [edge(30, 1, 1, 4, 4)] };
  const regions = new Map([[30, [{ x1: 0, y1: 0, x2: 9, y2: 9 }]]]);
  assert.deepEqual(chooseDestination({ graph: g, planner, routeOptions: () => routeOptions('yume'), game: 'yume', title: 'World', mapIds: [30], state, regions }),
    { map: 30, x: 4, y: 4, hops: 2, route: [20, 30], mapIds: [30] });
  // An unrestricted axis (-1) accepts any coordinate on it.
  assert.equal(chooseDestination({ graph: g, planner, routeOptions: () => routeOptions('yume'), game: 'yume', title: 'World', mapIds: [30], state,
    regions: new Map([[30, [{ x1: -1, y1: 40, x2: -1, y2: 60 }]]]) }).hops, 1);
  assert.throws(() => chooseDestination({ graph: g, planner, routeOptions: () => routeOptions('yume'), game: 'yume', title: 'World', mapIds: [30], state,
    regions: new Map([[30, [{ x1: 90, y1: 90, x2: 99, y2: 99 }]]]) }), /No known route reaches World/);
});

test('standing in an expedition map counts only where the page names the title', () => {
  const plan = (locationNames, mapIds = [10]) => chooseDestination({ graph, planner, routeOptions: () => routeOptions('yume'), game: 'yume', title: 'World',
    mapIds, state, locationNames });
  assert.equal(plan(['World: North']).hops, 0, 'sub-areas after a colon belong to the world');
  assert.equal(plan(null).hops, 0, 'unknown page names keep the current tile');
  assert.throws(() => plan(['Elsewhere']), /not named World here/);
  assert.deepEqual(plan(['Elsewhere'], [10, 30]), { map: 30, x: 7, y: 8, hops: 2, route: [20, 30], mapIds: [10, 30] });
});

test('planning reads the page, merges every map source and reports the chosen route', async () => {
  const lookups = [];
  const page = { expeditions: [{ title: 'Done', type: 'Daily', kind: null, complete: true }, { title: 'World', type: 'Weekly', kind: 'weekly', complete: false }] };
  const result = await planExpedition({
    read: async () => ({ ready: true, page, state: { ...state, map_known: true } }),
    lookup: async title => { lookups.push(title); return { cached: [70], explorer: [30], error: null }; },
    game: 'yume', catalog: { entries: [{ mapId: 40, name: 'World' }] }, graph: () => graph, planner,
  });
  assert.deepEqual(lookups, ['World']);
  assert.deepEqual(result.expedition, { title: 'World', type: 'Weekly', kind: 'weekly', map: 30, x: 7, y: 8, hops: 2, route: [20, 30], mapIds: [30, 40, 70] });
  assert.equal(result.current.page, page);
});

test('planning refuses without a map, an unfinished expedition or any known map', async () => {
  const plan = (current, found = { cached: [], explorer: null, error: null }) => planExpedition({
    read: async () => current, lookup: async () => found, game: 'yume', catalog: { entries: [] }, graph: () => graph, planner });
  const page = { expeditions: [{ title: 'World', complete: false }] };
  await assert.rejects(plan({ ready: false }), /Load a game map/);
  await assert.rejects(plan({ ready: true, page, state: { map_id: 10, map_known: false, player_x: 1, player_y: 1 } }), /Load a game map/);
  await assert.rejects(plan({ ready: true, page, state: { map_id: 10, player_x: null, player_y: 1 } }), /Load a game map/);
  // The list markup exists before the session sends anything; empty is not "all complete".
  await assert.rejects(plan({ ready: true, page: { expeditions: null }, state }), /No expeditions are listed for this game yet/);
  await assert.rejects(plan({ ready: true, page: { expeditions: [] }, state }), /No expeditions are listed for this game yet/);
  await assert.rejects(plan({ ready: true, page: { loggedIn: false, expeditions: [] }, state }), /Sign in to load expeditions/);
  await assert.rejects(plan({ ready: true, page: { expeditions: [{ title: 'World', complete: true }] }, state }), /Every expedition for this game is complete/);
  await assert.rejects(plan({ ready: true, page, state }, { cached: [], explorer: null, error: 'Explorer lookup timed out' }),
    /No map is known for World \(Explorer lookup timed out\)/);
});

test('the page lookup returns validated cached and Explorer map IDs for the session game only', async () => {
  const requests = [];
  const run = async (context, title = 'World', explorer = true) => vm.runInNewContext(expeditionLookupScript(title, '2kki', explorer), {
    location: { hostname: 'ynoproject.net', pathname: '/2kki/' }, setTimeout, clearTimeout, encodeURIComponent, ...context });
  const explorer = (url, callback) => { requests.push(url); callback({ title: 'World', mapIds: ['0143', '0144', '99999', 'x'] }); };
  const cache = { '0002_0143': [{ title: 'World' }], '0143_0002': [{ title: 'Other' }], 'bad_0009': [{ title: 'World' }], '0001_0000': [{ title: 'World' }] };
  // The cache holds only locations the page has met, so the Explorer is asked as well.
  assert.deepEqual(JSON.parse(JSON.stringify(await run({ locationCache: cache, send2kkiApiRequest: explorer }))), { cached: [143], explorer: [143, 144], error: null });
  assert.deepEqual(requests, ['https://explorer.yume.wiki/getLocationInfo?locationName=World']);
  assert.deepEqual(JSON.parse(JSON.stringify(await run({ locationCache: {}, send2kkiApiRequest: explorer }))), { cached: [], explorer: [143, 144], error: null });
  assert.equal(requests.length, 2);
  assert.equal((await run({ locationCache: {}, send2kkiApiRequest: explorer }, 'World', false)).explorer, null, 'a disallowed lookup skips the Explorer');
  assert.equal(requests.length, 2);
  const mismatch = await run({ send2kkiApiRequest: (_url, callback) => callback({ title: 'Different', mapIds: ['0143'] }) });
  assert.equal(mismatch.error, 'Explorer lookup failed');
  assert.equal(mismatch.explorer, null);
  await assert.rejects(vm.runInNewContext(expeditionLookupScript('World', '2kki'), { location: { hostname: 'ynoproject.net', pathname: '/yume/' } }),
    /does not match the debug session game/);
  // Titles are passed as data, never as script.
  const quoted = await run({ locationCache: { '0002_0005': [{ title: '"); throw 1; ("' }] } }, '"); throw 1; ("');
  assert.deepEqual(JSON.parse(JSON.stringify(quoted)).cached, [5]);
});

test('the reviewed 2kki overlay routes the Nexus to Zodiac Fortress through Symbolon, never through debug map 1', () => {
  const source = {
    10: [edge(615, 9, 21, 36, 35), edge(3241, 21, 39, 18, 20)],
    615: [edge(376, 21, 86, 9, 10)],
    376: [edge(375, 6, 11, 66, 184)],
    375: [edge(143, 39, 423, 8, 6)],
    3241: [edge(2701, 49, 26, 9, 49)], 2701: [edge(2704, 37, 3, 3, 4)], 2704: [edge(3371, 21, 19, 21, 10)],
    3371: [edge(3372, 58, 16, 42, 15)], 3372: [edge(146, 8, 17, 39, 44)], 146: [edge(143, 21, 9, 22, 44)],
    617: [edge(375, 47, 200, 94, 403), edge(146, 19, 211, 21, 5), edge(376, 42, 173, 9, 10)],
    300: [edge(1, 7, 7, 20, 39), edge(301, 1, 1, 2, 2)],
  };
  const { graph: served, overlay } = applyGraphOverlay(source, '2kki');
  assert.deepEqual(served[615].map(step => step.targetMapId), [617], 'only the reviewed cheese edge remains');
  assert.deepEqual(served[617], []);
  assert.deepEqual(served[300], [edge(301, 1, 1, 2, 2)]);
  assert.ok(overlay.changes.some(change => change.reason === 'Requires switch 1445' && change.removed === 1));
  const route = planner.findMapRoute(served, 10, 143, routeOptions('2kki'));
  assert.deepEqual([10, ...route.map(step => step.targetMapId)], [10, 3241, 2701, 2704, 3371, 3372, 146, 143]);
  assert.equal(source[615].length, 1, 'the source graph is not modified');
});

const { runScenario } = require('./navbot-scenario');
// Scripted states: before the plan, while travelling, then after arrival with the given list.
function expeditionRun({ kind = null, travel, after, confirmMs = 3000 }) {
  let tick = 0, phase = 'boot';
  const commands = [];
  const map = (id, x, y, extra = {}) => ({ ready: true, state: { scene: 'Map', map_id: id, player_x: x, player_y: y, active: false, graph_loaded: true, ...extra } });
  const planned = { title: 'World', type: 'Daily', kind, map: 30, x: 7, y: 8, hops: 2, route: [20, 30], mapIds: [30] };
  return runScenario(async command => {
    commands.push(command.op);
    if (command.op === 'expedition') return { expedition: planned };
    if (command.op === 'goto-map') { phase = 'travel'; return {}; }
    if (command.op === 'capture') return { path: '/test/capture.png' };
    if (command.op !== 'state') return {};
    if (phase === 'boot') return { ...map(10, 1, 1), page: { expeditions: [{ title: 'World', kind, complete: false }] } };
    const step = travel.shift();
    if (step) return step;
    return { ...after.state, page: { expeditions: after.list } };
  }, { expedition: true, timeoutMs: 20000, stallMs: 5000, confirmMs }, { now: () => tick, sleep: async ms => { tick += ms; } })
    .then(result => ({ result, commands, map }));
}
const arrive = (extra = {}) => ({ ready: true, state: { scene: 'Map', map_id: 30, player_x: 7, player_y: 8, active: false, graph_loaded: true, ...extra } });

test('run --expedition plans after boot, travels to the planned tile and waits for the completion flag', async () => {
  const travel = [{ ready: true, state: { scene: 'Map', map_id: 20, player_x: 1, player_y: 1, active: true, graph_loaded: true } },
    { ...arrive(), page: { expeditions: [{ title: 'World', complete: false }] } }, { ...arrive(), page: { expeditions: [{ title: 'World', complete: false }] } }];
  const { result, commands } = await expeditionRun({ travel, after: { state: arrive(), list: [{ title: 'World', complete: true }] } });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'arrived');
  assert.deepEqual(result.target, { map: 30, x: 7, y: 8 });
  assert.equal(result.expedition.complete, true);
  assert.ok(commands.indexOf('expedition') < commands.indexOf('goto-map'));
});

test('run --expedition fails when the server never confirms, and a missing daily entry is not completion', async () => {
  for (const list of [[{ title: 'World', complete: false }], [{ title: 'Other', complete: false }]]) {
    const { result } = await expeditionRun({ travel: [], after: { state: arrive(), list } });
    assert.equal(result.outcome, 'arrived');
    assert.equal(result.ok, false);
    assert.equal(result.expedition.complete, false);
    assert.equal(result.expedition.replaced, false);
  }
});

test('a free expedition replaced after arrival counts as completed', async () => {
  const { result } = await expeditionRun({ kind: 'free', travel: [], after: { state: arrive(), list: [{ title: 'Next World', kind: 'free', complete: false }] } });
  assert.equal(result.ok, true);
  assert.equal(result.expedition.replaced, true);
});

test('completion on another map of the same location is recognised even if navigation stops there', async () => {
  const stoppedThere = { ready: true, state: { scene: 'Map', map_id: 20, player_x: 1, player_y: 1, active: false, graph_loaded: true } };
  const { result } = await expeditionRun({ travel: [], after: { state: stoppedThere, list: [{ title: 'World', complete: true }] } });
  assert.equal(result.outcome, 'navigation-stopped');
  assert.equal(result.expedition.complete, true);
  assert.equal(result.ok, true);
});

test('Current expedition plans Jigsaw Puzzle World through Spring or Bat, and names them when neither is owned', async () => {
  const { graph: served } = applyGraphOverlay(require('../map_graph.json'), '2kki');
  const page = { expeditions: [{ title: 'Jigsaw Puzzle World', type: 'Daily', kind: null, complete: false }], cachedLocationNames: ["Urotsuki's Room"] };
  const plan = owned => planExpedition({
    read: async () => ({ ready: true, page, state: { map_id: 2, map_known: true, player_x: 12, player_y: 6, owned_effects: owned } }),
    // A fresh profile: no cached locations, so the Explorer's map IDs for the title
    // (expedition record IDs are never used), as the page script returns them.
    lookup: async (title, { explorer }) => ({ cached: [], explorer: explorer ? [412, 413, 415, 418, 419, 452, 1151, 1152] : null, error: null }),
    game: '2kki', graph: () => served, planner,
  });
  for (const owned of [[27], [38], [12, 27, 38]]) {
    const { expedition } = await plan(owned);
    assert.deepEqual([expedition.map, expedition.x, expedition.y, expedition.hops], [413, 32, 2, 8], JSON.stringify(owned));
    assert.deepEqual(expedition.route, [5, 4, 10, 71, 72, 411, 420, 413]);
  }
  for (const owned of [[], [12]]) {
    await assert.rejects(plan(owned), /^Error: Jigsaw Puzzle World: This route needs the Spring or Bat effect, which this save does not have\.$/,
      JSON.stringify(owned));
  }
  await assert.rejects(plan(null), /^Error: Jigsaw Puzzle World: This route needs the Spring or Bat effect, but the save's effects could not be read\.$/);
});

test('cached and Explorer map IDs add maps but keep the catalog regions of maps they also name', async () => {
  // The catalog names map 20 only in its region x 0..3; entering it at (5,6) is named after another world.
  const regionGraph = { 10: [edge(20, 1, 1, 5, 6), edge(50, 3, 1, 4, 4)], 50: [edge(20, 2, 2, 1, 1)] };
  for (const found of [{ cached: [], explorer: [20, 30] }, { cached: [20], explorer: null }]) {
    const result = await planExpedition({
      read: async () => ({ ready: true, page: { expeditions: [{ title: 'World', complete: false }] }, state: { ...state, map_known: true } }),
      lookup: async () => ({ ...found, error: null }),
      game: '2kki', catalog: { entries: [{ mapId: 20, name: 'World', regions: [{ x1: 0, y1: 0, x2: 3, y2: 3 }] }] },
      graph: () => regionGraph, planner,
    });
    assert.deepEqual([result.expedition.map, result.expedition.x, result.expedition.y, result.expedition.route], [20, 1, 1, [50, 20]], JSON.stringify(found));
  }
});

test('a region entrance never continues past an exit some effects open only for routes ending there', () => {
  // As map 420's exit: Bat may end a route in map 2, but only Spring leads on to map 3.
  const gate = { ...edge(2, 1, 1, 0, 0), approachX: 1, approachY: 1, direction: 0, action: true, reviewed: true,
    requiresEffects: [27, 38], continueEffects: [27] };
  const gated = { 10: [gate], 2: [edge(3, 4, 4, 1, 1)] };
  const regions = new Map([[3, [{ x1: 0, y1: 0, x2: 2, y2: 2 }]]]);
  const choose = owned => chooseDestination({ graph: gated, planner, routeOptions: () => routeOptions('2kki', [], [], owned), game: '2kki',
    title: 'World', mapIds: [3], state, regions });
  assert.throws(() => choose([38]), /No known route reaches World/);
  assert.deepEqual(choose([27]).route, [2, 3]);
});
