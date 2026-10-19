'use strict';

const { at, settled } = require('./route-runner');

// The highest menu index an effect item can have (2kki effect items are 12..47).
const MAX_INDEX = 47;

// The engine state of one effect: its menu index, whether it is active and,
// for the Bike, whether a ladder or boat blocks it. Official sessions report
// effects by item ID; the Bike also has its own fields in both engine modes.
function effectState(s, item) {
  const effect = s?.effects?.[item];
  if (effect) return { index: effect.index, active: effect.active, blocked: item === 12 ? s.bike_blocked : false };
  return item === 12 ? { index: s?.bike_item_index, active: s?.bike_active, blocked: s?.bike_blocked } : null;
}

// Equips a 2kki effect item through the ordinary item menu. Using an active
// effect again removes it, so its actual state is inspected first. With
// `preparing`, the page controller has paused its route for this request, and
// every read must still show that request pending.
async function ensureEffect(send, { game, item = 12, snapshot, target, signal, preparing = null, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs } = {}) {
  if (game !== '2kki') return snapshot;
  const label = item === 12 ? 'Bike preparation' : 'Effect preparation';
  const checkAbort = () => { if (signal?.aborted) throw new Error(`${label} cancelled`); };
  checkAbort();
  snapshot ??= await send({ op: 'state' });
  checkAbort();
  const initial = snapshot?.state;
  // Official sessions prepare effects only with verified engine state.
  if (initial?.backend === 'official' && initial.capabilities?.bike !== true) return snapshot;
  const pending = s => s?.status === 'preparing' && s.preparation_request?.id === preparing;
  const effect = effectState(initial, item);
  if (!snapshot?.ready || !initial || !settled(initial) || (preparing === null ? initial.active : !pending(initial))
    || initial.held_keys?.length || initial.menu_allowed !== true || initial.vehicle_type !== 0 || effect?.blocked === true
    || effect?.active !== false || !Number.isInteger(effect.index)
    || effect.index < 0 || effect.index > MAX_INDEX || (target && at(initial, target))) return snapshot;

  const position = [initial.map_id, initial.player_x, initial.player_y];
  const deadline = now() + (timeoutMs ?? 6000 + 150 * effect.index);
  let lastFrame = initial.frame, frameAt = now();
  async function read() {
    checkAbort();
    snapshot = await send({ op: 'state' });
    checkAbort();
    const s = snapshot?.state;
    if (!snapshot?.ready || !s) throw new Error(`${label}: engine is not ready`);
    if (preparing !== null && !pending(s)) throw new Error(`${label}: the route is no longer waiting for it`);
    if (!at(s, position)) throw new Error(`${label}: player position changed`);
    if (s.frame !== lastFrame) { lastFrame = s.frame; frameAt = now(); }
    if (now() - frameAt > 5000) throw new Error(`${label}: engine stopped advancing`);
    if (now() >= deadline) throw new Error(`${label} timed out`);
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

  // A cursor move into a row below the visible page scrolls the window for
  // four updates, which ignore input (Window_Selectable::Update). The next key
  // waits until then, and a press the window still lost is sent again.
  async function move(key) {
    const previousItem = snapshot.state.selected_item_id;
    for (let attempt = 0; attempt < 3; ++attempt) {
      checkAbort();
      const sent = await send({ op: 'hold', key, frames: 1 });
      checkAbort();
      const inputFrame = sent?.state?.frame ?? snapshot.state.frame;
      for (;;) {
        await sleep(50);
        const s = await read();
        if (s.scene !== 'Item') throw new Error(`${label}: the item menu closed`);
        if (s.held_keys?.length || s.async_pending || s.frame <= inputFrame + 1) continue;
        if (s.selected_item_id > 0 && s.selected_item_id !== previousItem) {
          if (s.frame >= inputFrame + 6) return s;
        } else if (s.frame > inputFrame + 8) break;
      }
    }
    throw new Error(`${label}: the item cursor did not move`);
  }

  try {
    await press('cancel', s => s.scene === 'Menu');
    await press('decision', s => s.scene === 'Item' && s.selected_item_id > 0);
    // The item window has two columns in item ID order: Down moves two
    // entries, Right one. Each press must visibly move the cursor.
    const moves = [...Array(Math.floor(effect.index / 2)).fill('down'), ...Array(effect.index % 2).fill('right')];
    for (const key of moves) {
      if (snapshot.state.selected_item_id === item) break;
      await move(key);
    }
    if (snapshot.state.selected_item_id !== item) throw new Error(`${label}: the selected item is not ${item === 12 ? 'Bike' : `item ${item}`}`);
    await press('decision', s => settled(s) && effectState(s, item)?.active === true);
    return snapshot;
  } catch (error) {
    // The caller guards this send with its navigation generation. Stop releases
    // keys without selecting anything. During a route preparation, a menu left
    // open by a failure is closed again so the route can continue.
    if (!signal?.aborted) {
      if (preparing !== null) await closeMenu().catch(() => {});
      await send({ op: 'stop' }).catch(() => {});
    }
    throw error;
  }
  async function closeMenu() {
    for (let attempt = 0; attempt < 2 && pending(snapshot?.state) && ['Menu', 'Item'].includes(snapshot.state.scene); ++attempt) {
      const scene = snapshot.state.scene, until = now() + 2000;
      await send({ op: 'hold', key: 'cancel', frames: 1 });
      do {
        await sleep(50);
        snapshot = await send({ op: 'state' });
        if (!pending(snapshot?.state)) return;
      } while (snapshot?.state?.scene === scene && now() < until);
    }
  }
}

const ensureBike = (send, options = {}) => ensureEffect(send, { ...options, item: 12 });

module.exports = { ensureBike, ensureEffect, effectState };
