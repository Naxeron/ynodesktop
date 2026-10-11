'use strict';

// Offline Chromium integration test. Run with `node tools/navbot-panel.test.js`.
// Uses the installed Electron; no live game, account, or browser package is needed.
// Set NAVBOT_PANEL_SCREENSHOTS to retain desktop and small-window screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 60000 });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, session } = require('electron');
const injectPanel = require('../src/scripts/navbot-panel');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yno-navbot-panel-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
let win;
let deadline;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = source => win.webContents.executeJavaScript(`(() => { ${source} })()`, true);
const shadow = 'document.getElementById("ynod-navbot").shadowRoot';
const field = id => `${shadow}.getElementById(${JSON.stringify(id)})`;

async function waitFor(source, message, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(`return Boolean(${source});`)) return;
    await sleep(40);
  }
  throw new Error(`Timed out: ${message}`);
}

async function setValue(id, value) {
  await evaluate(`const el = ${field(id)}; el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));`);
}

async function click(id) {
  await evaluate(`${field(id)}.click();`);
}

async function pressKey(id, key) {
  await evaluate(`${field(id)}.focus();`);
  win.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
  await sleep(50);
}

async function searchMaps(query) {
  await evaluate(`${field('map')}.focus();`);
  await setValue('map', query);
}

const mapOptions = `${field('map-results')}.querySelectorAll('[role="option"]')`;

async function clickMapOption(index, scroll = true) {
  const point = await evaluate(`const option = ${mapOptions}[${index}]; if (${scroll}) option.scrollIntoView({ block: 'nearest' }); const rect = option.getBoundingClientRect(); const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2); return { x, y, clickable: option.contains(${shadow}.elementFromPoint(x, y)) };`);
  assert.equal(point.clickable, true, 'map suggestion is visible and not covered by sticky controls');
  win.focus();
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await sleep(50);
}

async function freshPanel(configuration = '') {
  await win.loadFile(path.join(__dirname, 'fixtures/navbot-panel.html'));
  if (configuration) await evaluate(configuration);
  await injectPanel(win);
  await evaluate('document.getElementById("canvas").focus(); document.getElementById("ynod-navbot-toggle").click();');
  await waitFor(`${field('panel')}.getBoundingClientRect().height > 0`, 'fresh panel opens');
  await waitFor('panelFixture.stateCalls > 0', 'fresh panel reads engine state');
  await setValue('mode', 'map');
}

