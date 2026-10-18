'use strict';

const { at, settled } = require('./route-runner');

// 2kki's Bike is item 12. Using it again removes the effect, so inspect its
// actual state before opening the ordinary item menu.
async function ensureBike(send, { game, snapshot, target, signal, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 6000 } = {}) {
  if (game !== '2kki') return snapshot;
  const checkAbort = () => { if (signal?.aborted) throw new Error('Bike preparation cancelled'); };
  checkAbort();
  snapshot ??= await send({ op: 'state' });
  checkAbort();
  const initial = snapshot?.state;
  // Official sessions prepare Bike only with verified engine state.
  if (initial?.backend === 'official' && initial.capabilities?.bike !== true) return snapshot;
  if (!snapshot?.ready || !initial || !settled(initial) || initial.active || initial.held_keys?.length
    || initial.menu_allowed !== true || initial.vehicle_type !== 0 || initial.bike_blocked === true
    || initial.bike_active !== false || !Number.isInteger(initial.bike_item_index)
    || initial.bike_item_index < 0 || initial.bike_item_index > 11 || (target && at(initial, target))) return snapshot;

  const position = [initial.map_id, initial.player_x, initial.player_y];
  const deadline = now() + timeoutMs;
  let lastFrame = initial.frame, frameAt = now();
  async function read() {
    checkAbort();
    snapshot = await send({ op: 'state' });
    checkAbort();
    const s = snapshot?.state;
    if (!snapshot?.ready || !s) throw new Error('Bike preparation: engine is not ready');
    if (!at(s, position)) throw new Error('Bike preparation: player position changed');
    if (s.frame !== lastFrame) { lastFrame = s.frame; frameAt = now(); }
    if (now() - frameAt > 5000) throw new Error('Bike preparation: engine stopped advancing');
    if (now() >= deadline) throw new Error('Bike preparation timed out');
    return s;
  }
  async function press(key, expected) {
    checkAbort();
    const previousFrame = snapshot.state.frame;
    const sent = await send({ op: 'hold', key, frames: 1 });
    checkAbort();
    const inputFrame = sent?.state?.frame ?? previousFrame;
    for (;;) {
      await sleep(50);
      const s = await read();
      if (s.frame > inputFrame + 1 && !s.held_keys?.length && !s.async_pending && expected(s)) return s;
    }
  }

  try {
    await press('cancel', s => s.scene === 'Menu');
    await press('decision', s => s.scene === 'Item' && s.selected_item_id > 0);
    for (let index = 0; index < initial.bike_item_index && snapshot.state.selected_item_id !== 12; ++index) {
      const previousItem = snapshot.state.selected_item_id;
      await press('right', s => s.scene === 'Item' && s.selected_item_id > 0 && s.selected_item_id !== previousItem);
    }
    if (snapshot.state.selected_item_id !== 12) throw new Error('Bike preparation: the selected item is not Bike');
    await press('decision', s => settled(s) && s.bike_active === true);
    return snapshot;
  } catch (error) {
    // The caller guards this send with its navigation generation. Stop releases
    // keys without selecting or dismissing any unexpected menu.
    if (!signal?.aborted) await send({ op: 'stop' }).catch(() => {});
    throw error;
  }
}

module.exports = { ensureBike };
