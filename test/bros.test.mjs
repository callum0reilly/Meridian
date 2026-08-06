// Tests for the Meridian Bros rules and worlds.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TILE, ROWS, WORLDS, parseWorld, tileAt,
  CHARACTERS, CHAR_IDS, PLAYER_H, ENEMY,
  GRAVITY, COYOTE, JUMP_CUT, SPAWN_INVULN,
  makeBody, stepPlayer, kill, respawn,
  collectCoins, touchCheckpoint, touchFlag,
  stepEnemy, hitEnemy,
  createRun, applyCoin, applyBump, applyStomp, applyDeath, applyFlag,
  nextWorldId,
} from '../js/games/bros/rules.js';

/* ---------------- helpers ---------------- */

/**
 * A tiny hand-built world, so a test about physics is only about physics.
 * 16 columns, ROWS tall. The floor spans columns 0–13 with a pit at 14–15;
 * above it: a one-way platform, a ?-block, a floating spike (off the running
 * lane, so tests that sprint along the floor don't die by set dressing),
 * a coin, a checkpoint and the flag.
 *
 *   col:  0123456789012345
 *         ....=..^          ROWS-6   platform (4), spike (7)
 *         .?                ROWS-5   ?-block (1)
 *         ......o           ROWS-4   coin (6)
 *         .S......C.F       ROWS-3   spawn (1), checkpoint (8), flag (10)
 *         ##############..  ROWS-2   floor, pit at 14–15
 *         ##############..  ROWS-1
 */
function tinyWorld({ ice = false } = {}) {
  const r = (s) => s.padEnd(16, '.');
  const map = Array.from({ length: ROWS }, () => r(''));
  map[ROWS - 6] = r('....=..^');
  map[ROWS - 5] = r('.?');
  map[ROWS - 4] = r('......o');
  map[ROWS - 3] = r('.S......C.F');
  map[ROWS - 2] = r('##############');
  map[ROWS - 1] = r('##############');
  return { id: 'tiny', name: 'Tiny', sub: '', ice, palette: {}, map };
}

const lvOf = (opts) => parseWorld(tinyWorld(opts));

const GROUND_TOP = (ROWS - 2) * TILE;

const IDLE = { left: false, right: false, jump: false, held: false, down: false };
const press = (over = {}) => ({ ...IDLE, ...over });

function steps(b, input, n, lv) {
  let ev;
  for (let i = 0; i < n; i++) ev = stepPlayer(b, input, lv);
  return ev;
}

/** A body standing on the ground, settled. */
function grounded(lv, charId = 'rex', seat = 0) {
  const b = makeBody(lv, charId, seat);
  steps(b, IDLE, 30, lv);
  assert.equal(b.onGround, true, 'body should settle onto the ground');
  return b;
}

/* ---------------- worlds ---------------- */

test('every world parses with the essentials in place', () => {
  assert.ok(WORLDS.length >= 4, 'the tour has at least four worlds');
  for (const w of WORLDS) {
    const lv = parseWorld(w);
    assert.equal(lv.h, ROWS, `${w.id}: height is ${ROWS} rows`);
    for (const row of lv.grid) assert.equal(row.length, lv.w, `${w.id}: rows padded square`);
    assert.ok(lv.spawn.x < lv.flag.x, `${w.id}: flag is to the right of spawn`);
    assert.ok(lv.coins.length > 0, `${w.id}: has coins`);
    assert.ok(lv.enemies.length > 0, `${w.id}: has enemies`);
    assert.ok(lv.checkpoints.length > 0, `${w.id}: has a checkpoint`);
    // Spawn must be open air with ground beneath — a world that kills you on
    // frame one is a data typo this test exists to catch.
    const stx = Math.floor(lv.spawn.x / TILE), sty = Math.floor(lv.spawn.y / TILE);
    assert.equal(tileAt(lv, stx, sty), '.', `${w.id}: spawn cell is air`);
    const below = [0, 1, 2, 3].some((i) => tileAt(lv, stx, sty + 1 + i) === '#');
    assert.ok(below, `${w.id}: ground within four tiles under spawn`);
  }
});

