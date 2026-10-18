'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installOfficialInput } = require('../src/navbot/official-input');

// `memory` is the optional engine-state reader passed as installOfficialInput's second argument.
function page(browser = {}, memory = null) {
  const events = [], callbacks = [], handlers = new Map();
  let coordinates = [5, 8], reads = 0, now = 0;
  const canvas = { dispatchEvent: event => events.push([event.type, event.key, event.code, event.keyCode]) };
  // A real global is needed: contextified proxies hide non-configurable function bindings.
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY);
  Object.assign(context, {
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    document: { getElementById: id => id === 'canvas' ? canvas : null },
    addEventListener: (name, fn) => handlers.set(name, fn),
    btoa: input => Buffer.from(input, 'binary').toString('base64'),
    performance: { now: () => now },
    callbacks,
    moduleValue: { api: { getPlayerCoords() { ++reads; return coordinates; } } },
    navbotMemory: memory,
    ...browser,
  });
  context.window = context;
  const input = vm.runInContext(`(${installOfficialInput})('2kki', navbotMemory)`, context);
  // Real page functions are declarations, loaded after our document-start injection.
  vm.runInContext(`
    function onPlayerTeleported(...args) { callbacks.push(['teleport', this, args]); return 'original teleport'; }
    function onRoomSwitch(...args) { callbacks.push(['room', this, args]); return 'original room'; }
    function onLoadMap(...args) { callbacks.push(['load', this, args]); return 'original load'; }
    var createEasyRpgPlayer = function(options) { window.options = options; return Promise.resolve(moduleValue); };
  `, context);
  return {
    input, context, events, handlers, callbacks,
    setCoords(value) { coordinates = value; },
    advance(ms) { now += ms; },
    get reads() { return reads; },
    boot: options => context.createEasyRpgPlayer(options || {}),
    tick(ms = 17) {
      if (context.options.preMainLoop() === false) return;
      now += ms;
      context.options.postMainLoop();
    },
  };
}

const UNAVAILABLE = Object.freeze({ available: false, error: 'Engine memory is not available yet' });
const MISMATCH = Object.freeze({ available: false, error: 'Engine memory layout does not match getPlayerCoords()' });

// A stand-in for official-memory.js. Each change makes a new state object, so the
// input keeps its previous sample until the next main-loop observation or read().
function fakeMemory(initial = {}) {
  const calls = { sample: [], query: [], navigation: [], reset: 0 };
  let state = {
    available: true, error: null, scene: 'Map', frame_count: 100, map_id: 10, player_x: 5, player_y: 8,
    direction: 2, moving: false, event_running: false, message_active: false, async_pending: false,
    ...initial,
  };
  let override = null;
  const switches = { 1: true }, navigation = { width: 20, height: 15, events: [], revision: 1 };
  return {
    calls, switches, navigation,
    get state() { return state; },
    set(patch) { state = { ...state, ...patch }; },
    override(fn) { override = fn; },
    memory: {
      sample(module, coords, now) {
        calls.sample.push({ module, coords: Array.isArray(coords) ? Array.from(coords) : coords, now });
        return override ? override(coords) : state;
      },
      query(module, request) { calls.query.push({ module, request }); return { switches }; },
      navigation(module) { calls.navigation.push({ module }); return navigation; },
      reset() { ++calls.reset; },
    },
  };
}

// One engine iteration in which the engine counted `frames` logical frames.
function step(p, mem, frames = 1, patch = {}, ms = 17) {
  mem.set({ frame_count: mem.state.frame_count + frames, ...patch });
  p.tick(ms);
}

const eventTypes = p => p.events.map(event => event[0]);

