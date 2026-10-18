'use strict';

// Serialized into the official page before its scripts run; keep dependencies inside.
// It only reads the unmodified engine's WebAssembly memory: never writes, calls
// engine internals or changes networking. Objects are located through the
// build's own C++ RTTI names and static declaration order, and each sample is
// checked against the public getPlayerCoords() API before its fields are used.
function createOfficialMemory() {
  // wasm32 libc++ (ABI v2) offsets from the ynoengine/liblcf sources. They are
  // identical upstream and were checked against the official build's code,
  // vtables and liblcf field tables. Character fields are relative to _data.
  const O = Object.freeze({
    sceneType: 4, sceneDelay: 60, sceneTitleCommand: 64, sceneTitleNewGame: 72, sceneTitleContinue: 76,
    sceneTitleContinueEnabled: 96, sceneFileIndex: 64, sceneMenuCommand: 68, sceneItemWindow: 68,
    drawableFlags: 16, selectableIndex: 300, itemData: 328, messageCloseFinished: 407,
    characterData: 12, characterStorage: 16,
    active: 0, mapId: 4, x: 8, y: 12, direction: 16, facing: 20, remainingStep: 32, layer: 40,
    moveSpeed: 56, moveRouteOverwrite: 76, through: 92, jumping: 108, pause: 120, flying: 121,
    spriteName: 124, spriteId: 136, eventId: 188, vehicle: 188, playerTeleportActive: 311,
    eventSize: 352, eventDefinition: 336, eventPage: 340, vehicleSize: 232,
    definitionPages: 16, pageSize: 124, interpreterMain: 4, interpreterStack: 20,
    mapWidth: 16, mapHeight: 20, mapScroll: 24, mapLower: 120, mapUpper: 132,
    infoLowerTiles: 28, infoUpperTiles: 40, actorSize: 320, actorId: 128, actorSkills: 224,
    partyItems: 16, switchBits: 4, switchCapacity: 8, switchLowerLimit: 12,
    systemFrames: 4, systemMenuAllowed: 721, transitionCurrent: 64, transitionTotal: 68, transitionFlash: 120,
    requestState: 56, requestImportant: 60, nodeRequest: 20, nodeControl: 24,
    gmiConnection: 8, gmiConnected: 12, gmiSessionConnected: 137, gmiSwitching: 138, gmiRoomId: 156, gmiPlayerCount: 176,
  });
  // Statics are laid out in declaration order: main_data.cpp around game_player
  // and game_map.cpp around its interpreter. Every derived holder is validated.
  const MAIN = Object.freeze({ system: -32, switches: -28, actors: -4, party: 4, enemyParty: 8 });
  const MAP = Object.freeze({ info: -0x88, passagesDown: -0x38, passagesUp: -0x2c, events: -0x20, map: -4, vehicles: 4 });
  const CLASSES = Object.freeze({
    player: '11Game_Player', party: '10Game_Party', enemyParty: '15Game_EnemyParty',
    interpreter: '20Game_Interpreter_Map', message: '14Window_Message', itemWindow: '11Window_Item',
    command: '14Window_Command', event: '10Game_Event', vehicle: '12Game_Vehicle', actor: '10Game_Actor',
    transition: '10Transition', connection: '13YNOConnection',
  });
  const SCENES = ['Null', 'Title', 'Map', 'Menu', 'Item', 'Skill', 'Equip', 'ActorTarget', 'Status', 'File',
    'Save', 'Load', 'End', 'Battle', 'Shop', 'Name', 'Gameover', 'Debug', 'Logo', 'Order', 'GameBrowser',
    'Teleport', 'Settings', 'Language'];
  const WALL_SHAPES = new Set([20, 21, 22, 23, 33, 34, 35, 36, 37, 42, 43, 45, 46]);
  const DISCOVERY_RETRY_MS = 2000, DISCOVERY_MAX_RETRY_MS = 60000, TYPE_SCAN_BYTES = 12 << 20, STATIC_SCAN_BYTES = 32 << 20;

  let engine = null, buffer = null, u8 = null, i16 = null, i32 = null, u32 = null;
  let types = null, typesError = null, anchors = null, retryAt = 0, lastError = null, latest = null;
  let retryDelay = DISCOVERY_RETRY_MS, staticBound = 0, scanScene = null;
  let geometry = null, sampledAt = 0, layers = null;

  function reset() {
    engine = buffer = u8 = i16 = i32 = u32 = null;
    types = typesError = anchors = latest = geometry = layers = scanScene = null;
    retryAt = 0; retryDelay = DISCOVERY_RETRY_MS; staticBound = 0; sampledAt = 0; lastError = null;
  }

  function views(module) {
    if (module !== engine) { reset(); engine = module; }
    const heap = module?.HEAPU8;
    if (!heap || !(heap.buffer instanceof ArrayBuffer) || heap.byteLength < 0x10000) return false;
    if (heap.buffer !== buffer) {
      // Memory growth replaces the buffer; addresses stay valid.
      buffer = heap.buffer;
      u8 = new Uint8Array(buffer); i16 = new Int16Array(buffer);
      i32 = new Int32Array(buffer); u32 = new Uint32Array(buffer);
    }
    return true;
  }

  const inside = (address, size = 4) => Number.isInteger(address) && address >= 0x400
    && address + size <= u8.length;
  const pointer = address => inside(address) && !(address & 3) ? u32[address >> 2] : 0;
  const word = address => inside(address) && !(address & 3) ? i32[address >> 2] : null;
  const byte = address => inside(address, 1) ? u8[address] : null;
  const half = address => inside(address, 2) && !(address & 1) ? i16[address >> 1] : null;
  const classOf = object => inside(object) && !(object & 3) ? types.byVptr.get(u32[object >> 2]) : undefined;
  const is = (object, key) => classOf(object) === CLASSES[key];

  function vector(address, size, limit = 1000000) {
    const begin = pointer(address), end = pointer(address + 4), capacity = pointer(address + 8);
    if (!begin && !end) return { begin: 0, count: 0 };
    if (!inside(begin, 0) || end < begin || capacity < end || (end - begin) % size || (end - begin) / size > limit
      || !inside(begin, end - begin)) return null;
    return { begin, count: (end - begin) / size };
  }

  function latin1(limit) {
    if (typeof TextDecoder === 'function') return new TextDecoder('latin1').decode(u8.subarray(0, limit));
    const chunks = [];
    for (let start = 0; start < limit; start += 8192) {
      chunks.push(String.fromCharCode.apply(null, u8.subarray(start, Math.min(limit, start + 8192))));
    }
    return chunks.join('');
  }

  // Typeinfo name strings, typeinfo objects and vtables are static data.
  function discoverTypes() {
    const limit = Math.min(u8.length, TYPE_SCAN_BYTES) & ~3;
    const text = latin1(limit);
    const names = new Map();
    const add = (name, offset) => { if (offset > 0) names.set(offset, name); };
    for (const name of Object.values(CLASSES)) {
      const needle = `\0${name}\0`;
      for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) add(name, i + 1);
    }
    for (const match of text.matchAll(/\0(\d+)(Scene(?:_[A-Za-z0-9_]+)?)\0/g)) {
      if (Number(match[1]) === match[2].length) add(match[1] + match[2], match.index + 1);
    }
    for (const match of text.matchAll(/\0(NSt3__\d20__shared_ptr_emplaceI16FileRequestAsyncNS_9allocatorIS1_EEEE)\0/g)) {
      add('FileRequestAsyncBlock', match.index + 1);
    }
    const words = limit >> 2, typeinfos = new Map(), byVptr = new Map();
    for (let i = 1; i < words; i++) {
      const name = names.get(u32[i]);
      if (name !== undefined && u32[i - 1]) typeinfos.set((i - 1) << 2, name);
    }
    for (let i = 1; i < words - 1; i++) {
      const name = typeinfos.get(u32[i]);
      if (name !== undefined && u32[i - 1] === 0) byVptr.set((i + 1) << 2, name);
    }
    const found = new Set(byVptr.values());
    for (const key of ['player', 'party', 'enemyParty']) {
      if (!found.has(CLASSES[key])) throw new Error(`Official engine RTTI is missing ${CLASSES[key]}`);
    }
    const scenes = new Set([...byVptr].filter(([, name]) => /^\d+Scene(_|$)/.test(name)).map(([vptr]) => vptr));
    const vptrs = name => [...byVptr].filter(([, value]) => value === name).map(([vptr]) => vptr);
    return { byVptr, scenes, vptrs };
  }

  // Static holders are the lowest-addressed references; the heap starts after
  // the data, BSS and stack regions in Emscripten's default layout.
  function discoverAnchors(previous) {
    const limit = Math.min(u8.length, previous.staticEnd || STATIC_SCAN_BYTES) & ~3;
    const next = { ...previous };
    const holders = new Map(), objects = new Map();
    const note = (map, name, address) => {
      const list = map.get(name) || [];
      if (list.length < 64) list.push(address);
      map.set(name, list);
    };
    for (let i = 0x100; i < limit >> 2; i++) {
      const value = u32[i];
      const own = types.byVptr.get(value);
      if (own !== undefined) note(objects, own, i << 2);
      if (value < 0x400 || value & 3 || value >= u8.length - 4) continue;
      const name = types.byVptr.get(u32[value >> 2]);
      if (name !== undefined) note(holders, name, i << 2);
    }
    if (!next.main) {
      for (const address of holders.get(CLASSES.player) || []) {
        const player = pointer(address);
        if (pointer(player + O.characterData) === player + O.characterStorage && player > address
          && is(pointer(address + MAIN.party), 'party') && is(pointer(address + MAIN.enemyParty), 'enemyParty')) {
          next.main = address;
          break;
        }
      }
    }
    if (!next.main) throw new Error('Official engine globals were not found');
    // Heap-allocated objects bound the static region from above.
    if (!next.staticEnd) {
      let staticEnd = pointer(next.main);
      for (const [name, list] of holders) {
        if (name !== CLASSES.player && name !== CLASSES.party && !/^\d+Scene(_|$)/.test(name)) continue;
        for (const address of list) if (address < staticEnd && pointer(address) > address) staticEnd = Math.min(staticEnd, pointer(address));
      }
      next.staticEnd = staticEnd & ~3;
    }
    const staticEnd = next.staticEnd;
    const statics = name => (holders.get(name) || []).filter(address => address < staticEnd);
    if (!next.scene) {
      for (const [name, list] of holders) {
        if (!/^\d+Scene(_|$)/.test(name)) continue;
        for (const address of list) {
          if (address >= staticEnd) continue;
          const scene = pointer(address), control = pointer(address + 4), stack = vector(address + 20, 8, 64);
          // Scene::instance, Scene::old_instances, then Scene::instances (scene.cpp).
          if (control && stack?.count && pointer(stack.begin + (stack.count - 1) * 8) === scene
            && vector(address + 8, 8, 64) && (!next.scene || address < next.scene)) next.scene = address;
        }
      }
    }
    if (!next.interpreter) {
      next.interpreter = statics(CLASSES.interpreter).find(address => byte(pointer(address) + O.interpreterMain) === 1) || 0;
    }
    if (!next.message) {
      const scene = pointer(next.scene);
      const window = types.scenes.has(pointer(scene)) && word(scene + O.sceneType) === 2 ? pointer(scene + 68) : 0;
      next.message = window ? statics(CLASSES.message).find(address => pointer(address) === window) || 0 : 0;
    }
    if (!next.transition) next.transition = (objects.get(CLASSES.transition) || []).find(address => address < staticEnd) || 0;
    if (!next.multiplayer) {
      const connection = (objects.get(CLASSES.connection) || []).find(address => address < staticEnd);
      next.multiplayer = connection ? connection - O.gmiConnection : 0;
    }
    if (!next.requests) {
      const blocks = new Set(types.vptrs('FileRequestAsyncBlock'));
      for (let address = 0x400; blocks.size && address < staticEnd - 20; address += 4) {
        // unordered_map<string, shared_ptr<FileRequestAsync>>: buckets, count, first, size, 1.0f.
        if (u32[(address + 16) >> 2] !== 0x3f800000) continue;
        const first = pointer(address + 8), size = pointer(address + 12);
        const control = pointer(first + O.nodeControl);
        if (size > 0 && size < 1000000 && blocks.has(pointer(control))
          && pointer(first + O.nodeRequest) === control + 12) { next.requests = address; break; }
      }
    }
    return next;
  }

  const complete = () => !!(anchors?.main && anchors.scene && anchors.interpreter && anchors.transition
    && anchors.multiplayer && anchors.requests && (anchors.message || latest?.scene !== 'Map'));

  // Scans run inside the engine's frame callback, so they are bounded and back
  // off from 2 s to a minute while objects stay missing or checks keep failing.
  // RTTI is static data: a missing class is permanent for this engine. Entering
  // a map retries at once for the message window, which exists only there.
  function ensureDiscovery(now) {
    if (typesError) throw new Error(typesError);
    if (types && complete()) return;
    const enteredMap = latest?.scene === 'Map' && scanScene !== 'Map' && types && anchors?.main;
    if (now < retryAt && !enteredMap) {
      if (!types || !anchors?.main) throw new Error(lastError || 'Engine objects are not ready');
      return;
    }
    scanScene = latest?.scene ?? null;
    retryAt = now + retryDelay;
    retryDelay = Math.min(retryDelay * 2, DISCOVERY_MAX_RETRY_MS);
    if (!types) {
      try { types = discoverTypes(); } catch (cause) { typesError = String(cause?.message || cause); throw cause; }
    }
    anchors = discoverAnchors({ ...(anchors || {}), staticEnd: anchors?.staticEnd || staticBound });
    staticBound = anchors.staticEnd;
  }

  function player() {
    const object = pointer(anchors.main);
    if (!is(object, 'player') || pointer(object + O.characterData) !== object + O.characterStorage) return 0;
    return object;
  }

  function sceneState() {
    const scene = pointer(anchors.scene);
    if (!types.scenes.has(pointer(scene))) return null;
    const type = word(scene + O.sceneType);
    return Number.isInteger(type) && type >= 0 && type < SCENES.length ? { scene, type, name: SCENES[type] } : null;
  }

  function transitionActive() {
    const object = anchors.transition;
    if (!object || !is(object, 'transition')) return false;
    return word(object + O.transitionCurrent) < word(object + O.transitionTotal) || word(object + O.transitionFlash) !== 0;
  }

  function importantFilePending() {
    if (!anchors.requests) return null;
    const blocks = new Set(types.vptrs('FileRequestAsyncBlock'));
    let node = pointer(anchors.requests + 8);
    const size = pointer(anchors.requests + 12);
    for (let seen = 0; node && seen <= size; seen++) {
      const control = pointer(node + O.nodeControl), request = pointer(node + O.nodeRequest);
      if (!blocks.has(pointer(control)) || request !== control + 12) return null;
      const state = word(request + O.requestState);
      if (byte(request + O.requestImportant) && state !== 1 && state !== 2) return true;
      node = pointer(node);
    }
    return node ? null : false;
  }

  function selectedItem(scene) {
    const window = pointer(scene + O.sceneItemWindow);
    if (!is(window, 'itemWindow')) return null;
    const index = word(window + O.selectableIndex), items = vector(window + O.itemData, 4, 100000);
    if (!items || !Number.isInteger(index)) return null;
    const id = index >= 0 && index < items.count ? word(items.begin + index * 4) : 0;
    return id > 0 ? id : 0;
  }

  function commandIndex(window) {
    return is(window, 'command') ? word(window + O.selectableIndex) : null;
  }

  function room() {
    const base = anchors.multiplayer;
    if (!base || !is(base + O.gmiConnection, 'connection')) return null;
    const roomId = word(base + O.gmiRoomId), players = pointer(base + O.gmiPlayerCount);
    if (!Number.isInteger(roomId) || roomId < -1 || roomId > 99999 || players > 100000) return null;
    const connected = !!byte(base + O.gmiConnected) && !!byte(base + O.gmiSessionConnected);
    const pending = !!byte(base + O.gmiSwitching);
    return { room_connected: connected, room_sync_pending: pending,
      room_synced_id: connected && !pending ? roomId : -1, room_player_count: players };
  }

  function unavailable(error) {
    lastError = error;
    latest = { available: false, error };
    return latest;
  }

  function sample(module, coords, now = 0) {
    sampledAt = now;
    try {
      if (!views(module)) return unavailable('Engine memory is not available yet');
      ensureDiscovery(now);
      const object = player();
      if (!object) { anchors = null; return unavailable('Engine player object was not found'); }
      const data = object + O.characterStorage;
      const x = word(data + O.x), y = word(data + O.y);
      // The public API reads the same object, so any mismatch means a changed layout.
      if (Array.isArray(coords) && (coords[0] !== x || coords[1] !== y)) {
        anchors = null;
        retryAt = Math.max(retryAt, now + retryDelay);
        return unavailable('Engine memory layout does not match getPlayerCoords()');
      }
      const scene = sceneState();
      if (!scene) { anchors = { ...anchors, scene: 0 }; return unavailable('Engine scene was not found'); }
      const mapReady = scene.type === 2;
      const interpreter = pointer(anchors.interpreter);
      const running = interpreter && is(interpreter, 'interpreter') && byte(interpreter + O.interpreterMain) === 1
        ? pointer(interpreter + O.interpreterStack) !== pointer(interpreter + O.interpreterStack + 4) : null;
      const window = anchors.message ? pointer(anchors.message) : null;
      const message = window === null ? (mapReady ? null : false) : !window ? false
        : is(window, 'message') ? !(pointer(window + O.drawableFlags) & 4) || !!byte(window + O.messageCloseFinished) : null;
      const files = importantFilePending();
      const system = pointer(anchors.main + MAIN.system);
      const frames = word(system + O.systemFrames);
      const remaining = word(data + O.remainingStep), jumping = !!byte(data + O.jumping);
      const state = {
        available: true, error: null,
        scene: scene.name, frame_count: Number.isInteger(frames) ? frames : null,
        map_id: word(data + O.mapId), player_x: x, player_y: y,
        direction: word(data + O.direction), facing: word(data + O.facing),
        moving: !jumping && remaining > 0, jumping, move_speed: word(data + O.moveSpeed),
        vehicle_type: word(data + O.vehicle), player_paused: !!byte(data + O.pause),
        move_route_overwritten: !!byte(data + O.moveRouteOverwrite), through: !!byte(data + O.through),
        teleport_pending: !!byte(object + O.playerTeleportActive),
        event_running: mapReady ? running : false,
        message_active: message,
        async_pending: transitionActive() || word(scene.scene + O.sceneDelay) > 0 || files === true,
        async_files_known: files !== null,
        menu_allowed: system ? !!byte(system + O.systemMenuAllowed) : null,
        selected_item_id: scene.type === 4 ? selectedItem(scene.scene) : 0,
        title_index: scene.type === 1 ? commandIndex(pointer(scene.scene + O.sceneTitleCommand)) : null,
        title_continue_enabled: scene.type === 1 ? !!byte(scene.scene + O.sceneTitleContinueEnabled) : null,
        title_new_game_index: scene.type === 1 ? word(scene.scene + O.sceneTitleNewGame) : null,
        title_continue_index: scene.type === 1 ? word(scene.scene + O.sceneTitleContinue) : null,
        file_index: [9, 10, 11].includes(scene.type) ? word(scene.scene + O.sceneFileIndex) : null,
        menu_index: scene.type === 3 ? commandIndex(pointer(scene.scene + O.sceneMenuCommand)) : null,
        ...(room() || {}),
      };
      lastError = null;
      latest = state;
      if (complete()) { retryDelay = DISCOVERY_RETRY_MS; retryAt = 0; }
      return state;
    } catch (cause) {
      return unavailable(String(cause?.message || cause).slice(0, 300));
    }
  }

  // Equivalent to the local engine's _Navbot_GetSwitch/_Navbot_GetItemIndex/_Navbot_HasSkill.
  function query(module, request = {}) {
    if (!latest?.available || !views(module) || !anchors?.main) return null;
    const result = { switches: {}, items: {}, skills: {} };
    const switches = pointer(anchors.main + MAIN.switches);
    const bits = pointer(switches + O.switchBits), capacity = pointer(switches + O.switchCapacity);
    const lower = word(switches + O.switchLowerLimit), words = pointer(switches);
    const switchesValid = switches && bits <= capacity * 32 && capacity < 1000000 && (!bits || inside(words, capacity * 4));
    for (const id of request.switches || []) {
      if (!switchesValid || !Number.isInteger(id)) { result.switches[id] = null; continue; }
      if (id <= 0 || id > Math.max(lower, bits)) { result.switches[id] = -1; continue; }
      result.switches[id] = id <= bits ? (pointer(words + ((id - 1) >> 5) * 4) >>> ((id - 1) & 31)) & 1 : 0;
    }
    const party = pointer(anchors.main + MAIN.party);
    const items = is(party, 'party') ? vector(party + O.partyItems, 2, 100000) : null;
    for (const id of request.items || []) {
      let index = items ? -1 : null;
      for (let i = 0; items && i < items.count; i++) if (half(items.begin + i * 2) === id) { index = i; break; }
      result.items[id] = index;
    }
    const actors = vector(pointer(anchors.main + MAIN.actors), O.actorSize, 100000);
    for (const [actorId, skillId] of request.skills || []) {
      const key = `${actorId}:${skillId}`;
      if (latest.scene !== 'Map') { result.skills[key] = false; continue; }
      const actor = actors && Number.isInteger(actorId) && actorId >= 1 && actorId <= actors.count
        ? actors.begin + (actorId - 1) * O.actorSize : 0;
      if (!actor || !is(actor, 'actor') || word(actor + O.actorId) !== actorId) { result.skills[key] = null; continue; }
      const skills = vector(actor + O.actorSkills, 2, 100000);
      let learned = skills ? false : null;
      for (let i = 0; skills && i < skills.count; i++) if (half(skills.begin + i * 2) === skillId) { learned = true; break; }
      result.skills[key] = learned;
    }
    return result;
  }

  // A JavaScript port of Game_Map::CheckWay for the walking player: chipset
  // passages, tile substitutions, below-layer tile events and character
  // collisions. Bits match the planner: down 1, left 2, right 4, up 8.
  function navigation(module) {
    if (!latest?.available || latest.scene !== 'Map' || !views(module) || !anchors?.interpreter) return null;
    const base = anchors.interpreter, map = pointer(base + MAP.map);
    const width = word(map + O.mapWidth), height = word(map + O.mapHeight), scroll = word(map + O.mapScroll);
    if (!(width > 0 && height > 0 && width * height <= 1000000 && scroll >= 0 && scroll <= 3)) return null;
    const size = width * height;
    const lower = vector(map + O.mapLower, 2, size), upper = vector(map + O.mapUpper, 2, size);
    const lowerTiles = vector(base + MAP.info + O.infoLowerTiles, 1, 10000);
    const upperTiles = vector(base + MAP.info + O.infoUpperTiles, 1, 10000);
    const down = vector(base + MAP.passagesDown, 1, 10000), up = vector(base + MAP.passagesUp, 1, 10000);
    if (lower?.count !== size || upper?.count !== size || !(lowerTiles?.count >= 144) || !(upperTiles?.count >= 144)
      || !(down?.count >= 162) || !(up?.count >= 144)) return null;
    const object = player(), data = object + O.characterStorage;
    if (!object || word(data + O.vehicle) !== 0) return null;
    const tables = [down, up, lowerTiles, upperTiles];
    let checksum = 0;
    for (const table of tables) for (let i = 0; i < table.count; i++) checksum = (checksum * 31 + u8[table.begin + i]) | 0;
    // Tile layers can be rewritten in place (ReplaceTileAt) and a later map can
    // reuse freed addresses, so their contents are hashed at most once a second.
    const layerKey = [map, lower.begin, upper.begin, size].join(':');
    if (layers?.key !== layerKey || sampledAt - layers.at >= 1000 || sampledAt < layers.at) {
      let hash = 0;
      for (const layer of [lower, upper]) {
        for (let i = layer.begin >> 1, end = i + size; i < end; i++) hash = (hash * 31 + i16[i]) | 0;
      }
      layers = { key: layerKey, at: sampledAt, hash };
    }
    const key = [map, width, height, scroll, lower.begin, upper.begin, layers.hash, ...tables.map(table => table.begin), checksum].join(':');
    if (geometry?.key !== key) {
      const passages = new Array(size);
      for (let i = 0; i < size; i++) {
        const upperIndex = half(upper.begin + i * 2) - 10000;
        if (upperIndex < 0 || upperIndex >= upperTiles.count) return null;
        const upperTile = u8[upperTiles.begin + upperIndex];
        if (upperTile >= up.count) return null;
        const upperFlags = u8[up.begin + upperTile];
        const raw = half(lower.begin + i * 2);
        let tile, wall = false;
        if (raw >= 5000) {
          if (raw - 5000 >= lowerTiles.count) return null;
          tile = u8[lowerTiles.begin + raw - 5000] + 18;
        } else if (raw >= 4000) tile = Math.floor((raw - 4000) / 50) + 6;
        else if (raw >= 3000) tile = Math.floor((raw - 3000) / 50) + 3;
        else tile = Math.floor(raw / 1000);
        if (!(tile >= 0 && tile < down.count)) return null;
        // IsPassableLowerTile: these wall autotile shapes are passable in every direction.
        if (raw >= 4000 && raw < 5000) wall = (u8[down.begin + tile] & 0x20) !== 0 && WALL_SHAPES.has((raw - 4000) % 50);
        const lowerFlags = wall ? 0x0f : u8[down.begin + tile];
        passages[i] = (upperFlags & 0x10 ? upperFlags & lowerFlags : upperFlags) & 0x0f;
      }
      geometry = { key, passages, overlay: null, merged: null };
    }
    const self = { x: word(data + O.x), y: word(data + O.y), layer: word(data + O.layer),
      through: !!byte(data + O.through), flying: !!byte(data + O.flying), active: !!byte(data + O.active) };
    const events = vector(base + MAP.events, O.eventSize, 100000);
    const vehicles = vector(base + MAP.vehicles, O.vehicleSize, 3);
    if (!events || vehicles?.count !== 3) return null;
    const live = [], tileEvents = new Map(), blocked = new Set();
    const collides = character => !self.through && !self.flying && self.active && !character.through
      && !character.flying && character.active && character.layer === self.layer;
    for (let i = 0; i < events.count; i++) {
      const event = events.begin + i * O.eventSize, eventData = event + O.characterStorage;
      if (!is(event, 'event') || pointer(event + O.characterData) !== eventData) return null;
      const page = pointer(event + O.eventPage), definition = pointer(event + O.eventDefinition);
      const pages = definition ? vector(definition + O.definitionPages, O.pageSize, 10000) : null;
      const pageIndex = !page ? -1 : pages && page >= pages.begin && page < pages.begin + pages.count * O.pageSize
        && (page - pages.begin) % O.pageSize === 0 ? (page - pages.begin) / O.pageSize : null;
      const character = {
        id: word(eventData + O.eventId), x: word(eventData + O.x), y: word(eventData + O.y),
        layer: word(eventData + O.layer), through: !!byte(eventData + O.through),
        flying: !!byte(eventData + O.flying), active: !!byte(eventData + O.active), page: pageIndex,
      };
      live.push(character);
      if (!(character.x >= 0 && character.y >= 0 && character.x < width && character.y < height)) continue;
      const tileIndex = character.y * width + character.x;
      const flag = byte(eventData + O.spriteName + 11);
      const spriteLength = flag & 0x80 ? pointer(eventData + O.spriteName + 4) : flag & 0x7f;
      // IsPassableTile: the last (highest ID) qualifying below-layer event with a tile sprite wins.
      if (character.active && page && !character.through && character.layer === 0 && spriteLength === 0) {
        tileEvents.set(tileIndex, word(eventData + O.spriteId));
      }
      if (collides(character)) blocked.add(tileIndex);
    }
    const mapId = word(data + O.mapId);
    for (let i = 0; i < 2; i++) {
      // Boat and ship collide in the current map; the airship never blocks the player.
      const vehicle = vehicles.begin + i * O.vehicleSize, vehicleData = vehicle + O.characterStorage;
      if (!is(vehicle, 'vehicle')) return null;
      const character = { x: word(vehicleData + O.x), y: word(vehicleData + O.y), layer: word(vehicleData + O.layer),
        through: !!byte(vehicleData + O.through), flying: !!byte(vehicleData + O.flying), active: !!byte(vehicleData + O.active) };
      if (word(vehicleData + O.mapId) === mapId && collides(character)
        && character.x >= 0 && character.y >= 0 && character.x < width && character.y < height) {
        blocked.add(character.y * width + character.x);
      }
    }
    const own = self.y * width + self.x;
    const overrides = [...tileEvents].filter(([, tileId]) => tileId > 0 && tileId < up.count && !(u8[up.begin + tileId] & 0x10))
      .map(([tileIndex, tileId]) => [tileIndex, u8[up.begin + tileId] & 0x0f]);
    const obstacles = [...blocked].filter(tileIndex => tileIndex !== own);
    const overlay = `${self.through}|${overrides.join(';')}|${obstacles.join(',')}`;
    if (geometry.overlay !== overlay) {
      const passages = self.through ? new Array(size).fill(15) : geometry.passages.slice();
      if (!self.through) {
        for (const [tileIndex, flags] of overrides) passages[tileIndex] = flags;
        for (const tileIndex of obstacles) passages[tileIndex] = 0;
      }
      geometry.overlay = overlay;
      geometry.merged = passages;
    }
    return { width, height, loopHorizontal: scroll === 2 || scroll === 3, loopVertical: scroll === 1 || scroll === 3,
      passages: geometry.merged, static: geometry.passages, obstacles, events: live, revision: `${key}|${overlay}` };
  }

  function status() {
    return { types: !!types, anchors: anchors ? Object.fromEntries(Object.entries(anchors).map(([key, value]) => [key, !!value])) : null,
      error: lastError };
  }

  return { sample, query, navigation, status, reset };
}

module.exports = { createOfficialMemory };
