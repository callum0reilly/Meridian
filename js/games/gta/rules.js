// GTA: Dublin. Pure logic — no DOM, no Three.js, no timers, no network.
//
// Same contract as the other rules modules: one state object owned by the
// host, mutated through exported functions. The host runs step() at 20Hz and
// broadcasts a snapshot; clients predict their own body/car with the very same
// stepFoot/stepCarPhysics exported here, which is the only reason prediction
// and authority ever agree (see impostor/rules.js for the long version).
//
// Nothing here is hidden information — the whole city is public — so unlike
// Impostor there is no per-player redaction; one snapshot serves everyone.
//
// There is no win condition. It's a sandbox: money is the scoreboard, the
// wanted stars are the difficulty knob you turn on yourself.

import {
  fits, bulletBlocked, hasLOS, spawnPoint,
  LOOPS, PARKED, MISSION_DEFS, FETCH_POINTS,
  GARDA_SPAWN, HOSPITAL_SPAWN,
} from './city.js';

export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
export const secs = (s) => Math.round(s * TICK_HZ);

export const MIN_PLAYERS = 1;      // the host can roam solo; friends join mid-game
export const MAX_PLAYERS = 8;

export const COLORS = ['red', 'blue', 'green', 'pink', 'orange', 'yellow', 'purple', 'cyan'];
export const COLOR_HEX = {
  red: '#e5484d', blue: '#3d7dff', green: '#30a46c', pink: '#f07eb8',
  orange: '#f7861c', yellow: '#ffc53d', purple: '#8b5cf6', cyan: '#22c4d6',
};

/* ---- bodies ---- */
export const PLAYER_R = 12;
export const PED_R = 11;
export const CAR_R = 16;           // cars collide as circles; arcade, not CAD

export const FOOT_SPEED = 170 / TICK_HZ;
export const SPRINT_SPEED = 265 / TICK_HZ;
const PED_WALK = 2.6, PED_FLEE = 5.5;

/* ---- cars, in units per tick ---- */
const ACCEL = 0.55, BRAKE = 1.4, DRAG = 0.985;
const MAX_FWD = 26, MAX_REV = -10;
const TURN = 0.075;                // rad/tick at full speed factor
const CAR_HP = 100;
const RUNOVER_SPEED = 8;           // below this a bumper is a nudge, not a weapon
const BOOM_RADIUS = 90, BOOM_DMG = 60;

/* ---- guns ---- */
export const FIRE_CD = secs(0.45);
export const BULLET_RANGE = 380;
const BULLET_DMG = 20, BULLET_CAR_DMG = 15;
const HURT_CD = secs(0.6);         // i-frames after a car hits you

/* ---- reach ---- */
export const ENTER_RANGE = 75;
export const MARKER_RANGE = 55;
const PICKUP_RANGE = 45, DROP_RANGE = 55;

/* ---- heat ----
   One pool of trouble per player; stars are derived. Heat decays constantly,
   so escaping is just surviving long enough while not making it worse. */
const HEAT = { ped: 70, carjack: 30, gardajack: 50, hitPlayer: 10, killPlayer: 90, gardaDown: 60 };
const HEAT_DECAY = 0.4;            // per tick — one star fades in about 9s
export const wantedOf = (p) => Math.min(5, Math.floor(p.heat / 70));

/* ---- garda ---- */
const GARDA_TOP = 27.5;            // slightly quicker than you, as is traditional
const GARDA_FIRE_RANGE = 300;
const GARDA_FIRE_CD = secs(1.2);
const GARDA_DMG = 8;
const GARDA_LEAVE = secs(8);

/* ---- death and money ---- */
const RESPAWN = secs(5);
const DEATH_TAX = 0.1;             // the Mater doesn't treat you for free
const BOUNTY = 200;

const PED_COUNT = 14;
const TRAFFIC_COUNT = 8;
const PED_RESPAWN = secs(9);
const CAR_MODELS = 6;
const RUST = secs(30);             // how long a burnt-out wreck litters the street
const MIN_CIV_CARS = 14;           // fresh metal appears at the kerb below this

