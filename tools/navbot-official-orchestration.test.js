'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { effectTable } = require('../src/navbot/effects');

const navigation = { width: 2, height: 1, loopHorizontal: false, loopVertical: false, passages: [4, 2] };
const exitInteractions = [{ eventId: 1, startX: 1, startY: 0,
  pages: [{ trigger: 0, layer: 1, targetMapIds: [5], unsupported: false }] }];
const edge = targetMapId => ({ targetMapId, startX: 1, startY: 0, targetX: 0, targetY: 0 });

async function harness(graph = {}, options = {}) {
  const filename = require.resolve('../src/navbot/official');
  const realRequire = createRequire(filename);
  const calls = [], installs = [], failures = [], events = [], reroutes = [];
  const state = { ready: true, map_known: true, map_id: 2, teleport_sequence: 1, status: 'idle' };
  const input = { read: () => ({ ...state }) };
  const controller = { read: input.read, installMap: (...args) => installs.push(args), fail: reason => failures.push(reason),
    reroute: (...args) => { reroutes.push(JSON.parse(JSON.stringify(args))); state.reroute_request = null; return true; } };
  const page = vm.createContext({ window: { __ynoOfficialInput: input, __ynoOfficialController: controller } });
  const contents = new EventEmitter();
  contents.loadURL = async url => calls.push(['load', url]);
  contents.executeJavaScript = async source => vm.runInContext(source, page);
  contents.debugger = new EventEmitter();
  contents.debugger.attach = version => calls.push(['attach', version]);
  contents.debugger.sendCommand = async (method, params) => calls.push([method, params]);
  const assets = { reset() {}, ensureMap: async s => ({ mapId: s.map_id, navigation, exitInteractions }) };
  const moduleBox = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: moduleBox, URL,
    require(name) {
      if (name === 'node:fs') return { readFileSync: () => JSON.stringify(graph) };
      if (name === './official-assets') return { createOfficialAssets: () => assets };
      return realRequire(name);
    },
  });
  const api = await moduleBox.exports.setupOfficialNavbot({ isDestroyed: () => false, webContents: contents },
    { game: '2kki', graphPath: 'graph.json', ...options }, (...args) => events.push(args));
  return { api, assets, state, calls, contents, installs, failures, events, reroutes, page };
}

