// Dublin city centre, flattened to rectangles. Pure geometry — rules.js
// imports this, this imports nothing, and none of it touches the DOM, so the
// whole map is testable in Node.
//
// The plan (north at y=0, all logic on a flat x/y plane — the renderer maps
// y here onto Three.js z and invents the third dimension itself):
//
//     Parnell St ───────────────────────────────
//       Capel │     Henry St ── │O'Connell│ │Marl.│   [Mater]
//        St   │                 │  St     │           [Custom Hse][Garda]
//     ═ north quays ══════════════════════════════════════════
//     ~~~ Liffey ~ Grattan br ~ Ha'penny ~ O'Connell bridge ~~~
//     ═ south quays ══════════════════════════════════════════
//        │Parliament   TEMPLE BAR   │Westmoreland│ [Bank]
//     ── Dame St ─────────────────────────  [ TRINITY COLLEGE ]
//     [Christ Ch.]   │George's│  │Grafton│ ── Nassau St ──
//                                              │Dawson│
//     ─────────────────────────────────  [St Stephen's Green]
//     [Guinness]
//
// Everything solid is an axis-aligned rectangle; "walkable" means "not inside
// any of them". Roads are visual and give the traffic loops somewhere honest
// to drive, but nothing stops you walking off the pavement — this is a game
// about not respecting the rules of the road.

export const WORLD_W = 2600;
export const WORLD_H = 2000;

/* ---- the Liffey ---- */

export const RIVER = { y: 880, h: 120 };

/** Land over the water. Sorted west→east; WATER below is derived as the gaps. */
export const BRIDGES = [
  { id: 'grattan', name: 'Grattan Bridge', x: 380, w: 90, ped: false },
  { id: 'hapenny', name: "Ha'penny Bridge", x: 780, w: 80, ped: true },
  { id: 'oconnell', name: "O'Connell Bridge", x: 1440, w: 200, ped: false },
];

export const WATER = (() => {
  const out = [];
  let x = 0;
  for (const b of BRIDGES) {
    if (b.x > x) out.push({ x, y: RIVER.y, w: b.x - x, h: RIVER.h });
    x = b.x + b.w;
  }
  out.push({ x, y: RIVER.y, w: WORLD_W - x, h: RIVER.h });
  return out;
})();

/* ---- roads ----
   Visual, plus the rails the AI drives on. `ped` streets (Henry, Grafton, the
   Ha'penny) are rendered as paving and get no traffic. */

export const ROADS = [
  { id: 'parnell', x: 340, y: 100, w: 1360, h: 70 },
  { id: 'northquay', x: 40, y: 800, w: 2520, h: 80 },
  { id: 'southquay', x: 40, y: 1000, w: 2520, h: 80 },
  { id: 'capel', x: 380, y: 100, w: 90, h: 700 },
  { id: 'parliament', x: 380, y: 1000, w: 90, h: 380 },
  { id: 'oconnell', x: 1440, y: 100, w: 200, h: 700 },
  { id: 'westmoreland', x: 1440, y: 1080, w: 120, h: 220 },
  { id: 'henry', x: 600, y: 400, w: 840, h: 60, ped: true },
  { id: 'marlborough', x: 1720, y: 170, w: 70, h: 630 },
  { id: 'dame', x: 200, y: 1300, w: 1500, h: 80 },
  { id: 'georges', x: 700, y: 1380, w: 80, h: 400 },
  { id: 'grafton', x: 1560, y: 1380, w: 70, h: 370, ped: true },
  { id: 'nassau', x: 1630, y: 1440, w: 770, h: 70 },
  { id: 'dawson', x: 1950, y: 1510, w: 80, h: 270 },
  { id: 'southrd', x: 80, y: 1720, w: 1870, h: 60 },
];

/* ---- blocks ----
   kind 'block' is filled with generated Georgian terraces (see buildingsOf).
   Named kinds are landmarks the renderer draws by hand. Every kind except
   'park' is solid. */

