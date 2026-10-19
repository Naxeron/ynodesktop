'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRouteController, createEngineSender, createPreparationRunner, rendererScript, engineCommand } = require('../src/navbot/bridge');
const { ensureEffect } = require('../src/navbot/bike');
const plainObject = value => JSON.parse(JSON.stringify(value));
const { createCommandQueue } = require('../src/navbot/command-queue');

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function harness(map = 10, run, clock = {}) {
  const calls = [], runs = [];
  let time = 0;
  const engine = { ready: true, page: { location: 'Nexus' }, state: {
    scene: 'Map', map_id: map, player_x: 3, player_y: 4, frame: 1,
    active: false, status: 'stopped', last_error: '', path_length: 0,
  } };
  const controller = createRouteController(async (command, control) => {
    calls.push({ command, control });
    return structuredClone(engine);
  }, { game: '2kki', load: () => [{ map: 10, walk: [4, 4], label: 'Leave the Nexus' }], now: () => time, sleep: async ms => { time += ms; }, ...clock,
    run: async (send, steps, options) => {
      const job = deferred();
      runs.push({ send, steps, options, job });
      options.onStep(0, steps[0]);
      if (run) return run(send, steps, options, job);
      return job.promise;
    },
  });
  const start = (x = 3, y = 75) => controller.start({ op: 'goto-map', map: 568, x, y }, { generation: runs.length + 1 });
  return { controller, calls, runs, engine, start };
}

test('shared 2kki movement sender stops old navigation and prepares Bike before local and map movement', async () => {
  for (const command of [{ op: 'goto', x: 7, y: 8 }, { op: 'goto-map', map: 568, x: 3, y: 75 }]) {
    const calls = [], records = [];
    const raw = { ready: true, state: { map_id: 10, active: false } };
    let prepared = 0;
    const send = createEngineSender(async (call, control) => {
      calls.push({ call, control });
      return structuredClone(raw);
    }, { game: '2kki', generation: () => 4, now: () => 1000,
      snapshot: result => ({ ...result, state: { ...result.state, active: true } }),
      record: (type, data) => records.push({ type, data }),
      prepare: async (input, options) => {
        ++prepared;
        assert.equal(options.game, '2kki');
        assert.equal(options.snapshot.state.active, false, 'preparation gets raw engine state, not recipe activity');
        assert.deepEqual(options.target, [command.map ?? 10, command.x, command.y]);
        await input({ op: 'hold', key: 'cancel', frames: 1 });
        await input({ op: 'state' });
      },
    });
    const result = await send(command, { generation: 4, expiresAt: 2000 });
    assert.equal(prepared, 1, 'the final movement dispatch does not recurse into preparation');
    assert.deepEqual(calls.map(entry => entry.call?.[0] || 'state'), ['_Navbot_Stop', 'state', '_Navbot_HoldKey', 'state', engineCommand(command)[0]]);
    assert.equal(result.state.active, false);
    assert.ok(records.filter(entry => entry.type === 'state').every(entry => entry.data.state.active === true));
    assert.ok(calls.every(entry => entry.control.generation === 4 && entry.control.expiresAt === 5500));
  }
});

test('shared preparation skips other games and non-movement commands', async () => {
  for (const [game, command] of [['yume', { op: 'goto', x: 2, y: 3 }], ['2kki', { op: 'hold', key: 'up', frames: 1 }], ['2kki', { op: 'state' }]]) {
    const calls = [];
    const send = createEngineSender(async call => { calls.push(call); return {}; }, {
      game, prepare: async () => assert.fail('unexpected preparation'),
    });
    await send(command);
    assert.deepEqual(calls, [engineCommand(command)]);
  }
});

test('accepted preparation refreshes each input expiry while expired or stale requests never start it', async () => {
  let time = 1000, generation = 2;
  const calls = [];
  const send = createEngineSender(async (call, control) => {
    calls.push({ call, control, time });
    return { ready: true, state: { map_id: 10 } };
  }, { game: '2kki', generation: () => generation, now: () => time,
    prepare: async input => {
      time += 5000;
      await input({ op: 'hold', key: 'decision', frames: 1 });
    },
  });
  const command = { op: 'goto', x: 8, y: 9 };
  await assert.rejects(send(command, { generation: 1, expiresAt: 2000 }), /cancelled by Stop/);
  await assert.rejects(send(command, { generation: 2, expiresAt: 999 }), /expired before Bike preparation/);
  assert.equal(calls.length, 0);
  await send(command, { generation: 2, expiresAt: 2000 });
  assert.ok(calls.every(entry => entry.control.expiresAt === entry.time + 4500));
  assert.equal(calls.at(-1).control.expiresAt, 10500);
  assert.equal(calls.at(-1).call[0], '_Navbot_GoTo');
});

test('Stop during any nested preparation operation blocks subsequent inputs and original movement', async () => {
  for (const blockedOperation of ['_Navbot_Stop', 'state', '_Navbot_HoldKey']) {
    let generation = 1;
    const pending = deferred(), calls = [];
    const send = createEngineSender(async call => {
      const operation = call?.[0] || 'state';
      calls.push(operation);
      if (operation === blockedOperation) await pending.promise;
      return { ready: true, state: { map_id: 10 } };
    }, { game: '2kki', generation: () => generation,
      prepare: async input => {
        await input({ op: 'hold', key: 'cancel', frames: 1 });
        await input({ op: 'state' });
        await input({ op: 'hold', key: 'decision', frames: 1 });
      },
    });
    const moving = send({ op: 'goto', x: 8, y: 9 }, { generation: 1 });
    const cancelled = assert.rejects(moving, /cancelled by Stop/);
    await flush();
    assert.equal(calls.at(-1), blockedOperation);
    const count = calls.length;
    ++generation;
    pending.resolve();
    await cancelled;
    assert.equal(calls.length, count);
    assert.ok(!calls.includes('_Navbot_GoTo'));
  }
});

test('a failed preparation or a Stop just before movement never launches the original target', async () => {
  for (const stopped of [false, true]) {
    let generation = 1;
    const calls = [];
    const send = createEngineSender(async call => {
      calls.push(call?.[0] || 'state');
      return { ready: true, state: { map_id: 10 } };
    }, { game: '2kki', generation: () => generation, prepare: async () => {
      if (stopped) ++generation;
      else throw new Error('Bike preparation timed out');
    } });
    await assert.rejects(send({ op: 'goto-map', map: 568, x: 3, y: 75 }, { generation: 1 }), stopped ? /cancelled by Stop/ : /timed out/);
    assert.deepEqual(calls, ['_Navbot_Stop', 'state']);
  }
});

