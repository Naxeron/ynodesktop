'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractMapNames, buildMapCatalog, createMapCatalogLoader } = require('../src/navbot/map-catalog');
const { buildCatalogs } = require('./build-navbot-map-catalog');

test('location extraction handles strings, titles, arrays and prior-map conditions without metadata names', () => {
  const entries = extractMapNames({ mapLocations: {
    '0001': 'Nexus',
    '0002': { title: 'Bedroom', urlTitle: 'Do not use this', explorer: false },
    '0003': ['Forest', { title: 'Forest: Pond', coords: { x1: 0, y1: 2, x2: 6, y2: 4 } }],
    '0004': { '0003': { title: 'Maze: West', urlTitle: 'Also ignored' }, else: ['Maze', { title: 'Maze: East' }] },
    '0005': { urlTitle: 'Not a destination', arbitrary: 'Ignored', coords: { title: 'Also ignored' } },
  } });
  assert.deepEqual(entries, [
    { mapId: 2, name: 'Bedroom' },
    { mapId: 3, name: 'Forest' },
    { mapId: 3, name: 'Forest: Pond', regions: [{ x1: 0, y1: 2, x2: 6, y2: 4 }] },
    { mapId: 4, name: 'Maze', conditional: true },
    { mapId: 4, name: 'Maze: East', conditional: true },
    { mapId: 4, name: 'Maze: West', conditional: true },
    { mapId: 1, name: 'Nexus' },
  ]);
});

test('duplicate names merge per map while preserving distinct regions and conditional hints', () => {
  const area = { x1: -1, y1: 10, x2: -1, y2: 20 };
  const entries = extractMapNames({ mapLocations: {
    '0001': [{ title: 'Forest', coords: area }, { title: 'Forest', coords: area },
      { title: 'Forest', coords: { x1: 1, y1: 2, x2: 3, y2: 4 } }, { else: 'Forest' }],
    '0002': 'Forest',
  } });
  assert.deepEqual(entries, [
    { mapId: 1, name: 'Forest', regions: [area, { x1: 1, y1: 2, x2: 3, y2: 4 }], conditional: true },
    { mapId: 2, name: 'Forest' },
  ]);
});

test('ignored maps, non-map identifiers, expedition IDs and empty names are excluded', () => {
  assert.deepEqual(extractMapNames({ ignoredMapIds: ['0002', 3], locations: [{ locationId: 7, title: 'Expedition' }], mapLocations: {
    '0000': 'No map', '0001': 'Valid', '0002': 'Ignored', '0003': 'Ignored too',
    '4.0': 'Not an ID', '5e2': 'Not an ID', '10000': 'Invalid map', '0004': null,
    '0005': false, '0006': '', '0007': { title: '  ' }, '0008': { locationId: 8, name: 'Expedition' },
  } }), [{ mapId: 1, name: 'Valid' }]);
});

test('catalog loaders cache per game and never substitute another game or read invalid paths', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'navbot-catalog-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = buildMapCatalog('2kki', { mapLocations: { '0010': 'Nexus' } });
  const second = buildMapCatalog('yume', { mapLocations: { '0009': 'Nexus' } });
  fs.writeFileSync(path.join(directory, '2kki.json'), JSON.stringify(first));
  fs.writeFileSync(path.join(directory, 'yume.json'), JSON.stringify(second));
  const load = createMapCatalogLoader(directory);
  assert.equal(load('2kki').entries[0].mapId, 10);
  assert.equal(load('yume').entries[0].mapId, 9);
  fs.unlinkSync(path.join(directory, '2kki.json'));
  assert.strictEqual(load('2kki'), load('2kki'));
  assert.equal(load('2kki').entries[0].mapId, 10);
  assert.deepEqual(load('missing'), { game: 'missing', entries: [], error: 'map_names_unavailable' });
  for (const game of ['../2kki', '/tmp/2kki', '2kki.json', '', null, '__proto__/']) {
    assert.throws(() => load(game), /Invalid game ID/);
    assert.throws(() => buildMapCatalog(game, {}), /Invalid game ID/);
  }
  fs.writeFileSync(path.join(directory, 'wrong.json'), JSON.stringify(first));
  assert.equal(load('wrong').error, 'map_names_unavailable');
});

test('packaged catalogs reproduce all checked-in games and include actual 2kki sublocations', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'navbot-catalog-build-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const catalogs = buildCatalogs(path.resolve(__dirname, '../../ynolocations'), directory);
  assert.ok(catalogs.length > 20);
  for (const catalog of catalogs) {
    const filename = `${catalog.game}.json`;
    assert.equal(fs.readFileSync(path.join(directory, filename), 'utf8'), fs.readFileSync(path.resolve(__dirname, '../src/navbot/map-names', filename), 'utf8'), filename);
  }
  const game = catalogs.find(catalog => catalog.game === '2kki');
  assert.ok(game.entries.some(entry => entry.mapId === 10 && entry.name === 'Nexus'));
  assert.ok(game.entries.some(entry => entry.mapId === 25 && entry.name === 'Hospital: Hospital Outskirts'));
  assert.ok(game.entries.some(entry => entry.conditional && entry.regions === undefined));
  assert.ok(game.entries.every(entry => entry.mapId !== 900));
});