test('dynamic entities are lifted out of the grid', () => {
  const lv = lvOf();
  assert.equal(lv.coins.length, 1);
  assert.equal(lv.enemies.length, 0);
  assert.equal(lv.checkpoints.length, 1);
  for (const row of lv.grid) {
    assert.ok(!/[SoECXF]/.test(row), 'no entity glyphs left behind in the grid');
  }
});

test('the four heroes really differ, and all clear the tallest required jump', () => {
  assert.equal(CHAR_IDS.length, 4);
  const speeds = new Set(CHAR_IDS.map((c) => CHARACTERS[c].speed));
  const jumps = new Set(CHAR_IDS.map((c) => CHARACTERS[c].jump));
  assert.ok(speeds.size > 1 && jumps.size > 1);
  for (const c of CHAR_IDS) {
    const apex = CHARACTERS[c].jump ** 2 / (2 * GRAVITY);
    assert.ok(apex > TILE * 3, `${c} clears a 3-tile rise`);
  }
});

/* ---------------- moving ---------------- */

test('a body falls, lands flush, and stays put', () => {
  const lv = lvOf();
  const b = makeBody(lv, 'rex', 0);
  const ev = steps(b, IDLE, 60, lv);
  assert.equal(b.onGround, true);
  assert.equal(b.vy, 0);
  assert.equal(b.y + PLAYER_H / 2, GROUND_TOP, 'feet flush with the ground');
  assert.equal(ev.dead, null);
});

test('running accelerates up to the character cap', () => {
  const lv = lvOf();
  const rex = grounded(lv, 'rex');
  steps(rex, press({ right: true }), 60, lv);
  assert.equal(rex.vx, CHARACTERS.rex.speed);
  assert.equal(rex.face, 1);
  assert.ok(CHARACTERS.sunny.speed > CHARACTERS.gil.speed, 'Sunny outruns Gil');
  assert.ok(CHARACTERS.gil.jump > CHARACTERS.sunny.jump, 'Gil outjumps Sunny');
});

test('ice keeps you sliding where grass stops you', () => {
  const grass = lvOf();
  const icy = lvOf({ ice: true });
  const a = grounded(grass), c = grounded(icy);
  steps(a, press({ right: true }), 40, grass);
  steps(c, press({ right: true }), 40, icy);
  steps(a, IDLE, 12, grass);
  steps(c, IDLE, 12, icy);
  assert.ok(Math.abs(c.vx) > Math.abs(a.vx) * 3, 'ice retains far more speed after letting go');
});

test('jumping leaves the ground; releasing early cuts the rise', () => {
  const lv = lvOf();
  const full = grounded(lv);
  stepPlayer(full, press({ jump: true, held: true }), lv);
  assert.equal(full.onGround, false);
  // Gravity has already taken its bite by the end of the step.
  assert.ok(Math.abs(full.vy - (-CHARACTERS.rex.jump + GRAVITY)) < 1e-9);

  const tap = grounded(lv);
  stepPlayer(tap, press({ jump: true, held: true }), lv);
  stepPlayer(tap, press({ held: false }), lv);
  assert.ok(tap.vy >= JUMP_CUT, 'released jump is clamped to the cut velocity');
});

test('coyote time honours a jump pressed just after the ledge', () => {
  const lv = lvOf();
  const b = makeBody(lv, 'rex', 0);
  // Mid-air over the pit, as if the ground vanished underfoot this instant.
  b.x = 14 * TILE + 16;
  b.y = (ROWS - 6) * TILE;
  b.onGround = false;
  b.coyote = COYOTE;
  steps(b, IDLE, 3, lv);
  assert.ok(b.vy > 0, 'already falling');
  stepPlayer(b, press({ jump: true, held: true }), lv);
  assert.ok(Math.abs(b.vy - (-CHARACTERS.rex.jump + GRAVITY)) < 1e-9, 'the late press still jumps');
});

test('bumping a ?-block from below reports the block and stops the rise', () => {
  const lv = lvOf();
  const b = grounded(lv);
  b.x = 1 * TILE + TILE / 2;    // directly under the ?-block at (1, ROWS-5)
  stepPlayer(b, press({ jump: true, held: true }), lv);
  let bump = null;
  for (let i = 0; i < 40 && !bump; i++) bump = stepPlayer(b, press({ held: true }), lv).bump;
  assert.ok(bump, 'the head found the block');
  assert.deepEqual({ tx: bump.tx, ty: bump.ty }, { tx: 1, ty: ROWS - 5 });
  assert.equal(b.vy, 0, 'the bump killed the upward velocity');
});