function frameScheduler() {
  let nextNative = 1000, nextTimer = 2000;
  const native = new Map(), timers = new Map();
  return {
    native, timers,
    browser: {
      requestAnimationFrame(callback) { const id = ++nextNative; native.set(id, callback); return id; },
      cancelAnimationFrame(id) { native.delete(id); },
      setTimeout(callback, delay) { assert.equal(delay, 20); const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
      performance: { now: () => 1234.5 },
    },
  };
}

test('a native compositor frame wins once and clears its fallback timer', () => {
  const clock = frameScheduler(), p = page(clock.browser), observed = [];
  const original = p.context.requestAnimationFrame;
  const id = p.context.requestAnimationFrame(function(timestamp) { assert.equal(this, p.context); observed.push(timestamp); });
  assert.equal(typeof id, 'number');
  assert.equal(clock.native.size, 1);
  assert.equal(clock.timers.size, 1);
  const nativeCallback = [...clock.native.values()][0], timerCallback = [...clock.timers.values()][0];
  nativeCallback(456.7);
  timerCallback();
  nativeCallback(999);
  assert.deepEqual(observed, [456.7]);
  assert.equal(clock.native.size, 0);
  assert.equal(clock.timers.size, 0);
  vm.runInContext(`(${installOfficialInput})('2kki')`, p.context);
  assert.equal(p.context.requestAnimationFrame, original);
});

test('an occluded compositor uses its timer once and cancels the native callback', () => {
  const clock = frameScheduler(), p = page(clock.browser), observed = [];
  p.context.requestAnimationFrame(timestamp => observed.push(timestamp));
  const nativeCallback = [...clock.native.values()][0], timerCallback = [...clock.timers.values()][0];
  timerCallback();
  nativeCallback(456.7);
  timerCallback();
  assert.deepEqual(observed, [1234.5]);
  assert.equal(clock.native.size, 0);
  assert.equal(clock.timers.size, 0);
});

test('frame cancellation and pagehide cancel both requests without touching another request', () => {
  const clock = frameScheduler(), p = page(clock.browser), observed = [];
  const cancelled = p.context.requestAnimationFrame(() => observed.push('cancelled'));
  const cancelledNative = [...clock.native.values()][0], cancelledTimer = [...clock.timers.values()][0];
  p.context.requestAnimationFrame(() => observed.push('remaining'));
  p.context.cancelAnimationFrame(String(cancelled));
  cancelledNative(1); cancelledTimer();
  assert.deepEqual(observed, []);
  assert.equal(clock.native.size, 1);
  assert.equal(clock.timers.size, 1);
  const remainingNative = [...clock.native.values()][0], remainingTimer = [...clock.timers.values()][0];
  p.handlers.get('pagehide')();
  remainingNative(2); remainingTimer();
  assert.deepEqual(observed, []);
  assert.equal(clock.native.size, 0);
  assert.equal(clock.timers.size, 0);
  p.context.cancelAnimationFrame(cancelled);
  assert.equal(clock.timers.size, 0);
});

test('a frame callback can request its successor without an extra timer loop', () => {
  const clock = frameScheduler(), p = page(clock.browser);
  assert.equal(clock.timers.size, 0);
  let calls = 0;
  p.context.requestAnimationFrame(() => {
    ++calls;
    p.context.requestAnimationFrame(() => { ++calls; });
  });
  [...clock.timers.values()][0]();
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 1);
  [...clock.native.values()][0](20);
  assert.equal(calls, 2);
  assert.equal(clock.native.size, 0);
  assert.equal(clock.timers.size, 0);
});

test('document-start hooks preserve factory, callback receivers/results, and do not read coordinates before a map', async () => {
  const p = page();
  assert.equal(p.input.read().ready, false);
  assert.throws(() => p.input.hold('decision', 1), /not ready/);
  assert.equal(await p.boot(), p.context.moduleValue);
  assert.equal(p.input.read().ready, true);
  assert.equal(p.input.read().map_known, false);
  assert.equal(p.input.read().player_x, null);
  assert.equal(Object.getOwnPropertyDescriptor(p.context, 'onPlayerTeleported').configurable, false);
  assert.equal(Object.getOwnPropertyDescriptor(p.context, 'onRoomSwitch').configurable, false);
  p.tick();
  assert.equal(p.reads, 0);
  const receiver = {};
  assert.equal(p.context.onPlayerTeleported.call(receiver, 10, 5, 8, 'extra'), 'original teleport');
  assert.equal(p.callbacks[0][1], receiver);
  assert.equal(p.callbacks[0][2][3], 'extra');
  const state = p.input.read();
  assert.equal(state.map_id, 10);
  assert.equal(state.player_x, 5);
  assert.equal(state.player_y, 8);
  assert.equal(state.teleport_sequence, 1);
  assert.equal(state.input_timing, 'elapsed-main-loop');
  assert.equal(vm.runInContext(`(${installOfficialInput})('2kki')`, p.context), p.input);
});

test('non-configurable read-only callbacks disable automation without preventing official engine startup', async () => {
  const p = page();
  vm.runInContext(`Object.defineProperty(window, 'onPlayerTeleported', { writable: false });`, p.context);
  assert.equal(await p.boot(), p.context.moduleValue);
  const state = p.input.read();
  assert.equal(state.ready, false);
  assert.match(state.error, /cannot install onPlayerTeleported.*read-only.*Reload/);
  assert.throws(() => p.input.hold('up', 1), /not ready/);
  assert.equal(p.context.onPlayerTeleported(10, 5, 8), 'original teleport');
});

