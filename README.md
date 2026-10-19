
![ynodesk](https://user-images.githubusercontent.com/2998216/201456135-270da105-a4fa-4976-a69a-3a69e5d3fe59.png)

A desktop client for [Yume Nikki Online](https://ynoproject.net/) with optional Discord Rich Presence. Show your friends what game you're playing and what room you're in.

[![Build and Release](https://github.com/aguish/ynodesktop/actions/workflows/release.yml/badge.svg)](https://github.com/aguish/ynodesktop/actions/workflows/release.yml)

## Download

[**→ Latest release**](https://github.com/aguish/ynodesktop/releases/latest)

| Platform | File |
|----------|------|
| Windows | `YNOdesktop-*-win-*.exe` — portable, no install needed |
| macOS (Intel) | `YNOdesktop-*-mac-x64.dmg` |
| macOS (Apple Silicon) | `YNOdesktop-*-mac-arm64.dmg` |
| Linux | `YNOdesktop-*-linux-*.AppImage` |

### macOS note

macOS will block the app on first launch because it is not notarized. To allow it:

```sh
xattr -cr /Applications/YNOdesktop.app
```

Or right-click the app → Open → Open.

### Linux note

Make the AppImage executable before running:

```sh
chmod +x YNOdesktop-*.AppImage
./YNOdesktop-*.AppImage
```

## Discord Rich Presence

![Rich Presence Example 1](https://user-images.githubusercontent.com/2998216/201456282-6337d763-db5c-4fc2-b399-00b3513b1f7b.png)

![Rich Presence Example 2](https://user-images.githubusercontent.com/2998216/201456297-8cb36ebb-6400-4ae8-9804-ce51bcf3c1b5.png)

Click the Discord icon in the title bar to toggle Rich Presence on or off at any time.

## Navbot panel

Click **Navbot** in the title bar to open the navigation panel. In a Navbot session you can:

- Travel to another map (the default): search for a destination by map name and enter its coordinates. Choose **Walk within this map** for a tile in the current map.
- Choose autocomplete results with the mouse or ↑/↓ and Enter. Names shared by several maps show their map numbers so you can choose the intended one. Enter selects a name; it does not start navigation.
- Fill the current position, or click **Current expedition** to fill the first unfinished expedition of the loaded game: the map with the shortest known route and the tile where that route enters it. Then click **Start navigation**.
- See the current map, position, route, and reasons navigation is waiting.
- Click **Stop** at any time, including while a command is pending. This also stops navigation started from the CLI.

Coordinates start at zero. Editing a selected name clears its selection until you choose another result. Expedition records name locations, not maps: Navbot looks the name up in the bundled names, the page's location cache and, for 2kki, the Explorer, and never uses an expedition record ID as a map. After arriving in that map, the panel reports **Expedition complete** once the server marks it complete. Other-map navigation requires that game's map graph; routes can still depend on in-game events and conditions. Closing the panel leaves navigation running, with an indicator in the title bar.

Map names are bundled from `ynolocations` for each game. For 2kki, the panel also searches names already loaded by the game page and looks up unknown map mappings when selected. Those lookups need a working connection; failed lookups cannot start navigation. A name may identify a region or depend on the entrance, so selecting it does not choose a walkable tile for you. Regenerate the bundled names after updating the location configs with `npm run build:navbot-maps`.

From the project root run `./test_navbot.sh 2kki`. Navbot now uses the **official
engine by default**. `npm run navbot -- boot` can continue the newest save or start
a new game from the title screen; in-game menus such as the 2kki computer still
need deliberate input. Normal `npm start` sessions show setup instructions in the
panel; the Navbot control interface remains opt-in. Navbot sessions use a separate
profile with its own local saves and settings.

### Navbot engine modes

| Behavior | Official engine (default) | Custom local engine (`--engine local`) |
| --- | --- | --- |
| Engine and build | Uses the server's engine; builds the liblcf map parser when needed | Builds the modified engine incrementally in `ynoengine/build-debug/` |
| Official-server multiplayer | Normal engine networking; movement delivery and map changes verified without forced reconnects | Current builds lack packet-signing configuration; the map-change reconnect workaround does not fix outgoing movement or visibility |
| Available state | Scene, movement, event, message, menu, inventory, switch and room state read from the engine's memory without modifying it; checked against `getPlayerCoords()` and C++ class information. Falls back to coordinates and teleport callbacks if those checks fail | Detailed scene, movement, event and inventory state from Navbot exports |
| Navigation | Live collision (chipset, tile substitutions, events and vehicles) and active event pages; pauses for menus, messages and events; `goto-map` replans after unexpected maps or unreachable exits; reviewed intermediate maps, same-map transfers and position-completed moves; reviewed effect-gated exits when the save owns the effect | Runtime collision data; graph/event limitations still apply; no effect-gated exits |
| Boot, Bike and Planetarium | `boot` from the title screen and automatic Bike preparation, repeated during multi-map routes (for example after leaving the waking world) and before effect-gated exits; the checked Planetarium recipe runs but has not yet completed end to end in official mode. Real keyboard input on the game canvas cancels them, except while the game shows a menu, message or event | Same, for the checked 2kki routes and preconditions, but Bike preparation only when a command starts; recipe verified end to end |
| Input timing | Logical engine frames, pressed only after a scene update; overshoots when one callback runs several frames. Nominal 60 Hz durations without engine state | Logical engine-frame holds |

Use `./test_navbot.sh 2kki --engine local` for custom engine development, or add
`--skip-build` to reuse that engine build. `--official` remains an explicit alias
for the default. Direct `npm run navbot -- launch` also defaults to official;
use `npm run navbot -- launch --engine local` to select local artifacts.

Both Navbot modes currently require the developer checkout, a game-specific
graph and a graphical display. Official mode also needs the generated liblcf
parser; the launch helper builds it with the bundled Emscripten toolchain. It
does not yet ship as a feature of the packaged release. See
[Navbot debugging](../NAVBOT_DEBUGGING.md) for setup, limits and live test evidence.

Run `npm run test:navbot` for controller/graph checks and `npm run test:navbot-ui` for the offline Electron panel checks. The latter requires a graphical display; `NAVBOT_PANEL_SCREENSHOTS=/tmp/navbot-panel-ui npm run test:navbot-ui` also saves layout screenshots.

## Development Setup

For engine development and Navbot control, see [NAVBOT_DEBUGGING.md](../NAVBOT_DEBUGGING.md). Start a persistent official-engine 2kki session with `../test_navbot.sh 2kki`; control it with `npm run navbot -- state`, `capture`, `stop`, or `run --map ID --x X --y Y`. Add `--engine local` to the launch helper for custom engine development.

Requires [Node.js](https://nodejs.org/) 22.12.0 or newer. From this workspace's root:

```sh
cd ynodesktop
npm ci
npm start
```

The normal install downloads Electron and needs network access. Launching the
desktop client requires a graphical display. [Yarn](https://yarnpkg.com/) remains
supported: use `yarn install --frozen-lockfile` and `yarn start` instead.

The Navbot checks require the complete workspace layout: `ynolocations/` and
`tools/` must be siblings of `ynodesktop/`. After installing dependencies, run
`npm run test:navbot` inside `ynodesktop/`; the checks use local fixtures and
do not launch Electron or contact the game server. For a checkout used only for
these checks, `npm ci --ignore-scripts` skips Electron and native installation
scripts. Run a normal `npm ci` before launching the desktop client or UI checks.

## Building

Build for the current platform:

```sh
yarn dist
```

Or target a specific platform:

```sh
yarn dist-win      # Windows portable .exe
yarn dist-linux    # Linux AppImage
yarn dist-mac      # macOS dmg + zip (x64 and arm64)
```

Output files are placed in the `dist/` directory. Developer tools, scratch data,
and `.navbot/` profiles and captures are excluded from release packages.

Releases are built automatically by GitHub Actions when a version tag is pushed:

```sh
git tag v1.2.7
git push origin v1.2.7
```

## Project Structure

```
src/
  main.js                    # App entry point
  createApp.js               # Window, IPC, session, context menu
  preload.js                 # contextBridge API surface for the renderer
  scripts/
    discordRpcUtils.js       # Discord Rich Presence logic
    titlebar.js              # Injected custom title bar
    promptinjection.js       # Save slot dialog (replaces window.prompt)
    utils.js                 # URL parsing helpers
assets/
  logo.png / logo.ico        # App icons
.github/workflows/
  release.yml                # CI: build and publish releases
```

## YNOproject

Check out the [Yume Nikki Online Project](https://github.com/ynoproject)!
