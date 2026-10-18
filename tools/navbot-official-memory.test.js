'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createOfficialMemory } = require('../src/navbot/official-memory');

// A synthetic little-endian wasm32 heap with the official build's layout:
// RTTI names, typeinfo objects and vtables in the data region, statics in BSS
// declaration order, then heap objects. Offsets mirror the ynoengine/liblcf
// structures the reader documents; the reader itself is never imported for them.
const HEAP_SIZE = 2 << 20, HEAP_BASE = 0x40000;
const FILE_BLOCK = 'NSt3__220__shared_ptr_emplaceI16FileRequestAsyncNS_9allocatorIS1_EEEE';
const NAMES = Object.freeze({
  player: '11Game_Player', party: '10Game_Party', enemyParty: '15Game_EnemyParty',
  interpreter: '20Game_Interpreter_Map', message: '14Window_Message', itemWindow: '11Window_Item',
  command: '14Window_Command', event: '10Game_Event', vehicle: '12Game_Vehicle', actor: '10Game_Actor',
  transition: '10Transition', connection: '13YNOConnection', sceneMap: '9Scene_Map', sceneTitle: '11Scene_Title',
  sceneItem: '10Scene_Item', sceneMenu: '10Scene_Menu', sceneLoad: '10Scene_Load', fileBlock: FILE_BLOCK,
});
// BSS statics: Main_Data's game_player holder, Scene::instance, Game_Map's
// interpreter holder, Game_Message's window, Transition, Game_Multiplayer and
// the async request map.
const MAIN = 0x8100, SCENE = 0x8200, MAP = 0x8400, MESSAGE = 0x8500, TRANSITION = 0x8600, GMI = 0x8700, REQUESTS = 0x8800;
// Character fields, relative to the inline data at object + 16.
const CHAR = Object.freeze({
  active: [0, 'u8'], mapId: [4, 'i32'], x: [8, 'i32'], y: [12, 'i32'], direction: [16, 'i32'], facing: [20, 'i32'],
  remainingStep: [32, 'i32'], layer: [40, 'i32'], moveSpeed: [56, 'i32'], moveRouteOverwrite: [76, 'u8'],
  through: [92, 'u8'], jumping: [108, 'u8'], pause: [120, 'u8'], flying: [121, 'u8'], spriteId: [136, 'i32'],
  id: [188, 'i32'], vehicle: [188, 'i32'],
});
const EVENT_SIZE = 352, VEHICLE_SIZE = 232, PAGE_SIZE = 124, ACTOR_SIZE = 320;

const plain = value => JSON.parse(JSON.stringify(value));

// The reader is injected into the page from its source text, so load it the same way.
function load({ decoder = true } = {}) {
  const calls = { decode: 0 };
  const context = vm.createContext({});
  if (decoder) {
    const Native = TextDecoder;
    context.TextDecoder = class {
      constructor(label) { this.native = new Native(label); }
      decode(input) { calls.decode++; return this.native.decode(input); }
    };
  }
  const memory = vm.runInContext(`(${createOfficialMemory.toString()})()`, context);
  return { memory, calls, ArrayBuffer: vm.runInContext('ArrayBuffer', context) };
}

