'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNavbotUiController } = require('../src/navbot/ui-controller');
const { createCommandQueue } = require('../src/navbot/command-queue');

function harness({ enabled = true, bridge, getMapCatalog } = {}) {
  const calls = [];
  const frame = { url: 'https://ynoproject.net/2kki/' };
  const contents = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const win = { webContents: contents, isDestroyed: () => false };
  const snapshot = { ready: true, state: { scene: 'Map', map_id: 10 }, exports: ['_Navbot_Stop'] };
  let currentWindow = win;
  const controller = createNavbotUiController({
    getWindow: () => currentWindow,
    getOptions: () => ({ enabled, game: '2kki' }),
    getMapCatalog,
    getBridge: () => bridge === undefined ? {
      schedule: async command => { calls.push(command); return snapshot; },
    } : bridge,
  });
  return { controller, calls, frame, contents, win, event: { sender: contents, senderFrame: frame }, snapshot,
    setWindow: value => { currentWindow = value; } };
}

test('state preserves engine readiness and state without exposing the bridge session', async () => {
  const h = harness();
  assert.deepEqual(await h.controller.state(h.event), { ...h.snapshot, enabled: true, game: '2kki' });
  assert.deepEqual(h.calls, [{ op: 'state' }]);
  const loading = harness({ bridge: { schedule: async () => ({ ready: false, exports: [] }) } });
  assert.deepEqual(await loading.controller.state(loading.event), { enabled: true, game: '2kki', ready: false, exports: [] });
});

test('normal sessions report disabled and reject all movement without touching the engine', async () => {
  const h = harness({ enabled: false });
  for (const url of ['https://ynoproject.net/', 'https://ynoproject.net/yume/']) {
    h.frame.url = url;
    assert.deepEqual(await h.controller.state(h.event), {
      enabled: false, game: null, ready: false, message: 'Start a Navbot session to use navigation.',
    });
  }
  for (const command of [{ op: 'stop' }, { op: 'expedition' }, { op: 'goto', x: 1, y: 2 }, { op: 'goto-map', map: 10, x: 1, y: 2 }]) {
    await assert.rejects(h.controller.command(h.event, command), /requires a Navbot session/);
  }
  assert.deepEqual(h.calls, []);
});

test('bridge startup reports loading while mutations fail clearly', async () => {
  const h = harness({ bridge: null });
  assert.deepEqual(await h.controller.state(h.event), {
    enabled: true, game: '2kki', ready: false, message: 'Starting Navbot…',
  });
  await assert.rejects(h.controller.command(h.event, { op: 'stop' }), /still starting/);
});

test('only the current main window and its main frame can call either IPC handler', async () => {
  const h = harness();
  for (const event of [undefined, {}, { ...h.event, sender: {} }, { ...h.event, senderFrame: { url: h.frame.url } }]) {
    await assert.rejects(h.controller.state(event), /main game window/);
    await assert.rejects(h.controller.command(event, { op: 'stop' }), /main game window/);
  }
  h.setWindow(null);
  await assert.rejects(h.controller.state(h.event), /main game window/);
  h.setWindow(h.win);
  h.win.isDestroyed = () => true;
  await assert.rejects(h.controller.state(h.event), /main game window/);
  assert.deepEqual(h.calls, []);
});

test('authorization requires official HTTPS origin and the selected game on both URL sources', async () => {
  const h = harness();
  for (const url of [
    'http://ynoproject.net/2kki/', 'https://ynoproject.net:444/2kki/',
    'https://ynoproject.net.attacker.test/2kki/', 'https://attacker.test/2kki/',
    'https://name:password@ynoproject.net/2kki/', 'https://ynoproject.net/yume/',
    'https://ynoproject.net/2kki-other/', 'https://ynoproject.net/', 'about:blank', 'not a URL',
  ]) {
    h.frame.url = url;
    await assert.rejects(h.controller.state(h.event), /main game window/, url);
    await assert.rejects(h.controller.command(h.event, { op: 'stop' }), /main game window/, url);
  }
  h.frame.url = 'https://ynoproject.net/2kki/';
  h.contents.getURL = () => 'https://ynoproject.net/yume/';
  await assert.rejects(h.controller.state(h.event), /main game window/);
  assert.deepEqual(h.calls, []);
});

