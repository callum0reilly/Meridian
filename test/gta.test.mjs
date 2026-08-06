// Tests for the GTA: Dublin rules and city geometry.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createState, addPlayer, applyLeave,
  setFootInput, setDriveInput, applyFire, applyUse,
  step, stepCarPhysics, damageCar, wantedOf, secs,
  PLAYER_R, CAR_R,
} from '../js/games/gta/rules.js';
import {
  fits, hasLOS, spawnPoint,
  BLOCKS, PARKED, MISSION_DEFS, HOSPITAL_SPAWN,
} from '../js/games/gta/city.js';

/* ---------------- helpers ---------------- */

const SEATS = [
  { id: 'host', name: 'Cal', color: 'red' },
  { id: 'c2', name: 'Byrne', color: 'blue' },
];

const mk = (seats = SEATS, seed = 42) => createState(seats, { seed });
const run = (g, n) => { for (let i = 0; i < n; i++) step(g); };

/** Park a player somewhere specific for a test. */
const put = (g, id, x, y, yaw = 0) => {
  const p = g.players[id];
  p.x = x; p.y = y; p.yaw = yaw;
  return p;
};

/** Kill the ambient pedestrians so a test about shooting is only about the
    target it planted. */
const clearPeds = (g) => {
  for (const ped of g.peds) { ped.dead = true; ped.respawnAt = Infinity; }
};

/* ---------------- geometry ---------------- */

test('the city is standable where it should be, and not where it should not', () => {
  assert.equal(fits(1655, 660, PLAYER_R), true);   // spawn plaza
  assert.equal(fits(200, 280, PLAYER_R), false);   // inside a terrace block
  assert.equal(fits(1000, 940, PLAYER_R), false);  // in the Liffey
  assert.equal(fits(1540, 940, CAR_R), true);      // on O'Connell Bridge
});

test('buildings block line of sight; open street does not', () => {
  assert.equal(hasLOS(1300, 660, 1460, 660), false);  // through the GPO
  assert.equal(hasLOS(150, 60, 300, 60), true);
});

test('every spawn point, parked car and mission marker is on walkable ground', () => {
  for (let i = 0; i < 8; i++) {
    const at = spawnPoint(i);
    assert.equal(fits(at.x, at.y, PLAYER_R), true, `spawn ${i}`);
  }
  for (const p of PARKED) {
    assert.equal(fits(p.x, p.y, CAR_R), true, `parked at ${p.x},${p.y}`);
  }
  for (const def of MISSION_DEFS) {
    assert.equal(fits(def.marker.x, def.marker.y, PLAYER_R), true, `marker ${def.id}`);
  }
});

/* ---------------- setup ---------------- */

test('createState deals players, traffic and pedestrians onto valid ground', () => {
  const g = mk();
  assert.equal(Object.keys(g.players).length, 2);
  for (const p of Object.values(g.players)) {
    assert.equal(fits(p.x, p.y, PLAYER_R), true);
    assert.equal(p.hp, 100);
    assert.equal(p.money, 0);
  }
  assert.equal(g.cars.length, PARKED.length + 8);
  for (const c of g.cars) assert.equal(fits(c.x, c.y, CAR_R), true, `car ${c.id}`);
  assert.equal(g.peds.length, 14);
});

test('the same seed builds the same city twice', () => {
  const a = mk(SEATS, 7), b = mk(SEATS, 7);
  assert.deepEqual(a.peds.map((p) => [p.x, p.y]), b.peds.map((p) => [p.x, p.y]));
  assert.deepEqual(a.cars.map((c) => c.model), b.cars.map((c) => c.model));
});

/* ---------------- on foot ---------------- */

test('walking moves you, sprinting moves you faster', () => {
  const g = mk();
  const p = put(g, 'host', 150, 60);
  setFootInput(g, 'host', 1, 0, false);
  run(g, 10);
  const walked = p.x - 150;
  assert.ok(walked > 50, `walked ${walked}`);

  put(g, 'host', 150, 60);
  setFootInput(g, 'host', 1, 0, true);
  run(g, 10);
  assert.ok(p.x - 150 > walked, 'sprint should outrun a walk');
});