test('official setup installs game-scoped document-start hooks without changing engine resource requests', async () => {
  const h = await harness();
  assert.deepEqual(h.calls[0], ['load', 'about:blank']);
  const [_, { source }] = h.calls.find(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(h.calls.some(([method]) => /intercept|fetch|request/i.test(method)), false);
  for (const [origin, pathname, allowed] of [
    ['https://ynoproject.net', '/2kki/', true],
    ['https://ynoproject.net', '/yume/', false],
    ['https://other.example', '/2kki/', false],
  ]) {
    const window = { addEventListener() {} };
    vm.runInNewContext(source, { window, performance: { now: () => 0 }, location: { origin, pathname }, document: { addEventListener() {} } });
    assert.equal(typeof window.__ynoOfficialController === 'object', allowed);
    if (allowed) assert.equal(window.__ynoOfficialInput.read().ready, false);
  }
});

test('asset completion installs only the requested map and teleport in the same document', async () => {
  for (const supersede of ['map', 'teleport', 'document', 'none']) {
    const h = await harness();
    let finish, begin;
    const begun = new Promise(resolve => { begin = resolve; });
    h.assets.ensureMap = () => new Promise(resolve => { finish = resolve; begin(); });
    const refreshing = h.api.refresh();
    await begun;
    if (supersede === 'map') h.state.map_id = 5;
    if (supersede === 'teleport') h.state.teleport_sequence++;
    if (supersede === 'document') h.contents.emit('did-start-navigation', {}, 'https://ynoproject.net/2kki/', false, true);
    finish({ mapId: 2, navigation });
    await refreshing;
    assert.equal(h.installs.length, supersede === 'none' ? 1 : 0, supersede);
    assert.deepEqual(h.failures, []);
  }
});

test('map extraction failures affect only the matching observation and transient exits skip extraction', async () => {
  for (const supersede of ['map', 'teleport', 'none']) {
    const h = await harness();
    h.assets.ensureMap = async () => {
      if (supersede === 'map') h.state.map_id = 5;
      if (supersede === 'teleport') h.state.teleport_sequence++;
      throw new Error('Missing map');
    };
    await h.api.refresh();
    assert.equal(h.failures.length, supersede === 'none' ? 1 : 0, supersede);
    if (h.failures.length) assert.match(h.failures[0], /Missing map/);
  }
  const h = await harness();
  h.state.status = 'waiting_for_teleport';
  h.state.map_id = 900;
  h.assets.ensureMap = () => { assert.fail('Transient sleep map must not trigger extraction'); };
  await h.api.refresh();
  assert.deepEqual(h.failures, []);
});

test('official route dispatch preserves same-map walking and rejects ambiguous or unsupported travel', async () => {
  const h = await harness({ 2: [edge(5)], 5: [edge(10), edge(11)] });
  const to = map => ['_Navbot_GoToMap', [map, 0, 0]];
  assert.equal(h.api.route(null, h.state), null);
  assert.equal(h.api.route(to(2), h.state)[2].length, 0);
  assert.equal(h.api.route(to(5), h.state)[2][0].targetMapId, 5);
  assert.throws(() => h.api.route(to(10), h.state), /unambiguous map route/);
  assert.throws(() => h.api.route(to(568), h.state), /Planetarium recipe requires/);
  assert.equal(h.api.route(to(568), { ...h.state, map_id: 568 })[2].length, 0);
  assert.throws(() => h.api.route(to(5), { ...h.state, map_known: false }), /Load a game/);
});

test('map installation supplies only reviewed local transfers and permits extraction while settling', async () => {
  const transfer = { ...edge(2), reviewed: true };
  const h = await harness({ 2: [transfer, { ...edge(2), startX: 0 }, edge(5)] });
  // Avoid ambiguity at the reviewed transfer's trigger.
  h.state.status = 'settling_after_teleport';
  await h.api.refresh();
  assert.equal(h.installs.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.installs[0][2])), []);
  const local = await harness({ 2: [transfer, { ...edge(2), startX: 0 }] });
  local.state.status = 'settling_after_teleport';
  await local.api.refresh();
  assert.deepEqual(JSON.parse(JSON.stringify(local.installs[0][2])), [{ ...transfer, mapId: 2 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(local.installs[0][3])), exitInteractions,
    'current-map event interactions reach the same controller used by manual and CLI launches');
});

test('official engine mode never registers local asset interception or requires local game binaries', () => {
  const source = fs.readFileSync(require.resolve('../src/createApp'), 'utf8');
  for (const engine of ['official', 'local']) {
    const registrations = [], files = [];
    const moduleBox = { exports: {} };
    vm.runInNewContext(source, { module: moduleBox,
      require(name) {
        if (name === 'electron') return {
          protocol: { handle: scheme => registrations.push(scheme) },
          session: { defaultSession: { webRequest: { onBeforeRequest: () => registrations.push('requests') } } },
        };
        if (name === 'electron-store') return class {};
        if (name === 'path') return require('node:path');
        if (name === 'fs') return { existsSync: file => { files.push(file); return true; } };
        if (name === './navbot/options') return { readOptions: () => ({ enabled: true, engine, engineDir: '/unused', graphPath: '/graph.json' }) };
        if (name === './navbot/graph') return { prepareDebugGraph: options => options };
        if (name === './navbot/ui-controller') return { createNavbotUiController: () => ({}) };
        return {};
      },
    });
    moduleBox.exports.setupInterceptors();
    assert.deepEqual(registrations, engine === 'official' ? [] : ['local-engine', 'requests']);
    assert.deepEqual(files, engine === 'official' ? [] : ['/unused/ynoengine-simd.js', '/unused/ynoengine-simd.wasm']);
  }
});

