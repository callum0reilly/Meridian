// Meridian Bros. Pure logic — no DOM, no canvas, no network.
//
// ---- Who simulates what ----
//
// Unlike Impostor, there is no hidden information here: it is a co-op game
// between friends, so the split is chosen for feel, not for anti-cheat.
//
//   your own hero   — YOUR browser, at 60 steps/sec, zero latency on the jump
//   the enemies     — the host, on the shared clock, broadcast to everyone
//   coins / blocks / scores / the flag — the host, validating everyone's claims
//
// A player who has to wait a round trip to leave the ground will call the
// jump broken, and in a platformer the jump is the whole game. So each client
// owns its own body outright and *reports* position; the host never argues.
// What the host does referee is anything shared: a coin can only be collected
// once, an enemy only stomped once, whoever touches the flag first ends the
// level. Both hosts and clients run exactly the functions in this file, which
// is what keeps a stomp judged on one machine agreeing with the enemy path
// simulated on another.
//
// ---- Fixed steps ----
//
// Everything below is per step, and a step is 1/60s, for the same reason as
// Flappy: physics tied to the frame rate makes gravity a property of the
// player's monitor. The host's enemy simulation runs the same 60Hz steps,
// batched three at a time inside its 20Hz network tick.

import {
  TILE, ROWS, WORLDS, WORLD_BY_ID, parseWorld,
  tileAt, solidAt, oneWayAt, hazardAt,
} from './levels.js';

export const STEP_MS = 1000 / 60;
export const TICK_HZ = 20;              // network tick: snapshots per second
export const TICK_MS = 1000 / TICK_HZ;

export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 4;

/* ---- movement ---- */
export const GRAVITY = 0.55;
export const FLOAT_GRAVITY = 0.38;      // Bea, on the way down
export const MAX_FALL = 12;
export const JUMP_CUT = -4;             // release the key early, keep this much
export const COYOTE = 6;                // steps of grace after walking off a ledge
export const JUMP_BUFFER = 6;           // steps a jump press waits for the ground
export const STOMP_BOUNCE = -8.5;
export const PLAYER_W = 22;
export const PLAYER_H = 30;
export const RESPAWN_STEPS = 80;        // dead time before you're back
export const SPAWN_INVULN = 90;         // steps of enemy immunity after respawn

/**
 * The heroes. Stats differ enough to argue over, not enough to strand anyone:
 * every character clears every required jump in every world (the maps are
 * designed against Sunny's apex, the shortest).
 *
 * Apex height = jump² / (2 · gravity):
 *   Rex 110px · Gil 133px · Sunny 102px · Bea 106px  (a 3-tile rise is 96px)
 */
export const CHARACTERS = {
  rex:   { name: 'Rex',   hex: '#e5484d', dark: '#a32b30', speed: 3.4, jump: 11.0, accel: 0.50, floaty: false, blurb: 'Steady all-rounder' },
  gil:   { name: 'Gil',   hex: '#30a46c', dark: '#1d7a4c', speed: 3.1, jump: 12.1, accel: 0.45, floaty: false, blurb: 'Highest jump' },
  sunny: { name: 'Sunny', hex: '#ffb224', dark: '#c47f0a', speed: 4.0, jump: 10.6, accel: 0.60, floaty: false, blurb: 'Fastest on the flat' },
  bea:   { name: 'Bea',   hex: '#4a9eff', dark: '#2a6cc2', speed: 3.2, jump: 10.8, accel: 0.48, floaty: true,  blurb: 'Floats on the way down' },
};
export const CHAR_IDS = Object.keys(CHARACTERS);

/* re-exported so index.js has one import for game data */
export { TILE, ROWS, WORLDS, WORLD_BY_ID, parseWorld, tileAt };

/* ============================== the hero ============================== */

/** A fresh body at the level's spawn, nudged apart per seat so four players
 *  don't boot up standing inside each other. */
export function makeBody(lv, charId, seat) {
  const x = lv.spawn.x + seat * 12;
  const y = lv.spawn.y;
  return {
    seat, charId,
    x, y, vx: 0, vy: 0,
    face: 1, onGround: false,
    coyote: 0, jbuf: 0, dropT: 0,
    inv: 0,
    dead: false, deadT: 0,
    cx: x, cy: y,          // checkpoint: where death sends you back to
  };
}

/**
 * One step of one hero.
 *
 * @param input {{left, right, jump, held, down}} — `jump` is the *press*
 *   (edge), `held` is the key still being down; the difference is what makes
 *   tapping hop and holding soar.
 * @returns {{bump: {tx,ty}|null, dead: 'hazard'|'pit'|null, landed: boolean}}
 */
