'use strict';

// Drives the real startBridge (dispatch, command queue, preparation runner and
// its poll) with a fake window whose page runs the real official controller.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const official = require('../src/navbot/official');
const { startBridge } = require('../src/navbot/bridge');
const { createOfficialController } = require('../src/navbot/official-controller');
const { createPlanner } = require('../src/navbot/official-path');
const { effectTable } = require('../src/navbot/effects');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await wait(5); }
  return false;
}

// A page paused for a preparation in map 11. Its item window lists the held
// items in ID order; `blockMoves` holds the cursor so a run stays in the menu.
function createPage({ items = { 1: 0, 2: 1, 12: 2 }, mapId = 11, routes = {} } = {}) {
  const switches = {};
  const memory = { available: true, scene: 'Map', moving: false, event_running: false, message_active: false, async_pending: false,
    move_route_overwritten: false, player_paused: false, menu_allowed: true, vehicle_type: 0, direction: 2, selected_item_id: 0 };
  const state = { ready: true, map_known: true, map_id: mapId, player_x: 0, player_y: 0, frame: 0, time_ms: 1000, position_changed_ms: 0,
    teleport_sequence: 0, held_key: null, hold_remaining: 0, error: null, input_timing: 'logical-frames' };
  const listeners = [], keys = [];
  const list = Object.entries(items).filter(([, index]) => index >= 0).sort((a, b) => a[1] - b[1]).map(([id]) => Number(id));
  const cursor = { index: 0, blockMoves: true };
  const sync = () => { memory.selected_item_id = memory.scene === 'Item' ? list[cursor.index] : 0; };
  const press = {
    cancel: () => { memory.scene = memory.scene === 'Item' ? 'Menu' : memory.scene === 'Menu' ? 'Map' : 'Menu'; sync(); },
    decision: () => {
      if (memory.scene === 'Menu') { memory.scene = 'Item'; cursor.index = 0; }
      else if (memory.scene === 'Item') {
        const effect = effectTable('2kki').effects.find(entry => entry.item === list[cursor.index]);
        if (effect) { memory.scene = 'Map'; switches[effect.active] = switches[effect.active] ? 0 : 1; }
      }
      sync();
    },
    down: () => { if (memory.scene === 'Item' && !cursor.blockMoves && cursor.index < list.length - 2) cursor.index += 2; sync(); },
    right: () => { if (memory.scene === 'Item' && !cursor.blockMoves && cursor.index < list.length - 1) cursor.index += 1; sync(); },
  };
  const input = {
    read: () => ({ ...state, memory: { ...memory } }),
    subscribe: listener => listeners.push(listener),
    stop() { state.held_key = null; state.hold_remaining = 0; },
    hold(key, frames) { keys.push({ key, scene: memory.scene }); state.held_key = key; state.hold_remaining = frames; },
    query: request => ({ items: Object.fromEntries((request.items || []).map(id => [id, items[id] ?? -1])),
      switches: Object.fromEntries((request.switches || []).map(id => [id, switches[id] ?? 0])), skills: {} }),
    navigation: () => null,
  };
  const controller = createOfficialController(input, createPlanner());
  controller.configure({ reroute: true, preparation: effectTable('2kki') });
  controller.installMap(mapId, { width: 4, height: 1, loopHorizontal: false, loopVertical: false, passages: [4, 6, 6, 2] }, [], []);
  const timer = setInterval(() => {
    ++state.frame; state.time_ms += 17;
    if (state.held_key) { press[state.held_key]?.(); state.held_key = null; state.hold_remaining = 0; }
    for (const listener of listeners) listener();
  }, 16);
  const context = vm.createContext({ window: { __ynoOfficialController: controller }, document: { title: '2kki', getElementById: () => null, scripts: [] },
    location: { hostname: 'ynoproject.net', pathname: '/2kki/' }, URL, Date });
  const win = {
    isDestroyed: () => false, once() {},
    webContents: { isDestroyed: () => false, on() {}, reloadIgnoringCache() {}, async executeJavaScript(script) { return vm.runInContext(script, context); } },
  };
  return { controller, memory, cursor, keys, win, timer, routes };
}