export const BLOCKS = [
  { kind: 'block', x: 80, y: 190, w: 260, h: 190 },
  { kind: 'block', x: 500, y: 190, w: 920, h: 190 },
  { kind: 'block', x: 1810, y: 190, w: 450, h: 190 },
  { kind: 'hospital', name: 'The Mater', x: 2300, y: 200, w: 160, h: 160 },
  { kind: 'block', x: 80, y: 470, w: 260, h: 310 },
  { kind: 'block', x: 500, y: 470, w: 800, h: 310 },
  { kind: 'gpo', name: 'The GPO', x: 1330, y: 560, w: 110, h: 200 },
  { kind: 'block', x: 1810, y: 470, w: 450, h: 150 },
  { kind: 'custom', name: 'Custom House', x: 1810, y: 640, w: 330, h: 140 },
  { kind: 'garda', name: 'Garda Station', x: 2200, y: 640, w: 160, h: 140 },
  { kind: 'block', x: 2420, y: 470, w: 140, h: 310 },
  { kind: 'block', x: 80, y: 1120, w: 300, h: 180 },
  { kind: 'block', x: 500, y: 1120, w: 260, h: 180 },
  // Temple Bar: two rows of pubs with lanes between and through them.
  { kind: 'pub', x: 820, y: 1120, w: 110, h: 70 },
  { kind: 'pub', x: 960, y: 1120, w: 120, h: 70 },
  { kind: 'pub', x: 1120, y: 1120, w: 100, h: 70 },
  { kind: 'pub', x: 1260, y: 1120, w: 120, h: 70 },
  { kind: 'pub', x: 820, y: 1230, w: 110, h: 70 },
  { kind: 'templebar', name: 'The Temple Bar', x: 980, y: 1230, w: 140, h: 70 },
  { kind: 'pub', x: 1160, y: 1230, w: 90, h: 70 },
  { kind: 'pub', x: 1290, y: 1230, w: 90, h: 70 },
  { kind: 'bank', name: 'Bank of Ireland', x: 1560, y: 1120, w: 140, h: 180 },
  { kind: 'trinity', name: 'Trinity College', x: 1700, y: 1060, w: 700, h: 380 },
  { kind: 'block', x: 80, y: 1420, w: 120, h: 260 },
  { kind: 'christ', name: 'Christ Church', x: 240, y: 1420, w: 180, h: 180 },
  { kind: 'block', x: 460, y: 1420, w: 220, h: 260 },
  { kind: 'block', x: 800, y: 1420, w: 640, h: 260 },
  { kind: 'block', x: 1660, y: 1530, w: 270, h: 170 },
  { kind: 'block', x: 2050, y: 1530, w: 450, h: 370 },
  { kind: 'park', name: "St Stephen's Green", x: 1450, y: 1800, w: 500, h: 180 },
  { kind: 'guinness', name: "St James's Gate", x: 80, y: 1780, w: 280, h: 160 },
  { kind: 'block', x: 460, y: 1800, w: 400, h: 150 },
  { kind: 'block', x: 920, y: 1800, w: 480, h: 150 },
];

export const SPIRE = { x: 1540, y: 660 };

/** Trees are small solids — a car should crumple against one, not ghost
    through it. The O'Connell median row leaves a gap where the Spire stands. */
export const TREES = [
  [1540, 260], [1540, 360], [1540, 460], [1540, 560], [1540, 760],
  [1500, 1850], [1560, 1920], [1650, 1830], [1720, 1900],
  [1800, 1840], [1880, 1910], [1900, 1830], [1600, 1860],
];

const TREE_HALF = 7;

/* ---- collision ---- */

const SOLIDS = [
  ...BLOCKS.filter((b) => b.kind !== 'park'),
  ...WATER,
  ...TREES.map(([x, y]) => ({ x: x - TREE_HALF, y: y - TREE_HALF, w: TREE_HALF * 2, h: TREE_HALF * 2 })),
  { x: SPIRE.x - 8, y: SPIRE.y - 8, w: 16, h: 16 },
];

const inRect = (r, x, y, pad) =>
  x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad;

/** Can a body of radius r stand at (x, y)? */
export function fits(x, y, r) {
  if (x < r || y < r || x > WORLD_W - r || y > WORLD_H - r) return false;
  for (const s of SOLIDS) if (inRect(s, x, y, r)) return false;
  return true;
}

/** Do buildings stop a bullet here? Water and trees don't — you can shoot
    across the river, and through a sapling. */
export function bulletBlocked(x, y) {
  for (const b of BLOCKS) {
    if (b.kind === 'park') continue;
    if (inRect(b, x, y, 0)) return true;
  }
  return false;
}