export function stepPlayer(b, input, lv) {
  const ev = { bump: null, dead: null, landed: false };
  const ch = CHARACTERS[b.charId] || CHARACTERS.rex;

  if (b.dead) {
    // The death hop: rise, then fall out of the world. No collision — the
    // scenery is no longer this body's problem.
    b.deadT += 1;
    b.vy = Math.min(b.vy + GRAVITY * 0.5, MAX_FALL);
    b.y += b.vy;
    return ev;
  }

  if (b.inv > 0) b.inv -= 1;

  const ice = !!lv.world.ice;
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (dir) {
    // On ice you steer like a shopping trolley; in the air, weakly.
    b.vx += ch.accel * (ice && b.onGround ? 0.35 : b.onGround ? 1 : 0.65) * dir;
    b.face = dir;
  } else if (b.onGround) {
    b.vx *= ice ? 0.975 : 0.78;
  } else {
    b.vx *= 0.985;
  }
  if (Math.abs(b.vx) > ch.speed) b.vx = ch.speed * Math.sign(b.vx);
  if (!dir && Math.abs(b.vx) < 0.05) b.vx = 0;

  // Coyote time + a buffered jump: the two standard mercies. Pressing jump a
  // few steps early or leaving the ledge a few steps ago both still count.
  b.coyote = b.onGround ? COYOTE : Math.max(0, b.coyote - 1);
  b.jbuf = input.jump ? JUMP_BUFFER : Math.max(0, b.jbuf - 1);
  if (b.jbuf > 0 && b.coyote > 0) {
    b.vy = -ch.jump;
    b.coyote = 0;
    b.jbuf = 0;
    b.onGround = false;
  }
  if (!input.held && b.vy < JUMP_CUT) b.vy = JUMP_CUT;

  // Down through a one-way platform, on request.
  if (input.down && b.onGround && standingOnOneWay(b, lv)) {
    b.dropT = 12;
    b.onGround = false;
  }
  if (b.dropT > 0) b.dropT -= 1;

  const grav = ch.floaty && b.vy > 0 ? FLOAT_GRAVITY : GRAVITY;
  b.vy = Math.min(b.vy + grav, MAX_FALL);

  moveX(b, lv);
  const res = moveY(b, lv);
  ev.bump = res.bump;
  ev.landed = res.landed;

  if (touchesHazard(b, lv)) {
    kill(b);
    ev.dead = 'hazard';
  } else if (b.y - PLAYER_H / 2 > lv.h * TILE + 40) {
    kill(b);
    ev.dead = 'pit';
  }
  return ev;
}

/** Death is local and immediate; the respawn timer is counted in stepPlayer. */
export function kill(b) {
  b.dead = true;
  b.deadT = 0;
  b.vx = 0;
  b.vy = -6;       // the little upward pop every platformer death has had since 1985
}

export function respawn(b) {
  b.x = b.cx;
  b.y = b.cy;
  b.vx = 0; b.vy = 0;
  b.dead = false;
  b.deadT = 0;
  b.onGround = false;
  b.dropT = 0;
  b.inv = SPAWN_INVULN;
}

/* ---- collision ----
   Axis-separated: move X, resolve, then move Y, resolve. Squeezing both into
   one pass is where platformer collision bugs come from — the classic "caught
   on the seam between two floor tiles" is a diagonal resolution guessing the
   wrong axis. */

const EPS = 0.01;
const HW = PLAYER_W / 2;
const HH = PLAYER_H / 2;

function moveX(b, lv) {
  b.x += b.vx;
  const ty0 = Math.floor((b.y - HH + EPS) / TILE);
  const ty1 = Math.floor((b.y + HH - EPS) / TILE);
  if (b.vx > 0) {
    const tx = Math.floor((b.x + HW) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      if (solidAt(lv, tx, ty)) { b.x = tx * TILE - HW - EPS; b.vx = 0; break; }
    }
  } else if (b.vx < 0) {
    const tx = Math.floor((b.x - HW) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      if (solidAt(lv, tx, ty)) { b.x = (tx + 1) * TILE + HW + EPS; b.vx = 0; break; }
    }
  }
  // The level's outer walls.
  b.x = Math.max(HW, Math.min(lv.w * TILE - HW, b.x));
}