async function testMapAutocomplete() {
  win.setContentSize(1100, 752);
  await freshPanel();
  await waitFor('panelFixture.mapsCalls > 0', 'map catalog requested');
  assert.equal(await evaluate(`return ${field('map')}.getAttribute('role');`), 'combobox');
  assert.equal(await evaluate(`return ${field('map-results')}.getAttribute('role');`), 'listbox');

  await searchMaps('gEo');
  await waitFor(`${mapOptions}.length === 2`, 'case-insensitive partial map-name matches');
  assert.equal(await evaluate(`return Array.from(${mapOptions}).every(el => el.textContent.includes('Geometry World'));`), true);
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'matching names require an explicit selection');
  await screenshot('navbot-autocomplete-desktop');
  await searchMaps('forest anc');
  await waitFor(`${mapOptions}.length === 1`, 'search matches all name tokens in any order');
  assert.match(await evaluate(`return ${mapOptions}[0].textContent;`), /Ancient Forest/);

  await searchMaps('Nexus');
  await waitFor(`${mapOptions}.length === 1`, 'exact-name match shown');
  await click('start');
  assert.equal(await evaluate('return panelFixture.commands.length;'), 0, 'typing an exact name does not imply a map ID');
  await evaluate('panelFixture.gameKeys = [];');
  await pressKey('map', 'Down');
  const activeOption = await evaluate(`return ${field('map')}.getAttribute('aria-activedescendant');`);
  assert.ok(activeOption, 'arrow navigation exposes the active option for assistive technology');
  await pressKey('map', 'Return');
  await waitFor(`!${field('start')}.disabled`, 'Enter chooses an explicit map');
  assert.equal(await evaluate(`return ${field('map')}.value;`), 'Nexus');
  assert.equal(await evaluate('return panelFixture.commands.length;'), 0, 'Enter selects without launching navigation');
  assert.deepEqual(await evaluate('return panelFixture.gameKeys;'), [], 'picker arrows and Enter stay out of game input');
  await searchMaps('Nexu');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'editing the selected name clears its map ID');
  await click('start');
  assert.equal(await evaluate('return panelFixture.commands.length;'), 0, 'edited selection cannot issue movement');

  await searchMaps('Geometry');
  await waitFor(`${mapOptions}.length === 2`, 'duplicate map names remain separate options');
  const duplicateNames = await evaluate(`return Array.from(${mapOptions}).map(el => el.textContent);`);
  assert.match(duplicateNames[0], /34/);
  assert.match(duplicateNames[1], /35/);
  await clickMapOption(1);
  await waitFor(`!${field('start')}.disabled`, 'mouse selection resolves duplicate map');
  await setValue('x', 3);
  await setValue('y', 4);
  await click('start');
  await waitFor('panelFixture.commands.length === 1', 'selected duplicate submitted');
  assert.deepEqual(await evaluate('return panelFixture.commands[0];'), { op: 'goto-map', map: 35, x: 3, y: 4 }, 'actual selected map ID reaches the engine');
  await click('stop');
  await waitFor('panelFixture.commands.at(-1)?.op === "stop"', 'stop after duplicate-map navigation');

  await searchMaps('no-such-world');
  assert.equal(await evaluate(`return ${mapOptions}.length;`), 0, 'unknown names offer no false match');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'unknown name cannot start navigation');
  assert.match(await evaluate(`return ${field('map-search-status')}.textContent;`), /no .*match|no .*found|no map/i, 'unknown name has explanatory feedback');
  await searchMaps('Moon');
  await waitFor(`${mapOptions}.length === 1`, 'map names containing markup can be searched');
  assert.equal(await evaluate(`return ${field('map-results')}.querySelector('em');`), null, 'catalog names are rendered as text');

  await searchMaps('Geometry');
  await evaluate('panelFixture.gameKeys = [];');
  await pressKey('map', 'Escape');
  assert.equal(await evaluate(`return ${field('map')}.getAttribute('aria-expanded');`), 'false', 'first Escape dismisses suggestions');
  assert.ok(await evaluate(`return ${field('panel')}.getBoundingClientRect().height;`), 'first Escape leaves the panel open');
  await pressKey('map', 'Escape');
  await waitFor(`${field('panel')}.getBoundingClientRect().height === 0`, 'second Escape closes panel');
  assert.deepEqual(await evaluate('return panelFixture.gameKeys;'), [], 'picker Escape key and release never reach the game');
  assert.equal(await evaluate('return document.activeElement?.id;'), 'canvas', 'picker close restores game focus');
  await evaluate('document.getElementById("ynod-navbot-toggle").click();');
  win.setContentSize(640, 480);
  await searchMaps('Geometry');
  await waitFor(`${mapOptions}.length === 2`, 'small-window suggestions shown');
  await screenshot('navbot-autocomplete-small-window');
  await clickMapOption(0, false);
  await waitFor(`!${field('start')}.disabled`, 'small-window result can be selected without manual scrolling');
  console.log('PASS: map-name matching, duplicate IDs, explicit selection, keyboard controls, and small-window suggestions');

  await freshPanel('panelFixture.deferMaps = true;');
  await searchMaps('Nex');
  await waitFor('panelFixture.pendingMaps !== null', 'catalog request is pending');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'catalog loading cannot resolve typed names');
  assert.equal(await evaluate(`return ${mapOptions}.length;`), 0, 'loading does not show stale catalog entries');
  await evaluate('panelFixture.deferMaps = false; panelFixture.pendingMaps(); panelFixture.pendingMaps = null;');
  await waitFor(`${mapOptions}.length === 1`, 'loaded catalog applies the current query');

  await freshPanel('panelFixture.mapsError = "Map catalog is temporarily unavailable";');
  await searchMaps('Nex');
  await waitFor(`!${field('map-retry')}.hidden`, 'failed catalog request offers retry');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'catalog failure cannot start unresolved movement');
  const beforeRetry = await evaluate('return panelFixture.mapsCalls;');
  await evaluate('panelFixture.mapsError = null;');
  await click('map-retry');
  await waitFor(`panelFixture.mapsCalls > ${beforeRetry}`, 'retry requests catalog again');
  await waitFor(`${mapOptions}.length === 1`, 'retry recovers matching names');

  await freshPanel('panelFixture.maps.game = "yume";');
  await searchMaps('Nexus');
  await waitFor('panelFixture.mapsCalls > 0', 'wrong-game response received');
  await sleep(80);
  assert.equal(await evaluate(`return ${mapOptions}.length;`), 0, 'a catalog for another game is ignored');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'wrong-game catalog cannot resolve a destination');
  assert.equal(await evaluate('return panelFixture.commands.length;'), 0);
  console.log('PASS: catalog loading, failure/retry, and wrong-game response isolation');

  await freshPanel('window.locationsData = [{ id: 987, title: "Chocolate World" }];');
  await searchMaps('chocolate');
  await waitFor(`${mapOptions}.length === 1`, 'page location names supplement the map catalog');
  assert.match(await evaluate(`return ${mapOptions}[0].textContent;`), /look up/i);
  await clickMapOption(0);
  await waitFor(`${mapOptions}.length === 2`, 'Explorer map IDs expand into explicit choices');
  assert.equal(await evaluate('return panelFixture.commands.length;'), 0, 'location lookup never starts movement');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'ambiguous location requires map disambiguation');
  assert.equal(await evaluate('return panelFixture.lookupCalls[0];'), 'https://explorer.yume.wiki/getLocationInfo?locationName=Chocolate%20World');
  const resolvedNames = await evaluate(`return Array.from(${mapOptions}).map(el => el.textContent);`);
  assert.match(resolvedNames[0], /0036/);
  assert.match(resolvedNames[1], /0037/);
  assert.ok(resolvedNames.every(name => !name.includes('987')), 'location record IDs are never treated as map IDs');
  await clickMapOption(1);
  await setValue('x', 3);
  await setValue('y', 4);
  await click('start');
  await waitFor('panelFixture.commands.length === 1', 'disambiguated location submitted');
  assert.deepEqual(await evaluate('return panelFixture.commands[0];'), { op: 'goto-map', map: 37, x: 3, y: 4 });

  await freshPanel('window.locationsData = [{ id: 987, title: "Chocolate World" }]; panelFixture.deferLookup = true;');
  await searchMaps('chocolate');
  await clickMapOption(0);
  await waitFor('panelFixture.pendingLookup !== null', 'location lookup is pending');
  await searchMaps('Nex');
  await evaluate('panelFixture.deferLookup = false; panelFixture.pendingLookup(); panelFixture.pendingLookup = null;');
  await sleep(60);
  assert.equal(await evaluate(`return ${field('map')}.value;`), 'Nex', 'old lookup cannot overwrite edited query');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'old lookup cannot select a destination after editing');
  assert.equal(await evaluate(`return ${mapOptions}.length;`), 1);
  assert.match(await evaluate(`return ${mapOptions}[0].textContent;`), /Nexus/);

  await freshPanel('window.locationsData = [{ id: 987, title: "Chocolate World" }]; panelFixture.lookupResponse = { title: "Different World", mapIds: ["0036"] };');
  await searchMaps('chocolate');
  await clickMapOption(0);
  await waitFor(`${field('feedback')}.textContent.toLowerCase().includes('lookup failed')`, 'mismatched lookup response has readable error');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'failed lookup cannot start navigation');
  assert.equal(await evaluate('return panelFixture.commands.length;'), 0);

  await freshPanel('window.locationsData = [{ id: 1234, title: "Cached Corner" }]; window.locationCache = { "0002_0088": [{ title: "Cached Corner" }] };');
  await searchMaps('cached');
  await waitFor(`${mapOptions}.length === 1`, 'cached location becomes a known map option');
  assert.match(await evaluate(`return ${mapOptions}[0].textContent;`), /0088/);
  await clickMapOption(0);
  await click('start');
  await waitFor('panelFixture.commands.length === 1', 'cached map selected');
  assert.equal(await evaluate('return panelFixture.commands[0].map;'), 88, 'map ID comes from the location cache key');
  assert.equal(await evaluate('return panelFixture.lookupCalls.length;'), 0, 'known cached map does not need a network lookup');
  console.log('PASS: page-name enrichment, explicit map disambiguation, stale lookup rejection, and cached-map IDs');
}

