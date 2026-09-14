// Tests for the Meridian Bros rules and worlds.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TILE, ROWS, WORLDS, HARD_WORLDS, WORLD_BY_ID, parseWorld, tileAt,
  CHARACTERS, CHAR_IDS, PLAYER_H, ENEMY,
  GRAVITY, COYOTE, JUMP_CUT, SPAWN_INVULN, SPRING_VY, BUFF_STEPS, COINS_PER_LIFE,
  makeBody, stepPlayer, kill, hurt, respawn, eatPickup, hasBuff,
  collectCoins, collectGems, collectPickups, touchCheckpoint, touchFlag,
  stepEnemy, hitEnemy,
  createRun, applyCoin, applyBump, applyGem, applyPickup, applyStomp, applyDeath, applyFlag,
  nextWorldId, moverPos, windAt, laserPhase, LASER_PERIOD, LASER_ON,
  applyKey, unlockedWorlds, recordClear, fmtTime,
  isOut, livesOf, checkWipe,
} from '../js/games/bros/rules.js';
import { solidAt, hazardAt, registerCustom } from '../js/games/bros/levels.js';
import { encodeLevel, decodeLevel, sanitiseLevel } from '../js/games/bros/share.js';

/* ---------------- helpers ---------------- */

/**
 * A tiny hand-built world, so a test about physics is only about physics.
 * 16 columns, ROWS tall. The floor spans columns 0–13 with a pit at 14–15;
 * above it: a one-way platform, a ?-block, a floating spike (off the running
 * lane, so tests that sprint along the floor don't die by set dressing),
 * a coin, a checkpoint and the flag. A gem, a heart block and a speed
 * pickup sit high up the left side, and column 12's floor is a spring.
 *
 *   col:  0123456789012345
 *         ..G.........      ROWS-9   gem (2)
 *         ......@.....      ROWS-8   heart block (6)
 *         ....=..^....      ROWS-6   platform (4), spike (7)
 *         .?..Z.......      ROWS-5   ?-block (1), speed pickup (4)
 *         ......o.....      ROWS-4   coin (6)
 *         .S......C.F.      ROWS-3   spawn (1), checkpoint (8), flag (10)
 *         ############!#..  ROWS-2   floor, spring at 12, pit at 14–15
 *         ##############..  ROWS-1
 */
