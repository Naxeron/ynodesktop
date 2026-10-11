const path = require('node:path');

function readOptions(argv = process.argv, env = process.env) {
  const enabled = argv.includes('--navbot-debug') || argv.includes('--test-navbot');
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    if (index < 0) return fallback;
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[index + 1];
  };
  const root = path.resolve(__dirname, '../..');
  const game = value('--navbot-game', value('--test-navbot', '2kki'));
  if (!/^[a-z0-9_-]+$/.test(game)) throw new Error('Invalid game ID');
  return {
    enabled, game,
    runDir: path.resolve(value('--navbot-run-dir', path.join(root, '.navbot/runs', `${Date.now()}-${process.pid}`))),
    profileDir: path.resolve(value('--navbot-profile', path.join(root, '.navbot/profiles', game))),
    engineDir: path.resolve(value('--navbot-engine-dir', env.NAVBOT_ENGINE_DIR || path.join(root, '../ynoengine/build'))),
    // The legacy graph has been identified as 2kki data. Other games need their own graph.
    graphPath: path.resolve(value('--navbot-graph', game === '2kki' ? path.join(root, 'map_graph.json') : path.join(root, 'graphs', game, 'map_graph.json'))),
  };
}

module.exports = { readOptions };
