'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureBike, ensureEffect } = require('../src/navbot/bike');

function harness({ index = 0, state = {}, transform, freeze = false } = {}) {
  let time = 0, pending = null;
  const calls = [];
  const snapshot = { ready: true, state: { scene: 'Map', map_id: 10, player_x: 3, player_y: 4,
    frame: 1, active: false, menu_allowed: true, vehicle_type: 0, bike_active: false,
    bike_item_index: index, selected_item_id: 0, held_keys: [], ...state } };
  const read = () => structuredClone(snapshot);
  const send = async command => {
    calls.push(command);
    if (command.op === 'hold') {
      snapshot.state.held_keys = [command.key];
      pending = () => {
        const s = snapshot.state;
        s.held_keys = [];
        if (transform) return transform(command.key, s);
        // Items before the Bike have other IDs; the cursor starts at index 0.
        const select = cursor => { s.cursor = cursor; s.selected_item_id = cursor === index ? 12 : 200 + cursor; };
        if (command.key === 'cancel') s.scene = 'Menu';
        else if (command.key === 'decision' && s.scene === 'Menu') {
          s.scene = 'Item'; select(0);
        } else if (command.key === 'right') select(s.cursor + 1);
        else if (command.key === 'down') select(s.cursor + 2);
        else if (command.key === 'decision' && s.scene === 'Item') {
          s.scene = 'Map'; s.bike_active = true;
        }
      };
    }
    if (command.op === 'stop') snapshot.state.held_keys = [];
    return read();
  };
  const options = { game: '2kki', now: () => time, sleep: async ms => {
    time += ms;
    if (!freeze) {
      snapshot.state.frame += 3;
      const apply = pending; pending = null; apply?.();
    }
  } };
  return { calls, snapshot, send, options, read, keys: () => calls.filter(c => c.op === 'hold').map(c => c.key) };
}

// The two-column item window: Down moves two entries, Right one.
const walk = index => [...Array(Math.floor(index / 2)).fill('down'), ...Array(index % 2).fill('right')];

test('Bike uses normal menu inputs and verifies the actual selected item and active effect', async () => {
  for (const index of [0, 1, 3, 11, 12, 35]) {
    const h = harness({ index });
    const result = await ensureBike(h.send, h.options);
    assert.deepEqual(h.keys(), ['cancel', 'decision', ...walk(index), 'decision']);
    assert.equal(h.calls.every(c => c.op !== 'hold' || c.frames === 1), true);
    assert.equal(result.state.scene, 'Map');
    assert.equal(result.state.bike_active, true);
    await ensureBike(h.send, h.options);
    assert.equal(h.keys().length, walk(index).length + 3, 'already active Bike must never be toggled off');
  }
});

test('Bike skips other games, missing telemetry, unowned effects, blocked menus and scripted movement', async () => {
  const other = harness();
  assert.equal(await ensureBike(other.send, { ...other.options, game: 'yume' }), undefined);
  assert.deepEqual(other.calls, []);
  for (const state of [{ bike_item_index: -1 }, { bike_item_index: 48 }, { bike_active: null },
    { bike_active: true }, { menu_allowed: false }, { menu_allowed: undefined },
    { vehicle_type: 1 }, { vehicle_type: undefined }, { bike_blocked: true },
    { event_running: true }, { moving: true }, { active: true }, { held_keys: ['up'] },
    { message_active: true }, { move_route_overwritten: true }, { scene: 'Menu' }]) {
    const h = harness({ state });
    await ensureBike(h.send, h.options);
    assert.deepEqual(h.keys(), [], JSON.stringify(state));
  }
  const noWalk = harness();
  await ensureBike(noWalk.send, { ...noWalk.options, target: [10, 3, 4] });
  assert.deepEqual(noWalk.keys(), []);
});

test('Bike never activates an unexpected selected item', async () => {
  const h = harness({ transform(key, s) {
    if (key === 'cancel') s.scene = 'Menu';
    else { s.scene = 'Item'; s.selected_item_id = 99; }
  } });
  await assert.rejects(ensureBike(h.send, h.options), /selected item is not Bike/);
  assert.deepEqual(h.keys(), ['cancel', 'decision']);
  assert.equal(h.calls.at(-1).op, 'stop');
});

