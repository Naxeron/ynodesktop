// Timers observe progress; key duration is controlled only by the engine's frame loop.
async function runScenario(send, options, clock = {}) {
  const now = clock.now || Date.now;
  const sleep = clock.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now();
  const timeoutMs = options.timeoutMs ?? 120000;
  const stallMs = options.stallMs ?? 20000;
  let phase = 'boot';
  let lastState = null;
  let startState = null;
  const visitedMaps = [];
  let arrivalSince = null;
  let lastFrame = null;
  let lastFrameProgress = now();
  let lastProgress = now();
  let lastPosition = '';
  let lastScene = '';
  let lastInput = -Infinity;
  let inputs = 0;
  let targetSent = false;
  let readyMap = null;
  let readyMapSince = null;
  let outcome = 'timeout';
  let error = null;
  try {
    while (now() - started < timeoutMs) {
      if (options.signal?.aborted) { outcome = 'interrupted'; break; }
      const result = await send({ op: 'state' });
      if (options.signal?.aborted) { outcome = 'interrupted'; break; }
      if (!result.ready) { await sleep(500); continue; }
      const state = result.state;
      lastState = state;
      if (Number.isInteger(state.frame) && state.frame !== lastFrame) {
        lastFrame = state.frame;
        lastFrameProgress = now();
      }
      if (state.scene === 'Map' && state.map_id > 0 && visitedMaps.at(-1) !== state.map_id && visitedMaps.length < 128) visitedMaps.push(state.map_id);
      if (state.scene !== lastScene) { lastScene = state.scene; lastInput = now(); inputs = 0; }
      if (phase === 'boot') {
        if (state.scene === 'Map' && state.map_id > 0 && state.player_x >= 0 && state.player_y >= 0 && !state.moving && !state.message_active && !state.event_running && !state.async_pending) {
          if (readyMap !== state.map_id || readyMapSince === null) { readyMap = state.map_id; readyMapSince = now(); }
          // Map loading can expose one idle frame before autorun events start.
          if (now() - readyMapSince < 1000) { await sleep(500); continue; }
          if (!options.target) { outcome = 'map-ready'; break; }
          if (state.graph_loaded === false && state.map_id !== options.target.map) {
            if (state.graph_error) { outcome = 'graph-unavailable'; break; }
            await sleep(500); continue;
          }
          await send({ op: 'goto-map', ...options.target });
          startState = state;
          targetSent = true;
          phase = 'navigate';
          lastProgress = now();
        } else {
          readyMapSince = null;
          if (['Title', 'Logo', 'Language', 'File', 'Load'].includes(state.scene) && now() - lastInput >= 2000 && inputs < 3) {
            // The engine selects New Game when no save exists, Continue otherwise.
            await send({ op: 'hold', key: 'decision', frames: 1 });
            lastInput = now();
            inputs++;
          }
        }
      } else {
        const atMap = state.scene === 'Map' && state.map_id === options.target.map;
        const atDestination = atMap && (options.arrival === 'map' || (state.player_x === options.target.x && state.player_y === options.target.y));
        // Do not pass on a transient teleport frame or before the arrival event
        // relinquishes control. A stopped bot can still be settling at its goal.
        if (atDestination && !state.moving && !state.event_running && !state.message_active && !state.async_pending) {
          if (arrivalSince === null) arrivalSince = now();
          if (now() - arrivalSince >= 500) { outcome = 'arrived'; break; }
        } else arrivalSince = null;
        const position = `${state.scene}:${state.map_id}:${state.player_x}:${state.player_y}`;
        if (position !== lastPosition) { lastPosition = position; lastProgress = now(); }
        if (!state.active && state.scene === 'Map' && !atDestination) { outcome = 'navigation-stopped'; break; }
        if (now() - lastProgress >= stallMs) {
          outcome = lastFrame !== null && now() - lastFrameProgress >= stallMs ? 'engine-stalled' : 'stalled';
          break;
        }
      }
      await sleep(500);
    }
  } catch (cause) { outcome = 'error'; error = cause.message; }
  // Always release held input and stop navigation, including timeout/error paths.
  const cleanupErrors = [];
  const stopped = await send({ op: 'stop' }).catch(cause => { cleanupErrors.push(cause.message); return null; });
  const capture = await send({ op: 'capture' }).catch(cause => { cleanupErrors.push(cause.message); return null; });
  return { ok: ['arrived', 'map-ready'].includes(outcome) && cleanupErrors.length === 0, outcome, phase, elapsedMs: now() - started, target: options.target || null, targetSent, arrival: options.arrival || 'tile', startState, visitedMaps, lastState, finalState: stopped?.state || null, error, cleanupErrors, screenshot: capture?.path || null };
}

module.exports = { runScenario };
