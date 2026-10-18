#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { request, readSession } = require('./navbot-client');
const { runRoute } = require('../src/navbot/route-runner');

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: navbot-route.js ROUTE.json');
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  const session = readSession();
  const send = command => request(session, command);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  const evidence = { route: path.resolve(file), startedAt: new Date().toISOString(), steps: [] };
  try {
    evidence.final = await runRoute(send, steps, { signal: controller.signal, onStep(index, step, snapshot) {
      evidence.steps.push({ index, step, time: new Date().toISOString(), state: snapshot.state });
      console.log(`Step ${index + 1}/${steps.length}: ${JSON.stringify(step)}`);
    } });
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false;
    evidence.error = error.message;
    process.exitCode = 1;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    evidence.screenshot = await send({ op: 'capture' }).catch(error => ({ error: error.message }));
    const output = path.join(session.runDir, `route-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ok: evidence.ok, error: evidence.error, output }));
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
