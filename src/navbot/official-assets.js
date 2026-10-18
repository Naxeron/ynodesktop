'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { createPlanner } = require('./official-path');

function createOfficialAssets(win, options) {
  const parser = path.resolve(__dirname, '../../scratch/lmu_parser.js');
  if (!fs.existsSync(parser) || !fs.existsSync(parser.replace(/\.js$/, '.wasm'))) {
    throw new Error('Official Navbot needs the liblcf parser. Run ./tools/build-lmu-parser.sh from the ynoproject repository.');
  }
  const { validateMap, validateInteractions } = createPlanner();
  let generation = 0, database = null, maps = new Map();

  async function readAsset(filename, limit, directory) {
    const encoded = await win.webContents.executeJavaScript(`window.__ynoOfficialInput.readAsset(${JSON.stringify(filename)})`);
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(limit / 3) * 4
        || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error(`Invalid or oversized official engine asset: ${filename}`);
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== encoded) {
      throw new Error(`Invalid or oversized official engine asset: ${filename}`);
    }
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, filename);
    await fs.promises.writeFile(file, bytes, { mode: 0o600 });
    return { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }

  function ensureMap(input) {
    if (!input?.ready || !input.map_known) return Promise.resolve(null);
    const mapId = input.map_id;
    if (!Number.isInteger(mapId) || mapId < 1 || mapId > 9999) {
      return Promise.reject(new Error('Invalid official engine map ID'));
    }
    if (maps.has(mapId)) return maps.get(mapId);
    const epoch = generation, cache = maps;
    const directory = path.join(options.runDir, 'official-data', `runtime-${epoch}`);
    const filename = `Map${String(mapId).padStart(4, '0')}.lmu`;
    if (!database) {
      const pending = readAsset('RPG_RT.ldb', 32 * 1024 * 1024, directory);
      database = pending;
      pending.catch(() => { if (database === pending) database = null; });
    }
    const db = database;
    const pending = (async () => {
      const databaseAsset = await db;
      if (epoch !== generation) return null;
      const mapAsset = await readAsset(filename, 16 * 1024 * 1024, directory);
      if (epoch !== generation) return null;
      const output = await new Promise((resolve, reject) => {
        childProcess.execFile(process.execPath, [parser, mapAsset.file, databaseAsset.file, '--navigation'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024,
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      if (epoch !== generation) return null;
      const parsed = JSON.parse(output);
      const navigation = validateMap(parsed.navigation);
      const exitInteractions = validateInteractions(parsed.exitInteractions === undefined ? [] : parsed.exitInteractions, navigation);
      const result = { mapId, navigation, exitInteractions };
      await fs.promises.writeFile(path.join(directory, filename.replace('.lmu', '.navigation.json')),
        JSON.stringify({ ...result, sources: { [filename]: mapAsset.sha256, 'RPG_RT.ldb': databaseAsset.sha256 } }),
        { mode: 0o600 });
      return epoch === generation ? result : null;
    })().catch(error => {
      cache.delete(mapId);
      if (epoch !== generation) return null;
      throw error;
    });
    maps.set(mapId, pending);
    return pending;
  }

  return {
    ensureMap,
    reset() { generation++; database = null; maps = new Map(); },
  };
}

module.exports = { createOfficialAssets };
