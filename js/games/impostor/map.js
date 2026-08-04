// The ship: where the walls are, where the jobs are, and what you can see.
// Pure geometry — rules.js imports this, this imports nothing.
//
// The whole map is a union of axis-aligned rectangles. Rooms are the big ones,
// halls are the thin ones joining them, and "walkable" means nothing more than
// "inside at least one rectangle". That is why every hall below overlaps both
// rooms it connects by a few units: butt them up edge-to-edge and floating
// point decides whether the seam is a doorway or a wall, differently on each
// machine. An overlap makes the union genuinely continuous.
//
//         upper engine ── medbay ──── CAFETERIA ─────── weapons
//              │                          │                │
//           reactor ── security ── admin ─┘                │
//              │           └──────────┤                 (right hall)
//         lower engine ──────────── storage ─── shields ───┤
//                                                          navigation
//
// The loops matter more than the rooms do. A ship where every room is a
// dead end is a ship where anyone you meet in a corridor saw you coming, and
// the whole game is people arguing about who could have been where.

export const WORLD_W = 1640;
export const WORLD_H = 1000;

/** Half-width of a player, for collision. Bodies and stations have no size. */
export const PLAYER_R = 16;

export const ROOMS = [
  { id: 'upper-engine', name: 'Upper Engine', x: 80,   y: 80,  w: 240, h: 220 },
  { id: 'reactor',      name: 'Reactor',      x: 80,   y: 380, w: 220, h: 240 },
  { id: 'lower-engine', name: 'Lower Engine', x: 80,   y: 700, w: 240, h: 220 },
  { id: 'medbay',       name: 'MedBay',       x: 400,  y: 120, w: 160, h: 180 },
  { id: 'security',     name: 'Security',     x: 400,  y: 420, w: 160, h: 160 },
  { id: 'cafeteria',    name: 'Cafeteria',    x: 640,  y: 60,  w: 380, h: 280 },
  { id: 'admin',        name: 'Admin',        x: 700,  y: 440, w: 220, h: 160 },
  { id: 'storage',      name: 'Storage',      x: 640,  y: 700, w: 380, h: 240 },
  { id: 'weapons',      name: 'Weapons',      x: 1120, y: 60,  w: 240, h: 220 },
  { id: 'navigation',   name: 'Navigation',   x: 1400, y: 380, w: 160, h: 240 },
  { id: 'shields',      name: 'Shields',      x: 1120, y: 700, w: 240, h: 220 },
];

/** Corridors. Unnamed on purpose — "he was in the hall" is not an alibi. */
export const HALLS = [
  { x: 314,  y: 170, w: 92,  h: 60 },   // upper engine ─ medbay
  { x: 554,  y: 170, w: 92,  h: 60 },   // medbay ─ cafeteria
  { x: 150,  y: 294, w: 60,  h: 92 },   // upper engine ─ reactor
  { x: 150,  y: 614, w: 60,  h: 92 },   // reactor ─ lower engine
  { x: 294,  y: 470, w: 112, h: 60 },   // reactor ─ security
  { x: 554,  y: 470, w: 152, h: 60 },   // security ─ admin
  { x: 780,  y: 334, w: 60,  h: 112 },  // cafeteria ─ admin
  { x: 780,  y: 594, w: 60,  h: 112 },  // admin ─ storage
  { x: 314,  y: 780, w: 332, h: 60 },   // lower engine ─ storage
  { x: 1014, y: 140, w: 112, h: 60 },   // cafeteria ─ weapons
  { x: 1210, y: 274, w: 60,  h: 432 },  // weapons ─ shields, down the right side
  { x: 1240, y: 470, w: 166, h: 60 },   // that hall ─ navigation
  { x: 1014, y: 780, w: 112, h: 60 },   // storage ─ shields
];

/** Everything you can stand on. Rooms first, so roomAt() names a room when a
 *  hall overlaps one. */
export const AREAS = [...ROOMS, ...HALLS];

/**
 * The jobs. `kind` picks the minigame; see tasks.js.
 *
 * Deliberately spread to the ends of the ship: a task list you can finish
 * without leaving Cafeteria is a task list that never puts you alone in a
 * room with someone, which is the only situation this game is about.
 */
