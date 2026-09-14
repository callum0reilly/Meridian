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
//   @  power block — bump it and a heart shard pops out on top (one extra hit)
//   |  pillar (solid; a step to climb on)
//   =  one-way platform: land from above, jump through from below, S drops through
//   !  spring pad (solid; land on it and it launches you ~7 tiles up)
//   ^  spikes (touch = lose your shard, or die without one)
//   ~  lava (touch = death; lives at the bottom of pits in the hotter worlds)
//   o  coin
//   G  gem — three per world, tucked off the required path
//   Z  speed surge pickup (timed)    W  spike ward pickup (timed)
//   N  coin magnet pickup (timed)
//   $  breakable brick — bump once to crack it, again to smash it to air
//   D  door (solid until the team finds a key, or fells a boss)
//   K  key — any one player picking it up opens every door in the world
//   w  water: sink slowly, tap jump to swim, a full jump at the surface
//   L  l  laser beam tiles: deadly for part of a cycle, harmless the rest;
//         L and l run on opposite phases so a pair makes a rhythm
//   u  updraft (air that lifts you; columns of it over a pit are the lift)
//   M  moving platform, patrolling sideways along the '-' rail on its row
//   V  moving platform, patrolling up and down the ':' rail in its column
//   -  :  rails (air — they only say where a mover goes)
//   E  walker enemy — stomp it
//   X  spiker enemy — do NOT stomp it
//   Y  flyer — bobs back and forth in the air; stompable from above
//   J  hopper — a walker that jumps on a beat; stompable
//   Q  the boss — three stomps, stunned between them; felling it unlocks doors
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
// Later additions to a world go through `edit(map, put => ...)` with (x, y)
// coordinates rather than re-counting the row strings — a gem at (54, 6) is
// easier to check against the row it sits above than a `_(53) + 'G'` is.
//
// ---- Designing within the physics ----
//
// Jump apexes (see rules.js characters): the shortest jumper clears a rise of
// 3 tiles with a few pixels to spare, so nothing on the *required* path ever
// rises more than 3 in one jump — staircases go up in 1s and 2s. ?- and
// @-blocks sit exactly 3 tiles above whatever you jump from (row 12 over
// row-15 ground), so everyone can bump them from below *and* hop up on top —
// which is where an @-block's heart shard pops out. The widest required gap
// is 4 tiles, which every character clears at a run. Anything juicier (the
// row-10 platforms, coin arcs, gems) is optional and reached by hops from
// mid-level platforms — but reachable by every character, not just Gil.
//
// test/bros-reach.mjs checks all of that against the real physics: it
// searches every world for each character and lists anything they can't
// collect, bump or stand on. Run it after editing a world.

export const TILE = 32;

/** Rows per world — the canvas is exactly this many tiles tall. */
export const ROWS = 17;

const _ = (n) => '.'.repeat(n);   // air
const g = (n) => '#'.repeat(n);   // ground

/** Overlay features on a finished map by coordinate: put(x, y, 'G') writes a
 *  string rightwards from column x of row y; rect fills a box inclusive. */
function edit(map, fn) {
  const rows = map.map((r) => [...r]);
  const put = (x, y, s) => { for (let i = 0; i < s.length; i++) rows[y][x + i] = s[i]; };
  const rect = (x0, y0, x1, y1, ch) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) rows[y][x] = ch; };
  fn(put, rect);
  return rows.map((r) => r.join(''));
}

/** A world drawn from scratch by coordinate, on an empty sky. */
const build = (w, fn) => edit(Array.from({ length: ROWS }, () => _(w)), fn);

