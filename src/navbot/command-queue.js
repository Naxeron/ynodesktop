'use strict';

const movementOps = new Set(['goto', 'goto-map', 'hold']);
const cancelledByStopOps = new Set([...movementOps, 'reconnect']);
const mutationOps = new Set([...cancelledByStopOps, 'reload', 'close']);

// Stop must not wait behind renderer timeouts. Each Stop starts a new command
// generation: old movement is cancelled, and newer requests wait for that Stop.
// `extension` adds time the dispatcher itself spent on a command's behalf.
function createCommandQueue(dispatch, { now = Date.now, ttlMs = 4500, extension = () => 0 } = {}) {
  let queue = Promise.resolve();
  let generation = 0;
  return function schedule(command, { receivedAt = now(), disconnected = () => false } = {}) {
    const stop = command?.op === 'stop';
    if (stop) ++generation;
    const control = { generation, expiresAt: receivedAt + ttlMs, disconnected };
    const execute = async () => {
      if (cancelledByStopOps.has(command?.op) && control.generation !== generation) throw new Error('Command cancelled by Stop');
      if (!stop && disconnected()) throw new Error('Command client disconnected');
      if (mutationOps.has(command?.op) && now() > control.expiresAt + extension(command)) throw new Error('Command expired while waiting for the renderer');
      return dispatch(command, control);
    };
    const result = stop ? execute() : queue.then(execute);
    queue = result.catch(() => {});
    return result;
  };
}

module.exports = { createCommandQueue };