test('retargeting through the command queue interrupts standalone preparation immediately and preserves overlapping counts', async () => {
  for (const replacement of [{ op: 'goto', x: 20, y: 21 }, { op: 'hold', key: 'left', frames: 1 }, { op: 'reload' }]) {
    let generation = 0;
    const calls = [], jobs = [];
    const sender = createEngineSender(async (call, control) => {
      calls.push({ call, generation: control.generation });
      return { ready: true, state: { map_id: 10 } };
    }, { game: '2kki', generation: () => generation, prepare: async input => {
      const job = deferred();
      jobs.push(job);
      await input({ op: 'hold', key: 'cancel', frames: 1 });
      await job.promise;
      await input({ op: 'hold', key: 'decision', frames: 1 });
    } });
    const queue = createCommandQueue(async (command, control) => {
      control = { ...control, generation: ++generation };
      if (command.op === 'reload') { calls.push({ reload: true }); return {}; }
      return sender(command, control);
    });
    // Same receipt-time priority Stop used by the bridge when no recipe exists.
    const schedule = command => {
      if (sender.preparing && command.op !== 'stop') void queue({ op: 'stop' });
      return queue(command);
    };
    const original = schedule({ op: 'goto', x: 8, y: 9 });
    const cancelled = assert.rejects(original, /cancelled by Stop/);
    await flush();
    assert.equal(sender.preparing, true);
    const oldGeneration = generation;
    const next = schedule(replacement);
    assert.ok(generation > oldGeneration, 'priority Stop dispatches before the old preparation finishes');
    await flush();
    assert.equal(jobs.length, replacement.op === 'goto' ? 2 : 1);
    const count = calls.length;
    jobs[0].resolve();
    await cancelled;
    assert.equal(calls.length, count, 'cancelled preparation emits neither late input nor finally-stop');
    if (replacement.op === 'goto') {
      assert.equal(sender.preparing, true, 'old completion must not clear a newer preparation');
      jobs[1].resolve();
    }
    await next;
    assert.equal(sender.preparing, false);
    const moves = calls.filter(entry => entry.call?.[0] === '_Navbot_GoTo');
    assert.deepEqual(moves.map(entry => entry.call[1]), replacement.op === 'goto' ? [[20, 21]] : []);
  }
});

test('Planetarium recipes are game-scoped and append the exact requested tile', async () => {
  const h = harness();
  assert.equal(h.controller.accepts({ op: 'goto-map', map: 568 }), true);
  assert.equal(h.controller.accepts({ op: 'goto-map', map: 567 }), true);
  assert.equal(h.controller.accepts({ op: 'goto-map', map: 10 }), false);
  assert.equal(createRouteController(() => {}, { game: 'yume' }).accepts({ op: 'goto-map', map: 568 }), false);
  const result = await h.start(12, 20);
  assert.deepEqual(h.runs[0].steps.at(-1), { map: 568, walk: [12, 20], label: 'Reach the requested Planetarium tile' });
  assert.equal(result.state.active, true);
  assert.equal(result.state.engine_active, false);
  assert.equal(result.state.engine_status, 'stopped');
  assert.equal(result.state.path_length, 0);
  assert.equal(result.page.location, 'Nexus');
  assert.deepEqual(result.state.recipe, { name: 'Planetarium', step: 1, total: 2, label: 'Leave the Nexus', status: 'navigating', map: 568, x: 12, y: 20, expeditionComplete: null, variant: 'normal' });
  h.runs[0].job.resolve({ ready: true, page: { locationNames: ['Planetarium'] }, state: { ...h.engine.state, map_id: 568, player_x: 12, player_y: 20 } });
  await flush();
  assert.equal(h.controller.snapshot(h.engine).state.status, 'arrived');
  assert.equal(h.controller.snapshot(h.engine).state.active, false);
});

test('safe starting maps reach Nexus first, while unsupported maps fail clearly', async () => {
  for (const map of [2, 4, 5]) {
    const h = harness(map);
    await h.start();
    assert.deepEqual(h.runs[0].steps[0], { map, travel: [10, 3, 4], label: 'Reach the Nexus' });
    h.controller.cancel();
    h.runs[0].job.resolve(h.engine);
  }
  const already = harness(568);
  await already.start(8, 9);
  assert.equal(already.runs[0].steps.length, 1);
  already.controller.cancel();
  already.runs[0].job.resolve(already.engine);
  const unknown = harness(530);
  await assert.rejects(unknown.start(), /Start.*Nexus or the starting room/);
  assert.equal(unknown.runs.length, 0);
  assert.deepEqual(unknown.controller.snapshot(unknown.engine), unknown.engine);
  await assert.rejects(unknown.controller.start({ op: 'goto-map', map: 567 }, {}), /Planetarium map 568/);
  unknown.engine.state.map_id = 10;
  unknown.engine.state.event_running = true;
  await assert.rejects(unknown.start(), /standing on the map/);
});

test('route failures and wrong final coordinates never report arrival', async () => {
  const h = harness();
  await h.start();
  h.runs[0].job.reject(new Error('Step 8: unexpected map 999'));
  await flush();
  let result = h.controller.snapshot(h.engine);
  assert.equal(result.state.status, 'error');
  assert.equal(result.state.active, false);
  assert.match(result.state.last_error, /unexpected map 999/);
  h.controller.cancel();
  await h.start(12, 20);
  h.runs[1].job.resolve({ ready: true, state: { ...h.engine.state, map_id: 568, player_x: 3, player_y: 75 } });
  await flush();
  result = h.controller.snapshot(h.engine);
  assert.equal(result.state.status, 'error');
  assert.match(result.state.last_error, /requested Planetarium tile was not reached/);
});

test('cancellation blocks both delayed inputs and an old runner finally-stop after retargeting', async () => {
  const h = harness(10, async (send, _steps, _options, job) => {
    try { return await job.promise; }
    finally { await send({ op: 'stop' }); }
  });
  await h.start();
  const old = h.runs[0];
  assert.equal(h.controller.cancel(), true);
  assert.equal(old.options.signal.aborted, true);
  await h.start(12, 20);
  const count = h.calls.length;
  await assert.rejects(old.send({ op: 'hold', key: 'up', frames: 1 }), /cancelled/);
  old.job.resolve(h.engine);
  await flush();
  assert.equal(h.calls.length, count, 'old finally-stop never reaches the engine');
  assert.equal(h.controller.snapshot(h.engine).state.recipe.x, 12);
  assert.equal(h.controller.snapshot(h.engine).state.active, true);
  h.controller.cancel();
  h.runs[1].job.resolve(h.engine);
  await flush();
  assert.deepEqual(h.controller.snapshot(h.engine), h.engine);
});

test('cancellation during a pending state read cannot launch the recipe afterward', async () => {
  const read = deferred();
  let launched = false;
  const controller = createRouteController(() => read.promise, {
    game: '2kki', run: async () => { launched = true; }, load: () => [],
  });
  const starting = controller.start({ op: 'goto-map', map: 568, x: 3, y: 75 }, { generation: 1 });
  controller.cancel();
  read.resolve({ ready: true, state: { scene: 'Map', map_id: 10 } });
  await assert.rejects(starting, /cancelled/);
  assert.equal(launched, false);
});