test('modularized engine initialization copies input hooks before the page receives its module', async () => {
  const p = page();
  // This ordering mirrors official init.js and Emscripten MainLoop.init/runIter.
  await vm.runInContext(`
    var createEasyRpgPlayer = (() => async function(moduleArg = {}) {
      var Module = moduleArg;
      Object.assign(Module, { preRun: [], postRun: [] });
      const MainLoop = {
        pre: [], post: [],
        init() {
          Module.preMainLoop && this.pre.push(Module.preMainLoop);
          Module.postMainLoop && this.post.push(Module.postMainLoop);
        },
        runIter() {
          for (const pre of this.pre) if (pre() === false) return;
          for (const post of this.post) post();
        },
      };
      MainLoop.init();
      Module.api = moduleValue.api;
      window.runOfficialLoop = () => MainLoop.runIter();
      return Module;
    })();
    let easyrpgPlayer = { initialized: false, game: '2kki' };
    createEasyRpgPlayer(easyrpgPlayer).then(Module => {
      easyrpgPlayer = Module;
      easyrpgPlayer.initialized = true;
    });
  `, p.context);
  assert.equal(p.input.read().ready, true);
  assert.equal(vm.runInContext('easyrpgPlayer.initialized', p.context), true);
  p.input.hold('decision', 1);
  p.context.runOfficialLoop();
  assert.deepEqual(p.events.map(event => event[0]), ['keydown']);
  p.advance(17);
  p.context.runOfficialLoop();
  assert.deepEqual(p.events.map(event => event[0]), ['keydown', 'keyup']);
  assert.equal(p.input.read().frame, 2);
});

test('ordinary key holds use elapsed 60 Hz durations and can boot before the first map', async () => {
  const p = page();
  await p.boot();
  p.input.hold('decision', 2);
  assert.equal(p.events.length, 0);
  p.tick();
  assert.deepEqual(p.events, [['keydown', 'Enter', 'Enter', 13]]);
  assert.equal(p.input.read().hold_remaining, 1);
  p.tick();
  assert.deepEqual(p.events, [['keydown', 'Enter', 'Enter', 13], ['keyup', 'Enter', 'Enter', 13]]);
  assert.equal(p.input.read().held_key, null);
  assert.equal(p.reads, 0);
  assert.equal(p.input.read().frame, 2);
  for (const frames of [0, 601, 1.1, '1']) assert.throws(() => p.input.hold('up', frames), /frames/);
  assert.throws(() => p.input.hold('constructor', 1), /key/);
  assert.throws(() => p.input.hold('a', 1), /key/);
});

test('pre-main-loop false is preserved and hooks retain their original return values', async () => {
  const p = page();
  const receiver = {}, calls = [];
  let skip = true;
  await p.boot({
    preMainLoop(...args) { calls.push(['pre', this, args]); return skip ? false : 17; },
    postMainLoop(...args) { calls.push(['post', this, args]); return 23; },
  });
  p.input.hold('left', 1);
  assert.equal(p.context.options.preMainLoop.call(receiver, 'a'), false);
  assert.equal(p.events.length, 0);
  assert.equal(p.input.read().frame, 0);
  skip = false;
  assert.equal(p.context.options.preMainLoop.call(receiver, 'b'), 17);
  p.advance(17);
  assert.equal(p.context.options.postMainLoop.call(receiver, 'c'), 23);
  assert.equal(calls[0][1], receiver);
  assert.deepEqual(calls.map(call => call[2]), [['a'], ['b'], ['c']]);
  assert.deepEqual(p.events.map(event => event[0]), ['keydown', 'keyup']);
});

test('rapid main-loop callbacks cannot shorten a hold, and delayed dispatch starts its own duration', async () => {
  const p = page();
  await p.boot();
  p.input.hold('decision', 3);
  p.advance(1000);
  for (let i = 0; i < 16; ++i) p.tick(3);
  assert.equal(p.input.read().frame, 16);
  assert.equal(p.input.read().held_key, 'decision');
  assert.equal(p.input.read().hold_remaining, 1);
  assert.deepEqual(p.events.map(event => event[0]), ['keydown']);
  p.tick(2);
  assert.equal(p.input.read().held_key, null);
  assert.deepEqual(p.events.map(event => event[0]), ['keydown', 'keyup']);
});

test('same-map teleport, Stop, replacement input, and pagehide release owned keys; blur does not', async () => {
  const p = page();
  await p.boot();
  p.context.onPlayerTeleported(10, 5, 8);
  p.input.hold('up', 600);
  p.tick();
  p.context.onPlayerTeleported(10, 7, 8);
  assert.equal(p.input.read().teleport_sequence, 2);
  assert.equal(p.input.read().held_key, null);
  p.input.hold('left', 600);
  p.tick();
  p.input.hold('right', 600);
  p.tick();
  p.input.stop();
  p.input.hold('down', 600);
  p.tick();
  p.handlers.get('pagehide')();
  assert.equal(p.handlers.has('blur'), false);
  assert.deepEqual(p.events.map(event => event.slice(0, 2)), [
    ['keydown', 'ArrowUp'], ['keyup', 'ArrowUp'], ['keydown', 'ArrowLeft'], ['keyup', 'ArrowLeft'],
    ['keydown', 'ArrowRight'], ['keyup', 'ArrowRight'], ['keydown', 'ArrowDown'], ['keyup', 'ArrowDown'],
  ]);
});