test('Bike waits for the game transformation to settle before starting navigation', async () => {
  let transforming = false, waits = 0;
  const h = harness({ transform(key, s) {
    if (key === 'cancel') s.scene = 'Menu';
    else if (s.scene === 'Menu') { s.scene = 'Item'; s.selected_item_id = 12; }
    else { s.scene = 'Map'; s.event_running = true; transforming = true; }
  } });
  const sleep = h.options.sleep;
  const result = await ensureBike(h.send, { ...h.options, sleep: async ms => {
    await sleep(ms);
    if (transforming && ++waits === 8) {
      h.snapshot.state.event_running = false;
      h.snapshot.state.bike_active = true;
    }
  } });
  assert.equal(waits, 8);
  assert.equal(result.state.bike_active, true);
  assert.equal(result.state.event_running, false);
});

test('Bike abort prevents further inputs, and stalled or timed out menus fail boundedly', async () => {
  const h = harness(), abort = new AbortController();
  const sleep = h.options.sleep;
  await assert.rejects(ensureBike(h.send, { ...h.options, signal: abort.signal, sleep: async ms => {
    await sleep(ms); abort.abort();
  } }), /cancelled/);
  assert.deepEqual(h.keys(), ['cancel']);
  assert.equal(h.calls.at(-1).op, 'hold', 'a cancelled owner must not issue a late stop');

  const frozen = harness({ freeze: true });
  await assert.rejects(ensureBike(frozen.send, frozen.options), /engine stopped advancing/);
  assert.equal(frozen.calls.at(-1).op, 'stop');
  const timed = harness({ transform() {} });
  await assert.rejects(ensureBike(timed.send, { ...timed.options, timeoutMs: 500 }), /timed out/);
  assert.deepEqual(timed.keys(), ['cancel']);
});

test('Bike rejects a map or coordinate change during preparation', async () => {
  const h = harness({ transform(_key, s) { ++s.player_x; } });
  await assert.rejects(ensureBike(h.send, h.options), /player position changed/);
  assert.deepEqual(h.keys(), ['cancel']);
});

// An official snapshot: the controller reports every configured effect by item ID.
function effectHarness({ item = 38, index = 13, state = {}, transform } = {}) {
  const h = harness({ index, state: { backend: 'official', capabilities: { bike: true }, bike_item_index: 0,
    effects: { 12: { index: 0, owned: true, active: false }, [item]: { index, owned: true, active: false } }, ...state },
  transform: transform || ((key, s) => {
    if (key === 'cancel') s.scene = 'Menu';
    else if (key === 'decision' && s.scene === 'Menu') { s.scene = 'Item'; s.selected_item_id = item - index; }
    else if (key === 'right') ++s.selected_item_id;
    else if (key === 'down') s.selected_item_id += 2;
    else if (key === 'decision' && s.scene === 'Item') { s.scene = 'Map'; s.effects[item].active = true; }
  }) });
  return h;
}

test('any configured effect is equipped by item ID, and an active one is never toggled off', async () => {
  const h = effectHarness();
  const result = await ensureEffect(h.send, { ...h.options, item: 38 });
  assert.deepEqual(h.keys(), ['cancel', 'decision', ...walk(13), 'decision']);
  assert.equal(result.state.effects[38].active, true);
  await ensureEffect(h.send, { ...h.options, item: 38 });
  assert.equal(h.keys().length, walk(13).length + 3);
  for (const state of [{ effects: { 38: { index: -1, owned: true, active: false } } }, { capabilities: { bike: false } }]) {
    const skipped = effectHarness({ state });
    await ensureEffect(skipped.send, { ...skipped.options, item: 38 });
    assert.deepEqual(skipped.keys(), [], JSON.stringify(state));
  }
});