test('arrival waits for exact location and the initially unfinished weekly expedition to synchronize', async () => {
  let polls = 0;
  const h = harness(10, undefined, { sleep: async () => {
    ++polls;
    h.engine.page.locationNames = ['Planetarium'];
    if (polls === 2) h.engine.page.expeditions[0].complete = true;
  } });
  h.engine.page.expeditions = [{ title: 'Planetarium', type: 'Еженедельные', kind: 'weekly', complete: false }];
  await h.start();
  Object.assign(h.engine.state, { map_id: 568, player_x: 3, player_y: 75 });
  h.engine.page.locationNames = ['Planetarium: Entrance'];
  h.runs[0].job.resolve(structuredClone(h.engine));
  await flush();
  assert.equal(polls, 2);
  const result = h.controller.snapshot(h.engine);
  assert.equal(result.state.status, 'arrived');
  assert.equal(result.state.recipe.expeditionComplete, true);
  assert.ok(h.calls.every(call => call.command.op === 'state'), 'confirmation never sends movement');
});

test('unconfirmed arrival times out without reconnecting or retrying movement', async () => {
  for (const exactLocation of [false, true]) {
    const h = harness();
    h.engine.page.expeditions = [{ title: 'Planetarium', type: 'Weekly', kind: 'weekly', complete: false }];
    await h.start();
    Object.assign(h.engine.state, { map_id: 568, player_x: 3, player_y: 75 });
    h.engine.page.locationNames = [exactLocation ? 'Planetarium' : 'Planetarium: Entrance'];
    h.runs[0].job.resolve(structuredClone(h.engine));
    await flush();
    const result = h.controller.snapshot(h.engine);
    assert.equal(result.state.status, 'error');
    assert.equal(result.state.active, false);
    assert.equal(result.state.recipe.expeditionComplete, false);
    assert.equal(result.state.map_id, 568);
    assert.equal(result.state.player_x, 3);
    assert.equal(result.state.player_y, 75);
    assert.match(result.state.last_error, exactLocation ? /weekly expedition completion was not confirmed/ : /exact Planetarium location was not confirmed/);
    assert.equal(h.calls.filter(call => call.command.op === 'state').length, 61, 'confirmation stops after 15 seconds');
    assert.ok(h.calls.every(call => call.command.op === 'state'), 'confirmation only reads state');
  }
});

test('weekly confirmation can arrive after a delay without reconnecting', async () => {
  let time = 0;
  const h = harness(10, undefined, { now: () => time, sleep: async ms => {
    time += ms;
    if (time === 3000) h.engine.page.expeditions[0].complete = true;
  } });
  h.engine.page.expeditions = [{ title: 'Planetarium', kind: 'weekly', complete: false }];
  await h.start();
  Object.assign(h.engine.state, { map_id: 568, player_x: 3, player_y: 75 });
  h.engine.page.locationNames = ['Planetarium'];
  h.runs[0].job.resolve(structuredClone(h.engine));
  await flush();
  assert.equal(time, 3000);
  assert.equal(h.controller.snapshot(h.engine).state.status, 'arrived');
  assert.ok(h.calls.every(call => call.command.op === 'state'));
});

test('an already completed weekly entry still waits for natural server room acknowledgment', async () => {
  let time = 0;
  const h = harness(10, undefined, { now: () => time, sleep: async ms => {
    time += ms;
    if (time === 3250) {
      Object.assign(h.engine.state, { room_connected: true, room_sync_pending: false, room_synced_id: 568 });
    }
  } });
  h.engine.page.expeditions = [{ title: 'Planetarium', kind: 'weekly', complete: true }];
  await h.start();
  Object.assign(h.engine.state, { map_id: 568, player_x: 3, player_y: 75, room_connected: true, room_sync_pending: false, room_synced_id: 565 });
  h.engine.page.locationNames = ['Planetarium'];
  h.runs[0].job.resolve(structuredClone(h.engine));
  await flush();
  assert.equal(time, 3250);
  assert.ok(h.calls.every(call => call.command.op === 'state'));
  assert.equal(h.controller.snapshot(h.engine).state.status, 'arrived');
});

test('room telemetry must acknowledge the exact target without reconnecting', async () => {
  for (const room of [
    { room_connected: false, room_sync_pending: false, room_synced_id: -1 },
    { room_connected: true, room_sync_pending: true, room_synced_id: 568 },
    { room_synced_id: 568 },
  ]) {
    const h = harness();
    h.engine.page.expeditions = [{ title: 'Planetarium', kind: 'weekly', complete: false }];
    await h.start();
    Object.assign(h.engine.state, { map_id: 568, player_x: 3, player_y: 75 }, room);
    h.engine.page.locationNames = ['Planetarium'];
    h.runs[0].job.resolve(structuredClone(h.engine));
    await flush();
    assert.equal(h.calls.length, 61, 'confirmation stops after 15 seconds');
    assert.ok(h.calls.every(call => call.command.op === 'state'));
    const result = h.controller.snapshot(h.engine);
    assert.equal(result.state.status, 'error');
    assert.match(result.state.last_error, /server room did not synchronize/);
  }
});

test('an acknowledged target room and completed weekly entry need no reconnect', async () => {
  const h = harness();
  h.engine.page.expeditions = [{ title: 'Planetarium', kind: 'weekly', complete: true }];
  await h.start();
  Object.assign(h.engine.state, { map_id: 568, player_x: 3, player_y: 75, room_connected: true, room_sync_pending: false, room_synced_id: 568 });
  h.engine.page.locationNames = ['Planetarium'];
  h.runs[0].job.resolve(structuredClone(h.engine));
  await flush();
  assert.equal(h.controller.snapshot(h.engine).state.status, 'arrived');
  assert.ok(h.calls.every(call => call.command.op === 'state'));
});

test('Stop during delayed weekly confirmation blocks stale polling', async () => {
  const waiting = deferred();
  let time = 0;
  const h = harness(10, undefined, { now: () => time, sleep: async ms => {
    time += ms;
    if (time === 3000) await waiting.promise;
  } });
  h.engine.page.expeditions = [{ title: 'Planetarium', kind: 'weekly', complete: false }];
  await h.start();
  Object.assign(h.engine.state, { map_id: 568, player_x: 3, player_y: 75 });
  h.engine.page.locationNames = ['Planetarium'];
  h.runs[0].job.resolve(structuredClone(h.engine));
  await flush();
  assert.equal(time, 3000);
  h.controller.cancel();
  await h.start(12, 20);
  const calls = h.calls.length;
  waiting.resolve();
  await flush();
  assert.equal(h.calls.length, calls);
  assert.ok(h.calls.every(call => call.command.op === 'state'));
  assert.equal(h.controller.snapshot(h.engine).state.recipe.x, 12);
  h.controller.cancel();
  h.runs[1].job.resolve(h.engine);
});