test('frame subscribers observe fresh coordinates and can schedule the following input', async () => {
  const p = page();
  await p.boot();
  p.context.onPlayerTeleported(10, 5, 8);
  let observed;
  const unsubscribe = p.input.subscribe(state => { observed = state; p.input.hold('down', 1); });
  p.setCoords([6, 8]);
  p.tick();
  assert.equal(observed.player_x, 6);
  assert.equal(observed.position_changed_frame, 1);
  assert.equal(p.input.read().hold_remaining, 1);
  assert.equal(p.events.length, 0);
  unsubscribe();
  p.tick();
  assert.equal(p.input.read().held_key, null);
  p.setCoords([-1, -1]);
  p.tick();
  assert.equal(p.input.read().player_x, null);
  assert.equal(p.input.read().player_y, null);
});

test('listener and coordinate failures release held keys without breaking the engine loop', async () => {
  const p = page();
  await p.boot();
  p.input.hold('up', 600);
  p.input.subscribe(() => { throw new Error('controller failed'); });
  assert.doesNotThrow(() => p.tick());
  assert.equal(p.input.read().error, 'controller failed');
  assert.equal(p.input.read().held_key, null);
  p.context.onPlayerTeleported(10, 5, 8);
  p.input.hold('right', 600);
  p.context.options.preMainLoop();
  p.context.moduleValue.api.getPlayerCoords = () => { throw new Error('coordinate failed'); };
  assert.doesNotThrow(() => p.context.options.postMainLoop());
  assert.equal(p.input.read().error, 'coordinate failed');
  assert.deepEqual(p.events.map(event => event[0]), ['keydown', 'keyup', 'keydown', 'keyup']);
});

test('original hook errors propagate after releasing input, and failed factories report unavailable', async () => {
  for (const hook of ['preMainLoop', 'postMainLoop']) {
    const p = page();
    const failure = new Error(`${hook} failed`);
    let shouldThrow = false;
    await p.boot({ [hook]() { if (shouldThrow) throw failure; } });
    p.input.hold('up', 600);
    p.tick();
    shouldThrow = true;
    assert.throws(() => p.tick(), error => error === failure);
    assert.equal(p.input.read().held_key, null);
    assert.deepEqual(p.events.map(event => event[0]), ['keydown', 'keyup']);
  }
  const p = page();
  const failure = new Error('factory failed');
  p.context.createEasyRpgPlayer = () => Promise.reject(failure);
  await assert.rejects(p.boot(), error => error === failure);
  assert.equal(p.input.read().ready, false);
  assert.equal(p.input.read().error, failure.message);
});

test('room acknowledgments retain map observations without claiming a verified server map', async () => {
  const p = page();
  await p.boot();
  assert.equal(p.context.onRoomSwitch(), 'original room');
  assert.equal(p.input.read().map_at_ack, null);
  p.context.onPlayerTeleported(10, 5, 8);
  assert.equal(p.context.onRoomSwitch(), 'original room');
  p.context.onPlayerTeleported(11, 2, 3);
  assert.equal(p.input.read().room_ack_sequence, 2);
  assert.equal(p.input.read().map_at_ack, 10);
  assert.equal(p.input.read().room_synced_id, undefined);
});

test('asset reads use only loaded database/current-map bytes and forbid save files and traversal', async () => {
  const p = page();
  const reads = [];
  const bytes = Uint8Array.from({ length: 20000 }, (_, i) => i % 256);
  const dirs = {
    '/': ['.', '..', 'EasyRPG'], '/EasyRPG': ['.', '..', '2KKI'],
    '/EasyRPG/2KKI': ['.', '..', 'map0010.LMU', 'rpg_rt.LDB', 'Save'],
  };
  p.context.moduleValue.FS = {
    readdir: directory => dirs[directory],
    stat: () => ({ size: bytes.length }),
    readFile(filename) { reads.push(filename); return bytes; },
  };
  await p.boot();
  assert.throws(() => p.input.readAsset('Map0010.lmu'), /Only/);
  p.context.onPlayerTeleported(10, 5, 8);
  assert.deepEqual(Buffer.from(p.input.readAsset('Map0010.lmu'), 'base64'), Buffer.from(bytes));
  assert.deepEqual(Buffer.from(p.input.readAsset('RPG_RT.ldb'), 'base64'), Buffer.from(bytes));
  assert.deepEqual(reads, ['/EasyRPG/2KKI/map0010.LMU', '/EasyRPG/2KKI/rpg_rt.LDB']);
  for (const name of ['Map0011.lmu', '../Map0010.lmu', 'Save/Save01.lsd', 'Save01.lsd', null]) {
    assert.throws(() => p.input.readAsset(name), /Only/);
  }
  p.context.onPlayerTeleported(11, 1, 2);
  assert.throws(() => p.input.readAsset('Map0010.lmu'), /Only/);
  assert.throws(() => p.input.readAsset('Map0011.lmu'), /not loaded/);
  p.context.moduleValue.FS.stat = () => ({ size: 64 * 1024 * 1024 + 1 });
  assert.throws(() => p.input.readAsset('RPG_RT.ldb'), /too large/);
});

