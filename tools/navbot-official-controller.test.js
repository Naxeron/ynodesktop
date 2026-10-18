'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createOfficialController } = require('../src/navbot/official-controller');
const { createPlanner } = require('../src/navbot/official-path');

function map(width = 5, height = 3, loops = {}) {
  return { width, height, loopHorizontal: false, loopVertical: false, passages: Array(width * height).fill(15), ...loops };
}

// The verified official-memory sample() shape; tests override single fields.
const engineDefaults = {
  available: true, error: null, scene: 'Map', frame_count: 0, direction: 2, facing: 2,
  moving: false, jumping: false, move_speed: 4, vehicle_type: 0, player_paused: false,
  move_route_overwritten: false, through: false, teleport_pending: false, event_running: false,
  message_active: false, async_pending: false, async_files_known: true, menu_allowed: true,
  selected_item_id: 0, title_index: null, title_continue_enabled: null, title_new_game_index: null,
  title_continue_index: null, file_index: null, menu_index: null,
};
const turns = { up: 0, right: 1, down: 2, left: 3 };
// Values created inside the vm context have that realm's prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ mapId = 10, x = 0, y = 0, navigation = map(), transfers = [], exitInteractions = [], canMove = () => true, onHold = () => {},
  memory = null, live = null, query = null } = {}) {
  const state = {
    ready: true, map_known: true, map_id: mapId, player_x: x, player_y: y,
    frame: 0, position_changed_frame: 0, teleport_sequence: 0,
    teleport_map_id: null, teleport_x: null, teleport_y: null,
    time_ms: 0, position_changed_ms: 0,
    held_key: null, hold_remaining: 0, error: null,
    ...(memory ? { memory: { ...engineDefaults, ...memory } } : {}),
  };
  const commands = [], subscribers = [];
  let holdUntil = 0;
  const input = {
    read: () => ({ ...state, ...(state.memory ? { memory: { ...state.memory } } : {}) }),
    // Live CheckWay passability; null (the default) means unavailable.
    navigation: () => typeof live === 'function' ? live(state) : live,
    subscribe: callback => subscribers.push(callback),
    stop() { state.held_key = null; state.hold_remaining = 0; },
    hold(key, loops) {
      commands.push({ key, loops, frame: state.frame });
      state.held_key = key; state.hold_remaining = loops;
      holdUntil = state.time_ms + loops * 1000 / 60;
      onHold(key, state);
    },
  };
  if (query) input.query = query;
  const context = vm.createContext({ input });
  const controller = vm.runInContext(`(${createOfficialController})(input, (${createPlanner})())`, context);
  controller.installMap(mapId, navigation, transfers, exitInteractions);
  return {
    controller, state, commands, input,
    tick(count = 1, ms = 17) {
      for (let i = 0; i < count; ++i) {
        ++state.frame;
        state.time_ms += ms;
        if (state.memory) ++state.memory.frame_count;
        if (state.hold_remaining > 0) {
          const direction = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] }[state.held_key];
          if (direction && state.frame % 8 === 0 && Number.isInteger(state.player_x) && Number.isInteger(state.player_y)) {
            // The engine turns the player even when the step is blocked.
            if (state.memory) state.memory.direction = turns[state.held_key];
            let nx = state.player_x + direction[0], ny = state.player_y + direction[1];
            if (navigation.loopHorizontal) nx = (nx + navigation.width) % navigation.width;
            if (navigation.loopVertical) ny = (ny + navigation.height) % navigation.height;
            if (nx >= 0 && ny >= 0 && nx < navigation.width && ny < navigation.height && canMove(state, state.held_key, nx, ny)) {
              state.player_x = nx; state.player_y = ny; state.position_changed_frame = state.frame;
              state.position_changed_ms = state.time_ms;
            }
          }
          state.hold_remaining = Math.max(0, Math.ceil((holdUntil - state.time_ms) * 60 / 1000));
          if (state.hold_remaining === 0) state.held_key = null;
        }
        for (const callback of subscribers) callback(input.read());
      }
    },
    teleport(nextMap, nextX, nextY, nextNavigation = navigation) {
      input.stop();
      Object.assign(state, { map_id: nextMap, player_x: nextX, player_y: nextY, position_changed_frame: state.frame, position_changed_ms: state.time_ms });
      Object.assign(state, { teleport_map_id: nextMap, teleport_x: nextX, teleport_y: nextY });
      ++state.teleport_sequence;
      navigation = nextNavigation;
    },
    install(nextTransfers = transfers, nextInteractions = exitInteractions) { controller.installMap(state.map_id, navigation, nextTransfers, nextInteractions); },
  };
}

test('official controller reaches observed coordinates through keys and reports state it cannot observe as unknown', () => {
  const p = fixture();
  p.controller.start(10, 3, 1);
  p.tick(100);
  const state = p.controller.read();
  assert.equal(state.status, 'arrived');
  assert.equal(state.active, false);
  assert.equal(state.player_x, 3);
  assert.equal(state.player_y, 1);
  assert.equal(state.held_key, null);
  for (const key of ['scene', 'moving', 'event_running', 'message_active', 'async_pending', 'move_route_overwritten']) {
    assert.equal(state[key], null, key);
  }
  assert.equal(state.observed_stationary, true);
  assert.ok(p.commands.length > 0);
  assert.ok(p.commands.every(command => command.loops <= 120));
});

test('fast callbacks preserve the half-second arrival dwell and 1.5-second blocked-step window', () => {
  const arrived = fixture();
  arrived.controller.start(10, 0, 0);
  arrived.tick(166, 3);
  assert.equal(arrived.controller.read().active, true);
  arrived.tick(1, 2);
  assert.equal(arrived.controller.read().status, 'arrived');

  const blocked = fixture({ canMove: () => false });
  blocked.controller.start(10, 2, 0);
  blocked.tick(501, 3);
  assert.equal(blocked.commands.length, 1);
  assert.equal(blocked.commands[0].key, 'right');
  blocked.tick(1, 3);
  assert.equal(blocked.commands.length, 2);
  assert.equal(blocked.commands[1].key, 'down');
});

test('route and navigation deadlines measure milliseconds rather than callback counts', () => {
  const exit = fixture();
  exit.controller.start(11, 0, 0, [{ mapId: 10, startX: 0, startY: 0, targetMapId: 11, action: false }]);
  exit.tick(5000, 1);
  assert.equal(exit.controller.read().status, 'waiting_for_teleport');
  exit.state.time_ms = 20501;
  exit.tick(1, 0);
  assert.match(exit.controller.read().last_error, /exit did not reach/);

  const navigation = fixture();
  navigation.controller.start(10, 2, 0);
  navigation.state.player_x = navigation.state.player_y = null;
  navigation.tick(12000, 1);
  assert.equal(navigation.controller.read().active, true);
  navigation.state.time_ms = 180001;
  navigation.tick(1, 0);
  assert.match(navigation.controller.read().last_error, /Navigation timed out/);
});

test('arrival requires a quiet observation interval rather than just the first target coordinate', () => {
  const p = fixture();
  p.controller.start(10, 1, 0);
  p.tick(8);
  assert.equal(p.state.player_x, 1);
  assert.equal(p.controller.read().active, true);
  assert.equal(p.state.held_key, null);
  p.tick(29);
  assert.equal(p.controller.read().active, true);
  p.tick();
  assert.equal(p.controller.read().status, 'arrived');
});

test('wrapping destination takes the map loop edge', () => {
  const p = fixture({ navigation: map(5, 2, { loopHorizontal: true }) });
  p.controller.start(10, 4, 0);
  p.tick(50);
  assert.equal(p.commands[0].key, 'left');
  assert.equal(p.state.player_x, 4);
  assert.equal(p.controller.read().status, 'arrived');
});

test('an event blocking a planned step produces an observed blocker and a bounded detour', () => {
  const p = fixture({ navigation: map(3, 2), canMove: (state, direction) => !(state.player_x === 0 && state.player_y === 0 && direction === 'right') });
  p.controller.start(10, 2, 0);
  p.tick(170);
  assert.equal(p.commands[0].key, 'right');
  assert.equal(p.commands[1].key, 'down');
  assert.equal(p.controller.read().status, 'arrived');
  assert.equal(p.state.player_x, 2);
  assert.equal(p.state.player_y, 0);
});

test('a touch exit consumes the matching map transition and waits for new collision data', () => {
  const p = fixture({ navigation: map(3, 2) });
  p.controller.start(11, 2, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false }]);
  p.tick(8);
  assert.equal(p.state.player_x, 1);
  p.teleport(11, 0, 0);
  p.tick(2);
  assert.equal(p.controller.read().status, 'settling_after_teleport');
  p.tick(30);
  assert.equal(p.controller.read().status, 'loading_map');
  assert.equal(p.state.held_key, null);
  p.install();
  p.tick(80);
  assert.equal(p.controller.read().status, 'arrived');
  assert.equal(p.state.player_x, 2);
  assert.equal(p.commands.some(command => command.key === 'decision'), false);
});