async function updateSnapshot(source) {
  const calls = await evaluate(`return panelFixture.stateCalls;`);
  await evaluate(source);
  await waitFor(`panelFixture.stateCalls > ${calls}`, 'updated game state polled');
  await sleep(40);
}

async function screenshot(name) {
  if (!process.env.NAVBOT_PANEL_SCREENSHOTS) return;
  const directory = path.resolve(process.env.NAVBOT_PANEL_SCREENSHOTS);
  fs.mkdirSync(directory, { recursive: true });
  const image = await win.webContents.capturePage();
  assert.ok(!image.isEmpty(), 'window screenshot has pixels');
  const output = path.join(directory, `${name}.png`);
  fs.writeFileSync(output, image.toPNG());
  console.log(`Screenshot: ${output}`);
}

async function run() {
  deadline = setTimeout(() => {
    console.error('Navbot panel browser test exceeded 45 seconds.');
    finish(1);
  }, 45000);
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) });
  });
  win = new BrowserWindow({
    width: 1100, height: 780, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  await win.loadFile(path.join(__dirname, 'fixtures/navbot-panel.html'));
  console.log('Loaded offline Navbot fixture in sandboxed Electron renderer.');
  assert.equal(await evaluate('return typeof require;'), 'undefined', 'renderer has no Node integration');
  await injectPanel(win);
  await waitFor('document.querySelector("#ynod-navbot")', 'panel mounted');
  await injectPanel(win);
  assert.equal(await evaluate('return document.querySelectorAll("#ynod-navbot").length;'), 1, 'mount is idempotent');
  await evaluate('document.getElementById("canvas").focus(); document.getElementById("ynod-navbot-toggle").click();');
  await waitFor(`${field('panel')}.getBoundingClientRect().height > 0`, 'panel opens');
  await waitFor('panelFixture.stateCalls > 0', 'initial state requested');
  await sleep(60);

  await click('current');
  assert.equal(await evaluate(`return ${field('x')}.value;`), '8');
  assert.equal(await evaluate(`return ${field('y')}.value;`), '5');
  await setValue('mode', 'local');
  await setValue('x', 6);
  await setValue('y', 7);
  await click('start');
  await waitFor('panelFixture.commands.length === 1', 'local movement submitted');
  assert.deepEqual(await evaluate('return panelFixture.commands[0];'), { op: 'goto', x: 6, y: 7 });
  await click('stop');
  await waitFor('panelFixture.commands.at(-1)?.op === "stop"', 'stop submitted');
  await waitFor(`!${field('start')}.disabled`, 'movement controls enabled after stop');

  await click('nexus');
  assert.equal(await evaluate('return panelFixture.commands.length;'), 2, 'Nexus preset does not move automatically');
  assert.equal(await evaluate(`return ${field('map')}.value;`), 'Nexus');
  assert.equal(await evaluate(`return ${field('x')}.value;`), '3');
  assert.equal(await evaluate(`return ${field('y')}.value;`), '4');
  await click('start');
  await waitFor('panelFixture.commands.length === 3', 'map movement submitted');
  assert.deepEqual(await evaluate('return panelFixture.commands.at(-1);'), { op: 'goto-map', map: 10, x: 3, y: 4 });
  await waitFor(`${field('route')}.textContent.includes('10')`, 'route displayed');
  await screenshot('navbot-desktop');
  await click('stop');
  await waitFor(`!${field('start')}.disabled`, 'movement completed');
  console.log('PASS: mount, current position, local movement, Nexus preset, route, and Stop');

  const commandsBeforeInvalid = await evaluate('return panelFixture.commands.length;');
  await setValue('map', 0);
  await click('start');
  await sleep(80);
  assert.equal(await evaluate('return panelFixture.commands.length;'), commandsBeforeInvalid, 'invalid map cannot issue a command');
  await setValue('mode', 'local');
  await setValue('x', 20);
  await click('start');
  await sleep(80);
  assert.equal(await evaluate('return panelFixture.commands.length;'), commandsBeforeInvalid, 'out-of-bounds local tile cannot issue a command');
  await setValue('x', 3);
  await click('nexus');
  await updateSnapshot('panelFixture.snapshot.state.graph_loaded = false;');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'cross-map movement needs a graph');
  await setValue('mode', 'local');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), false, 'local movement remains available without a graph');
  await updateSnapshot('panelFixture.snapshot.ready = false;');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'movement is disabled until engine ready');
  await updateSnapshot('panelFixture.snapshot.ready = true; panelFixture.snapshot.state.graph_loaded = true; panelFixture.snapshot.state.scene = "Title";');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'movement is disabled outside a map');
  await updateSnapshot('panelFixture.snapshot.state.scene = "Map";');
  await setValue('x', 7);
  await setValue('y', 6);
  await updateSnapshot('panelFixture.snapshot.state.player_x = 9; panelFixture.snapshot.state.player_y = 4;');
  assert.equal(await evaluate(`return ${field('x')}.value;`), '7', 'polling preserves edited X');
  assert.equal(await evaluate(`return ${field('y')}.value;`), '6', 'polling preserves edited Y');
  await updateSnapshot('panelFixture.snapshot.enabled = false; panelFixture.snapshot.ready = false;');
  assert.equal(await evaluate(`return ${field('start')}.disabled;`), true, 'unavailable engine cannot start movement');
  assert.equal(await evaluate(`return ${field('stop')}.disabled;`), true, 'unavailable engine cannot issue Stop');
  assert.equal(await evaluate(`return ${field('unavailable')}.hidden;`), false, 'unavailable engine has setup instructions');
  await screenshot('navbot-unavailable');
  await updateSnapshot('panelFixture.snapshot.enabled = true; panelFixture.snapshot.ready = true; panelFixture.snapshot.game = "yume";');
  assert.equal(await evaluate(`return ${field('nexus')}.hidden;`), true, '2kki Nexus preset is hidden in another game');
  await updateSnapshot('panelFixture.snapshot.game = "2kki";');
  console.log('PASS: invalid coordinates, graph availability, engine readiness, and title scene');

  await evaluate('panelFixture.deferMovement = true;');
  await click('start');
  await waitFor('panelFixture.pendingMovement !== null', 'movement command is pending');
  assert.equal(await evaluate(`return ${field('stop')}.disabled;`), false, 'Stop stays usable while movement request is pending');
  const countBeforeStop = await evaluate('return panelFixture.commands.length;');
  await click('stop');
  await waitFor(`panelFixture.commands.length === ${countBeforeStop + 1}`, 'Stop bypasses pending movement');
  assert.deepEqual(await evaluate('return panelFixture.commands.at(-1);'), { op: 'stop' });
  await evaluate('panelFixture.deferMovement = false; panelFixture.finishMovement();');
  await waitFor(`!${field('start')}.disabled`, 'controls recover after pending movement');
  assert.equal(await evaluate(`return ${field('status')}.textContent;`), 'Ready to explore', 'stale movement completion cannot overwrite Stop');
  await evaluate('panelFixture.snapshot.state.active = true; panelFixture.snapshot.state.status = "navigating"; panelFixture.deferState = true;');
  await waitFor('panelFixture.pendingState !== null', 'state request is pending');
  await click('stop');
  await waitFor(`${field('status')}.textContent === 'Ready to explore'`, 'Stop state applied');
  await evaluate('panelFixture.deferState = false; panelFixture.pendingState(); panelFixture.pendingState = null;');
  await sleep(80);
  assert.equal(await evaluate(`return ${field('status')}.textContent;`), 'Ready to explore', 'stale poll response cannot overwrite Stop');
  await evaluate('panelFixture.commandError = "No route is available";');
  await click('start');
  await waitFor(`${field('feedback')}.textContent.includes('No route is available')`, 'command error visible');
  await evaluate('panelFixture.commandError = null;');
  console.log('PASS: Stop during pending command and readable command failures');

  await evaluate(`panelFixture.gameKeys = []; ${field('x')}.focus();`);
  await evaluate(`${field('x')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, composed: true })); ${field('x')}.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true, composed: true }));`);
  assert.deepEqual(await evaluate('return panelFixture.gameKeys;'), [], 'panel keyboard input never reaches game listeners');
  await evaluate(`${field('x')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })); ${field('x')}.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true, composed: true }));`);
  await waitFor(`${field('panel')}.getBoundingClientRect().height === 0`, 'Escape closes panel');
  assert.equal(await evaluate('return document.activeElement?.id;'), 'canvas', 'closing restores previous game focus');
  await evaluate('document.getElementById("canvas").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));');
  assert.equal(await evaluate('return panelFixture.gameKeys.at(-1)?.key;'), 'ArrowRight', 'closed panel preserves game keyboard input');
  await evaluate('document.getElementById("ynod-navbot-toggle").click();');
  await waitFor(`${field('panel')}.getBoundingClientRect().height > 0`, 'panel reopens');
  console.log('PASS: keyboard isolation, Escape close, and restored game focus');

  win.setContentSize(640, 480);
  await sleep(100);
  const layout = await evaluate(`const panel = ${field('panel')}; const rect = panel.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, overflow: panel.scrollWidth > panel.clientWidth };`);
  assert.ok(layout.left >= 0 && layout.right <= layout.width + 1, 'panel fits small-window width');
  assert.ok(layout.top >= 0 && layout.bottom <= layout.height + 1, 'panel fits small-window height');
  assert.equal(layout.overflow, false, 'panel has no horizontal overflow');
  const stopBounds = await evaluate(`const rect = ${field('stop')}.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height };`);
  assert.ok(stopBounds.height > 0 && stopBounds.top >= layout.top && stopBounds.bottom <= layout.bottom, 'Stop remains visible without scrolling in a small window');
  await screenshot('navbot-small-window');
  console.log('PASS: small-window layout');
  await testMapAutocomplete();
}

function finish(code) {
  clearTimeout(deadline);
  if (win && !win.isDestroyed()) win.destroy();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(code);
}

run().then(() => {
  console.log('Navbot panel browser tests passed.');
  finish(0);
}, async error => {
  console.error(error);
  if (win && !win.isDestroyed()) await screenshot('navbot-failure').catch(() => {});
  finish(1);
});
