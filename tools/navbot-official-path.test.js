'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createPlanner } = require('../src/navbot/official-path');
const { applyGraphOverlay } = require('../src/navbot/graph');
const planner = createPlanner();
const grid = (width, height, patch = {}) => ({ width, height,
  loopHorizontal: false, loopVertical: false, passages: Array(width * height).fill(15), ...patch });
const edge = (targetMapId, startX = 0, startY = 0) => ({ targetMapId, startX, startY, targetX: 0, targetY: 0 });
const transfer = (startX, targetX, patch = {}) => ({ ...edge(7, startX), mapId: 7,
  targetX, reviewed: true, ...patch });

test('planner factory can be injected without Node globals or closures', () => {
  const isolated = vm.runInNewContext(`(${createPlanner.toString()})()`);
  assert.equal(isolated.findPath(grid(2, 1), { x: 0, y: 0 }, { x: 1, y: 0 })[0].direction, 'right');
});

test('grid path is shortest, omits the start and distinguishes arrival from failure', () => {
  const map = grid(3, 3);
  map.passages[4] = 0;
  const path = planner.findPath(map, { x: 0, y: 1 }, { x: 2, y: 1 });
  assert.equal(path.length, 4);
  assert.deepEqual(path.at(-1), { x: 2, y: 1, direction: 'up' });
  assert.equal(path.some(({ x, y }) => x === 1 && y === 1), false);
  assert.deepEqual(planner.findPath(map, { x: 1, y: 1 }, { x: 1, y: 1 }), []);
  assert.equal(planner.findPath(map, { x: 0, y: 0 }, { x: 1, y: 1 }), null);
});

test('both source and destination directional passages must allow a move', () => {
  for (const passages of [[15, 13], [11, 15]]) {
    assert.equal(planner.findPath(grid(2, 1, { passages }), { x: 0, y: 0 }, { x: 1, y: 0 }), null);
  }
  assert.equal(planner.findPath(grid(2, 1, { passages: [4, 2] }), { x: 0, y: 0 }, { x: 1, y: 0 }).length, 1);
});

test('horizontal and vertical loops preserve the actual input direction', () => {
  const horizontal = planner.findPath(grid(4, 1, { loopHorizontal: true }), { x: 0, y: 0 }, { x: 3, y: 0 });
  assert.deepEqual(horizontal, [{ x: 3, y: 0, direction: 'left' }]);
  const vertical = planner.findPath(grid(1, 4, { loopVertical: true }), { x: 0, y: 0 }, { x: 0, y: 3 });
  assert.deepEqual(vertical, [{ x: 0, y: 3, direction: 'up' }]);
  assert.equal(planner.findPath(grid(4, 1), { x: 0, y: 0 }, { x: 3, y: 0 }).length, 3);
});

test('observed blocked steps are directed and can be routed around', () => {
  const blocked = new Set([planner.stepKey(0, 0, 'right')]);
  assert.equal(planner.findPath(grid(2, 1), { x: 0, y: 0 }, { x: 1, y: 0 }, blocked), null);
  assert.equal(planner.findPath(grid(2, 1), { x: 1, y: 0 }, { x: 0, y: 0 }, blocked).length, 1);
  assert.equal(planner.findPath(grid(2, 2), { x: 0, y: 0 }, { x: 1, y: 0 }, blocked).length, 3);
  const wrapBlocked = new Set([planner.stepKey(0, 0, 'left')]);
  assert.equal(planner.findPath(grid(4, 1, { loopHorizontal: true }), { x: 0, y: 0 }, { x: 3, y: 0 }, wrapBlocked).length, 3);
});

test('local routing chains reviewed transfers across disconnected regions and terminates cycles', () => {
  const map = grid(9, 1, { passages: [15, 15, 0, 15, 15, 0, 15, 15, 15] });
  const first = transfer(1, 3), second = transfer(4, 6), cycle = transfer(0, 0);
  assert.deepEqual(planner.findLocalRoute(map, { x: 0, y: 0 }, { x: 8, y: 0 }, [cycle, second, first]), [first, second]);
  assert.equal(planner.findLocalRoute(map, { x: 0, y: 0 }, { x: 8, y: 0 }, [cycle, first]), null);
  const blocked = new Set([planner.stepKey(0, 0, 'right')]);
  assert.equal(planner.findLocalRoute(map, { x: 0, y: 0 }, { x: 8, y: 0 }, [first, second], blocked), null);
  assert.deepEqual(planner.findLocalRoute(map, { x: 6, y: 0 }, { x: 8, y: 0 }, [first, second]), []);
});

