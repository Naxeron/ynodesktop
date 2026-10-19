'use strict';

// Effects Navbot can read and equip through the ordinary item menu, from the
// game's RPG_RT.ldb (2kki database sha256 d12927da8b70bddb...). Each effect is a
// switch item: using it turns on a request switch whose autostart common event
// first clears every active effect switch (common event 99, switches 121..200),
// then turns on the effect's own active switch. Using an active effect removes
// it. While awake, common event 16 swaps each owned item for a dummy item
// (ID + 41) that cannot be used; common event 17 swaps them back in dreams.
const tables = Object.freeze({
  '2kki': Object.freeze({
    effects: Object.freeze([
      Object.freeze({ item: 12, name: 'Bike', active: 132, dummy: 53 }),
      Object.freeze({ item: 27, name: 'Spring', active: 137, dummy: 68 }),
      Object.freeze({ item: 36, name: 'Red Riding Hood', active: 148, dummy: 77 }),
      Object.freeze({ item: 38, name: 'Bat', active: 150, dummy: 79 }),
      Object.freeze({ item: 45, name: 'Bunny Ears', active: 157, dummy: 86 }),
    ]),
    // Ladder (14) and effect actions prohibited (39, as the game's own effect
    // change checks) leave the Bike alone; 4103 is the boat.
    bike: Object.freeze({ item: 12, blocked: Object.freeze([14, 39, 4103]) }),
  }),
});

function effectTable(game) {
  return tables[game] || null;
}

function effectNames(game, items) {
  const table = effectTable(game);
  return items.map(item => table?.effects.find(effect => effect.item === item)?.name || `effect ${item}`);
}

module.exports = { effectTable, effectNames };