test('an ordinary graph door approaches once and presses decision using loaded event metadata', () => {
  const p = fixture({ x: 0, y: 1,
    exitInteractions: [{ eventId: 7, startX: 2, startY: 1,
      pages: [{ trigger: 0, layer: 1, targetMapIds: [11], unsupported: false }] }],
    canMove: (_state, _direction, x, y) => x !== 2 || y !== 1,
    onHold(key, state) {
      if (key !== 'decision') return;
      assert.deepEqual([state.player_x, state.player_y], [1, 1]);
      Object.assign(state, { map_id: 11, player_x: 0, player_y: 0,
        teleport_map_id: 11, teleport_x: 0, teleport_y: 0, held_key: null, hold_remaining: 0 });
      ++state.teleport_sequence;
    },
  });
  p.controller.execute(['_Navbot_GoToMap', [11, 2, 0],
    [{ mapId: 10, startX: 2, startY: 1, targetMapId: 11, targetX: 0, targetY: 0 }]]);
  p.tick(100);
  assert.deepEqual(p.commands.map(command => command.key), ['right', 'right', 'decision']);
  assert.equal(p.controller.read().status, 'loading_map');
  assert.equal(p.state.held_key, null);
  p.install([], []);
  p.tick(80);
  assert.equal(p.controller.read().status, 'arrived');
  assert.equal(p.state.player_x, 2);
});

test('a graph touch exit walks into the event without an unrelated decision press', () => {
  const p = fixture({ exitInteractions: [{ eventId: 3, startX: 1, startY: 0,
    pages: [{ trigger: 1, layer: 0, targetMapIds: [11], unsupported: false }] }] });
  p.controller.execute(['_Navbot_GoToMap', [11, 0, 0],
    [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 }]]);
  p.tick(8);
  assert.equal(p.state.player_x, 1);
  p.teleport(11, 0, 0);
  p.tick(32);
  assert.equal(p.controller.read().status, 'loading_map');
  assert.equal(p.commands.some(command => command.key === 'decision'), false);
  assert.equal(p.state.held_key, null);
});

test('a directional touch exit approaches from below and accepts a callback during facing or activation', () => {
  for (const phase of ['facing', 'activation']) {
    let upwardHolds = 0;
    const p = fixture({ x: 0, y: 1, navigation: map(3, 3),
      exitInteractions: [{ eventId: 3, startX: 1, startY: 1,
        pages: [{ trigger: 1, layer: 0, targetMapIds: [11], direction: 0, unsupported: false }] }],
      canMove: (_state, _direction, x, y) => x !== 1 || y !== 1,
      onHold(key, state) {
        if (key !== 'up') return;
        assert.deepEqual([state.player_x, state.player_y], [1, 2]);
        if (++upwardHolds < (phase === 'facing' ? 1 : 2)) return;
        Object.assign(state, { map_id: 11, player_x: 0, player_y: 0,
          teleport_map_id: 11, teleport_x: 0, teleport_y: 0, held_key: null, hold_remaining: 0 });
        ++state.teleport_sequence;
      },
    });
    p.controller.execute(['_Navbot_GoToMap', [11, 0, 0],
      [{ mapId: 10, startX: 1, startY: 1, targetMapId: 11, targetX: 0, targetY: 0 }]]);
    p.tick(100);
    assert.deepEqual(p.commands.map(command => command.key),
      phase === 'facing' ? ['down', 'right', 'up'] : ['down', 'right', 'up', 'up']);
    assert.equal(p.controller.read().status, 'loading_map');
    assert.equal(p.state.held_key, null);
  }
});

test('an unreachable explicit approach stops instead of activating from an adjacent wrong tile', () => {
  for (const action of [false, true]) {
    const navigation = map(3, 3);
    navigation.passages[4] = 0;
    const p = fixture({ x: 0, y: 1, navigation });
    p.controller.start(11, 0, 0, [{ mapId: 10, startX: 1, startY: 0, approachX: 1, approachY: 1,
      action, direction: 0, targetMapId: 11, targetX: 0, targetY: 0 }]);
    p.tick(100);
    assert.equal(p.controller.read().status, 'error');
    assert.match(p.controller.read().last_error, /required teleport approach/);
    assert.deepEqual(p.commands, []);
  }
});

test('missing, conflicting or scripted interaction metadata stops before circling the event', () => {
  const action = { trigger: 0, layer: 1, targetMapIds: [11], unsupported: false };
  for (const pages of [null, [action, { ...action, trigger: 1, layer: 0 }], [{ ...action, unsupported: true }]]) {
    const p = fixture({ exitInteractions: pages ? [{ eventId: 3, startX: 2, startY: 0, pages }] : [] });
    p.controller.execute(['_Navbot_GoToMap', [11, 0, 0],
      [{ mapId: 10, startX: 2, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 }]]);
    p.tick(100);
    assert.equal(p.controller.read().status, 'error');
    assert.ok(p.controller.read().last_error);
    assert.deepEqual(p.commands, []);
    assert.equal(p.state.held_key, null);
  }
});

test('reviewed bedroom action accepts transient map 900 while waiting for map 5', () => {
  const p = fixture({ mapId: 2, x: 8, y: 5, navigation: map(12, 10) });
  p.controller.start(5, 1, 1, [{ mapId: 2, startX: 7, startY: 5, approachX: 8, approachY: 5, direction: 3, action: true, targetMapId: 5, targetX: 1, targetY: 1, transientMapIds: [900] }]);
  p.tick(34);
  assert.deepEqual(p.commands.map(command => command.key), ['left', 'decision']);
  p.teleport(900, null, null);
  p.tick(50);
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
  assert.equal(p.state.held_key, null);
  assert.equal(p.commands.length, 2);
  p.teleport(5, 1, 1);
  p.install();
  p.tick(35);
  assert.equal(p.controller.read().status, 'arrived');
});

test('unexpected exit map stops safely instead of carrying movement to the wrong map', () => {
  const p = fixture();
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, action: false }]);
  p.tick();
  p.teleport(12, 0, 0);
  p.tick();
  assert.equal(p.controller.read().status, 'error');
  assert.match(p.controller.read().last_error, /Unexpected map 12/);
  assert.equal(p.state.held_key, null);
});

test('Stop clears held movement and later ticks cannot restart it', () => {
  const p = fixture();
  p.controller.start(10, 4, 0);
  p.tick();
  assert.equal(p.state.held_key, 'right');
  p.controller.stop();
  const count = p.commands.length;
  p.tick(200);
  assert.equal(p.commands.length, count);
  assert.equal(p.state.player_x, 0);
  assert.equal(p.state.held_key, null);
  assert.equal(p.controller.read().status, 'stopped');
});

test('a new destination releases the old step before planning movement in another direction', () => {
  const p = fixture();
  p.controller.start(10, 4, 0);
  p.tick();
  p.controller.start(10, 0, 2);
  assert.equal(p.state.held_key, null);
  p.tick(80);
  assert.deepEqual(p.commands.map(command => command.key), ['right', 'down', 'down']);
  assert.equal(p.state.player_x, 0);
  assert.equal(p.state.player_y, 2);
  assert.equal(p.controller.read().status, 'arrived');
});

test('unavailable coordinates wait without treating null as a tile', () => {
  const p = fixture();
  p.controller.start(10, 2, 0);
  p.state.player_x = p.state.player_y = null;
  p.tick();
  assert.equal(p.controller.read().active, true);
  assert.equal(p.commands.length, 0);
  p.state.player_x = p.state.player_y = 0;
  p.tick(80);
  assert.equal(p.controller.read().status, 'arrived');
});

test('same-map exits require a new teleport and exact landing before the next route edge', () => {
  const p = fixture({ navigation: map(7, 1), canMove: () => false });
  const transfer = { mapId: 10, startX: 0, startY: 0, targetMapId: 10, targetX: 4, targetY: 0, action: false, settleMs: 3500 };
  const exit = { mapId: 10, startX: 6, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false };
  p.controller.start(11, 2, 0, [transfer, exit]);
  p.tick(100);
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
  assert.equal(p.controller.read().route_length, 2);
  p.teleport(10, 4, 0);
  p.tick();
  assert.equal(p.controller.read().status, 'settling_after_teleport');
  p.tick(200);
  assert.equal(p.controller.read().route_length, 2);
  assert.equal(p.state.held_key, null);
  p.tick(7);
  assert.equal(p.controller.read().route_length, 1);
  assert.equal(p.controller.read().target_map_id, 11);
  assert.equal(p.controller.read().target_x, 2);
});

test('landing coordinates alone cannot consume a same-map exit without a teleport callback', () => {
  const p = fixture();
  p.controller.start(10, 3, 0, [{ mapId: 10, startX: 0, startY: 0, targetMapId: 10, targetX: 2, targetY: 0, action: false }]);
  p.tick(31);
  p.state.player_x = 2;
  p.tick(100);
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
  assert.equal(p.controller.read().route_length, 1);
  assert.equal(p.state.held_key, null);
});

test('same-map teleport during the final walking step is recognized before a waiting phase exists', () => {
  const p = fixture();
  p.controller.start(10, 4, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 10, targetX: 3, targetY: 0, action: false }]);
  p.tick(8);
  assert.equal(p.state.player_x, 1);
  p.teleport(10, 3, 0);
  p.tick();
  assert.equal(p.controller.read().status, 'settling_after_teleport');
  assert.equal(p.state.held_key, null);
  p.tick(90);
  assert.equal(p.controller.read().status, 'arrived');
  assert.equal(p.state.player_x, 4);
});