const plain = value => JSON.parse(JSON.stringify(value));
const scriptSource = h => h.calls.find(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')[1].source;

test('the injected page script enables controller rerouting and counts only trusted canvas keyboard input', async () => {
  const h = await harness();
  const canvas = { id: 'canvas' }, chat = { id: 'chatInput' };
  const listeners = [], configured = [];
  let controller = null;
  const window = { addEventListener() {} };
  // Observe the real controller's configure() call without replacing its behaviour.
  Object.defineProperty(window, '__ynoOfficialController', { configurable: true, get: () => controller, set(value) {
    const configure = value.configure;
    value.configure = options => { configured.push(plain(options)); return configure(options); };
    controller = value;
  } });
  const document = {
    addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }),
    getElementById: id => id === 'canvas' ? canvas : null,
  };
  vm.runInNewContext(scriptSource(h), { window, document, performance: { now: () => 0 },
    location: { origin: 'https://ynoproject.net', pathname: '/2kki/' } });
  // 2kki also hands the controller its effect table for item-menu preparations.
  assert.deepEqual(configured, [{ reroute: true, preparation: plain(effectTable('2kki')) }]);
  assert.equal(controller.read().capabilities.preparation, false, 'preparations still need verified engine state');
  const keydown = listeners.filter(entry => entry.type === 'keydown');
  assert.equal(keydown.length, 1);
  assert.equal(keydown[0].capture, true, 'capture phase sees keys before the page can stop propagation');
  const interrupts = () => controller.read().user_interrupts;
  assert.equal(interrupts(), 0);
  keydown[0].listener({ isTrusted: false, target: canvas }); // Navbot's own synthetic canvas keys
  keydown[0].listener({ isTrusted: true, target: chat }); // typing in chat or other page inputs
  assert.equal(interrupts(), 0);
  keydown[0].listener({ isTrusted: true, target: canvas });
  keydown[0].listener({ isTrusted: true, target: canvas });
  assert.equal(interrupts(), 2);
  assert.equal(controller.read().active, false);
});

const exit = (targetMapId, startX, startY = 0) => ({ targetMapId, startX, startY, targetX: 0, targetY: 0 });
// Map 2 has an ambiguous departure at (1,0) and a plain one at (3,0).
const rerouteGraph = { 2: [exit(5, 1), exit(6, 1), exit(7, 3)], 5: [exit(10, 0)], 6: [exit(10, 0)], 7: [exit(10, 0)] };
const rerouteRequest = (patch = {}) => ({ id: 4, map: 2, target_map: 10, observed: [], blocked: [], ...patch });

test('refresh answers a reroute request with planner edges that honour observed and blocked departures', async () => {
  for (const [patch, via] of [
    [{}, 7],
    [{ observed: [['2:1,0', 5]] }, 5],
    [{ observed: [['2:1,0', 6]], blocked: ['2:3,0'] }, 6],
    [{ observed: Array(128).fill(['2:1,0', 6]), blocked: Array(128).fill('x'.repeat(32)) }, 6],
  ]) {
    const h = await harness(rerouteGraph);
    h.state.reroute_request = rerouteRequest(patch);
    await h.api.refresh();
    assert.equal(h.reroutes.length, 1, JSON.stringify(patch).slice(0, 80));
    const [id, edges, message] = h.reroutes[0];
    assert.equal(id, 4);
    assert.deepEqual(edges.map(item => [item.mapId, item.targetMapId, item.startX]), [[2, via, via === 7 ? 3 : 1], [via, 10, 0]]);
    assert.equal(message, null);
    assert.deepEqual(plain(h.events.find(([type]) => type === 'reroute')),
      ['reroute', { id: 4, from: 2, to: 10, route: [via, 10], message: null }]);
    assert.equal(h.installs.length, 1, 'answering a reroute does not skip map installation');
  }
});