function createWorld(BufferType, { omit = [], size = HEAP_SIZE } = {}) {
  let buffer = new BufferType(size), view = new DataView(buffer), top = HEAP_BASE;
  const module = { HEAPU8: new Uint8Array(buffer) };
  const u8 = (address, value) => view.setUint8(address, Number(value));
  const i16 = (address, value) => view.setInt16(address, value, true);
  const i32 = (address, value) => view.setInt32(address, value, true);
  const u32 = (address, value) => view.setUint32(address, value >>> 0, true);
  function alloc(bytes) {
    const address = top;
    top += Math.max(16, (bytes + 15) & ~15);
    assert.ok(top <= buffer.byteLength, 'synthetic heap is full');
    return address;
  }
  function vector(at, begin, count, elem, spare = 0) {
    u32(at, begin); u32(at + 4, begin + count * elem); u32(at + 8, begin + (count + spare) * elem);
  }
  function setVector(at, write, elem, values, spare = 0) {
    const begin = alloc((values.length + spare) * elem || elem);
    values.forEach((value, index) => write(begin + index * elem, value));
    vector(at, begin, values.length, elem, spare);
    return begin;
  }
  // libc++ alternate string layout: short {data[11], size}, long {data, size, cap|0x80000000}.
  function string(at, text) {
    if (text.length <= 10) {
      for (let i = 0; i < 12; i++) u8(at + i, i < text.length ? text.charCodeAt(i) : 0);
      u8(at + 11, text.length);
      return;
    }
    const data = alloc(text.length + 1);
    for (let i = 0; i < text.length; i++) u8(data + i, text.charCodeAt(i));
    u32(at, data); u32(at + 4, text.length); u32(at + 8, 0x80000000 | (text.length + 1));
  }
  function character(object, fields) {
    const data = object + 16;
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'sprite') { string(data + 124, value); continue; }
      const [offset, type] = CHAR[key];
      (type === 'u8' ? u8 : i32)(data + offset, Number(value));
    }
  }

  // Data: "\0name\0" strings, typeinfo {vptr, name}, vtable {0, typeinfo, functions...}.
  const vptr = {};
  Object.entries(NAMES).forEach(([key, name], index) => {
    if (omit.includes(name)) { vptr[key] = 0x6008 + index * 32; return; }
    const text = 0x1000 + index * 128, info = 0x3000 + index * 16, table = 0x4000 + index * 32;
    for (let i = 0; i < name.length; i++) u8(text + i, name.charCodeAt(i));
    u32(info, 0x500); u32(info + 4, text);
    u32(table, 0); u32(table + 4, info);
    for (let i = 0; i < 4; i++) u32(table + 8 + i * 4, index * 4 + i + 1);
    vptr[key] = table + 8;
  });

  // Heap objects; the player is the lowest, which bounds the static region.
  const player = alloc(320);
  u32(player, vptr.player); u32(player + 12, player + 16);
  character(player, { active: 1, mapId: 42, x: 5, y: 3, direction: 2, facing: 2, layer: 1, moveSpeed: 4, sprite: 'hero' });
  const party = alloc(64);
  u32(party, vptr.party);
  setVector(party + 16, i16, 2, [3, 7, 7, 12]);
  const enemyParty = alloc(32);
  u32(enemyParty, vptr.enemyParty);
  const system = alloc(800);
  i32(system + 4, 1234); u8(system + 721, 1);
  const switches = alloc(16), switchWords = alloc(8);
  u32(switchWords, 0x80000001); u32(switchWords + 4, 0x81); // switches 1, 32, 33 and 40
  u32(switches, switchWords); u32(switches + 4, 40); u32(switches + 8, 2); i32(switches + 12, 100);
  const actors = alloc(16), actorArray = alloc(3 * ACTOR_SIZE);
  vector(actors, actorArray, 3, ACTOR_SIZE);
  [[1, [5, 9]], [2, []], [99, [1]]].forEach(([id, skills], index) => {
    const actor = actorArray + index * ACTOR_SIZE;
    u32(actor, vptr.actor); i32(actor + 128, id);
    setVector(actor + 224, i16, 2, skills);
  });

  const messageWindow = alloc(420);
  u32(messageWindow, vptr.message); u32(messageWindow + 16, 4); // Drawable::Flags::Invisible
  const sceneMap = alloc(128);
  u32(sceneMap, vptr.sceneMap); i32(sceneMap + 4, 2); u32(sceneMap + 68, messageWindow);
  const titleCommand = alloc(320);
  u32(titleCommand, vptr.command); i32(titleCommand + 300, 1);
  const sceneTitle = alloc(128);
  u32(sceneTitle, vptr.sceneTitle); i32(sceneTitle + 4, 1); u32(sceneTitle + 64, titleCommand);
  i32(sceneTitle + 72, 0); i32(sceneTitle + 76, 1); u8(sceneTitle + 96, 1);
  const itemWindow = alloc(340);
  u32(itemWindow, vptr.itemWindow); i32(itemWindow + 300, 1);
  setVector(itemWindow + 328, i32, 4, [101, 205, 0]);
  const sceneItem = alloc(128);
  u32(sceneItem, vptr.sceneItem); i32(sceneItem + 4, 4); u32(sceneItem + 68, itemWindow);
  const menuCommand = alloc(320);
  u32(menuCommand, vptr.command); i32(menuCommand + 300, 2);
  const sceneMenu = alloc(128);
  u32(sceneMenu, vptr.sceneMenu); i32(sceneMenu + 4, 3); u32(sceneMenu + 68, menuCommand);
  const sceneLoad = alloc(128);
  u32(sceneLoad, vptr.sceneLoad); i32(sceneLoad + 4, 11); i32(sceneLoad + 64, 2);

  const interpreter = alloc(64), stack = alloc(64);
  u32(interpreter, vptr.interpreter); u8(interpreter + 4, 1);
  vector(interpreter + 20, stack, 0, 32, 2);

  const mapObject = alloc(160);
  const vehicles = alloc(3 * VEHICLE_SIZE);
  for (let i = 0; i < 3; i++) {
    const vehicle = vehicles + i * VEHICLE_SIZE;
    u32(vehicle, vptr.vehicle); u32(vehicle + 12, vehicle + 16);
    character(vehicle, { active: 1, mapId: 0, x: 0, y: 0, layer: 1 });
  }

  // Main_Data statics in declaration order around game_player.
  u32(MAIN - 32, system); u32(MAIN - 28, switches); u32(MAIN - 4, actors);
  u32(MAIN, player); u32(MAIN + 4, party); u32(MAIN + 8, enemyParty);
  // Scene::instance, Scene::old_instances, Scene::instances.
  const sceneControl = alloc(16), instances = alloc(32);
  u32(SCENE, sceneMap); u32(SCENE + 4, sceneControl);
  u32(instances, sceneMap); u32(instances + 4, sceneControl);
  vector(SCENE + 20, instances, 1, 8, 3);
  // Game_Map statics around the interpreter holder.
  const identity = Array.from({ length: 144 }, (_, i) => i);
  const tables = {
    lowerTiles: setVector(MAP - 0x88 + 28, u8, 1, identity),
    upperTiles: setVector(MAP - 0x88 + 40, u8, 1, identity),
    down: setVector(MAP - 0x38, u8, 1, Array(162).fill(0x0f)),
    up: setVector(MAP - 0x2c, u8, 1, Array(144).fill(0x1f)),
  };
  u32(MAP - 4, mapObject); u32(MAP, interpreter);
  vector(MAP + 4, vehicles, 3, VEHICLE_SIZE);
  u32(MESSAGE, messageWindow);
  // A finished Transition and a connected room.
  u32(TRANSITION, vptr.transition); i32(TRANSITION + 64, 40); i32(TRANSITION + 68, 40); i32(TRANSITION + 120, 0);
  u32(GMI + 8, vptr.connection); u8(GMI + 12, 1); u8(GMI + 137, 1); u8(GMI + 138, 0);
  i32(GMI + 156, 7); u32(GMI + 176, 3);
  // unordered_map<string, shared_ptr<FileRequestAsync>> with two finished requests.
  function request(important, state) {
    const control = alloc(12 + 64);
    u32(control, vptr.fileBlock); u32(control + 4, 1);
    i32(control + 12 + 56, state); u8(control + 12 + 60, important);
    return control;
  }
  function node(control, next = 0) {
    const address = alloc(32);
    u32(address, next); u32(address + 4, 1); string(address + 8, 'Map0042');
    u32(address + 20, control + 12); u32(address + 24, control);
    return address;
  }
  const optionalRequest = request(0, 1), importantRequest = request(1, 1);
  const secondNode = node(optionalRequest), firstNode = node(importantRequest, secondNode);
  const buckets = alloc(16);
  u32(buckets, REQUESTS + 8);
  u32(REQUESTS, buckets); u32(REQUESTS + 4, 1); u32(REQUESTS + 8, firstNode); u32(REQUESTS + 12, 2);
  view.setFloat32(REQUESTS + 16, 1, true);

  function setMap({ width, height, scroll = 0, lower = Array(width * height).fill(0), upper = Array(width * height).fill(10000) }) {
    i32(mapObject + 16, width); i32(mapObject + 20, height); i32(mapObject + 24, scroll);
    return { lower: setVector(mapObject + 120, i16, 2, lower), upper: setVector(mapObject + 132, i16, 2, upper) };
  }
  function setEvents(specs) {
    const begin = alloc(specs.length * EVENT_SIZE || EVENT_SIZE);
    specs.forEach((spec, index) => {
      const { id, x, y, layer = 1, active = true, through = false, flying = false, sprite = '', spriteId = 0,
        page = 0, pages = 2 } = spec;
      const event = begin + index * EVENT_SIZE;
      u32(event, vptr.event); u32(event + 12, event + 16);
      character(event, { id, mapId: 42, x, y, layer, active, through, flying, sprite, spriteId });
      const definition = alloc(32), pageBegin = alloc(pages * PAGE_SIZE);
      vector(definition + 16, pageBegin, pages, PAGE_SIZE);
      u32(event + 336, definition);
      u32(event + 340, page === null ? 0 : page === 'foreign' ? alloc(PAGE_SIZE) : pageBegin + page * PAGE_SIZE);
    });
    vector(MAP - 0x20, begin, specs.length, EVENT_SIZE);
    return begin;
  }
  setMap({ width: 8, height: 4 });
  setEvents([{ id: 1, x: 0, y: 0 }]);

  return {
    module, vptr, player, party, system, switches, actors, actorArray, messageWindow, sceneMap, sceneTitle,
    titleCommand, sceneItem, itemWindow, sceneMenu, sceneLoad, interpreter, stack, mapObject, vehicles, tables,
    importantRequest, optionalRequest, firstNode,
    u8, i16, i32, u32, alloc, vector, setVector, character, setMap, setEvents,
    vehicle: (index, fields) => character(vehicles + index * VEHICLE_SIZE, fields),
    setScene(scene) { u32(SCENE, scene); u32(instances, scene); },
    setRunning(running) { vector(interpreter + 20, stack, running ? 1 : 0, 32, 2); },
    grow(next) {
      const old = buffer;
      buffer = new BufferType(next);
      new Uint8Array(buffer).set(new Uint8Array(old));
      view = new DataView(buffer);
      module.HEAPU8 = new Uint8Array(buffer);
      return old;
    },
    snapshot: () => Buffer.from(new Uint8Array(buffer)),
  };
}