test('an already completed weekly entry or another expedition does not gate generic arrival', async () => {
  for (const entry of [
    { title: 'Planetarium', type: 'Weekly', kind: 'weekly', complete: true },
    { title: 'Planetarium', type: 'Daily', complete: false },
    { title: 'Nexus', type: 'Weekly', kind: 'weekly', complete: false },
  ]) {
    const h = harness();
    h.engine.page.expeditions = [entry];
    await h.start();
    Object.assign(h.engine.state, { map_id: 568, player_x: 3, player_y: 75 });
    h.engine.page.locationNames = ['Planetarium'];
    h.runs[0].job.resolve(structuredClone(h.engine));
    await flush();
    const result = h.controller.snapshot(h.engine);
    assert.equal(result.state.status, 'arrived');
    assert.equal(result.state.recipe.expeditionComplete, null);
    assert.equal(h.calls.length, 1);
  }
});

test('cancelling during final confirmation cannot overwrite a new route or dispatch a stale poll', async () => {
  const sleeping = deferred();
  const h = harness(10, undefined, { sleep: () => sleeping.promise });
  await h.start();
  Object.assign(h.engine.state, { map_id: 568, player_x: 3, player_y: 75 });
  h.runs[0].job.resolve(structuredClone(h.engine));
  await flush();
  assert.equal(h.controller.snapshot(h.engine).state.recipe.label, 'Confirm Planetarium location');
  h.controller.cancel();
  await h.start(12, 20);
  const calls = h.calls.length;
  sleeping.resolve();
  await flush();
  assert.equal(h.calls.length, calls);
  assert.equal(h.controller.snapshot(h.engine).state.recipe.x, 12);
  assert.equal(h.controller.snapshot(h.engine).state.status, 'navigating');
  h.controller.cancel();
  h.runs[1].job.resolve(h.engine);
});

test('renderer reads only the fixed 2kki Forest Pier capability, with safe older-engine fallback', () => {
  const calls = [];
  const context = {
    window: { Module: { _Navbot_GetState: () => 1, UTF8ToString: () => '{}', _Navbot_HasSkill: (...args) => { calls.push(args); return 1; } } },
    document: { title: '2kki', getElementById: () => null },
    location: { hostname: 'ynoproject.net', pathname: '/2kki/' },
  };
  assert.equal(vm.runInNewContext(rendererScript(null, '2kki', undefined, undefined, 'local'), context).state.forest_pier_visited, true);
  assert.deepEqual(calls, [[2, 512]]);
  context.location.pathname = '/yume/';
  assert.equal(vm.runInNewContext(rendererScript(null, 'yume', undefined, undefined, 'local'), context).state.forest_pier_visited, undefined);
  assert.equal(calls.length, 1);
  context.location.pathname = '/2kki/';
  delete context.window.Module._Navbot_HasSkill;
  assert.equal(vm.runInNewContext(rendererScript(null, '2kki', undefined, undefined, 'local'), context).state.forest_pier_visited, false);
  assert.throws(() => engineCommand({ op: 'has-skill', actor: 2, skill: 512 }), /Unknown operation/);
});

test('renderer exposes fixed read-only Bike capability fields and preserves unknown state', () => {
  const calls = [];
  const switches = { 132: 0, 14: 0, 39: 1, 4103: 0 };
  const context = {
    window: { Module: {
      _Navbot_GetState: () => 1, UTF8ToString: () => '{}',
      _Navbot_GetItemIndex: id => { calls.push(['item', id]); return 4; },
      _Navbot_GetSwitch: id => { calls.push(['switch', id]); return switches[id] ?? -1; },
    } },
    document: { title: '2kki', getElementById: () => null },
    location: { hostname: 'ynoproject.net', pathname: '/2kki/' },
  };
  const read = () => vm.runInNewContext(rendererScript(null, '2kki', undefined, undefined, 'local'), context).state;
  const first = read();
  assert.equal(first.bike_item_index, 4);
  assert.equal(first.bike_active, false);
  assert.equal(first.bike_blocked, true);
  assert.deepEqual(calls, [['item', 12], ['switch', 132], ['switch', 14], ['switch', 39], ['switch', 4103]]);
  switches[132] = 1;
  switches[39] = 0;
  assert.equal(read().bike_active, true);
  assert.equal(read().bike_blocked, false);
  switches[4103] = 1;
  assert.equal(read().bike_blocked, true, 'the boat blocks the Bike');
  delete context.window.Module._Navbot_GetItemIndex;
  delete context.window.Module._Navbot_GetSwitch;
  const older = read();
  assert.equal(older.bike_item_index, -1);
  assert.equal(older.bike_active, null);
  assert.equal(older.bike_blocked, null);
});

test('reconnect clicks only the official available button and observes expiry, game and Stop guards', () => {
  let clicks = 0;
  const button = { click: () => ++clicks, classList: { contains: () => false } };
  const context = {
    Date: { now: () => 1000 },
    window: { Module: { _Navbot_GetState: () => 1, UTF8ToString: () => '{}', _Navbot_Stop: () => {} } },
    document: { title: '2kki', getElementById: id => id === 'reconnectButton' ? button : null },
    location: { hostname: 'ynoproject.net', pathname: '/2kki/' }, connStatus: 1,
  };
  const command = engineCommand({ op: 'reconnect' });
  assert.deepEqual(command, ['reconnect', []]);
  const read = (expiry = 2000, generation = 0) => vm.runInNewContext(rendererScript(command, '2kki', expiry, generation, 'local'), context);
  assert.equal(read().reconnectClicked, true);
  assert.equal(clicks, 1);
  button.disabled = true;
  assert.equal(read().reconnectClicked, false);
  button.disabled = false;
  button.classList.contains = () => true;
  assert.equal(read().reconnectClicked, false);
  button.classList.contains = () => false;
  context.connStatus = 2;
  assert.equal(read().reconnectClicked, false);
  context.connStatus = 1;
  context.document.getElementById = () => null;
  assert.equal(read().reconnectClicked, false);
  context.document.getElementById = id => id === 'reconnectButton' ? button : null;
  assert.throws(() => read(999), /expired/);
  context.location.pathname = '/yume/';
  assert.throws(() => read(), /does not match/);
  context.location.pathname = '/2kki/';
  vm.runInNewContext(rendererScript(['_Navbot_Stop', []], '2kki', 0, 1, 'local'), context);
  assert.throws(() => read(), /cancelled by Stop/);
  assert.equal(clicks, 1, 'unavailable, expired and cancelled operations do not click');
});