async function session(t, page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navbot-bridge-test-'));
  const setup = official.setupOfficialNavbot;
  // The page script, assets and graph are replaced by the fake page's own routes.
  official.setupOfficialNavbot = async () => ({ refresh: async () => {}, snapshot: result => result,
    route: (call) => call[0] === '_Navbot_GoToMap' ? [call[0], call[1], page.routes[call[1][0]] || []] : call });
  const bridge = await startBridge(page.win, { game: '2kki', engine: 'official', runDir: path.join(dir, 'run'), graphPath: path.join(dir, 'none.json'),
    latestPath: path.join(dir, 'latest.json') }, () => {});
  official.setupOfficialNavbot = setup;
  t.after(() => { bridge.close(); clearInterval(page.timer); fs.rmSync(dir, { recursive: true, force: true }); });
  const trace = () => fs.readFileSync(path.join(dir, 'run', 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { ...bridge, trace };
}
const onward = { 12: [{ mapId: 11, startX: 3, startY: 0, targetMapId: 12, targetX: 0, targetY: 0, action: false }] };

test('a new destination first closes the menu a page preparation opened, then starts', async t => {
  const page = createPage({ routes: onward });
  const { schedule } = await session(t, page);
  page.controller.execute(['_Navbot_GoToMap', [12, 0, 0], onward[12]]);
  assert.ok(await until(() => page.memory.scene === 'Item'), 'the poll answered the Bike request');
  page.cursor.blockMoves = false;
  const from = page.keys.length;
  const result = await schedule({ op: 'goto-map', map: 12, x: 0, y: 0 });
  assert.equal(result.state.active, true);
  assert.deepEqual(page.keys.slice(from, from + 2).map(key => `${key.key}@${key.scene}`), ['cancel@Item', 'cancel@Menu']);
  assert.ok(await until(() => page.controller.read().status !== 'preparing'));
  assert.notEqual(page.controller.read().status, 'paused_scene', 'the new route does not wait behind an open menu');
});

test('a Stop sent while a new destination closes the menu cancels that destination', async t => {
  for (const delay of [5, 60, 200]) {
    const page = createPage({ routes: onward });
    const { schedule } = await session(t, page);
    page.controller.execute(['_Navbot_GoToMap', [12, 0, 0], onward[12]]);
    assert.ok(await until(() => page.memory.scene === 'Item'));
    page.cursor.blockMoves = false;
    const go = schedule({ op: 'goto-map', map: 12, x: 0, y: 0 }).then(() => 'started', error => error.message);
    await wait(delay);
    await schedule({ op: 'stop' });
    const from = page.keys.length;
    assert.match(await go, /^(Command cancelled by Stop|started)$/);
    await wait(300);
    const state = page.controller.read();
    assert.equal(state.active, false, `Stop at +${delay} ms`);
    assert.deepEqual(page.keys.slice(from), [], `no input after Stop at +${delay} ms`);
  }
});

test('the Stop queued ahead of a new destination during a recipe also closes the menu', async t => {
  // A Planetarium travel step whose map 2 exit needs Spring (item 27).
  const gated = [{ mapId: 2, startX: 1, startY: 0, approachX: 0, approachY: 0, direction: 1, targetMapId: 10, targetX: 0, targetY: 0,
    action: true, reviewed: true, requiresEffects: [27] }];
  const page = createPage({ mapId: 2, items: { 1: 0, 2: 1, 27: 2 },
    routes: { 10: gated, 12: [{ mapId: 2, startX: 3, startY: 0, targetMapId: 12, targetX: 0, targetY: 0, action: false }] } });
  const { schedule, trace } = await session(t, page);
  assert.equal((await schedule({ op: 'goto-map', map: 568, x: 3, y: 75 })).state.status, 'navigating');
  assert.ok(await until(() => page.memory.scene === 'Item', 8000), 'the recipe step asked for Spring');
  page.cursor.blockMoves = false;
  const from = page.keys.length;
  await schedule({ op: 'goto-map', map: 12, x: 0, y: 0 });
  assert.deepEqual(page.keys.slice(from, from + 2).map(key => `${key.key}@${key.scene}`), ['cancel@Item', 'cancel@Menu']);
  assert.ok(await until(() => page.memory.scene === 'Map'));
  assert.ok(trace().some(entry => entry.type === 'preparation' && entry.outcome === 'cancelled'));
});

test('a release flag sent by a client is an ordinary Stop', async t => {
  const page = createPage({ routes: onward });
  const { schedule } = await session(t, page);
  page.controller.execute(['_Navbot_GoToMap', [12, 0, 0], onward[12]]);
  assert.ok(await until(() => page.memory.scene === 'Item'));
  const from = page.keys.length;
  const stop = await schedule({ op: 'stop', release: true });
  assert.equal(stop.state.active, false);
  await wait(300);
  assert.deepEqual(page.keys.slice(from), [], 'a Stop presses nothing, whatever fields it carries');
  assert.equal(page.memory.scene, 'Item', 'the menu is left to the player');
});

test('a new destination closes the menu of the Bike preparation another destination started', async t => {
  const page = createPage({ routes: onward });
  const { schedule } = await session(t, page);
  // The first goto-map prepares the Bike itself and holds in the item list.
  const first = schedule({ op: 'goto-map', map: 12, x: 0, y: 0 }).then(() => 'started', error => error.message);
  assert.ok(await until(() => page.memory.scene === 'Item'), 'the pre-route Bike preparation opened the menu');
  page.cursor.blockMoves = false;
  const from = page.keys.length;
  const second = await schedule({ op: 'goto-map', map: 12, x: 0, y: 0 });
  assert.match(await first, /cancelled/i);
  assert.deepEqual(page.keys.slice(from, from + 2).map(key => `${key.key}@${key.scene}`), ['cancel@Item', 'cancel@Menu']);
  assert.equal(second.state.active, true);
  assert.ok(await until(() => page.memory.scene === 'Map' && page.controller.read().status !== 'paused_scene'));
});

test('closing the menu does not count toward a new destination\'s expiry', async t => {
  const page = createPage({ routes: onward });
  const { schedule } = await session(t, page);
  page.controller.execute(['_Navbot_GoToMap', [12, 0, 0], onward[12]]);
  assert.ok(await until(() => page.memory.scene === 'Item'));
  page.cursor.blockMoves = false;
  // Received just before its 4.5 s limit; closing the menu takes longer than what is left.
  const result = await schedule({ op: 'goto-map', map: 12, x: 0, y: 0 }, { receivedAt: Date.now() - 4400 });
  assert.equal(result.state.active, true);
  assert.equal(result.state.target_map_id, 12);
  assert.ok(await until(() => page.controller.read().status !== 'preparing'), 'the old preparation is not left waiting for its timeout');
});

test('a destination queued behind the Stop that closes a Bike preparation keeps its time', async t => {
  const page = createPage({ routes: onward });
  const { schedule } = await session(t, page);
  void schedule({ op: 'goto-map', map: 12, x: 0, y: 0 }).catch(() => {});
  assert.ok(await until(() => page.memory.scene === 'Item'));
  page.cursor.blockMoves = false;
  const second = await schedule({ op: 'goto-map', map: 12, x: 0, y: 0 }, { receivedAt: Date.now() - 4400 });
  assert.equal(second.state.active, true);
});

test('a failed setup leaves no preparation poll behind', async () => {
  const page = createPage();
  let calls = 0;
  const execute = page.win.webContents.executeJavaScript;
  page.win.webContents.executeJavaScript = script => { ++calls; return execute(script); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navbot-bridge-test-'));
  const setup = official.setupOfficialNavbot;
  official.setupOfficialNavbot = async () => ({ refresh: async () => {}, snapshot: result => result, route: call => call });
  try {
    fs.writeFileSync(path.join(dir, 'file'), '');
    await assert.rejects(startBridge(page.win, { game: '2kki', engine: 'official', runDir: path.join(dir, 'run'),
      graphPath: path.join(dir, 'none.json'), latestPath: path.join(dir, 'file', 'latest.json') }, () => {}));
    const before = calls;
    await wait(600);
    assert.equal(calls, before);
  } finally {
    official.setupOfficialNavbot = setup;
    clearInterval(page.timer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