export const WORLDS = [
  {
    id: 'meadow',
    name: 'Meadow March',
    sub: 'Rolling grass, gentle gaps. Learn the ropes.',
    ice: false,
    lives: 5,
    par: 75,
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
    map: edit([
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
      _(36) + 'BBB' + _(10) + 'o' + _(47) + 'oo' + _(14) + '?.?' + _(6) + 'ooo' + _(25),
      _(12) + 'ooo' + _(7) + '?.?' + _(23) + '===' + _(15) + '?' + _(16) + 'oooo' + _(9) + g(4) + _(20) + '=======' + _(23),
      _(94) + g(8) + _(34) + '|' + _(13),
      _(2) + 'S' + _(13) + 'E' + _(23) + 'E' + _(14) + 'E' + _(14) + 'E' + _(3) + 'E' + _(2) + 'C' + _(14) + g(12) + _(8) + 'E' + _(3) + 'E' + _(16) + '|' + _(2) + '|' + _(7) + 'F' + _(5),
      g(31) + _(3) + g(27) + _(3) + g(20) + _(2) + g(36) + _(3) + g(25),
      g(31) + _(3) + g(27) + _(3) + g(20) + _(2) + g(36) + _(3) + g(25),
    ], (put) => {
      put(8, 15, '!');  put(8, 8, 'G');       // the first spring, and what it's for
      put(54, 6, 'G');                        // over the high platform
      put(98, 8, 'G');                        // over the hill
      put(30, 12, '@');
      put(44, 13, 'Z');
      put(120, 13, 'N');
    }),
  },

  {
    id: 'cavern',
    name: 'Cavern Crawl',
    sub: 'Dark rock, lava pits, spikes. Watch your feet.',
    ice: false,
    lives: 5,
    par: 80,
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
    map: edit([
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
      _(20) + '?' + _(39) + 'BB?BB' + _(25) + 'ooo' + _(57),
      _(54) + '======' + _(29) + '=====' + _(56),
      _(137) + '|' + _(12),
      _(2) + 'S' + _(9) + 'E' + _(24) + 'E' + _(6) + '^^^' + _(3) + 'X' + _(19) + 'E' + _(4) + 'C' + _(2) + '^^^' + _(3) + 'X' + _(15) + 'E' + _(4) + '^^^' + _(5) + 'X' + _(12) + 'X' + _(7) + '|' + _(2) + '|' + _(5) + 'F' + _(6),
      g(30) + _(3) + g(22) + _(4) + g(31) + _(3) + g(25) + _(3) + g(29),
      g(30) + '~~~' + g(22) + '~~~~' + g(31) + '~~~' + g(25) + '~~~' + g(29),
    ], (put) => {
      put(25, 15, '!'); put(25, 7, 'G');
      put(57, 7, 'G');
      put(91, 8, 'G');
      put(48, 12, '@');
      put(66, 13, 'W');                       // right before the spike run
      put(98, 13, 'Z');
    }),
  },

  {
    id: 'frost',
    name: 'Frostpeak',
    sub: 'Ice underfoot — braking is a suggestion.',
    ice: true,
    lives: 5,
    par: 80,
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
    map: edit([
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
      _(35) + 'BBB' + _(12) + 'oooo' + _(57) + 'oooo' + _(35),
      _(15) + '?' + _(9) + 'ooo' + _(8) + 'o' + _(12) + '======' + _(23) + '=======' + _(23) + '========' + _(34),
      _(135) + '|' + _(14),
      _(2) + 'S' + _(17) + 'E' + _(23) + 'X' + _(23) + 'E' + _(5) + 'C' + _(15) + 'X' + _(12) + 'E' + _(18) + 'X' + _(9) + '|' + _(2) + '|' + _(6) + 'F' + _(7),
      g(25) + _(3) + g(22) + _(4) + g(26) + _(3) + g(27) + _(4) + g(36),
      g(25) + _(3) + g(22) + _(4) + g(26) + _(3) + g(27) + _(4) + g(36),
    ], (put) => {
      put(52, 8, 'G');
      put(81, 8, 'G');
      put(128, 15, '!'); put(128, 8, 'G');
      put(95, 12, '@');
      put(10, 13, 'Z');
      put(40, 13, 'N');
    }),
  },

  {
    id: 'citadel',
    name: 'Sunset Citadel',
    sub: 'Battlements over a lava moat. The long march.',
    ice: false,
    lives: 5,
    par: 90,
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
    map: edit([
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
      _(41) + '?' + _(6) + 'oo' + _(46) + 'oo' + _(52),
      _(12) + '?' + _(10) + 'o' + _(22) + '======' + _(21) + 'o' + _(4) + 'B?B' + _(13) + '======' + _(26) + 'o' + _(11) + g(4) + _(8),
      _(30) + 'BB' + _(28) + 'BB' + _(26) + 'BB' + _(28) + 'BB' + _(16) + g(6) + _(8),
      _(2) + 'S' + _(14) + 'E' + _(12) + 'BB' + _(3) + 'X' + _(19) + 'E' + _(4) + 'BB' + _(3) + 'X' + _(2) + 'C' + _(13) + 'E' + _(5) + 'BB' + _(2) + 'X' + _(12) + 'E' + _(6) + 'X' + _(5) + 'BB' + _(2) + 'E' + _(9) + 'X' + _(1) + g(8) + _(4) + 'F' + _(3),
      g(22) + _(3) + g(22) + _(4) + g(21) + _(3) + g(20) + _(4) + g(26) + _(3) + g(22),
      g(22) + '~~~' + g(22) + '~~~~' + g(21) + '~~~' + g(20) + '~~~~' + g(26) + '~~~' + g(22),
    ], (put) => {
      put(48, 8, 'G');
      put(96, 8, 'G');
      put(140, 8, 'G');
      put(41, 11, '@');
      put(27, 13, 'W');
      put(100, 13, 'Z');
    }),
  },

  {
    id: 'isles',
    name: 'Windswept Isles',
    sub: 'Floating islands, gusting wind. Ride the updrafts.',
    ice: false,
    wind: 0.035,       // gust strength; the direction swings with the clock
    lives: 5,
    par: 100,
    palette: {
      sky: ['#3f7fc9', '#d9efff'],
      hillFar: '#9dc7ee', hillNear: '#c6e2f7',
      groundTop: '#5ccc7a', ground: '#7a6a5a', groundDark: '#5d5044',
      brick: '#b9a58f', brickDark: '#8c7b68',
      block: '#ffb224', blockDead: '#8f7a52',
      pillar: '#6f8fb5', pillarDark: '#54708f',
      platform: '#c8b79e',
      spike: '#c9d3e0',
      lava: null, lavaGlow: null,
      flag: '#e5484d',
    },
    map: build(150, (put, rect) => {
      // Island A — the launch. Wide, flat, a taste of the wind.
      rect(0, 15, 18, 16, '#'); put(2, 14, 'S'); put(6, 13, 'ooo'); put(14, 13, 'oo');
      // Island B
      rect(22, 14, 34, 16, '#'); put(26, 12, 'oo'); put(29, 12, 'Z'); put(31, 13, 'E');
      // Island C, with a flyer to duck or stomp
      rect(38, 13, 46, 16, '#'); put(42, 10, 'Y'); put(40, 11, 'ooo');
      // The first updraft: a column of lift over open sky, a gem at its crown
      rect(47, 5, 49, 16, 'u'); put(49, 3, 'G');
      // Island D — a tall pillar with a spring on top
      rect(52, 9, 62, 16, '#'); put(54, 7, 'ooo'); put(57, 8, 'E'); put(60, 9, '!'); put(60, 2, 'G');
      // Island E — checkpoint, two walkers, a heart in the blocks
      rect(66, 11, 78, 16, '#'); put(72, 10, 'C'); put(69, 10, 'E'); put(75, 10, 'E'); put(70, 8, '?@?');
      // The mover: rides the rail from E to F over nothing at all
      put(80, 11, 'M'); put(81, 11, '------------');
      // Island F — flyer overhead, a spring to the second-highest gem
      rect(94, 11, 104, 16, '#'); put(99, 8, 'Y'); put(96, 8, '?'); put(97, 10, 'N'); put(103, 11, '!'); put(103, 4, 'G');
      // Island G — spikes and a walker on a low island
      rect(108, 13, 120, 16, '#'); put(112, 12, '^^'); put(116, 12, 'E'); put(110, 10, 'oo'); put(118, 10, 'oo');
      // The second updraft, up to the high island
      rect(121, 3, 123, 16, 'u');
      // Island H — high ground with a spiker
      rect(126, 8, 138, 16, '#'); put(129, 7, 'E'); put(132, 7, 'X'); put(128, 5, 'oooo');
      // Island I — the flag
      rect(142, 10, 149, 16, '#'); put(146, 9, 'F');
    }),
  },

  {
    id: 'ruins',
    name: 'Sunken Ruins',
    sub: 'A flooded temple. Tap jump to swim; find the key.',
    ice: false,
    creature: 'fish',   // what the flyers look like here
    lives: 5,
    par: 110,
    palette: {
      sky: ['#0d2b3a', '#1f6b7a'],
      hillFar: '#164452', hillNear: '#1d5866',
      groundTop: '#7fb8a2', ground: '#3d6b62', groundDark: '#2c4f48',
      brick: '#4f8577', brickDark: '#3a6358',
      block: '#ffb224', blockDead: '#6b6b52',
      pillar: '#8fb7ab', pillarDark: '#6d948a',
      platform: '#a9c9bd',
      spike: '#cfe4dc',
      lava: null, lavaGlow: null,
      water: 'rgba(52,152,219,0.45)', waterTop: 'rgba(200,240,255,0.7)',
      flag: '#ffb224',
    },
    map: build(150, (put, rect) => {
      // Bank A — dry stone, one walker
      rect(0, 12, 20, 16, '#'); put(2, 11, 'S'); put(8, 9, 'ooo'); put(14, 11, 'E');
      // Pool 1 — learn to swim; a gem on the bottom, spikes nearby, a fish
      rect(21, 16, 40, 16, '#'); rect(21, 13, 40, 15, 'w');
      put(30, 15, 'G'); put(25, 14, 'oo'); put(35, 14, 'oo'); put(33, 15, '^^'); put(28, 14, 'Y');
      // Bank B
      rect(41, 12, 60, 16, '#'); put(46, 11, 'E'); put(54, 11, 'E'); put(50, 9, '?'); put(44, 10, 'oo'); put(57, 10, 'N');
      // The shaft — a flooded tower you swim up; a doorway at the bottom, a wall to climb over at the top
      rect(61, 16, 75, 16, '#'); rect(61, 4, 75, 15, 'w'); rect(60, 3, 60, 10, '#'); rect(76, 5, 76, 16, '#');
      put(66, 10, '==='); put(63, 8, 'o'); put(63, 6, 'o'); put(70, 12, 'o'); put(70, 9, 'o');
      put(66, 13, 'Y'); put(71, 6, 'Y'); put(74, 15, 'G');
      // Bank C — high ground, checkpoint, a spiker
      rect(77, 9, 90, 16, '#'); put(80, 8, 'C'); put(86, 8, 'X'); put(83, 6, 'ooo');
      // Pool 2 — the key lies on the bottom between two pillars
      rect(91, 16, 110, 16, '#'); rect(91, 12, 110, 15, 'w'); rect(96, 14, 96, 15, '|'); rect(103, 13, 103, 15, '|');
      put(100, 15, 'K'); put(94, 13, 'oo'); put(106, 13, 'oo'); put(99, 13, 'Y');
      // Bank D — hopper, heart block, a climb to the third gem
      rect(111, 12, 127, 16, '#'); put(118, 11, 'J'); put(114, 8, '@'); put(116, 9, '==='); put(121, 7, '==='); put(122, 5, 'G'); put(124, 11, 'E');
      // The door, and the flag beyond it
      rect(128, 12, 149, 16, '#'); rect(128, 7, 128, 11, 'D'); put(135, 11, 'E'); put(140, 9, 'oo'); put(146, 11, 'F');
    }),
  },

  {
    id: 'sprawl',
    name: 'Neon Sprawl',
    sub: 'Rooftops at night. Lasers keep time; so should you.',
    ice: false,
    lives: 5,
    par: 120,
    palette: {
      sky: ['#0b0716', '#3a1d5c'],
      hillFar: '#1c1233', hillNear: '#2b1a48',
      groundTop: '#c563e6', ground: '#2e2542', groundDark: '#211a31',
      brick: '#4a3a66', brickDark: '#382b4f',
      block: '#ffb224', blockDead: '#5d5566',
      pillar: '#5f4e85', pillarDark: '#463a63',
      platform: '#8b7ab0',
      spike: '#e0d4f5',
      lava: null, lavaGlow: null,
      laser: '#ff3b6b', laserGlow: '#ff9ab5',
      flag: '#39c0d6',
    },
    map: build(150, (put, rect) => {
      // Rooftop A
      rect(0, 13, 16, 16, '#'); put(2, 12, 'S'); put(8, 10, 'ooo'); put(13, 12, 'E');
      // Rooftop B — a hopper, a vertical beam to time, platforms up to a gem
      rect(20, 11, 32, 16, '#'); put(26, 10, 'J'); rect(30, 6, 30, 10, 'L');
      put(22, 8, '==='); put(26, 6, '==='); put(27, 4, 'G'); put(23, 9, 'oo');
      // Rooftop C — a breakable ceiling with a gem stashed above it
      rect(36, 12, 50, 16, '#'); put(44, 9, '$$$$'); put(45, 8, 'G'); put(40, 11, 'E'); put(38, 9, 'oo'); put(49, 11, 'W');
      // The lift: a vertical mover up to the tall building
      rect(53, 5, 53, 11, ':'); put(53, 12, 'V');
      // Rooftop D — high, with a beam lying across the roof
      rect(56, 7, 66, 16, '#'); put(60, 6, 'llll'); put(58, 4, 'oo'); put(64, 4, 'oo');
      // Rooftop E — checkpoint, hopper, heart
      rect(70, 10, 84, 16, '#'); put(72, 9, 'C'); put(78, 9, 'J'); put(75, 7, '?@?'); put(82, 9, 'E');
      // The long mover through a beam
      put(86, 10, 'M'); put(87, 10, '--------------'); rect(93, 4, 93, 9, 'L');
      // Rooftop F — spiker, magnet, a spring to the sky gem
      rect(102, 10, 116, 16, '#'); put(108, 9, 'X'); put(104, 7, 'oo'); put(111, 9, 'N'); put(114, 10, '!'); put(114, 3, 'G');
      // Rooftop G — two beam gates on opposite beats
      rect(120, 12, 134, 16, '#'); rect(124, 10, 126, 11, 'L'); rect(129, 10, 131, 11, 'l'); put(121, 9, 'ooo'); put(133, 9, 'oo');
      // Rooftop H — the flag
      rect(138, 12, 149, 16, '#'); put(141, 11, 'E'); put(146, 11, 'F');
    }),
  },

  {
    id: 'reactor',
    name: 'The Reactor',
    sub: 'Everything at once, then the thing at the end.',
    ice: false,
    lives: 5,
    par: 150,
    boss: true,
    palette: {
      sky: ['#150808', '#4a1616'],
      hillFar: '#2a1212', hillNear: '#3a1818',
      groundTop: '#8a93a6', ground: '#3b3f4a', groundDark: '#2b2e36',
      brick: '#5a5f6e', brickDark: '#43474f',
      block: '#ffb224', blockDead: '#5d5566',
      pillar: '#6b7386', pillarDark: '#4f5666',
      platform: '#7c8698',
      spike: '#c9d3e6',
      lava: '#ff5c2e', lavaGlow: '#ffcf3e',
      laser: '#ff3b6b', laserGlow: '#ff9ab5',
      water: 'rgba(72,220,160,0.4)', waterTop: 'rgba(200,255,230,0.7)',
      flag: '#39c0d6',
    },
    map: build(150, (put, rect) => {
      // The loading bay
      rect(0, 13, 14, 16, '#'); put(2, 12, 'S'); put(6, 10, 'ooo');
      rect(15, 16, 17, 16, '~');
      rect(18, 13, 30, 16, '#'); put(24, 12, 'J'); put(27, 12, '^^'); put(21, 10, 'oo');
      // The vent: an updraft over lava, up to the catwalk
      rect(31, 3, 33, 15, 'u'); rect(31, 16, 33, 16, '~');
      rect(34, 6, 44, 16, '#'); put(38, 5, 'lll'); put(36, 3, 'oo'); put(42, 3, 'oo');
      // The coolant pool
      rect(45, 10, 47, 16, '#');
      rect(48, 16, 62, 16, '#'); rect(48, 11, 62, 15, 'w'); put(55, 13, 'Y'); put(56, 15, 'G'); put(51, 13, 'oo'); put(59, 13, 'oo');
      rect(63, 10, 66, 16, '#');
      // The gantry — checkpoint, walker, spiker, a heart, a ward for what's next
      rect(67, 12, 80, 16, '#'); put(69, 11, 'C'); put(74, 11, 'E'); put(78, 11, 'X'); put(72, 9, '?@?'); put(70, 10, 'W');
      // The mover over the lava, through a beam
      rect(81, 16, 96, 16, '~'); put(82, 11, 'M'); put(83, 11, '-------------'); rect(89, 5, 89, 10, 'L');
      // The last approach — hopper, flyer, a spring to the gem
      rect(97, 12, 110, 16, '#'); put(102, 11, 'J'); put(106, 7, 'Y'); put(108, 12, '!'); put(108, 5, 'G'); put(100, 9, 'oo');
      // A low wall the boss can't clear, and the arena
      rect(110, 10, 110, 11, '|');
      rect(111, 12, 138, 16, '#'); put(128, 11, 'Q'); put(118, 9, '?B?'); put(132, 9, '==='); put(136, 6, '==='); put(137, 4, 'G');
      put(114, 10, 'oo'); put(124, 10, 'oo');
      // The gate opens when the boss falls
      rect(139, 12, 149, 16, '#'); rect(139, 6, 139, 11, 'D'); put(146, 11, 'F');
    }),
  },
];