/* ============================== setup ============================== */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randomWalkable(rng, r) {
  for (let i = 0; i < 200; i++) {
    const x = 40 + rng() * (2520), y = 40 + rng() * (1920);
    if (fits(x, y, r)) return { x, y };
  }
  return { x: 1540, y: 660 };      // the Spire plaza always exists
}

export function createState(seats, { seed = 1 } = {}) {
  const rng = mulberry32(seed);
  const state = {
    phase: 'playing',
    tick: 0,
    seats: seats.map((s) => ({ id: s.id, name: s.name, color: s.color })),
    players: {},
    cars: [],
    peds: [],
    shots: [],                     // this tick's tracers: [x1,y1,x2,y2]
    booms: [],                     // this tick's explosions: [x,y]
    log: [],
    nextCarId: 1,
    rng,
  };
  for (const s of state.seats) spawnPlayer(state, s.id);

  for (const p of PARKED) {
    state.cars.push(makeCar(state, {
      kind: 'civ', x: p.x, y: p.y, yaw: p.yaw, driver: null,
    }));
  }
  for (let i = 0; i < TRAFFIC_COUNT; i++) {
    const loop = i % LOOPS.length;
    const wp = i % LOOPS[loop].length;
    const [x, y] = LOOPS[loop][wp];
    state.cars.push(makeCar(state, {
      kind: 'civ', x: x + (i % 2 ? 20 : -20), y, yaw: 0, driver: 'ai',
      route: { loop, wp: (wp + 1) % LOOPS[loop].length },
    }));
  }
  for (let i = 0; i < PED_COUNT; i++) state.peds.push(makePed(state));
  return state;
}

function makeCar(state, opts) {
  return {
    id: state.nextCarId++,
    model: Math.floor(state.rng() * CAR_MODELS),
    speed: 0, hp: CAR_HP, dead: false, route: null, mission: null,
    fireCd: 0, leaveAt: 0, targetId: null, rustAt: 0,
    ...opts,
  };
}

function makePed(state) {
  const at = randomWalkable(state.rng, PED_R);
  return {
    x: at.x, y: at.y, yaw: state.rng() * Math.PI * 2,
    turnAt: state.tick + secs(1 + state.rng() * 4),
    dead: false, respawnAt: 0, fleeUntil: 0, fleeYaw: 0,
  };
}

function spawnPlayer(state, id) {
  const seat = state.seats.findIndex((s) => s.id === id);
  const at = spawnPoint(seat);
  state.players[id] = {
    id, seat,
    x: at.x, y: at.y, yaw: Math.PI / 2,
    hp: 100, alive: true, respawnAt: 0,
    money: 0, kills: 0, deaths: 0,
    heat: 0, hurtCd: 0, fireCd: 0,
    carId: null, mission: null,
    ix: 0, iy: 0, sprint: false, steer: 0, throttle: 0,
    left: false,
  };
}

/** Drop-in join: GTA has no rounds, so a friend can arrive whenever. */
export function addPlayer(state, seat) {
  state.seats.push({ id: seat.id, name: seat.name, color: seat.color });
  spawnPlayer(state, seat.id);
  logLine(state, `${seat.name} rolled into town.`);
}

export function applyLeave(state, id) {
  const p = state.players[id];
  if (!p || p.left) return false;
  p.left = true;
  if (p.carId != null) {
    const car = state.cars.find((c) => c.id === p.carId);
    if (car) car.driver = null;
    p.carId = null;
  }
  endMission(state, p, null);
  logLine(state, `${nameOf(state, id)} left town.`);
  return true;
}

/* ============================== input ============================== */

export function setFootInput(state, id, ix, iy, sprint) {
  const p = state.players[id];
  if (!p) return;
  const len = Math.hypot(ix, iy);
  if (!Number.isFinite(len) || len < 0.05) { p.ix = 0; p.iy = 0; }
  else { const k = Math.min(1, len) / len; p.ix = ix * k; p.iy = iy * k; }
  p.sprint = !!sprint;
}

