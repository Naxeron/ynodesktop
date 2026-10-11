const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');
const path = require('path');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error('Status: ' + res.statusCode));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

async function scrapeMaps(gameId) {
  console.log(`Starting scrape for ${gameId}...`);
  let graph = {};

  if (!fs.existsSync('scratch/maps')) {
      fs.mkdirSync('scratch/maps', { recursive: true });
  }

  // Download RPG_RT.ldb for the game
  let ldbDest = path.join(__dirname, 'scratch', 'maps', 'RPG_RT.ldb');
  try {
    await download(`https://ynoproject.net/data/${gameId}/RPG_RT.ldb`, ldbDest);
    console.log('Downloaded RPG_RT.ldb');
  } catch (e) {
    console.log('Failed to download RPG_RT.ldb:', e.message);
  }

  // Iterate maps 1 through 100 as proof of concept.
  // In full deployment this goes up to 9999.
  let maxMap = 9999;
  let batchSize = 20;

  for (let b = 0; b < maxMap; b += batchSize) {
    let promises = [];
    for (let i = 1; i <= batchSize; i++) {
      let mapId = b + i;
      let mapIdStr = String(mapId).padStart(4, '0');
      let dest = path.join(__dirname, 'scratch', 'maps', `Map${mapIdStr}.lmu`);
      promises.push(
        download(`https://ynoproject.net/data/${gameId}/Map${mapIdStr}.lmu`, dest)
          .then(() => ({ mapId, mapIdStr, dest, success: true }))
          .catch(e => ({ mapId, mapIdStr, success: false, error: e.message }))
      );
    }

    let results = await Promise.all(promises);
    for (let res of results) {
      if (!res.success) continue;

      try {
        let parserPath = path.join(__dirname, 'scratch', 'lmu_parser.js');
        let dbPath = path.join(__dirname, 'scratch', 'maps', 'RPG_RT.ldb');
        let output = execSync(`node "${parserPath}" "${res.dest}" "${dbPath}"`, { encoding: 'utf8' });
        let parsed = JSON.parse(output);
        if (parsed.teleports && parsed.teleports.length > 0) {
           graph[res.mapId] = parsed.teleports;
           console.log(`[Map${res.mapIdStr}] Found ${parsed.teleports.length} teleports`);
        }
      } catch(e) {
        console.error(`Error parsing Map${res.mapIdStr}:`, e.message);
      }

      // Cleanup
      fs.unlinkSync(res.dest);
    }
  }

  if (gameId === '2kki') {
    // Maps 222/223/224/225/448 are ending maps, not alternate Nexus hubs.
    // Keep extraction evidence raw; reviewed action exits are applied by the
    // game-scoped debug overlay rather than inventing walkable connections.
    if (graph[2]) {
        graph[2] = graph[2].filter(edge => edge.targetMapId !== 1 && edge.targetMapId !== 171);
    }
  }

  const outPath = path.join(__dirname, 'map_graph.json');
  fs.writeFileSync(outPath, JSON.stringify(graph, null, 2));
  console.log(`Graph saved to ${outPath}`);
}

let game = process.argv[2] || 'yume';
scrapeMaps(game);