/* ---- hard variants ----
   The first four worlds again, meaner: three lives, spikers where walkers
   were, flyers over the pits, a few spikes where you used to be able to
   relax. Same layout, so what you learned still counts. */

function harder(base, name, fn) {
  return {
    ...base,
    id: base.id + '-hard',
    base: base.id,
    hard: true,
    name,
    sub: base.sub + ' Now with fewer excuses.',
    lives: 3,
    par: Math.round(base.par * 1.15),
    map: edit(base.map, fn),
  };
}

export const HARD_WORLDS = [
  harder(WORLDS[0], 'Meadow March ★', (put) => {
    put(40, 14, 'X'); put(74, 14, 'X'); put(116, 14, 'X');
    put(60, 10, 'Y'); put(105, 10, 'Y');
    put(97, 11, '^');
    put(83, 15, '....'); put(83, 16, '....');      // the small pit, not so small
  }),
  harder(WORLDS[1], 'Cavern Crawl ★', (put) => {
    put(12, 14, 'X');
    put(62, 14, '^^'); put(92, 14, '^^');
    put(30, 10, 'Y'); put(118, 9, 'Y');
  }),
  harder(WORLDS[2], 'Frostpeak ★', (put) => {
    put(20, 14, 'X');
    put(51, 9, 'Y'); put(111, 9, 'Y');
    put(57, 14, '^^'); put(85, 14, '^');
  }),
  harder(WORLDS[3], 'Sunset Citadel ★', (put) => {
    put(17, 14, 'X');
    put(48, 9, 'Y'); put(96, 9, 'Y');
    put(76, 14, '^^');
  }),
];