test('unexpected same-map transfers and unreviewed transient maps stop instead of continuing', () => {
  for (const mode of ['local', 'wrong-landing', 'unreviewed-transient']) {
    const p = fixture();
    const route = mode === 'local' ? [] : [{ mapId: 10, startX: 1, startY: 0, targetMapId: 10, targetX: 3, targetY: 0, action: false }];
    p.controller.start(10, 4, 0, route);
    p.tick();
    p.teleport(mode === 'unreviewed-transient' ? 900 : 10, 2, 0);
    p.tick();
    assert.equal(p.controller.read().status, 'error', mode);
    assert.match(p.controller.read().last_error, /Unexpected/);
    assert.equal(p.state.held_key, null);
  }
});

test('an explicit touch approach walks into the exit without pressing decision', () => {
  const p = fixture({ x: 1, canMove: () => false });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 2, startY: 0, approachX: 1, approachY: 0,
    direction: 1, action: false, targetMapId: 11, targetX: 0, targetY: 0 }]);
  p.tick(34);
  assert.deepEqual(p.commands.map(command => command.key), ['right', 'right']);
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
  p.teleport(11, 0, 0);
  p.tick();
  assert.equal(p.controller.read().status, 'settling_after_teleport');
});

test('post-teleport settling waits for scripted movement and Stop cancels it permanently', () => {
  const p = fixture();
  p.controller.start(10, 4, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 10, targetX: 3, targetY: 0, action: false }]);
  p.tick(8);
  p.teleport(10, 3, 0);
  p.tick(20);
  p.state.position_changed_ms = p.state.time_ms;
  p.tick(20);
  assert.equal(p.controller.read().status, 'settling_after_teleport');
  assert.equal(p.state.held_key, null);
  const commands = p.commands.length;
  p.controller.stop();
  p.tick(100);
  assert.equal(p.controller.read().status, 'stopped');
  assert.equal(p.commands.length, commands);
});

test('settling has a deadline if scripted movement never becomes quiet', () => {
  const p = fixture();
  p.controller.start(10, 4, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 10, targetX: 3, targetY: 0, action: false }]);
  p.tick(8);
  p.teleport(10, 3, 0);
  p.tick();
  p.state.time_ms += 20001;
  p.state.position_changed_ms = p.state.time_ms;
  p.tick();
  assert.equal(p.controller.read().status, 'error');
  assert.equal(p.state.held_key, null);
});

test('teleport callback synchronous with the first key cannot race the sequence baseline', () => {
  let moved = false;
  const p = fixture({ onHold(key, state) {
    if (moved) return;
    moved = true;
    Object.assign(state, { map_id: 11, player_x: 0, player_y: 0, teleport_map_id: 11, teleport_x: 0, teleport_y: 0, held_key: null, hold_remaining: 0 });
    ++state.teleport_sequence;
  } });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false }]);
  p.tick(2);
  assert.equal(p.controller.read().status, 'settling_after_teleport');
  assert.equal(p.commands.length, 1);
  assert.equal(p.state.held_key, null);
});

test('reviewed local transfers connect disconnected regions without losing the remaining map route', () => {
  const navigation = map(7, 1);
  navigation.passages[3] = 0;
  const transfers = [{ mapId: 10, startX: 2, startY: 0, targetMapId: 10,
    targetX: 4, targetY: 0, action: false, reviewed: true }];
  const p = fixture({ navigation, transfers, canMove: (_state, _direction, x) => x !== 3 });
  p.controller.start(11, 1, 0, [{ mapId: 10, startX: 6, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false }]);
  p.tick(45);
  assert.equal(p.controller.read().route_length, 2);
  assert.equal(p.state.player_x, 2);
  p.teleport(10, 4, 0);
  p.tick(80);
  assert.equal(p.controller.read().route_length, 1);
  assert.equal(p.state.player_x, 6);
  assert.equal(p.controller.read().target_map_id, 11);
  p.teleport(11, 0, 0, map());
  p.install([]);
  p.tick(80);
  assert.equal(p.controller.read().status, 'arrived');
  assert.equal(p.state.player_x, 1);
  assert.equal(p.state.held_key, null);
});

test('on-tile actions enter facing the required direction and press decision without walking away', () => {
  const decisions = [];
  const p = fixture({ x: 0, y: 1, navigation: map(3, 3), onHold(key, state) {
    if (key === 'decision') decisions.push([state.player_x, state.player_y]);
  } });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 1, startY: 1,
    approachX: 1, approachY: 1, action: true, direction: 0, targetMapId: 11, targetX: 0, targetY: 0 }]);
  p.tick(100);
  assert.deepEqual(decisions, [[1, 1]]);
  assert.deepEqual(p.commands.slice(-2).map(command => command.key), ['up', 'decision']);
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
  assert.equal(p.state.player_x, 1);
  assert.equal(p.state.player_y, 1);
  p.teleport(11, 0, 0);
  p.install();
  p.tick(40);
  assert.equal(p.controller.read().status, 'arrived');
});

test('starting on an action tile with unknown facing steps off and back on exactly once', () => {
  const p = fixture({ x: 1, y: 1, navigation: map(3, 3) });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 1, startY: 1,
    approachX: 1, approachY: 1, action: true, direction: 0, targetMapId: 11, targetX: 0, targetY: 0 }]);
  p.tick(150);
  assert.deepEqual(p.commands.map(command => command.key), ['down', 'up', 'decision']);
  assert.equal(p.state.player_x, 1);
  assert.equal(p.state.player_y, 1);
});

test('Stop cancels an on-tile action approach before it presses decision', () => {
  const p = fixture({ x: 1, y: 1, navigation: map(3, 3) });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 1, startY: 1,
    approachX: 1, approachY: 1, action: true, direction: 0, targetMapId: 11, targetX: 0, targetY: 0 }]);
  p.tick(8);
  p.controller.stop();
  const commands = p.commands.length;
  p.tick(100);
  assert.equal(p.commands.length, commands);
  assert.equal(p.commands.some(command => command.key === 'decision'), false);
  assert.equal(p.controller.read().status, 'stopped');
  assert.equal(p.state.held_key, null);
});

test('an impossible on-tile facing approach fails without looping or pressing action', () => {
  const p = fixture({ x: 1, y: 1, navigation: map(3, 2) });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 1, startY: 1,
    approachX: 1, approachY: 1, action: true, direction: 0, targetMapId: 11, targetX: 0, targetY: 0 }]);
  p.tick(100);
  assert.equal(p.controller.read().status, 'error');
  assert.match(p.controller.read().last_error, /required direction/);
  assert.deepEqual(p.commands, []);
});

test('same-map landing validates callback coordinates when a script moves before the controller tick', () => {
  const p = fixture();
  p.controller.start(10, 4, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 10, targetX: 3, targetY: 0, action: false }]);
  p.tick(8);
  p.teleport(10, 3, 0);
  p.state.player_x = 4;
  p.tick();
  assert.equal(p.controller.read().status, 'settling_after_teleport');
  assert.equal(p.state.held_key, null);
  p.tick(40);
  assert.equal(p.controller.read().status, 'arrived');
  assert.equal(p.state.player_x, 4);
});

test('valid live coordinates cannot conceal an invalid or mismatched teleport callback landing', () => {
  for (const callbackX of [null, -1, 2]) {
    const p = fixture();
    p.controller.start(10, 4, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 10, targetX: 3, targetY: 0, action: false }]);
    p.tick(8);
    p.teleport(10, callbackX, 0);
    p.state.player_x = 3;
    p.tick();
    assert.equal(p.controller.read().status, 'error');
    assert.match(p.controller.read().last_error, /Unexpected/);
    assert.equal(p.state.held_key, null);
  }
});

test('engine pauses release keys with scene, message and event statuses, then resume navigation', () => {
  for (const [field, value, status] of [['scene', 'Menu', 'paused_scene'], ['message_active', true, 'paused_message'],
    ['event_running', true, 'paused_event'], ['move_route_overwritten', true, 'paused_event'], ['player_paused', true, 'paused_event']]) {
    const p = fixture({ memory: {} });
    p.controller.start(10, 4, 0);
    p.tick();
    assert.equal(p.state.held_key, 'right');
    const original = p.state.memory[field];
    p.state.memory[field] = value;
    p.tick();
    let state = p.controller.read();
    assert.equal(state.status, status, field);
    assert.equal(state.active, true, field);
    assert.equal(p.state.held_key, null, field);
    assert.deepEqual(plain(state.held_keys), [], field);
    const count = p.commands.length;
    p.tick(200);
    assert.equal(p.commands.length, count, field);
    assert.equal(p.state.player_x, 0, field);
    assert.equal(p.controller.read().status, status, field);
    p.state.memory[field] = original;
    p.tick();
    state = p.controller.read();
    assert.equal(state.status, 'navigating', field);
    assert.equal(p.state.held_key, 'right', field);
    p.tick(100);
    assert.equal(p.controller.read().status, 'arrived', field);
    assert.equal(p.state.player_x, 4, field);
  }
});