test('localized expedition cache exposes canonical title and kind with only bounded public fields', () => {
  const row = {
    classList: { contains: () => true },
    querySelector: () => ({ textContent: 'プラネタリウム', querySelector: () => ({ textContent: 'プラネタリウム' }) }),
  };
  const context = {
    window: {}, document: { title: '2kki', getElementById: id => id === 'eventLocationsList' ? { children: [row] } : null },
    location: { hostname: 'ynoproject.net', pathname: '/2kki/' },
    localizedMessages: { events: { types: ['Ежедневные', 'Еженедельные'] } },
    eventsCache: { locations: [
      { title: 'Planetarium', game: '2kki', type: 1, complete: false, unrelatedPrivateField: 'must not leak' },
      { title: 'Planetarium', game: 'yume', type: 1, complete: true },
    ] },
  };
  const result = vm.runInNewContext(rendererScript(null, '2kki'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(result.page.expeditions)), [
    { title: 'Planetarium', type: 'Еженедельные', kind: 'weekly', complete: false },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /must not leak|unrelatedPrivateField/);
  context.eventsCache.locations = Array(100).fill({ title: 'x'.repeat(500), type: 1, complete: false });
  const bounded = vm.runInNewContext(rendererScript(null, '2kki'), context);
  assert.equal(bounded.page.expeditions.length, 40);
  assert.equal(bounded.page.expeditions[0].title.length, 300);
});

test('arrival diagnostics expose only bounded connection and location cache metadata', () => {
  const context = {
    window: {}, document: { title: '2kki', getElementById: () => null },
    location: { hostname: 'ynoproject.net', pathname: '/2kki/' },
  };
  const read = () => vm.runInNewContext(rendererScript(null, '2kki'), context).page;
  const missing = read();
  for (const key of ['loggedIn', 'connectionState', 'sessionSocketState', 'cachedMapId', 'cachedLocationNames']) assert.equal(missing[key], null);
  Object.assign(context, {
    loggedIn: true, connStatus: 1, sessionWs: { readyState: 1, url: 'must-not-leak-token' }, cachedMapId: '0568',
    cachedLocations: [{ title: 'Planetarium', unrelatedPrivateField: 'must-not-leak-account' }],
    playerData: { name: 'must-not-leak-player' },
  });
  const ready = read();
  assert.equal(ready.loggedIn, true);
  assert.equal(ready.connectionState, 1);
  assert.equal(ready.sessionSocketState, 1);
  assert.equal(ready.cachedMapId, '0568');
  assert.deepEqual(Array.from(ready.cachedLocationNames), ['Planetarium']);
  assert.doesNotMatch(JSON.stringify(ready), /must-not-leak|unrelatedPrivateField/);
  Object.assign(context, { loggedIn: false, connStatus: 9, sessionWs: { readyState: -1 }, cachedMapId: 'invalid', cachedLocations: Array(30).fill({ title: 'x'.repeat(500) }) });
  const bounded = read();
  assert.equal(bounded.loggedIn, false);
  assert.equal(bounded.connectionState, null);
  assert.equal(bounded.sessionSocketState, null);
  assert.equal(bounded.cachedMapId, null);
  assert.equal(bounded.cachedLocationNames.length, 16);
  assert.equal(bounded.cachedLocationNames[0].length, 300);
});

test('only a verified Forest Pier skill selects the shortcut and joins the normal boat approach', async () => {
  const normal = require('../src/navbot/routes/2kki-planetarium.json');
  const prefix = require('../src/navbot/routes/2kki-planetarium-shortcut.json');
  const join = normal.findIndex(step => step.map === 524 && step.walk?.[0] === 6 && step.walk[1] === 47);
  assert.ok(join > 0);
  for (const visited of [undefined, false, 1, true]) {
    const h = harness(10, undefined, { load: name => name === '2kki-planetarium-shortcut' ? prefix : normal });
    h.engine.state.forest_pier_visited = visited;
    await h.start();
    const expected = visited === true ? [...prefix, ...normal.slice(join)] : normal;
    assert.deepEqual(h.runs[0].steps.slice(0, -1), expected);
    assert.equal(h.controller.snapshot(h.engine).state.recipe.variant, visited === true ? 'forest-pier-shortcut' : 'normal');
    h.controller.cancel();
    h.runs[0].job.resolve(h.engine);
  }
  const invalid = harness();
  invalid.engine.state.forest_pier_visited = true;
  await assert.rejects(invalid.start(), /missing its Forest Pier connection/);
  assert.equal(invalid.runs.length, 0);
});

const official = (extra = {}) => ({ backend: 'official', user_interrupts: 0, engine_state_error: null,
  capabilities: { scene: true, events: true, bike: true, recipes: true, memory: true, logical_frames: true, live_collision: false }, ...extra });

test('official Planetarium recipes require verified engine state and report the memory reader error', async () => {
  for (const [patch, reason] of [
    [{ capabilities: { recipes: false }, engine_state_error: 'Game_Player typeinfo not found' }, 'Game_Player typeinfo not found'],
    [{ capabilities: { recipes: 'true' }, engine_state_error: 'vtable mismatch' }, 'vtable mismatch'],
    [{ capabilities: undefined, engine_state_error: null }, 'unavailable'],
    [{ capabilities: {}, engine_state_error: '' }, 'unavailable'],
  ]) {
    const h = harness();
    Object.assign(h.engine.state, official(patch));
    const error = await h.start().then(() => null, cause => cause);
    assert.ok(error, JSON.stringify(patch));
    assert.equal(error.message, `The Planetarium recipe requires verified official-engine state (${reason}).`);
    assert.equal(h.runs.length, 0);
    assert.deepEqual(h.calls.map(call => call.command.op), ['state'], 'a refused recipe sends no input');
    assert.deepEqual(h.controller.snapshot(h.engine), h.engine, 'a refused recipe leaves no route state behind');
  }
  // The capability check precedes ordinary readiness checks, so it explains an unverified scene.
  const unverified = harness();
  Object.assign(unverified.engine.state, official({ scene: null, capabilities: { recipes: false }, engine_state_error: 'no scene' }));
  await assert.rejects(unverified.start(), /official-engine state \(no scene\)/);

  const verified = harness();
  Object.assign(verified.engine.state, official());
  const result = await verified.start(12, 20);
  assert.equal(verified.runs.length, 1);
  assert.equal(result.state.status, 'navigating');
  assert.equal(result.state.recipe.variant, 'normal');
  verified.controller.cancel();
  verified.runs[0].job.resolve(verified.engine);
});

test('keyboard input on the official canvas cancels a running recipe', async () => {
  const h = harness(10, (send, _steps, _options, job) => job.promise.then(() => send({ op: 'state' })));
  Object.assign(h.engine.state, official({ user_interrupts: 4 }));
  await h.start();
  // Unchanged counters pass through the guarded sender.
  assert.equal((await h.runs[0].send({ op: 'state' })).state.user_interrupts, 4);
  h.engine.state.user_interrupts = 5;
  await assert.rejects(h.runs[0].send({ op: 'hold', key: 'up', frames: 1 }), /^Error: Route cancelled by keyboard input$/);
  h.runs[0].job.resolve(h.engine);
  await flush();
  const result = h.controller.snapshot(h.engine);
  assert.equal(result.state.status, 'error');
  assert.equal(result.state.active, false);
  assert.equal(result.state.last_error, 'Route cancelled by keyboard input');
  assert.equal(result.state.recipe.status, 'error');
});

test('keyboard input during final Planetarium confirmation also cancels the recipe', async () => {
  let time = 0;
  // Time advances so a regression ends at the confirmation deadline instead of hanging.
  const h = harness(10, undefined, { now: () => time, sleep: async ms => { time += ms; h.engine.state.user_interrupts = 1; } });
  Object.assign(h.engine.state, official());
  await h.start();
  Object.assign(h.engine.state, { map_id: 568, player_x: 3, player_y: 75 });
  h.engine.page.locationNames = ['Planetarium: Entrance'];
  h.runs[0].job.resolve(structuredClone(h.engine));
  await flush();
  const result = h.controller.snapshot(h.engine);
  assert.equal(result.state.status, 'error');
  assert.equal(result.state.last_error, 'Route cancelled by keyboard input');
  assert.equal(h.calls.length, 2, 'the cancelled confirmation stops polling');
});

test('local engine state without interrupt counters never reports keyboard cancellation', async () => {
  const h = harness(10, (send, _steps, _options, job) => job.promise.then(() => send({ op: 'state' })));
  await h.start();
  // A later integer cannot be compared with an unknown starting counter.
  Object.assign(h.engine.state, { user_interrupts: 3, map_id: 568, player_x: 3, player_y: 75 });
  h.engine.page.locationNames = ['Planetarium'];
  h.runs[0].job.resolve();
  await flush();
  const result = h.controller.snapshot(h.engine);
  assert.equal(result.state.last_error, '');
  assert.equal(result.state.status, 'arrived');
});

// A page-side official controller stub driven through the real renderer script,
// with Bike fields filled from verified memory queries as on ynoproject.net.
function officialPage({ memory = true, interruptOn = null } = {}) {
  const engine = { scene: 'Map', map_id: 10, player_x: 3, player_y: 4, frame: 1, bike_active: false, selected_item_id: 0 };
  const executed = [];
  let held = null, ticks = 0, interrupts = 0;
  const effects = {
    cancel: () => { engine.scene = 'Menu'; },
    decision: () => {
      if (engine.scene === 'Menu') { engine.scene = 'Item'; engine.selected_item_id = 12; }
      else if (engine.scene === 'Item') { engine.scene = 'Map'; engine.selected_item_id = 0; engine.bike_active = true; }
    },
  };
  const keys = ['up', 'down', 'left', 'right', 'decision', 'cancel', 'shift'];
  const controller = {
    read() {
      ++engine.frame;
      if (held && --ticks <= 0) { effects[held]?.(); held = null; }
      return { ready: true, backend: 'official', map_known: true, map_id: engine.map_id, player_x: engine.player_x, player_y: engine.player_y,
        frame: engine.frame, scene: memory ? engine.scene : null, moving: memory ? false : null, event_running: memory ? false : null,
        message_active: memory ? false : null, async_pending: memory ? false : null, move_route_overwritten: memory ? false : null,
        menu_allowed: memory ? true : null, vehicle_type: memory ? 0 : null, selected_item_id: memory ? engine.selected_item_id : null,
        bike_item_index: null, bike_active: null, bike_blocked: null, forest_pier_visited: null,
        engine_state_error: memory ? null : 'memory unavailable', user_interrupts: interrupts,
        active: false, status: 'stopped', held_keys: held ? [{ button: keys.indexOf(held), frames: 1 }] : [],
        capabilities: { scene: memory, bike: memory, recipes: memory, memory } };
    },
    query: () => memory ? { switches: { 132: engine.bike_active ? 1 : 0, 14: 0, 39: 0 }, items: { 12: 0 }, skills: { '2:512': false } } : null,
    execute(call) {
      executed.push(JSON.parse(JSON.stringify(call)));
      if (call[0] === '_Navbot_HoldKey') {
        held = keys[call[1][0]]; ticks = 2;
        if (interruptOn === held) ++interrupts;
      }
      if (call[0] === '_Navbot_Stop') held = null;
    },
  };
  const context = { window: { __ynoOfficialController: controller }, document: { title: '2kki', getElementById: () => null },
    location: { hostname: 'ynoproject.net', pathname: '/2kki/' } };
  const evaluate = async (call, control = {}) => vm.runInNewContext(rendererScript(call, '2kki', control.expiresAt, control.generation, 'official'), context);
  return { evaluate, executed, engine, names: () => executed.map(call => call[0] === '_Navbot_HoldKey' ? keys[call[1][0]] : call[0]) };
}

test('official 2kki movement prepares Bike through the item menu when verified fields allow it', async () => {
  const page = officialPage();
  const send = createEngineSender(page.evaluate, { game: '2kki' });
  const result = await send({ op: 'goto', x: 7, y: 8 }, { generation: 0 });
  assert.deepEqual(page.names(), ['_Navbot_Stop', 'cancel', 'decision', 'decision', '_Navbot_GoTo']);
  assert.deepEqual(page.executed.at(-1), ['_Navbot_GoTo', [7, 8]]);
  assert.equal(page.engine.bike_active, true);
  assert.equal(result.state.bike_active, true);
  assert.equal(send.preparing, false);
});

test('official movement without verified memory skips Bike preparation and moves directly', async () => {
  const page = officialPage({ memory: false });
  const send = createEngineSender(page.evaluate, { game: '2kki' });
  await send({ op: 'goto-map', map: 568, x: 3, y: 75 }, { generation: 0 });
  assert.deepEqual(page.names(), ['_Navbot_Stop', '_Navbot_GoToMap']);
  assert.equal(page.engine.scene, 'Map', 'no menu was opened');
});

test('keyboard input during official Bike preparation cancels it before the original movement', async () => {
  for (const key of ['cancel', 'decision']) {
    const page = officialPage({ interruptOn: key });
    const send = createEngineSender(page.evaluate, { game: '2kki' });
    await assert.rejects(send({ op: 'goto', x: 7, y: 8 }, { generation: 0 }), /^Error: Bike preparation cancelled by keyboard input$/);
    assert.equal(page.executed.some(call => call[0] === '_Navbot_GoTo'), false, key);
    assert.equal(page.executed.at(-1)[0], '_Navbot_Stop', 'held keys are released after the cancellation');
    assert.equal(send.preparing, false);
  }
});

test('an interrupt counter change seen on any preparation read cancels before movement', async () => {
  let interrupts = 0;
  const calls = [];
  const send = createEngineSender(async call => {
    calls.push(call?.[0] || 'state');
    return { ready: true, state: { map_id: 10, user_interrupts: interrupts } };
  }, { game: '2kki', prepare: async input => {
    await input({ op: 'state' });
    ++interrupts;
    await input({ op: 'state' });
    assert.fail('preparation continued after keyboard input');
  } });
  await assert.rejects(send({ op: 'goto', x: 1, y: 2 }), /Bike preparation cancelled by keyboard input/);
  assert.deepEqual(calls, ['_Navbot_Stop', 'state', 'state', 'state']);
  // Engines without counters (the local build) are never cancelled this way.
  const local = createEngineSender(async () => ({ ready: true, state: { map_id: 10 } }), { game: '2kki', prepare: async input => { await input({ op: 'state' }); } });
  assert.equal((await local({ op: 'goto', x: 1, y: 2 })).ready, true);
});

// The real page controller paused for a Bike preparation in map 11, with a
// simulated item menu: each held key acts once on the next engine frame.
// `defer`: like the engine, a menu opens on the frame after its key is read.
// `framesPerCall`: frames the engine runs while each page call is answered.
function preparingPage({ selected = 12, interruptOn = null, defer = false, framesPerCall = 2 } = {}) {
  const { createOfficialController } = require('../src/navbot/official-controller');
  const { createPlanner } = require('../src/navbot/official-path');
  const { effectTable } = require('../src/navbot/effects');
  const switches = {}, items = { 12: 0 };
  const memory = { available: true, scene: 'Map', moving: false, event_running: false, message_active: false, async_pending: false,
    move_route_overwritten: false, player_paused: false, menu_allowed: true, vehicle_type: 0, direction: 2, selected_item_id: 0 };
  const state = { ready: true, map_known: true, map_id: 11, player_x: 0, player_y: 0, frame: 0, time_ms: 1000, position_changed_ms: 0,
    teleport_sequence: 0, held_key: null, hold_remaining: 0, error: null, input_timing: 'logical-frames' };
  const listeners = [], executed = [];
  let controller, opening = null;
  const press = {
    cancel: () => {
      if (defer && memory.scene === 'Map') { opening = 'Menu'; return; }
      memory.scene = memory.scene === 'Item' ? 'Menu' : memory.scene === 'Menu' ? 'Map' : 'Menu';
    },
    decision: () => {
      if (memory.scene === 'Menu') { memory.scene = 'Item'; memory.selected_item_id = selected; }
      else if (memory.scene === 'Item' && memory.selected_item_id === 12) { memory.scene = 'Map'; switches[132] = 1; }
    },
  };
  const input = {
    read: () => ({ ...state, memory: { ...memory } }),
    subscribe: listener => listeners.push(listener),
    stop() { state.held_key = null; state.hold_remaining = 0; },
    hold(key, frames) {
      state.held_key = key; state.hold_remaining = frames;
      if (key === interruptOn) controller.interrupt();
    },
    query: request => ({ items: Object.fromEntries((request.items || []).map(id => [id, items[id] ?? -1])),
      switches: Object.fromEntries((request.switches || []).map(id => [id, switches[id] ?? 0])), skills: {} }),
    navigation: () => null,
  };
  controller = createOfficialController(input, createPlanner());
  const run = controller.execute;
  controller.execute = call => { executed.push(JSON.parse(JSON.stringify(call))); return run(call); };
  controller.configure({ reroute: true, preparation: effectTable('2kki') });
  controller.installMap(11, { width: 4, height: 1, loopHorizontal: false, loopVertical: false, passages: [4, 6, 6, 2] }, [], []);
  const frame = () => {
    ++state.frame; state.time_ms += 17;
    if (opening) { memory.scene = opening; opening = null; }
    if (state.held_key) { press[state.held_key]?.(); state.held_key = null; state.hold_remaining = 0; }
    for (const listener of listeners) listener();
  };
  // Start a route to map 12, whose departure is at (3,0): the arrival check runs first.
  run(['_Navbot_GoToMap', [12, 0, 0], [{ mapId: 11, startX: 3, startY: 0, targetMapId: 12, targetX: 0, targetY: 0, action: false }]]);
  frame();
  const context = { window: { __ynoOfficialController: controller }, document: { title: '2kki', getElementById: () => null },
    location: { hostname: 'ynoproject.net', pathname: '/2kki/' } };
  const evaluate = async (call, control = {}) => {
    const result = vm.runInNewContext(rendererScript(call, '2kki', control.expiresAt, control.generation, 'official'), context);
    for (let i = 0; i < (call ? (typeof framesPerCall === 'function' ? framesPerCall(call) : framesPerCall) : 2); ++i) frame();
    return result;
  };
  const keys = ['up', 'down', 'left', 'right', 'decision', 'cancel', 'shift'];
  return { controller, evaluate, memory, switches, frame,
    names: () => executed.map(([name, args]) => name === '_Navbot_PrepareKey' ? keys[args[1]] : name.replace('_Navbot_Prepare', '')) };
}
const fastPrepare = (send, options) => ensureEffect(send, { ...options, sleep: async () => {} });

test('the preparation runner equips the Bike through menu keys that keep the route, then answers', async () => {
  const page = preparingPage();
  const request = page.controller.pendingPreparation();
  assert.deepEqual(plainObject(request), { id: 1, kind: 'bike', item_id: 12, map: 11, accepted: false, reason: 'Equipping the Bike' });
  const records = [];
  const runner = createPreparationRunner(page.evaluate, { game: '2kki', record: (type, data) => records.push({ type, ...data }), prepare: fastPrepare });
  const job = runner.offer(request);
  assert.equal(runner.active, true);
  assert.equal(runner.offer(request), null, 'one preparation at a time');
  await job;
  assert.equal(runner.active, false);
  assert.deepEqual(page.names(), ['Accept', 'cancel', 'decision', 'decision', 'Done']);
  assert.equal(page.switches[132], 1);
  assert.deepEqual(records.map(entry => [entry.type, entry.outcome]), [['preparation', 'equipped']]);
  page.frame();
  const state = page.controller.read();
  assert.equal(state.status, 'navigating');
  assert.equal(state.active, true);
  assert.equal(state.target_map_id, 12, 'the route survives the preparation');
});

test('the preparation runner ignores malformed requests and answers failures after closing the menu', async () => {
  for (const request of [null, { id: 1, kind: 'bike', item_id: 12, accepted: true }, { id: 1.5, kind: 'bike', item_id: 12, accepted: false },
    { id: 1, kind: 'warp', item_id: 12, accepted: false }, { id: 1, kind: 'effect', item_id: 99, accepted: false }]) {
    assert.equal(createPreparationRunner(async () => assert.fail('unexpected call'), { game: '2kki' }).offer(request), null, JSON.stringify(request));
  }
  assert.equal(createPreparationRunner(async () => assert.fail('unexpected call'), { game: 'yume' })
    .offer({ id: 1, kind: 'bike', item_id: 12, accepted: false }), null);

  const page = preparingPage({ selected: 13 });
  const records = [];
  await createPreparationRunner(page.evaluate, { game: '2kki', record: (type, data) => records.push(data), prepare: fastPrepare })
    .offer(page.controller.pendingPreparation());
  assert.deepEqual(page.names(), ['Accept', 'cancel', 'decision', 'cancel', 'cancel', 'Release', 'Done']);
  assert.equal(page.memory.scene, 'Map', 'the menu opened for the preparation is closed again');
  assert.equal(records[0].outcome, 'failed');
  assert.match(records[0].message, /selected item is not Bike/);
  page.frame();
  assert.equal(page.controller.read().status, 'navigating');
});

test('Stop and real keyboard input end the runner without another key or answer', async () => {
  let generation = 3;
  const page = preparingPage();
  const evaluate = async (call, control) => {
    const result = await page.evaluate(call, control);
    if (call?.[1]?.[1] === 5) ++generation; // Stop arrives right after the menu opens.
    return result;
  };
  const records = [];
  await createPreparationRunner(evaluate, { game: '2kki', generation: () => generation, record: (type, data) => records.push(data), prepare: fastPrepare })
    .offer(page.controller.pendingPreparation());
  assert.deepEqual(page.names(), ['Accept', 'cancel']);
  assert.equal(records[0].outcome, 'cancelled');

  const interrupted = preparingPage({ interruptOn: 'cancel' });
  const later = [];
  await createPreparationRunner(interrupted.evaluate, { game: '2kki', record: (type, data) => later.push(data), prepare: fastPrepare })
    .offer(interrupted.controller.pendingPreparation());
  assert.deepEqual(interrupted.names(), ['Accept', 'cancel']);
  assert.equal(later[0].outcome, 'cancelled');
  assert.equal(interrupted.controller.read().status, 'stopped');
});

test('a new destination first closes the menu a running preparation opened', async () => {
  const page = preparingPage();
  let release = null, runner;
  const evaluate = async (call, control) => {
    const result = await page.evaluate(call, control);
    // The panel submits another destination right after the menu opened.
    if (call?.[0] === '_Navbot_PrepareKey' && call[1][1] === 5 && !release) release = new Promise(resolve => setImmediate(() => resolve(runner.release())));
    return result;
  };
  const records = [];
  // Polls yield to other tasks, as real timers do.
  const tick = () => new Promise(resolve => setImmediate(resolve));
  runner = createPreparationRunner(evaluate, { game: '2kki', record: (type, data) => records.push(data), sleep: tick,
    prepare: (send, options) => ensureEffect(send, { ...options, sleep: tick }) });
  const job = runner.offer(page.controller.pendingPreparation());
  await job;
  await release;
  assert.equal(runner.active, false);
  // A key not yet pressed is dropped first; the open menu is then closed.
  assert.deepEqual(page.names(), ['Accept', 'cancel', 'Release', 'cancel']);
  assert.equal(page.memory.scene, 'Map', 'the new route does not wait behind an open menu');
  assert.equal(records.at(-1).outcome, 'cancelled');
  // The request is left for the new command's Stop; nothing answered it.
  assert.equal(page.controller.read().status, 'preparing');
});

test('a request polled before a newer command never starts', async () => {
  let generation = 2;
  const page = preparingPage();
  const runner = createPreparationRunner(page.evaluate, { game: '2kki', generation: () => generation, prepare: fastPrepare });
  const request = page.controller.pendingPreparation();
  generation = 3;
  await runner.offer(request, 2);
  assert.deepEqual(page.names(), []);
});

test('closing a preparation menu waits for the key in flight: a late menu is closed, an unpressed key dropped', async () => {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  // The menu opens a frame after the runner's Cancel is read, or the key is not pressed yet.
  for (const [frames, expected] of [[1, ['Accept', 'cancel', 'Release', 'cancel']], [0, ['Accept', 'cancel', 'Release']]]) {
    const page = preparingPage({ defer: true,
      framesPerCall: call => call[0] === '_Navbot_PrepareKey' ? frames : call[0] === '_Navbot_PrepareRelease' ? 0 : 2 });
    let release = null, runner;
    const evaluate = async (call, control) => {
      const result = await page.evaluate(call, control);
      if (call?.[0] === '_Navbot_PrepareKey' && !release) release = new Promise(resolve => setImmediate(() => resolve(runner.release())));
      return result;
    };
    runner = createPreparationRunner(evaluate, { game: '2kki', sleep: tick, prepare: (send, options) => ensureEffect(send, { ...options, sleep: tick }) });
    await runner.offer(page.controller.pendingPreparation());
    await release;
    for (let i = 0; i < 4; ++i) page.frame();
    assert.deepEqual(page.names(), expected, `${frames} frame(s) during the key`);
    assert.equal(page.memory.scene, 'Map', `${frames} frame(s) during the key`);
  }
});

test('the pre-route Bike preparation closes its menu for a new destination, also without keyboard telemetry', async () => {
  // The local engine reports no user_interrupts.
  const s = { scene: 'Map', map_id: 10, player_x: 3, player_y: 4, frame: 1, active: false, status: 'stopped', held_keys: [],
    menu_allowed: true, vehicle_type: 0, bike_active: false, bike_item_index: 1, bike_blocked: false, selected_item_id: 0,
    moving: false, event_running: false, message_active: false, async_pending: false, move_route_overwritten: false };
  const keys = [];
  let held = null;
  const evaluate = async call => {
    if (call?.[0] === '_Navbot_HoldKey') { held = ['up', 'down', 'left', 'right', 'decision', 'cancel', 'shift'][call[1][0]]; keys.push(`${held}@${s.scene}`); }
    if (call?.[0] === '_Navbot_Stop') held = null;
    const result = { ready: true, state: { ...s, held_keys: held ? [held] : [] } };
    // One engine frame per call; the cursor never reaches the Bike.
    ++s.frame;
    if (held === 'cancel') s.scene = s.scene === 'Item' ? 'Menu' : s.scene === 'Menu' ? 'Map' : 'Menu';
    else if (held === 'decision' && s.scene === 'Menu') { s.scene = 'Item'; s.selected_item_id = 30; }
    held = null;
    return result;
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const send = createEngineSender(evaluate, { game: '2kki', sleep: tick, prepare: (input, options) => ensureEffect(input, { ...options, sleep: tick }) });
  const first = send({ op: 'goto-map', map: 12, x: 0, y: 0 }, { generation: 0 }).then(() => 'started', error => error.message);
  while (s.scene !== 'Item') await tick();
  await send.release();
  assert.match(await first, /cancelled/i);
  assert.equal(s.scene, 'Map');
  assert.deepEqual(keys.slice(-2), ['cancel@Item', 'cancel@Menu']);
});