export function setDriveInput(state, id, steer, throttle) {
  const p = state.players[id];
  if (!p) return;
  p.steer = clamp(+steer || 0, -1, 1);
  p.throttle = clamp(+throttle || 0, -1, 1);
}

/* ============================== stepping ============================== */

/**
 * Walk one body one tick. Shared with the client for prediction — one
 * function, both ends, or they drift apart. Axis-by-axis retry so walls are
 * slid along rather than stuck to.
 */
export function stepFoot(p) {
  const sp = p.sprint ? SPRINT_SPEED : FOOT_SPEED;
  const dx = p.ix * sp, dy = p.iy * sp;
  if (!dx && !dy) return;
  p.yaw = Math.atan2(dy, dx);
  if (fits(p.x + dx, p.y + dy, PLAYER_R)) { p.x += dx; p.y += dy; return; }
  if (dx && fits(p.x + dx, p.y, PLAYER_R)) { p.x += dx; return; }
  if (dy && fits(p.x, p.y + dy, PLAYER_R)) { p.y += dy; }
}

/**
 * Drive one car one tick. Also shared with the client. Returns the impact
 * speed if it hit a wall this tick (0 otherwise) — the host turns that into
 * damage; the predicting client ignores it.
 *
 * Steering scales with speed (and flips in reverse), which is the entire
 * driving model. It is enough: with a camera glued to the back of the car it
 * reads as handling, not maths.
 */
export function stepCarPhysics(car, steer, throttle) {
  const factor = clamp(car.speed / 12, -1, 1);
  car.yaw += steer * TURN * factor;

  if (throttle > 0) car.speed += throttle * (car.speed < 0 ? BRAKE : ACCEL);
  else if (throttle < 0) car.speed += throttle * (car.speed > 0 ? BRAKE : ACCEL * 0.6);
  car.speed *= DRAG;
  if (!throttle && Math.abs(car.speed) < 0.25) car.speed = 0;
  car.speed = clamp(car.speed, MAX_REV, car.kind === 'garda' ? GARDA_TOP : MAX_FWD);

  const nx = car.x + Math.cos(car.yaw) * car.speed;
  const ny = car.y + Math.sin(car.yaw) * car.speed;
  if (fits(nx, ny, CAR_R)) { car.x = nx; car.y = ny; return 0; }

  const impact = Math.abs(car.speed);
  if (fits(nx, car.y, CAR_R)) { car.x = nx; car.speed *= 0.72; return impact * 0.4; }
  if (fits(car.x, ny, CAR_R)) { car.y = ny; car.speed *= 0.72; return impact * 0.4; }
  car.speed *= -0.35;
  return impact;
}

/**
 * Advance one tick.
 * @returns {{sync: boolean}} true when the log gained a line — money changed
 * hands, somebody got wasted, a job opened or closed — and the host owes
 * everyone a room push on top of the snapshot.
 */
export function step(state) {
  state.tick += 1;
  state.shots = [];
  state.booms = [];
  const logLen = state.log.length;

  for (const p of players(state)) {
    if (p.fireCd > 0) p.fireCd -= 1;
    if (p.hurtCd > 0) p.hurtCd -= 1;
    if (p.heat > 0) p.heat = Math.max(0, p.heat - HEAT_DECAY);

    if (!p.alive) {
      if (state.tick >= p.respawnAt) respawn(state, p);
      continue;
    }
    if (p.carId == null) {
      stepFoot(p);
    } else {
      // Your body rides along with the car — missions, minimap dots and the
      // Garda all target the player, and they must not aim at where you
      // parked ten minutes ago.
      const car = state.cars.find((c) => c.id === p.carId);
      if (car) { p.x = car.x; p.y = car.y; p.yaw = car.yaw; }
    }
  }

  stepCars(state);
  stepGardai(state);
  stepPeds(state);
  stepMissions(state);

  // Wrecks rust away, and the kerbs restock — a long rampage must not slowly
  // empty Dublin of anything left to drive.
  state.cars = state.cars.filter((c) => !c.dead || state.tick < c.rustAt);
  if (state.tick % secs(10) === 0) {
    let live = state.cars.filter((c) => c.kind === 'civ' && !c.dead).length;
    for (const spot of PARKED) {
      if (live >= MIN_CIV_CARS) break;
      if (state.cars.some((c) => within(c, spot, 60))) continue;
      state.cars.push(makeCar(state, { kind: 'civ', x: spot.x, y: spot.y, yaw: spot.yaw, driver: null }));
      live += 1;
    }
  }

  return { sync: state.log.length !== logLen };
}

