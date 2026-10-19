'use strict';

// Keep the factory self-contained so the desktop can inject it into the isolated page.
function createPlanner() {
  const directions = [
    { name: 'down', dx: 0, dy: 1, bit: 1, reverse: 8 },
    { name: 'left', dx: -1, dy: 0, bit: 2, reverse: 4 },
    { name: 'right', dx: 1, dy: 0, bit: 4, reverse: 2 },
    { name: 'up', dx: 0, dy: -1, bit: 8, reverse: 1 },
  ];
  const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && value <= 2147483647;
  const stepKey = (x, y, direction) => `${x},${y}:${direction}`;
  const exitKey = (mapId, edge) => `${mapId}:${edge.startX},${edge.startY}`;
  const insideMap = (map, point) => point && integer(point.x) && integer(point.y)
    && point.x < map.width && point.y < map.height;

  function validateMap(map) {
    if (!map || !integer(map.width, 1) || !integer(map.height, 1)
      || map.width * map.height > 1000000 || typeof map.loopHorizontal !== 'boolean'
      || typeof map.loopVertical !== 'boolean' || !Array.isArray(map.passages)
      || map.passages.length !== map.width * map.height
      || map.passages.some(value => !Number.isInteger(value) || value < 0 || value > 15)) {
      throw new Error('Invalid navigation map');
    }
    return map;
  }

  function validateInteractions(interactions, map) {
    if (!Array.isArray(interactions) || interactions.length > 10000) throw new Error('Invalid exit interactions');
    const ids = new Set();
    for (const event of interactions) {
      if (!event || !integer(event.eventId, 1) || ids.has(event.eventId)
        || !insideMap(map, { x: event.startX, y: event.startY })
        || !Array.isArray(event.pages) || !event.pages.length || event.pages.length > 1000) {
        throw new Error('Invalid exit interaction event');
      }
      ids.add(event.eventId);
      for (const page of event.pages) {
        if (!page || !integer(page.trigger) || page.trigger > 4 || !integer(page.layer) || page.layer > 2
          || typeof page.unsupported !== 'boolean' || !Array.isArray(page.targetMapIds) || page.targetMapIds.length > 10000
          || page.targetMapIds.some(id => !integer(id, 1) || id > 9999)
          || ('direction' in page && (!integer(page.direction) || page.direction > 3))) {
          throw new Error('Invalid exit interaction page');
        }
      }
    }
    return interactions;
  }

  // activePages maps event IDs to the engine's current page index (-1: none),
  // when read-only engine state is available. Otherwise every page must agree.
  function resolveExit(map, start, edge, interactions, blockedSteps = new Set(), transfers = [], activePages = null) {
    if (typeof edge.action === 'boolean') return edge;
    validateInteractions(interactions, map);
    const matches = interactions.filter(event => event.startX === edge.startX && event.startY === edge.startY);
    const label = `Teleport at (${edge.startX},${edge.startY})`;
    if (matches.length !== 1) throw new Error(`${label} has no unambiguous interaction data in the loaded map.`);
    let pages = matches[0].pages;
    const active = activePages?.get(matches[0].eventId);
    if (Number.isInteger(active)) {
      if (active < 0 || active >= pages.length) throw new Error(`${label} is not active in the current game state.`);
      pages = [pages[active]];
    }
    const first = pages[0];
    if (pages.some(page => page.unsupported || page.trigger > 2 || page.trigger !== first.trigger
      || page.layer !== first.layer || page.direction !== first.direction || !page.targetMapIds.length
      || page.targetMapIds.some(id => id !== edge.targetMapId))) {
      throw new Error(`${label} has conditional or scripted interactions that need a reviewed route.`);
    }
    const action = first.trigger === 0;
    if (!action && first.layer !== 1 && first.direction === undefined) return { ...edge, action: false };
    const blocked = new Set(blockedSteps), blockedApproachSteps = [];
    const candidates = [];
    for (const direction of directions) {
      let x = edge.startX - direction.dx, y = edge.startY - direction.dy;
      if (map.loopHorizontal) x = (x + map.width) % map.width;
      if (map.loopVertical) y = (y + map.height) % map.height;
      if (!insideMap(map, { x, y })) continue;
      const index = ['up', 'right', 'down', 'left'].indexOf(direction.name);
      if (first.layer === 1 || !action) {
        const key = stepKey(x, y, direction.name);
        blocked.add(key); blockedApproachSteps.push(key);
      }
      if (first.direction === undefined || first.direction === index) candidates.push({ x, y, direction: index });
    }
    let best = null;
    for (const candidate of candidates) {
      const path = findPath(map, start, candidate, blocked, transfers);
      const localRoute = path === null ? findLocalRoute(map, start, candidate, transfers, blocked) : [];
      if (localRoute === null) continue;
      if (first.layer !== 1) {
        const entry = findPath(map, candidate, { x: edge.startX, y: edge.startY }, blockedSteps, transfers);
        if (entry?.length !== 1 || entry[0].direction !== ['up', 'right', 'down', 'left'][candidate.direction]) continue;
      }
      const length = path?.length ?? map.passages.length * localRoute.length;
      if (!best || length < best.length) best = { ...candidate, length };
    }
    if (!best) throw new Error(`${label} has no reachable interaction approach.`);
    return { ...edge, action, direction: best.direction,
      approachX: first.layer === 1 || !action ? best.x : edge.startX,
      approachY: first.layer === 1 || !action ? best.y : edge.startY, blockedApproachSteps };
  }

  function validateEdge(edge, mapId) {
    if (!edge || !integer(edge.targetMapId, 1) || !integer(edge.startX) || !integer(edge.startY)
      || !integer(edge.targetX, -1) || !integer(edge.targetY, -1)
      || (('approachX' in edge || 'approachY' in edge) && (!integer(edge.approachX) || !integer(edge.approachY)))
      || ('direction' in edge && (!integer(edge.direction) || edge.direction > 3))
      || ('action' in edge && typeof edge.action !== 'boolean')
      || (edge.action && (!integer(edge.approachX) || !integer(edge.approachY) || !integer(edge.direction)))
      || ('reviewed' in edge && typeof edge.reviewed !== 'boolean')
      || (edge.reviewed && edge.targetMapId === mapId && (!integer(edge.targetX) || !integer(edge.targetY)))
      || ('settleMs' in edge && (!integer(edge.settleMs) || edge.settleMs > 10000))
      || ('transientMapIds' in edge && (!Array.isArray(edge.transientMapIds) || edge.transientMapIds.length > 16
        || edge.transientMapIds.some(id => !integer(id, 1))))
      // Reviewed same-map moves that complete by position, without a teleport.
      || ('teleport' in edge && (typeof edge.teleport !== 'boolean'
        || (!edge.teleport && (edge.reviewed !== true || edge.targetMapId !== mapId || !integer(edge.approachX) || !integer(edge.direction)))))
      // Any one of these effect items must be active; checked on a reviewed standing tile.
      || ('requiresEffects' in edge && (!Array.isArray(edge.requiresEffects) || !edge.requiresEffects.length
        || edge.requiresEffects.length > 8 || edge.requiresEffects.some(id => !integer(id, 1) || id > 9999)
        || edge.reviewed !== true || typeof edge.action !== 'boolean' || !integer(edge.approachX)
        || !integer(edge.direction) || edge.targetMapId === mapId))
      // The subset of those effects with which a route may continue past the target map.
      || ('continueEffects' in edge && (!Array.isArray(edge.requiresEffects) || !Array.isArray(edge.continueEffects)
        || !edge.continueEffects.length || edge.continueEffects.some(id => !edge.requiresEffects.includes(id))))) {
      throw new Error('Invalid map graph edge');
    }
  }

  function validateTransfers(map, transfers) {
    if (!Array.isArray(transfers)) throw new Error('Invalid local transfers');
    for (const edge of transfers) {
      validateEdge(edge, edge && edge.mapId);
      if (!integer(edge.mapId, 1) || edge.mapId !== edge.targetMapId || edge.reviewed !== true
        || edge.mapId !== transfers[0].mapId) throw new Error('Local transfers must be reviewed same-map edges');
      const points = [{ x: edge.startX, y: edge.startY }, { x: edge.targetX, y: edge.targetY }];
      if ('approachX' in edge) points.push({ x: edge.approachX, y: edge.approachY });
      if (points.some(point => !insideMap(map, point))) throw new Error('Local transfer coordinates outside map');
    }
  }

  function findPath(map, start, end, blockedSteps = new Set(), transfers = []) {
    validateMap(map);
    validateTransfers(map, transfers);
    if (!insideMap(map, start) || !insideMap(map, end)) throw new Error('Navigation coordinates outside map');
    const first = start.y * map.width + start.x, last = end.y * map.width + end.x;
    if (first === last) return [];
    const portals = new Set(transfers.filter(edge => !edge.action).map(edge => edge.startY * map.width + edge.startX));
    const parents = new Int32Array(map.passages.length).fill(-1);
    const entered = new Uint8Array(map.passages.length);
    const queue = new Int32Array(map.passages.length);
    parents[first] = first;
    queue[0] = first;
    let count = 1;
    for (let cursor = 0; cursor < count; cursor++) {
      const current = queue[cursor], x = current % map.width, y = Math.floor(current / map.width);
      for (let index = 0; index < directions.length; index++) {
        const direction = directions[index];
        if (!(map.passages[current] & direction.bit) || blockedSteps.has(stepKey(x, y, direction.name))) continue;
        let nx = x + direction.dx, ny = y + direction.dy;
        if (map.loopHorizontal) nx = (nx + map.width) % map.width;
        if (map.loopVertical) ny = (ny + map.height) % map.height;
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        const next = ny * map.width + nx;
        if (portals.has(next) && next !== last) continue;
        if (parents[next] !== -1 || !(map.passages[next] & direction.reverse)) continue;
        parents[next] = current;
        entered[next] = index;
        if (next === last) {
          const result = [];
          for (let tile = last; tile !== first; tile = parents[tile]) {
            result.push({ x: tile % map.width, y: Math.floor(tile / map.width), direction: directions[entered[tile]].name });
          }
          return result.reverse();
        }
        queue[count++] = next;
      }
    }
    return null;
  }

  function findLocalRoute(map, start, end, transfers, blockedSteps = new Set()) {
    const queue = [{ point: start, route: [] }], visited = new Set();
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const { point, route } = queue[cursor];
      if (findPath(map, point, end, blockedSteps, transfers) !== null) return route;
      for (let index = 0; index < transfers.length; index++) {
        if (visited.has(index)) continue;
        const edge = transfers[index];
        const approach = { x: edge.approachX ?? edge.startX, y: edge.approachY ?? edge.startY };
        if (findPath(map, point, approach, blockedSteps, transfers) === null) continue;
        visited.add(index);
        queue.push({ point: { x: edge.targetX, y: edge.targetY }, route: [...route, edge] });
      }
    }
    return null;
  }

  // ownedEffects: effect item IDs the save owns; without it, effect-gated exits are unusable.
  function usableExits(graph, mapId, { blockedExits = new Set(), observedExits = new Map(), preferredExits = new Map(),
    ownedEffects = null } = {}) {
    if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !integer(mapId, 1)) throw new Error('Invalid map graph');
    const edges = Object.hasOwn(graph, mapId) ? graph[mapId] : [];
    if (!Array.isArray(edges)) throw new Error('Invalid map graph edges');
    const destinations = new Map();
    for (const edge of edges) {
      validateEdge(edge, mapId);
      const key = exitKey(mapId, edge);
      if (!destinations.has(key)) destinations.set(key, new Set());
      destinations.get(key).add(edge.targetMapId);
    }
    return edges.filter(edge => {
      const key = exitKey(mapId, edge);
      if (blockedExits.has(key)) return false;
      if (Array.isArray(edge.requiresEffects) && !edge.requiresEffects.some(id => ownedEffects?.has(id))) return false;
      if (observedExits.has(key)) return observedExits.get(key) === edge.targetMapId;
      if (preferredExits.has(key)) return preferredExits.get(key) === edge.targetMapId;
      // shortcut: the graph lacks event conditions, replace ambiguity filtering when live page state is available.
      return destinations.get(key).size === 1;
    });
  }

  function findMapRoute(graph, start, end, options) {
    if (!integer(start, 1) || !integer(end, 1)) throw new Error('Invalid destination map');
    if (start === end) return [];
    const parents = new Map([[start, null]]), queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const mapId = queue[cursor];
      for (const edge of usableExits(graph, mapId, options)) {
        if (parents.has(edge.targetMapId)) continue;
        // Some effects open an exit only for routes that end in its target map.
        if (edge.targetMapId !== end && Array.isArray(edge.continueEffects)
          && !edge.continueEffects.some(id => options?.ownedEffects?.has(id))) continue;
        parents.set(edge.targetMapId, { ...edge, mapId });
        if (edge.targetMapId === end) {
          const result = [];
          for (let current = end; current !== start;) {
            const departure = parents.get(current);
            result.push(departure);
            current = departure.mapId;
          }
          return result.reverse();
        }
        queue.push(edge.targetMapId);
      }
    }
    return null;
  }

  return { validateMap, validateInteractions, resolveExit, findPath, findLocalRoute, stepKey, usableExits, exitKey, findMapRoute };
}

module.exports = { createPlanner };