test('one-way platform: lands from above, passes from below, drops on demand', () => {
  const lv = lvOf();
  const px = 4 * TILE + TILE / 2;
  const platTop = (ROWS - 6) * TILE;

  const a = makeBody(lv, 'rex', 0);
  a.x = px; a.y = platTop - 40;
  steps(a, IDLE, 40, lv);
  assert.equal(a.y + PLAYER_H / 2, platTop, 'standing on the platform');

  const c = makeBody(lv, 'rex', 0);
  c.x = px; c.y = platTop + 60;
  c.vy = -12;
  let minFeet = c.y + PLAYER_H / 2;
  for (let i = 0; i < 12; i++) {
    stepPlayer(c, press({ held: true }), lv);
    minFeet = Math.min(minFeet, c.y + PLAYER_H / 2);
  }
  assert.ok(minFeet < platTop, 'rose through the platform unharmed');

  stepPlayer(a, press({ down: true }), lv);
  steps(a, IDLE, 8, lv);
  assert.ok(a.y + PLAYER_H / 2 > platTop + 4, 'dropped below the platform');
});

/* ---------------- dying ---------------- */

test('spikes kill, the pit kills, and respawn returns to the checkpoint', () => {
  const lv = lvOf();
  const b = grounded(lv);
  b.x = 7 * TILE + TILE / 2;    // the floating spike at (7, ROWS-6)
  b.y = (ROWS - 6) * TILE + TILE / 2;
  const ev = stepPlayer(b, IDLE, lv);
  assert.equal(ev.dead, 'hazard');
  assert.equal(b.dead, true);

  b.cx = 99; b.cy = 200;
  respawn(b);
  assert.equal(b.dead, false);
  assert.deepEqual([b.x, b.y], [99, 200]);
  assert.equal(b.inv, SPAWN_INVULN);

  const faller = makeBody(lv, 'rex', 0);
  faller.x = 14 * TILE + 16;    // over the pit
  let cause = null;
  for (let i = 0; i < 400 && !cause; i++) cause = stepPlayer(faller, IDLE, lv).dead;
  assert.equal(cause, 'pit');
  assert.equal(faller.dead, true);
});

test('a dead body ignores input and scenery, and claims nothing', () => {
  const lv = lvOf();
  const b = grounded(lv);
  kill(b);
  steps(b, press({ right: true, jump: true, held: true }), 200, lv);
  assert.ok(b.y > ROWS * TILE, 'fell out of the world unimpeded');
  assert.equal(collectCoins(b, lv, new Set()).length, 0);
  assert.equal(touchFlag(b, lv), false);
  assert.equal(touchCheckpoint(b, lv), null);
});

/* ---------------- pickups & goals ---------------- */

test('coins collect once and only in reach', () => {
  const lv = lvOf();
  const b = grounded(lv);
  const collected = new Set();
  assert.equal(collectCoins(b, lv, collected).length, 0, 'far away: nothing');
  b.x = lv.coins[0].x;
  b.y = lv.coins[0].y;
  assert.deepEqual(collectCoins(b, lv, collected), [0]);
  collected.add(0);
  assert.equal(collectCoins(b, lv, collected).length, 0, 'already banked');
});

test('checkpoints and the flag trigger by proximity', () => {
  const lv = lvOf();
  const b = grounded(lv);
  assert.equal(touchCheckpoint(b, lv), null);
  b.x = lv.checkpoints[0].x;
  b.y = lv.checkpoints[0].y;
  assert.ok(touchCheckpoint(b, lv));
  assert.equal(touchFlag(b, lv), false);
  b.x = lv.flag.x;
  assert.equal(touchFlag(b, lv), true);
});

/* ---------------- enemies ---------------- */