function stepCars(state) {
  for (const car of state.cars) {
    if (car.dead) { car.speed = 0; continue; }

    if (typeof car.driver === 'string' && car.driver !== 'ai') {
      // A player's hands on the wheel.
      const p = state.players[car.driver];
      const impact = stepCarPhysics(car, p?.steer ?? 0, p?.throttle ?? 0);
      if (impact > 6) damageCar(state, car, (impact - 6) * 3, car.driver);
      runOver(state, car, car.driver);
    } else if (car.driver === 'ai') {
      driveAI(state, car);
      runOver(state, car, null);
    } else {
      car.speed *= 0.9;            // abandoned mid-roll; it coasts to a stop
      if (Math.abs(car.speed) > 0.3) stepCarPhysics(car, 0, 0);
    }
  }

  // Car-on-car: shove apart, swap some paint. Circle vs circle is crude but
  // ramming the joyrider off the quays has to actually work.
  for (let i = 0; i < state.cars.length; i++) {
    for (let j = i + 1; j < state.cars.length; j++) {
      const a = state.cars[i], b = state.cars[j];
      if (a.dead && b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d >= CAR_R * 2 || d === 0) continue;
      const push = (CAR_R * 2 - d) / 2;
      const ux = dx / d, uy = dy / d;
      if (fits(a.x - ux * push, a.y - uy * push, CAR_R)) { a.x -= ux * push; a.y -= uy * push; }
      if (fits(b.x + ux * push, b.y + uy * push, CAR_R)) { b.x += ux * push; b.y += uy * push; }
      const rel = Math.abs(a.speed) + Math.abs(b.speed);
      if (rel > 6) {
        const hitter = Math.abs(a.speed) > Math.abs(b.speed) ? a : b;
        const victim = hitter === a ? b : a;
        damageCar(state, victim, rel * 1.5, playerDriver(hitter));
        damageCar(state, hitter, rel * 0.7, playerDriver(hitter));
      }
      a.speed *= 0.6; b.speed *= 0.6;
    }
  }
}

const playerDriver = (car) =>
  typeof car.driver === 'string' && car.driver !== 'ai' ? car.driver : null;

/** Pedestrians and players caught under a fast bumper. */
function runOver(state, car, driverId) {
  if (Math.abs(car.speed) < RUNOVER_SPEED) return;
  for (const ped of state.peds) {
    if (ped.dead || !within(car, ped, 24)) continue;
    killPed(state, ped);
    if (driverId) state.players[driverId].heat += HEAT.ped;
  }
  for (const p of players(state)) {
    if (!p.alive || p.carId != null || p.id === driverId) continue;
    if (!within(car, p, 26) || p.hurtCd > 0) continue;
    p.hurtCd = HURT_CD;
    hurtPlayer(state, p, 34, driverId);
  }
}