test('walking cannot silently cross a touch portal, but can approach one deliberately', () => {
  const map = grid(5, 1), portal = transfer(2, 4);
  const start = { x: 0, y: 0 }, goal = { x: 3, y: 0 };
  assert.equal(planner.findPath(map, start, goal, new Set(), [portal]), null);
  assert.equal(planner.findPath(map, start, { x: 2, y: 0 }, new Set(), [portal]).length, 2);
  assert.deepEqual(planner.findLocalRoute(map, start, goal, [portal]), [portal]);
  const action = { ...portal, action: true, approachX: 1, approachY: 0, direction: 1 };
  assert.deepEqual(planner.findLocalRoute(map, start, goal, [action]), []);
});

test('local routing targets an action approach rather than an impassable event tile', () => {
  const map = grid(5, 1, { passages: [15, 0, 0, 15, 15] });
  const portal = transfer(1, 3, { action: true, approachX: 0, approachY: 0, direction: 1 });
  assert.deepEqual(planner.findLocalRoute(map, { x: 0, y: 0 }, { x: 4, y: 0 }, [portal]), [portal]);
});

test('local routing rejects unreviewed, cross-map, unknown and out-of-bounds transfers', () => {
  const map = grid(5, 1), start = { x: 0, y: 0 }, end = { x: 4, y: 0 };
  for (const bad of [transfer(1, 3, { reviewed: false }), transfer(1, 3, { mapId: undefined }),
    transfer(1, 3, { targetMapId: 8 }), transfer(1, -1), transfer(1, 5),
    transfer(5, 3), transfer(1, 3, { approachX: 0, approachY: 1 })]) {
    assert.throws(() => planner.findLocalRoute(map, start, end, [bad]), /graph edge|transfers|coordinates/);
  }
  assert.throws(() => planner.findLocalRoute(map, start, end, {}), /local transfers/);
  assert.throws(() => planner.findLocalRoute(map, start, end,
    [transfer(1, 3), transfer(2, 4, { mapId: 8, targetMapId: 8 })]), /same-map edges/);
});

test('malformed grids and invalid coordinates fail before allocating the search', () => {
  for (const map of [null, grid(2, 2, { passages: [15] }), grid(1, 1, { passages: [16] }),
    grid(1, 1, { passages: [-1] }), grid(1, 1, { width: 1000001 }), grid(1, 1, { loopHorizontal: 1 })]) {
    assert.throws(() => planner.findPath(map, { x: 0, y: 0 }, { x: 0, y: 0 }), /navigation map/);
  }
  for (const point of [{ x: -1, y: 0 }, { x: 2, y: 0 }, { x: 0.5, y: 0 }, null]) {
    assert.throws(() => planner.findPath(grid(2, 2), point, { x: 0, y: 0 }), /coordinates/);
    assert.throws(() => planner.findPath(grid(2, 2), { x: 0, y: 0 }, point), /coordinates/);
  }
});

test('map routing finds shortest route and handles cycles and target-only maps', () => {
  const graph = { 1: [edge(2), edge(3, 1)], 2: [edge(1), edge(4, 1)], 3: [edge(5)], 4: [edge(5)] };
  assert.deepEqual(planner.findMapRoute(graph, 1, 5).map(item => [item.mapId, item.targetMapId]), [[1, 3], [3, 5]]);
  assert.equal(planner.findMapRoute(graph, 5, 1), null);
  assert.deepEqual(planner.findMapRoute(graph, 5, 5), []);
});

