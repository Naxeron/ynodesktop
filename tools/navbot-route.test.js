'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../src/navbot/route-runner');

function engine(states, { afterSleep } = {}) {
  let time = 0, reads = 0;
  const calls = [];
  const send = async command => {
    calls.push({ ...command, read: reads });
    if (command.op !== 'state') return;
    const patch = typeof states === 'function' ? states(reads) : states[Math.min(reads, states.length - 1)];
    const snapshot = { ready: true, state: {
      scene: 'Map', map_id: 359, player_x: 1, player_y: 1, frame: reads * 6,
      active: true, moving: false, event_running: false, message_active: false,
      async_pending: false, move_route_overwritten: false, held_keys: [], ...patch,
    } };
    reads += 1;
    return snapshot;
  };
  return {
    send, calls,
    options: { now: () => time, sleep: async ms => { time += ms; afterSleep?.(); } },
    movement: () => calls.filter(command => ['goto', 'goto-map', 'hold'].includes(command.op)),
  };
}

const walk = { map: 359, walk: [4, 5] };

test('walk finishes at its exact settled tile and releases controls', async () => {
  const game = engine([{}, { player_x: 4, player_y: 5, moving: true },
    { player_x: 4, player_y: 5, active: false }]);
  const progress = [];
  const result = await route.runRoute(game.send, [walk], {
    ...game.options, onStep: (index, step) => progress.push([index, step]),
  });
  assert.deepEqual([result.state.map_id, result.state.player_x, result.state.player_y], [359, 4, 5]);
  assert.deepEqual(progress, [[0, walk]]);
  assert.equal(game.movement().length, 1);
  assert.deepEqual(game.movement()[0], { op: 'goto', x: 4, y: 5, read: 1 });
  assert.equal(game.calls.at(-1).op, 'stop');
});

test('stopping next to a blocked walk target is failure, not arrival', async () => {
  const game = engine([{}, { player_x: 3, player_y: 5, active: false, status: 'blocked', last_error: 'unreachable' }]);
  await assert.rejects(route.runRoute(game.send, [walk], game.options), /unreachable.*359:3,5/);
  assert.equal(game.calls.at(-1).op, 'stop');
});

test('same-map transfer waits for the exact settled landing', async () => {
  const game = engine([{}, { player_x: 18, player_y: 79 },
    { player_x: 18, player_y: 80, event_running: true },
    { player_x: 18, player_y: 80, moving: true },
    { player_x: 18, player_y: 80, async_pending: true },
    { player_x: 18, player_y: 80, active: false }]);
  const result = await route.runRoute(game.send, [
    { map: 359, key: 'decision', expect: [359, 18, 80] },
  ], game.options);
  assert.equal(result.state.player_y, 80);
  assert.equal(result.state.frame, 42);
  assert.equal(game.movement().length, 1);
});

test('scripted intermediate maps are allowed while an event is running', async () => {
  const game = engine([{}, { map_id: 171, event_running: true },
    { map_id: 512, player_x: 87, player_y: 27, event_running: true },
    { map_id: 512, player_x: 87, player_y: 27 }]);
  const result = await route.runRoute(game.send, [
    { map: 359, key: 'decision', expect: [512, 87, 27] },
  ], game.options);
  assert.equal(result.state.map_id, 512);
  assert.equal(game.movement().length, 1);
});

test('unexpected settled map fails promptly and releases controls', async () => {
  const game = engine([{}, { map_id: 171 }]);
  await assert.rejects(route.runRoute(game.send, [
    { map: 359, key: 'decision', expect: [512, 87, 27] },
  ], game.options), /unexpected map 171/);
  assert.equal(game.calls.at(-1).op, 'stop');
});

test('travel permits active intermediate maps and finishes at the exact destination', async () => {
  const game = engine([{}, { map_id: 4 }, { map_id: 10, player_x: 3, player_y: 4, active: false }]);
  const result = await route.runRoute(game.send, [{ map: 359, travel: [10, 3, 4] }], game.options);
  assert.equal(result.state.map_id, 10);
  assert.deepEqual(game.movement(), [{ op: 'goto-map', map: 10, x: 3, y: 4, read: 1 }]);
});

test('travel reports path failure instead of accepting an intermediate landing', async () => {
  const game = engine([{}, { map_id: 4, active: false, last_error: 'path_not_found' }]);
  await assert.rejects(route.runRoute(game.send, [{ map: 359, travel: [10, 3, 4] }], game.options), /path_not_found.*4:1,1/);
  assert.equal(game.calls.at(-1).op, 'stop');
});