function driveAI(state, car) {
  let tx, ty, throttle;

  if (car.kind === 'garda') {
    const target = car.targetId ? state.players[car.targetId] : null;
    if (!target || !target.alive || wantedOf(target) === 0) return; // handled by stepGardai
    tx = target.x; ty = target.y;
    const dist = Math.hypot(tx - car.x, ty - car.y);
    throttle = dist > 130 ? 1 : Math.abs(car.speed) > 6 ? -0.4 : 0.3;

    if (dist < GARDA_FIRE_RANGE && car.fireCd <= 0 && hasLOS(car.x, car.y, tx, ty)) {
      car.fireCd = GARDA_FIRE_CD;
      state.shots.push([Math.round(car.x), Math.round(car.y), Math.round(tx), Math.round(ty)]);
      if (target.carId != null) {
        const tc = state.cars.find((c) => c.id === target.carId);
        if (tc) damageCar(state, tc, GARDA_DMG, null);
      } else {
        hurtPlayer(state, target, GARDA_DMG, null);
      }
    }
    if (car.fireCd > 0) car.fireCd -= 1;
  } else if (car.route) {
    const loop = LOOPS[car.route.loop];
    const wp = loop[car.route.wp];
    tx = wp[0]; ty = wp[1];
    if (Math.hypot(tx - car.x, ty - car.y) < (car.kind === 'target' ? 80 : 60)) {
      car.route.wp = (car.route.wp + 1) % loop.length;
    }
    throttle = car.kind === 'target' ? 1 : 0.5;
  } else return;

  const desired = Math.atan2(ty - car.y, tx - car.x);
  const diff = angleDiff(car.yaw, desired);
  const steer = clamp(diff * 3, -1, 1);
  // Nose pointing the wrong way entirely: back up and swing around.
  const impact = stepCarPhysics(car, steer, Math.abs(diff) > 2.4 ? -0.5 : throttle);
  if (impact > 6 && car.kind !== 'garda') damageCar(state, car, (impact - 6) * 2, null);
}

/* ---- gardai ---- */

function stepGardai(state) {
  let wantedMax = 0;
  for (const p of players(state)) if (p.alive) wantedMax = Math.max(wantedMax, wantedOf(p));

  const force = state.cars.filter((c) => c.kind === 'garda' && !c.dead);

  if (wantedMax > 0) {
    // One car per star, arriving one at a time, not as a wall.
    if (force.length < wantedMax && state.tick % secs(2) === 0) {
      state.cars.push(makeCar(state, {
        kind: 'garda',
        x: GARDA_SPAWN.x + (state.rng() - 0.5) * 40,
        y: GARDA_SPAWN.y,
        yaw: Math.PI, driver: 'ai',
      }));
    }
    for (const car of force) {
      car.leaveAt = 0;
      const t = car.targetId ? state.players[car.targetId] : null;
      if (!t || !t.alive || t.left || wantedOf(t) === 0) car.targetId = nearestWanted(state, car);
    }
  } else {
    // Nothing left to chase: drive back to the station and clock off.
    for (const car of force) {
      car.targetId = null;
      if (!car.leaveAt) car.leaveAt = state.tick + GARDA_LEAVE;
      const desired = Math.atan2(GARDA_SPAWN.y - car.y, GARDA_SPAWN.x - car.x);
      stepCarPhysics(car, clamp(angleDiff(car.yaw, desired) * 3, -1, 1), 0.8);
      const home = Math.hypot(car.x - GARDA_SPAWN.x, car.y - GARDA_SPAWN.y) < 120;
      if (home || state.tick >= car.leaveAt) {
        state.cars.splice(state.cars.indexOf(car), 1);
      }
    }
  }
}

function nearestWanted(state, car) {
  let best = null, bestD = Infinity;
  for (const p of players(state)) {
    if (!p.alive || wantedOf(p) === 0) continue;
    const d = (p.x - car.x) ** 2 + (p.y - car.y) ** 2;
    if (d < bestD) { best = p.id; bestD = d; }
  }
  return best;
}

/* ---- pedestrians ---- */