test('conditional departures require review or observation; observations override review', () => {
  const graph = { 1: [edge(2), edge(3)], 2: [edge(4)], 3: [edge(4)] };
  const key = planner.exitKey(1, graph[1][0]);
  assert.equal(planner.findMapRoute(graph, 1, 4), null);
  const preferredExits = new Map([[key, 2]]);
  assert.equal(planner.findMapRoute(graph, 1, 4, { preferredExits })[0].targetMapId, 2);
  const observedExits = new Map([[key, 3]]);
  assert.equal(planner.findMapRoute(graph, 1, 4, { preferredExits, observedExits })[0].targetMapId, 3);
  assert.equal(planner.findMapRoute(graph, 1, 4, { preferredExits, blockedExits: new Set([key]) }), null);
  assert.equal(planner.findMapRoute(graph, 1, 4, { observedExits: new Map([[key, 99]]) }), null);
});

test('reviewed 2kki route retains action approach, prunes debug and invented exits', () => {
  const source = require('../map_graph.json');
  const { graph } = applyGraphOverlay(source, '2kki');
  const preferredExits = new Map([['4:15,7', 10]]);
  const route = planner.findMapRoute(graph, 2, 10, { preferredExits });
  assert.deepEqual(route.map(item => item.targetMapId), [5, 4, 10]);
  assert.deepEqual([route[0].approachX, route[0].approachY, route[0].direction, route[0].action], [8, 5, 3, true]);
  assert.deepEqual([route[2].approachX, route[2].approachY, route[2].direction], [14, 7, 1]);
  assert.equal(planner.usableExits(graph, 2).some(item => [1, 171, 222, 223, 224, 225, 448].includes(item.targetMapId)), false);
  for (const mapId of [222, 223, 224, 225, 448]) {
    assert.equal(planner.usableExits(graph, mapId).some(item => item.targetMapId === 10), false);
  }
  assert.equal(source[2].some(item => item.targetMapId === 900), true);
});

test('graph validation rejects malformed action exits and allows unknown landing hints', () => {
  for (const bad of [{ ...edge(2), action: true }, { ...edge(2), approachX: 1 },
    { ...edge(2), direction: 4 }, { ...edge(2), action: 1 }, { ...edge(2), targetX: -2 }, { ...edge(0) }]) {
    assert.throws(() => planner.findMapRoute({ 1: [bad] }, 1, 2), /graph edge/);
  }
  assert.equal(planner.findMapRoute({ 1: [{ ...edge(2), targetX: -1, targetY: -1 }] }, 1, 2).length, 1);
  assert.throws(() => planner.findMapRoute({ 1: 'invalid' }, 1, 2), /graph edges/);
  assert.throws(() => planner.findMapRoute({}, 1, 0), /destination map/);
});

test('teleport metadata is bounded and reviewed self-transfers require exact landing coordinates', () => {
  for (const patch of [{ transientMapIds: null }, { transientMapIds: '900' }, { transientMapIds: [0] },
    { transientMapIds: [1.5] }, { transientMapIds: Array(17).fill(900) }, { settleMs: -1 },
    { settleMs: 10001 }, { settleMs: 0.5 }, { reviewed: 1 }]) {
    assert.throws(() => planner.usableExits({ 1: [{ ...edge(2), ...patch }] }, 1), /graph edge/);
  }
  const valid = { ...edge(2), reviewed: true, transientMapIds: [900], settleMs: 3500 };
  assert.deepEqual(planner.findMapRoute({ 1: [valid] }, 1, 2)[0], { ...valid, mapId: 1 });
  assert.throws(() => planner.usableExits({ 1: [{ ...edge(1), reviewed: true, targetX: -1 }] }, 1), /graph edge/);
});

const interaction = (patch = {}) => ({ eventId: 17, startX: 2, startY: 1,
  pages: [{ trigger: 0, layer: 1, targetMapIds: [11], unsupported: false }], ...patch });

test('raw action exits choose an adjacent tile and never plan through the occupied event', () => {
  const map = grid(5, 3), raw = edge(11, 2, 1);
  const result = planner.resolveExit(map, { x: 0, y: 1 }, raw, [interaction()]);
  assert.equal(result.action, true);
  assert.deepEqual([result.approachX, result.approachY, result.direction], [1, 1, 1]);
  assert.equal(raw.action, undefined, 'do not mutate the shared graph');
  const blocked = new Set(result.blockedApproachSteps);
  assert.equal(planner.findPath(map, { x: 1, y: 1 }, { x: 2, y: 1 }, blocked), null);
  assert.equal(planner.findPath(map, { x: 0, y: 1 }, { x: result.approachX, y: result.approachY }, blocked).length, 1);
});