function setup(options) {
  const loaded = load(options);
  const world = createWorld(loaded.ArrayBuffer, options);
  const sample = (now, coords = [5, 3]) => plain(loaded.memory.sample(world.module, coords, now));
  const query = request => plain(loaded.memory.query(world.module, request));
  const navigation = () => plain(loaded.memory.navigation(world.module));
  return { ...loaded, world, sample, query, navigation };
}

const MAP_STATE = Object.freeze({
  available: true, error: null, scene: 'Map', frame_count: 1234, map_id: 42, player_x: 5, player_y: 3,
  direction: 2, facing: 2, moving: false, jumping: false, move_speed: 4, vehicle_type: 0,
  player_paused: false, move_route_overwritten: false, through: false, teleport_pending: false,
  event_running: false, message_active: false, async_pending: false, async_files_known: true,
  menu_allowed: true, selected_item_id: 0, title_index: null, title_continue_enabled: null,
  title_new_game_index: null, title_continue_index: null, file_index: null, menu_index: null,
  room_connected: true, room_sync_pending: false, room_synced_id: 7, room_player_count: 3,
});

test('discovers engine objects through RTTI and samples a Map scene', () => {
  const s = setup();
  assert.deepEqual(s.sample(0), MAP_STATE);
  assert.deepEqual(plain(s.memory.status()), { types: true, error: null, anchors: {
    main: true, staticEnd: true, scene: true, interpreter: true, message: true, transition: true,
    multiplayer: true, requests: true } });
  assert.equal(s.calls.decode, 1);

  const { world } = s;
  world.character(world.player, { x: 6, direction: 1, facing: 3, remainingStep: 128, moveSpeed: 5, pause: 1,
    moveRouteOverwrite: 1, through: 1 });
  world.u8(world.player + 311, 1);
  world.i32(world.system + 4, 1300); world.u8(world.system + 721, 0);
  world.u8(GMI + 138, 1); world.u32(GMI + 176, 4);
  assert.deepEqual(s.sample(50, [6, 3]), { ...MAP_STATE, player_x: 6, direction: 1, facing: 3, moving: true,
    move_speed: 5, player_paused: true, move_route_overwritten: true, through: true, teleport_pending: true,
    frame_count: 1300, menu_allowed: false, room_sync_pending: true, room_synced_id: -1, room_player_count: 4 });
  // A jump is not a step.
  world.character(world.player, { jumping: 1, vehicle: 2 });
  world.u8(GMI + 12, 0);
  const jumping = s.sample(60, [6, 3]);
  assert.equal(jumping.moving, false);
  assert.equal(jumping.jumping, true);
  assert.equal(jumping.vehicle_type, 2);
  assert.equal(jumping.room_connected, false);
  assert.equal(jumping.room_synced_id, -1);
  // Complete discovery is not repeated.
  assert.equal(s.calls.decode, 1);
});