export const STATIONS = [
  { id: 'align-upper',      room: 'upper-engine', name: 'Align Engine Output',    kind: 'align', x: 200,  y: 140 },
  { id: 'reactor-wires',    room: 'reactor',      name: 'Start Reactor',          kind: 'wires', x: 190,  y: 430 },
  { id: 'unlock-manifolds', room: 'reactor',      name: 'Unlock Manifolds',       kind: 'hold',  x: 190,  y: 580 },
  { id: 'align-lower',      room: 'lower-engine', name: 'Align Engine Output',    kind: 'align', x: 200,  y: 860 },
  { id: 'medbay-scan',      room: 'medbay',       name: 'Submit Scan',            kind: 'hold',  x: 480,  y: 170 },
  { id: 'security-wires',   room: 'security',     name: 'Fix Wiring',             kind: 'wires', x: 480,  y: 540 },
  { id: 'cafe-garbage',     room: 'cafeteria',    name: 'Empty Garbage',          kind: 'hold',  x: 700,  y: 290 },
  { id: 'cafe-wires',       room: 'cafeteria',    name: 'Fix Wiring',             kind: 'wires', x: 960,  y: 290 },
  { id: 'admin-swipe',      room: 'admin',        name: 'Swipe Card',             kind: 'swipe', x: 760,  y: 560 },
  { id: 'storage-fuel',     room: 'storage',      name: 'Fuel Engines',           kind: 'hold',  x: 700,  y: 880 },
  { id: 'storage-wires',    room: 'storage',      name: 'Fix Wiring',             kind: 'wires', x: 960,  y: 740 },
  { id: 'weapons-align',    room: 'weapons',      name: 'Calibrate Distributor',  kind: 'align', x: 1180, y: 230 },
  { id: 'nav-align',        room: 'navigation',   name: 'Stabilise Steering',     kind: 'align', x: 1480, y: 430 },
  { id: 'nav-swipe',        room: 'navigation',   name: 'Chart Course',           kind: 'swipe', x: 1480, y: 570 },
  { id: 'shields-swipe',    room: 'shields',      name: 'Prime Shields',          kind: 'swipe', x: 1180, y: 860 },
];

export const STATION_BY_ID = new Map(STATIONS.map((s) => [s.id, s]));

/** The cafeteria table. Everyone spawns around it and meetings return here. */
export const BUTTON = { x: 830, y: 200 };
const SPAWN_RING = 90;

/**
 * Where seat `i` of `n` stands at the start of a round and after every meeting.
 *
 * A ring rather than a pile: overlapping players at spawn is the one moment
 * everyone is looking at everyone, and a heap of circles is the worst possible
 * first impression of who is even in the game.
 */
export function spawnPoint(i, n) {
  const angle = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
  return {
    x: BUTTON.x + Math.cos(angle) * SPAWN_RING,
    y: BUTTON.y + Math.sin(angle) * SPAWN_RING,
  };
}

/* ============================ geometry ============================ */

const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Is this single point inside the ship? */
export function walkable(x, y) {
  for (const r of AREAS) if (inRect(r, x, y)) return true;
  return false;
}

/**
 * Could a player centred here stand here?
 *
 * Tests the four corners of the player's box, not just the centre. The centre
 * alone lets you stand with half your body inside a wall, which looks like a
 * rendering bug and plays like one too — you can be stabbed from inside solid
 * rock. Four corners is enough because every hall below is 60 wide against a
 * 32-wide player, so there is no gap narrow enough to squeeze a corner through.
 */
export function fits(x, y, r = PLAYER_R) {
  return walkable(x - r, y - r) && walkable(x + r, y - r)
      && walkable(x - r, y + r) && walkable(x + r, y + r);
}

/** The room containing this point, or null in a corridor. */
export function roomAt(x, y) {
  for (const r of ROOMS) if (inRect(r, x, y)) return r;
  return null;
}

export const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
export const within = (ax, ay, bx, by, r) => dist2(ax, ay, bx, by) <= r * r;

/** Sampling step for the sight line, in world units. */
const LOS_STEP = 12;

/**
 * Can a player at A see a point at B, walls aside?
 *
 * Walks the segment and asks whether every sample is inside the ship. It is a
 * sampled test, not an exact one, so a sliver of wall thinner than LOS_STEP
 * would be seen through — there isn't one on this map, and the alternative is
 * segment-vs-edge intersection against every rectangle on every frame for
 * every pair of players. The cost of being wrong here is a player briefly
 * visible around a corner; the cost of being exact is the frame budget.
 */
export function hasLOS(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const steps = Math.ceil(Math.hypot(dx, dy) / LOS_STEP);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!walkable(ax + dx * t, ay + dy * t)) return false;
  }
  return true;
}