test('a route preparation needs its pending request and backs out of the menu after a failure', async () => {
  const request = { status: 'preparing', active: true, preparation_request: { id: 4, accepted: true } };
  // An active route without the matching pending request is never interrupted.
  for (const state of [{ active: true }, { ...request, preparation_request: { id: 5, accepted: true } }]) {
    const h = effectHarness({ state });
    await ensureEffect(h.send, { ...h.options, item: 38, preparing: 4 });
    assert.deepEqual(h.keys(), []);
  }
  const ok = effectHarness({ state: request });
  await ensureEffect(ok.send, { ...ok.options, item: 38, preparing: 4 });
  assert.equal(ok.snapshot.state.effects[38].active, true);

  const wrong = effectHarness({ state: request, transform(key, s) {
    if (key === 'cancel') s.scene = s.scene === 'Item' ? 'Menu' : s.scene === 'Menu' && s.selected_item_id ? 'Map' : 'Menu';
    else if (key === 'decision') { s.scene = 'Item'; s.selected_item_id = 99; }
    else s.selected_item_id += key === 'down' ? 2 : 1;
  } });
  await assert.rejects(ensureEffect(wrong.send, { ...wrong.options, item: 38, preparing: 4 }), /selected item is not item 38/);
  assert.deepEqual(wrong.keys(), ['cancel', 'decision', ...walk(13), 'cancel', 'cancel']);
  assert.equal(wrong.snapshot.state.scene, 'Map');
  assert.equal(wrong.calls.at(-1).op, 'stop');

  // Once the route stops waiting, preparation ends without further inputs.
  const dropped = effectHarness({ state: request, transform(key, s) {
    if (key === 'cancel') { s.scene = 'Menu'; s.status = 'stopped'; s.preparation_request = null; }
  } });
  await assert.rejects(ensureEffect(dropped.send, { ...dropped.options, item: 38, preparing: 4 }), /no longer waiting/);
  assert.deepEqual(dropped.keys(), ['cancel']);
});

// A frame-accurate item window: a move below the visible 12 rows scrolls for
// four updates, which ignore input (ynoengine Window_Selectable::Update).
function scrollingHarness(index, { frameStep = 3 } = {}) {
  const ids = Array.from({ length: index + 3 }, (_, i) => i === index ? 38 : 100 + i);
  const s = { ready: true, state: { backend: 'official', capabilities: { bike: true }, scene: 'Map', map_id: 420, player_x: 50, player_y: 30,
    frame: 1, active: false, menu_allowed: true, vehicle_type: 0, selected_item_id: 0, held_keys: [], bike_item_index: -1,
    effects: { 38: { index, owned: true, active: false } } } };
  let cursor = 0, top = 0, ignoreThrough = 0, pending = null, lost = 0;
  const frame = () => {
    const st = s.state;
    ++st.frame;
    if (!pending) return;
    const key = pending; pending = null; st.held_keys = [];
    if (st.frame <= ignoreThrough) { ++lost; return; }
    if (key === 'cancel') st.scene = 'Menu';
    else if (key === 'decision' && st.scene === 'Menu') { st.scene = 'Item'; cursor = 0; st.selected_item_id = ids[0]; }
    else if (key === 'decision' && st.scene === 'Item') { st.scene = 'Map'; st.effects[38].active = true; }
    else if (key === 'down' || key === 'right') {
      cursor += key === 'down' ? 2 : 1;
      st.selected_item_id = ids[cursor];
      const row = Math.floor(cursor / 2);
      if (row > top + 11) { top = row - 11; ignoreThrough = st.frame + 4; }
    }
  };
  const send = async command => {
    if (command.op === 'hold') { pending = command.key; s.state.held_keys = [command.key]; }
    return structuredClone(s);
  };
  const options = { game: '2kki', item: 38, now: () => s.state.frame * 17, sleep: async () => { for (let i = 0; i < frameStep; ++i) frame(); } };
  return { send, options, state: s.state, lost: () => lost };
}

test('cursor moves wait out the item window scroll and resend a lost press', async () => {
  for (const index of [23, 24, 25, 26, 35]) {
    for (const frameStep of [1, 2, 3, 5]) {
      const h = scrollingHarness(index, { frameStep });
      await ensureEffect(h.send, h.options);
      assert.equal(h.state.effects[38].active, true, `index ${index}, ${frameStep} frames per poll`);
      assert.equal(h.state.scene, 'Map');
    }
  }
});