test('a coordinate mismatch reports the layout error without throwing and rediscovers later', () => {
  const s = setup();
  assert.equal(s.sample(0).available, true);
  let state;
  assert.doesNotThrow(() => { state = s.sample(100, [9, 9]); });
  assert.deepEqual(state, { available: false, error: 'Engine memory layout does not match getPlayerCoords()' });
  assert.equal(s.memory.query(s.world.module, { switches: [1] }), null);
  assert.equal(s.memory.navigation(s.world.module), null);
  assert.equal(plain(s.memory.status()).anchors, null);
  // Rediscovery waits for the retry delay even with matching coordinates.
  assert.deepEqual(s.sample(1000), state);
  assert.deepEqual(s.sample(2099), state);
  assert.deepEqual(s.sample(2100), MAP_STATE);
  // Type information survives; only the anchors were rescanned.
  assert.equal(s.calls.decode, 1);
  // Without coordinates there is nothing to compare against.
  assert.equal(s.sample(2200, null).available, true);
  // A mismatch on the very first sample is reported the same way.
  const fresh = setup();
  assert.deepEqual(fresh.sample(0, [5, 4]), state);
});

test('scene switches expose Title, Item, Menu and File selections', () => {
  const s = setup(), { world } = s;
  assert.equal(s.sample(0).scene, 'Map');

  // Scene_Map is destroyed with its message window.
  world.setScene(world.sceneTitle); world.u32(MESSAGE, 0);
  assert.deepEqual(s.sample(100), { ...MAP_STATE, scene: 'Title', title_index: 1, title_continue_enabled: true,
    title_new_game_index: 0, title_continue_index: 1 });
  world.i32(world.titleCommand + 300, 0); world.u8(world.sceneTitle + 96, 0);
  world.i32(world.sceneTitle + 72, 2); world.i32(world.sceneTitle + 76, 3);
  let state = s.sample(200);
  assert.equal(state.title_index, 0);
  assert.equal(state.title_continue_enabled, false);
  assert.equal(state.title_new_game_index, 2);
  assert.equal(state.title_continue_index, 3);
  // Running interpreters only count on a map.
  world.setRunning(true);
  assert.equal(s.sample(250).event_running, false);
  world.setRunning(false);
  // The command window must really be a Window_Command.
  world.u32(world.sceneTitle + 64, world.itemWindow);
  assert.equal(s.sample(300).title_index, null);

  world.setScene(world.sceneItem);
  state = s.sample(400);
  assert.equal(state.scene, 'Item');
  assert.equal(state.selected_item_id, 205);
  assert.equal(state.title_index, null);
  assert.equal(state.title_continue_enabled, null);
  for (const [index, expected] of [[0, 101], [2, 0], [3, 0], [-1, 0], [99, 0]]) {
    world.i32(world.itemWindow + 300, index);
    assert.equal(s.sample(410).selected_item_id, expected, `item index ${index}`);
  }
  world.u32(world.sceneItem + 68, world.titleCommand);
  assert.equal(s.sample(420).selected_item_id, null);

  world.setScene(world.sceneMenu);
  state = s.sample(500);
  assert.equal(state.scene, 'Menu');
  assert.equal(state.menu_index, 2);
  assert.equal(state.selected_item_id, 0);

  world.setScene(world.sceneLoad);
  state = s.sample(600);
  assert.equal(state.scene, 'Load');
  assert.equal(state.file_index, 2);
  assert.equal(state.menu_index, null);

  world.setScene(world.sceneMap); world.u32(MESSAGE, world.messageWindow);
  assert.deepEqual(s.sample(700), MAP_STATE);
  // A scene that is not a known Scene is not trusted.
  world.u32(SCENE, world.messageWindow);
  assert.deepEqual(s.sample(800), { available: false, error: 'Engine scene was not found' });
});

test('message_active follows Window_Message visibility and its close-finished frame', () => {
  const s = setup(), { world } = s;
  assert.equal(s.sample(0).message_active, false);
  world.u32(world.messageWindow + 16, 0);
  assert.equal(s.sample(10).message_active, true);
  world.u32(world.messageWindow + 16, 1); // Global, still visible
  assert.equal(s.sample(20).message_active, true);
  world.u32(world.messageWindow + 16, 5); // Global | Invisible
  assert.equal(s.sample(30).message_active, false);
  world.u8(world.messageWindow + 407, 1);
  assert.equal(s.sample(40).message_active, true);
  world.u8(world.messageWindow + 407, 0);
  assert.equal(s.sample(50).message_active, false);
  // No window at all.
  world.u32(MESSAGE, 0);
  assert.equal(s.sample(60).message_active, false);
  // A holder that no longer points at a Window_Message is unknown.
  world.u32(MESSAGE, world.itemWindow);
  assert.equal(s.sample(70).message_active, null);
});