test('touch and on-tile action events keep different activation semantics', () => {
  const map = grid(5, 3), raw = edge(11, 2, 1), start = { x: 0, y: 1 };
  const belowTouch = interaction({ pages: [{ trigger: 1, layer: 0, targetMapIds: [11], unsupported: false }] });
  assert.deepEqual(planner.resolveExit(map, start, raw, [belowTouch]), { ...raw, action: false });
  const sameTouch = interaction({ pages: [{ trigger: 2, layer: 1, targetMapIds: [11], unsupported: false }] });
  const bump = planner.resolveExit(map, start, raw, [sameTouch]);
  assert.deepEqual([bump.action, bump.approachX, bump.approachY, bump.direction], [false, 1, 1, 1]);
  const belowAction = interaction({ pages: [{ trigger: 0, layer: 0, targetMapIds: [11], unsupported: false }] });
  const onTile = planner.resolveExit(map, start, raw, [belowAction]);
  assert.deepEqual([onTile.action, onTile.approachX, onTile.approachY, onTile.direction], [true, 2, 1, 1]);
});

test('directional touch exits approach from the required side without crossing the trigger tile', () => {
  const map = grid(5, 3), start = { x: 2, y: 0 }, raw = edge(11, 2, 1);
  const event = interaction({ pages: [{ trigger: 1, layer: 0, targetMapIds: [11], unsupported: false, direction: 0 }] });
  const result = planner.resolveExit(map, start, raw, [event]);
  assert.deepEqual([result.action, result.approachX, result.approachY, result.direction], [false, 2, 2, 0]);
  const path = planner.findPath(map, start, { x: result.approachX, y: result.approachY }, new Set(result.blockedApproachSteps));
  assert.equal(path.some(({ x, y }) => x === 2 && y === 1), false);
  map.passages[2 * map.width + 2] = 0;
  assert.throws(() => planner.resolveExit(map, start, raw, [event]), /no reachable interaction approach/);
});

test('loaded event pages must agree before resolving a raw exit, and reviewed metadata stays authoritative', () => {
  const map = grid(5, 3), raw = edge(11, 2, 1), page = interaction().pages[0];
  for (const pages of [[{ ...page, unsupported: true }], [{ ...page, trigger: 3 }],
    [page, { ...page, targetMapIds: [] }], [page, { ...page, targetMapIds: [12] }],
    [page, { ...page, trigger: 1 }], [page, { ...page, layer: 0 }], [page, { ...page, direction: 0 }]]) {
    assert.throws(() => planner.resolveExit(map, { x: 0, y: 1 }, raw, [interaction({ pages })]), /conditional or scripted/);
  }
  assert.throws(() => planner.resolveExit(map, { x: 0, y: 1 }, raw, []), /no unambiguous interaction data/);
  const reviewed = { ...raw, action: true, approachX: 2, approachY: 2, direction: 0 };
  assert.equal(planner.resolveExit(map, { x: 0, y: 1 }, reviewed, []), reviewed);
});

test('an action exit beyond a reviewed local transfer can still resolve its approach', () => {
  const map = grid(7, 1, { passages: [15, 15, 0, 15, 15, 15, 15] });
  const raw = edge(11, 6, 0), portal = transfer(1, 3);
  const result = planner.resolveExit(map, { x: 0, y: 0 }, raw, [interaction({ startX: 6, startY: 0 })], new Set(), [portal]);
  assert.deepEqual([result.approachX, result.approachY], [5, 0]);
});

test('interaction metadata rejects malformed pages and coordinates at the parser boundary', () => {
  for (const value of [null, {}, [interaction({ startX: 5 })], [interaction({ eventId: 0 })],
    [interaction(), interaction()], [interaction({ pages: [] })],
    [interaction({ pages: [{ trigger: 0, layer: 1, targetMapIds: ['11'], unsupported: false }] })],
    [interaction({ pages: [{ trigger: 0, layer: 1, targetMapIds: [11] }] })]]) {
    assert.throws(() => planner.validateInteractions(value, grid(5, 3)), /Invalid .*interaction/);
  }
  assert.deepEqual(planner.validateInteractions([interaction()], grid(5, 3)), [interaction()]);
});