test('until repeats bounded inputs only after release and idle movement', async () => {
  const game = engine([{}, { held_keys: ['down'] }, { moving: true },
    { async_pending: true }, {}, { player_y: 3, moving: true }, { player_y: 3 }]);
  await route.runRoute(game.send, [{ map: 359, key: 'down', until: [359, 1, 3] }], game.options);
  assert.deepEqual(game.movement().map(({ op, key, frames, read }) => ({ op, key, frames, read })), [
    { op: 'hold', key: 'down', frames: 1, read: 1 },
    { op: 'hold', key: 'down', frames: 1, read: 5 },
  ]);
});

test('until does not inject more input into a running script, message, or forced route', async () => {
  const game = engine([{}, { event_running: true }, { message_active: true },
    { move_route_overwritten: true }, {}, { player_y: 3 }]);
  await route.runRoute(game.send, [{ map: 359, key: 'down', until: [359, 1, 3] }], game.options);
  assert.deepEqual(game.movement().map(command => command.read), [1, 5]);
});

test('persistent menu steps can finish without waiting for event completion', async () => {
  const game = engine(() => ({ event_running: true }));
  await route.runRoute(game.send, [
    { map: 359, key: 'decision', settle: false },
    { map: 359, key: 'down', settle: false },
  ], game.options);
  assert.deepEqual(game.movement().map(command => command.key), ['decision', 'down']);
  assert.equal(game.calls.at(-1).op, 'stop');
});

test('waitFrames keeps a settled parallel-event landing pending until its engine frame delay passes', async () => {
  const start = 400, waitFrames = 600;
  const game = engine(read => ({
    frame: read === 0 ? start : start + waitFrames + Math.max(0, read - 4),
  }));
  const result = await route.runRoute(game.send, [
    { map: 359, key: 'decision', expect: [359, 1, 1], waitFrames },
  ], game.options);
  assert.ok(result.state.frame > start + waitFrames);
  assert.deepEqual(game.movement(), [{ op: 'hold', key: 'decision', frames: 1, read: 1 }]);
  assert.equal(game.calls.at(-1).op, 'stop');
});

test('waitFrames also delays settle:false menu steps without repeating the key', async () => {
  const start = 400, waitFrames = 120;
  const game = engine(read => ({
    event_running: true,
    frame: read === 0 ? start : start + waitFrames + Math.max(0, read - 4),
  }));
  const result = await route.runRoute(game.send, [
    { map: 359, key: 'decision', waitFrames, settle: false },
  ], game.options);
  assert.ok(result.state.frame > start + waitFrames);
  assert.equal(result.state.event_running, true);
  assert.equal(game.movement().length, 1);
});

test('waitFrames starts after initial and repeated input acknowledgements despite dispatch delay', async () => {
  for (const repeat of [false, true]) {
    let frame = 100, time = 0;
    const inputFrames = [];
    const snapshot = () => ({ ready: true, state: {
      scene: 'Map', map_id: 359, player_x: 1,
      player_y: repeat && inputFrames.length >= 2 ? 3 : 1,
      frame, held_keys: [], active: false,
    } });
    const send = async command => {
      if (command.op === 'stop') frame += 120;
      if (command.op === 'hold') {
        frame += 120;
        inputFrames.push(frame);
      }
      if (command.op === 'state') frame += 6;
      return snapshot();
    };
    const step = repeat
      ? { map: 359, key: 'down', waitFrames: 120, until: [359, 1, 3] }
      : { map: 359, key: 'decision', waitFrames: 120, settle: false };
    const result = await route.runRoute(send, [step], {
      now: () => time, sleep: async ms => { time += ms; },
    });
    assert.equal(inputFrames.length, repeat ? 2 : 1);
    assert.ok(result.state.frame - inputFrames.at(-1) > 120,
      `${repeat ? 'Repeated' : 'Initial'} input delay consumed the requested frame wait`);
  }
});

test('abort releases controls and never issues another route input', async () => {
  const controller = new AbortController();
  const game = engine([{}], { afterSleep: () => controller.abort() });
  await assert.rejects(route.runRoute(game.send, [walk, walk], {
    ...game.options, signal: controller.signal,
  }), /cancelled/i);
  assert.equal(game.movement().length, 1);
  assert.equal(game.calls.at(-1).op, 'stop');
});

test('engine frame stalls are distinguished from route timeouts', async () => {
  const stalled = engine(() => ({ frame: 0 }));
  await assert.rejects(route.runRoute(stalled.send, [
    { map: 359, key: 'down', expect: [359, 4, 5] },
  ], stalled.options), /engine stopped advancing/);
  assert.equal(stalled.calls.at(-1).op, 'stop');
  const advancing = engine([{}]);
  await assert.rejects(route.runRoute(advancing.send, [
    { map: 359, key: 'down', expect: [359, 4, 5], timeoutMs: 300 },
  ], advancing.options), /timed out at 359:1,1/);
  assert.equal(advancing.calls.at(-1).op, 'stop');
});