function tinyWorld({ ice = false, lives } = {}) {
  const r = (s) => s.padEnd(16, '.');
  const map = Array.from({ length: ROWS }, () => r(''));
  map[ROWS - 9] = r('..G');
  map[ROWS - 8] = r('......@');
  map[ROWS - 6] = r('....=..^');
  map[ROWS - 5] = r('.?..Z');
  map[ROWS - 4] = r('......o');
  map[ROWS - 3] = r('.S......C.F');
  map[ROWS - 2] = r('############!#');
  map[ROWS - 1] = r('##############');
  return { id: 'tiny', name: 'Tiny', sub: '', ice, lives, palette: {}, map };
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
    assert.equal(lv.gems.length, 3, `${w.id}: exactly three gems`);
    assert.ok(lv.pickups.some((p) => p.type === 'heart'), `${w.id}: has a heart block`);
    // No row was silently padded — a short row means a run-length miscount.
    for (const row of w.map) assert.equal(row.length, lv.w, `${w.id}: every row is exactly ${lv.w} wide`);
    // Nothing solid may be placed inside the ground rows' neighbours such that
    // an entity is embedded in rock — every lifted entity sits in air.
    for (const list of [lv.coins, lv.gems, lv.checkpoints, lv.enemies]) {
      for (const p of list) {
        assert.ok('.w'.includes(tileAt(lv, Math.floor(p.x / TILE), Math.floor(p.y / TILE))), `${w.id}: entity at ${p.x},${p.y} sits in air or water`);
      }
    }
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
  assert.equal(lv.gems.length, 1);
  assert.equal(lv.pickups.length, 2);
  for (const row of lv.grid) {
    assert.ok(!/[SoECXFGZWN]/.test(row), 'no entity glyphs left behind in the grid');
  }
  const heart = lv.pickups.find((p) => p.type === 'heart');
  assert.equal(heart.block, `6,${ROWS - 8}`, 'the heart remembers its block');
  assert.equal(heart.y, (ROWS - 9) * TILE + TILE / 2, 'and pops out on top of it');
  assert.equal(tileAt(lv, 6, ROWS - 8), '@', 'the block itself stays solid in the grid');

  const pool = parseWorld(ruinsWorld());
  assert.equal(tileAt(pool, 10, ROWS - 3), 'w', 'the key\'s cell heals back to water');
  assert.equal(pool.keys.length, 1);
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

test('a spring launches far higher than any jump, and the cut cannot shorten it', () => {
  const lv = lvOf();
  const b = makeBody(lv, 'sunny', 0);
  b.x = 12 * TILE + TILE / 2;
  b.y = GROUND_TOP - 60;
  let sprung = false;
  for (let i = 0; i < 30 && !sprung; i++) sprung = stepPlayer(b, IDLE, lv).spring;
  assert.ok(sprung, 'landing on the spring fired it');
  assert.ok(b.vy < -SPRING_VY + 1, 'launched at spring speed');
  let top = b.y;
  for (let i = 0; i < 80; i++) { stepPlayer(b, IDLE, lv); top = Math.min(top, b.y); }   // never holding jump
  const rise = (GROUND_TOP - PLAYER_H / 2) - top;
  assert.ok(rise > TILE * 6, `rose ${rise.toFixed(0)}px — more than six tiles`);
  assert.ok(rise > CHARACTERS.gil.jump ** 2 / (2 * GRAVITY), 'higher than even Gil can jump');
});

test('a heart shard absorbs one hit, then spikes kill', () => {
  const lv = lvOf();
  const b = grounded(lv);
  eatPickup(b, 'heart');
  assert.equal(b.hp, 2);
  b.x = 7 * TILE + TILE / 2;
  b.y = (ROWS - 6) * TILE + TILE / 2;
  b.vy = 0;
  const ev = stepPlayer(b, IDLE, lv);
  assert.equal(ev.hurt, true, 'the spike took the shard');
  assert.equal(ev.dead, null);
  assert.equal(b.hp, 1);
  assert.equal(b.inv, SPAWN_INVULN, 'and granted a moment of mercy');
  b.inv = 0;
  const ev2 = stepPlayer(b, IDLE, lv);
  assert.equal(ev2.dead, 'hazard', 'the second touch is fatal');
  assert.equal(hurt({ ...b, dead: false, hp: 1, inv: 5 }), 'shrug', 'invulnerable bodies shrug hits off');
});

test('lava ignores shards; the ward ignores spikes', () => {
  const lava = lvOf();
  lava.grid[ROWS - 6] = lava.grid[ROWS - 6].slice(0, 7) + '~' + lava.grid[ROWS - 6].slice(8);
  const b = grounded(lava);
  eatPickup(b, 'heart');
  b.x = 7 * TILE + TILE / 2; b.y = (ROWS - 6) * TILE + TILE / 2; b.vy = 0;
  assert.equal(stepPlayer(b, IDLE, lava).dead, 'hazard', 'lava kills a shard-holder outright');

  const lv = lvOf();
  const w = grounded(lv);
  eatPickup(w, 'ward');
  assert.ok(hasBuff(w, 'ward'));
  w.x = 7 * TILE + TILE / 2; w.y = (ROWS - 6) * TILE + TILE / 2; w.vy = 0;
  const ev = stepPlayer(w, IDLE, lv);
  assert.equal(ev.dead, null);
  assert.equal(ev.hurt, false);
  assert.equal(w.dead, false, 'warded: walked through the spikes');
});

test('buffs run out, and the speed surge really is faster', () => {
  const lv = lvOf();
  const b = grounded(lv, 'rex');
  eatPickup(b, 'speed');
  steps(b, press({ right: true }), 60, lv);
  assert.ok(b.vx > CHARACTERS.rex.speed, 'surging past the normal cap');
  steps(b, IDLE, BUFF_STEPS, lv);
  assert.equal(b.buff, null, 'the surge expired');
  steps(b, press({ left: true }), 60, lv);          // back the way we came: the pit is to the right
  assert.equal(b.vx, -CHARACTERS.rex.speed, 'back to the normal cap');
});

test('the magnet widens the coin reach', () => {
  const lv = lvOf();
  const b = grounded(lv);
  b.x = lv.coins[0].x - 60;
  b.y = lv.coins[0].y;
  assert.equal(collectCoins(b, lv, new Set()).length, 0, 'out of ordinary reach');
  eatPickup(b, 'magnet');
  assert.deepEqual(collectCoins(b, lv, new Set()), [0], 'pulled in by the magnet');
});

test('gems and pickups collect by proximity; hearts wait for their block', () => {
  const lv = lvOf();
  const b = grounded(lv);
  assert.equal(collectGems(b, lv, new Set()).length, 0);
  b.x = lv.gems[0].x; b.y = lv.gems[0].y;
  assert.deepEqual(collectGems(b, lv, new Set()), [0]);

  const heartIdx = lv.pickups.findIndex((p) => p.type === 'heart');
  const heart = lv.pickups[heartIdx];
  b.x = heart.x; b.y = heart.y;
  assert.equal(collectPickups(b, lv, new Set(), new Set()).length, 0, 'still inside the block');
  assert.deepEqual(collectPickups(b, lv, new Set(), new Set([heart.block])), [heartIdx], 'out once bumped');
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

test('gems, pickups and hearts are refereed like coins', () => {
  const run = createRun('meadow', 2);
  assert.equal(applyGem(run, 0, 0), true);
  assert.equal(applyGem(run, 1, 0), false, 'a gem is taken once');
  assert.equal(run.scores[0].g, 1);

  const heartIdx = run.lv.pickups.findIndex((p) => p.type === 'heart');
  assert.ok(heartIdx >= 0, 'meadow has a heart block');
  assert.equal(applyPickup(run, 0, heartIdx), false, 'the heart is still in its block');
  const [tx, ty] = run.lv.pickups[heartIdx].block.split(',').map(Number);
  assert.equal(applyBump(run, 0, tx, ty), true, 'bumping the @ block opens it');
  assert.equal(run.scores[0].c, 0, 'but pays no coin');
  assert.equal(applyPickup(run, 1, heartIdx), true, 'now it can be taken');
  assert.equal(applyPickup(run, 0, heartIdx), false, 'once');
});

/** Bank team coins — every coin on the map, then ?-blocks — up to exactly
 *  one 1-up's worth. */
function earnOneUp(run) {
  const goal = run.coinsTotal + COINS_PER_LIFE - (run.coinsTotal % COINS_PER_LIFE);
  for (let i = 0; i < run.lv.coins.length && run.coinsTotal < goal; i++) applyCoin(run, i % 2, i);
  for (let ty = 0; ty < run.lv.h && run.coinsTotal < goal; ty++) {
    for (let tx = 0; tx < run.lv.w && run.coinsTotal < goal; tx++) {
      if (tileAt(run.lv, tx, ty) === '?') applyBump(run, 0, tx, ty);
    }
  }
  assert.equal(run.coinsTotal, goal, 'the map holds enough coins for a 1-up');
}

test('each player has their own lives, and a death costs only the one who died', () => {
  const run = createRun('meadow', 3);
  const start = WORLD_BY_ID.get('meadow').lives;
  assert.equal(start, 5);
  assert.deepEqual(run.lives, [5, 5, 5]);
  assert.equal(applyDeath(run, 1), true);
  assert.deepEqual(run.lives, [5, 4, 5]);
  assert.equal(livesOf(run, 1), 4);
  assert.equal(run.scores[1].d, 1);
});

test('a player on no lives is out, but the run goes on while anyone has one', () => {
  const run = createRun('meadow', 2);
  for (let i = 0; i < 5; i++) assert.equal(applyDeath(run, 0), true);
  assert.equal(isOut(run, 0), true);
  assert.equal(isOut(run, 1), false);
  assert.equal(run.over, false, 'one player out is not game over');
  assert.equal(applyDeath(run, 0), false, 'an out player has nothing left to lose');
  assert.equal(run.scores[0].d, 5, 'and the refused death is not scored');
});

test('a 1-up is for everyone, and brings a player who was out back in', () => {
  const run = createRun('meadow', 2);
  for (let i = 0; i < 5; i++) applyDeath(run, 0);
  applyDeath(run, 1);
  assert.deepEqual(run.lives, [0, 4]);
  earnOneUp(run);
  assert.deepEqual(run.lives, [1, 5], `${COINS_PER_LIFE} team coins is a 1-up each`);
  assert.equal(isOut(run, 0), false, 'back in the game');
});

test('the run ends only when every player is out', () => {
  const run = createRun('meadow', 2);
  for (let i = 0; i < 5; i++) applyDeath(run, 0);
  for (let i = 0; i < 4; i++) applyDeath(run, 1);
  assert.equal(run.over, false);
  applyDeath(run, 1);
  assert.deepEqual(run.lives, [0, 0]);
  assert.equal(run.over, true, 'everyone out');
  assert.equal(applyDeath(run, 0), false);
  assert.equal(applyFlag(run, 0), false, 'and the flag no longer counts');
});

test('a player who disconnects does not hold a lost run open', () => {
  const run = createRun('meadow', 2);
  for (let i = 0; i < 5; i++) applyDeath(run, 0, [0]);    // seat 1 has left the room
  assert.equal(run.over, true);

  const still = createRun('meadow', 2);
  for (let i = 0; i < 5; i++) applyDeath(still, 0);
  assert.equal(still.over, false, 'with seat 1 still here, it still has lives');
  assert.equal(checkWipe(still, [0]), true, 'until seat 1 goes');
  assert.equal(still.over, true);
});

test('hard worlds give each player their own three lives', () => {
  const run = createRun('meadow-hard', 2);
  assert.deepEqual(run.lives, [3, 3]);
});

test('races have no lives, and coins never hand any out', () => {
  const run = createRun('meadow', 2, { race: true });
  assert.equal(run.lives, null);
  earnOneUp(run);
  assert.equal(run.lives, null);
  for (let i = 0; i < 12; i++) assert.equal(applyDeath(run, 0), true, 'a death in a race just costs time');
  assert.equal(run.over, false);
  assert.equal(isOut(run, 0), false);
});

test('spikers refuse to be stomp-scored', () => {
  // The cavern has spikers; the referee must not pay out for one.
  const run = createRun('cavern', 1);
  const spikerIdx = run.enemies.findIndex((e) => e.type === 'spiker');
  assert.ok(spikerIdx >= 0, 'cavern has a spiker');
  assert.equal(applyStomp(run, 0, spikerIdx), false);
  assert.equal(run.enemies[spikerIdx].alive, true);
});

/* ---------------- the clockwork: movers, wind, updrafts, flyers ---------------- */

function windyWorld({ wind = 0 } = {}) {
  const r = (s) => s.padEnd(24, '.');
  const map = Array.from({ length: ROWS }, () => r(''));
  //   col: 012345678901234567890123
  map[ROWS - 8] = r('..........uu');              // updraft column at 10–11, rows ROWS-8..ROWS-3
  map[ROWS - 7] = r('..........uu');
  map[ROWS - 6] = r('..........uu.......Y');       // flyer at 19
  map[ROWS - 5] = r('..........uu');
  map[ROWS - 4] = r('..........uu');
  map[ROWS - 3] = r('.S........uu..M-----');       // mover at 14, rail 15–19 (same row as the floor top!)
  map[ROWS - 2] = r('########..........######');   // floor 0–7, pit 8–17, floor 18–23
  map[ROWS - 1] = r('########..........######');
  return { id: 'windy', name: 'Windy', sub: '', ice: false, wind, palette: {}, map };
}

test('movers parse their rails and ride a triangle wave on the clock', () => {
  const lv = parseWorld(windyWorld());
  assert.equal(lv.movers.length, 1);
  const m = lv.movers[0];
  assert.equal(m.x0, 14 * TILE + TILE / 2);
  assert.equal(m.x1, 19 * TILE + TILE / 2);
  assert.equal(m.y0, m.y1);
  assert.ok(!/[MV:-]/.test(lv.grid.join('')), 'rails are air once parsed');
  assert.deepEqual(moverPos(m, 0), { x: m.x0, y: m.y0 }, 'starts at the rail\'s first end');
  const xs = [];
  for (let s = 0; s < 400; s += 20) xs.push(moverPos(m, s).x);
  assert.ok(Math.max(...xs) <= m.x1 && Math.min(...xs) >= m.x0, 'never leaves the rail');
  assert.ok(xs.some((x, i) => i && x < xs[i - 1]), 'comes back the other way');
});

test('a hero lands on a mover and is carried along with it', () => {
  const lv = parseWorld(windyWorld());
  const b = makeBody(lv, 'rex', 0);
  let step = 0;
  const p0 = moverPos(lv.movers[0], step);
  b.x = p0.x; b.y = p0.y - 60; b.onGround = false;
  for (let i = 0; i < 30; i++) stepPlayer(b, IDLE, lv, ++step);
  assert.equal(b.onGround, true, 'standing on the platform');
  assert.equal(b.ride, 0);
  const xBefore = b.x;
  const offset = b.x - moverPos(lv.movers[0], step).x;
  for (let i = 0; i < 60; i++) stepPlayer(b, IDLE, lv, ++step);
  const p1 = moverPos(lv.movers[0], step);
  assert.ok(Math.abs(b.x - xBefore) > 30, 'carried sideways without any input');
  assert.ok(Math.abs((b.x - p1.x) - offset) < 0.01, 'kept its footing: same spot on the platform');
  stepPlayer(b, press({ down: true }), lv, ++step);
  for (let i = 0; i < 10; i++) stepPlayer(b, IDLE, lv, ++step);
  assert.equal(b.ride, -1, 'pressing down drops you off the platform');
  assert.ok(b.y > p1.y, 'and you fall through it');
});

test('the wind swings both ways and pushes airborne heroes more', () => {
  const world = windyWorld({ wind: 0.05 });
  const seen = new Set();
  for (let s = 0; s < 1000; s += 50) seen.add(Math.sign(windAt(world, s)));
  assert.ok(seen.has(1) && seen.has(-1), 'blows right and left over time');
  const lv = parseWorld(world);
  const air = makeBody(lv, 'rex', 0);
  air.x = 4 * TILE; air.y = 2 * TILE; air.onGround = false;
  const ground = grounded(lv);
  const step = 235;     // sin(235/150) is near its peak
  stepPlayer(air, IDLE, lv, step);
  stepPlayer(ground, IDLE, lv, step);
  assert.ok(Math.abs(air.vx) > Math.abs(ground.vx) * 2, 'a gust shoves you in the air, leans on you on the ground');
});

test('an updraft lifts you instead of letting you fall', () => {
  const lv = parseWorld(windyWorld());
  const b = makeBody(lv, 'rex', 0);
  b.x = 10 * TILE + TILE; b.y = (ROWS - 4) * TILE; b.onGround = false; b.vy = 3;
  for (let i = 0; i < 40; i++) stepPlayer(b, IDLE, lv, i);
  assert.ok(b.vy < 0, 'rising');
  assert.ok(b.y < (ROWS - 6) * TILE, 'well above where it started');
  assert.equal(b.dead, false);
});

test('flyers bob and patrol on the clock, and can be stomped', () => {
  const lv = parseWorld(windyWorld());
  const run = createRun('isles', 1);
  const flyer = run.enemies.find((e) => e.type === 'flyer');
  assert.ok(flyer, 'the isles have flyers');
  const y0 = flyer.y, x0 = flyer.x;
  const ys = new Set();
  for (let s = 1; s <= 200; s++) { stepEnemy(flyer, run.lv, s); ys.add(Math.round(flyer.y)); }
  assert.ok(ys.size > 10, 'bobbing through many heights');
  assert.ok(Math.abs(flyer.y - y0) <= ENEMY.flyer.bob + 1, 'never far from its line');
  assert.ok(Math.abs(flyer.x - x0) <= ENEMY.flyer.range + 2, 'never far from its post');
  assert.equal(applyStomp(run, 0, flyer.i), true, 'stompable');
  const local = parseWorld(windyWorld());
  assert.equal(local.enemies.find((e) => e.type === 'flyer').y, (ROWS - 6) * TILE + TILE / 2, 'Y parses as a flyer');
});

/* ---------------- water, bricks, keys, lasers, hoppers ---------------- */

function ruinsWorld() {
  const r = (s) => s.padEnd(24, '.');
  const map = Array.from({ length: ROWS }, () => r(''));
  //   col: 012345678901234567890123
  map[ROWS - 7] = r('...$$');                      // breakable bricks at 3–4
  map[ROWS - 6] = r('........LL....l');            // lasers: L at 8–9, l at 14
  map[ROWS - 5] = r('.................D');         // door column at 17, rows ROWS-5..ROWS-3
  map[ROWS - 4] = r('.......wwwwww....D');         // water pool 7–12, rows ROWS-4..ROWS-2
  map[ROWS - 3] = r('.S.....wwwKww....D..J');      // key at 10 (in water), hopper at 20
  map[ROWS - 2] = r('#######wwwwww###########');
  map[ROWS - 1] = r('########################');
  return { id: 'ruinsy', name: 'Ruinsy', sub: '', ice: false, palette: {}, map };
}

test('water slows the fall, swimming kicks, and the surface gives a full jump', () => {
  const lv = parseWorld(ruinsWorld());
  const b = makeBody(lv, 'rex', 0);
  b.x = 9 * TILE + TILE / 2; b.y = (ROWS - 4) * TILE - 4; b.onGround = false; b.vy = 10;
  stepPlayer(b, IDLE, lv);                  // this step carries the body into the water
  const ev = stepPlayer(b, IDLE, lv);       // and this one notices
  assert.equal(ev.splash, true, 'entering water splashes');
  assert.ok(b.vy <= 2.3, 'and kills the fall speed');
  steps(b, IDLE, 20, lv);
  assert.ok(b.y + PLAYER_H / 2 < (ROWS - 1) * TILE - 20, 'still sinking slowly, not on the floor yet');
  const deep = { ...b };
  stepPlayer(b, press({ jump: true, held: true }), lv);
  assert.ok(b.vy < 0 && b.vy > -6, 'a kick underwater is a small rise');
  void deep;
  // Float up to the surface and jump out.
  for (let i = 0; i < 200 && b.y > (ROWS - 4) * TILE + 4; i++) stepPlayer(b, press({ jump: i % 4 === 0, held: true }), lv);
  b.y = (ROWS - 4) * TILE + TILE / 2;      // head just under the surface
  stepPlayer(b, press({ jump: true, held: true }), lv);
  assert.ok(b.vy < -9, 'a jump at the surface is a real jump');
});

test('bricks crack, then break, then are air — for physics and the referee', () => {
  const lv = parseWorld(ruinsWorld());
  const key = `3,${ROWS - 7}`;
  const b = makeBody(lv, 'rex', 0);
  b.x = 3 * TILE + TILE / 2; b.y = (ROWS - 6) * TILE + TILE / 2 + 4; b.onGround = false; b.vy = -8;
  let bump = null;
  for (let i = 0; i < 10 && !bump; i++) bump = stepPlayer(b, press({ held: true }), lv).bump;
  assert.deepEqual(bump, { tx: 3, ty: ROWS - 7 }, 'head found the brick');

  const run = { lv, cracked: lv.cracked, broken: lv.broken, used: new Set(), scores: [], coinsTotal: 0, lives: 3 };
  assert.equal(applyBump(run, 0, 3, ROWS - 7), true);
  assert.ok(lv.cracked.has(key) && !lv.broken.has(key), 'cracked after one hit');
  assert.equal(applyBump(run, 0, 3, ROWS - 7), true);
  assert.ok(lv.broken.has(key), 'smashed after two');
  assert.equal(applyBump(run, 0, 3, ROWS - 7), false, 'nothing left to hit');

  const c = makeBody(lv, 'rex', 0);
  c.x = 3 * TILE + TILE / 2; c.y = (ROWS - 6) * TILE + TILE / 2 + 4; c.onGround = false; c.vy = -8;
  let rose = false;
  for (let i = 0; i < 10; i++) { stepPlayer(c, press({ held: true }), lv); if (c.y < (ROWS - 7) * TILE + 10) rose = true; }
  assert.ok(rose, 'and the way through is open');
});

test('a key opens the door for the whole team', () => {
  const run = createRun('ruins', 2);
  assert.ok(run.lv.keys.length >= 1, 'the ruins have a key');
  const doorTx = run.lv.grid.findIndex((r) => r.includes('D')) >= 0 ? run.lv.grid.find((r) => r.includes('D')).indexOf('D') : -1;
  const doorTy = run.lv.grid.findIndex((r) => r.includes('D'));
  assert.ok(doorTx >= 0, 'and a door');
  assert.equal(solidAt(run.lv, doorTx, doorTy), true, 'shut to begin with');
  assert.equal(applyKey(run, 1, 0), true);
  assert.equal(applyKey(run, 0, 0), false, 'one key, one pickup');
  assert.equal(run.lv.unlocked, true);
  assert.equal(solidAt(run.lv, doorTx, doorTy), false, 'open for everyone');
});

test('lasers keep time: L and l alternate, and only hurt while on', () => {
  const lv = parseWorld(ruinsWorld());
  const L = { tx: 8, ty: ROWS - 6 }, l = { tx: 14, ty: ROWS - 6 };
  let onL = 0, onl = 0, both = 0;
  for (let s = 0; s < LASER_PERIOD; s++) {
    const a = hazardAt(lv, L.tx, L.ty, s), b = hazardAt(lv, l.tx, l.ty, s);
    if (a) onL++;
    if (b) onl++;
    if (a && b) both++;
  }
  assert.equal(onL, LASER_ON);
  assert.equal(onl, LASER_ON);
  assert.equal(both, 0, 'never both at once');
  assert.equal(hazardAt(lv, L.tx, L.ty), 'sharp', 'with no clock a beam is always dangerous (enemies avoid it)');

  const b = makeBody(lv, 'rex', 0);
  b.x = 8 * TILE + TILE / 2; b.y = (ROWS - 6) * TILE + TILE / 2; b.onGround = false; b.vy = 0;
  const offStep = LASER_ON + 5;
  assert.equal(laserPhase('L', offStep), 'off');
  const evOff = stepPlayer(b, IDLE, lv, offStep);
  assert.equal(evOff.dead, null);
  assert.equal(b.dead, false, 'off: harmless');
  b.y = (ROWS - 6) * TILE + TILE / 2; b.vy = 0;
  const evOn = stepPlayer(b, IDLE, lv, 2);
  assert.equal(evOn.dead, 'hazard', 'on: deadly without a shard');
});

test('hoppers walk like walkers and leap on a beat', () => {
  const lv = parseWorld(ruinsWorld());
  const run = createRun('sprawl', 1);
  const e = run.enemies.find((x) => x.type === 'hopper');
  assert.ok(e, 'the sprawl has hoppers');
  let airborne = 0, floorY = null;
  for (let s = 1; s <= 400; s++) {
    stepEnemy(e, run.lv, s);
    if (floorY === null && e.vy === 0) floorY = e.y;
    if (floorY !== null && e.y < floorY - 20) airborne++;
  }
  assert.ok(airborne > 20, 'spent real time in the air');
  assert.equal(e.alive, true);
  assert.equal(applyStomp(run, 0, e.i), true, 'stompable');
  const local = parseWorld(ruinsWorld());
  assert.equal(local.enemies.find((x) => x.type === 'hopper').x, 20 * TILE + TILE / 2, 'J parses as a hopper');
  void lv;
});

/* ---------------- the boss, the race, the campaign ---------------- */

test('the boss takes three stomps, reels between them, and opens the gate', () => {
  const run = createRun('reactor', 2);
  const boss = run.enemies.find((e) => e.type === 'boss');
  assert.ok(boss, 'the reactor has a boss');
  assert.equal(boss.hp, ENEMY.boss.hp);
  const doorTy = run.lv.grid.findIndex((r) => r.includes('D'));
  const doorTx = run.lv.grid[doorTy].indexOf('D');
  assert.equal(solidAt(run.lv, doorTx, doorTy), true, 'the gate is shut');

  const stomper = { x: boss.x, y: boss.y - 30, vx: 0, vy: 4, dead: false, inv: 0 };
  assert.equal(hitEnemy(stomper, boss), 'stomp');
  assert.equal(applyStomp(run, 0, boss.i), true);
  assert.equal(boss.hp, 2);
  assert.equal(boss.alive, true, 'still standing');
  assert.ok(boss.hurtT > 0, 'reeling');
  assert.equal(hitEnemy(stomper, boss), null, 'reeling: no second stomp yet, and harmless to touch');
  assert.equal(applyStomp(run, 1, boss.i), false, 'the referee agrees');

  const x0 = boss.x;
  for (let s = 1; s <= ENEMY.boss.stun; s++) stepEnemy(boss, run.lv, s);
  assert.ok(Math.abs(boss.x - x0) < 2, 'did not move while stunned (bar the step the stun wore off)');
  assert.equal(boss.hurtT, 0);
  for (let s = 1; s <= 60; s++) stepEnemy(boss, run.lv, s);
  assert.ok(Math.abs(boss.x - x0) > 30, 'back on the move, and faster');

  assert.equal(applyStomp(run, 0, boss.i), true);
  boss.hurtT = 0;
  assert.equal(applyStomp(run, 1, boss.i), true);
  assert.equal(boss.alive, false, 'down');
  assert.equal(run.bossDown, true);
  assert.equal(run.lv.unlocked, true);
  assert.equal(solidAt(run.lv, doorTx, doorTy), false, 'and the gate is open');
  assert.equal(run.scores[0].s + run.scores[1].s, 3, 'every hit scored');
});

test('a race has no shared lives, and records who was first', () => {
  const run = createRun('meadow', 3, { race: true });
  assert.equal(run.lives, null);
  for (let i = 0; i < 20; i++) applyDeath(run, i % 3);
  assert.equal(run.over, false, 'deaths never end a race');
  run.steps = 61 * 60;
  assert.equal(applyFlag(run, 2), true);
  assert.equal(run.clearBy, 2);
  assert.equal(run.clearSteps, 61 * 60);
  assert.equal(fmtTime(run.clearSteps / 60), '1:01');
});

test('clearing a world unlocks the next; the record keeps best gems and time', () => {
  let progress = { all: false, cleared: {} };
  assert.deepEqual([...unlockedWorlds(progress)], [WORLDS[0].id], 'only the first world at the start');

  const run = createRun(WORLDS[0].id, 1);
  run.gems.add(0); run.gems.add(1);
  run.steps = 90 * 60; applyFlag(run, 0);
  progress = recordClear(progress, run);
  assert.deepEqual(progress.cleared[WORLDS[0].id], { gems: 2, best: 90 });
  assert.ok(unlockedWorlds(progress).has(WORLDS[1].id), 'the second world opens');
  assert.ok(!unlockedWorlds(progress).has(WORLDS[2].id), 'but not the third');

  const again = createRun(WORLDS[0].id, 1);
  again.gems.add(2);
  again.steps = 120 * 60; applyFlag(again, 0);
  progress = recordClear(progress, again);
  assert.deepEqual(progress.cleared[WORLDS[0].id], { gems: 2, best: 90 }, 'a slower run with fewer gems changes nothing');

  assert.ok(unlockedWorlds(progress).has(WORLDS[0].id + '-hard'), 'and so does its hard variant');
  assert.ok(!unlockedWorlds(progress).has(WORLDS[1].id + '-hard'), 'but not the next one\'s');
  assert.equal(unlockedWorlds({ all: true, cleared: {} }).size, WORLDS.length + HARD_WORLDS.length, '"unlock everything" opens the lot');
});

test('hard variants keep the layout, cut the lives, and add trouble', () => {
  assert.equal(HARD_WORLDS.length, 4);
  for (const h of HARD_WORLDS) {
    const base = WORLDS.find((w) => w.id === h.base);
    assert.ok(base, `${h.id} has a base world`);
    assert.equal(h.lives, 3);
    assert.ok(h.par > base.par);
    const lv = parseWorld(h), blv = parseWorld(base);
    assert.equal(lv.w, blv.w);
    assert.equal(lv.gems.length, 3);
    assert.ok(lv.enemies.length > blv.enemies.length, `${h.id}: more enemies`);
    assert.ok(lv.enemies.filter((e) => e.type === 'spiker').length > blv.enemies.filter((e) => e.type === 'spiker').length, `${h.id}: more spikers`);
    assert.deepEqual(lv.flag, blv.flag, 'same flag');
    for (const row of h.map) assert.equal(row.length, lv.w);
  }
});

/* ---------------- level codes ---------------- */

test('a level survives the trip through a share code', () => {
  const def = { name: 'Pit; of doom', theme: 'cavern', ice: false, wind: true, lives: 3, par: 60, map: WORLDS[0].map };
  const code = encodeLevel(def);
  assert.ok(code.startsWith('MB1;'));
  assert.ok(code.length < WORLDS[0].map.join('').length / 4, 'far shorter than the raw rows');
  const back = decodeLevel(code);
  assert.deepEqual(back.map, WORLDS[0].map);
  assert.equal(back.name, 'Pit; of doom');
  assert.equal(back.theme, 'cavern');
  assert.equal(back.wind, true);
  assert.equal(back.lives, 3);
  assert.equal(back.par, 60);
  assert.equal(decodeLevel(code).id, back.id, 'the same content gets the same id');
  const world = registerCustom(back);
  assert.equal(world.palette, WORLD_BY_ID.get('cavern').palette, 'borrows the theme\'s palette');
  assert.ok(world.wind > 0, 'and its wind, when asked');
  const lv = parseWorld(world);
  assert.equal(lv.w, 150);
  assert.equal(lv.gems.length, 3);
});

test('level codes are checked before anyone plays them', () => {
  const rows = (fn) => Array.from({ length: ROWS }, (_, y) => fn(y).padEnd(40, '.'));
  const ok = rows((y) => (y === ROWS - 3 ? '.S....F' : y >= ROWS - 2 ? '#'.repeat(40) : ''));
  assert.equal(sanitiseLevel({ name: 'x', theme: 'meadow', map: ok }).map.length, ROWS);
  assert.throws(() => sanitiseLevel({ name: 'x', theme: 'meadow', map: rows((y) => (y >= ROWS - 2 ? '#'.repeat(40) : '')) }), /start/);
  assert.throws(() => sanitiseLevel({ name: 'x', theme: 'meadow', map: rows((y) => (y === ROWS - 3 ? '.S.S..F' : '')) }), /one start/);
  assert.throws(() => sanitiseLevel({ name: 'x', theme: 'meadow', map: rows((y) => (y === ROWS - 3 ? '.S....Fz' : '')) }), /Unknown tile/);
  assert.throws(() => sanitiseLevel({ name: 'x', theme: 'meadow', map: ['S...F'] }), /at least/);
  assert.throws(() => decodeLevel('hello'), /level code/);
  assert.throws(() => decodeLevel('MB1;n;meadow;;5;;150./150.'), /start/);
  const themed = sanitiseLevel({ name: 'x', theme: 'nope', map: ok });
  assert.equal(themed.theme, WORLDS[0].id, 'an unknown theme falls back to the first world');
  assert.equal(sanitiseLevel({ name: 'x', theme: 'meadow', lives: 500, map: ok }).lives, 5, 'silly lives are reset');
});

test('the world tour advances and wraps', () => {
  const ids = WORLDS.map((w) => w.id);
  for (let i = 0; i < ids.length; i++) {
    assert.equal(nextWorldId(ids[i]), ids[(i + 1) % ids.length]);
  }
});
