#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { request, readSession } = require('./navbot-client');
const { runScenario } = require('./navbot-scenario');
const { engineCommand } = require('../src/navbot/bridge');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const operation = args.shift();
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`--${name} needs a value`);
  return args[index + 1];
}
function number(name, fallback) {
  const text = flag(name, fallback);
  if (text === undefined) throw new Error(`--${name} is required`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be an integer`);
  return value;
}
function print(result) { console.log(JSON.stringify(result, null, 2)); }

async function main() {
  if (!operation || ['help', '--help', '-h'].includes(operation)) {
    console.log(`Navbot control (run from any directory):
  launch [--game 2kki] [--engine official|local] [--engine-dir DIR] [--graph FILE] [--profile DIR]
  state | events [--after SEQ] | capture | stop | reconnect | reload | close
  hold --key up|down|left|right|decision|cancel|shift [--frames 1]
  goto --x X --y Y
  goto-map --map ID --x X --y Y
  boot [--timeout 120]
  run --map ID --x X --y Y [--arrival tile|map] [--timeout 120] [--stall 20]
  run --expedition [--arrival tile|map] [--timeout 120] [--stall 20] [--confirm 30]
  expedition   (print the destination chosen for the first unfinished expedition)
Commands use .navbot/latest.json; select another with --session FILE.
launch runs Electron until close. run/boot save result JSON, trace, and screenshot.
The default official engine uses the server's engine. --engine local requires a Navbot build.
reconnect clicks the official Reconnect button once when it is available.
Map IDs are engine map IDs, never expedition location IDs. run --expedition picks
the destination after boot and succeeds once the server marks the expedition complete.`);
    return;
  }
  if (operation === 'launch') {
    const engine = flag('engine', 'official');
    if (!['local', 'official'].includes(engine)) throw new Error('--engine must be local or official');
    const defaultBuild = ['js', 'wasm'].every(ext => fs.existsSync(path.join(root, `../ynoengine/build-debug/ynoengine-simd.${ext}`))) ? '../ynoengine/build-debug' : '../ynoengine/build';
    const engineDir = path.resolve(flag('engine-dir', process.env.NAVBOT_ENGINE_DIR || path.join(root, defaultBuild)));
    const game = flag('game', '2kki');
    if (!/^[a-z0-9_-]+$/.test(game)) throw new Error('Invalid game ID');
    const electron = require('electron');
    fs.accessSync(electron, fs.constants.X_OK);
    const electronArgs = [root, '--navbot-debug', '--navbot-game', game, '--navbot-engine', engine];
    if (engine === 'local') electronArgs.push('--navbot-engine-dir', engineDir);
    for (const name of ['graph', 'profile', 'run-dir']) {
      const value = flag(name);
      if (value) electronArgs.push(`--navbot-${name}`, path.resolve(value));
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, electronArgs, { cwd: root, stdio: 'inherit', env });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    return;
  }
  const session = readSession(flag('session'));
  const send = command => request(session, command);
  if (operation === 'boot' || operation === 'run') {
    const expedition = operation === 'run' && args.includes('--expedition');
    const target = operation === 'run' && !expedition ? { map: number('map'), x: number('x'), y: number('y') } : null;
    if (target) engineCommand({ op: 'goto-map', ...target });
    const timeout = number('timeout', 120);
    const stall = number('stall', 20);
    const confirm = number('confirm', 30);
    const arrival = flag('arrival', 'tile');
    if (timeout < 1 || timeout > 3600 || stall < 1 || stall > 3600) throw new Error('Timeout/stall must be 1..3600 seconds');
    if (confirm < 1 || confirm > 300) throw new Error('--confirm must be 1..300 seconds');
    if (!['tile', 'map'].includes(arrival)) throw new Error('--arrival must be tile or map');
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const result = await runScenario(send, { target, expedition, confirmMs: confirm * 1000, timeoutMs: timeout * 1000, stallMs: stall * 1000, arrival, signal: controller.signal });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    const output = path.join(session.runDir, `result-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 });
    print({ ...result, resultFile: output, traceFile: path.join(session.runDir, 'trace.jsonl') });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const command = { op: operation };
  if (operation === 'events') command.after = number('after', 0);
  else if (operation === 'hold') Object.assign(command, { key: flag('key'), frames: number('frames', 1) });
  else if (operation === 'goto' || operation === 'goto-map') {
    Object.assign(command, { x: number('x'), y: number('y') });
    if (operation === 'goto-map') command.map = number('map');
  }
  if (!['events', 'capture', 'reload', 'close', 'expedition'].includes(operation)) engineCommand(command);
  print(await send(command));
}

main().catch(error => { console.error(`[Navbot] ${error.message}`); process.exitCode = 1; });