test('the message window is found once a Map scene exists', () => {
  const s = setup(), { world } = s;
  world.setScene(world.sceneTitle); world.u32(MESSAGE, 0);
  assert.equal(s.sample(0).message_active, false);
  assert.equal(plain(s.memory.status()).anchors.message, false);
  world.setScene(world.sceneMap); world.u32(MESSAGE, world.messageWindow); world.u32(world.messageWindow + 16, 0);
  // Not looked up again until the retry delay: unknown on a map.
  assert.equal(s.sample(100).message_active, null);
  assert.equal(s.sample(2000).message_active, true);
  assert.equal(plain(s.memory.status()).anchors.message, true);
  assert.equal(s.calls.decode, 1);
});

test('event_running reflects the map interpreter stack', () => {
  const s = setup(), { world } = s;
  assert.equal(s.sample(0).event_running, false);
  world.setRunning(true);
  assert.equal(s.sample(10).event_running, true);
  world.setRunning(false);
  assert.equal(s.sample(20).event_running, false);
  // Not the main interpreter (or not an interpreter) -> unknown.
  world.u8(world.interpreter + 4, 0);
  assert.equal(s.sample(30).event_running, null);
  world.u8(world.interpreter + 4, 1);
  world.u32(MAP, world.party);
  assert.equal(s.sample(40).event_running, null);
});

test('async_pending tracks transitions, scene delays and important file requests', () => {
  const s = setup(), { world } = s;
  const pending = now => { const state = s.sample(now); return [state.async_pending, state.async_files_known]; };
  assert.deepEqual(pending(0), [false, true]);
  world.i32(TRANSITION + 64, 10);
  assert.deepEqual(pending(10), [true, true]);
  world.i32(TRANSITION + 64, 40);
  assert.deepEqual(pending(20), [false, true]);
  world.i32(TRANSITION + 120, 3); // flash frames
  assert.deepEqual(pending(30), [true, true]);
  world.i32(TRANSITION + 120, 0);
  world.i32(world.sceneMap + 60, 5); // Scene delay_frames
  assert.deepEqual(pending(40), [true, true]);
  world.i32(world.sceneMap + 60, 0);
  assert.deepEqual(pending(50), [false, true]);

  const important = world.importantRequest + 12, optional = world.optionalRequest + 12;
  for (const [state, expected] of [[3, true], [0, true], [2, false], [1, false]]) {
    world.i32(important + 56, state);
    assert.deepEqual(pending(60), [expected, true], `important request state ${state}`);
  }
  world.i32(optional + 56, 3);
  assert.deepEqual(pending(70), [false, true]);
  world.u8(optional + 60, 1);
  assert.deepEqual(pending(80), [true, true]);
  world.i32(optional + 56, 1);
  // A corrupted chain makes the file state unknown rather than pending.
  world.u32(world.importantRequest, world.vptr.party);
  assert.deepEqual(pending(90), [false, false]);
});

test('reads continue after memory growth replaces the heap buffer', () => {
  const s = setup(), { world } = s;
  assert.deepEqual(s.sample(0), MAP_STATE);
  const nav = s.navigation();
  const old = world.grow(4 << 20);
  assert.notEqual(world.module.HEAPU8.buffer, old);
  assert.deepEqual(s.sample(10), MAP_STATE);
  // The new buffer is read; writes to the detached one are not.
  new DataView(old).setInt32(world.player + 16 + 8, 1, true);
  world.character(world.player, { x: 6 });
  assert.equal(s.sample(20, [6, 3]).player_x, 6);
  assert.deepEqual(s.query({ switches: [1], items: [7] }), { switches: { 1: 1 }, items: { 7: 1 }, skills: {} });
  assert.deepEqual(s.navigation().passages, nav.passages);
  assert.equal(s.calls.decode, 1);
  // A different Module object starts over.
  const other = { HEAPU8: world.module.HEAPU8 };
  assert.equal(s.memory.sample(other, [6, 3], 30).available, true);
  assert.equal(s.calls.decode, 2);
});

test('query reads switches, items and skills like the local engine exports', () => {
  const s = setup(), { world } = s;
  assert.equal(s.memory.query(world.module, { switches: [1] }), null, 'no sample yet');
  s.sample(0);
  const result = s.query({
    switches: [1, 2, 32, 33, 34, 40, 41, 100, 101, 0, -1, 1.5],
    items: [3, 7, 12, 99],
    skills: [[1, 9], [1, 5], [1, 6], [2, 5], [3, 1], [4, 1], [0, 1]],
  });
  assert.deepEqual(result, {
    // Bit id-1; beyond the vector but within lower_limit reads 0; invalid ids -1.
    switches: { 1: 1, 2: 0, 32: 1, 33: 1, 34: 0, 40: 1, 41: 0, 100: 0, 101: -1, 0: -1, '-1': -1, 1.5: null },
    // Index of the first match.
    items: { 3: 0, 7: 1, 12: 3, 99: -1 },
    // Actor 3's slot holds ID 99, so neither it nor out-of-range actors are trusted.
    skills: { '1:9': true, '1:5': true, '1:6': false, '2:5': false, '3:1': null, '4:1': null, '0:1': null },
  });
  assert.deepEqual(s.query({}), { switches: {}, items: {}, skills: {} });
  // Skills read false outside a map, like the local engine.
  world.setScene(world.sceneItem);
  s.sample(10);
  assert.deepEqual(s.query({ skills: [[1, 9], [3, 1]] }).skills, { '1:9': false, '3:1': false });
  world.setScene(world.sceneMap);
  s.sample(20);
  // A party object that is not Game_Party is unknown.
  world.u32(world.party, world.vptr.enemyParty);
  assert.deepEqual(s.query({ items: [7] }).items, { 7: null });
  // A switch vector whose size exceeds its capacity is unknown.
  world.u32(world.switches + 4, 65);
  assert.deepEqual(s.query({ switches: [1] }).switches, { 1: null });
});

