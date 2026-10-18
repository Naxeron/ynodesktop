'use strict';

// Serialized into the page before its scripts run; keep dependencies inside this function.
// `memory` is the optional read-only engine-state reader from official-memory.js.
function installOfficialInput(game, memory = null) {
  if (window.__ynoOfficialInput) return window.__ynoOfficialInput;
  if (typeof game !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(game)) throw new Error('Invalid game');

  const keys = {
    up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40],
    left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
    decision: ['Enter', 'Enter', 13], cancel: ['Escape', 'Escape', 27], shift: ['Shift', 'ShiftLeft', 16],
  };
  const listeners = new Set();
  const wrappers = new WeakSet();
  let engine = null, initialized = false, held = null, iterationInput = null;
  let frame = 0, map = null, x = null, y = null, changed = 0, teleports = 0;
  let teleportMap = null, teleportX = null, teleportY = null;
  let changedMs = 0;
  let roomAcks = 0, mapAtAck = null, error = null, hookError = null;
  // Logical game frames accumulated from Game_System::frame_count deltas.
  let engineState = null, logicalFrames = null, lastFrameCount = null;
  // The last logical frame at which the engine was busy (async/transition) or
  // switched scenes. Input read during those frames never reaches the scene.
  let busyFrame = -1, lastScene = null;
  const pendingFrames = new Map();
  const nativeRequestFrame = window.requestAnimationFrame, nativeCancelFrame = window.cancelAnimationFrame;
  let frameRequestId = 0;

  function cancelFrame(id) {
    const pending = pendingFrames.get(id);
    if (!pending) return;
    pendingFrames.delete(id);
    nativeCancelFrame.call(window, pending.native);
    window.clearTimeout(pending.timer);
  }

  if (typeof nativeRequestFrame === 'function' && typeof nativeCancelFrame === 'function') {
    // Wayland occlusion can stop compositor frames even with Electron background throttling disabled.
    window.requestAnimationFrame = function(callback) {
      if (typeof callback !== 'function') return nativeRequestFrame.call(window, callback);
      const id = ++frameRequestId;
      const pending = { native: null, timer: null };
      pendingFrames.set(id, pending);
      const finish = timestamp => {
        if (!pendingFrames.has(id)) return;
        cancelFrame(id);
        callback.call(window, timestamp);
      };
      pending.native = nativeRequestFrame.call(window, finish);
      pending.timer = window.setTimeout(() => finish(performance.now()), 20);
      return id;
    };
    window.cancelAnimationFrame = id => cancelFrame(Number(id) >>> 0);
  }

  function release() {
    const input = held;
    held = null;
    if (input?.pressed) dispatch(input, 'keyup');
  }

  function fail(reason) {
    error = String(reason?.message || reason).slice(0, 300);
    try { release(); } catch (_) { /* Canvas may already be gone during page teardown. */ }
  }

  function dispatch(input, type) {
    const [key, code, keyCode] = keys[input.key];
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { key, code, keyCode, which: keyCode });
    input.canvas.dispatchEvent(event);
  }

  // Scenes in which the player's map is not loaded (title return keeps stale coordinates).
  const offMap = new Set(['Null', 'Title', 'Logo', 'Language', 'Gameover', 'GameBrowser']);

  let mapFromMemory = false;
  function sampleMemory(coords) {
    if (!memory) return;
    engineState = memory.sample(engine, coords, performance.now());
    if (!engineState?.available) {
      // The map identity was checked against getPlayerCoords() when it was set;
      // keep it and continue with coordinates and callbacks.
      mapFromMemory = false;
      return;
    }
    const count = engineState.frame_count;
    if (Number.isInteger(count)) {
      // New Game and Load replace the counter inside a scene update that has
      // already counted itself, so a replacement counts as one frame. One
      // callback runs at most a dozen frames (200 ms catch-up).
      const delta = lastFrameCount === null ? 0 : count - lastFrameCount;
      logicalFrames = (logicalFrames ?? 0) + (delta > 0 && delta <= 60 ? delta : delta !== 0 ? 1 : 0);
      lastFrameCount = count;
    }
    if (engineState.async_pending || engineState.scene !== lastScene) {
      busyFrame = logicalFrames ?? -1;
      lastScene = engineState.scene;
    }
    const mapId = engineState.map_id;
    const known = Number.isInteger(mapId) && mapId > 0 && mapId <= 9999 && !offMap.has(engineState.scene);
    if (!known) { map = null; mapFromMemory = false; }
    else if (map !== mapId) { map = mapId; mapFromMemory = true; changed = frame; changedMs = performance.now(); }
  }

  function refresh() {
    if (!initialized || typeof engine?.api?.getPlayerCoords !== 'function') return;
    // Coordinates are read once a map is loaded, or once memory has found the
    // live player object that getPlayerCoords() reads; every sample that then
    // drives navigation or boot input is checked against them.
    const probe = map === null && memory ? memory.sample(engine, null, performance.now()) : null;
    if (map === null && !probe?.available) { sampleMemory(null); return; }
    const coords = engine.api.getPlayerCoords();
    sampleMemory(Array.isArray(coords) ? [coords[0], coords[1]] : null);
    if (map === null) return;
    const nextX = Number.isInteger(coords?.[0]) && coords[0] >= 0 ? coords[0] : null;
    const nextY = Number.isInteger(coords?.[1]) && coords[1] >= 0 ? coords[1] : null;
    if (x !== nextX || y !== nextY) { changed = frame; changedMs = performance.now(); }
    x = nextX;
    y = nextY;
  }

  const logicalTiming = () => logicalFrames !== null && engineState?.available === true;
  // Like the local engine, which applies simulated keys only inside scene
  // updates: a new press waits until a scene has updated since it was busy.
  const inputReady = () => !logicalTiming() || (!engineState.async_pending && logicalFrames > busyFrame);

  function holdRemaining() {
    if (!held) return 0;
    if (!held.pressed) return held.frames;
    if (held.startLogical !== null && logicalTiming()) return Math.max(1, held.frames - (logicalFrames - held.startLogical));
    return Math.max(1, Math.ceil((held.until - performance.now()) * 60 / 1000));
  }

  function read() {
    try { refresh(); } catch (reason) { fail(reason); }
    const logical = logicalTiming();
    return {
      ready: !hookError && initialized && typeof engine?.api?.getPlayerCoords === 'function',
      map_id: map, player_x: x, player_y: y, map_known: map !== null,
      frame: logical ? logicalFrames : frame, loop_frame: frame,
      position_changed_frame: changed, teleport_sequence: teleports,
      teleport_map_id: teleportMap, teleport_x: teleportX, teleport_y: teleportY,
      time_ms: performance.now(), position_changed_ms: changedMs,
      room_ack_sequence: roomAcks, map_at_ack: mapAtAck,
      held_key: held?.key || null,
      hold_remaining: holdRemaining(),
      input_timing: logical ? 'logical-frames' : 'elapsed-main-loop', error: hookError || error,
      memory: engineState ? { ...engineState } : null,
    };
  }

  function intercept(name, wrap, optional = false) {
    const decorate = value => {
      if (typeof value !== 'function' || wrappers.has(value)) return value;
      const result = wrap(value);
      wrappers.add(result);
      return result;
    };
    try {
      let value = decorate(window[name]);
      const descriptor = Object.getOwnPropertyDescriptor(window, name);
      if (descriptor && !descriptor.configurable) {
        if (!descriptor.writable && typeof descriptor.set !== 'function') throw new Error('hook is read-only');
        // Global function declarations are non-configurable, but remain assignable.
        window[name] = value;
        if (window[name] !== value) throw new Error('hook assignment was ignored');
      } else {
        Object.defineProperty(window, name, {
          configurable: true, enumerable: true,
          get: () => value,
          set: next => { value = decorate(next); },
        });
      }
    } catch (reason) {
      if (optional) return;
      hookError = `Official Navbot cannot install ${name}: ${reason.message}. Reload the game to retry.`;
      fail(hookError);
    }
  }

  function observeCallbacks() {
    intercept('onPlayerTeleported', original => function(mapId, playerX, playerY, ...args) {
      try {
        release();
        map = Number.isInteger(mapId) && mapId > 0 && mapId <= 9999 ? mapId : null;
        mapFromMemory = false;
        x = Number.isInteger(playerX) && playerX >= 0 ? playerX : null;
        y = Number.isInteger(playerY) && playerY >= 0 ? playerY : null;
        // A script can move again before the next engine-loop observation.
        teleportMap = map; teleportX = x; teleportY = y;
        changed = frame;
        changedMs = performance.now();
        ++teleports;
      } catch (reason) { fail(reason); }
      return original.call(this, mapId, playerX, playerY, ...args);
    });
    intercept('onRoomSwitch', original => function(...args) {
      ++roomAcks;
      // The callback carries no map ID; this is an observation, not server map verification.
      mapAtAck = map;
      return original.apply(this, args);
    });
    // New Game and Continue load a map without onPlayerTeleported. Teleports call
    // this first and onPlayerTeleported in the same frame, so it only fills a gap.
    intercept('onLoadMap', original => function(mapName, ...args) {
      try {
        const match = typeof mapName === 'string' ? /^Map(\d{4})\.lmu$/i.exec(mapName) : null;
        const mapId = match ? Number(match[1]) : null;
        // Without verified engine state this is always the player's new map;
        // teleports overwrite it with onPlayerTeleported in the same frame.
        if (mapId > 0 && !engineState?.available) {
          if (map !== mapId) { changed = frame; changedMs = performance.now(); }
          map = mapId; mapFromMemory = false;
        }
      } catch (reason) { fail(reason); }
      return original.call(this, mapName, ...args);
    }, true);
  }

  intercept('createEasyRpgPlayer', original => function(options = {}, ...args) {
    release();
    engine = options;
    initialized = false;
    map = x = y = mapAtAck = null;
    mapFromMemory = false;
    teleportMap = teleportX = teleportY = null;
    engineState = logicalFrames = lastFrameCount = lastScene = null;
    busyFrame = -1;
    memory?.reset();
    error = null;
    // Script function declarations can replace the document-start callback accessors.
    observeCallbacks();
    const previousPre = options.preMainLoop, previousPost = options.postMainLoop;
    options.preMainLoop = function(...hookArgs) {
      let result;
      try { result = previousPre?.apply(this, hookArgs); }
      catch (reason) { fail(reason); throw reason; }
      if (result === false) return false;
      try {
        ++frame;
        iterationInput = held;
        if (held && !held.pressed && initialized && inputReady()) {
          held.pressed = true;
          held.until = performance.now() + held.frames * 1000 / 60;
          // The engine drains input before each logical frame of this iteration.
          held.startLogical = logicalTiming() ? logicalFrames : null;
          dispatch(held, 'keydown');
        }
      } catch (reason) { fail(reason); }
      return result;
    };
    options.postMainLoop = function(...hookArgs) {
      try {
        return previousPost?.apply(this, hookArgs);
      } catch (reason) {
        fail(reason);
        throw reason;
      } finally {
        try {
          refresh();
          if (held && held === iterationInput && held.pressed) {
            // Logical frames freeze during transitions, as in the local engine; a
            // generous elapsed bound still releases keys if memory reads stop.
            const logical = held.startLogical !== null && logicalTiming();
            if (logical ? logicalFrames - held.startLogical >= held.frames || performance.now() >= held.until + 30000
              : performance.now() >= held.until) release();
          }
          const state = read();
          for (const listener of Array.from(listeners)) {
            try { listener(state); } catch (reason) { listeners.delete(listener); fail(reason); }
          }
        } catch (reason) { fail(reason); }
      }
    };
    const ready = module => { engine = module; initialized = true; return module; };
    try {
      const result = original.call(this, options, ...args);
      return result?.then ? result.then(ready, reason => { fail(reason); throw reason; }) : ready(result);
    } catch (reason) { fail(reason); throw reason; }
  });
  observeCallbacks();

  function readAsset(name) {
    const currentMap = map === null ? null : `Map${String(map).padStart(4, '0')}.lmu`;
    if (typeof name !== 'string' || (name.toLowerCase() !== 'rpg_rt.ldb' && name.toLowerCase() !== currentMap?.toLowerCase())) {
      throw new Error('Only the database and current map can be read');
    }
    const fs = engine?.FS;
    if (!initialized || !fs) throw new Error('Engine filesystem is not ready');
    const child = (directory, requested) => {
      const entries = fs.readdir(directory);
      if (entries.length > 20000) throw new Error('Engine asset directory is too large');
      const match = entries.find(entry => entry.toLowerCase() === requested.toLowerCase());
      if (!match || match.includes('/') || match === '.' || match === '..') throw new Error(`Asset is not loaded: ${requested}`);
      return `${directory === '/' ? '' : directory}/${match}`;
    };
    const directory = child(child('/', 'easyrpg'), game);
    const filename = child(directory, name);
    if (fs.stat(filename).size > 64 * 1024 * 1024) throw new Error('Engine asset is too large');
    const bytes = fs.readFile(filename);
    const chunks = [];
    for (let start = 0; start < bytes.length; start += 8192) {
      let chunk = '';
      for (let i = start; i < Math.min(start + 8192, bytes.length); ++i) chunk += String.fromCharCode(bytes[i]);
      chunks.push(chunk);
    }
    return btoa(chunks.join(''));
  }

  window.addEventListener('pagehide', () => {
    for (const id of pendingFrames.keys()) cancelFrame(id);
    try { release(); } catch (reason) { fail(reason); }
  });
  window.__ynoOfficialInput = {
    read,
    hold(key, frames) {
      if (!Object.hasOwn(keys, key)) throw new Error('Invalid input key');
      if (!Number.isInteger(frames) || frames < 1 || frames > 600) throw new Error('Input frames must be an integer in 1..600');
      if (!read().ready) throw new Error('Official engine is not ready');
      const canvas = document.getElementById('canvas');
      if (!canvas) throw new Error('Engine canvas is unavailable');
      release();
      error = null;
      held = { key, frames, pressed: false, until: null, startLogical: null, canvas };
      return read();
    },
    stop() { release(); return read(); },
    // Read-only engine-state queries; null when memory introspection is unavailable.
    query(request) { return memory && engineState?.available ? memory.query(engine, request) : null; },
    navigation() { return memory && engineState?.available ? memory.navigation(engine) : null; },
    subscribe(callback) {
      if (typeof callback !== 'function') throw new Error('Listener must be a function');
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    readAsset,
  };
  return window.__ynoOfficialInput;
}

module.exports = { installOfficialInput };