function stepPeds(state) {
  for (let i = 0; i < state.peds.length; i++) {
    const ped = state.peds[i];
    if (ped.dead) {
      if (state.tick >= ped.respawnAt) state.peds[i] = makePed(state);
      continue;
    }
    const fleeing = state.tick < ped.fleeUntil;
    const yaw = fleeing ? ped.fleeYaw : ped.yaw;
    const sp = fleeing ? PED_FLEE : PED_WALK;
    const nx = ped.x + Math.cos(yaw) * sp, ny = ped.y + Math.sin(yaw) * sp;
    if (fits(nx, ny, PED_R)) { ped.x = nx; ped.y = ny; ped.yaw = yaw; }
    else { ped.yaw = state.rng() * Math.PI * 2; ped.fleeUntil = 0; }
    if (!fleeing && state.tick >= ped.turnAt) {
      ped.yaw = state.rng() * Math.PI * 2;
      ped.turnAt = state.tick + secs(1 + state.rng() * 4);
    }
  }
}

function killPed(state, ped) {
  ped.dead = true;
  ped.respawnAt = state.tick + PED_RESPAWN;
}

/** Gunfire nearby sends the innocent running away from it. */
function scatterPeds(state, x, y) {
  for (const ped of state.peds) {
    if (ped.dead || !within(ped, { x, y }, 260)) continue;
    ped.fleeYaw = Math.atan2(ped.y - y, ped.x - x);
    ped.fleeUntil = state.tick + secs(4);
  }
}

/* ============================== guns ============================== */

/**
 * Pull the trigger. On foot the shot goes where you face; from a car, out the
 * windscreen. Hitscan, first thing in the way wins, buildings eat the rest.
 */
export function applyFire(state, id) {
  const p = state.players[id];
  if (!p || !p.alive || p.left || p.fireCd > 0) return null;
  p.fireCd = FIRE_CD;

  let ox = p.x, oy = p.y, yaw = p.yaw;
  if (p.carId != null) {
    const car = state.cars.find((c) => c.id === p.carId);
    if (car) { yaw = car.yaw; ox = car.x + Math.cos(yaw) * 40; oy = car.y + Math.sin(yaw) * 40; }
  }
  const dx = Math.cos(yaw), dy = Math.sin(yaw);

  let hit = null, hx = ox + dx * BULLET_RANGE, hy = oy + dy * BULLET_RANGE;
  outer:
  for (let d = 10; d <= BULLET_RANGE; d += 10) {
    const x = ox + dx * d, y = oy + dy * d;
    if (bulletBlocked(x, y)) { hx = x; hy = y; break; }
    for (const ped of state.peds) {
      if (!ped.dead && within(ped, { x, y }, PED_R + 3)) { hit = { ped }; hx = x; hy = y; break outer; }
    }
    for (const q of players(state)) {
      if (q.id === id || !q.alive || q.carId != null) continue;
      if (within(q, { x, y }, PLAYER_R + 3)) { hit = { player: q }; hx = x; hy = y; break outer; }
    }
    for (const car of state.cars) {
      if (car.dead || car.id === p.carId) continue;
      if (within(car, { x, y }, CAR_R + 6)) { hit = { car }; hx = x; hy = y; break outer; }
    }
  }

  state.shots.push([Math.round(ox), Math.round(oy), Math.round(hx), Math.round(hy)]);
  scatterPeds(state, ox, oy);

  if (hit?.ped) { killPed(state, hit.ped); p.heat += HEAT.ped; }
  else if (hit?.player) { p.heat += HEAT.hitPlayer; hurtPlayer(state, hit.player, BULLET_DMG, id); }
  else if (hit?.car) damageCar(state, hit.car, BULLET_CAR_DMG, id);
  return hit;
}

function hurtPlayer(state, p, dmg, byId) {
  p.hp -= dmg;
  if (p.hp <= 0) killPlayer(state, p, byId);
}

