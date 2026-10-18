'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { readOptions } = require('../src/navbot/options');

test('official is the default, debug remains opt-in and local must be selected explicitly', () => {
  assert.equal(readOptions([]).engine, 'official');
  assert.equal(readOptions([]).enabled, false);
  assert.equal(readOptions(['--navbot-engine', 'official']).enabled, false);
  const official = readOptions(['--navbot-debug']);
  assert.equal(official.enabled, true);
  assert.equal(official.engine, 'official');
  assert.equal(readOptions(['--test-navbot', '2kki']).engine, 'official');
  assert.equal(readOptions(['--navbot-debug', '--navbot-engine', 'local']).engine, 'local');
  assert.throws(() => readOptions(['--navbot-engine', 'other']), /local or official/);
  assert.throws(() => readOptions(['--navbot-engine']), /needs a value/);
});

test('CLI forwards the engine choice without requiring or intercepting a local engine for official mode', () => {
  const file = path.join(__dirname, 'navbot-cli.js');
  const realRequire = createRequire(file);
  for (const selection of [[], ['--engine', 'official'], ['--engine', 'local']]) {
    const engine = selection[1] || 'official';
    const spawned = [];
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      __dirname, console,
      process: { argv: ['node', file, 'launch', ...selection], env: { ELECTRON_RUN_AS_NODE: '1' }, on() {} },
      require(name) {
        if (name === 'electron') return '/mock/electron';
        if (name === 'node:fs') return { ...fs, accessSync() {} };
        if (name === 'node:child_process') return { spawn(...args) {
          spawned.push(args);
          return { once() {}, kill() {} };
        } };
        return realRequire(name);
      },
    });
    assert.equal(spawned.length, 1);
    const [executable, args, options] = spawned[0];
    assert.equal(executable, '/mock/electron');
    assert.equal(args[args.indexOf('--navbot-engine') + 1], engine);
    assert.equal(args.includes('--navbot-engine-dir'), engine === 'local');
    assert.equal('ELECTRON_RUN_AS_NODE' in options.env, false);
  }
});

test('launch helper defaults to parser-only official mode and preserves explicit local build behavior', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navbot-launch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of ['tools', 'ynoengine', 'ynodesktop/scratch', 'bin']) fs.mkdirSync(path.join(root, folder), { recursive: true });
  const script = path.join(root, 'test_navbot.sh');
  fs.copyFileSync(path.resolve(__dirname, '../../test_navbot.sh'), script);
  const writeScript = (name, source) => fs.writeFileSync(path.join(root, name), `#!/usr/bin/env bash\nset -eu\n${source}\n`, { mode: 0o700 });
  writeScript('ynoengine/cmake_build.sh', 'echo engine >> "$NAVBOT_BUILD_LOG"');
  writeScript('tools/build-lmu-parser.sh', 'echo parser >> "$NAVBOT_BUILD_LOG"\ntouch "$(dirname "$0")/../ynodesktop/scratch/lmu_parser.js" "$(dirname "$0")/../ynodesktop/scratch/lmu_parser.wasm"');
  writeScript('bin/node', 'printf "%s\\n" "$@" > "$NAVBOT_LAUNCH_ARGS"');
  const parserSource = path.join(root, 'ynodesktop/scratch/lmu_parser.cpp');
  fs.writeFileSync(parserSource, '// source');
  fs.writeFileSync(path.join(root, 'ynodesktop/scratch/lmu_parser_test.cpp'), '// tests');
  const log = path.join(root, 'builds.txt'), argsFile = path.join(root, 'args.txt');
  const run = args => {
    fs.writeFileSync(log, '');
    const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, NAVBOT_BUILD_LOG: log, NAVBOT_LAUNCH_ARGS: argsFile } });
    assert.equal(result.status, 0, result.stderr);
    return { builds: fs.readFileSync(log, 'utf8').trim(), args: fs.readFileSync(argsFile, 'utf8').trim().split('\n') };
  };
  const initial = run(['2kki']);
  assert.equal(initial.builds, 'parser');
  assert.deepEqual(initial.args.slice(1), ['launch', '--game', '2kki', '--engine', 'official']);
  assert.equal(run([]).builds, '');
  assert.equal(run(['2kki', '--official']).builds, '');
  fs.utimesSync(path.join(root, 'ynodesktop/scratch/lmu_parser.js'), new Date(0), new Date(0));
  assert.equal(run(['2kki', '--skip-build']).builds, 'parser');
  const local = run(['2kki', '--engine', 'local']);
  assert.equal(local.builds, 'engine');
  assert.deepEqual(local.args.slice(1), ['launch', '--game', '2kki', '--engine', 'local']);
  assert.equal(run(['2kki', '--engine', 'local', '--skip-build']).builds, '');
  assert.equal(run(['2kki', '--engine', 'official']).builds, '');
});