// Chipset fixture: passages_down/up flags (down 1, left 2, right 4, up 8, Above 0x10, Wall 0x20)
// and tile substitutions.
function chipset(world) {
  const { down, up, lowerTiles, upperTiles } = world.tables;
  for (const [tile, flags] of [[0, 0x0f], [1, 0x09], [2, 0x00], [4, 0x06], [5, 0x0c], [7, 0x20], [8, 0x01],
    [18, 0x0a], [21, 0x0f], [28, 0x05]]) world.u8(down + tile, flags);
  for (const [tile, flags] of [[5, 0x0f], [6, 0x00], [7, 0x13], [11, 0x02], [12, 0x1f]]) world.u8(up + tile, flags);
  world.u8(lowerTiles + 3, 10); // BLOCK_E 3 -> 10 (+18 = chip 28, not 21)
  world.u8(upperTiles + 9, 6); // BLOCK_F 9 -> 6 (blocked)
}

const GEOMETRY = {
  lower: [0, 1000, 2000, 0, 0, 1000, 3050, 3107, 4070, 4060, 4146, 4095, 5003, 5000, 0, 0, ...Array(16).fill(0)],
  upper: [10000, 10000, 10005, 10006, 10007, 10007, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10009,
    10000, ...Array(16).fill(10000)],
  passages: [
    15, 9, 15, 0, 3, 1, 6, 12, // BLOCK_A/B, upper without Above, upper Above & lower, BLOCK_C
    15, 0, 1, 15, 5, 10, 0, 15, // BLOCK_D wall shapes, BLOCK_E substitution, upper substitution
    ...Array(16).fill(15),
  ],
};

test('navigation ports the chipset rules of IsPassableTile and IsPassableLowerTile', () => {
  const s = setup(), { world } = s;
  chipset(world);
  world.setMap({ width: 8, height: 4, lower: GEOMETRY.lower, upper: GEOMETRY.upper });
  world.setEvents([]);
  assert.equal(s.memory.navigation(world.module), null, 'no sample yet');
  s.sample(0);
  const nav = s.navigation();
  assert.equal(nav.width, 8);
  assert.equal(nav.height, 4);
  assert.equal(nav.loopHorizontal, false);
  assert.equal(nav.loopVertical, false);
  assert.deepEqual(nav.static, GEOMETRY.passages);
  assert.deepEqual(nav.passages, GEOMETRY.passages);
  assert.deepEqual(nav.obstacles, []);
  assert.deepEqual(nav.events, []);
  assert.equal(typeof nav.revision, 'string');
  // Without the substitutions the identity tables apply.
  world.u8(world.tables.lowerTiles + 3, 3); world.u8(world.tables.upperTiles + 9, 9);
  const identity = s.navigation();
  assert.equal(identity.static[12], 15, 'BLOCK_E 3 -> chip 21');
  assert.equal(identity.static[14], 15, 'BLOCK_F 9 -> chip 9');
  assert.notEqual(identity.revision, nav.revision);
  // Out-of-range layers or substitutions are not guessed.
  world.setMap({ width: 8, height: 4, upper: [9999, ...Array(31).fill(10000)] });
  assert.equal(s.memory.navigation(world.module), null);
  world.setMap({ width: 8, height: 4, lower: [5000 + 144, ...Array(31).fill(0)] });
  assert.equal(s.memory.navigation(world.module), null);
});

test('BLOCK_D wall autotile shapes are fully passable only with the Wall flag', () => {
  const s = setup(), { world } = s;
  chipset(world);
  const shapes = Array.from({ length: 50 }, (_, shape) => shape);
  // Row 0: chip 7 (Wall, no directions); row 1: chip 8 (down only, no Wall flag).
  world.setMap({ width: 50, height: 2, lower: [...shapes.map(shape => 4050 + shape), ...shapes.map(shape => 4100 + shape)],
    upper: Array(100).fill(10000) });
  world.setEvents([]);
  world.character(world.player, { x: 0, y: 0 });
  s.sample(0, [0, 0]);
  const walls = new Set([20, 21, 22, 23, 33, 34, 35, 36, 37, 42, 43, 45, 46]);
  const nav = s.navigation();
  assert.deepEqual(nav.static.slice(0, 50), shapes.map(shape => walls.has(shape) ? 15 : 0));
  assert.deepEqual(nav.static.slice(50), shapes.map(() => 1));
  // An upper tile with Above still restricts the wall.
  world.setMap({ width: 50, height: 2, lower: [...shapes.map(shape => 4050 + shape), ...shapes.map(shape => 4100 + shape)],
    upper: Array(100).fill(10007) });
  assert.equal(s.navigation().static[20], 3);
});