function killPlayer(state, p, byId) {
  p.alive = false;
  p.hp = 0;
  p.deaths += 1;
  p.respawnAt = state.tick + RESPAWN;
  p.money -= Math.floor(p.money * DEATH_TAX);
  p.ix = 0; p.iy = 0; p.steer = 0; p.throttle = 0;
  if (p.carId != null) {
    const car = state.cars.find((c) => c.id === p.carId);
    if (car && car.driver === p.id) car.driver = null;
    p.carId = null;
  }
  const killer = byId ? state.players[byId] : null;
  if (killer && killer.id !== p.id) {
    killer.kills += 1;
    killer.money += BOUNTY;
    killer.heat += HEAT.killPlayer;
    logLine(state, `${nameOf(state, p.id)} was wasted by ${nameOf(state, byId)} (+$${BOUNTY}).`);
  } else {
    logLine(state, `${nameOf(state, p.id)} was wasted.`);
  }
}

function respawn(state, p) {
  for (let i = 0; i < 12; i++) {
    const x = HOSPITAL_SPAWN.x + (i % 4) * 28 - 42, y = HOSPITAL_SPAWN.y + Math.floor(i / 4) * 28;
    if (fits(x, y, PLAYER_R)) { p.x = x; p.y = y; break; }
  }
  p.alive = true;
  p.hp = 100;
  p.heat = 0;                      // the Garda lose interest in the deceased
  p.yaw = Math.PI / 2;
}

export function damageCar(state, car, dmg, byId) {
  if (car.dead) return;
  car.hp -= dmg;
  if (car.hp > 0) return;

  car.hp = 0;
  car.dead = true;
  car.speed = 0;
  car.rustAt = state.tick + RUST;
  state.booms.push([Math.round(car.x), Math.round(car.y)]);

  if (car.kind === 'garda' && byId) state.players[byId].heat += HEAT.gardaDown;
  if (car.mission) {
    const owner = state.players[car.mission];
    if (owner?.mission != null) finishMission(state, owner);
  }
  if (typeof car.driver === 'string' && car.driver !== 'ai') {
    const p = state.players[car.driver];
    if (p?.alive) killPlayer(state, p, byId);
  }
  car.driver = null;

  // The blast: anyone standing too close, in or out of a car, has a bad day.
  for (const q of players(state)) {
    if (!q.alive || q.carId === car.id || !within(q, car, BOOM_RADIUS)) continue;
    hurtPlayer(state, q, BOOM_DMG, byId);
  }
  for (const ped of state.peds) {
    if (!ped.dead && within(ped, car, BOOM_RADIUS)) killPed(state, ped);
  }
}

/* ============================== E: use ============================== */

/** The car you could take right now, or null. Locked: other players' cars and
    the joyrider's — the chase is a chase, not a repossession. */
export function carAt(state, id) {
  const p = state.players[id];
  if (!p || !p.alive || p.carId != null) return null;
  let best = null, bestD = Infinity;
  for (const car of state.cars) {
    if (car.dead || car.kind === 'target') continue;
    if (typeof car.driver === 'string' && car.driver !== 'ai') continue;
    const d = (car.x - p.x) ** 2 + (car.y - p.y) ** 2;
    if (d < ENTER_RANGE ** 2 && d < bestD) { best = car; bestD = d; }
  }
  return best;
}

/** The mission marker `id` is standing on, if they're free to take the job. */
export function markerAt(state, id) {
  const p = state.players[id];
  if (!p || !p.alive || p.mission) return null;
  for (let i = 0; i < MISSION_DEFS.length; i++) {
    const def = MISSION_DEFS[i];
    if (within(p, def.marker, MARKER_RANGE)) return { def, idx: i };
  }
  return null;
}

/**
 * The E key: exit the car you're in, else take the job you're standing on,
 * else take the car you're standing next to. One key, resolved host-side.
 */