export const WORLD_BY_ID = new Map([...WORLDS, ...HARD_WORLDS].map((w) => [w.id, w]));

/* ---- custom worlds ----
   A level from the editor is a name, a theme (whose palette and feel it
   borrows) and its rows. Registering one gives every machine the same world
   object under the same id, which is all the run code needs. */

export function materialiseCustom(def) {
  const theme = WORLD_BY_ID.get(def.theme) || WORLDS[0];
  return {
    id: def.id,
    custom: true,
    name: def.name,
    sub: `A custom level, in the style of ${theme.name}.`,
    ice: !!def.ice,
    wind: def.wind ? theme.wind || 0.035 : 0,
    creature: theme.creature,
    lives: def.lives ?? 5,
    par: def.par ?? null,
    palette: theme.palette,
    map: def.map,
  };
}

export function registerCustom(def) {
  const world = materialiseCustom(def);
  WORLD_BY_ID.set(world.id, world);
  return world;
}

/** Every glyph a map may contain, for the editor and for checking codes. */
export const GLYPHS = '.#B?@|=!^~wuLl-:MVDK$oGZWNEXYJQCSF';

/* ---- tile queries ----
   Outside the level: the left and right edges are walls, the sky above is
   open (jumping over the top of the screen is allowed, as it always was), and
   below is the pit. */

