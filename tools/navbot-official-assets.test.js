'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { createOfficialAssets } = require('../src/navbot/official-assets');

const navigation = { width: 2, height: 1, loopHorizontal: false, loopVertical: false, passages: [4, 2] };
const exitInteractions = [{ eventId: 1, startX: 1, startY: 0,
  pages: [{ trigger: 0, layer: 1, targetMapIds: [5], unsupported: false }] }];
const snapshot = map_id => ({ ready: true, map_known: true, map_id, teleport_sequence: 1 });
function harness(t) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navbot-official-assets-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const existsSync = fs.existsSync;
  t.mock.method(fs, 'existsSync', file => /\/scratch\/lmu_parser\.(js|wasm)$/.test(file) || existsSync(file));
  const reads = [], parses = [];
  const state = { data: filename => Buffer.from(filename).toString('base64'), output: { navigation, exitInteractions } };
  const win = { webContents: { executeJavaScript: async source => {
    const match = /^window\.__ynoOfficialInput\.readAsset\(("[^"\n]+")\)$/.exec(source);
    assert.ok(match, 'only the fixed asset reader is evaluated');
    const filename = JSON.parse(match[1]);
    assert.match(filename, /^(RPG_RT\.ldb|Map\d{4}\.lmu)$/);
    reads.push(filename);
    return state.data(filename);
  } } };
  t.mock.method(childProcess, 'execFile', (executable, args, options, callback) => {
    parses.push({ executable, args, options });
    setImmediate(() => callback(state.error || null, JSON.stringify(state.output)));
  });
  return { provider: createOfficialAssets(win, { runDir }), reads, parses, state, runDir };
}

test('official assets use only loaded data, cache a runtime, and record source hashes', async t => {
  const h = harness(t);
  assert.equal(await h.provider.ensureMap({ ready: false }), null);
  assert.equal(await h.provider.ensureMap({ ready: true, map_known: false }), null);
  await assert.rejects(h.provider.ensureMap(snapshot('../RPG_RT')), /map ID/);
  assert.deepEqual(h.reads, []);
  const first = h.provider.ensureMap(snapshot(2));
  assert.equal(h.provider.ensureMap(snapshot(2)), first, 'concurrent requests share extraction');
  assert.deepEqual(await first, { mapId: 2, navigation, exitInteractions });
  await h.provider.ensureMap({ ...snapshot(2), teleport_sequence: 3 });
  await h.provider.ensureMap(snapshot(10));
  assert.deepEqual(h.reads, ['RPG_RT.ldb', 'Map0002.lmu', 'Map0010.lmu']);
  assert.equal(h.parses.length, 2);
  const call = h.parses[0];
  assert.equal(call.executable, process.execPath);
  assert.equal(call.args.at(-1), '--navigation');
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(call.options.timeout, 15000);
  assert.equal(call.options.maxBuffer, 64 * 1024 * 1024);
  const metadata = JSON.parse(fs.readFileSync(path.join(h.runDir, 'official-data/runtime-0/Map0002.navigation.json')));
  assert.deepEqual(metadata.exitInteractions, exitInteractions);
  assert.equal(metadata.sources['Map0002.lmu'], crypto.createHash('sha256').update('Map0002.lmu').digest('hex'));
  assert.equal(metadata.sources['RPG_RT.ldb'], crypto.createHash('sha256').update('RPG_RT.ldb').digest('hex'));
  h.provider.reset();
  await h.provider.ensureMap(snapshot(2));
  assert.deepEqual(h.reads.slice(-2), ['RPG_RT.ldb', 'Map0002.lmu']);
  assert.match(h.parses.at(-1).args[1], /runtime-1/);
});

test('reset discards in-flight runtime assets before parsing', async t => {
  const h = harness(t);
  let finish;
  h.state.data = () => new Promise(resolve => { finish = resolve; });
  const old = h.provider.ensureMap(snapshot(2));
  h.provider.reset();
  finish(Buffer.from('old database').toString('base64'));
  assert.equal(await old, null);
  assert.equal(h.parses.length, 0);
  h.state.data = filename => Buffer.from(filename).toString('base64');
  assert.deepEqual(await h.provider.ensureMap(snapshot(10)), { mapId: 10, navigation, exitInteractions });
});

test('malformed assets, oversized maps, and invalid parser output fail closed and can retry', async t => {
  const h = harness(t);
  h.state.data = () => '%%%=';
  await assert.rejects(h.provider.ensureMap(snapshot(2)), /Invalid or oversized/);
  assert.equal(h.parses.length, 0);
  h.state.data = filename => filename.endsWith('.lmu')
    ? 'A'.repeat(Math.ceil(16 * 1024 * 1024 / 3) * 4 + 4) : Buffer.from(filename).toString('base64');
  await assert.rejects(h.provider.ensureMap(snapshot(2)), /Invalid or oversized/);
  assert.equal(h.parses.length, 0);
  h.state.data = filename => Buffer.from(filename).toString('base64');
  h.state.output = { navigation: { ...navigation, passages: [16, 2] } };
  await assert.rejects(h.provider.ensureMap(snapshot(2)), /Invalid navigation map/);
  h.state.output = { navigation };
  h.state.error = new Error('Parser failed');
  await assert.rejects(h.provider.ensureMap(snapshot(2)), /Parser failed/);
  h.state.error = null;
  assert.deepEqual(await h.provider.ensureMap(snapshot(2)), { mapId: 2, navigation, exitInteractions: [] });
});

test('invalid exit interactions fail closed before caching or installing parser output', async t => {
  const h = harness(t);
  for (const invalid of [null, {}, [{ ...exitInteractions[0], startX: navigation.width }],
    [{ ...exitInteractions[0], pages: [{ trigger: 0, layer: 1, targetMapIds: ['5'], unsupported: false }] }]]) {
    h.state.output = { navigation, exitInteractions: invalid };
    await assert.rejects(h.provider.ensureMap(snapshot(2)), /Invalid .*interaction/i);
    assert.equal(fs.existsSync(path.join(h.runDir, 'official-data/runtime-0/Map0002.navigation.json')), false);
  }
  h.state.output = { navigation, exitInteractions };
  assert.deepEqual(await h.provider.ensureMap(snapshot(2)), { mapId: 2, navigation, exitInteractions });
});

test('missing parser build gives the developer an actionable startup error', t => {
  t.mock.method(fs, 'existsSync', () => false);
  assert.throws(() => createOfficialAssets({}, {}), /\.\/tools\/build-lmu-parser\.sh/);
});