export function applyUse(state, id) {
  const p = state.players[id];
  if (!p || !p.alive || p.left) return null;

  if (p.carId != null) {
    const car = state.cars.find((c) => c.id === p.carId);
    if (!car) { p.carId = null; return null; }
    // Step out beside the car — first side that isn't a wall or the river.
    const side = car.yaw + Math.PI / 2;
    const spots = [
      [car.x + Math.cos(side) * 36, car.y + Math.sin(side) * 36],
      [car.x - Math.cos(side) * 36, car.y - Math.sin(side) * 36],
      [car.x - Math.cos(car.yaw) * 50, car.y - Math.sin(car.yaw) * 50],
    ];
    for (const [x, y] of spots) {
      if (!fits(x, y, PLAYER_R)) continue;
      car.driver = null;
      p.carId = null;
      p.x = x; p.y = y;
      return { exited: car.id };
    }
    return null;                   // wedged in an alley; drive somewhere saner
  }

  const marker = markerAt(state, id);
  if (marker) return startMission(state, p, marker.idx);

  const car = carAt(state, id);
  if (!car) return null;
  const jacked = car.driver === 'ai';
  if (jacked) p.heat += car.kind === 'garda' ? HEAT.gardajack : HEAT.carjack;
  car.driver = id;
  car.route = null;
  if (car.kind === 'garda') car.kind = 'civ';   // a stolen squad car chases no one
  p.carId = car.id;
  p.steer = 0; p.throttle = 0;
  return { entered: car.id, jacked };
}

/* ============================== missions ============================== */

function startMission(state, p, idx) {
  const def = MISSION_DEFS[idx];
  const m = { def: idx, endsAt: state.tick + secs(def.secs), targets: null, carId: null };

  if (def.kind === 'fetch') {
    const pts = [...FETCH_POINTS];
    for (let i = pts.length - 1; i > 0; i--) {
      const j = Math.floor(state.rng() * (i + 1));
      [pts[i], pts[j]] = [pts[j], pts[i]];
    }
    m.targets = pts.slice(0, def.count).map(([x, y]) => ({ x, y }));
  } else if (def.kind === 'chase') {
    const car = makeCar(state, {
      // Spawns on Capel Street pointing at the top of the big cross-river
      // loop, so its first move is up a straight road, not into a wall.
      kind: 'target', x: def.spawn.x, y: def.spawn.y, yaw: -Math.PI / 2,
      driver: 'ai', route: { loop: 2, wp: 3 }, mission: p.id,
    });
    state.cars.push(car);
    m.carId = car.id;
  }

  p.mission = m;
  logLine(state, `${nameOf(state, p.id)} took the job: ${def.name}.`);
  return { mission: idx };
}

function stepMissions(state) {
  for (const p of players(state)) {
    const m = p.mission;
    if (!m) continue;
    const def = MISSION_DEFS[m.def];

    if (state.tick >= m.endsAt) {
      logLine(state, `${nameOf(state, p.id)} blew the ${def.name} job.`);
      endMission(state, p, m);
      continue;
    }
    if (!p.alive) continue;        // the clock keeps running while you respawn

    if (def.kind === 'delivery') {
      if (within(p, def.drop, DROP_RANGE)) finishMission(state, p);
    } else if (def.kind === 'fetch') {
      m.targets = m.targets.filter((t) => !within(p, t, PICKUP_RANGE));
      if (m.targets.length === 0) finishMission(state, p);
    }
    // 'chase' completes from damageCar when the target dies.
  }
}

function finishMission(state, p) {
  const def = MISSION_DEFS[p.mission.def];
  p.money += def.reward;
  logLine(state, `${nameOf(state, p.id)} finished ${def.name} — $${def.reward}.`);
  endMission(state, p, p.mission);
}

/** Tear a mission down without judging it — despawn the chase car, clear it. */
function endMission(state, p, m) {
  const mission = m ?? p.mission;
  if (!mission) return;
  if (mission.carId != null) {
    const i = state.cars.findIndex((c) => c.id === mission.carId && !c.dead);
    if (i >= 0) state.cars.splice(i, 1);
  }
  p.mission = null;
}

/* ============================== helpers ============================== */

const players = (state) => state.seats
  .map((s) => state.players[s.id])
  .filter((p) => p && !p.left);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const within = (a, b, r) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= r * r;
const angleDiff = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

const nameOf = (state, id) => state.seats.find((s) => s.id === id)?.name || 'Someone';

function logLine(state, text) {
  state.log.push(text);
  if (state.log.length > 40) state.log.shift();
}
