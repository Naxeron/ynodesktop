'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureBike } = require('../src/navbot/bike');

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
        if (command.key === 'cancel') s.scene = 'Menu';
        else if (command.key === 'decision' && s.scene === 'Menu') {
          s.scene = 'Item'; s.selected_item_id = 12 - index;
        } else if (command.key === 'right') ++s.selected_item_id;
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

test('Bike uses normal menu inputs and verifies the actual selected item and active effect', async () => {
  for (const index of [0, 1, 3, 11]) {
    const h = harness({ index });
    const result = await ensureBike(h.send, h.options);
    assert.deepEqual(h.keys(), ['cancel', 'decision', ...Array(index).fill('right'), 'decision']);
    assert.equal(h.calls.every(c => c.op !== 'hold' || c.frames === 1), true);
    assert.equal(result.state.scene, 'Map');
    assert.equal(result.state.bike_active, true);
    await ensureBike(h.send, h.options);
    assert.equal(h.keys().length, index + 3, 'already active Bike must never be toggled off');
  }
});

test('Bike skips other games, missing telemetry, unowned effects, blocked menus and scripted movement', async () => {
  const other = harness();
  assert.equal(await ensureBike(other.send, { ...other.options, game: 'yume' }), undefined);
  assert.deepEqual(other.calls, []);
  for (const state of [{ bike_item_index: -1 }, { bike_item_index: 12 }, { bike_active: null },
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
