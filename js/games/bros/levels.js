// Meridian Bros — the worlds. Data only: tile maps, palettes, and the parser
// that turns a map into something rules.js can collide against.
//
// ---- The map format ----
//
// Each world is 17 rows of tiles, TILE world-units square. 17 because the
// canvas is 960x544 and 544/32 is exactly 17 — the camera only ever scrolls
// sideways, so a level is as tall as the screen and as wide as it likes.
//
//   #  solid ground (drawn themed: grass top, cave rock, snow, castle stone)
//   B  brick (solid)
//   ?  coin block — bump it from below for a coin; goes dead after one use
//   |  pillar (solid; a step to climb on)
//   =  one-way platform: land from above, jump through from below, S drops through
//   ^  spikes (touch = death)
//   ~  lava (touch = death; lives at the bottom of pits in the hotter worlds)
//   o  coin
//   E  walker enemy — stomp it
//   X  spiker enemy — do NOT stomp it
//   C  checkpoint pennant (per player: touch it and you respawn there)
//   S  where players start
//   F  the goal flag
//   .  air
//
// Rows are built by concatenation with the run-length helpers below rather
// than typed as 150-character art strings — every row's segments must sum to
// the level width, and `_(23)` is checkable arithmetic where 23 hand-counted
// dots are not. The parser still pads ragged rows, so an edit that drops a
// character shifts one feature, not the whole world.
//
// ---- Designing within the physics ----
//
// Jump apexes (see rules.js characters): the shortest jumper clears a rise of
// 3 tiles with a few pixels to spare, so nothing on the *required* path ever
// rises more than 3 in one jump — staircases go up in 1s and 2s, and row-11
// blocks are head-bumpable from the ground but not standable. The widest
// required gap is 4 tiles, which every character clears at a run. Anything
// juicier (the row-10 platforms, coin arcs) is optional and reached by hops
// from mid-level platforms.

export const TILE = 32;

/** Rows per world — the canvas is exactly this many tiles tall. */
export const ROWS = 17;

const _ = (n) => '.'.repeat(n);   // air
const g = (n) => '#'.repeat(n);   // ground