function moveY(b, lv) {
  const prevBottom = b.y + HH;
  b.y += b.vy;
  const out = { landed: false, bump: null };
  const tx0 = Math.floor((b.x - HW + EPS) / TILE);
  const tx1 = Math.floor((b.x + HW - EPS) / TILE);

  if (b.vy >= 0) {
    const ty = Math.floor((b.y + HH) / TILE);
    let hit = false;
    for (let tx = tx0; tx <= tx1; tx++) {
      if (solidAt(lv, tx, ty)) { hit = true; break; }
      // One-way platforms only exist for feet that were above them last step —
      // that single condition is what makes them jump-through-able.
      if (oneWayAt(lv, tx, ty) && b.dropT <= 0 && prevBottom <= ty * TILE + 4) { hit = true; break; }
    }
    if (hit) {
      b.y = ty * TILE - HH;
      out.landed = !b.onGround;
      b.onGround = true;
      b.vy = 0;
    } else {
      b.onGround = false;
    }
  } else {
    const ty = Math.floor((b.y - HH) / TILE);
    // Head hits pick ONE block — the most-overlapped — so jumping at the seam
    // between two ?-blocks bumps the one you meant, not both.
    let best = null, bestOv = 0;
    for (let tx = tx0; tx <= tx1; tx++) {
      if (!solidAt(lv, tx, ty)) continue;
      const ov = Math.min(b.x + HW, (tx + 1) * TILE) - Math.max(b.x - HW, tx * TILE);
      if (ov > bestOv) { bestOv = ov; best = tx; }
    }
    if (best !== null) {
      b.y = (ty + 1) * TILE + HH + EPS;
      b.vy = 0;
      out.bump = { tx: best, ty };
    }
    b.onGround = false;
  }
  return out;
}

function standingOnOneWay(b, lv) {
  const ty = Math.floor((b.y + HH + 2) / TILE);
  const tx0 = Math.floor((b.x - HW + EPS) / TILE);
  const tx1 = Math.floor((b.x + HW - EPS) / TILE);
  let oneWay = false;
  for (let tx = tx0; tx <= tx1; tx++) {
    if (solidAt(lv, tx, ty)) return false;   // partly on real ground: no drop
    if (oneWayAt(lv, tx, ty)) oneWay = true;
  }
  return oneWay;
}

/** Hazards test a shrunk box: brushing the tile a spike lives in shouldn't
 *  kill, standing among the points should. */
function touchesHazard(b, lv) {
  const tx0 = Math.floor((b.x - HW + 5) / TILE);
  const tx1 = Math.floor((b.x + HW - 5) / TILE);
  const ty0 = Math.floor((b.y - HH + 4) / TILE);
  const ty1 = Math.floor((b.y + HH - 4) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (hazardAt(lv, tx, ty)) return true;
    }
  }
  return false;
}

/* ============================ pickups & goals ============================ */

/** Coin indexes this body is touching that aren't already in `collected`.
 *  The caller sends the claim to the host; the host is the one set of record. */
export function collectCoins(b, lv, collected) {
  if (b.dead) return [];
  const got = [];
  for (let i = 0; i < lv.coins.length; i++) {
    if (collected.has(i)) continue;
    const c = lv.coins[i];
    if (Math.abs(b.x - c.x) < 24 && Math.abs(b.y - c.y) < 26) got.push(i);
  }
  return got;
}

export function touchCheckpoint(b, lv) {
  if (b.dead) return null;
  for (const cp of lv.checkpoints) {
    if (Math.abs(b.x - cp.x) < 22 && Math.abs(b.y - cp.y) < 48) return cp;
  }
  return null;
}

export function touchFlag(b, lv) {
  if (b.dead) return false;
  return Math.abs(b.x - lv.flag.x) < 18 && b.y > (lv.flag.ty - 5) * TILE;
}

/* ============================== enemies ============================== */

export const ENEMY = {
  walker: { w: 26, h: 22, speed: 0.8 },
  spiker: { w: 26, h: 20, speed: 0.55 },
};

export function makeEnemies(lv) {
  return lv.enemies.map((e, i) => ({
    i, type: e.type, x: e.x, y: e.y, dir: -1, vy: 0, alive: true,
  }));
}

/** Enemies patrol: walk until a wall, a ledge, or something pointy, then turn.
 *  They obey the same gravity as everyone, so a spawn in mid-air just lands. */