test('another scene takes precedence over a message or a running event', () => {
  const p = fixture({ memory: { scene: 'Menu', message_active: true, event_running: true } });
  p.controller.start(10, 4, 0);
  p.tick();
  assert.equal(p.controller.read().status, 'paused_scene');
  p.state.memory.scene = 'Map';
  p.tick();
  assert.equal(p.controller.read().status, 'paused_message');
  p.state.memory.message_active = false;
  p.tick();
  assert.equal(p.controller.read().status, 'paused_event');
  assert.deepEqual(p.commands, []);
});

test('paused and async-pending time does not count toward the 180-second navigation deadline', () => {
  const p = fixture({ memory: {} });
  p.controller.start(10, 2, 0);
  p.tick();
  p.state.memory.scene = 'Menu';
  p.tick(150, 1000);
  assert.equal(p.controller.read().status, 'paused_scene');
  p.state.memory.scene = 'Map';
  p.state.memory.async_pending = true;
  p.tick(50, 1000);
  // Async waits leave the previous status unchanged.
  assert.equal(p.controller.read().status, 'paused_scene');
  assert.equal(p.controller.read().active, true);
  assert.equal(p.controller.read().last_error, '');
  // Unpaused time without coordinates still counts.
  p.state.memory.async_pending = false;
  p.state.player_x = p.state.player_y = null;
  p.tick(178, 1000);
  assert.equal(p.controller.read().active, true);
  assert.equal(p.controller.read().status, 'navigating');
  p.tick(2, 1000);
  assert.match(p.controller.read().last_error, /Navigation timed out/);
});

test('async_pending releases keys and waits without changing the navigating status', () => {
  const p = fixture({ memory: {} });
  p.controller.start(10, 4, 0);
  p.tick();
  assert.equal(p.state.held_key, 'right');
  p.state.memory.async_pending = true;
  p.tick(100);
  assert.equal(p.controller.read().status, 'navigating');
  assert.equal(p.controller.read().active, true);
  assert.equal(p.state.held_key, null);
  assert.equal(p.commands.length, 1);
  assert.equal(p.state.player_x, 0);
  p.state.memory.async_pending = false;
  p.tick();
  assert.equal(p.state.held_key, 'right');
  p.tick(100);
  assert.equal(p.controller.read().status, 'arrived');
  assert.equal(p.state.player_x, 4);
});

test('engine direction decides on-tile facing: already facing presses decision without stepping off', () => {
  const edge = { mapId: 10, startX: 1, startY: 1, approachX: 1, approachY: 1, action: true, direction: 0,
    targetMapId: 11, targetX: 0, targetY: 0 };
  for (const [direction, keys] of [[0, ['decision']], [2, ['down', 'up', 'decision']], [3, ['down', 'up', 'decision']]]) {
    const decisions = [];
    const p = fixture({ x: 1, y: 1, navigation: map(3, 3), memory: { direction }, onHold(key, state) {
      if (key === 'decision') decisions.push([state.player_x, state.player_y]);
    } });
    p.controller.start(11, 0, 0, [edge]);
    p.tick(150);
    assert.deepEqual(p.commands.map(command => command.key), keys, `direction ${direction}`);
    assert.deepEqual(decisions, [[1, 1]]);
    assert.equal(p.controller.read().status, 'waiting_for_teleport');
    assert.equal(p.state.player_x, 1);
    assert.equal(p.state.player_y, 1);
  }
});

test('arrival waits until the engine reports the player settled', () => {
  const p = fixture({ memory: {} });
  p.controller.start(10, 1, 0);
  p.tick(8);
  assert.equal(p.state.player_x, 1);
  p.state.memory.moving = true;
  p.tick(60);
  assert.equal(p.controller.read().active, true);
  assert.equal(p.controller.read().status, 'navigating');
  assert.equal(p.state.held_key, null);
  assert.equal(p.commands.length, 1);
  p.state.memory.moving = false;
  p.tick();
  assert.equal(p.controller.read().status, 'arrived');
});

test('an explicit touch approach waits for engine settling before stepping into the exit', () => {
  const p = fixture({ memory: {}, exitInteractions: [] });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0,
    approachX: 0, approachY: 0, direction: 1, action: false }]);
  p.state.memory.moving = true;
  p.tick(100);
  assert.equal(p.controller.read().status, 'navigating');
  assert.deepEqual(p.commands, []);
  p.state.memory.moving = false;
  p.tick();
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
  assert.deepEqual(p.commands.map(command => command.key), ['right']);
});

test('post-teleport settling waits while engine events run, without exit or navigation deadlines, then proceeds', () => {
  const p = fixture({ memory: {}, navigation: map(3, 2) });
  p.controller.start(11, 2, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false }]);
  p.tick(8);
  assert.equal(p.state.player_x, 1);
  p.teleport(11, 0, 0);
  p.state.memory.event_running = true;
  p.tick(2);
  assert.equal(p.controller.read().status, 'settling_after_teleport');
  // 204 seconds: longer than both the 20-second exit and the 180-second navigation deadline.
  p.tick(1200, 170);
  let state = p.controller.read();
  assert.equal(state.status, 'settling_after_teleport');
  assert.equal(state.active, true);
  assert.equal(state.last_error, '');
  assert.equal(state.route_length, 1);
  assert.equal(p.state.held_key, null);
  p.state.memory.event_running = false;
  p.tick(2);
  state = p.controller.read();
  assert.equal(state.status, 'loading_map');
  assert.equal(state.route_length, 0);
  p.install([], []);
  p.tick(80);
  assert.equal(p.controller.read().status, 'arrived');
  assert.equal(p.state.player_x, 2);
});

test('live navigation replaces static passages when its dimensions match the loaded map', () => {
  const live = { ...map(5, 3), static: map(5, 3).passages, obstacles: [], events: [], revision: 1 };
  live.passages[1] = 0;
  live.static[14] = 7;
  const p = fixture({ memory: {}, live });
  p.controller.start(10, 2, 0);
  p.tick(120);
  assert.deepEqual(p.commands.map(command => command.key), ['down', 'right', 'right', 'up']);
  let state = p.controller.read();
  assert.equal(state.status, 'arrived');
  assert.deepEqual([p.state.player_x, p.state.player_y], [2, 0]);
  assert.equal(state.capabilities.live_collision, true);
  assert.equal(state.live_collision_mismatch, 1);

  for (const other of [{ ...map(4, 3), events: [] }, { ...map(5, 3, { loopHorizontal: true }), events: [] }]) {
    other.passages[1] = 0;
    const q = fixture({ memory: {}, live: other });
    q.controller.start(10, 2, 0);
    q.tick(100);
    assert.deepEqual(q.commands.map(command => command.key), ['right', 'right']);
    state = q.controller.read();
    assert.equal(state.status, 'arrived');
    assert.equal(state.capabilities.live_collision, false);
    assert.equal(state.live_collision_mismatch, null);
  }
});

test('a live obstacle on the next planned step replans immediately', () => {
  const open = map(5, 3), occupied = map(5, 3);
  occupied.passages[2] = 0;
  const p = fixture({ memory: {}, live: state => state.player_x >= 1 ? occupied : open,
    canMove: (_state, _direction, x, y) => x !== 2 || y !== 0 });
  p.controller.start(10, 3, 0);
  p.tick(150);
  assert.deepEqual(p.commands.map(command => command.key), ['right', 'down', 'right', 'right', 'up']);
  assert.equal(p.controller.read().status, 'arrived');
  assert.deepEqual([p.state.player_x, p.state.player_y], [3, 0]);
});

test('a timed-out step into a live obstacle is not learned, while a non-live failure is', () => {
  let npc = false;
  const p = fixture({ memory: {}, navigation: map(3, 1),
    live: () => { const nav = map(3, 1); if (npc) nav.passages[1] = 0; return nav; },
    canMove: (_state, _direction, x) => !npc || x !== 1 });
  p.controller.start(10, 2, 0);
  p.tick();
  assert.equal(p.state.held_key, 'right');
  npc = true;
  p.tick(100);
  let state = p.controller.read();
  assert.equal(state.status, 'navigating');
  assert.equal(state.active, true);
  assert.equal(state.last_error, '');
  assert.equal(p.commands.length, 1);
  assert.equal(p.state.held_key, null);
  // The obstacle leaves: the original step must still be usable.
  npc = false;
  p.tick(60);
  assert.deepEqual(p.commands.map(command => command.key), ['right', 'right', 'right']);
  assert.equal(p.controller.read().status, 'arrived');
  assert.equal(p.state.player_x, 2);

  // The live grid says the step is open: the unexplained failure is retried,
  // and learned as a blocked step once it repeats a third time.
  const q = fixture({ memory: {}, navigation: map(3, 1), live: map(3, 1), canMove: (_state, _direction, x) => x !== 1 });
  q.controller.start(10, 2, 0);
  q.tick(200);
  state = q.controller.read();
  assert.equal(state.status, 'navigating');
  assert.deepEqual(q.commands.map(command => command.key), ['right', 'right', 'right']);
  q.tick(100);
  state = q.controller.read();
  assert.equal(state.status, 'error');
  assert.match(state.last_error, /observed blockers/);
  assert.equal(q.commands.length, 3);
  assert.equal(q.state.held_key, null);

  // Without live collision the first failure is learned, as before.
  const r = fixture({ navigation: map(3, 1), canMove: (_state, _direction, x) => x !== 1 });
  r.controller.start(10, 2, 0);
  r.tick(100);
  assert.equal(r.controller.read().status, 'error');
  assert.match(r.controller.read().last_error, /observed blockers/);
  assert.equal(r.commands.length, 1);
});