test('teleport callback landing survives script movement before the next engine-loop observation', async () => {
  const p = page();
  await p.boot();
  p.context.onPlayerTeleported(10, 5, 8);
  p.setCoords([6, 8]);
  let observed;
  p.input.subscribe(state => { observed = state; });
  p.tick();
  assert.equal(observed.teleport_sequence, 1);
  assert.deepEqual([observed.teleport_map_id, observed.teleport_x, observed.teleport_y], [10, 5, 8]);
  assert.deepEqual([observed.player_x, observed.player_y], [6, 8]);
  p.setCoords([7, 8]);
  p.tick();
  assert.deepEqual([observed.teleport_x, observed.teleport_y], [5, 8]);
  assert.deepEqual([observed.player_x, observed.player_y], [7, 8]);
  p.context.onPlayerTeleported(10, 9, 8);
  p.setCoords([10, 8]);
  assert.equal(p.input.read().teleport_sequence, 2);
  assert.deepEqual([p.input.read().teleport_x, p.input.read().teleport_y], [9, 8]);
});

test('invalid teleport callbacks replace stale landing data even when live coordinates remain valid', async () => {
  const p = page();
  await p.boot();
  p.context.onPlayerTeleported(10, 5, 8);
  p.context.onPlayerTeleported(10, null, NaN);
  const state = p.input.read();
  assert.equal(state.teleport_sequence, 2);
  assert.deepEqual([state.teleport_map_id, state.teleport_x, state.teleport_y], [10, null, null]);
  assert.deepEqual([state.player_x, state.player_y], [5, 8]);
  p.context.onPlayerTeleported(0, -1, -1);
  assert.deepEqual([p.input.read().teleport_map_id, p.input.read().teleport_x, p.input.read().teleport_y], [null, null, null]);
  await p.boot();
  assert.deepEqual([p.input.read().teleport_map_id, p.input.read().teleport_x, p.input.read().teleport_y], [null, null, null]);
});

test('memory frame_count deltas become logical frames; a replaced counter counts as one frame', async () => {
  const mem = fakeMemory({ frame_count: 100 });
  const p = page({}, mem.memory);
  await p.boot();
  let state = p.input.read();
  assert.equal(state.input_timing, 'logical-frames');
  assert.equal(state.frame, 0);
  assert.equal(state.loop_frame, 0);
  let observed;
  p.input.subscribe(next => { observed = next; });
  step(p, mem, 3);
  assert.equal(observed.frame, 3);
  assert.equal(observed.input_timing, 'logical-frames');
  assert.equal(p.input.read().frame, 3);
  assert.equal(p.input.read().loop_frame, 1);
  // Repeated samples of the same counter add nothing.
  for (let i = 0; i < 3; ++i) p.input.read();
  step(p, mem, 0);
  assert.deepEqual([p.input.read().frame, p.input.read().loop_frame], [3, 2]);
  // New Game/Load replace the counter inside a counted scene update: one frame.
  mem.set({ frame_count: 40 });
  p.tick();
  assert.equal(p.input.read().frame, 4);
  step(p, mem, 1);
  assert.equal(p.input.read().frame, 5);
  // Larger jumps than one callback can run are replacements too.
  step(p, mem, 601);
  assert.equal(p.input.read().frame, 6);
  step(p, mem, 60);
  assert.equal(p.input.read().frame, 66);
  // A non-integer counter keeps the previous base and logical timing.
  mem.set({ frame_count: null });
  p.tick();
  assert.deepEqual([p.input.read().frame, p.input.read().input_timing], [66, 'logical-frames']);
  mem.set({ frame_count: 1245 });
  p.tick();
  assert.equal(p.input.read().frame, 67);
  assert.equal(p.input.read().loop_frame, 8);
});

test('logical holds release after exactly N logical frames however long or short each iteration is', async () => {
  for (const ms of [1, 5000]) {
    const mem = fakeMemory();
    const p = page({}, mem.memory);
    await p.boot();
    p.input.read();
    step(p, mem, 1, {}, ms);
    p.input.hold('decision', 4);
    assert.equal(p.input.read().hold_remaining, 4);
    for (let i = 1; i <= 3; ++i) {
      step(p, mem, 1, {}, ms);
      assert.deepEqual(eventTypes(p), ['keydown'], `ms=${ms} frame ${i}`);
      assert.equal(p.input.read().held_key, 'decision');
      assert.equal(p.input.read().hold_remaining, 4 - i);
    }
    step(p, mem, 1, {}, ms);
    assert.deepEqual(eventTypes(p), ['keydown', 'keyup'], `ms=${ms}`);
    assert.equal(p.input.read().held_key, null);
    assert.equal(p.input.read().hold_remaining, 0);
  }
});

