'use strict';

const at = (s, p) => s.map_id === p[0] && s.player_x === p[1] && s.player_y === p[2];
const settled = s => s.scene === 'Map' && !s.moving && !s.event_running && !s.message_active && !s.async_pending && !s.move_route_overwritten;

function validateRoute(steps) {
  const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  const point = (p, map) => Array.isArray(p) && p.length === (map ? 3 : 2)
    && p.every((n, i) => integer(n, map && i === 0 ? 1 : 0, 9999));
  if (!Array.isArray(steps) || !steps.length || steps.length > 1000) throw new Error('Invalid route steps');
  for (const [index, step] of steps.entries()) {
    if (!step || !integer(step.map, 1, 9999) || [step.walk, step.key, step.travel].filter(value => value !== undefined).length !== 1
      || (step.walk !== undefined && !point(step.walk, false))
      || (step.travel !== undefined && !point(step.travel, true))
      || (step.key !== undefined && !['up', 'down', 'left', 'right', 'decision', 'cancel', 'shift'].includes(step.key))
      || (step.expect !== undefined && !point(step.expect, true))
      || (step.until !== undefined && (!step.key || !point(step.until, true)))
      || (step.frames !== undefined && !integer(step.frames, 1, 600))
      || (step.waitFrames !== undefined && !integer(step.waitFrames, 1, 600))
      || (step.settle !== undefined && typeof step.settle !== 'boolean')
      || (step.timeoutMs !== undefined && !integer(step.timeoutMs, 1, 180000))) {
      throw new Error(`Invalid route step ${index + 1}`);
    }
  }
}

// Timers observe the game; every input is held for bounded engine frames.
async function runRoute(send, steps, { signal, onStep = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  validateRoute(steps);
  let snapshot;
  const check = () => { if (signal?.aborted) throw new Error('Route cancelled'); };
  const read = async () => {
    check();
    snapshot = await send({ op: 'state' });
    check();
    if (!snapshot.ready) throw new Error('Navbot engine is not ready');
    return snapshot.state;
  };
  try {
    for (const [index, step] of steps.entries()) {
      check();
      let s = await read();
      if (s.scene !== 'Map' || s.map_id !== step.map) throw new Error(`Step ${index + 1}: expected map ${step.map}, got ${s.map_id}`);
      onStep(index, step, snapshot);
      const started = now();
      let lastFrame = s.frame, frameAt = started, arrivalAt = null;
      const expected = step.expect || step.until || step.travel || (step.walk && [step.map, ...step.walk]);
      await send({ op: 'stop' });
      check();
      const command = step.travel ? { op: 'goto-map', map: step.travel[0], x: step.travel[1], y: step.travel[2] }
        : step.walk ? { op: 'goto', x: step.walk[0], y: step.walk[1] }
        : { op: 'hold', key: step.key, frames: step.frames ?? 1 };
      const sent = await send(command);
      let inputFrame = sent?.state?.frame ?? s.frame;
      for (;;) {
        await sleep(100);
        s = await read();
        if (s.frame !== lastFrame) { lastFrame = s.frame; frameAt = now(); }
        if (now() - frameAt > 5000) throw new Error(`Step ${index + 1}: engine stopped advancing`);
        if (now() - started > (step.timeoutMs ?? (step.walk || step.travel ? 180000 : 90000))) throw new Error(`Step ${index + 1}: timed out at ${s.map_id}:${s.player_x},${s.player_y}`);
        const released = !s.held_keys?.length && s.frame > inputFrame + Math.max(1, step.waitFrames ?? 0);
        if (released && (!expected || at(s, expected)) && (step.settle === false || settled(s))) {
          arrivalAt ??= now();
          if (now() - arrivalAt >= (step.settle === false ? 100 : 200)) break;
        } else arrivalAt = null;
        if (!step.travel && settled(s) && s.map_id !== step.map && s.map_id !== expected?.[0]) {
          throw new Error(`Step ${index + 1}: unexpected map ${s.map_id}`);
        }
        if ((step.walk || step.travel) && !s.active && settled(s) && expected && !at(s, expected)) {
          throw new Error(`Step ${index + 1}: ${s.last_error || s.status} at ${s.map_id}:${s.player_x},${s.player_y}`);
        }
        if (step.until && released && settled(s) && !at(s, expected)) {
          check();
          const repeated = await send(command);
          inputFrame = repeated?.state?.frame ?? s.frame;
        }
      }
    }
    return snapshot;
  } finally {
    // The owner cancels old routes before accepting a new movement command.
    await send({ op: 'stop' });
  }
}

module.exports = { runRoute, validateRoute, at, settled };