test('a live obstacle seen during a step attempt makes its timeout temporary', () => {
  let npc = false, hidden = true;
  const p = fixture({ memory: {}, navigation: map(3, 1),
    live: () => { const nav = map(3, 1); if (npc) nav.passages[1] = 0; return nav; },
    canMove: (_state, _direction, x) => x !== 1 || (!npc && !hidden) });
  p.controller.start(10, 2, 0);
  p.tick();
  npc = true;
  p.tick(3);
  // The character leaves, but the step still fails until the timeout.
  npc = false;
  p.tick(90);
  assert.equal(p.controller.read().status, 'navigating');
  assert.deepEqual(p.commands.map(command => command.key), ['right', 'right']);
  hidden = false;
  p.tick(60);
  assert.equal(p.controller.read().status, 'arrived');
  assert.equal(p.state.player_x, 2);
});

test('only unexplained step failures count toward learning a live-open step as blocked', () => {
  // Two timeouts explained by a character seen on the step, then one unexplained
  // timeout: that is a single unexplained failure, so the step stays usable.
  let npc = false, hidden = true;
  const p = fixture({ memory: {}, navigation: map(3, 1),
    live: () => { const nav = map(3, 1); if (npc) nav.passages[1] = 0; return nav; },
    canMove: (_state, _direction, x) => x !== 1 || (!npc && !hidden) });
  p.controller.start(10, 2, 0);
  p.tick();
  for (const seen of [true, true, false]) {
    npc = seen;
    p.tick(3);
    npc = false;
    p.tick(90);
  }
  const state = p.controller.read();
  assert.equal(state.last_error, '');
  assert.equal(state.status, 'navigating');
  assert.equal(p.commands.length, 4);
  hidden = false;
  p.tick(60);
  assert.equal(p.controller.read().status, 'arrived');
});

test('a repeated unexplained failure with open live collision detours around the learned blocked step', () => {
  const p = fixture({ memory: {}, navigation: map(3, 2), live: map(3, 2),
    canMove: (state, direction) => !(state.player_x === 0 && state.player_y === 0 && direction === 'right') });
  p.controller.start(10, 2, 0);
  p.tick(400);
  assert.deepEqual(p.commands.map(command => command.key), ['right', 'right', 'right', 'down', 'right', 'right', 'up']);
  assert.equal(p.controller.read().status, 'arrived');
});

test('a live-only blockage waits up to five seconds, then falls back to static passages', () => {
  const live = map(3, 1);
  live.passages[1] = 0;
  const p = fixture({ memory: {}, navigation: map(3, 1), live });
  p.controller.start(10, 2, 0);
  p.tick(290);
  let state = p.controller.read();
  assert.equal(p.commands.length, 0);
  assert.equal(state.status, 'navigating');
  assert.equal(state.active, true);
  assert.equal(state.capabilities.live_collision, true);
  p.tick(100);
  state = p.controller.read();
  assert.deepEqual(p.commands.map(command => command.key), ['right', 'right']);
  assert.equal(state.status, 'arrived');
  assert.equal(p.state.player_x, 2);
  assert.equal(state.capabilities.live_collision, false);
});

test('tiles occupied throughout a live blockage stay blocked and the departure is resolved around them', () => {
  // An invisible same-layer wall at (1,0) occupies the statically nearest side
  // of the occupied door at (2,0); the door can still be entered from below.
  const live = { ...map(3, 3), obstacles: [1, 2], events: [] };
  live.passages[1] = live.passages[2] = 0;
  const p = fixture({ memory: {}, navigation: map(3, 3), live,
    exitInteractions: [{ eventId: 4, startX: 2, startY: 0, pages: [{ trigger: 1, layer: 1, targetMapIds: [11], unsupported: false }] }],
    canMove: (_state, _direction, x, y) => y !== 0 || x === 0,
    onHold(key, state) {
      if (key !== 'up' || state.player_x !== 2 || state.player_y !== 1) return;
      Object.assign(state, { map_id: 11, player_x: 0, player_y: 0,
        teleport_map_id: 11, teleport_x: 0, teleport_y: 0, held_key: null, hold_remaining: 0 });
      ++state.teleport_sequence;
    } });
  p.controller.configure({ reroute: true });
  p.controller.execute(['_Navbot_GoToMap', [11, 0, 0], [{ mapId: 10, startX: 2, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 }]]);
  p.tick(290);
  assert.deepEqual(p.commands, [], 'waits while live collision blocks the statically chosen approach');
  p.tick(200);
  const state = p.controller.read();
  assert.deepEqual(p.commands.map(command => command.key), ['down', 'right', 'right', 'up']);
  assert.equal(state.stationary_obstacles, 2);
  assert.equal(state.capabilities.live_collision, true, 'the other side is reachable with live collision');
  assert.equal(state.status, 'loading_map');
  assert.deepEqual(plain(state.unreachable_departures), []);
});

test('a departure walled in by stationary obstacles is excluded and rerouted', () => {
  const live = { ...map(3, 1), obstacles: [1, 2], events: [] };
  live.passages[1] = live.passages[2] = 0;
  const p = fixture({ memory: {}, navigation: map(3, 1), live,
    exitInteractions: [{ eventId: 4, startX: 2, startY: 0, pages: [{ trigger: 1, layer: 1, targetMapIds: [11], unsupported: false }] }],
    canMove: (_state, _direction, x) => x === 0 });
  p.controller.configure({ reroute: true });
  p.controller.execute(['_Navbot_GoToMap', [11, 0, 0], [{ mapId: 10, startX: 2, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 }]]);
  p.tick(320);
  const state = p.controller.read();
  assert.deepEqual(p.commands, [], 'never walks into the invisible wall');
  assert.equal(state.status, 'rerouting');
  assert.deepEqual(plain(state.reroute_request.blocked), ['10:2,0']);
  assert.match(state.last_reroute_reason, /no reachable interaction approach/);
});

test('tiles freed at any point during a live blockage are not kept as stationary obstacles', () => {
  // A character pacing between two tiles blocks the corridor the whole time.
  const p = fixture({ memory: {}, navigation: map(5, 1), live: state => {
    const nav = { ...map(5, 1), events: [] }, tile = Math.floor(state.time_ms / 1000) % 2 ? 2 : 1;
    nav.passages[tile] = 0; nav.obstacles = [tile];
    return nav;
  } });
  p.controller.start(10, 4, 0);
  p.tick(290);
  assert.deepEqual(p.commands, []);
  p.tick(200);
  const state = p.controller.read();
  assert.equal(state.status, 'arrived');
  assert.equal(p.state.player_x, 4);
  assert.equal(state.stationary_obstacles, 0);
});

test('a directional below-player exit keeps its approach after a live blockage', () => {
  // A character paces in the corridor for seven seconds, then leaves.
  const npc = state => state.time_ms < 7000 ? (Math.floor(state.time_ms / 1000) % 2 ? 2 : 1) : -1;
  const p = fixture({ memory: {}, navigation: map(5, 1),
    live: state => { const nav = { ...map(5, 1), events: [], obstacles: [] }, tile = npc(state); if (tile >= 0) { nav.passages[tile] = 0; nav.obstacles = [tile]; } return nav; },
    exitInteractions: [{ eventId: 4, startX: 4, startY: 0, pages: [{ trigger: 1, layer: 0, direction: 1, targetMapIds: [11], unsupported: false }] }],
    canMove: (state, _direction, x) => x !== npc(state) });
  p.controller.configure({ reroute: true });
  p.controller.execute(['_Navbot_GoToMap', [11, 0, 0], [{ mapId: 10, startX: 4, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 }]]);
  p.tick(700);
  const state = p.controller.read();
  assert.deepEqual(plain(state.unreachable_departures), []);
  assert.equal(state.last_reroute_reason, '');
  assert.equal(p.state.player_x, 4, 'walks onto the exit from the required side');
});

test('a character idle in a corridor for longer than the live wait does not become a permanent wall', () => {
  const present = state => state.time_ms < 6000;
  const p = fixture({ memory: {}, navigation: map(5, 1),
    live: state => { const nav = { ...map(5, 1), events: [], obstacles: [] }; if (present(state)) { nav.passages[2] = 0; nav.obstacles = [2]; } return nav; },
    canMove: (state, _direction, x) => x !== 2 || !present(state) });
  p.controller.start(10, 4, 0);
  p.tick(700);
  const state = p.controller.read();
  assert.equal(state.status, 'arrived');
  assert.equal(p.state.player_x, 4);
  assert.equal(state.stationary_obstacles, 0);
});