test('frozen logical frames keep a key held until the generous elapsed safety bound', async () => {
  const mem = fakeMemory();
  const p = page({}, mem.memory);
  await p.boot();
  p.input.read();
  step(p, mem, 1);
  p.input.hold('up', 2);
  step(p, mem, 1);
  assert.deepEqual(eventTypes(p), ['keydown']);
  // A transition stops Game_System::frame_count while main-loop iterations continue.
  for (let i = 0; i < 100; ++i) step(p, mem, 0, {}, 100);
  p.advance(19900);
  step(p, mem, 0);
  assert.equal(p.input.read().held_key, 'up');
  assert.equal(p.input.read().hold_remaining, 1);
  assert.deepEqual(eventTypes(p), ['keydown']);
  step(p, mem, 0, {}, 200);
  assert.equal(p.input.read().held_key, null);
  assert.deepEqual(eventTypes(p), ['keydown', 'keyup']);
});

test('unavailable memory or counters fall back to elapsed main-loop timing without deferring input', async () => {
  const mem = fakeMemory();
  mem.override(() => UNAVAILABLE);
  const p = page({}, mem.memory);
  await p.boot();
  let state = p.input.read();
  assert.equal(state.input_timing, 'elapsed-main-loop');
  assert.equal(state.map_known, false);
  assert.deepEqual({ ...state.memory }, { ...UNAVAILABLE });
  p.input.hold('decision', 2);
  p.tick();
  assert.deepEqual(eventTypes(p), ['keydown']);
  assert.equal(p.input.read().hold_remaining, 1);
  p.tick();
  assert.deepEqual(eventTypes(p), ['keydown', 'keyup']);
  state = p.input.read();
  assert.equal(state.frame, 2);
  assert.equal(state.frame, state.loop_frame);
  assert.equal(p.reads, 0);
  assert.ok(mem.calls.sample.length > 0 && mem.calls.sample.every(call => call.coords === null));

  // Available memory without an integer counter still provides map identity, not frame timing.
  const counterless = fakeMemory({ frame_count: null });
  const q = page({}, counterless.memory);
  await q.boot();
  state = q.input.read();
  assert.equal(state.input_timing, 'elapsed-main-loop');
  assert.deepEqual([state.map_known, state.map_id], [true, 10]);
  q.input.hold('left', 1);
  q.tick();
  assert.deepEqual(eventTypes(q), ['keydown', 'keyup']);
});

test('a new press waits while async work is pending and for a logical frame after it ends', async () => {
  const mem = fakeMemory({ async_pending: true });
  const p = page({}, mem.memory);
  await p.boot();
  p.input.read();
  p.input.hold('decision', 2);
  step(p, mem, 1, { async_pending: true });
  for (let i = 0; i < 10; ++i) step(p, mem, 0, { async_pending: true });
  step(p, mem, 1, { async_pending: true });
  assert.deepEqual(p.events, []);
  // The iteration that finishes the async work still started while it was pending.
  step(p, mem, 1, { async_pending: false });
  assert.deepEqual(p.events, []);
  assert.equal(p.input.read().held_key, 'decision');
  assert.equal(p.input.read().hold_remaining, 2);
  step(p, mem, 1);
  assert.deepEqual(eventTypes(p), ['keydown']);
  assert.equal(p.input.read().hold_remaining, 1);
  step(p, mem, 1);
  assert.deepEqual(eventTypes(p), ['keydown', 'keyup']);
});

test('a scene change defers a pending press until the new scene has advanced a logical frame', async () => {
  const mem = fakeMemory({ scene: 'Title', map_id: 0 });
  const p = page({}, mem.memory);
  await p.boot();
  p.input.read();
  // Boot is itself a scene change; one updated Title frame makes input ready.
  p.input.hold('decision', 1);
  step(p, mem, 0);
  assert.deepEqual(p.events, []);
  step(p, mem, 1);
  assert.deepEqual(p.events, []);
  step(p, mem, 1);
  assert.deepEqual(eventTypes(p), ['keydown', 'keyup']);
  step(p, mem, 1, { scene: 'Map', map_id: 10 });
  p.input.hold('up', 1);
  step(p, mem, 0);
  step(p, mem, 0);
  step(p, mem, 1);
  assert.equal(p.events.length, 2);
  assert.equal(p.input.read().held_key, 'up');
  assert.equal(p.input.read().hold_remaining, 1);
  step(p, mem, 1);
  assert.deepEqual(p.events.slice(2).map(event => event.slice(0, 2)), [['keydown', 'ArrowUp'], ['keyup', 'ArrowUp']]);
});