const SOLID = new Set(['#', 'B', '?', '@', '|', '!', '$', 'D']);

export function tileAt(lv, tx, ty) {
  if (tx < 0 || tx >= lv.w) return '#';
  if (ty < 0 || ty >= lv.h) return '.';
  return lv.grid[ty][tx];
}

/** Solid, allowing for what the run has changed: smashed bricks are air,
 *  and doors are air once the world is unlocked. */
export function solidAt(lv, tx, ty) {
  const ch = tileAt(lv, tx, ty);
  if (!SOLID.has(ch)) return false;
  if (ch === '$') return !lv.broken.has(tx + ',' + ty);
  if (ch === 'D') return !lv.unlocked;
  return true;
}
export const oneWayAt = (lv, tx, ty) => tileAt(lv, tx, ty) === '=';
export const springAt = (lv, tx, ty) => tileAt(lv, tx, ty) === '!';
export const blockAt = (lv, tx, ty) => { const ch = tileAt(lv, tx, ty); return ch === '?' || ch === '@'; };
export const waterAt = (lv, tx, ty) => tileAt(lv, tx, ty) === 'w';
export const updraftAt = (lv, tx, ty) => tileAt(lv, tx, ty) === 'u';

/* Lasers keep time on the shared clock: on for LASER_ON of every
   LASER_PERIOD steps, with 'l' half a cycle behind 'L'. */