test('live active pages select only the current event page while unloaded state keeps all-pages agreement', () => {
  const map = grid(5, 3), raw = edge(11, 2, 1), start = { x: 0, y: 1 };
  const action = { trigger: 0, layer: 1, targetMapIds: [11], unsupported: false };
  const elsewhere = { ...action, targetMapIds: [12] };
  const scripted = { ...action, unsupported: true };
  const event = interaction({ pages: [action, elsewhere, scripted] });
  const before = JSON.stringify(event);
  // Without live state, disagreeing pages still need a reviewed route.
  for (const activePages of [undefined, null, new Map(), new Map([[99, 0]]), new Map([[17, '0']]), new Map([[17, 0.5]])]) {
    assert.throws(() => planner.resolveExit(map, start, raw, [event], new Set(), [], activePages), /conditional or scripted/);
  }
  const selected = planner.resolveExit(map, start, raw, [event], new Set(), [], new Map([[17, 0]]));
  assert.deepEqual([selected.action, selected.approachX, selected.approachY, selected.direction], [true, 1, 1, 1]);
  assert.deepEqual(selected, planner.resolveExit(map, start, raw, [interaction()]),
    'the active page resolves exactly like an event that only has that page');
  for (const index of [1, 2]) {
    assert.throws(() => planner.resolveExit(map, start, raw, [event], new Set(), [], new Map([[17, index]])), /conditional or scripted/,
      `active page ${index} leads elsewhere or is scripted`);
  }
  for (const index of [-1, 3, 100]) {
    assert.throws(() => planner.resolveExit(map, start, raw, [event], new Set(), [], new Map([[17, index]])), /not active in the current game state/);
  }
  assert.equal(JSON.stringify(event), before, 'page selection does not mutate loaded interactions');
});

test('the active page decides activation semantics and cannot bypass validation or reviewed metadata', () => {
  const map = grid(5, 3), raw = edge(11, 2, 1), start = { x: 0, y: 1 };
  const action = { trigger: 0, layer: 1, targetMapIds: [11], unsupported: false };
  const touch = { trigger: 1, layer: 0, targetMapIds: [11], unsupported: false };
  const event = interaction({ pages: [action, touch] });
  assert.deepEqual(planner.resolveExit(map, start, raw, [event], new Set(), [], new Map([[17, 1]])), { ...raw, action: false });
  assert.equal(planner.resolveExit(map, start, raw, [event], new Set(), [], new Map([[17, 0]])).action, true);
  assert.throws(() => planner.resolveExit(map, start, raw, [event]), /conditional or scripted/);
  // Agreeing pages need no live page state; any active page gives the same exit.
  const agreeing = interaction({ pages: [action, { ...action }] });
  const all = planner.resolveExit(map, start, raw, [agreeing]);
  for (const activePages of [null, new Map([[17, 1]]), new Map([[99, -1]])]) {
    assert.deepEqual(planner.resolveExit(map, start, raw, [agreeing], new Set(), [], activePages), all);
  }
  // A malformed inactive page is still rejected at the parser boundary.
  const malformed = interaction({ pages: [action, { ...action, trigger: 9 }] });
  assert.throws(() => planner.resolveExit(map, start, raw, [malformed], new Set(), [], new Map([[17, 0]])), /Invalid exit interaction page/);
  const reviewed = { ...raw, action: true, approachX: 2, approachY: 2, direction: 0 };
  assert.equal(planner.resolveExit(map, start, reviewed, [], new Set(), [], new Map([[17, -1]])), reviewed);
});

test('the injected planner honours active pages from another realm', () => {
  const isolated = vm.runInNewContext(`(${createPlanner.toString()})()`);
  const map = grid(5, 3), raw = edge(11, 2, 1);
  const event = interaction({ pages: [{ trigger: 0, layer: 1, targetMapIds: [12], unsupported: false }, interaction().pages[0]] });
  assert.equal(isolated.resolveExit(map, { x: 0, y: 1 }, raw, [event], new Set(), [], new Map([[17, 1]])).action, true);
  assert.throws(() => isolated.resolveExit(map, { x: 0, y: 1 }, raw, [event], new Set(), [], new Map([[17, -1]])), /not active/);
});