test('map identity comes from memory and coordinates validate samples once memory finds the player', async () => {
  // Returning to the title keeps the player's stale map ID in memory.
  const mem = fakeMemory({ scene: 'Title', map_id: 10 });
  const p = page({}, mem.memory);
  await p.boot();
  let state = p.input.read();
  assert.deepEqual([state.map_known, state.map_id], [false, null]);
  for (let i = 0; i < 3; ++i) step(p, mem, 1);
  for (const scene of ['Null', 'Logo', 'Language', 'Gameover', 'GameBrowser']) {
    mem.set({ scene });
    p.tick();
    assert.equal(p.input.read().map_known, false, scene);
  }
  for (const map_id of [0, -1, 10000, 10.5, null, '10']) {
    mem.set({ scene: 'Map', map_id });
    p.tick();
    assert.equal(p.input.read().map_known, false, String(map_id));
  }
  // Off-map samples (Title cursors drive boot input) are checked against getPlayerCoords().
  assert.ok(p.reads > 0);
  assert.ok(mem.calls.sample.some(call => Array.isArray(call.coords)));
  assert.ok(mem.calls.sample.every(call => call.module === p.context.moduleValue));

  mem.set({ scene: 'Map', map_id: 10 });
  p.advance(50);
  state = p.input.read();
  assert.deepEqual([state.map_known, state.map_id, state.player_x, state.player_y], [true, 10, 5, 8]);
  assert.deepEqual(mem.calls.sample.at(-1).coords, [5, 8]);
  assert.equal(mem.calls.sample.at(-1).now, state.time_ms);
  // Menus keep the map loaded.
  mem.set({ scene: 'Menu' });
  assert.deepEqual([p.input.read().map_known, p.input.read().map_id], [true, 10]);
  mem.set({ scene: 'Map', map_id: 11 });
  p.advance(50);
  state = p.input.read();
  assert.equal(state.map_id, 11);
  assert.equal(state.position_changed_ms, state.time_ms);
  mem.set({ scene: 'Title' });
  assert.equal(p.input.read().map_known, false);
  // Without a live player object found by memory, coordinates are not read.
  mem.override(() => UNAVAILABLE);
  p.input.read();
  const reads = p.reads;
  p.tick();
  p.input.read();
  assert.equal(p.reads, reads);
});

test('a coordinate validation failure keeps the checked map and falls back to coordinates and callbacks', async () => {
  const mem = fakeMemory();
  const p = page({}, mem.memory);
  await p.boot();
  assert.deepEqual([p.input.read().map_known, p.input.read().map_id], [true, 10]);
  mem.override(coords => Array.isArray(coords) ? MISMATCH : mem.state);
  const state = p.input.read();
  assert.deepEqual([state.map_known, state.map_id], [true, 10]);
  assert.equal(state.input_timing, 'elapsed-main-loop');
  assert.match(state.memory.error, /does not match getPlayerCoords/);
  const reads = p.reads;
  p.tick();
  assert.equal(p.input.read().map_known, true);
  assert.ok(p.reads > reads, 'coordinates are still read');
  // Map changes then come from the page callbacks again.
  assert.equal(p.context.onLoadMap('Map0012.lmu'), 'original load');
  assert.equal(p.input.read().map_id, 12);

  // Without usable memory, the teleport callback remains the map source.
  const broken = fakeMemory();
  broken.override(() => MISMATCH);
  const q = page({}, broken.memory);
  await q.boot();
  q.context.onPlayerTeleported(10, 5, 8);
  q.tick();
  assert.deepEqual([q.input.read().map_known, q.input.read().map_id], [true, 10]);
  assert.ok(q.reads > 0);
});

test('a teleport-reported map survives a later coordinate validation failure', async () => {
  const mem = fakeMemory();
  const p = page({}, mem.memory);
  await p.boot();
  assert.equal(p.input.read().map_id, 10);
  // The callback, not memory, now reports the map; memory then stops validating.
  p.context.onPlayerTeleported(12, 3, 4);
  p.setCoords([3, 4]);
  mem.override(() => MISMATCH);
  const state = p.input.read();
  assert.deepEqual([state.map_known, state.map_id, state.player_x, state.player_y], [true, 12, 3, 4]);
});

test('a new engine forgets the previous engine memory-derived map origin', async () => {
  const mem = fakeMemory();
  const p = page({}, mem.memory);
  await p.boot();
  assert.equal(p.input.read().map_id, 10);
  mem.override(() => UNAVAILABLE);
  await p.boot();
  assert.equal(p.context.onLoadMap('Map0011.lmu'), 'original load');
  assert.deepEqual([p.input.read().map_known, p.input.read().map_id], [true, 11]);
});

test('onLoadMap sets the map only without available memory and preserves the page callback', async () => {
  for (const memory of [null, 'unavailable']) {
    const mem = fakeMemory();
    if (memory) mem.override(() => UNAVAILABLE);
    const p = page({}, memory ? mem.memory : null);
    await p.boot();
    assert.equal(Object.getOwnPropertyDescriptor(p.context, 'onLoadMap').configurable, false);
    for (const name of ['Map10.lmu', 'Map0000.lmu', 'Map0010.lmu.bak', 'Map0010.lmd', undefined, {}]) {
      assert.equal(p.context.onLoadMap(name), 'original load');
      assert.equal(p.input.read().map_known, false, String(name));
    }
    const receiver = {};
    assert.equal(p.context.onLoadMap.call(receiver, 'map0010.LMU', 'extra'), 'original load');
    const call = p.callbacks.at(-1);
    assert.equal(call[0], 'load');
    assert.equal(call[1], receiver);
    assert.deepEqual(Array.from(call[2]), ['map0010.LMU', 'extra']);
    let state = p.input.read();
    assert.deepEqual([state.map_known, state.map_id, state.player_x, state.player_y], [true, 10, 5, 8]);
    // Without verified engine state it is always the player's new map
    // (teleports then report the landing through onPlayerTeleported).
    p.context.onLoadMap('Map0011.lmu');
    p.tick();
    state = p.input.read();
    assert.equal(state.map_id, 11);
    assert.equal(state.error, null);
  }

  // Available memory owns map identity, even when it currently reports no map.
  const mem = fakeMemory({ scene: 'Title' });
  const p = page({}, mem.memory);
  await p.boot();
  assert.equal(p.input.read().map_known, false);
  p.context.moduleValue.api.getPlayerCoords = undefined;
  assert.equal(p.context.onLoadMap('Map0010.lmu'), 'original load');
  assert.equal(p.input.read().map_id, null);
});

