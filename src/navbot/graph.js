'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const startRoute = require('./overlays/2kki-start-route.json');
const reflectionsRoute = require('./overlays/2kki-reflections-route.json');
const zodiacRoute = require('./overlays/2kki-zodiac-route.json');
const jigsawRoute = require('./overlays/2kki-jigsaw-route.json');
const corrections = [startRoute, reflectionsRoute, zodiacRoute, jigsawRoute];
const overlayNames = ['2kki-start-route.json', '2kki-reflections-route.json', '2kki-zodiac-route.json', '2kki-jigsaw-route.json'];
const edgeFields = ['targetMapId', 'startX', 'startY', 'targetX', 'targetY'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function applyGraphOverlay(source, game) {
  if (game !== startRoute.game) return { graph: source, overlay: null };
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Map graph must be an object');
  const graph = { ...source };
  const changes = [];
  const update = (mapId, predicate, additions, reason) => {
    const before = graph[mapId] || [];
    if (!Array.isArray(before)) throw new Error(`Map ${mapId} must contain an array of edges`);
    const kept = before.filter(edge => !predicate(edge));
    graph[mapId] = [...kept, ...additions.map(edge => ({ ...edge }))];
    changes.push({ mapId, reason, removed: before.length - kept.length, added: additions.length });
  };
  for (const correction of corrections.flatMap(overlay => overlay.replaceExits)) {
    update(correction.mapId,
      edge => edge && edge.startX === correction.startX && edge.startY === correction.startY,
      correction.edges, `Reviewed exit at (${correction.startX},${correction.startY})`);
  }
  for (const removal of corrections.flatMap(overlay => overlay.removeEdges)) {
    update(removal.mapId, edge => edge && edgeFields.every(field => edge[field] === removal[field]), [], removal.reason || 'Remove fabricated Nexus edge');
  }
  for (const pruning of corrections.flatMap(overlay => overlay.pruneDestinations)) {
    update(pruning.mapId, edge => edge && pruning.targetMapIds.includes(edge.targetMapId), [], pruning.reason || 'Remove debug destinations');
  }
  return { graph, overlay: {
    id: '2kki-reviewed-routes-v1', game,
    sources: corrections.flatMap(overlay => overlay.sources),
    limitations: corrections.flatMap(overlay => overlay.limitations), changes,
  } };
}

// The local engine's planner reads only the basic edge fields, so it gets no
// exits that need an effect or that complete without a teleport.
function localEngineGraph(graph) {
  return Object.fromEntries(Object.entries(graph).map(([mapId, edges]) => [mapId, Array.isArray(edges)
    ? edges.filter(edge => !Array.isArray(edge?.requiresEffects) && edge?.teleport !== false) : edges]));
}

// Keep the downloaded/generated graph intact. Each debug run records exactly what
// it served, together with the source and correction hashes needed to reproduce it.
function prepareDebugGraph(options) {
  if (!options.enabled || options.game !== startRoute.game) return options;
  const sourceGraphPath = options.graphPath;
  const sourceBytes = fs.readFileSync(sourceGraphPath);
  const { graph, overlay } = applyGraphOverlay(JSON.parse(sourceBytes), options.game);
  // The run serves, and records, the graph its engine actually plans with.
  const local = options.engine === 'local';
  const output = JSON.stringify(local ? localEngineGraph(graph) : graph);
  const graphPath = path.join(options.runDir, 'map_graph.json');
  const graphProvenancePath = path.join(options.runDir, 'graph-provenance.json');
  const overlayFiles = overlayNames.map(name => {
    const file = path.join(__dirname, 'overlays', name);
    return { path: file, sha256: hash(fs.readFileSync(file)) };
  });
  if (path.resolve(sourceGraphPath) === path.resolve(graphPath)) {
    throw new Error('Debug graph output would overwrite its source; select a fresh run directory');
  }
  fs.mkdirSync(options.runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(graphPath, output, { mode: 0o600 });
  fs.writeFileSync(graphProvenancePath, JSON.stringify({
    game: options.game,
    source: { path: sourceGraphPath, sha256: hash(sourceBytes), bytes: sourceBytes.length },
    served: { path: graphPath, sha256: hash(output), bytes: Buffer.byteLength(output),
      ...(local ? { filter: 'local engine: no effect-gated exits or position-completed moves' } : {}) },
    overlay: { ...overlay, files: overlayFiles },
  }, null, 2), { mode: 0o600 });
  return { ...options, sourceGraphPath, graphPath, graphProvenancePath };
}

module.exports = { applyGraphOverlay, prepareDebugGraph, localEngineGraph };