test('a reroute request without a remaining route or with an invalid graph fails with a message', async () => {
  const h = await harness(rerouteGraph);
  h.state.reroute_request = rerouteRequest({ blocked: ['2:3,0'] });
  await h.api.refresh();
  assert.deepEqual(h.reroutes, [[4, null, 'No unambiguous route remains from map 2 after excluding observed departures.']]);
  assert.equal(plain(h.events.find(([type]) => type === 'reroute'))[1].route, null);

  const invalid = await harness({ 2: 'invalid' });
  invalid.state.reroute_request = rerouteRequest();
  await invalid.api.refresh();
  assert.deepEqual(invalid.reroutes, [[4, null, 'Invalid map graph edges']]);
});

test('malformed reroute requests are ignored without disturbing map installation', async () => {
  for (const bad of [
    'reroute', {}, { id: 1.5 }, { id: '4' }, { id: Number.MAX_SAFE_INTEGER + 1 }, { map: 0 }, { map: 10000 }, { map: '2' },
    { target_map: 2.5 }, { target_map: null }, { observed: null }, { observed: ['2:1,0'] }, { observed: [['2:1,0']] },
    { observed: [[5, 6]] }, { observed: [['2:1,0', '6']] }, { observed: [['x'.repeat(33), 6]] },
    { observed: Array(129).fill(['2:1,0', 6]) }, { blocked: '2:3,0' }, { blocked: [7] }, { blocked: ['x'.repeat(33)] },
    { blocked: Array(129).fill('2:3,0') },
  ]) {
    const h = await harness(rerouteGraph);
    h.state.reroute_request = typeof bad === 'string' || !Object.keys(bad).length ? bad : rerouteRequest(bad);
    await h.api.refresh();
    assert.deepEqual(h.reroutes, [], JSON.stringify(bad).slice(0, 80));
    assert.equal(h.events.some(([type]) => type === 'reroute'), false);
    assert.equal(h.installs.length, 1);
  }
});

test('a reroute request read before a document navigation is not answered into the new page', async () => {
  const h = await harness(rerouteGraph);
  h.state.reroute_request = rerouteRequest();
  const execute = h.contents.executeJavaScript;
  h.contents.executeJavaScript = async source => {
    const result = await execute(source);
    if (source === 'window.__ynoOfficialController?.read()') h.contents.emit('did-start-navigation', {}, 'https://ynoproject.net/2kki/', false, true);
    return result;
  };
  await h.api.refresh();
  assert.deepEqual(h.reroutes, []);
  assert.equal(h.installs.length, 0);
});

test('route requires a loaded game before recipe checks, and route and reroute share game route options', async () => {
  const h = await harness({ 2: [exit(568, 1)], 4: [exit(10, 15, 7), exit(11, 15, 7)] });
  for (const map of [567, 568]) {
    const call = ['_Navbot_GoToMap', [map, 3, 75]];
    assert.throws(() => h.api.route(call, { map_known: false, map_id: null, engine_state_error: 'memory unavailable' }),
      error => /Load a game/.test(error.message) && !/Planetarium/.test(error.message));
    assert.throws(() => h.api.route(call, { map_known: true, map_id: 10, engine_state_error: 'memory unavailable' }),
      /Planetarium recipe requires verified official-engine state \(memory unavailable\)/);
    assert.throws(() => h.api.route(call, { map_known: true, map_id: 10 }), /official-engine state \(unavailable\)/);
  }
  assert.throws(() => h.api.route(['_Navbot_GoToMap', [10, 0, 0]], { map_known: false }), /Load a game/);
  // The reviewed 2kki Nexus departure resolves an otherwise ambiguous exit for both paths.
  assert.deepEqual(plain(h.api.route(['_Navbot_GoToMap', [10, 1, 2]], { map_known: true, map_id: 4 })[2])
    .map(item => [item.mapId, item.targetMapId]), [[4, 10]]);
  h.state.map_id = 4;
  h.state.reroute_request = rerouteRequest({ map: 4 });
  await h.api.refresh();
  assert.deepEqual(h.reroutes[0][1].map(item => item.targetMapId), [10]);

  const yume = await harness({ 2: [exit(568, 1)], 4: [exit(10, 15, 7), exit(11, 15, 7)] }, { game: 'yume' });
  assert.equal(yume.api.route(['_Navbot_GoToMap', [568, 0, 0]], { map_known: true, map_id: 2 })[2][0].targetMapId, 568,
    'the Planetarium recipe guard is scoped to 2kki');
  assert.throws(() => yume.api.route(['_Navbot_GoToMap', [10, 0, 0]], { map_known: true, map_id: 4 }), /unambiguous map route/);
  yume.state.map_id = 4;
  yume.state.reroute_request = rerouteRequest({ map: 4 });
  await yume.api.refresh();
  assert.deepEqual(yume.reroutes, [[4, null, 'No unambiguous route remains from map 4 after excluding observed departures.']]);
});

