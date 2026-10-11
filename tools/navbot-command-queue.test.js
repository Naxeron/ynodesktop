'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createCommandQueue } = require('../src/navbot/command-queue');
const { rendererScript } = require('../src/navbot/bridge');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('Stop bypasses a blocked renderer, cancels older queued movement, and orders newer movement after Stop', async () => {
  let time = 0;
  const blocked = deferred();
  const stopping = deferred();
  const calls = [];
  const schedule = createCommandQueue(async (command, control) => {
    calls.push({ op: command.op, ...control });
    if (command.op === 'state') await blocked.promise;
    if (command.op === 'stop') await stopping.promise;
    return command.op;
  }, { now: () => time });
  const state = schedule({ op: 'state' });
  await Promise.resolve();
  const oldMovement = schedule({ op: 'goto', x: 1, y: 1 });
  const cancelled = assert.rejects(oldMovement, /cancelled by Stop/);
  time = 20000;
  const stop = schedule({ op: 'stop' }, { receivedAt: 0, disconnected: () => true });
  const newMovement = schedule({ op: 'hold', key: 'up', frames: 1 });
  assert.deepEqual(calls.map(call => call.op), ['state', 'stop']);
  assert.equal(calls[1].generation, 1);
  blocked.resolve();
  await state;
  await cancelled;
  assert.deepEqual(calls.map(call => call.op), ['state', 'stop']);
  stopping.resolve();
  assert.equal(await stop, 'stop');
  assert.equal(await newMovement, 'hold');
  assert.equal(calls[2].generation, 1);
});

test('queued mutations expire from receipt, and an expired request does not poison later commands', async () => {
  let time = 0;
  const blocked = deferred();
  const calls = [];
  const schedule = createCommandQueue(async (command, control) => {
    calls.push({ op: command.op, ...control });
    if (command.op === 'state') await blocked.promise;
  }, { now: () => time });
  const state = schedule({ op: 'state' });
  const oldMovement = schedule({ op: 'goto-map', map: 10, x: 3, y: 4 });
  const expired = assert.rejects(oldMovement, /expired while waiting/);
  time = 4501;
  blocked.resolve();
  await state;
  await expired;
  for (const op of ['reload', 'close']) {
    await assert.rejects(schedule({ op }, { receivedAt: 0 }), /expired while waiting/);
  }
  await schedule({ op: 'goto', x: 1, y: 1 });
  assert.deepEqual(calls.map(call => call.op), ['state', 'goto']);
  assert.equal(calls[1].expiresAt, time + 4500);
});

test('renderer rejects an old movement evaluation that executes after Stop', () => {
  const calls = [];
  const context = {
    Date: { now: () => 1000 },
    window: { Module: {
      _Navbot_GetState: () => 1,
      UTF8ToString: () => '{}',
      _Navbot_Stop: () => calls.push('stop'),
      _Navbot_GoTo: () => calls.push('goto'),
      _Navbot_HoldKey: () => calls.push('hold'),
    } },
    document: { title: '2kki', getElementById: () => null },
    location: { hostname: 'ynoproject.net', pathname: '/2kki/' },
  };
  const run = (call, expiry, generation) => vm.runInNewContext(rendererScript(call, '2kki', expiry, generation), context);
  run(['_Navbot_Stop', []], 0, 1);
  assert.throws(() => run(['_Navbot_GoTo', [1, 1]], 9999, 0), /cancelled by Stop/);
  assert.throws(() => run(['_Navbot_HoldKey', [0, 1]], 9999, 0), /cancelled by Stop/);
  run(['_Navbot_GoTo', [2, 2]], 9999, 1);
  run(['_Navbot_Stop', []], 0, 2);
  assert.deepEqual(calls, ['stop', 'goto', 'stop']);
});