/** Straight line of sight for AI and bullets, sampled every 14 units. */
export function hasLOS(x1, y1, x2, y2) {
  const d = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.ceil(d / 14);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (bulletBlocked(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return false;
  }
  return true;
}

/** Players spawn in a ring on the plaza just east of the Spire — open ground,
    clear of the traffic lanes, so nobody gets clipped while reading the HUD. */
export function spawnPoint(i) {
  const a = (i % 8) * (Math.PI / 4) + Math.PI / 8;
  return { x: 1655 + Math.cos(a) * 55, y: 660 + Math.sin(a) * 55 };
}

/* ---- traffic ----
   Closed waypoint loops down road centrelines. Loop 2 threads both road
   bridges, which is what keeps the two halves of the city feeling like one. */

export const LOOPS = [
  [[1490, 840], [1490, 135], [425, 135], [425, 840]],
  [[1500, 1040], [1500, 1340], [425, 1340], [425, 1040]],
  [[1500, 170], [1500, 1340], [425, 1340], [425, 170]],
];

/** Kerbside spawns: { x, y, yaw }. Yaw 0 faces east. All placed off the
    traffic loops' driven segments, or a passing AI would grind them to scrap. */
export const PARKED = [
  { x: 240, y: 820, yaw: 0 }, { x: 1755, y: 300, yaw: Math.PI / 2 },
  { x: 1900, y: 820, yaw: 0 }, { x: 2200, y: 820, yaw: 0 },
  { x: 180, y: 1040, yaw: Math.PI }, { x: 2450, y: 1040, yaw: Math.PI },
  { x: 2000, y: 1040, yaw: Math.PI },
  { x: 1456, y: 300, yaw: Math.PI / 2 }, { x: 1610, y: 500, yaw: -Math.PI / 2 },
  { x: 300, y: 1340, yaw: 0 }, { x: 1750, y: 1475, yaw: 0 },
  { x: 2380, y: 440, yaw: Math.PI / 2 },
  { x: 740, y: 1500, yaw: Math.PI / 2 }, { x: 1990, y: 1600, yaw: Math.PI / 2 },
];

export const GARDA_SPAWN = { x: 2280, y: 840 };     // the quay outside the station
export const HOSPITAL_SPAWN = { x: 2380, y: 420 };  // the Mater's front step

/* ---- missions ----
   Stand on the marker, press E. One job at a time. */

export const MISSION_DEFS = [
  {
    id: 'post', name: 'Post Run', kind: 'delivery',
    marker: { x: 1460, y: 660 },
    drop: { x: 1620, y: 1340 },
    secs: 50, reward: 300,
    brief: 'The GPO mail van died. Get the sacks to Trinity front gate — grab a car.',
  },
  {
    id: 'joyride', name: 'Joyrider', kind: 'chase',
    marker: { x: 1100, y: 1210 },
    spawn: { x: 425, y: 300 },
    secs: 75, reward: 400,
    brief: "Some chancer robbed a publican's car. Wreck it before he's gone.",
  },
  {
    id: 'errands', name: 'Green Errands', kind: 'fetch',
    marker: { x: 1700, y: 1750 },
    count: 5, secs: 90, reward: 350,
    brief: 'Five parcels left around town. Collect the lot before the clock runs out.',
  },
];

/** Candidate parcel spots for the fetch job — all on open road or plaza. */
export const FETCH_POINTS = [
  [1500, 760], [2380, 420], [300, 1340], [740, 1500],
  [1000, 820], [620, 430], [1750, 1475], [425, 1050],
];

/* ---- generated terraces ----
   Each 'block' becomes 2–6 hand-height buildings, deterministically, so every
   player renders the identical city without a byte of it on the wire. */

const BRICK = ['#8a5a44', '#9c6b50', '#7b4f3e', '#a87e62', '#6e7f8d', '#8d8577', '#b0876a', '#5f6c78', '#97684d', '#77645a'];
const PUBS = ['#b3372f', '#1f6f43', '#28457c', '#8a6d2f', '#54306e', '#245c66'];

export const BUILDINGS = (() => {
  const out = [];
  let n = 0;
  const rand = () => {          // tiny deterministic LCG, seeded once
    n = (n * 1664525 + 1013904223) >>> 0;
    return n / 4294967296;
  };
  for (const b of BLOCKS) {
    if (b.kind === 'pub' || b.kind === 'templebar') {
      out.push({
        x: b.x, y: b.y, w: b.w, h: b.h,
        ht: 34 + Math.floor(rand() * 14),
        color: b.kind === 'templebar' ? '#b3372f' : PUBS[Math.floor(rand() * PUBS.length)],
        pub: true,
      });
      continue;
    }
    if (b.kind !== 'block') continue;
    const alongX = b.w >= b.h;
    const len = alongX ? b.w : b.h;
    const pieces = Math.max(1, Math.min(6, Math.round(len / 150)));
    const step = len / pieces;
    for (let i = 0; i < pieces; i++) {
      const inset = 4 + rand() * 10;
      out.push({
        x: alongX ? b.x + i * step + 3 : b.x + inset / 2,
        y: alongX ? b.y + inset / 2 : b.y + i * step + 3,
        w: alongX ? step - 6 : b.w - inset,
        h: alongX ? b.h - inset : step - 6,
        ht: 42 + Math.floor(rand() * 52),
        color: BRICK[Math.floor(rand() * BRICK.length)],
      });
    }
  }
  return out;
})();