// Map 2's only way on needs Spring (27) or Bat (38).
const gatedGraph = { 2: [{ ...exit(5, 1), approachX: 1, approachY: 0, direction: 0, action: true, reviewed: true, requiresEffects: [27, 38] }],
  5: [exit(10, 0)] };

test('route and reroute use an effect-gated exit only with an owned effect, and name the missing one', async () => {
  const h = await harness(gatedGraph);
  assert.throws(() => h.api.route(['_Navbot_GoToMap', [10, 0, 0]], { map_known: true, map_id: 2, owned_effects: [12] }),
    /This route needs the Spring or Bat effect, which this save does not have/);
  assert.throws(() => h.api.route(['_Navbot_GoToMap', [10, 0, 0]], { map_known: true, map_id: 2, owned_effects: null }),
    /This route needs the Spring or Bat effect, but the save's effects could not be read/);
  assert.deepEqual(plain(h.api.route(['_Navbot_GoToMap', [10, 0, 0]], { map_known: true, map_id: 2, owned_effects: [38] })[2])
    .map(item => item.targetMapId), [5, 10]);

  for (const [effects, route, message] of [[undefined, null, /could not be read/], [null, null, /could not be read/],
    [[45], null, /which this save does not have/], [[27], [5, 10], null]]) {
    const r = await harness(gatedGraph);
    r.state.reroute_request = rerouteRequest(effects === undefined ? {} : { effects });
    await r.api.refresh();
    assert.equal(r.reroutes.length, 1, JSON.stringify(effects));
    assert.deepEqual(r.reroutes[0][1]?.map(item => item.targetMapId) ?? null, route);
    if (message) assert.match(r.reroutes[0][2], message);
    const event = plain(r.events.find(([type]) => type === 'reroute'))[1];
    assert.deepEqual(event.effects, Array.isArray(effects) ? effects : undefined);
  }
  for (const effects of ['27', [0], [1.5], [10000], Array(65).fill(27)]) {
    const bad = await harness(gatedGraph);
    bad.state.reroute_request = rerouteRequest({ effects });
    await bad.api.refresh();
    assert.deepEqual(bad.reroutes, [], JSON.stringify(effects).slice(0, 40));
  }
  // After an exclusion, the missing effect is not why the route ended.
  const blocked = await harness({ 2: [...gatedGraph[2], exit(7, 3)], 5: [exit(10, 0)], 7: [exit(10, 0)] });
  blocked.state.reroute_request = rerouteRequest({ effects: [12], blocked: ['2:3,0'] });
  await blocked.api.refresh();
  assert.deepEqual(blocked.reroutes, [[4, null, 'No unambiguous route remains from map 2 after excluding observed departures.']]);
  // Other games have no effect table, so nothing is suggested.
  const yume = await harness(gatedGraph, { game: 'yume' });
  assert.throws(() => yume.api.route(['_Navbot_GoToMap', [10, 0, 0]], { map_known: true, map_id: 2 }), /unambiguous map route/);
});

test('map installation never offers effect-gated or cross-map exits as local transfers', async () => {
  const pipe = { ...exit(2, 4), targetX: 0, targetY: 0, approachX: 3, approachY: 0, direction: 1, action: false, teleport: false, reviewed: true };
  const h = await harness({ 2: [...gatedGraph[2], pipe] });
  await h.api.refresh();
  assert.equal(h.installs.length, 1);
  assert.deepEqual(plain(h.installs[0][2]), [{ ...pipe, mapId: 2 }]);
});