test('a read-only onLoadMap is optional and never disables automation', async () => {
  const p = page();
  vm.runInContext(`Object.defineProperty(window, 'onLoadMap', { writable: false });`, p.context);
  assert.equal(await p.boot(), p.context.moduleValue);
  const state = p.input.read();
  assert.equal(state.ready, true);
  assert.equal(state.error, null);
  assert.equal(p.context.onLoadMap('Map0010.lmu'), 'original load');
  assert.equal(p.input.read().map_known, false);
  p.input.hold('up', 1);
  p.tick();
  assert.deepEqual(eventTypes(p), ['keydown', 'keyup']);
});

test('read().memory is a copy of the last sample and absent without a sample', async () => {
  const plain = page();
  await plain.boot();
  assert.equal(plain.input.read().memory, null);

  const mem = fakeMemory();
  const p = page({}, mem.memory);
  assert.equal(p.input.read().memory, null);
  await p.boot();
  const sampled = mem.state;
  const state = p.input.read();
  assert.notEqual(state.memory, sampled);
  assert.deepEqual({ ...state.memory }, sampled);
  state.memory.map_id = 99;
  state.memory.scene = 'Title';
  assert.equal(sampled.map_id, 10);
  assert.equal(sampled.scene, 'Map');
  // Without coordinates there is no new sample: the stored one is unchanged.
  p.context.moduleValue.api.getPlayerCoords = undefined;
  const again = p.input.read();
  assert.notEqual(again.memory, state.memory);
  assert.deepEqual([again.memory.map_id, again.memory.scene], [10, 'Map']);
});

test('query and navigation delegate to available memory and are null otherwise', async () => {
  const plain = page();
  await plain.boot();
  plain.context.onPlayerTeleported(10, 5, 8);
  assert.equal(plain.input.query({ switches: [1] }), null);
  assert.equal(plain.input.navigation(), null);

  const mem = fakeMemory();
  const p = page({}, mem.memory);
  assert.equal(p.input.query({ switches: [1] }), null);
  assert.equal(p.input.navigation(), null);
  await p.boot();
  p.input.read();
  const request = { switches: [1, 2], items: [3], skills: [] };
  assert.deepEqual(p.input.query(request), { switches: mem.switches });
  assert.equal(p.input.navigation(), mem.navigation);
  assert.equal(mem.calls.query.length, 1);
  assert.equal(mem.calls.query[0].module, p.context.moduleValue);
  assert.equal(mem.calls.query[0].request, request);
  assert.deepEqual(mem.calls.navigation.map(call => call.module), [p.context.moduleValue]);

  mem.override(() => UNAVAILABLE);
  p.input.read();
  assert.equal(p.input.query(request), null);
  assert.equal(p.input.navigation(), null);
  assert.equal(mem.calls.query.length, 1);
  assert.equal(mem.calls.navigation.length, 1);
});

test('a new engine resets memory discovery and logical frame counting', async () => {
  const mem = fakeMemory({ frame_count: 500 });
  const p = page({}, mem.memory);
  assert.equal(mem.calls.reset, 0);
  await p.boot();
  assert.equal(mem.calls.reset, 1);
  p.input.read();
  step(p, mem, 1);
  step(p, mem, 1);
  assert.equal(p.input.read().frame, 2);
  p.input.hold('up', 600);
  step(p, mem, 1);
  assert.deepEqual(eventTypes(p), ['keydown']);
  // The new engine starts its own counter.
  mem.set({ frame_count: 10, scene: 'Logo' });
  const pending = p.boot();
  assert.equal(mem.calls.reset, 2);
  assert.deepEqual(eventTypes(p), ['keydown', 'keyup']);
  let state = p.input.read();
  assert.equal(state.memory, null);
  assert.equal(state.input_timing, 'elapsed-main-loop');
  assert.equal(state.map_known, false);
  assert.equal(state.held_key, null);
  await pending;
  state = p.input.read();
  assert.deepEqual([state.frame, state.input_timing, state.map_known], [0, 'logical-frames', false]);
  step(p, mem, 1);
  assert.equal(p.input.read().frame, 1);
});
