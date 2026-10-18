'use strict';

// Kept self-contained so Electron can install it in the isolated page without
// exposing Node, filesystem access, or arbitrary evaluation through the preload.
function mountNavbotPanel() {
  if (document.getElementById('ynod-navbot') || !window.electronAPI?.navbotState) return;
  const host = document.createElement('div');
  host.id = 'ynod-navbot';
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; color-scheme: dark; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      #panel { position: fixed; z-index: 10000; top: 42px; right: 12px;
        width: 352px; max-width: calc(100vw - 24px); max-height: calc(100dvh - 54px);
        overflow: auto; overscroll-behavior: contain; scroll-padding-bottom: 76px; color: #ece7f1;
        background: #19161f; border: 1px solid #49404f; border-radius: 12px;
        box-shadow: 0 16px 60px #0009; font: 13px/1.5 system-ui, sans-serif;
        -webkit-app-region: no-drag; }
      header { display: flex; align-items: center; gap: 10px; padding: 17px 18px 14px; }
      .mark { display: grid; place-items: center; width: 34px; height: 34px;
        border: 1px solid #59465f; border-radius: 10px; color: #d9afe1; background: #2b2232; }
      h2 { font-size: 16px; line-height: 1.2; margin: 0; font-weight: 650; }
      .sub { color: #a99caf; font-size: 11px; margin-top: 3px; }
      #game { margin-left: auto; color: #bcaac5; font-size: 10px; letter-spacing: .07em;
        text-transform: uppercase; border: 1px solid #493b51; border-radius: 5px; padding: 2px 6px; }
      button, input, select { font: inherit; }
      button { cursor: pointer; border: 1px solid #524459; border-radius: 7px; color: #eee7f4;
        background: #302737; min-height: 34px; padding: 6px 11px; }
      button:hover:not(:disabled) { background: #45354e; border-color: #9472a1; }
      button:disabled { opacity: .45; cursor: default; }
      :focus-visible { outline: 2px solid #dfb3eb; outline-offset: 3px; }
      #close { border: none; background: none; color: #b7aabd; font-size: 22px;
        line-height: 1; padding: 3px; width: 26px; min-height: 28px; }
      .body { padding: 0 18px 17px; }
      .live { background: #221e28; border: 1px solid #39303f; border-radius: 8px; padding: 11px 12px; }
      .status-row { display: flex; align-items: center; gap: 7px; font-weight: 600; }
      .dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: #9b8ba3; }
      [data-tone="active"] .dot { background: #d9afe1; box-shadow: 0 0 8px #bd82cf66; }
      [data-tone="success"] .dot { background: #a9d6ba; }
      [data-tone="error"] .dot { background: #eca6aa; }
      #status-detail { margin: 4px 0 0; color: #b6a9bf; font-size: 12px; }
      .position { display: flex; gap: 22px; margin: 11px 0 0; padding-top: 10px; border-top: 1px solid #3b3242; }
      .position dt, .eyebrow { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #a899b1; }
      .position dd { margin: 3px 0 0; font-variant-numeric: tabular-nums; font-size: 13px; }
      form { margin-top: 17px; }
      label { display: block; color: #c8bacf; font-size: 12px; margin-bottom: 5px; }
      input, select { width: 100%; border: 1px solid #52465d; border-radius: 7px; background: #141218;
        color: #f1eaf5; padding: 8px 10px; min-height: 36px; }
      input:disabled, select:disabled { opacity: .5; }
      #map-field { margin-top: 11px; }
      #map-results { padding: 4px; margin: 6px 0 0; list-style: none; border: 1px solid #594762;
        border-radius: 7px; background: #211a28; max-height: min(175px, 30dvh); overflow-y: auto; overscroll-behavior: contain; }
      #map-results [role="option"] { padding: 7px 8px; border-radius: 4px; cursor: pointer; overflow-wrap: anywhere; }
      #map-results [role="option"]:hover, #map-results [aria-selected="true"] { background: #473251; }
      .option-name { display: block; color: #f0e7f5; font-size: 12px; }
      .option-meta { display: block; color: #b9a6c4; font-size: 10px; margin-top: 2px; }
      #map-search-status { color: #b9a6c4; font-size: 11px; margin-top: 5px; }
      #map-retry { font-size: 11px; min-height: 26px; margin-top: 5px; padding: 3px 8px; }
      .fields { display: flex; gap: 10px; margin-top: 11px; }
      .fields > div { flex: 1; min-width: 0; }
      .shortcuts { display: flex; gap: 7px; flex-wrap: wrap; margin: 10px 0; }
      .shortcuts button { min-height: 28px; padding: 4px 8px; font-size: 11px; background: transparent; }
      .hint { color: #a99caf; font-size: 11px; margin: 8px 0 0; }
      #feedback { font-size: 12px; color: #f0b2b7; margin: 10px 0 0; overflow-wrap: anywhere; }
      .route-box { margin-top: 16px; border-top: 1px solid #3a303f; padding-top: 12px; }
      #route { color: #d5c7df; font-size: 12px; margin-top: 5px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
      #route-detail { color: #a99caf; font-size: 11px; margin-top: 4px; }
      .actions { display: flex; gap: 8px; margin-top: 7px; padding: 10px 0;
        position: sticky; bottom: 0; z-index: 1; background: #19161f; box-shadow: 0 -6px 12px #19161f; }
      #start { flex: 1; background: #c394d2; border-color: #c394d2; color: #211529; font-weight: 650; }
      #start:hover:not(:disabled) { background: #d6afe1; }
      #stop { width: 87px; color: #f0b8bd; border-color: #73515b; background: #33232b; }
      #unavailable { border-top: 1px solid #3a303f; margin-top: 15px; padding-top: 12px; color: #baadc3; font-size: 12px; }
      #unavailable p { margin: 0 0 9px; }
      code { display: block; color: #e1c3eb; background: #100e14; padding: 9px; border-radius: 6px;
        user-select: text; font: 11px/1.5 monospace; overflow-wrap: anywhere; }
      footer { font-size: 10px; color: #a99caf; text-align: center; margin-top: 11px; }
      @media (max-height: 570px) { header { padding-top: 11px; padding-bottom: 10px; } .body { padding-bottom: 12px; } }
    </style>
    <section id="panel" role="dialog" aria-modal="false" aria-labelledby="heading" hidden>
      <header>
        <span class="mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg></span>
        <div><h2 id="heading">Navbot</h2><div class="sub">A little help finding your way</div></div>
        <span id="game" hidden></span><button id="close" type="button" aria-label="Close Navbot" title="Close panel (Esc)">×</button>
      </header>
      <div class="body">
        <div class="live" id="live">
          <div class="status-row"><span class="dot" aria-hidden="true"></span><span id="status" role="status" aria-live="polite">Connecting…</span></div>
          <p id="status-detail">Reading the game state.</p>
          <dl class="position"><div><dt>Current map</dt><dd id="position-map">—</dd></div><div><dt>Position · X, Y</dt><dd id="position-xy">—</dd></div><div><dt>Scene</dt><dd id="scene">—</dd></div></dl>
        </div>
        <div id="unavailable" hidden><p>From the project folder, start a Navbot session, then open this panel:</p><code>./test_navbot.sh 2kki</code><p class="hint">The session uses its own local saves and settings.</p></div>
        <form id="form" novalidate>
          <label for="mode">Destination</label>
          <select id="mode"><option value="local">Walk within this map</option><option value="map">Travel to another map</option></select>
          <div id="map-field" hidden>
            <label for="map">Map name</label>
            <input id="map" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="map-results" aria-describedby="map-selection map-search-status" autocomplete="off" spellcheck="false" placeholder="Search map names…" required>
            <ul id="map-results" role="listbox" aria-label="Matching maps" hidden></ul>
            <div id="map-search-status" role="status" aria-live="polite"></div>
            <button id="map-retry" type="button" hidden>Retry map names</button>
            <p id="map-selection" class="hint">Choose a map from the suggestions.</p>
          </div>
          <div class="fields">
            <div><label for="x">X coordinate</label><input id="x" type="number" inputmode="numeric" min="0" max="9999" step="1" placeholder="0" required></div>
            <div><label for="y">Y coordinate</label><input id="y" type="number" inputmode="numeric" min="0" max="9999" step="1" placeholder="0" required></div>
          </div>
          <div class="shortcuts"><button id="current" type="button">Use current position</button><button id="nexus" type="button" hidden>Nexus · 2kki</button><button id="planetarium" type="button" hidden>Planetarium · 2kki</button></div>
          <p id="target-hint" class="hint">Coordinates start at 0.</p>
          <p id="feedback" role="alert" hidden></p>
          <div class="route-box"><div class="eyebrow">Route</div><div id="route">Choose a destination to begin.</div><div id="route-detail">Navbot walks using normal game controls.</div></div>
          <div class="actions"><button id="start" type="submit" disabled>Start navigation</button><button id="stop" type="button" disabled>■ Stop</button></div>
        </form>
        <footer id="footer">Closing this panel keeps navigation running.</footer>
      </div>
    </section>`;
  const $ = id => root.getElementById(id);
  let snapshot = { enabled: false, ready: false };
  let open = false, previousFocus = null, polling = false, busy = false;
  let epoch = 0, initializedPosition = false, destinationEdited = false, commandPending = false, stopped = false, timer;
  const mapScene = () => {
    const s = snapshot.state;
    // Official sessions report the scene only while engine memory reads are verified.
    return snapshot.ready && s && (s.backend === 'official' ? s.map_known === true && (typeof s.scene !== 'string' || s.scene === 'Map') : s.scene === 'Map')
      && s.map_width > 0 && s.map_height > 0 && Number.isInteger(s.player_x) && Number.isInteger(s.player_y)
      && s.player_x >= 0 && s.player_y >= 0 && s.player_x < s.map_width && s.player_y < s.map_height;
  };
  const mapMode = () => $('mode').value === 'map';
  let mapSelection = null, mapEntries = [], catalogGame = null, catalogState = 'idle';
  let catalogRequest = 0, selectionRequest = 0, suggestions = [], activeSuggestion = -1, dismissEscape = false, resolvingMap = false;
  const differentMap = () => mapMode() && mapSelection?.mapId !== snapshot.state?.map_id;
  const normalize = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
  const mapNumber = id => String(id).padStart(4, '0');
  function describeMap(entry) {
    if (!entry.mapId) return 'Look up maps for this location';
    let detail = `Map ${mapNumber(entry.mapId)}`;
    if (entry.regions?.length) detail += ' · Named area within this map';
    if (entry.conditional) detail += ' · Name depends on the entrance';
    return detail;
  }
  function closeSuggestions() {
    $('map-results').hidden = true;
    $('map').setAttribute('aria-expanded', 'false');
    $('map').removeAttribute('aria-activedescendant');
    activeSuggestion = -1;
  }
  function selectMap(entry) {
    if (!entry.mapId) { void resolveMap(entry); return; }
    ++selectionRequest; resolvingMap = false;
    mapSelection = entry;
    $('map').value = entry.name;
    $('map').setCustomValidity('');
    text('map-selection', describeMap(entry));
    closeSuggestions();
    feedback();
    updateControls();
  }
  function highlightSuggestion(index) {
    activeSuggestion = index;
    for (const [i, option] of [...$('map-results').children].entries()) option.setAttribute('aria-selected', String(i === index));
    const option = $('map-results').children[index];
    if (option) {
      $('map').setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    }
  }
  // Reuse names the game page already loaded. World/location record IDs must
  // never become engine map IDs; only known cache keys or Explorer mapIds do.
  function enrichMapNames() {
    if (snapshot.game !== '2kki' || (typeof gameId !== 'undefined' && gameId !== '2kki')) return;
    const known = new Set(mapEntries.filter(entry => entry.mapId).map(entry => `${entry.mapId}\n${entry.name}`));
    if (typeof locationCache === 'object' && locationCache) {
      for (const [key, locations] of Object.entries(locationCache)) {
        const match = /^\d{4}_(\d{4})$/.exec(key);
        if (!match || !Array.isArray(locations)) continue;
        const mapId = Number(match[1]);
        if (mapId < 1) continue;
        for (const location of locations) {
          if (typeof location?.title !== 'string' || !location.title.trim()) continue;
          const name = location.title;
          if (known.has(`${mapId}\n${name}`)) continue;
          mapEntries.push({ mapId, name }); known.add(`${mapId}\n${name}`);
        }
      }
    }
    const knownNames = new Set(mapEntries.filter(entry => entry.mapId).map(entry => entry.name));
    mapEntries = mapEntries.filter(entry => entry.mapId || !knownNames.has(entry.name));
    const names = new Set(mapEntries.map(entry => entry.name));
    if (typeof locationsData !== 'undefined' && Array.isArray(locationsData)) {
      for (const location of locationsData) {
        if (typeof location?.title !== 'string' || !location.title.trim() || names.has(location.title)) continue;
        mapEntries.push({ mapId: null, name: location.title }); names.add(location.title);
      }
    }
  }
  async function resolveMap(entry) {
    const request = ++selectionRequest;
    const game = snapshot.game;
    resolvingMap = true; mapSelection = null;
    $('map').value = entry.name;
    closeSuggestions(); feedback(); updateControls();
    text('map-selection', `Looking up maps for ${entry.name}…`);
    try {
      if (game !== '2kki' || typeof send2kkiApiRequest !== 'function') throw new Error('Map lookup is unavailable. Let the game finish loading and try again.');
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Map lookup timed out. Select the name to try again.')), 11000);
        send2kkiApiRequest(`https://explorer.yume.wiki/getLocationInfo?locationName=${encodeURIComponent(entry.name)}`, response => { clearTimeout(timeout); resolve(response); });
      });
      if (stopped || request !== selectionRequest || snapshot.game !== game) return;
      if (result?.title !== entry.name || !Array.isArray(result.mapIds)) throw new Error('Map lookup failed. Select the name to try again.');
      const ids = [...new Set(result.mapIds.filter(id => /^\d{1,4}$/.test(String(id))).map(Number))].filter(id => Number.isInteger(id) && id > 0 && id <= 9999);
      if (!ids.length) throw new Error('No map was found for this location. Try another name.');
      const entries = ids.map(mapId => ({ mapId, name: entry.name }));
      mapEntries = mapEntries.filter(candidate => candidate.name !== entry.name || candidate.mapId);
      const keys = new Set(mapEntries.map(candidate => `${candidate.mapId}\n${candidate.name}`));
      for (const candidate of entries) if (!keys.has(`${candidate.mapId}\n${candidate.name}`)) mapEntries.push(candidate);
      resolvingMap = false;
      if (entries.length === 1) selectMap(entries[0]);
      else {
        text('map-selection', 'This name covers several maps. Choose one from the suggestions.');
        if (root.activeElement === $('map')) showSuggestions();
      }
    } catch (error) {
      if (stopped || request !== selectionRequest || snapshot.game !== game) return;
      resolvingMap = false;
      text('map-selection', 'Choose a map from the suggestions.');
      feedback(error.message || 'Map lookup failed. Try again.');
    }
    updateControls();
  }
  function showSuggestions() {
    if (!mapMode() || $('map').disabled) return closeSuggestions();
    enrichMapNames();
    const query = normalize($('map').value);
    const tokens = query.split(/\s+/).filter(Boolean);
    const matches = mapEntries.filter(entry => tokens.every(token => normalize(entry.name).includes(token)));
    matches.sort((a, b) => {
      const score = entry => normalize(entry.name) === query ? 0 : normalize(entry.name).startsWith(query) ? 1 : 2;
      return score(a) - score(b) || a.name.localeCompare(b.name) || a.mapId - b.mapId;
    });
    suggestions = matches.slice(0, 40);
    activeSuggestion = -1;
    $('map-results').replaceChildren();
    $('map').removeAttribute('aria-activedescendant');
    for (const [i, entry] of suggestions.entries()) {
      const option = document.createElement('li');
      option.id = `map-option-${i}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      const name = document.createElement('span'); name.className = 'option-name'; name.textContent = entry.name;
      const detail = document.createElement('span'); detail.className = 'option-meta'; detail.textContent = describeMap(entry);
      option.append(name, detail);
      // Keep focus in the combobox while selecting with a mouse.
      option.addEventListener('mousedown', event => event.preventDefault());
      option.addEventListener('click', () => { destinationEdited = true; selectMap(entry); });
      $('map-results').append(option);
    }
    const expanded = suggestions.length > 0;
    $('map-results').hidden = !expanded;
    $('map').setAttribute('aria-expanded', String(expanded));
    text('map-search-status', catalogState === 'loading' ? 'Loading map names…' : catalogState === 'error' ?
      'Map names could not be loaded. Try again.' : matches.length > 40 ? `${matches.length} matches. Keep typing to narrow the list.` :
      matches.length ? `${matches.length} matching ${matches.length === 1 ? 'map' : 'maps'}. Use ↑ and ↓, then Enter to select.` : 'No matching map names. Try another name.');
    if (expanded) $('map-field').scrollIntoView({ block: 'nearest' });
  }
  async function loadMapNames(game) {
    const request = ++catalogRequest;
    catalogGame = game; catalogState = 'loading'; mapEntries = [];
    $('map-retry').hidden = true;
    text('map-search-status', 'Loading map names…');
    try {
      const result = await window.electronAPI.navbotMaps();
      if (stopped || request !== catalogRequest) return;
      if (result.game !== game || !Array.isArray(result.entries) || result.error) throw new Error('Map names unavailable');
      mapEntries = result.entries.filter(entry => Number.isInteger(entry.mapId) && entry.mapId > 0 && entry.mapId <= 9999 && typeof entry.name === 'string' && entry.name.trim());
      catalogState = 'ready';
      enrichMapNames();
      text('map-search-status', mapEntries.length ? 'Search by name, then choose a matching map.' : 'No map names are available for this game.');
      if (!destinationEdited && !mapSelection && snapshot.state?.map_id) {
        const current = mapEntries.filter(entry => entry.mapId === snapshot.state.map_id);
        if (current.length === 1) selectMap(current[0]);
      }
    } catch (error) {
      if (stopped || request !== catalogRequest) return;
      catalogState = 'error';
      $('map-retry').hidden = false;
      text('map-search-status', 'Map names could not be loaded. Try again.');
    }
    if (root.activeElement === $('map')) showSuggestions();
    updateControls();
  }
  const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  const readable = value => String(value || '').replaceAll('_', ' ');
  function feedback(message = '') { text('feedback', message); $('feedback').hidden = !message; }
  function updateControls() {
    $('map-field').hidden = !mapMode();
    $('map').disabled = !mapMode() || !snapshot.enabled;
    for (const id of ['mode', 'x', 'y']) $(id).disabled = !snapshot.enabled;
    $('current').disabled = !mapScene();
    $('nexus').hidden = snapshot.game !== '2kki';
    $('nexus').disabled = !snapshot.enabled;
    $('planetarium').hidden = snapshot.game !== '2kki';
    $('planetarium').disabled = !snapshot.enabled;
    const planetarium = snapshot.game === '2kki' && mapMode() && mapSelection?.mapId === 568;
    const unsupported = planetarium && snapshot.state?.backend === 'official' && snapshot.state.capabilities?.recipes !== true;
    const graphMissing = differentMap() && !snapshot.state?.graph_loaded && !(planetarium && snapshot.state?.map_id === 10);
    $('start').disabled = busy || resolvingMap || !mapScene() || graphMissing || unsupported || (mapMode() && !mapSelection);
    // Stop stays available during pending requests and communication failures.
    $('stop').disabled = !snapshot.enabled;
    text('start', busy ? 'Starting…' : snapshot.state?.active ? 'Update destination' : 'Start navigation');
    const localBounds = mapScene() && !differentMap();
    $('x').max = localBounds ? snapshot.state.map_width - 1 : 9999;
    $('y').max = localBounds ? snapshot.state.map_height - 1 : 9999;
    text('target-hint', unsupported ? 'The Planetarium route needs verified official-engine state. Load the game and try again.' :
      graphMissing ? 'Map routing is unavailable. You can still walk within this map.' :
      planetarium ? 'Planetarium route starts from the Nexus or starting room.' :
      localBounds ? `This map: X 0–${$('x').max} · Y 0–${$('y').max}.` : 'Coordinates start at 0. Choose the tile to walk to on the selected map.');
  }
  function render(next) {
    snapshot = next;
    if (next.enabled && next.game && catalogGame !== next.game) {
      ++selectionRequest; resolvingMap = false;
      mapSelection = null; $('map').value = ''; closeSuggestions();
      void loadMapNames(next.game);
    }
    const s = next.state || {};
    if (!initializedPosition && !destinationEdited && mapScene()) {
      $('x').value = s.player_x;
      $('y').value = s.player_y;
      const current = mapEntries.filter(entry => entry.mapId === s.map_id);
      if (current.length === 1) selectMap(current[0]);
      initializedPosition = true;
    }
    $('game').hidden = !next.game;
    text('game', next.game === '2kki' ? '2kki' : (next.game || ''));
    $('unavailable').hidden = next.enabled;
    $('form').hidden = !next.enabled;
    $('footer').hidden = !next.enabled;
    text('position-map', mapScene() ? String(s.map_id).padStart(4, '0') : '—');
    text('position-xy', mapScene() ? `${s.player_x}, ${s.player_y}` : '—');
    text('scene', s.backend === 'official' ? (typeof s.scene === 'string' ? `Official · ${s.scene}` : 'Official engine') : s.scene || '—');
    const statuses = {
      idle: ['Ready to explore', 'Choose a destination below.'],
      stopped: ['Stopped', 'Navbot has released its controls.'],
      navigating: ['On the way', 'Following the route to your destination.'],
      paused_scene: ['Waiting for the game', 'Navigation resumes when you return to the map.'],
      paused_message: ['Waiting for dialogue', 'Close the game dialogue to continue.'],
      paused_event: ['Waiting for an event', 'Navigation resumes when the event finishes.'],
      facing_departure: ['At the exit', 'Turning to face the next passage.'],
      interacting: ['Opening the way', 'Interacting with the next passage.'],
      waiting_for_teleport: ['Changing maps', 'Waiting for the map transition to finish.'],
      settling_after_teleport: ['Changing maps', 'Waiting for the new map to settle.'],
      loading_map: ['Reading the map', 'Loading this map\'s passages before walking.'],
      rerouting: ['Finding another way', 'Choosing a different route to the destination.'],
      interaction_ready: ['Next to the destination', 'The target tile is blocked. Interact in the game to continue.'],
      arrived: ['Destination reached', 'You have arrived at the requested tile.'],
      error: ['Navigation stopped', readable(s.last_error) || 'The route could not be completed.'],
    };
    let status = statuses[s.status] || ['Ready', 'Choose a destination below.'];
    if (s.status === 'arrived' && s.recipe?.expeditionComplete === true) status = ['Weekly expedition complete', 'Planetarium visit and expedition completion confirmed.'];
    if (!next.enabled) status = ['Navbot session required', 'Start a Navbot session to use navigation.'];
    else if (!next.ready) status = ['Waiting for the engine', next.message || 'Load the game to connect Navbot.'];
    else if (!mapScene() && !s.active) status = ['Waiting for a map', 'Continue or start a game to choose a destination.'];
    text('status', status[0]); text('status-detail', status[1]);
    $('live').dataset.tone = s.status === 'error' ? 'error' : s.active ? 'active' : s.status === 'arrived' ? 'success' : 'idle';
    const route = Array.isArray(s.route) ? s.route : [];
    const navigating = s.active || s.status === 'arrived' || s.status === 'interaction_ready';
    if (next.ready && s.recipe) {
      text('route', `${s.recipe.name} · (${s.recipe.x}, ${s.recipe.y})`);
      text('route-detail', s.recipe.status === 'arrived' ? (s.recipe.expeditionComplete === true ? 'Weekly expedition complete.' : 'Route complete.') :
        `Step ${s.recipe.step} of ${s.recipe.total} · ${s.recipe.label}`);
    } else if (next.ready && navigating) {
      const global = s.target_map_id > 0;
      const destination = global ? `Map ${s.target_map_id} · (${s.global_target_x}, ${s.global_target_y})` : `Map ${s.map_id} · (${s.target_x}, ${s.target_y})`;
      text('route', destination);
      text('route-detail', route.length ? `${[s.map_id, ...route.slice(0, 7)].join(' → ')}${route.length > 7 ? ' → …' : ''} · ${s.route_length} map hops remaining` :
        s.active ? `${s.path_length || 0} walking steps remaining` : s.status === 'arrived' ? 'Route complete.' : 'Interaction needed at the target.');
    } else {
      text('route', 'Choose a destination to begin.');
      text('route-detail', 'Navbot walks using normal game controls.');
    }
    const launcher = document.getElementById('ynod-navbot-toggle');
    if (launcher) {
      launcher.dataset.active = s.active ? 'true' : 'false';
      launcher.title = s.active ? `Navbot · ${status[0]}` : 'Open Navbot';
      launcher.setAttribute('aria-expanded', String(open));
    }
    updateControls();
  }
  async function poll() {
    if (polling || stopped) return;
    polling = true;
    const requestEpoch = epoch;
    try {
      const next = await window.electronAPI.navbotState();
      if (!stopped && !commandPending && requestEpoch === epoch) render(next);
    } catch (error) {
      if (!stopped && !commandPending && requestEpoch === epoch) {
        text('status', 'Connection interrupted');
        text('status-detail', 'Retrying the connection to the game…');
        snapshot = { ...snapshot, ready: false };
        updateControls();
      }
    } finally {
      polling = false;
      if (!stopped) timer = setTimeout(poll, open ? 600 : 1800);
    }
  }
  function setOpen(value) {
    open = value;
    if (!open) closeSuggestions();
    $('panel').hidden = !open;
    const launcher = document.getElementById('ynod-navbot-toggle');
    launcher?.setAttribute('aria-expanded', String(open));
    if (open) {
      previousFocus = document.activeElement;
      $('close').focus();
      clearTimeout(timer);
      void poll();
    } else {
      const target = previousFocus?.isConnected ? previousFocus : launcher || document.getElementById('canvas');
      target?.focus();
    }
  }
  const toggle = () => setOpen(!open);
  window.addEventListener('ynod-navbot-toggle', toggle);
  $('close').addEventListener('click', () => setOpen(false));
  // Keep typing and navigation keys out of the page/game's shortcuts. Close on
  // keyup so the matching Escape release cannot reach the newly focused canvas.
  for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (type === 'keyup') { if (!dismissEscape) setOpen(false); dismissEscape = false; }
    }
  });
  $('map').addEventListener('input', () => {
    destinationEdited = true;
    ++selectionRequest; resolvingMap = false;
    mapSelection = null;
    $('map').setCustomValidity('Choose a map from the suggestions.');
    text('map-selection', 'Choose a map from the suggestions.');
    feedback(); updateControls(); showSuggestions();
  });
  $('map').addEventListener('focus', showSuggestions);
  $('map').addEventListener('click', showSuggestions);
  $('map').addEventListener('blur', closeSuggestions);
  $('map').addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if ($('map-results').hidden) showSuggestions();
      if (suggestions.length) highlightSuggestion(event.key === 'ArrowDown' ? (activeSuggestion + 1) % suggestions.length : (activeSuggestion < 0 ? suggestions.length - 1 : (activeSuggestion - 1 + suggestions.length) % suggestions.length));
    } else if (event.key === 'Enter') {
      // Enter in the picker only selects; navigation always needs its own action.
      event.preventDefault();
      if (!$('map-results').hidden && activeSuggestion >= 0) { destinationEdited = true; selectMap(suggestions[activeSuggestion]); }
    } else if (event.key === 'Escape' && !$('map-results').hidden) {
      dismissEscape = true;
      closeSuggestions();
    }
  });
  $('map-retry').addEventListener('click', () => { if (snapshot.enabled && snapshot.game) void loadMapNames(snapshot.game); });
  $('mode').addEventListener('input', () => { ++selectionRequest; resolvingMap = false; if (!mapMode()) closeSuggestions(); });
  for (const id of ['mode', 'x', 'y']) $(id).addEventListener('input', () => { destinationEdited = true; feedback(); updateControls(); });
  $('current').addEventListener('click', () => {
    if (!mapScene()) return;
    destinationEdited = true;
    $('mode').value = 'local';
    const current = mapEntries.filter(entry => entry.mapId === snapshot.state.map_id);
    if (current.length === 1) selectMap(current[0]);
    else { ++selectionRequest; resolvingMap = false; mapSelection = null; $('map').value = ''; closeSuggestions(); }
    $('x').value = snapshot.state.player_x;
    $('y').value = snapshot.state.player_y;
    feedback(); updateControls();
  });
  $('nexus').addEventListener('click', () => {
    if (snapshot.game !== '2kki') return;
    destinationEdited = true;
    $('mode').value = 'map'; selectMap(mapEntries.find(entry => entry.mapId === 10 && entry.name === 'Nexus') || { mapId: 10, name: 'Nexus' }); $('x').value = 3; $('y').value = 4;
    feedback(); updateControls();
  });
  $('planetarium').addEventListener('click', () => {
    if (snapshot.game !== '2kki') return;
    destinationEdited = true;
    $('mode').value = 'map'; selectMap({ mapId: 568, name: 'Planetarium' }); $('x').value = 3; $('y').value = 75;
    feedback(); updateControls();
  });
  async function command(payload) {
    const requestEpoch = ++epoch;
    const starting = payload.op !== 'stop';
    commandPending = true;
    busy = starting;
    feedback(); updateControls();
    try {
      const next = await window.electronAPI.navbotCommand(payload);
      if (!stopped && requestEpoch === epoch) render(next);
    } catch (error) {
      if (!stopped && requestEpoch === epoch) feedback(error.message || 'Navbot could not complete the command.');
    } finally {
      if (!stopped && requestEpoch === epoch) {
        ++epoch; // Ignore status reads begun before this command finished.
        commandPending = false; busy = false; updateControls();
      }
    }
  }
  $('form').addEventListener('submit', event => {
    event.preventDefault();
    if ($('start').disabled) return;
    updateControls();
    if (!$('form').checkValidity()) { feedback('Enter whole numbers within the map and coordinate limits.'); $('form').reportValidity(); return; }
    const payload = { op: mapMode() ? 'goto-map' : 'goto', x: Number($('x').value), y: Number($('y').value) };
    if (mapMode()) payload.map = mapSelection.mapId;
    void command(payload);
  });
  $('stop').addEventListener('click', () => { if (snapshot.enabled) void command({ op: 'stop' }); });
  window.addEventListener('pagehide', () => {
    stopped = true; clearTimeout(timer); window.removeEventListener('ynod-navbot-toggle', toggle);
  }, { once: true });
  void poll();
}

module.exports = function installNavbotPanel(win) {
  return win.webContents.executeJavaScript(`(${mountNavbotPanel.toString()})()`).catch(error => {
    console.error('[Navbot UI] Could not install panel:', error.message);
  });
};
module.exports.mount = mountNavbotPanel;