test('a destination blocked by a tile that never clears fails after fifteen seconds', () => {
  const live = { ...map(3, 1), events: [], obstacles: [1] };
  live.passages[1] = 0;
  const p = fixture({ memory: {}, navigation: map(3, 1), live, canMove: (_state, _direction, x) => x !== 1 });
  p.controller.start(10, 2, 0);
  p.tick(600);
  assert.equal(p.controller.read().active, true, 'still waiting after ten seconds');
  assert.deepEqual(p.commands, []);
  p.tick(300);
  const state = p.controller.read();
  assert.equal(state.status, 'error');
  assert.match(state.last_error, /kept every route to the destination blocked/);
  assert.deepEqual(p.commands, [], 'never walks into the occupied tile');
});

test('the navigation deadline restarts after each completed exit', () => {
  const p = fixture();
  p.controller.start(12, 2, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false },
    { mapId: 11, startX: 1, startY: 0, targetMapId: 12, targetX: 0, targetY: 0, action: false }]);
  p.state.player_x = p.state.player_y = null;
  p.tick(170, 1000);
  assert.equal(p.controller.read().active, true);
  p.state.player_x = p.state.player_y = 0;
  p.tick(8);
  assert.equal(p.state.player_x, 1);
  p.teleport(11, 0, 0);
  p.tick(40);
  assert.equal(p.controller.read().status, 'loading_map');
  p.install();
  p.state.player_x = p.state.player_y = null;
  p.tick(170, 1000);
  assert.equal(p.controller.read().active, true, 'the next map has its own deadline');
  p.tick(11, 1000);
  assert.match(p.controller.read().last_error, /Navigation timed out/);
});

test('live active pages select the event page used to resolve a graph exit', () => {
  const action = { trigger: 0, layer: 1, targetMapIds: [11], unsupported: false };
  const touch = { trigger: 1, layer: 0, targetMapIds: [11], unsupported: false };
  const exitInteractions = [{ eventId: 7, startX: 2, startY: 0, pages: [action, touch] }];
  const edge = { mapId: 10, startX: 2, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 };
  const event = page => ({ id: 7, x: 2, y: 0, layer: 1, through: false, flying: false, active: true, page });
  for (const [page, keys] of [[1, ['right', 'right']], [0, ['right', 'right', 'decision']]]) {
    const p = fixture({ memory: {}, exitInteractions, live: { ...map(), events: [event(page)] },
      canMove: (_state, _direction, x, y) => page === 1 || x !== 2 || y !== 0 });
    p.controller.start(11, 0, 0, [edge]);
    p.tick(100);
    assert.deepEqual(p.commands.map(command => command.key), keys, `page ${page}`);
    assert.equal(p.controller.read().status, 'waiting_for_teleport', `page ${page}`);
  }

  // Without a live page, conflicting pages still need a reviewed route.
  for (const live of [null, { ...map(), events: [] }, { ...map(), events: [event(null)] }]) {
    const p = fixture({ memory: {}, exitInteractions, live });
    p.controller.start(11, 0, 0, [edge]);
    p.tick(10);
    assert.equal(p.controller.read().status, 'error');
    assert.match(p.controller.read().last_error, /conditional or scripted/);
    assert.deepEqual(p.commands, []);
  }

  // An event with no active page is not an exit in the current game state.
  for (const reroute of [false, true]) {
    const p = fixture({ memory: {}, exitInteractions, live: { ...map(), events: [event(-1)] } });
    if (reroute) p.controller.configure({ reroute: true });
    p.controller.start(11, 0, 0, [edge]);
    p.tick(10);
    const state = p.controller.read();
    assert.deepEqual(p.commands, []);
    if (!reroute) {
      assert.equal(state.status, 'error');
      assert.match(state.last_error, /not active in the current game state/);
      continue;
    }
    assert.equal(state.status, 'rerouting');
    assert.deepEqual(plain(state.reroute_request.blocked), ['10:2,0']);
  }
});

test('an unexpected landing on another map publishes a reroute request and a fresh route resumes navigation', () => {
  const p = fixture({ memory: {} });
  p.controller.configure({ reroute: true });
  p.controller.start(11, 2, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false }]);
  p.tick(8);
  assert.equal(p.state.player_x, 1);
  p.teleport(12, 3, 1);
  p.tick();
  let state = p.controller.read();
  assert.equal(state.status, 'rerouting');
  assert.equal(state.active, true);
  assert.equal(state.global_active, true);
  assert.equal(state.reroutes, 1);
  assert.equal(state.route_length, 0);
  assert.equal(p.state.held_key, null);
  assert.match(state.last_error, /^$/);
  assert.deepEqual(plain(state.reroute_request),
    { id: 1, map: 12, target_map: 11, reason: 'Unexpected map 12 or landing (3,1) while taking an exit.', observed: [['10:1,0', 12]], blocked: [] });
  assert.equal(state.last_reroute_reason, 'Unexpected map 12 or landing (3,1) while taking an exit.');
  assert.deepEqual(plain(state.observed_departures), [{ departure: '10:1,0', map: 12 }]);
  const commands = p.commands.length;
  p.tick(100);
  assert.equal(p.commands.length, commands);
  assert.equal(p.controller.read().status, 'rerouting');

  const next = { mapId: 12, startX: 4, startY: 1, targetMapId: 11, targetX: 0, targetY: 0, action: false };
  assert.equal(p.controller.reroute(99, [next]), false);
  assert.equal(p.controller.read().status, 'rerouting');
  assert.equal(p.controller.reroute(1, [next]), true);
  assert.equal(p.controller.reroute(1, [next]), false);
  state = p.controller.read();
  assert.equal(state.status, 'navigating');
  assert.equal(state.reroute_request, null);
  assert.equal(state.route_length, 1);
  p.tick();
  assert.equal(p.controller.read().status, 'loading_map');
  p.install([], []);
  p.tick(50);
  assert.deepEqual([p.state.player_x, p.state.player_y], [4, 1]);
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
  p.teleport(11, 0, 0);
  p.tick(40);
  assert.equal(p.controller.read().status, 'loading_map');
  p.install([], []);
  p.tick(80);
  state = p.controller.read();
  assert.equal(state.status, 'arrived');
  assert.deepEqual([p.state.player_x, p.state.player_y], [2, 0]);
  assert.equal(state.reroutes, 1);
});

test('same-map walking ends on a scripted map change instead of rerouting, like the local engine', () => {
  // Planetarium recipe steps walk into touch transfers and expect the map change.
  for (const edges of [[], [{ mapId: 10, startX: 1, startY: 0, targetMapId: 10, targetX: 3, targetY: 0, action: false, reviewed: true }]]) {
    const p = fixture();
    p.controller.configure({ reroute: true });
    p.controller.start(10, 4, 0, edges);
    p.tick(8);
    p.teleport(12, 3, 1);
    p.tick();
    const state = p.controller.read();
    assert.equal(state.status, 'error');
    assert.match(state.last_error, /Unexpected/);
    assert.equal(state.reroute_request, null);
    assert.equal(state.reroutes, 0);
    assert.equal(p.state.held_key, null);
  }
});

test('a reroute answer without edges fails with the supplied or default message', () => {
  for (const message of ['No route from map 12 reaches map 11.', undefined]) {
    const p = fixture({ memory: {} });
    p.controller.configure({ reroute: true });
    p.controller.start(11, 2, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false }]);
    p.tick();
    p.teleport(12, 0, 0);
    p.tick();
    const id = p.controller.read().reroute_request.id;
    assert.equal(p.controller.reroute(id, null, message), true);
    const state = p.controller.read();
    assert.equal(state.status, 'error');
    assert.equal(state.last_error, message || 'No route remains from this map.');
    assert.equal(state.active, false);
    assert.equal(state.reroute_request, null);
    assert.equal(p.controller.reroute(id, [], 'late'), false);
  }
});

test('a teleport during a pending reroute renews the request id and map, invalidating the stale id', () => {
  const exit = { mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false };
  const p = fixture({ memory: {} });
  p.controller.configure({ reroute: true });
  p.controller.start(11, 2, 0, [exit]);
  p.tick();
  for (let attempt = 1; attempt <= 3; ++attempt) {
    p.teleport(12, 3, 1);
    p.tick();
    if (attempt === 3) break;
    const first = p.controller.read().reroute_request;
    assert.equal(p.controller.read().status, 'rerouting');
    assert.equal(first.map, 12);
    p.teleport(10, 0, 0);
    p.tick();
    const request = p.controller.read().reroute_request;
    assert.equal(request.map, 10);
    assert.notEqual(request.id, first.id);
    assert.equal(p.controller.reroute(first.id, [exit]), false);
    assert.equal(p.controller.reroute(request.id, [exit]), true);
    p.tick();
    assert.equal(p.state.held_key, 'right');
  }
  // The same departure landing on the same map three times stops the command.
  const state = p.controller.read();
  assert.equal(state.status, 'error');
  assert.match(state.last_error, /same transition repeated three times/);
  assert.equal(state.reroutes, 2);
  assert.equal(p.state.held_key, null);
});