export const LASER_PERIOD = 240;
export const LASER_ON = 80;
export const LASER_WARN = 30;           // steps of flicker before it fires

/** Where in its cycle a beam is: 'on', 'warn', or 'off'. */
export function laserPhase(ch, step) {
  const t = ((step + (ch === 'l' ? LASER_PERIOD / 2 : 0)) % LASER_PERIOD + LASER_PERIOD) % LASER_PERIOD;
  if (t < LASER_ON) return 'on';
  if (t >= LASER_PERIOD - LASER_WARN) return 'warn';
  return 'off';
}

/** 'deadly' hazards always kill; 'sharp' ones cost a shard first. With no
 *  step given a laser counts as always on — that is how enemies see it. */
export const hazardAt = (lv, tx, ty, step) => {
  const ch = tileAt(lv, tx, ty);
  if (ch === '~') return 'deadly';
  if (ch === '^') return 'sharp';
  if (ch === 'L' || ch === 'l') return step === undefined || laserPhase(ch, step) === 'on' ? 'sharp' : null;
  return null;
};

export const PICKUPS = { Z: 'speed', W: 'ward', N: 'magnet' };
export const ENEMY_GLYPHS = { E: 'walker', X: 'spiker', Y: 'flyer', J: 'hopper', Q: 'boss' };

