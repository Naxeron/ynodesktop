#!/usr/bin/env node
'use strict';

// Regenerate packaged autocomplete data using the checked-out location configs:
// node ynodesktop/tools/build-navbot-map-catalog.js
const fs = require('node:fs');
const path = require('node:path');
const { buildMapCatalog } = require('../src/navbot/map-catalog');

function buildCatalogs(sourceDirectory = path.resolve(__dirname, '../../ynolocations'), outputDirectory = path.resolve(__dirname, '../src/navbot/map-names')) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const catalogs = [];
  for (const directory of fs.readdirSync(sourceDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!directory.isDirectory()) continue;
    const configPath = path.join(sourceDirectory, directory.name, 'config.json');
    if (!fs.existsSync(configPath)) continue;
    const catalog = buildMapCatalog(directory.name, JSON.parse(fs.readFileSync(configPath, 'utf8')));
    fs.writeFileSync(path.join(outputDirectory, `${directory.name}.json`), `${JSON.stringify(catalog, null, 2)}\n`);
    catalogs.push(catalog);
  }
  return catalogs;
}

if (require.main === module) {
  const catalogs = buildCatalogs();
  console.log(`Built Navbot map names for ${catalogs.length} games (${catalogs.reduce((count, catalog) => count + catalog.entries.length, 0)} entries).`);
}

module.exports = { buildCatalogs };