test('more than sixteen reroutes in one command fail', () => {
  const exit = { mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false };
  const p = fixture({ memory: {} });
  p.controller.configure({ reroute: true });
  p.controller.start(11, 2, 0, [exit]);
  p.tick();
  let answered = 0;
  for (let attempt = 0; attempt < 17; ++attempt) {
    p.teleport(20 + attempt, 0, 0);
    p.tick();
    if (p.controller.read().status !== 'rerouting') break;
    p.teleport(10, 0, 0);
    p.tick();
    assert.equal(p.controller.reroute(p.controller.read().reroute_request.id, [exit]), true);
    ++answered;
    p.tick();
  }
  assert.equal(answered, 16);
  assert.equal(p.controller.read().status, 'error');
  assert.equal(p.controller.read().reroutes, 17);
  assert.match(p.controller.read().last_error, /Unexpected map 36/);
});

test('landing on the target map continues without a reroute; without configure it still errors', () => {
  for (const reroute of [true, false]) {
    const p = fixture({ memory: {} });
    if (reroute) p.controller.configure({ reroute: true });
    p.controller.start(11, 2, 0, [
      { mapId: 10, startX: 1, startY: 0, targetMapId: 12, targetX: 0, targetY: 0, action: false },
      { mapId: 12, startX: 4, startY: 2, targetMapId: 11, targetX: 0, targetY: 0, action: false },
    ]);
    p.tick(8);
    assert.equal(p.state.player_x, 1);
    p.teleport(11, 0, 1);
    p.tick();
    let state = p.controller.read();
    if (!reroute) {
      assert.equal(state.status, 'error');
      assert.match(state.last_error, /Unexpected map 11/);
      assert.equal(state.reroute_request, null);
      assert.equal(p.state.held_key, null);
      continue;
    }
    assert.equal(state.status, 'navigating');
    assert.equal(state.route_length, 0);
    assert.equal(state.reroute_request, null);
    assert.equal(state.reroutes, 0);
    p.tick();
    assert.equal(p.controller.read().status, 'loading_map');
    p.install([], []);
    p.tick(80);
    state = p.controller.read();
    assert.equal(state.status, 'arrived');
    assert.deepEqual([p.state.player_x, p.state.player_y], [2, 0]);
  }
});

test('other unexpected landings stop without configure, as before', () => {
  const p = fixture();
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, action: false, targetX: 0, targetY: 0 }]);
  p.tick();
  p.teleport(12, 0, 0);
  p.tick();
  const state = p.controller.read();
  assert.equal(state.status, 'error');
  assert.match(state.last_error, /Unexpected map 12/);
  assert.equal(state.reroute_request, null);
  assert.equal(state.reroutes, 0);
});

test('an unreachable or unresolvable departure is blocked and requests a reroute', () => {
  const unresolvable = { mapId: 10, startX: 2, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 };
  const navigation = map(3, 3);
  navigation.passages[4] = 0;
  const unreachable = { mapId: 10, startX: 1, startY: 0, approachX: 1, approachY: 1, action: false, direction: 0,
    targetMapId: 11, targetX: 0, targetY: 0 };
  for (const [edge, options, key, reason] of [[unresolvable, {}, '10:2,0', /no unambiguous interaction data/],
    [unreachable, { x: 0, y: 1, navigation }, '10:1,0', /required teleport approach/]]) {
    for (const reroute of [false, true]) {
      const p = fixture({ ...options, memory: {} });
      if (reroute) p.controller.configure({ reroute: true });
      p.controller.start(11, 0, 0, [edge]);
      p.tick();
      const state = p.controller.read();
      assert.deepEqual(p.commands, []);
      assert.equal(p.state.held_key, null);
      if (!reroute) {
        assert.equal(state.status, 'error');
        assert.match(state.last_error, reason);
        continue;
      }
      assert.equal(state.status, 'rerouting', key);
      assert.equal(state.active, true);
      assert.deepEqual(plain(state.reroute_request), { id: 1, map: 10, target_map: 11, reason: state.last_reroute_reason, observed: [], blocked: [key] });
      assert.match(state.last_reroute_reason, reason);
      assert.deepEqual(plain(state.unreachable_departures), [key]);
    }
  }

  const p = fixture({ memory: {} });
  p.controller.configure({ reroute: true });
  p.controller.start(11, 0, 0, [unresolvable]);
  p.tick();
  assert.equal(p.controller.reroute(1, [{ mapId: 10, startX: 4, startY: 2, targetMapId: 11, targetX: 0, targetY: 0, action: false }]), true);
  p.tick(100);
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
  assert.deepEqual([p.state.player_x, p.state.player_y], [4, 2]);
  // The blocked departure stays excluded for later reroute requests of this command.
  p.teleport(13, 0, 0);
  p.tick();
  assert.deepEqual(plain(p.controller.read().reroute_request.blocked), ['10:2,0']);
});

test('an unanswered reroute request fails after fifteen seconds', () => {
  const p = fixture({ memory: {} });
  p.controller.configure({ reroute: true });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 2, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 }]);
  p.tick();
  assert.equal(p.controller.read().status, 'rerouting');
  p.tick(800);
  assert.equal(p.controller.read().status, 'rerouting');
  assert.equal(p.state.held_key, null);
  p.tick(100);
  const state = p.controller.read();
  assert.equal(state.status, 'error');
  assert.match(state.last_error, /No new route was planned/);
  assert.equal(state.active, false);
  assert.equal(state.reroute_request, null);
  assert.equal(p.controller.reroute(1, []), false);
});

test('configure only enables rerouting for an explicit reroute: true', () => {
  for (const options of [{}, { reroute: 'yes' }, null]) {
    const p = fixture();
    p.controller.configure({ reroute: true });
    p.controller.configure(options);
    p.controller.start(11, 0, 0, [{ mapId: 10, startX: 2, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 }]);
    p.tick();
    assert.equal(p.controller.read().status, 'error');
  }
});

test('keyboard interrupts are counted and stop an active target', () => {
  const p = fixture({ memory: {} });
  assert.equal(p.controller.read().user_interrupts, 0);
  p.controller.start(10, 4, 0);
  p.tick();
  assert.equal(p.state.held_key, 'right');
  p.controller.interrupt();
  let state = p.controller.read();
  assert.equal(state.user_interrupts, 1);
  assert.equal(state.status, 'stopped');
  assert.equal(state.last_error, 'Stopped by keyboard input');
  assert.equal(state.active, false);
  assert.equal(p.state.held_key, null);
  p.tick(100);
  assert.equal(p.commands.length, 1);
  assert.equal(p.state.player_x, 0);

  // Without a target it only releases held keys.
  p.controller.execute(['_Navbot_HoldKey', [4, 30]]);
  assert.equal(p.state.held_key, 'decision');
  p.controller.interrupt();
  state = p.controller.read();
  assert.equal(state.user_interrupts, 2);
  assert.equal(state.status, 'stopped');
  assert.equal(p.state.held_key, null);

  // A pending reroute is cancelled too.
  p.controller.configure({ reroute: true });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 2, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 }]);
  p.tick();
  assert.equal(p.controller.read().status, 'rerouting');
  p.controller.interrupt();
  state = p.controller.read();
  assert.equal(state.user_interrupts, 3);
  assert.equal(state.status, 'stopped');
  assert.equal(state.reroute_request, null);
  assert.equal(p.controller.reroute(1, []), false);
});

test('read reports capabilities, memory-derived fields and held keys as button/frame pairs', () => {
  const none = fixture();
  none.controller.execute(['_Navbot_HoldKey', [4, 10]]);
  let state = none.controller.read();
  assert.deepEqual(plain(state.held_keys), [{ button: 4, frames: 10 }]);
  assert.deepEqual(plain(state.capabilities), { scene: false, events: false, bike: false, recipes: false,
    memory: false, logical_frames: false, live_collision: false });
  for (const key of ['scene', 'direction', 'menu_allowed', 'vehicle_type', 'selected_item_id', 'move_speed', 'player_paused',
    'title_index', 'engine_state_error', 'live_collision_mismatch', 'bike_item_index', 'bike_active', 'forest_pier_visited']) {
    assert.equal(state[key], null, key);
  }
  assert.equal(state.backend, 'official');
  assert.equal('memory' in state, false);
  assert.equal('room_connected' in state, false);

  const p = fixture({ live: { ...map(), static: map().passages, events: [] },
    memory: { direction: 1, selected_item_id: 3, move_speed: 5, title_index: 0, room_connected: true,
      room_sync_pending: false, room_synced_id: 10, room_player_count: 3 } });
  p.state.input_timing = 'logical-frames';
  p.controller.start(10, 4, 0);
  p.tick();
  state = p.controller.read();
  assert.deepEqual(plain(state.capabilities), { scene: true, events: true, bike: true, recipes: true,
    memory: true, logical_frames: true, live_collision: true });
  assert.deepEqual(plain(state.held_keys), [{ button: 3, frames: 120 }]);
  assert.equal(state.scene, 'Map');
  assert.equal(state.direction, 1);
  assert.equal(state.moving, false);
  assert.equal(state.event_running, false);
  assert.equal(state.message_active, false);
  assert.equal(state.async_pending, false);
  assert.equal(state.move_route_overwritten, false);
  assert.equal(state.player_paused, false);
  assert.equal(state.menu_allowed, true);
  assert.equal(state.vehicle_type, 0);
  assert.equal(state.selected_item_id, 3);
  assert.equal(state.move_speed, 5);
  assert.equal(state.title_index, 0);
  assert.equal(state.room_connected, true);
  assert.equal(state.room_sync_pending, false);
  assert.equal(state.room_synced_id, 10);
  assert.equal(state.room_player_count, 3);
  assert.equal(state.engine_state_error, null);
  assert.equal(state.live_collision_mismatch, 0);
  assert.equal(state.bike_active, null);
  assert.equal('memory' in state, false);

  const unknownEvents = fixture({ memory: { event_running: null } });
  state = unknownEvents.controller.read();
  assert.equal(state.capabilities.scene, true);
  assert.equal(state.capabilities.events, false);
  assert.equal(state.capabilities.logical_frames, false);
  assert.equal('room_connected' in state, false);
});