/* ---- the clock-driven scenery ----
   Movers and wind are pure functions of the shared step count, so every
   machine computes exactly the same platform position from the same number
   and nobody rides a platform that's 80ms behind the one they see. */

export const MOVER_W = TILE * 3;
export const MOVER_H = 10;
export const MOVER_SPEED = 1.25;      // px per step

/** Where a mover is at a given step: a triangle wave along its rail. */
export function moverPos(m, step) {
  const dist = Math.hypot(m.x1 - m.x0, m.y1 - m.y0);
  if (dist === 0) return { x: m.x0, y: m.y0 };
  const half = dist / MOVER_SPEED;
  const t = ((step % (half * 2)) + half * 2) % (half * 2);
  const k = t < half ? t / half : 2 - t / half;
  return { x: m.x0 + (m.x1 - m.x0) * k, y: m.y0 + (m.y1 - m.y0) * k };
}

/** Sideways push this step, from a world's gust strength: swings between
 *  blowing left and right over about ten seconds. */
export const windAt = (world, step) => (world.wind ? world.wind * Math.sin(step / 150) : 0);

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
    gems: [],
    pickups: [],       // { type, x, y, block } — block: the '@' this pops out of, else null
    enemies: [],
    movers: [],        // { x0, y0, x1, y1 } rail ends, in px (platform centre)
    keys: [],
    // What the run has done to the scenery. Mirrors of the host's record,
    // kept here because collision has to see them.
    cracked: new Set(),
    broken: new Set(),
    unlocked: false,
  };

  const centre = (tx, ty) => ({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });

  // Movers first, while their rails are still in the grid: a rail is the run
  // of rail glyphs touching the mover along its axis.
  const rail = (tx, ty, dx, dy, glyph) => {
    let a = 0, b = 0;
    while (grid[ty - dy * (a + 1)]?.[tx - dx * (a + 1)] === glyph) a++;
    while (grid[ty + dy * (b + 1)]?.[tx + dx * (b + 1)] === glyph) b++;
    return { ...centre(tx - dx * a, ty - dy * a), end: centre(tx + dx * b, ty + dy * b) };
  };
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const ch = grid[ty][tx];
      if (ch !== 'M' && ch !== 'V') continue;
      const r = ch === 'M' ? rail(tx, ty, 1, 0, '-') : rail(tx, ty, 0, 1, ':');
      lv.movers.push({ x0: r.x, y0: r.y, x1: r.end.x, y1: r.end.y });
    }
  }

  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const ch = grid[ty][tx];
      if (ch === '.' || ch === ' ') { grid[ty][tx] = '.'; continue; }
      if (ch === 'S') { lv.spawn = centre(tx, ty); grid[ty][tx] = '.'; }
      else if (ch === 'F') { lv.flag = { ...centre(tx, ty), tx, ty }; grid[ty][tx] = '.'; }
      else if (ch === 'C') { lv.checkpoints.push(centre(tx, ty)); grid[ty][tx] = '.'; }
      else if (ch === 'o') { lv.coins.push(centre(tx, ty)); grid[ty][tx] = '.'; }
      else if (ch === 'G') { lv.gems.push(centre(tx, ty)); grid[ty][tx] = '.'; }
      else if (ch === 'K') { lv.keys.push(centre(tx, ty)); grid[ty][tx] = '.'; }
      else if (PICKUPS[ch]) { lv.pickups.push({ type: PICKUPS[ch], ...centre(tx, ty), block: null }); grid[ty][tx] = '.'; }
      else if (ch === '@') { lv.pickups.push({ type: 'heart', ...centre(tx, ty - 1), block: tx + ',' + ty }); }
      else if (ENEMY_GLYPHS[ch]) { lv.enemies.push({ type: ENEMY_GLYPHS[ch], ...centre(tx, ty) }); grid[ty][tx] = '.'; }
      else if (ch === 'M' || ch === 'V' || ch === '-' || ch === ':') { grid[ty][tx] = '.'; }
    }
  }

  // Entities drawn over a pool left holes in the water where they were
  // lifted out; a cell that is mostly surrounded by water is water.
  const snap = grid.map((row) => row.join(''));
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      if (snap[ty][tx] !== '.') continue;
      const wet = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => snap[ty + dy]?.[tx + dx] === 'w').length;
      if (wet >= 2) grid[ty][tx] = 'w';
    }
  }

  lv.grid = grid.map((row) => row.join(''));
  return lv;
}