const EVENTS = [
  // Below-layer tile-sprite events (layer 0).
  { id: 1, x: 0, y: 2, layer: 0, spriteId: 11, page: 1 }, // overrides with up[11] = left
  { id: 2, x: 1, y: 2, layer: 0, spriteId: 12 }, // up[12] has Above: no override
  { id: 3, x: 2, y: 2, layer: 0, spriteId: 11, sprite: 'chara' }, // character sprite
  { id: 4, x: 3, y: 2, layer: 0, spriteId: 11, through: true },
  { id: 5, x: 4, y: 2, layer: 0, spriteId: 11, active: false },
  { id: 6, x: 5, y: 2, layer: 0, spriteId: 11, page: null },
  { id: 7, x: 6, y: 2, layer: 0, spriteId: 11 },
  { id: 8, x: 6, y: 2, layer: 0, spriteId: 0 }, // the last one wins, even with tile 0
  { id: 9, x: 7, y: 0, layer: 0, spriteId: 0 },
  { id: 10, x: 7, y: 0, layer: 0, spriteId: 11 },
  // Same-layer characters (layer 1).
  { id: 11, x: 0, y: 3 },
  { id: 12, x: 1, y: 3, through: true },
  { id: 13, x: 2, y: 3, flying: true },
  { id: 14, x: 3, y: 3, active: false },
  { id: 15, x: 4, y: 3, layer: 2 },
  { id: 16, x: 5, y: 3 }, // on the player's own tile
  { id: 17, x: 7, y: 2, layer: 0, spriteId: 11, sprite: 'LongSpriteName01', page: 'foreign' },
  { id: 18, x: 20, y: 1 }, // outside the map
];

function liveWorld() {
  const s = setup(), { world } = s;
  chipset(world);
  world.setMap({ width: 8, height: 4, lower: GEOMETRY.lower, upper: GEOMETRY.upper });
  const events = world.setEvents(EVENTS);
  world.vehicle(0, { mapId: 42, x: 6, y: 3 }); // boat on this map
  world.vehicle(1, { mapId: 41, x: 7, y: 3 }); // ship elsewhere
  world.vehicle(2, { mapId: 42, x: 7, y: 1 }); // airship never blocks
  assert.equal(s.sample(0).available, true);
  return { ...s, events };
}

test('navigation overlays tile events, character collisions and vehicles', () => {
  const s = liveWorld();
  const nav = s.navigation();
  assert.deepEqual(nav.static, GEOMETRY.passages);
  const expected = GEOMETRY.passages.slice();
  expected[7] = 2; // event 10 replaces chip 5 at (7,0)
  expected[16] = 2; // event 1 at (0,2)
  expected[24] = 0; // event 11
  expected[30] = 0; // boat
  assert.deepEqual(nav.passages, expected);
  assert.deepEqual(nav.obstacles, [24, 30]);
  assert.deepEqual(nav.events, EVENTS.map(({ id, x, y, layer = 1, through = false, flying = false, active = true, page = 0 }) => ({
    id, x, y, layer, through, flying, active, page: page === null ? -1 : page === 'foreign' ? null : page })));
  assert.equal(s.navigation().revision, nav.revision, 'stable while nothing changes');

  // Characters move: the overlay follows without touching the static geometry.
  s.world.character(s.events + 10 * EVENT_SIZE, { x: 1 });
  const moved = s.navigation();
  assert.equal(moved.passages[24], 15);
  assert.equal(moved.passages[25], 0);
  assert.deepEqual(moved.obstacles, [25, 30]);
  assert.deepEqual(moved.static, GEOMETRY.passages);
  assert.notEqual(moved.revision, nav.revision);
  // A later tile event at the same tile with tile 0 cancels the earlier override.
  s.world.character(s.events + 9 * EVENT_SIZE, { spriteId: 0 });
  assert.equal(s.navigation().passages[7], 12);
  // The ship collides once it is on this map; the airship never does.
  s.world.vehicle(1, { mapId: 42 });
  s.world.vehicle(2, { x: 7, y: 2 });
  const vehicles = s.navigation();
  assert.deepEqual(vehicles.obstacles, [25, 30, 31]);
  assert.equal(vehicles.passages[23], 15);
  // A non-event in the event vector invalidates the whole snapshot.
  s.world.u32(s.events, s.world.vptr.vehicle);
  assert.equal(s.memory.navigation(s.world.module), null);
});

test('navigation honours player through, vehicles, scenes and map loops', () => {
  const s = liveWorld(), { world } = s;
  world.character(world.player, { through: 1 });
  let nav = s.navigation();
  assert.deepEqual(nav.passages, Array(32).fill(15));
  assert.deepEqual(nav.static, GEOMETRY.passages);
  assert.deepEqual(nav.obstacles, []);
  world.character(world.player, { through: 0 });
  assert.equal(s.navigation().passages[24], 0);
  // A flying or inactive player collides with nothing.
  world.character(world.player, { flying: 1 });
  assert.deepEqual(s.navigation().obstacles, []);
  world.character(world.player, { flying: 0 });

  for (const [scroll, loopHorizontal, loopVertical] of [[0, false, false], [1, false, true], [2, true, false], [3, true, true]]) {
    world.i32(world.mapObject + 24, scroll);
    nav = s.navigation();
    assert.deepEqual([nav.loopHorizontal, nav.loopVertical], [loopHorizontal, loopVertical], `scroll ${scroll}`);
  }
  world.i32(world.mapObject + 24, 4);
  assert.equal(s.memory.navigation(world.module), null);
  world.i32(world.mapObject + 24, 0);

  // Vehicle passability is not modelled.
  world.character(world.player, { vehicle: 1 });
  assert.equal(s.memory.navigation(world.module), null);
  world.character(world.player, { vehicle: 0 });
  assert.equal(s.navigation().width, 8);

  // Only Map scenes have live passability.
  world.setScene(world.sceneMenu);
  s.sample(100);
  assert.equal(s.memory.navigation(world.module), null);
  world.setScene(world.sceneMap);
  s.sample(200);
  assert.equal(s.navigation().width, 8);
  // The vehicle vector must hold all three vehicles.
  world.vector(MAP + 4, world.vehicles, 2, VEHICLE_SIZE);
  assert.equal(s.memory.navigation(world.module), null);
});

