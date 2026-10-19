'use strict';

// Chooses a navigation destination for the loaded game's current expedition.
// Expedition records carry location titles and record IDs, never engine map
// IDs: titles resolve to maps through the packaged catalog, the page's location
// cache and, for 2kki, the Explorer lookup the page itself uses.

// Map 568 is reached by the bridge's checked Planetarium recipe, not by graph
// edges, and only from these starting maps.
const planetariumStarts = Object.freeze([2, 4, 5, 10]);
const recipeDestinations = { '2kki': new Map([[568, { x: 3, y: 75, starts: planetariumStarts }]]) };
// The Planetarium recipe only supports its checked destination map.
const excludedMaps = { '2kki': new Set([567]) };
const mapIdOf = value => /^\d{1,4}$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 9999 ? Number(value) : null;
// The legacy graph uses (0,0) and negative values for unknown landings.
const knownTile = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && (x > 0 || y > 0);
// As the page matches teleport coordinates; -1 leaves an axis unrestricted.
const inRegion = (region, x, y) => ((region.x1 === -1 && region.x2 === -1) || (region.x1 <= x && region.x2 >= x))
  && ((region.y1 === -1 && region.y2 === -1) || (region.y1 <= y && region.y2 >= y));
// The page claims an expedition by the location title before any colon.
const worldOf = name => { const index = name.indexOf(':'); return index < 0 ? name : name.slice(0, index); };

// The first unfinished entry, in the page's own order.
function currentExpedition(page) {
  if (!Array.isArray(page?.expeditions)) return null;
  return page.expeditions.find(entry => typeof entry?.title === 'string' && entry.title.trim() && entry.complete === false) || null;
}

// Catalog map IDs for the exact title, with the coordinate regions that name it.
// A map entry without regions names the whole map.
function catalogMaps(catalog, title) {
  const maps = new Map();
  for (const entry of catalog?.entries || []) {
    const mapId = mapIdOf(entry.mapId);
    if (entry.name !== title || !mapId) continue;
    const regions = Array.isArray(entry.regions) && entry.regions.length ? entry.regions : null;
    const known = maps.get(mapId);
    maps.set(mapId, known === undefined ? regions : known && regions ? [...known, ...regions] : null);
  }
  return [...maps].map(([mapId, regions]) => ({ mapId, regions }));
}

// Prefers the fewest map hops to a landing tile the graph knows and that the
// page names after the title. `regions` maps a map ID to its title regions;
// `locationNames` are the page's canonical names for the current location.
function chooseDestination({ graph, planner, routeOptions, game, title, mapIds, state, regions = new Map(), locationNames = null }) {
  const excluded = excludedMaps[game] || new Set();
  const candidates = [...new Set(mapIds.map(mapIdOf).filter(Boolean))].filter(id => !excluded.has(id)).sort((a, b) => a - b);
  if (!candidates.length) throw new Error(`No map is known for ${title}.`);
  const recipes = recipeDestinations[game] || new Map();
  if (candidates.includes(state.map_id)) {
    const recipe = recipes.get(state.map_id);
    // Standing in one of its maps counts only where the page already names the title.
    const named = !Array.isArray(locationNames) || !locationNames.length || locationNames.some(name => worldOf(name) === title);
    if (recipe) return { map: state.map_id, x: recipe.x, y: recipe.y, hops: 0, route: [], mapIds: candidates };
    if (named) return { map: state.map_id, x: state.player_x, y: state.player_y, hops: 0, route: [], mapIds: candidates };
  }
  for (const map of candidates) {
    const recipe = recipes.get(map);
    if (recipe?.starts.includes(state.map_id)) return { map, x: recipe.x, y: recipe.y, hops: null, route: [], recipe: true, mapIds: candidates };
  }
  const reachable = candidates.filter(map => map !== state.map_id && !recipes.has(map));
  if (!reachable.length) {
    throw new Error(candidates.some(map => recipes.has(map)) ? `The checked route to ${title} starts from the Nexus or the starting room.`
      : `This map is not named ${title} here. Walk into its area, or choose its tile manually.`);
  }
  if (!graph) throw new Error(`Map routing is unavailable, so ${title} cannot be reached from this map.`);
  const options = routeOptions();
  let best = null;
  const consider = (map, edges) => {
    const last = edges.at(-1);
    const tile = knownTile(last.targetX, last.targetY) ? { x: last.targetX, y: last.targetY } : null;
    const option = { map, x: tile?.x ?? null, y: tile?.y ?? null, hops: edges.length, route: edges.map(edge => edge.targetMapId) };
    if (!best || (!!tile && best.x === null) || ((!!tile === (best.x !== null)) && option.hops < best.hops)) best = option;
  };
  for (const map of reachable) {
    const areas = regions.get(map);
    if (!areas) {
      const edges = planner.findMapRoute(graph, state.map_id, map, options);
      if (edges?.length) consider(map, edges);
      continue;
    }
    // Only entrances landing inside the title's regions name it on arrival.
    for (const [source, list] of Object.entries(graph)) {
      const from = Number(source);
      if (from === map || !Array.isArray(list) || !list.some(edge => edge?.targetMapId === map)) continue;
      for (const edge of planner.usableExits(graph, from, options)) {
        if (edge.targetMapId !== map || !knownTile(edge.targetX, edge.targetY) || !areas.some(area => inRegion(area, edge.targetX, edge.targetY))) continue;
        const before = from === state.map_id ? [] : planner.findMapRoute(graph, state.map_id, from, options);
        // An exit some effects open only for routes ending in its map cannot lead on.
        const gate = before?.at(-1);
        if (gate && Array.isArray(gate.continueEffects) && !gate.continueEffects.some(id => options?.ownedEffects?.has(id))) continue;
        if (before) consider(map, [...before, { ...edge, mapId: from }]);
      }
    }
  }
  if (!best) throw new Error(`No known route reaches ${title} (map ${reachable.join(', ')}) from map ${state.map_id}.`);
  return { ...best, mapIds: candidates };
}

module.exports = { currentExpedition, catalogMaps, chooseDestination, knownTile, planetariumStarts };