test('a walker patrols the floor and turns at the pit instead of falling in', () => {
  const lv = lvOf();
  const e = { i: 0, type: 'walker', x: 5 * TILE, y: GROUND_TOP - 16, dir: 1, vy: 0, alive: true };
  for (let i = 0; i < 900; i++) stepEnemy(e, lv);
  assert.equal(e.alive, true, 'still with us');
  assert.ok(e.x < 14 * TILE, 'never walked into the pit');
  assert.ok(e.x > 0, 'never walked through the level wall');
  assert.ok(e.y + ENEMY.walker.h / 2 <= GROUND_TOP + 0.01, 'on the floor, not in it');
});

test('stomps are for falling feet, and never for spikers', () => {
  const bodyAt = (x, y) => ({ x, y, vx: 0, vy: 0, dead: false, inv: 0 });
  const walker = { i: 0, type: 'walker', x: 100, y: 100, dir: 1, vy: 0, alive: true };

  const stomper = { ...bodyAt(100, 80), vy: 4 };
  assert.equal(hitEnemy(stomper, walker), 'stomp');

  const walkIn = bodyAt(110, 100);
  assert.equal(hitEnemy(walkIn, walker), 'hurt');

  const spiker = { i: 1, type: 'spiker', x: 100, y: 100, dir: 1, vy: 0, alive: true };
  assert.equal(hitEnemy(stomper, spiker), 'hurt', 'landing on a spiker hurts');

  assert.equal(hitEnemy({ ...walkIn, inv: 10 }, walker), null, 'spawn protection shrugs off a walk-in');
  assert.equal(hitEnemy({ ...stomper, inv: 10 }, walker), 'stomp', '…but still allows the stomp');

  assert.equal(hitEnemy(stomper, { ...walker, alive: false }), null, 'the dead cannot be re-stomped');
  assert.equal(hitEnemy({ ...stomper, dead: true }, walker), null, 'nor stomp anything');
});

/* ---------------- the shared run ---------------- */

test('the run referees claims: once each, and the first flag wins', () => {
  const run = createRun('meadow', 2);
  assert.equal(run.worldId, 'meadow');

  assert.equal(applyCoin(run, 0, 0), true);
  assert.equal(applyCoin(run, 1, 0), false, 'second claim on the same coin loses');
  assert.equal(applyCoin(run, 0, -1), false);
  assert.equal(applyCoin(run, 0, 9999), false);
  assert.equal(run.scores[0].c, 1);
  assert.equal(run.scores[1].c, 0);

  // find a real ?-block in the meadow grid
  let q = null;
  for (let ty = 0; ty < run.lv.h && !q; ty++) {
    const tx = run.lv.grid[ty].indexOf('?');
    if (tx >= 0) q = { tx, ty };
  }
  assert.ok(q, 'meadow has a ?-block');
  assert.equal(applyBump(run, 1, q.tx, q.ty), true);
  assert.equal(applyBump(run, 0, q.tx, q.ty), false, 'a block spends once');
  assert.equal(applyBump(run, 0, 0, 0), false, 'a non-block bumps nothing');
  assert.equal(run.scores[1].c, 1, 'the bump paid a coin');

  const walkerIdx = run.enemies.findIndex((e) => e.type === 'walker');
  assert.ok(walkerIdx >= 0);
  assert.equal(applyStomp(run, 0, walkerIdx), true);
  assert.equal(applyStomp(run, 1, walkerIdx), false, 'an enemy dies once');
  assert.equal(run.scores[0].s, 1);

  applyDeath(run, 1);
  assert.equal(run.scores[1].d, 1);

  assert.equal(applyFlag(run, 1), true);
  assert.equal(applyFlag(run, 0), false, 'the flag is already claimed');
  assert.equal(run.clearBy, 1);
});

test('spikers refuse to be stomp-scored', () => {
  // The cavern has spikers; the referee must not pay out for one.
  const run = createRun('cavern', 1);
  const spikerIdx = run.enemies.findIndex((e) => e.type === 'spiker');
  assert.ok(spikerIdx >= 0, 'cavern has a spiker');
  assert.equal(applyStomp(run, 0, spikerIdx), false);
  assert.equal(run.enemies[spikerIdx].alive, true);
});

test('the world tour advances and wraps', () => {
  const ids = WORLDS.map((w) => w.id);
  for (let i = 0; i < ids.length; i++) {
    assert.equal(nextWorldId(ids[i]), ids[(i + 1) % ids.length]);
  }
});
