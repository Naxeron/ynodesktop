'use strict';

// Runs in the page. The engine owns gameplay and networking; this controller
// only plans walking and holds the same canvas keys as the touch controls.
// When read-only engine state is available (input.read().memory), it pauses
// like the local engine, plans against live collision and can replan.
function createOfficialController(input, planner) {
  let grid = null, gridMap = null, target = null, route = [], path = [], step = null, lastStep = null, lastSeen = null;
  let status = 'idle', error = '', started = 0, transition = null, blocked = new Set();
  let failures = 0, interrupts = 0, lastTick = null, liveUsed = false, liveNear = [], liveMismatch = null, liveDisabled = false, liveBlocked = null;
  // Tiles that stayed occupied while live collision blocked the route (for
  // example invisible event walls); kept when falling back to static passages.
  let stationary = new Set(), fallback = null;
  let destination = null, transfers = [], interactions = [], teleportSequence = 0, facing = null;
  // Global replanning, as in the local engine: the desktop process owns the map
  // graph, so the page publishes a request and waits for reroute().
  let rerouteEnabled = false, rerouteRequest = null, rerouteSequence = 0, reroutes = 0, globalCommand = false, rerouteReason = '';
  const observedExits = new Map(), blockedExits = new Set(), transitionCounts = new Map();
  // Unexplained failures of steps that live collision reports as open.
  const stepFailures = new Map();
  // Steps that warped the player within the destination map, per command.
  const warpSteps = new Set();
  const exitKey = (mapId, edge) => `${mapId}:${edge.startX},${edge.startY}`;
  const keys = ['up', 'down', 'left', 'right', 'decision', 'cancel', 'shift'];
  const offsets = { down: [0, 1], left: [-1, 0], right: [1, 0], up: [0, -1] };
  const directions = ['up', 'right', 'down', 'left'];
  const at = (s, p) => s.player_x === p.x && s.player_y === p.y;
  const quiet = s => s.time_ms - s.position_changed_ms >= 500;
  // Engine state is used only after official-memory verified its reads.
  const engineOf = s => s.memory?.available === true ? s.memory : null;
  // States in which the local engine does not process navigation at all.
  const engineBusy = m => !!m && (m.scene !== 'Map' || m.message_active === true || m.event_running === true || !!m.async_pending);
  const engineSettled = m => !m || (!engineBusy(m) && !m.moving && !m.move_route_overwritten && !m.player_paused);
  function stop(next = 'stopped', reason = '') {
    input.stop(); target = null; route = []; path = []; step = null; transition = null; facing = null;
    rerouteRequest = null; status = next; error = reason;
  }
  function fail(reason) { stop('error', reason); }
  // Like the local engine, only travel to another map replans, and only with
  // verified engine state; a map change during same-map walking ends it
  // (recipes rely on that for scripted transfers).
  function requestReroute(s, reason) {
    if (!rerouteEnabled || !globalCommand || !engineOf(s) || ++reroutes > 16) return fail(reason);
    input.stop(); route = []; path = []; step = null; transition = null; facing = null;
    rerouteRequest = { id: ++rerouteSequence, map: s.map_id, since: s.time_ms, reason };
    rerouteReason = reason;
    status = 'rerouting';
  }
  // A departure that cannot be reached or resolved is excluded for this command.
  function departureFailed(s, edge, reason) {
    if (!edge || !route.length || !rerouteEnabled || !globalCommand || !engineOf(s)) return fail(reason);
    blockedExits.add(exitKey(edge.mapId, edge));
    return requestReroute(s, reason);
  }
  // A teleport that did not match the expected exit. Only an armed departure is
  // recorded as observed, as in the local engine; the final map is judged.
  function unexpectedLanding(s, edge, reason, trigger = null) {
    if (!rerouteEnabled || !globalCommand || !engineOf(s)) return fail(reason);
    if (s.map_id === target.map && Number.isInteger(s.player_x)) {
      const key = `warp:${s.map_id}@${s.player_x},${s.player_y}`;
      transitionCounts.set(key, (transitionCounts.get(key) || 0) + 1);
      if (transitionCounts.get(key) >= 3) return fail(`${reason} The same transition repeated three times.`);
      // Avoid the step that warped the player while walking on this map.
      if (trigger?.map === s.map_id) warpSteps.add(`${trigger.map}|${planner.stepKey(trigger.fromX, trigger.fromY, trigger.direction)}`);
      route = []; transition = null; status = 'navigating';
      return;
    }
    const key = `${edge ? exitKey(edge.mapId, edge) : 'unattributed'}>${s.map_id}`;
    transitionCounts.set(key, (transitionCounts.get(key) || 0) + 1);
    if (transitionCounts.get(key) >= 3) return fail(`${reason} The same transition repeated three times.`);
    if (edge && edge.mapId !== s.map_id) observedExits.set(exitKey(edge.mapId, edge), s.map_id);
    return requestReroute(s, reason);
  }
  function installMap(mapId, navigation, localTransfers = [], exitInteractions = []) {
    planner.validateMap(navigation);
    planner.validateInteractions(exitInteractions, navigation);
    if (input.read().map_id !== mapId) return;
    grid = navigation; gridMap = mapId; transfers = localTransfers; interactions = exitInteractions;
    path = []; step = null; facing = null; blocked.clear(); stepFailures.clear(); liveMismatch = null; liveDisabled = false; liveBlocked = null;
    stationary = new Set(); fallback = null;
  }
  // Live engine state for the installed map: CheckWay passability (unless this
  // map fell back to static passages) and active event pages.
  function liveState() {
    const nav = typeof input.navigation === 'function' ? input.navigation() : null;
    if (!nav || !grid || nav.width !== grid.width || nav.height !== grid.height
      || nav.loopHorizontal !== grid.loopHorizontal || nav.loopVertical !== grid.loopVertical) return null;
    if (liveMismatch === null && Array.isArray(nav.static)) {
      liveMismatch = 0;
      for (let i = 0; i < nav.static.length; i++) if (nav.static[i] !== grid.passages[i]) liveMismatch++;
    }
    return nav;
  }
  // Static passages without the tiles live collision showed as permanently occupied.
  function geometry() {
    if (!stationary.size) return grid;
    if (fallback?.source !== grid) {
      const passages = grid.passages.slice();
      for (const tile of stationary) if (tile >= 0 && tile < passages.length) passages[tile] = 0;
      fallback = { source: grid, map: { ...grid, passages } };
    }
    return fallback.map;
  }
  const planningGrid = nav => nav ? { width: nav.width, height: nav.height, loopHorizontal: nav.loopHorizontal,
    loopVertical: nav.loopVertical, passages: nav.passages } : geometry();
  // Event ID -> active page index, or -1 when no page is active or the event was erased.
  const activePages = nav => Array.isArray(nav?.events)
    ? new Map(nav.events.filter(event => Number.isInteger(event.page)).map(event => [event.id, event.active === false ? -1 : event.page])) : null;
  function start(map, x, y, edges = []) {
    const s = input.read();
    if (!s.ready || !s.map_known) throw new Error('Load a game before starting navigation.');
    if (![map, x, y].every(Number.isInteger) || map < 1 || map > 9999 || x < 0 || y < 0 || x > 9999 || y > 9999) throw new Error('Invalid destination');
    if (map === s.map_id && gridMap === map && (x >= grid.width || y >= grid.height)) throw new Error('Destination is outside the map');
    stop(); blocked.clear(); stepFailures.clear(); warpSteps.clear(); failures = 0; reroutes = 0;
    observedExits.clear(); blockedExits.clear(); transitionCounts.clear();
    liveDisabled = false; liveBlocked = null; stationary = new Set(); fallback = null; lastStep = null; rerouteReason = '';
    target = destination = { map, x, y }; route = edges.slice(); started = s.time_ms; lastTick = s.time_ms;
    globalCommand = map !== s.map_id;
    teleportSequence = s.teleport_sequence; status = 'navigating';
  }
  function routeGoal(s) {
    if (!route.length) {
      if (s.map_id !== target.map) throw new Error(`Unexpected map ${s.map_id}; expected ${target.map}`);
      return target;
    }
    const edge = route[0];
    if (s.map_id !== edge.mapId) throw new Error(`Unexpected map ${s.map_id}; expected ${edge.mapId}`);
    if (Number.isInteger(edge.approachX)) return { x: edge.approachX, y: edge.approachY };
    return { x: edge.startX, y: edge.startY };
  }
  function approach(s, goal, map, usable) {
    let best = null;
    for (const [direction, [dx, dy]] of Object.entries(offsets)) {
      let x = goal.x - dx, y = goal.y - dy;
      if (map.loopHorizontal) x = (x + map.width) % map.width;
      if (map.loopVertical) y = (y + map.height) % map.height;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const candidate = planner.findPath(map, { x: s.player_x, y: s.player_y }, { x, y }, blocked, usable);
      if (candidate && (!best || candidate.length < best.path.length)) best = { path: candidate, direction };
    }
    return best;
  }
  // Whether one step is currently open in the live collision grid: leave the
  // source tile in its direction and enter the target from the opposite side.
  function liveStepOpen(nav, from, next) {
    const bits = { down: [1, 8], left: [2, 4], right: [4, 2], up: [8, 1] }[next.direction];
    return !!bits && (nav.passages[from.y * nav.width + from.x] & bits[0]) !== 0
      && (nav.passages[next.y * nav.width + next.x] & bits[1]) !== 0;
  }
  function depart(s, direction, onTile = false) {
    input.stop();
    transition = { edge: route[0], since: s.time_ms, direction, phase: onTile ? 'activate' : 'face' };
    input.hold(onTile ? 'decision' : direction, 3);
    status = 'waiting_for_teleport';
  }
  // Whether the current position completes edge (callback landing or, after
  // an event chain, the final position).
  function landed(s, edge, x, y) {
    return s.map_id === edge.targetMapId && Number.isInteger(x) && x >= 0 && Number.isInteger(y) && y >= 0
      && (edge.mapId !== edge.targetMapId || (x === edge.targetX && y === edge.targetY));
  }
  function settle(s, edge) {
    transition = { ...(transition || {}), edge, since: transition?.since ?? s.time_ms, phase: 'settling', arrived: s.time_ms };
    status = 'settling_after_teleport';
  }
  function onTeleport(s, m, prior, trigger) {
    // A teleport while settling completes the previous edge first.
    if (transition?.phase === 'settling') { route.shift(); transition = null; started = s.time_ms; }
    // Further teleports of one event chain are judged once the chain ends.
    if (transition?.phase === 'landing') return;
    const expected = transition?.edge || route[0] || null;
    if (expected && s.map_id === s.teleport_map_id && landed(s, expected, s.teleport_x, s.teleport_y)) return settle(s, expected);
    // Only an exit being taken, or a step onto the next exit tile, is armed.
    const armed = transition?.edge || (expected && prior?.map === expected.mapId
      && ((prior.x === expected.startX && prior.y === expected.startY)
        || (trigger?.x === expected.startX && trigger?.y === expected.startY)) ? expected : null);
    if (armed && s.map_id === s.teleport_map_id && armed.transientMapIds?.includes(s.teleport_map_id)) {
      transition = transition || { edge: armed, since: s.time_ms, phase: 'waiting' };
      transition.phase = 'waiting'; status = 'waiting_for_teleport';
      return;
    }
    const reason = `Unexpected map ${s.teleport_map_id} or landing (${s.teleport_x},${s.teleport_y})${armed ? ' while taking an exit' : ''}.`;
    const valid = s.map_id === s.teleport_map_id && Number.isInteger(s.map_id)
      && Number.isInteger(s.teleport_x) && s.teleport_x >= 0 && Number.isInteger(s.teleport_y) && s.teleport_y >= 0;
    if (!valid) return fail(reason);
    if (m && engineBusy(m) && rerouteEnabled && globalCommand) {
      // As the local engine does, wait for the event chain to finish and judge the final map.
      transition = { edge: armed, expected, since: s.time_ms, phase: 'landing', trigger, reason };
      status = 'waiting_for_teleport';
      return;
    }
    return unexpectedLanding(s, armed, reason, trigger);
  }
  function tick() {
    if (!target) return;
    const s = input.read();
    const m = engineOf(s);
    const elapsed = lastTick === null ? 0 : Math.max(0, s.time_ms - lastTick);
    lastTick = s.time_ms;
    const prior = lastSeen;
    lastSeen = { map: s.map_id, x: s.player_x, y: s.player_y };
    if (s.error) return fail(s.error);
    if (s.time_ms - started > 180000) return fail('Navigation timed out. Check for a menu, dialogue or blocked route.');
    if (s.teleport_sequence !== teleportSequence) {
      teleportSequence = s.teleport_sequence;
      const trigger = step || lastStep;
      input.stop(); path = []; step = null; facing = null; blocked.clear(); stepFailures.clear();
      if (rerouteRequest) { rerouteRequest = { ...rerouteRequest, id: ++rerouteSequence, map: s.map_id }; return; }
      onTeleport(s, m, prior, trigger);
      // Unexpected landings resume walking from the next callback.
      if (!target || !transition) return;
    }
    if (rerouteRequest) {
      input.stop();
      if (s.time_ms - rerouteRequest.since > 15000) return fail(`${rerouteRequest.reason} No new route was planned.`);
      return;
    }
    if (!transition && !route.length && s.map_id !== target.map) return fail(`Unexpected map ${s.map_id}.`);
    if (transition) {
      const t = transition;
      // Events, messages, scene changes and loads during an exit pause it: no
      // input, and that time does not count toward the exit or command deadlines.
      if (m && engineBusy(m)) {
        input.stop();
        t.since += elapsed; started += elapsed;
        if (m.message_active === true) status = 'paused_message';
        return;
      }
      if (status === 'paused_message') status = t.phase === 'settling' ? 'settling_after_teleport' : 'waiting_for_teleport';
      if (s.time_ms - t.since > 20000) return fail(`The exit did not reach map ${t.edge?.targetMapId ?? target.map} (current map ${s.map_id}).`);
      if (t.phase === 'landing') {
        input.stop();
        if (!quiet(s) || !engineSettled(m)) return;
        transition = null;
        if (t.expected && landed(s, t.expected, s.player_x, s.player_y)) return settle(s, t.expected);
        return unexpectedLanding(s, t.edge, t.reason, t.trigger);
      }
      if (t.phase === 'settling') {
        input.stop();
        if (!engineSettled(m)) return;
        if (!Number.isInteger(s.player_x) || !Number.isInteger(s.player_y)
          || !quiet(s) || s.time_ms - t.arrived < Math.max(500, t.edge.settleMs || 0)) return;
        // Each completed exit restarts the walking deadline for the next map.
        route.shift(); transition = null; status = 'navigating'; started = s.time_ms;
        return;
      }
      if (s.map_id !== t.edge.mapId) {
        input.stop();
        if (!t.edge.transientMapIds?.includes(s.map_id)) return fail(`Unexpected map ${s.map_id} while taking an exit.`);
        return;
      }
      if (t.phase === 'face' && !s.hold_remaining) {
        t.phase = 'activate';
        input.hold(t.edge.action ? 'decision' : t.direction, t.edge.action ? 3 : 60);
      }
      return;
    }
    if (m) {
      // The local engine's pauses: other scenes, messages, then foreground events.
      // Moves forced by scripts or a paused player also cannot take input, but
      // only the local engine's pause states stop the deadlines.
      const pause = m.scene !== 'Map' ? 'paused_scene' : m.message_active === true ? 'paused_message'
        : m.event_running === true || m.move_route_overwritten || m.player_paused ? 'paused_event' : null;
      if (pause || m.async_pending) {
        input.stop(); step = null; path = []; facing = null;
        if (pause) status = pause;
        if (engineBusy(m)) started += elapsed;
        return;
      }
      if (status.startsWith('paused_')) status = 'navigating';
    }
    if (gridMap !== s.map_id || !grid) { input.stop(); status = 'loading_map'; return; }
    if (!Number.isInteger(s.player_x) || !Number.isInteger(s.player_y) || s.player_x < 0 || s.player_y < 0) { input.stop(); return; }
    const state = liveState();
    // A tile stays a stationary obstacle only while live collision still shows it occupied.
    if (stationary.size && Array.isArray(state?.obstacles)) {
      const occupied = new Set(state.obstacles);
      for (const tile of [...stationary]) if (!occupied.has(tile)) { stationary.delete(tile); fallback = null; path = []; }
    }
    const nav = liveDisabled ? null : state;
    liveUsed = !!nav;
    // Diagnostics: live obstacles within five tiles of the player.
    liveNear = Array.isArray(nav?.obstacles) ? nav.obstacles.map(index => ({ x: index % nav.width, y: Math.floor(index / nav.width) }))
      .filter(point => Math.abs(point.x - s.player_x) <= 5 && Math.abs(point.y - s.player_y) <= 5).slice(0, 16) : [];
    const map = planningGrid(nav);
    // Excluded departures are not reused as local transfers either.
    const usable = transfers.filter(edge => !blockedExits.has(exitKey(s.map_id, edge)));
    for (const key of warpSteps) if (key.startsWith(`${s.map_id}|`)) blocked.add(key.slice(key.indexOf('|') + 1));
    if (route.length && typeof route[0].action !== 'boolean') {
      // Exits are resolved on the map geometry; characters only affect walking.
      try {
        // Kept so a departure can be resolved again once stationary obstacles are known.
        const source = route[0];
        route[0] = { ...planner.resolveExit(geometry(), { x: s.player_x, y: s.player_y }, source, interactions, blocked, usable, activePages(state)), source };
      } catch (cause) { return departureFailed(s, route[0], cause.message); }
    }
    for (const blockedStep of route[0]?.blockedApproachSteps || []) blocked.add(blockedStep);
    const goal = routeGoal(s);
    const edge = route[0];
    const onTile = edge?.action && edge.approachX === edge.startX && edge.approachY === edge.startY;
    // The engine's direction when readable, otherwise the last completed step.
    const currentFacing = () => m && Number.isInteger(m.direction) && m.direction >= 0 && m.direction <= 3 ? directions[m.direction] : facing;
    if (goal.x >= map.width || goal.y >= map.height) return fail('Destination is outside the map');
    if (step) {
      if (at(s, step)) { input.stop(); facing = step.direction; step = null; path.shift(); }
      else if (s.player_x !== step.fromX || s.player_y !== step.fromY) {
        input.stop(); step = null; path = []; facing = null;
      } else if (s.time_ms - step.since > 1500) {
        input.stop();
        const key = planner.stepKey(step.fromX, step.fromY, step.direction);
        // A character seen on the step during the attempt (for example a
        // wandering NPC) is temporary. Live collision models the map, so an
        // unexplained failure there is learned only after it repeats.
        const temporary = step.liveBlocked || (nav && !liveStepOpen(nav, { x: step.fromX, y: step.fromY }, step));
        if (!temporary) {
          const repeated = (stepFailures.get(key) || 0) + 1;
          stepFailures.set(key, repeated);
          if (!nav || repeated >= 3) blocked.add(key);
        }
        path = []; step = null;
        if (++failures > 20) return fail('Too many blocked steps. Close any menu or dialogue, then retry.');
      } else {
        if (nav && !liveStepOpen(nav, { x: step.fromX, y: step.fromY }, step)) step.liveBlocked = true;
        return;
      }
    }
    if (at(s, goal) && (!onTile || currentFacing() === directions[edge.direction])) {
      input.stop();
      if (!quiet(s) || !engineSettled(m)) return;
      if (!route.length) return stop('arrived');
      if (edge.action || Number.isInteger(edge.approachX)) return depart(s, directions[edge.direction], onTile);
      // Touch exits normally trigger on the final step. If they have not,
      // wait without pressing unrelated action buttons.
      transition = { edge, since: s.time_ms, phase: 'waiting' };
      status = 'waiting_for_teleport';
      return;
    }
    // Replan when a character moves into the next step.
    if (path.length && nav && !liveStepOpen(nav, { x: s.player_x, y: s.player_y }, path[0])) path = [];
    if (!path.length) {
      let walkGoal = goal, finalStep = null;
      if (onTile) {
        const direction = directions[edge.direction], [dx, dy] = offsets[direction];
        let x = goal.x - dx, y = goal.y - dy;
        if (grid.loopHorizontal) x = (x + grid.width) % grid.width;
        if (grid.loopVertical) y = (y + grid.height) % grid.height;
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return departureFailed(s, edge, 'The action tile cannot be entered facing the required direction.');
        walkGoal = { x, y };
        const entry = planner.findPath(grid, walkGoal, goal, blocked, usable);
        if (entry?.length !== 1 || entry[0].direction !== direction) return departureFailed(s, edge, 'The action tile cannot be entered facing the required direction.');
        finalStep = entry[0];
      }
      path = planner.findPath(map, { x: s.player_x, y: s.player_y }, walkGoal, blocked, usable);
      // A character standing on the goal itself is approached like an occupied
      // door, as the local engine allows a blocked terminal tile.
      const goalOccupied = !path && nav && !onTile && !Number.isInteger(edge?.approachX)
        && nav.passages[walkGoal.y * nav.width + walkGoal.x] === 0 && grid.passages[walkGoal.y * grid.width + walkGoal.x] !== 0;
      if (path) liveBlocked = null;
      else if (nav && !goalOccupied && planner.findPath(grid, { x: s.player_x, y: s.player_y }, walkGoal, blocked, usable)) {
        // Characters can block every route for a moment. Wait for them, then
        // fall back to static passages and observed blockers for this map.
        // Tiles occupied throughout the wait, such as invisible event walls,
        // stay blocked, and the departure is resolved again around them.
        const occupied = new Set(Array.isArray(nav.obstacles) ? nav.obstacles : []);
        if (!liveBlocked) liveBlocked = { since: s.time_ms, tiles: occupied };
        else for (const tile of liveBlocked.tiles) if (!occupied.has(tile)) liveBlocked.tiles.delete(tile);
        const waited = s.time_ms - liveBlocked.since;
        if (waited < 5000) { path = []; status = 'navigating'; return; }
        if (liveBlocked.tiles.size) { for (const tile of liveBlocked.tiles) stationary.add(tile); fallback = null; }
        // Try the departure's other sides once, around the tiles that stayed occupied.
        if (edge?.source && !edge.retried) {
          for (const key of edge.blockedApproachSteps || []) blocked.delete(key);
          route[0] = { ...edge.source, retried: true }; liveBlocked = null; path = [];
          return;
        }
        // Static passages still reach the goal around them: use those for this map.
        if (planner.findPath(geometry(), { x: s.player_x, y: s.player_y }, walkGoal, blocked, usable)) {
          liveDisabled = true; liveBlocked = null; path = []; return;
        }
        // Nothing passes even then; occupied tiles get a little longer to clear.
        if (waited < 15000) { path = []; status = 'navigating'; return; }
        liveBlocked = null;
        return route.length ? departureFailed(s, edge, 'Characters or events kept every route to the next exit blocked.')
          : fail('Characters or events kept every route to the destination blocked.');
      }
      if (!path) {
        const localRoute = planner.findLocalRoute(map, { x: s.player_x, y: s.player_y }, walkGoal, usable, blocked);
        if (localRoute?.length) {
          route.unshift(...localRoute.map(edge => ({ ...edge, mapId: s.map_id })));
          path = []; status = 'navigating'; return;
        }
        if (onTile) return departureFailed(s, edge, 'No walkable route reaches the required side of the action tile.');
        if (Number.isInteger(edge?.approachX)) return departureFailed(s, edge, 'No walkable route reaches the required teleport approach.');
        // An event can occupy an impassable terminal tile, such as a door.
        const adjacent = approach(s, goal, map, usable);
        if (!adjacent) return route.length ? departureFailed(s, edge, 'No walkable route reaches the next exit.')
          : fail('No walkable route found using the current map and observed blockers.');
        path = adjacent.path;
        if (!path.length) {
          if (!quiet(s) || !engineSettled(m)) return;
          if (route.length) return depart(s, adjacent.direction);
          input.hold(adjacent.direction, 1);
          target = null; status = 'interaction_ready'; return;
        }
      }
      if (finalStep) path.push(finalStep);
    }
    const next = path[0];
    if (!next) return;
    status = 'navigating';
    step = lastStep = { ...next, map: s.map_id, fromX: s.player_x, fromY: s.player_y, since: s.time_ms };
    facing = null;
    input.hold(next.direction, 120);
  }
  input.subscribe(() => { try { tick(); } catch (cause) { fail(cause.message); } });
  function read() {
    const s = input.read();
    const m = engineOf(s);
    const { memory, ...base } = s;
    const events = !!m && m.event_running !== null && m.message_active !== null;
    // Recipes and Bike preparation also need known event and message state.
    const capabilities = { scene: !!m, events, bike: events, recipes: events, memory: !!m,
      logical_frames: s.input_timing === 'logical-frames', live_collision: !!m && liveUsed };
    return { ...base, backend: 'official',
      scene: m ? m.scene : null, moving: m ? m.moving : null, event_running: m ? m.event_running : null,
      message_active: m ? m.message_active : null, async_pending: m ? m.async_pending : null,
      move_route_overwritten: m ? m.move_route_overwritten : null, player_paused: m ? m.player_paused : null,
      menu_allowed: m ? m.menu_allowed : null, vehicle_type: m ? m.vehicle_type : null,
      selected_item_id: m ? m.selected_item_id : null, move_speed: m ? m.move_speed : null,
      direction: m ? m.direction : null, title_index: m ? m.title_index : null,
      title_continue_enabled: m ? m.title_continue_enabled : null, title_new_game_index: m ? m.title_new_game_index : null,
      title_continue_index: m ? m.title_continue_index : null, file_index: m ? m.file_index : null,
      menu_index: m ? m.menu_index : null,
      ...(m && typeof m.room_connected === 'boolean' ? { room_connected: m.room_connected, room_sync_pending: m.room_sync_pending,
        room_synced_id: m.room_synced_id, room_player_count: m.room_player_count } : {}),
      bike_item_index: null, bike_active: null, bike_blocked: null, forest_pier_visited: null,
      engine_state_error: memory && !m ? memory.error : null, live_collision_mismatch: liveMismatch,
      live_obstacles_near: liveNear,
      observed_stationary: s.map_known && quiet(s), user_interrupts: interrupts,
      active: !!target, status, last_error: error,
      map_width: grid && gridMap === s.map_id ? grid.width : 0, map_height: grid && gridMap === s.map_id ? grid.height : 0,
      graph_loaded: true, path_length: path.length, path: path.slice(0, 100),
      target_map_id: destination?.map ?? -1, target_x: destination?.x ?? -1, target_y: destination?.y ?? -1,
      global_target_x: destination?.x ?? -1, global_target_y: destination?.y ?? -1,
      global_active: !!target && (route.length > 0 || !!rerouteRequest), route_length: route.length,
      reroute_request: rerouteRequest && target ? { id: rerouteRequest.id, map: rerouteRequest.map, target_map: target.map,
        reason: String(rerouteRequest.reason || '').slice(0, 300),
        observed: [...observedExits].slice(0, 128), blocked: [...blockedExits].slice(0, 128) } : null,
      observed_departures: [...observedExits].slice(0, 32).map(([key, map]) => ({ departure: key, map })),
      unreachable_departures: [...blockedExits].slice(0, 32), reroutes, last_reroute_reason: rerouteReason,
      stationary_obstacles: stationary.size,
      route: route.map(edge => edge.targetMapId),
      held_keys: s.held_key ? [{ button: keys.indexOf(s.held_key), frames: s.hold_remaining }] : [],
      capabilities,
    };
  }
  return { read, stop, start, installMap, fail,
    // Real keyboard input on the game canvas stops this controller and lets the
    // desktop cancel its own recipes and preparations. While navigation is
    // paused or the game is busy, keys answer the game (for example to close a
    // dialogue) and navigation resumes afterwards, as in the local engine.
    interrupt() {
      const m = engineOf(input.read());
      if (status.startsWith('paused_') || ['settling', 'landing'].includes(transition?.phase) || engineBusy(m)) return false;
      ++interrupts;
      if (target) stop('stopped', 'Stopped by keyboard input'); else input.stop();
      return true;
    },
    // Enabled by the desktop process, which answers reroute requests.
    configure(options) { rerouteEnabled = options?.reroute === true; },
    reroute(id, edges, message) {
      if (!target || rerouteRequest?.id !== id) return false;
      rerouteRequest = null;
      if (!Array.isArray(edges)) { fail(message || 'No route remains from this map.'); return true; }
      route = edges.slice(); path = []; step = null; status = 'navigating';
      return true;
    },
    query(request) { return typeof input.query === 'function' ? input.query(request) : null; },
    execute(call) {
      const [name, args, edges] = call;
      if (name === '_Navbot_Stop') stop();
      else if (name === '_Navbot_HoldKey') { stop(); input.hold(keys[args[0]], args[1]); }
      else if (name === '_Navbot_GoTo') start(input.read().map_id, ...args);
      else if (name === '_Navbot_GoToMap') start(...args, edges);
      else throw new Error('Unsupported official-engine command');
    },
  };
}

module.exports = { createOfficialController };