test('navigation refreshes cached geometry after an in-place chipset change', () => {
  const s = liveWorld(), { world } = s;
  assert.equal(s.navigation().static[0], 15);
  world.u8(world.tables.down, 0x03);
  assert.equal(s.navigation().static[0], 3);
  world.u8(world.tables.up + 6, 0x0f);
  assert.equal(s.navigation().static[3], 15);
});

// Game_Map::ReplaceTileAt (Maniac Patch tile rewrites via TilemapLayer::RecreateTileDataAt)
// edits map->lower_layer/upper_layer in place, so their addresses do not change.
test('navigation refreshes cached geometry after in-place tile layer rewrites within a second', () => {
  const s = liveWorld(), { world } = s;
  assert.equal(s.navigation().static[0], 15);
  const lower = new DataView(world.module.HEAPU8.buffer).getUint32(world.mapObject + 120, true);
  world.i16(lower, 2000); // (0,0) -> chip 2, no directions
  const upper = new DataView(world.module.HEAPU8.buffer).getUint32(world.mapObject + 132, true);
  world.i16(upper + 2 * 2, 10006); // (2,0) -> upper chip 6, blocked
  // Layer contents are hashed at most once per second of sample time.
  assert.equal(s.sample(999).available, true);
  assert.equal(s.navigation().static[0], 15, 'cached within a second');
  assert.equal(s.sample(1000).available, true);
  const nav = s.navigation();
  assert.equal(nav.static[0], 0, 'lower layer rewrite');
  assert.equal(nav.static[2], 0, 'upper layer rewrite');
});

test('never writes to engine memory', () => {
  const s = liveWorld(), { world } = s;
  const unchanged = action => {
    const before = world.snapshot();
    action();
    assert.equal(Buffer.compare(before, world.snapshot()), 0);
  };
  unchanged(() => {
    s.sample(10);
    s.sample(20, [9, 9]);
    s.sample(2100);
    s.query({ switches: [1, 41, 101], items: [7, 99], skills: [[1, 9], [3, 1]] });
    s.navigation();
    s.navigation();
    s.memory.status();
  });
  world.character(world.player, { through: 1 });
  world.setScene(world.sceneItem);
  unchanged(() => {
    s.sample(2200);
    s.query({ skills: [[1, 9]] });
    s.memory.navigation(world.module);
  });
  world.setScene(world.sceneTitle);
  unchanged(() => { s.sample(2300); s.memory.reset(); s.sample(2400); });
  world.grow(3 << 20);
  world.setScene(world.sceneMap);
  unchanged(() => { s.sample(2500); s.navigation(); s.query({ items: [7] }); });
});

test('missing RTTI is reported once and not rescanned until reset', () => {
  const s = setup({ omit: ['11Game_Player'] });
  const error = 'Official engine RTTI is missing 11Game_Player';
  assert.deepEqual(s.sample(0), { available: false, error });
  assert.equal(s.calls.decode, 1);
  for (const now of [1, 500, 1999]) {
    assert.deepEqual(s.sample(now), { available: false, error });
  }
  assert.equal(s.calls.decode, 1, 'no rescan within 2000 ms');
  assert.deepEqual(plain(s.memory.status()), { types: false, anchors: null, error });
  assert.equal(s.memory.query(s.world.module, { switches: [1] }), null);
  assert.equal(s.memory.navigation(s.world.module), null);
  // RTTI is static data, so a missing class is never rescanned for this engine.
  for (const now of [2000, 60000, 600000]) assert.deepEqual(s.sample(now), { available: false, error });
  assert.equal(s.calls.decode, 1);
  // reset() (a new engine) scans again.
  s.memory.reset();
  s.sample(600001);
  assert.equal(s.calls.decode, 2);
});

test('discovery works without TextDecoder and on the host realm', () => {
  const s = setup({ decoder: false });
  assert.deepEqual(s.sample(0), MAP_STATE);
  const memory = createOfficialMemory(), world = createWorld(ArrayBuffer);
  assert.deepEqual(plain(memory.sample(world.module, [5, 3], 0)), MAP_STATE);
});

test('heaps that are missing or too small are unavailable', () => {
  const { memory, ArrayBuffer: Buffer } = load();
  const unavailable = { available: false, error: 'Engine memory is not available yet' };
  assert.deepEqual(plain(memory.sample({}, [0, 0], 0)), unavailable);
  assert.deepEqual(plain(memory.sample(null, [0, 0], 0)), unavailable);
  assert.deepEqual(plain(memory.sample({ HEAPU8: new Uint8Array(new Buffer(0x8000)) }, [0, 0], 0)), unavailable);
  // An empty but large heap has no RTTI.
  assert.deepEqual(plain(memory.sample({ HEAPU8: new Uint8Array(new Buffer(0x20000)) }, [0, 0], 0)),
    { available: false, error: 'Official engine RTTI is missing 11Game_Player' });
});

test('repeated coordinate mismatches back off before rescanning, then recover', () => {
  const s = setup();
  assert.equal(s.sample(0).available, true);
  const wrong = [99, 99];
  assert.equal(s.sample(10, wrong).available, false);
  assert.equal(s.sample(2009).available, false, 'waits 2 s after the first mismatch');
  assert.equal(s.sample(2010, wrong).available, false);
  assert.equal(s.sample(6009).available, false, 'then 4 s');
  assert.equal(s.sample(6010, wrong).available, false);
  assert.equal(s.sample(14009).available, false, 'then 8 s');
  assert.equal(s.sample(14010).available, true);
  // A good sample resets the delay.
  assert.equal(s.sample(14020, wrong).available, false);
  assert.equal(s.sample(16020).available, true);
  assert.equal(s.calls.decode, 1, 'type information is never rescanned');
});