export function stepEnemy(e, lv) {
  if (!e.alive) return;
  const spec = ENEMY[e.type];
  const hw = spec.w / 2, hh = spec.h / 2;

  e.vy = Math.min(e.vy + GRAVITY, MAX_FALL);
  e.y += e.vy;
  const fty = Math.floor((e.y + hh) / TILE);
  const tx0 = Math.floor((e.x - hw + EPS) / TILE);
  const tx1 = Math.floor((e.x + hw - EPS) / TILE);
  let grounded = false;
  for (let tx = tx0; tx <= tx1; tx++) {
    if (solidAt(lv, tx, fty) || oneWayAt(lv, tx, fty)) { grounded = true; break; }
  }
  if (grounded) {
    e.y = fty * TILE - hh;
    e.vy = 0;

    const aheadX = e.x + e.dir * (hw + 3);
    const atx = Math.floor(aheadX / TILE);
    const mty = Math.floor(e.y / TILE);           // wall at body height?
    const bty = Math.floor((e.y + hh + 6) / TILE); // floor under the next step?
    const blocked = solidAt(lv, atx, mty)
      || hazardAt(lv, atx, mty) || hazardAt(lv, atx, bty)
      || !(solidAt(lv, atx, bty) || oneWayAt(lv, atx, bty));
    if (blocked) e.dir = -e.dir;
    e.x += spec.speed * e.dir;
    if (e.x < hw) { e.x = hw; e.dir = 1; }
    if (e.x > lv.w * TILE - hw) { e.x = lv.w * TILE - hw; e.dir = -1; }
  }

  if (e.y > (lv.h + 3) * TILE) e.alive = false;   // fell out somehow; tidy up
}

/**
 * What happens when a hero and an enemy share space.
 *
 * A stomp is: falling, and your feet above the enemy's shoulders. Walkers die
 * of it; spikers are the reason you look before you land — every touch hurts.
 * Spawn invulnerability skips the hurt (not the stomp: mercy shouldn't also
 * disarm you).
 */
export function hitEnemy(b, e) {
  if (!e.alive || b.dead) return null;
  const spec = ENEMY[e.type];
  const inX = Math.abs(b.x - e.x) < (PLAYER_W + spec.w) / 2 - 4;
  const inY = Math.abs(b.y - e.y) < (PLAYER_H + spec.h) / 2 - 3;
  if (!inX || !inY) return null;
  if (e.type === 'walker' && b.vy > 0.5 && b.y + PLAYER_H / 2 < e.y + spec.h * 0.3) return 'stomp';
  return b.inv > 0 ? null : 'hurt';
}

/* ========================= the shared run (host) ========================= */

/** Everything one attempt at one world accumulates. Lives on the host;
 *  clients see it through room pushes. */
export function createRun(worldId, seatCount) {
  const world = WORLD_BY_ID.get(worldId) || WORLDS[0];
  const lv = parseWorld(world);
  return {
    worldId: world.id,
    lv,
    enemies: makeEnemies(lv),
    collected: new Set(),        // coin indexes
    used: new Set(),             // "tx,ty" of spent ?-blocks
    scores: Array.from({ length: seatCount }, () => ({ c: 0, s: 0, d: 0 })),
    clearBy: -1,                 // seat that reached the flag, once someone has
  };
}

/* Claims arrive from every player, the host's own included, and each is
   checked against the run before it counts. Not for cheating — for races:
   two players hitting the same coin in the same tick both honestly claim it,
   and exactly one of these calls returns true. */

export function applyCoin(run, seat, i) {
  if (!Number.isInteger(i) || i < 0 || i >= run.lv.coins.length) return false;
  if (run.collected.has(i)) return false;
  run.collected.add(i);
  score(run, seat).c += 1;
  return true;
}

export function applyBump(run, seat, tx, ty) {
  if (tileAt(run.lv, tx, ty) !== '?') return false;
  const key = tx + ',' + ty;
  if (run.used.has(key)) return false;
  run.used.add(key);
  score(run, seat).c += 1;
  return true;
}

export function applyStomp(run, seat, i) {
  const e = run.enemies[i];
  if (!e || !e.alive || e.type !== 'walker') return false;
  e.alive = false;
  score(run, seat).s += 1;
  return true;
}

export function applyDeath(run, seat) {
  score(run, seat).d += 1;
  return true;
}

export function applyFlag(run, seat) {
  if (run.clearBy >= 0) return false;
  run.clearBy = seat;
  return true;
}

function score(run, seat) {
  return run.scores[seat] || (run.scores[seat] = { c: 0, s: 0, d: 0 });
}

/** The next world in the tour, wrapping at the end. */
export function nextWorldId(worldId) {
  const i = WORLDS.findIndex((w) => w.id === worldId);
  return WORLDS[(i + 1) % WORLDS.length].id;
}