test('walls stop you, and a diagonal slides along them', () => {
  const g = mk();
  const p = put(g, 'host', 360, 280);       // just east of a terrace block
  setFootInput(g, 'host', -1, 0, false);
  run(g, 40);
  assert.ok(p.x > 351, `pushed into the wall to ${p.x}`);

  const y0 = p.y;
  setFootInput(g, 'host', -1, 1, false);
  run(g, 10);
  assert.ok(p.y > y0, 'should slide south along the wall');
  assert.ok(p.x > 351, 'still outside the wall');
});

/* ---------------- cars ---------------- */

test('car physics: top speed is clamped and steering turns the nose', () => {
  const car = { x: 2200, y: 1040, yaw: 0, speed: 0, kind: 'civ' };
  let top = 0;
  for (let i = 0; i < 60; i++) {
    stepCarPhysics(car, 0, 1);
    top = Math.max(top, Math.abs(car.speed));
  }
  assert.ok(top <= 26.01, `top speed ${top}`);

  const yaw0 = car.yaw;
  for (let i = 0; i < 10; i++) stepCarPhysics(car, 1, 1);
  assert.ok(car.yaw > yaw0, 'steering right should raise yaw');
});

test('hitting a wall reports an impact and kills the speed', () => {
  const car = { x: 380, y: 280, yaw: Math.PI, speed: 20, kind: 'civ' };
  let impact = 0;
  for (let i = 0; i < 5; i++) impact = Math.max(impact, stepCarPhysics(car, 0, 0));
  assert.ok(impact > 0, 'no impact reported');
  assert.ok(Math.abs(car.speed) < 20, 'speed should not survive the wall');
});

test('enter a parked car, drive it, get back out', () => {
  const g = mk();
  const car = g.cars.find((c) => c.x === 2380 && c.y === 440);
  assert.ok(car, 'the Mater kerb car exists');
  const p = put(g, 'host', 2380, 480);

  const res = applyUse(g, 'host');
  assert.equal(res?.entered, car.id);
  assert.equal(p.carId, car.id);
  assert.equal(car.driver, 'host');

  setDriveInput(g, 'host', 0, 1);
  run(g, secs(1));
  assert.ok(car.y > 520, `drove to y=${car.y}`);
  // The body syncs to the car at the top of each tick, so it can trail by
  // at most one tick of travel.
  assert.ok(Math.abs(p.y - car.y) < 30, 'the body rides with the car');

  const out = applyUse(g, 'host');
  assert.ok(out?.exited);
  assert.equal(p.carId, null);
  assert.equal(car.driver, null);
});

test('carjacking a driven car heats you up', () => {
  const g = mk();
  const traffic = g.cars.find((c) => c.driver === 'ai');
  put(g, 'host', traffic.x, traffic.y - 40);
  const res = applyUse(g, 'host');
  assert.equal(res?.jacked, true);
  assert.equal(traffic.driver, 'host');
  assert.equal(traffic.route, null);
  assert.ok(g.players.host.heat >= 30);
});

/* ---------------- guns and heat ---------------- */

test('shooting a pedestrian kills them and earns a wanted star', () => {
  const g = mk();
  clearPeds(g);
  g.peds[0] = {
    x: 220, y: 60, yaw: 0, turnAt: 0,
    dead: false, respawnAt: 0, fleeUntil: 0, fleeYaw: 0,
  };
  const p = put(g, 'host', 150, 60, 0);

  applyFire(g, 'host');
  assert.equal(g.peds[0].dead, true);
  assert.equal(wantedOf(p), 1);
});

test('heat cools back to zero on its own', () => {
  const g = mk();
  const p = put(g, 'host', 150, 60);
  p.heat = 10;
  run(g, secs(2));
  assert.equal(p.heat, 0);
  assert.equal(wantedOf(p), 0);
});

test('stars summon the Garda', () => {
  const g = mk();
  const p = put(g, 'host', 150, 60);
  p.heat = 200;
  run(g, secs(5));
  const force = g.cars.filter((c) => c.kind === 'garda');
  assert.ok(force.length >= 1 && force.length <= 5, `${force.length} cars responded`);
});