export const WORLDS = [
  {
    id: 'meadow',
    name: 'Meadow March',
    sub: 'Rolling grass, gentle gaps. Learn the ropes.',
    ice: false,
    palette: {
      sky: ['#5fb8f2', '#c9ecff'],
      hillFar: '#a9dfb2', hillNear: '#6cc281',
      groundTop: '#43b55e', ground: '#8a5a33', groundDark: '#6f4527',
      brick: '#c96e4a', brickDark: '#9c4f33',
      block: '#ffb224', blockDead: '#8f7a52',
      pillar: '#2fa7b0', pillarDark: '#1f7c84',
      platform: '#b07b3f',
      spike: '#9aa7b8',
      lava: null, lavaGlow: null,
      flag: '#e5484d',
    },
    map: [
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(53) + 'ooo' + _(94),
      _(52) + '=====' + _(93),
      _(22) + '?.?' + _(11) + 'BBB' + _(10) + 'o' + _(16) + '?' + _(30) + 'oo' + _(14) + '?.?' + _(6) + 'ooo' + _(25),
      _(12) + 'ooo' + _(33) + '===' + _(32) + 'oooo' + _(9) + g(4) + _(20) + '=======' + _(23),
      _(94) + g(8) + _(34) + '|' + _(13),
      _(2) + 'S' + _(13) + 'E' + _(23) + 'E' + _(14) + 'E' + _(14) + 'E' + _(3) + 'E' + _(2) + 'C' + _(14) + g(12) + _(8) + 'E' + _(3) + 'E' + _(16) + '|' + _(2) + '|' + _(7) + 'F' + _(5),
      g(31) + _(3) + g(27) + _(3) + g(20) + _(2) + g(36) + _(3) + g(25),
      g(31) + _(3) + g(27) + _(3) + g(20) + _(2) + g(36) + _(3) + g(25),
    ],
  },

  {
    id: 'cavern',
    name: 'Cavern Crawl',
    sub: 'Dark rock, lava pits, spikes. Watch your feet.',
    ice: false,
    palette: {
      sky: ['#10141f', '#232c42'],
      hillFar: '#1b2438', hillNear: '#2a3550',
      groundTop: '#7c8fbd', ground: '#39415e', groundDark: '#2b3149',
      brick: '#5a4a6e', brickDark: '#443853',
      block: '#ffb224', blockDead: '#6b6047',
      pillar: '#4f5f85', pillarDark: '#3c4a68',
      platform: '#66759c',
      spike: '#c3cede',
      lava: '#ff6b35', lavaGlow: '#ffd23e',
      flag: '#4a9eff',
    },
    map: [
      g(150),
      _(10) + g(3) + _(12) + g(3) + _(12) + g(2) + _(23) + g(3) + _(27) + g(3) + _(32) + g(3) + _(17),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(56) + 'ooo' + _(91),
      _(20) + '?' + _(27) + '?' + _(11) + 'BB?BB' + _(25) + 'ooo' + _(57),
      _(54) + '======' + _(29) + '=====' + _(56),
      _(137) + '|' + _(12),
      _(2) + 'S' + _(9) + 'E' + _(24) + 'E' + _(6) + '^^^' + _(3) + 'X' + _(19) + 'E' + _(4) + 'C' + _(2) + '^^^' + _(3) + 'X' + _(15) + 'E' + _(4) + '^^^' + _(5) + 'X' + _(12) + 'X' + _(7) + '|' + _(2) + '|' + _(5) + 'F' + _(6),
      g(30) + _(3) + g(22) + _(4) + g(31) + _(3) + g(25) + _(3) + g(29),
      g(30) + '~~~' + g(22) + '~~~~' + g(31) + '~~~' + g(25) + '~~~' + g(29),
    ],
  },

  {
    id: 'frost',
    name: 'Frostpeak',
    sub: 'Ice underfoot — braking is a suggestion.',
    ice: true,
    palette: {
      sky: ['#7fb2e6', '#e8f4fd'],
      hillFar: '#c6dcf1', hillNear: '#9fc2e4',
      groundTop: '#f4fafe', ground: '#8fa5c8', groundDark: '#7288ad',
      brick: '#a8c8e8', brickDark: '#7fa5cb',
      block: '#ffb224', blockDead: '#8d94a6',
      pillar: '#6d87ad', pillarDark: '#566c8c',
      platform: '#c8dff2',
      spike: '#5d7699',
      lava: null, lavaGlow: null,
      flag: '#30a46c',
    },
    map: [
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(15) + '?' + _(19) + 'BBB' + _(12) + 'oooo' + _(41) + '?' + _(15) + 'oooo' + _(35),
      _(25) + 'ooo' + _(8) + 'o' + _(12) + '======' + _(23) + '=======' + _(23) + '========' + _(34),
      _(135) + '|' + _(14),
      _(2) + 'S' + _(17) + 'E' + _(23) + 'X' + _(23) + 'E' + _(5) + 'C' + _(15) + 'X' + _(12) + 'E' + _(18) + 'X' + _(9) + '|' + _(2) + '|' + _(6) + 'F' + _(7),
      g(25) + _(3) + g(22) + _(4) + g(26) + _(3) + g(27) + _(4) + g(36),
      g(25) + _(3) + g(22) + _(4) + g(26) + _(3) + g(27) + _(4) + g(36),
    ],
  },

  {
    id: 'citadel',
    name: 'Sunset Citadel',
    sub: 'Battlements over a lava moat. The long march.',
    ice: false,
    palette: {
      sky: ['#2c1a45', '#ff9d5c'],
      hillFar: '#241536', hillNear: '#3b2450',
      groundTop: '#a06a72', ground: '#6e4149', groundDark: '#57333a',
      brick: '#8a4f58', brickDark: '#6b3b43',
      block: '#ffb224', blockDead: '#75604e',
      pillar: '#5a3d63', pillarDark: '#452e4c',
      platform: '#a97b4f',
      spike: '#cbb6c4',
      lava: '#ff5c2e', lavaGlow: '#ffcf3e',
      flag: '#ffb224',
    },
    map: [
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(150),
      _(12) + '?' + _(28) + '?' + _(6) + 'oo' + _(28) + 'B?B' + _(15) + 'oo' + _(52),
      _(23) + 'o' + _(22) + '======' + _(21) + 'o' + _(20) + '======' + _(26) + 'o' + _(11) + g(4) + _(8),
      _(30) + 'BB' + _(28) + 'BB' + _(26) + 'BB' + _(28) + 'BB' + _(16) + g(6) + _(8),
      _(2) + 'S' + _(14) + 'E' + _(12) + 'BB' + _(3) + 'X' + _(19) + 'E' + _(4) + 'BB' + _(3) + 'X' + _(2) + 'C' + _(13) + 'E' + _(5) + 'BB' + _(2) + 'X' + _(12) + 'E' + _(6) + 'X' + _(5) + 'BB' + _(2) + 'E' + _(9) + 'X' + _(1) + g(8) + _(4) + 'F' + _(3),
      g(22) + _(3) + g(22) + _(4) + g(21) + _(3) + g(20) + _(4) + g(26) + _(3) + g(22),
      g(22) + '~~~' + g(22) + '~~~~' + g(21) + '~~~' + g(20) + '~~~~' + g(26) + '~~~' + g(22),
    ],
  },
];

