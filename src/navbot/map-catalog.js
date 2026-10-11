'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validateGame(game) {
  if (typeof game !== 'string' || !/^[a-z0-9_-]+$/.test(game)) throw new Error('Invalid game ID');
  return game;
}

function mapId(value) {
  if (!/^\d{1,4}$/.test(String(value))) return null;
  const id = Number(value);
  return id >= 1 && id <= 9999 ? id : null;
}

function region(coords) {
  if (!coords || typeof coords !== 'object') return null;
  const result = {};
  for (const key of ['x1', 'y1', 'x2', 'y2']) {
    // The location format uses -1 for an unrestricted coordinate bound.
    if (!Number.isInteger(coords[key]) || coords[key] < -1 || coords[key] > 9999) return null;
    result[key] = coords[key];
  }
  return result;
}

function extractMapNames(config) {
  const ignored = new Set((config.ignoredMapIds || []).map(mapId));
  const entries = new Map();
  function visit(value, id, conditional = false) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, id, conditional);
      return;
    }
    const name = typeof value === 'string' ? value : value?.title;
    if (typeof name === 'string' && name.trim()) {
      const key = JSON.stringify([id, name]);
      const entry = entries.get(key) || { mapId: id, name };
      const bounds = region(value?.coords);
      if (bounds) {
        entry.regions ||= [];
        if (!entry.regions.some(existing => JSON.stringify(existing) === JSON.stringify(bounds))) entry.regions.push(bounds);
      }
      if (conditional) entry.conditional = true;
      entries.set(key, entry);
    }
    if (!value || typeof value !== 'object') return;
    // Only prior-map conditions and their fallback contain nested names.
    // urlTitle, explorer and coordinate metadata are never destinations.
    for (const [key, child] of Object.entries(value)) {
      if (key === 'else' || mapId(key) !== null) visit(child, id, true);
    }
  }
  for (const [key, value] of Object.entries(config.mapLocations || {})) {
    const id = mapId(key);
    if (id !== null && !ignored.has(id)) visit(value, id);
  }
  return [...entries.values()].sort((a, b) => {
    const first = a.name.toLowerCase(), second = b.name.toLowerCase();
    return (first < second ? -1 : first > second ? 1 : 0) || a.mapId - b.mapId || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
}

function buildMapCatalog(game, config) {
  validateGame(game);
  return { version: 1, game, source: `ynolocations/${game}/config.json`, entries: extractMapNames(config) };
}

function createMapCatalogLoader(directory = path.join(__dirname, 'map-names')) {
  const cache = new Map();
  return function loadMapCatalog(game) {
    validateGame(game);
    if (!cache.has(game)) {
      let catalog;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(directory, `${game}.json`), 'utf8'));
        if (data.version !== 1 || data.game !== game || !Array.isArray(data.entries)
          || !data.entries.every(entry => Number.isInteger(entry.mapId) && entry.mapId >= 1 && entry.mapId <= 9999 && typeof entry.name === 'string' && entry.name.trim())) {
          throw new Error('Invalid map catalog');
        }
        catalog = { game, entries: data.entries, source: data.source };
      } catch {
        catalog = { game, entries: [], error: 'map_names_unavailable' };
      }
      cache.set(game, catalog);
    }
    return cache.get(game);
  };
}

module.exports = { extractMapNames, buildMapCatalog, createMapCatalogLoader, loadMapCatalog: createMapCatalogLoader() };