test('route validation accepts bounded ordinary commands and optional labels', () => {
  assert.doesNotThrow(() => route.validateRoute([
    { map: 1, travel: [9999, 0, 9999] },
    { map: 1, walk: [0, 9999], expect: [9999, 0, 9999], label: 'Boat landing' },
    ...['up', 'down', 'left', 'right', 'decision', 'cancel', 'shift'].map(key => ({
      map: 9999, key, frames: 600, waitFrames: 600, until: [1, 9999, 0], settle: false, timeoutMs: 180000,
    })),
    { map: 1, key: 'up', frames: 1, waitFrames: 1, settle: true, timeoutMs: 1 },
  ]));
  assert.doesNotThrow(() => route.validateRoute(Array.from({ length: 1000 }, () => ({ map: 1, walk: [0, 0] }))));
});

test('route validation rejects malformed or unbounded commands', () => {
  for (const value of [null, {}, [], Array.from({ length: 1001 }, () => walk)]) {
    assert.throws(() => route.validateRoute(value));
  }
  const invalid = [
    null, [], {}, { map: 1 }, { map: 1, walk: [0, 0], key: 'up' },
    { map: 1, walk: [0, 0], travel: [1, 0, 0] },
    { map: 1, travel: [1, 0, 0], key: 'up' },
    { map: 1, walk: [0, 0], key: '' },
    { map: 1, key: 'teleport' }, { map: 1, key: null },
    ...[0, 10000, 1.5, '1'].map(map => ({ map, key: 'up' })),
    ...[null, [0], [0, 0, 0], [-1, 0], [0, 10000], [0.5, 0], ['0', 0]].map(walk => ({ map: 1, walk })),
    ...[null, [1, 0], [1, 0, 0, 0], [0, 0, 0], [10000, 0, 0], [1, -1, 0], [1, 0, 10000], ['1', 0, 0]].map(expect => ({ map: 1, key: 'up', expect })),
    { map: 1, walk: [0, 0], until: [1, 0, 0] },
    { map: 1, travel: [1, 0, 0], until: [1, 0, 0] },
    ...[null, [1, 0], [0, 0, 0], [1, 10000, 0], ['1', 0, 0]].map(travel => ({ map: 1, travel })),
    { map: 1, key: 'up', until: [1, -1, 0] },
    ...[0, 601, 1.5, '1', null].map(frames => ({ map: 1, key: 'up', frames })),
    ...[0, 601, 1.5, '1', null].map(waitFrames => ({ map: 1, key: 'up', waitFrames })),
    ...[0, 1, 'false', null].map(settle => ({ map: 1, key: 'up', settle })),
    ...[0, 180001, 1.5, '100', null].map(timeoutMs => ({ map: 1, key: 'up', timeoutMs })),
  ];
  for (const step of invalid) assert.throws(() => route.validateRoute([step]), `Accepted ${JSON.stringify(step)}`);
});


test('packaged Planetarium recipes validate and keep consecutive map expectations consistent', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = path.join(__dirname, '../src/navbot/routes');
  const names = fs.readdirSync(directory).filter(name => /^2kki-planetarium(?:-shortcut)?\.json$/.test(name));
  assert.ok(names.includes('2kki-planetarium.json'), 'The supported route must be packaged');
  const normal = JSON.parse(fs.readFileSync(path.join(directory, '2kki-planetarium.json'), 'utf8'));
  for (const name of names) {
    let steps = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (name.endsWith('-shortcut.json')) {
      const join = normal.findIndex(step => step.map === 524 && step.walk?.[0] === 6 && step.walk[1] === 47);
      assert.ok(join >= 0, 'The shortcut must join the ordinary boat route');
      steps = [...steps, ...normal.slice(join)];
    }
    route.validateRoute(steps);
    for (let index = 1; index < steps.length; ++index) {
      const previous = steps[index - 1];
      const landing = previous.expect || previous.until || previous.travel;
      assert.equal(steps[index].map, landing?.[0] ?? previous.map,
        `${name}: step ${index + 1} starts on a different map from the preceding landing`);
    }
    const final = steps.at(-1);
    const destination = final.expect || final.until || final.travel || [final.map, ...final.walk];
    assert.equal(destination[0], 568, `${name} must finish at the exact Planetarium map`);
  }
});