test('unverified engine memory is ignored apart from its error', () => {
  const p = fixture({ memory: { available: false, error: 'Engine player object was not found', scene: 'Menu', message_active: true } });
  let state = p.controller.read();
  assert.equal(state.engine_state_error, 'Engine player object was not found');
  assert.equal(state.capabilities.memory, false);
  assert.equal(state.capabilities.recipes, false);
  assert.equal(state.scene, null);
  assert.equal(state.message_active, null);
  p.controller.start(10, 2, 0);
  p.tick();
  assert.equal(p.controller.read().status, 'navigating');
  assert.equal(p.state.held_key, 'right');
  p.tick(80);
  assert.equal(p.controller.read().status, 'arrived');
});

test('query forwards read-only engine queries and reports null without a memory reader', () => {
  const requests = [];
  const p = fixture({ memory: {}, query: request => { requests.push(request); return { switches: { 5: true }, items: {} }; } });
  const request = { switches: [5], items: [2] };
  assert.deepEqual(plain(p.controller.query(request)), { switches: { 5: true }, items: {} });
  assert.deepEqual(requests, [request]);
  assert.equal(fixture().controller.query({ switches: [5] }), null);
});

test('read lists live obstacles within five tiles of the player', () => {
  const live = { ...map(12, 3), obstacles: [3, 11, 12 + 6], events: [] };
  const p = fixture({ memory: {}, navigation: map(12, 3), live });
  p.controller.start(10, 1, 2);
  p.tick();
  assert.deepEqual(plain(p.controller.read().live_obstacles_near), [{ x: 3, y: 0 }]);
  const q = fixture({ memory: {} });
  q.controller.start(10, 1, 2);
  q.tick();
  assert.deepEqual(plain(q.controller.read().live_obstacles_near), []);
});

// Review fixes: attribution, deferred landings, exit pauses and keyboard handling.
test('rerouting requires verified engine state', () => {
  const p = fixture();
  p.controller.configure({ reroute: true });
  p.controller.start(11, 2, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false }]);
  p.tick(8);
  p.teleport(12, 3, 1);
  p.tick();
  const state = p.controller.read();
  assert.equal(state.status, 'error');
  assert.match(state.last_error, /Unexpected map 12/);
  assert.equal(state.reroute_request, null);
});

test('a teleport away from the next exit is replanned without recording that exit', () => {
  const p = fixture({ memory: {} });
  p.controller.configure({ reroute: true });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 4, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false }]);
  p.tick(8);
  assert.equal(p.state.player_x, 1);
  p.teleport(12, 2, 2);
  p.tick();
  const state = p.controller.read();
  assert.equal(state.status, 'rerouting');
  assert.deepEqual(plain(state.reroute_request.observed), []);
});

test('a teleport while settling completes the previous edge before judging the next one', () => {
  const p = fixture({ memory: {} });
  p.controller.configure({ reroute: true });
  p.controller.start(13, 0, 0, [
    { mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false },
    { mapId: 11, startX: 4, startY: 0, targetMapId: 13, targetX: 0, targetY: 0, action: false },
  ]);
  p.tick(8);
  p.teleport(11, 0, 0);
  p.tick();
  assert.equal(p.controller.read().status, 'settling_after_teleport');
  p.teleport(12, 1, 1);
  p.tick();
  const state = p.controller.read();
  assert.equal(state.status, 'rerouting');
  assert.deepEqual(plain(state.reroute_request.observed), []);
  assert.equal(state.reroute_request.map, 12);
});

test('maps passed during a running event are judged once the event ends', () => {
  const p = fixture({ memory: {} });
  p.controller.configure({ reroute: true });
  p.controller.start(5, 2, 2, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 5, targetX: 2, targetY: 2, action: false }]);
  p.tick(8);
  p.state.memory.event_running = true;
  p.teleport(900, 0, 0);
  p.tick(30);
  let state = p.controller.read();
  assert.equal(state.status, 'waiting_for_teleport');
  assert.equal(state.reroute_request, null);
  p.teleport(5, 2, 2);
  p.tick(30);
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
  p.state.memory.event_running = false;
  p.tick(40);
  state = p.controller.read();
  assert.equal(state.reroute_request, null);
  assert.deepEqual(plain(state.observed_departures), []);
  assert.ok(['settling_after_teleport', 'loading_map', 'arrived'].includes(state.status), state.status);
});

test('messages and events during an exit pause it without counting toward its deadline', () => {
  const p = fixture({ x: 1, memory: {} });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 2, startY: 0, approachX: 1, approachY: 0, action: true, direction: 1,
    targetMapId: 11, targetX: 0, targetY: 0 }]);
  p.tick(40);
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
  p.state.memory.message_active = true;
  p.tick(1500, 17);
  const state = p.controller.read();
  assert.equal(state.status, 'paused_message');
  assert.equal(state.active, true);
  assert.equal(p.state.held_key, null);
  p.state.memory.message_active = false;
  p.tick();
  assert.equal(p.controller.read().status, 'waiting_for_teleport');
});

test('keyboard input while navigation is paused or the game is busy answers the game', () => {
  const p = fixture({ memory: {} });
  p.controller.start(10, 4, 0);
  p.tick();
  p.state.memory.message_active = true;
  p.tick();
  assert.equal(p.controller.read().status, 'paused_message');
  assert.equal(p.controller.interrupt(), false);
  let state = p.controller.read();
  assert.equal(state.user_interrupts, 0);
  assert.equal(state.active, true);
  p.state.memory.message_active = false;
  p.state.memory.scene = 'Menu';
  assert.equal(p.controller.interrupt(), false);
  p.state.memory.scene = 'Map';
  p.tick();
  assert.equal(p.controller.interrupt(), true);
  state = p.controller.read();
  assert.equal(state.user_interrupts, 1);
  assert.equal(state.status, 'stopped');
});

test('recipes and Bike preparation need known event and message state', () => {
  for (const [patch, expected] of [[{}, true], [{ message_active: null }, false], [{ event_running: null }, false]]) {
    const p = fixture({ memory: patch });
    const capabilities = p.controller.read().capabilities;
    assert.equal(capabilities.recipes, expected);
    assert.equal(capabilities.bike, expected);
    assert.equal(capabilities.scene, true);
  }
});

test('an erased exit event is treated as inactive', () => {
  const exitInteractions = [{ eventId: 3, startX: 2, startY: 0, pages: [{ trigger: 1, layer: 0, targetMapIds: [11], unsupported: false }] }];
  const nav = { width: 5, height: 3, loopHorizontal: false, loopVertical: false, passages: Array(15).fill(15), static: Array(15).fill(15),
    obstacles: [], events: [{ id: 3, x: 2, y: 0, layer: 0, through: false, flying: false, active: false, page: 0 }] };
  const p = fixture({ memory: {}, live: nav, exitInteractions });
  p.controller.start(11, 0, 0, [{ mapId: 10, startX: 2, startY: 0, targetMapId: 11, targetX: 0, targetY: 0 }]);
  p.tick();
  const state = p.controller.read();
  assert.equal(state.status, 'error');
  assert.match(state.last_error, /not active/);
});

test('repeated warps within the destination map stop after three', () => {
  const p = fixture({ memory: {} });
  p.controller.configure({ reroute: true });
  p.controller.start(11, 4, 0, [{ mapId: 10, startX: 1, startY: 0, targetMapId: 11, targetX: 0, targetY: 0, action: false }]);
  p.tick(8);
  p.teleport(11, 0, 0);
  p.install([], []);
  p.tick(80);
  for (let i = 0; i < 3; i++) {
    p.tick(8);
    p.teleport(11, 0, 2);
    p.tick();
  }
  const state = p.controller.read();
  assert.equal(state.status, 'error');
  assert.match(state.last_error, /repeated three times/);
});

test('a character on the goal tile is approached without waiting for it to move', () => {
  const passages = Array(15).fill(15);
  passages[4] = 0;
  const nav = { width: 5, height: 3, loopHorizontal: false, loopVertical: false, passages, static: Array(15).fill(15),
    obstacles: [4], events: [] };
  const p = fixture({ memory: {}, live: nav, canMove: (_state, _key, nx, ny) => !(nx === 4 && ny === 0) });
  p.controller.start(10, 4, 0);
  p.tick(120);
  const state = p.controller.read();
  assert.equal(state.status, 'interaction_ready');
  assert.deepEqual([p.state.player_x, p.state.player_y], [3, 0]);
});