test('shooting a player: damage, a bounty, and a bed in the Mater', () => {
  const g = mk();
  clearPeds(g);
  const p = put(g, 'host', 150, 60, 0);
  const q = put(g, 'c2', 230, 60);

  p.fireCd = 0;
  applyFire(g, 'host');
  assert.equal(q.hp, 80);

  for (let i = 0; i < 4; i++) { p.fireCd = 0; applyFire(g, 'host'); }
  assert.equal(q.alive, false);
  assert.equal(q.deaths, 1);
  assert.equal(p.kills, 1);
  assert.equal(p.money, 200);

  run(g, secs(6));
  assert.equal(q.alive, true);
  assert.equal(q.hp, 100);
  const d = Math.hypot(q.x - HOSPITAL_SPAWN.x, q.y - HOSPITAL_SPAWN.y);
  assert.ok(d < 200, `respawned ${d} from the Mater`);
});

/* ---------------- missions ---------------- */

test('Post Run: deliver to Trinity, get paid', () => {
  const g = mk();
  put(g, 'host', MISSION_DEFS[0].marker.x, MISSION_DEFS[0].marker.y);
  const res = applyUse(g, 'host');
  assert.equal(res?.mission, 0);
  assert.ok(g.players.host.mission);

  put(g, 'host', MISSION_DEFS[0].drop.x, MISSION_DEFS[0].drop.y);
  step(g);
  assert.equal(g.players.host.mission, null);
  assert.equal(g.players.host.money, MISSION_DEFS[0].reward);
});

test('a mission that times out pays nothing', () => {
  const g = mk();
  put(g, 'host', MISSION_DEFS[0].marker.x, MISSION_DEFS[0].marker.y);
  applyUse(g, 'host');
  put(g, 'host', 150, 60);            // wander off and ignore the job
  run(g, secs(MISSION_DEFS[0].secs) + 2);
  assert.equal(g.players.host.mission, null);
  assert.equal(g.players.host.money, 0);
});

test('Joyrider: wrecking the target car completes the chase', () => {
  const g = mk();
  put(g, 'host', MISSION_DEFS[1].marker.x, MISSION_DEFS[1].marker.y);
  const res = applyUse(g, 'host');
  assert.equal(res?.mission, 1);
  const target = g.cars.find((c) => c.kind === 'target');
  assert.ok(target, 'the joyrider spawned');

  damageCar(g, target, 999, 'host');
  assert.equal(target.dead, true);
  assert.equal(g.players.host.mission, null);
  assert.equal(g.players.host.money, MISSION_DEFS[1].reward);
});

test('Green Errands: collect every parcel', () => {
  const g = mk();
  const p = put(g, 'host', MISSION_DEFS[2].marker.x, MISSION_DEFS[2].marker.y);
  const res = applyUse(g, 'host');
  assert.equal(res?.mission, 2);
  assert.equal(p.mission.targets.length, MISSION_DEFS[2].count);

  for (let guard = 0; guard < 10 && p.mission; guard++) {
    const t = p.mission.targets[0];
    p.x = t.x; p.y = t.y;
    step(g);
  }
  assert.equal(p.mission, null);
  assert.equal(p.money, MISSION_DEFS[2].reward);
});

test('wrecks rust away and the kerb restocks', () => {
  const g = mk();
  const car = g.cars.find((c) => c.x === 2380 && c.y === 440);
  damageCar(g, car, 999, null);
  assert.equal(car.dead, true);

  run(g, secs(31));
  assert.equal(g.cars.includes(car), false, 'the wreck should be towed');

  run(g, secs(21));
  const live = g.cars.filter((c) => c.kind === 'civ' && !c.dead).length;
  assert.ok(live >= 14, `only ${live} drivable cars left in Dublin`);
});

/* ---------------- coming and going ---------------- */

test('leaving mid-drive abandons the car; a late friend can drop in', () => {
  const g = mk();
  const car = g.cars.find((c) => c.x === 2380 && c.y === 440);
  put(g, 'host', 2380, 480);
  applyUse(g, 'host');
  assert.equal(car.driver, 'host');

  applyLeave(g, 'host');
  assert.equal(g.players.host.left, true);
  assert.equal(car.driver, null);

  addPlayer(g, { id: 'c3', name: 'Late', color: 'green' });
  assert.equal(g.seats.length, 3);
  const late = g.players.c3;
  assert.ok(late);
  assert.equal(fits(late.x, late.y, PLAYER_R), true);
  run(g, 5);                          // and the world keeps turning
  assert.equal(late.alive, true);
});