export const WORLD_BY_ID = new Map(WORLDS.map((w) => [w.id, w]));

/* ---- tile queries ----
   Outside the level: the left and right edges are walls, the sky above is
   open (jumping over the top of the screen is allowed, as it always was), and
   below is the pit. */

const SOLID = new Set(['#', 'B', '?', '|']);

export function tileAt(lv, tx, ty) {
  if (tx < 0 || tx >= lv.w) return '#';
  if (ty < 0 || ty >= lv.h) return '.';
  return lv.grid[ty][tx];
}

export const solidAt = (lv, tx, ty) => SOLID.has(tileAt(lv, tx, ty));
export const oneWayAt = (lv, tx, ty) => tileAt(lv, tx, ty) === '=';
export const hazardAt = (lv, tx, ty) => {
  const ch = tileAt(lv, tx, ty);
  return ch === '^' || ch === '~';
};

/**
 * Turn a world into a level: a static tile grid for collision and drawing,
 * with the dynamic things (coins, enemies, spawn, checkpoints, flag) lifted
 * out into lists and their cells blanked.
 *
 * The grid never changes after this — a used coin block stays solid, only its
 * face changes, and who-collected-what lives in the room state, not here. That
 * is what lets every machine parse its own copy and trust it forever.
 */
export function parseWorld(world) {
  const w = Math.max(...world.map.map((r) => r.length));
  const grid = world.map.map((r) => [...r.padEnd(w, '.')]);
  const h = grid.length;

  const lv = {
    world, w, h,
    grid: null,
    spawn: { x: TILE * 2, y: TILE * 3 },
    flag: { x: (w - 2) * TILE, y: 0, tx: w - 2, ty: h - 3 },
    checkpoints: [],
    coins: [],
    enemies: [],
  };

  const centre = (tx, ty) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });

  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const ch = grid[ty][tx];
      if (ch === '.' || ch === ' ') { grid[ty][tx] = '.'; continue; }
      if (ch === 'S') { lv.spawn = centre(tx, ty); grid[ty][tx] = '.'; }
      else if (ch === 'F') { lv.flag = { ...centre(tx, ty), tx, ty }; grid[ty][tx] = '.'; }
      else if (ch === 'C') { lv.checkpoints.push(centre(tx, ty)); grid[ty][tx] = '.'; }
      else if (ch === 'o') { lv.coins.push(centre(tx, ty)); grid[ty][tx] = '.'; }
      else if (ch === 'E') { lv.enemies.push({ type: 'walker', ...centre(tx, ty) }); grid[ty][tx] = '.'; }
      else if (ch === 'X') { lv.enemies.push({ type: 'spiker', ...centre(tx, ty) }); grid[ty][tx] = '.'; }
    }
  }

  lv.grid = grid.map((row) => row.join(''));
  return lv;
}