test('UI exposes only state, Stop, the expedition lookup and bounded tile/map navigation', async () => {
  const h = harness();
  for (const command of [
    null, [], 'stop', {}, { op: 'eval', code: 'alert(1)' }, { op: 'capture' },
    { op: 'events' }, { op: 'reload' }, { op: 'close' }, { op: 'hold', key: 'up', frames: 1 },
    { op: 'goto', x: -1, y: 0 }, { op: 'goto', x: 1.5, y: 0 },
    { op: 'goto', x: '1);alert(1)', y: 0 }, { op: 'goto-map', map: 0, x: 1, y: 2 },
    { op: 'goto-map', map: 10, x: 10000, y: 0 },
  ]) await assert.rejects(h.controller.command(h.event, command));
  assert.deepEqual(h.calls, []);
  await h.controller.command(h.event, { op: 'goto', x: 0, y: 9999, code: 'ignored' });
  await h.controller.command(h.event, { op: 'goto-map', map: 10, x: 3, y: 4 });
  await h.controller.command(h.event, { op: 'stop' });
  await h.controller.command(h.event, { op: 'expedition', map: 1, title: 'ignored' });
  assert.deepEqual(h.calls, [{ op: 'goto', x: 0, y: 9999 }, { op: 'goto-map', map: 10, x: 3, y: 4 }, { op: 'stop' }, { op: 'expedition' }]);
});

test('UI Stop cancels queued CLI movement and CLI Stop cancels queued UI movement', async () => {
  for (const stopFromUi of [true, false]) {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const calls = [];
    const bridge = { schedule: createCommandQueue(async command => {
      calls.push(command.op);
      if (command.op === 'state') await blocked;
      return { ready: true };
    }) };
    const h = harness({ bridge });
    const cliState = bridge.schedule({ op: 'state' });
    await Promise.resolve();
    const movement = { op: 'goto', x: 1, y: 2 };
    const oldMovement = stopFromUi ? bridge.schedule(movement) : h.controller.command(h.event, movement);
    const cancelled = assert.rejects(oldMovement, /cancelled by Stop/);
    if (stopFromUi) await h.controller.command(h.event, { op: 'stop' });
    else await bridge.schedule({ op: 'stop' });
    assert.deepEqual(calls, ['state', 'stop']);
    release();
    await cliState;
    await cancelled;
    await h.controller.command(h.event, movement);
    assert.deepEqual(calls, ['state', 'stop', 'goto']);
  }
});

test('queued UI movement is discarded if its authorized page navigates away', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const calls = [];
  const bridge = { schedule: createCommandQueue(async command => {
    calls.push(command.op);
    if (command.op === 'state') await blocked;
    return { ready: true };
  }) };
  const h = harness({ bridge });
  const state = bridge.schedule({ op: 'state' });
  const navigation = h.controller.command(h.event, { op: 'goto', x: 1, y: 2 });
  const disconnected = assert.rejects(navigation, /disconnected/);
  h.frame.url = 'https://ynoproject.net/yume/';
  release();
  await state;
  await disconnected;
  assert.deepEqual(calls, ['state']);
});

test('engine readiness failures reach the UI without reporting success', async () => {
  const h = harness({ bridge: { schedule: async () => { throw new Error('Navbot engine is not ready'); } } });
  await assert.rejects(h.controller.command(h.event, { op: 'goto', x: 1, y: 2 }), /engine is not ready/);
});

test('catalog IPC is scoped to the authorized selected game and independent of engine startup', async () => {
  const calls = [];
  const catalog = { game: '2kki', entries: [{ mapId: 10, name: 'Nexus' }] };
  const h = harness({ bridge: null, getMapCatalog: game => { calls.push(game); return catalog; } });
  assert.deepEqual(await h.controller.maps(h.event), catalog);
  assert.deepEqual(calls, ['2kki']);
  await h.controller.state(h.event);
  assert.deepEqual(calls, ['2kki']);
  for (const event of [undefined, {}, { ...h.event, sender: {} }, { ...h.event, senderFrame: { url: h.frame.url } }]) {
    await assert.rejects(h.controller.maps(event), /main game window/);
  }
  for (const url of ['https://ynoproject.net/yume/', 'https://other.example/2kki/', 'http://ynoproject.net/2kki/']) {
    h.frame.url = url;
    await assert.rejects(h.controller.maps(h.event), /main game window/);
  }
  assert.deepEqual(calls, ['2kki']);
});

test('normal sessions cannot load a Navbot catalog', async () => {
  let loaded = false;
  const h = harness({ enabled: false, getMapCatalog: () => { loaded = true; } });
  await assert.rejects(h.controller.maps(h.event), /requires a Navbot session/);
  assert.equal(loaded, false);
});
