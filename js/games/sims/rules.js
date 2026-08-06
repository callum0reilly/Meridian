// The Sims 5. Pure logic — no DOM, no canvas, no timers, no network.
//
// Same contract as the other rules modules: one state object, mutated through
// exported functions, stepped at a fixed rate. Single-player, so there is no
// host/client split — index.js owns the one state and calls step() 20 times a
// second while the game is live and unpaused.
//
// ---- Time ----
// One tick advances dt = 0.12 × speed sim-minutes, so a 1440-minute day takes
// exactly ten real minutes at 1×. Every rate in this file is per sim-minute or
// per sim-hour; speed multiplies dt and nothing else, which is why 10× needs no
// separate tuning anywhere. Scheduled things (bills, shift end, hauntings) fire
// on minute CROSSINGS, never equality — at 10× a tick spans 1.2 minutes and
// equality would skip straight past them.
//
// ---- Obedience ----
// Sims have no free will, by design. They execute the queue and otherwise stand
// there while their needs decay. The body still files its own complaints —
// bladder empties itself, an exhausted sim faints where they stand, and an
// ignored hunger bar starts the six-hour countdown that ends with the Reaper.
//
// ---- RNG ----
// Unlike gta's closure RNG, the generator state lives IN the state object
// (rng: {s}) and rand() advances it in place. Saves capture it, loads restore
// it, and the determinism test in test/sims.test.mjs is the reason: same seed,
// same commands, same world — twice.

import {
  NEEDS, ROOM_WEIGHT, TRAITS, OBJECTS, CAREERS, SOCIALS,
  TOWNIE_NAMES, SHIRTS, FLOORS,
  objectTiles, slotTiles, rotSize,
  WALL_COST, DOOR_COST, WINDOW_COST, FLOOR_COST, RESALE, WALL_REFUND,
  START_FUNDS, MAX_SIMS, QUEUE_CAP, WALK_SPEED,
  BILL_EVERY_DAYS, BILL_BASE, BILL_RATE, BILL_GRACE_DAYS,
  STARVE_GRACE_MIN, REAPER_MIN, PASSOUT_MIN, PASSOUT_ENERGY,
  FIRE_BASE, FIRE_PER_SKILL, FIRE_SPREAD_MIN, FIRE_BURN_MIN, FIRE_KILL_MIN, EXTINGUISH_MIN,
  GHOST_HOUR, GHOST_DAWN, GHOST_CHANCE, GHOST_RANGE, SPOOK_FUN, SPOOK_COMFORT,
  VISIT_CHANCE, VISIT_STAY_MIN, VISIT_CURFEW, LOT_DOOR,
  SKILL_MAX, MOOD_SKILL_BONUS, PROMOTION_MOOD, SKILLS,
} from './catalogue.js';
import { findPath } from './path.js';

export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
export const MIN_PER_TICK = 0.12;    // sim-minutes at 1×; ×3 and ×10 scale this
export const LOT_W = 24;
export const LOT_H = 24;
export const SAVE_VERSION = 1;

/* ============================== rng ============================== */

// mulberry32 with its word of state held in state.rng.s.
export function rand(state) {
  let a = (state.rng.s = (state.rng.s + 0x6D2B79F5) | 0);
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
const randInt = (state, n) => Math.floor(rand(state) * n);

/* ============================== setup ============================== */

const grid = (w, h, fill) => Array.from({ length: h }, () => Array(w).fill(fill));

function makeSim(spec, i) {
  return {
    id: 's' + (i + 1),
    name: String(spec.name || 'Sim ' + (i + 1)).slice(0, 12),
    shirt: spec.shirt || SHIRTS[i % SHIRTS.length],
    traits: (spec.traits || []).slice(0, 2),
    needs: { hunger: 80, energy: 80, bladder: 80, hygiene: 80, fun: 70, social: 70, comfort: 70 },
    skills: { cooking: 0, charisma: 0, fitness: 0 },
    job: { career: spec.career || 'business', level: 1, missedDays: 0, lastWorkedDay: 0 },
    rel: {},
    pos: { x: LOT_DOOR[0] - 1.5 + i, y: LOT_DOOR[1] - 1 },
    facing: 0,
    path: [],
    queue: [],
    nextAid: 1,
    atWork: false, workReturnMin: 0, moodAtDeparture: 0,
    busyWith: null,                  // { aid, withId } while captured by a social
    starveDeadline: null,            // absolute sim-minute, or null
    passedOutUntil: null,
    fireExposure: 0,
    dying: null,                     // { atMin, cause } once the Reaper is booked
  };
}

export function createState(specs, { seed = 1 } = {}) {
  const state = {
    v: SAVE_VERSION,
    phase: 'live',                   // 'live' | 'gameover'
    mode: 'live',                    // 'live' | 'build'
    seed, rng: { s: seed >>> 0 },
    time: { day: 1, minute: 8 * 60, speed: 1 },
    funds: START_FUNDS,
    bills: { due: 0, issuedDay: 0, deadlineDay: 0 },
    lot: {
      w: LOT_W, h: LOT_H,
      floor: grid(LOT_W, LOT_H, 0),
      wallsN: grid(LOT_W, LOT_H + 1, 0),   // wallsN[y][x]: north edge of tile (x,y)
      wallsW: grid(LOT_W + 1, LOT_H, 0),   // wallsW[y][x]: west edge of tile (x,y)
      objects: [],
      nextObjectId: 1,
    },
    sims: specs.slice(0, MAX_SIMS).map(makeSim),
    townies: [],
    visitPlan: null,
    ghosts: [],
    fires: [],
    deadLog: [],
  };
  // The town: six regulars, rolled once so this world's Bella is always the same.
  state.townies = TOWNIE_NAMES.map((name, i) => ({
    id: 't' + (i + 1), name,
    shirt: SHIRTS[randInt(state, SHIRTS.length)],
    traits: [TRAITS[randInt(state, TRAITS.length)].id],
    rel: {},
    present: false, pos: null, path: [], busyWith: null,
    leavesAtMin: 0, nextChatMin: 0, arrivedAtMin: 0, chatEndsAtMin: null, chatWith: null,
  }));
  scheduleVisit(state);
  rebuildDerived(state);
  return state;
}

// Everybody died. The house, the urns and the town remain; a new family moves
// into whatever the last one left behind. Funds reset, the calendar does not.
export function refound(state, specs) {
  state.sims = specs.slice(0, MAX_SIMS).map(makeSim);
  state.funds = START_FUNDS;
  state.phase = 'live';
  state.mode = 'live';
  state.time.speed = 1;
  state.fires = [];
  for (const t of state.townies) { t.present = false; t.pos = null; t.path = []; t.social = null; }
  scheduleVisit(state);
  rebuildDerived(state);
}

/* ============================== derived ============================== */

// Rebuilt after load and after every build-mode edit; never serialised.
export function rebuildDerived(state) {
  const { w, h } = state.lot;
  const blocked = grid(w, h, 0);
  const seatAt = grid(w, h, 0);
  for (const obj of state.lot.objects) {
    const def = OBJECTS[obj.def];
    for (const [x, y] of objectTiles(obj)) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (!def.passable) blocked[y][x] = obj.id;
      if (def.seat) seatAt[y][x] = 1;
    }
  }

  // Rooms: flood fill through open edges only — a doorway joins two rooms for
  // walking but not for room identity, exactly like the real thing. Region 0 is
  // everything connected to the lot border: the outdoors.
  const roomId = grid(w, h, -1);
  const open = (x, y, dir) => edgeVal(state, x, y, dir) === 0;
  let nextRoom = 1;
  const fill = (sx, sy, id) => {
    const stack = [[sx, sy]];
    roomId[sy][sx] = id;
    while (stack.length) {
      const [x, y] = stack.pop();
      if (y > 0 && roomId[y - 1][x] === -1 && open(x, y, 0)) { roomId[y - 1][x] = id; stack.push([x, y - 1]); }
      if (x < w - 1 && roomId[y][x + 1] === -1 && open(x, y, 1)) { roomId[y][x + 1] = id; stack.push([x + 1, y]); }
      if (y < h - 1 && roomId[y + 1][x] === -1 && open(x, y, 2)) { roomId[y + 1][x] = id; stack.push([x, y + 1]); }
      if (x > 0 && roomId[y][x - 1] === -1 && open(x, y, 3)) { roomId[y][x - 1] = id; stack.push([x - 1, y]); }
    }
  };
  for (let x = 0; x < w; x++) {
    if (roomId[0][x] === -1 && edgeVal(state, x, 0, 0) === 0) fill(x, 0, 0);
    if (roomId[h - 1][x] === -1 && edgeVal(state, x, h - 1, 2) === 0) fill(x, h - 1, 0);
  }
  for (let y = 0; y < h; y++) {
    if (roomId[y][0] === -1 && edgeVal(state, 0, y, 3) === 0) fill(0, y, 0);
    if (roomId[y][w - 1] === -1 && edgeVal(state, w - 1, y, 1) === 0) fill(w - 1, y, 0);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (roomId[y][x] === -1) fill(x, y, nextRoom++);
  }

  // Room score: a plain room is a 50, decor helps, windows help, puddles hurt.
  const decorSum = new Array(nextRoom).fill(0);
  const windows = new Array(nextRoom).fill(0);
  for (const obj of state.lot.objects) {
    const r = roomId[obj.y]?.[obj.x];
    if (r > 0) decorSum[r] += OBJECTS[obj.def].decor;
  }
  for (let y = 0; y <= h; y++) for (let x = 0; x < w; x++) {
    if (state.lot.wallsN[y][x] === 3) {
      const above = y > 0 ? roomId[y - 1][x] : 0;
      const below = y < h ? roomId[y][x] : 0;
      if (above > 0) windows[above]++;
      if (below > 0) windows[below]++;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x <= w; x++) {
    if (state.lot.wallsW[y][x] === 3) {
      const left = x > 0 ? roomId[y][x - 1] : 0;
      const right = x < w ? roomId[y][x] : 0;
      if (left > 0) windows[left]++;
      if (right > 0) windows[right]++;
    }
  }
  const roomScore = new Array(nextRoom).fill(75); // outdoors: fresh air, can't decorate it
  for (let r = 1; r < nextRoom; r++) {
    roomScore[r] = clamp(50 + 6 * decorSum[r] + 3 * windows[r], 0, 100);
  }

  state.derived = { blocked, seatAt, roomId, roomScore };
}

// The wall on the far side of stepping off tile (x,y) in dir (0 N,1 E,2 S,3 W).
function edgeVal(state, x, y, dir) {
  const { wallsN, wallsW } = state.lot;
  switch (dir) {
    case 0: return wallsN[y][x];
    case 1: return wallsW[y][x + 1];
    case 2: return wallsN[y + 1][x];
    default: return wallsW[y][x];
  }
}

const canWalk = (state) => (x, y, dir) => { const v = edgeVal(state, x, y, dir); return v === 0 || v === 2; };

/* ============================== queries ============================== */

export const absMin = (state) => (state.time.day - 1) * 1440 + state.time.minute;
export const simById = (state, id) => state.sims.find((s) => s.id === id) || state.townies.find((t) => t.id === id);
export const objectById = (state, id) => state.lot.objects.find((o) => o.id === id);

export function traitMult(sim, key) {
  let m = 1;
  for (const tid of sim.traits) {
    const t = TRAITS.find((x) => x.id === tid);
    if (t?.mult?.[key] != null) m *= t.mult[key];
  }
  return m;
}
const hasTraitFlag = (sim, flag) => sim.traits.some((tid) => TRAITS.find((t) => t.id === tid)?.[flag]);

export function roomScoreAt(state, x, y) {
  const r = state.derived.roomId[Math.floor(y)]?.[Math.floor(x)];
  return r == null ? 75 : state.derived.roomScore[r];
}

export function mood(state, sim) {
  let sum = 0, wsum = 0;
  for (const n of NEEDS) { sum += sim.needs[n.id] * n.weight; wsum += n.weight; }
  if (!hasTraitFlag(sim, 'ignoreRoom')) {
    sum += roomScoreAt(state, sim.pos.x, sim.pos.y) * ROOM_WEIGHT;
    wsum += ROOM_WEIGHT;
  }
  return sum / wsum;
}

export function relTo(sim, otherId) {
  return sim.rel[otherId] || { friend: 0, romance: 0, partner: false };
}
function relRow(sim, otherId) {
  return (sim.rel[otherId] ??= { friend: 0, romance: 0, partner: false });
}

// Menu data: which socials the initiator can offer this target, and why not.
export function availableSocials(sim, target) {
  const r = relTo(sim, target.id);
  return SOCIALS.map((s) => {
    if (s.needFriend != null && r.friend < s.needFriend) {
      return { social: s, ok: false, why: `Needs friendship ${s.needFriend}` };
    }
    if (s.needRomance != null && r.romance < s.needRomance) {
      return { social: s, ok: false, why: `Needs romance ${s.needRomance}` };
    }
    if (s.partner && r.partner) return { social: s, ok: false, why: 'Already partners' };
    return { social: s, ok: true };
  });
}

export function availableInteractions(state, obj) {
  const def = OBJECTS[obj.def];
  return def.interactions.filter((ia) =>
    !ia.requires?.object || state.lot.objects.some((o) => o.def === ia.requires.object));
}

/* ============================== the queue ============================== */

function pushAction(state, sim, action) {
  if (sim.queue.length >= QUEUE_CAP) return { ok: false, msg: 'Queue is full.' };
  sim.queue.push({ aid: sim.nextAid++, state: 'queued', path: undefined, ...action });
  return { ok: true };
}

export const queueGo = (state, simId, x, y) =>
  pushAction(state, simById(state, simId), { kind: 'go', tx: x, ty: y });

export function queueObjectAction(state, simId, objectId, interactionId) {
  const sim = simById(state, simId);
  const obj = objectById(state, objectId);
  if (!obj) return { ok: false, msg: 'It’s gone.' };
  const ia = OBJECTS[obj.def].interactions.find((i) => i.id === interactionId);
  if (!ia) return { ok: false, msg: 'Can’t do that.' };
  if (ia.requires?.object && !state.lot.objects.some((o) => o.def === ia.requires.object)) {
    return { ok: false, msg: `Needs a ${OBJECTS[ia.requires.object].label.toLowerCase()} on the lot.` };
  }
  return pushAction(state, sim, { kind: 'object', objectId, def: interactionId });
}

export function queueSocial(state, simId, targetId, socialId) {
  const sim = simById(state, simId);
  const target = simById(state, targetId);
  if (!target) return { ok: false, msg: 'They’ve gone.' };
  const gate = availableSocials(sim, target).find((g) => g.social.id === socialId);
  if (!gate?.ok) return { ok: false, msg: gate?.why || 'Not now.' };
  return pushAction(state, sim, { kind: 'social', targetId, def: socialId });
}

export function queueGoToWork(state, simId) {
  const sim = simById(state, simId);
  return pushAction(state, sim, { kind: 'work' });
}

export const queueExtinguish = (state, simId, x, y) =>
  pushAction(state, simById(state, simId), { kind: 'extinguish', tx: x, ty: y });

export function cancelAction(state, simId, aid) {
  const sim = simById(state, simId);
  const i = sim.queue.findIndex((a) => a.aid === aid);
  if (i === -1) return;
  const [a] = sim.queue.splice(i, 1);
  if (i === 0) {
    sim.path = [];
    // A social mid-flow releases its captive.
    if (a.kind === 'social' && a.state === 'running') {
      const target = simById(state, a.targetId);
      if (target?.busyWith?.aid === a.aid) target.busyWith = null;
    }
  }
}

// Build mode moved the furniture; anyone mid-walk re-plans from scratch.
export function repathMovers(state) {
  for (const sim of state.sims) {
    const head = sim.queue[0];
    if (head && head.state === 'moving') { head.state = 'queued'; sim.path = []; }
  }
}

/* ---- target resolution ---- */

// Where do you stand to do this, and can you get there? Returns {tx, ty, path}
// or null. For seats the standing tile IS the object, so the target object's
// own footprint is exempted from the blocked test for this search only.
function resolveTarget(state, sim, action) {
  const from = [Math.round(sim.pos.x), Math.round(sim.pos.y)];
  const { w, h } = state.lot;
  const cross = canWalk(state);
  const pathTo = (tx, ty, ignoreObjId) => {
    const blocked = (x, y) => {
      const b = state.derived.blocked[y][x];
      return b !== 0 && b !== ignoreObjId;
    };
    return findPath(w, h, blocked, cross, from, [tx, ty]);
  };

  if (action.kind === 'go') {
    const p = pathTo(action.tx, action.ty, 0);
    return p ? { tx: action.tx, ty: action.ty, path: p } : null;
  }
  if (action.kind === 'work') {
    const p = pathTo(LOT_DOOR[0], LOT_DOOR[1], 0);
    return p ? { tx: LOT_DOOR[0], ty: LOT_DOOR[1], path: p } : null;
  }
  if (action.kind === 'extinguish') {
    for (const [tx, ty] of neighbours(state, action.tx, action.ty)) {
      const p = pathTo(tx, ty, 0);
      if (p) return { tx, ty, path: p };
    }
    return null;
  }
  if (action.kind === 'object') {
    const obj = objectById(state, action.objectId);
    if (!obj) return null;
    for (const [tx, ty] of slotTiles(obj)) {
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const p = pathTo(tx, ty, obj.id);
      if (p) return { tx, ty, path: p };
    }
    return null;
  }
  if (action.kind === 'social') {
    const target = simById(state, action.targetId);
    if (!target || target.atWork || !targetPos(target)) return null;
    const tp = targetPos(target);
    for (const [tx, ty] of neighbours(state, Math.round(tp.x), Math.round(tp.y))) {
      const p = pathTo(tx, ty, 0);
      if (p) return { tx, ty, path: p };
    }
    return null;
  }
  return null;
}

const targetPos = (t) => t.pos;
function* neighbours(state, x, y) {
  const { w, h } = state.lot;
  for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) yield [nx, ny];
  }
}

/* ============================== build mode ============================== */

// All build ops validate, charge and rebuild derived state. They are also the
// only mutations the undo stack in index.js needs to invert.

function footprintClear(state, def, x, y, rot, ignoreId = 0) {
  const { w, d } = rotSize(def, rot);
  if (x < 0 || y < 0 || x + w > state.lot.w || y + d > state.lot.h) return false;
  for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < d; dy++) {
    const b = state.derived.blocked[y + dy][x + dx];
    if (b !== 0 && b !== ignoreId) return false;
    // No dropping a sofa on someone's head.
    for (const sim of state.sims) {
      if (!sim.atWork && Math.round(sim.pos.x) === x + dx && Math.round(sim.pos.y) === y + dy) return false;
    }
    // A footprint may not straddle a wall.
    if (dx < w - 1 && edgeVal(state, x + dx, y + dy, 1) !== 0) return false;
    if (dy < d - 1 && edgeVal(state, x + dx, y + dy, 2) !== 0) return false;
  }
  return true;
}

// The build ghost asks this every mousemove; placement asks it again for real.
export const canPlace = (state, def, x, y, rot, ignoreId = 0) => footprintClear(state, def, x, y, rot, ignoreId);

export function placeObject(state, def, x, y, rot = 0) {
  const o = OBJECTS[def];
  if (!o || o.fixed) return { ok: false, msg: 'Not for sale.' };
  if (state.funds < o.price) return { ok: false, msg: 'Not enough money.' };
  if (!footprintClear(state, def, x, y, rot)) return { ok: false, msg: 'Doesn’t fit there.' };
  state.funds -= o.price;
  const obj = { id: state.lot.nextObjectId++, def, x, y, rot };
  state.lot.objects.push(obj);
  rebuildDerived(state);
  return { ok: true, id: obj.id };
}

export function moveObject(state, id, x, y, rot) {
  const obj = objectById(state, id);
  if (!obj) return { ok: false, msg: 'It’s gone.' };
  if (!footprintClear(state, obj.def, x, y, rot, id)) return { ok: false, msg: 'Doesn’t fit there.' };
  Object.assign(obj, { x, y, rot });
  rebuildDerived(state);
  return { ok: true };
}

export function sellObject(state, id) {
  const i = state.lot.objects.findIndex((o) => o.id === id);
  if (i === -1) return { ok: false, msg: 'It’s gone.' };
  const obj = state.lot.objects[i];
  const def = OBJECTS[obj.def];
  if (def.fixed && obj.def === 'urn') return { ok: false, msg: 'Have some respect.' };
  // Selling the thing somebody is walking to just drops their action later.
  state.lot.objects.splice(i, 1);
  state.funds += Math.round(def.price * RESALE);
  rebuildDerived(state);
  return { ok: true, refund: Math.round(def.price * RESALE) };
}

// side 'N'|'W', val: 0 none · 1 wall · 2 door · 3 window. Doors and windows
// upgrade an existing wall; bulldozing anything refunds half the wall.
export function setEdge(state, side, x, y, val) {
  const arr = side === 'N' ? state.lot.wallsN : state.lot.wallsW;
  if (arr[y]?.[x] == null) return { ok: false, msg: 'Off the lot.' };
  const cur = arr[y][x];
  if (cur === val) return { ok: false, msg: '' };
  if (val === 1 && !edgeClearOfObjects(state, side, x, y)) return { ok: false, msg: 'Something is in the way.' };
  const cost = val === 1 ? WALL_COST
    : val === 2 ? (cur === 1 ? DOOR_COST : null)
    : val === 3 ? (cur === 1 ? WINDOW_COST : null)
    : -Math.round(WALL_COST * WALL_REFUND);
  if (cost == null) return { ok: false, msg: 'Needs a wall first.' };
  if (cur === 0 && val !== 1) return { ok: false, msg: 'Needs a wall first.' };
  if (state.funds < cost) return { ok: false, msg: 'Not enough money.' };
  state.funds -= cost;
  arr[y][x] = val;
  rebuildDerived(state);
  return { ok: true, was: cur };
}

// A new wall may not slice through an object's footprint.
function edgeClearOfObjects(state, side, x, y) {
  const [ax, ay, bx, by] = side === 'N' ? [x, y - 1, x, y] : [x - 1, y, x, y];
  const idA = state.derived.blocked[ay]?.[ax] ?? 0;
  const idB = state.derived.blocked[by]?.[bx] ?? 0;
  return !(idA !== 0 && idA === idB);
}

export function paintFloor(state, x, y, floorId) {
  if (x < 0 || y < 0 || x >= state.lot.w || y >= state.lot.h) return { ok: false, msg: 'Off the lot.' };
  if (!FLOORS.some((f) => f.id === floorId) || floorId === 0) return { ok: false, msg: 'Not a floor.' };
  if (state.lot.floor[y][x] === floorId) return { ok: false, msg: '' };
  if (state.funds < FLOOR_COST) return { ok: false, msg: 'Not enough money.' };
  state.funds -= FLOOR_COST;
  const was = state.lot.floor[y][x];
  state.lot.floor[y][x] = floorId;
  return { ok: true, was };
}

export function payBills(state) {
  if (state.bills.due <= 0) return { ok: false, msg: 'Nothing owed.' };
  if (state.funds < state.bills.due) return { ok: false, msg: 'Not enough money.' };
  state.funds -= state.bills.due;
  state.bills.due = 0;
  return { ok: true };
}

/* ============================== step ============================== */

export function step(state) {
  const events = [];
  if (state.phase !== 'live' || state.mode !== 'live' || state.time.speed === 0) return { events };

  const dt = MIN_PER_TICK * state.time.speed;
  const prevAbs = absMin(state);
  const newAbs = prevAbs + dt;
  const crossed = (m) => prevAbs < m && m <= newAbs;   // absolute sim-minute
  // Daily clock-time crossings, robust across midnight because abs time is monotonic.
  const crossedDaily = (minuteOfDay) => {
    const base = Math.floor(prevAbs / 1440) * 1440;
    return crossed(base + minuteOfDay) || crossed(base + 1440 + minuteOfDay);
  };

  state.time.minute += dt;
  if (state.time.minute >= 1440) { state.time.minute -= 1440; state.time.day++; onNewDay(state, events); }
  if (Math.floor(prevAbs / 60) !== Math.floor(newAbs / 60)) events.push({ t: 'hourly' });

  stepBills(state, events, crossedDaily);
  stepWork(state, events, newAbs, crossedDaily);
  for (const sim of [...state.sims]) stepSim(state, sim, dt, newAbs, events);
  stepTownies(state, dt, newAbs, events);
  stepFires(state, dt, events);
  stepGhosts(state, dt, events, crossedDaily);

  if (state.sims.length === 0 && state.phase === 'live') {
    state.phase = 'gameover';
    events.push({ t: 'gameover' });
  }
  return { events };
}

function onNewDay(state, events) {
  if (!state.visitPlan && rand(state) < VISIT_CHANCE) scheduleVisit(state);
  for (const g of state.ghosts) g.spookedIds = [];
}

function scheduleVisit(state) {
  if (!state.townies.length) return;
  // Partners get double weight in the draw — they miss you.
  const pool = [];
  for (const t of state.townies) {
    pool.push(t.id);
    if (state.sims.some((s) => relTo(s, t.id).partner)) pool.push(t.id);
  }
  state.visitPlan = {
    day: state.time.day + (state.time.minute > 18 * 60 ? 1 : 0),
    minute: (10 + randInt(state, 8)) * 60 + randInt(state, 60),
    townieId: pool[randInt(state, pool.length)],
  };
}

/* ---- money ---- */

function stepBills(state, events, crossedDaily) {
  const b = state.bills;
  if (b.due === 0 && state.time.day % BILL_EVERY_DAYS === 0 &&
      b.issuedDay !== state.time.day && crossedDaily(9 * 60)) {
    const value = state.lot.objects.reduce((s, o) => s + OBJECTS[o.def].price, 0);
    b.due = BILL_BASE + Math.round(value * BILL_RATE);
    b.issuedDay = state.time.day;
    b.deadlineDay = state.time.day + BILL_GRACE_DAYS;
    events.push({ t: 'bill', due: b.due });
  }
  if (b.due > 0 && state.time.day >= b.deadlineDay && crossedDaily(9 * 60)) {
    // The repo man takes the priciest thing that isn't sacred.
    const takeable = state.lot.objects.filter((o) => !OBJECTS[o.def].fixed);
    if (takeable.length) {
      const worst = takeable.reduce((a, o) => (OBJECTS[o.def].price > OBJECTS[a.def].price ? o : a));
      state.lot.objects.splice(state.lot.objects.indexOf(worst), 1);
      rebuildDerived(state);
      events.push({ t: 'repossess', label: OBJECTS[worst.def].label });
    }
    b.due = 0;
  }
}

/* ---- work ---- */

export function canGoToWork(state, sim) {
  const c = CAREERS[sim.job.career];
  const m = state.time.minute;
  return !sim.atWork && sim.job.lastWorkedDay !== state.time.day &&
    m >= (c.start - 2) * 60 && m < c.end * 60;
}

function stepWork(state, events, newAbs, crossedDaily) {
  for (const sim of state.sims) {
    const c = CAREERS[sim.job.career];
    if (sim.atWork && newAbs >= sim.workReturnMin) {
      sim.atWork = false;
      sim.pos = { x: LOT_DOOR[0], y: LOT_DOOR[1] };
      sim.path = [];
      const lvl = c.levels[sim.job.level - 1];
      state.funds += lvl.pay;
      sim.job.lastWorkedDay = state.time.day;
      sim.job.missedDays = 0;
      events.push({ t: 'toast', msg: `${sim.name} came home with §${lvl.pay}.` });
      if (sim.job.level < c.levels.length) {
        const next = c.levels[sim.job.level];
        const qualified = Object.entries(next.req).every(([sk, n]) => sim.skills[sk] >= n);
        if (qualified && sim.moodAtDeparture >= PROMOTION_MOOD) {
          sim.job.level++;
          events.push({ t: 'promotion', name: sim.name, title: next.title });
        }
      }
    }
    // Shift's over and they never went: that's a missed day.
    if (!sim.atWork && sim.job.lastWorkedDay !== state.time.day && crossedDaily(c.end * 60)) {
      sim.job.lastWorkedDay = state.time.day;   // marks the day judged, worked or not
      sim.job.missedDays++;
      if (sim.job.missedDays >= 2 && sim.job.level > 1) {
        sim.job.level--;
        sim.job.missedDays = 0;
        events.push({ t: 'demotion', name: sim.name, title: c.levels[sim.job.level - 1].title });
      } else {
        events.push({ t: 'toast', msg: `${sim.name} missed work.` });
      }
    }
  }
}

/* ---- one sim, one tick ---- */

function stepSim(state, sim, dt, newAbs, events) {
  // The Reaper's appointment book is kept even mid-social.
  if (sim.dying) {
    if (newAbs >= sim.dying.atMin) killSim(state, sim, sim.dying.cause, events);
    return;
  }

  decayNeeds(state, sim, dt);

  if (sim.atWork) return;

  // Physiological interrupts — the body outranks the queue.
  if (sim.passedOutUntil != null) {
    if (newAbs >= sim.passedOutUntil) {
      sim.passedOutUntil = null;
      sim.needs.energy = PASSOUT_ENERGY;
      sim.needs.comfort = clamp(sim.needs.comfort - 20, 0, 100);
    }
    return;
  }
  if (sim.needs.bladder <= 0) {
    sim.needs.bladder = 100;
    sim.needs.hygiene = clamp(sim.needs.hygiene - 40, 0, 100);
    sim.needs.fun = clamp(sim.needs.fun - 15, 0, 100);
    placeFixed(state, 'puddle', Math.round(sim.pos.x), Math.round(sim.pos.y));
    events.push({ t: 'toast', msg: `${sim.name} had an accident.` });
  }
  if (sim.needs.energy <= 0 && !isSleeping(sim)) {
    sim.passedOutUntil = newAbs + PASSOUT_MIN;
    sim.path = [];
    const head = sim.queue[0];
    if (head) cancelAction(state, sim.id, head.aid);
    events.push({ t: 'toast', msg: `${sim.name} passed out on the floor.` });
    return;
  }

  // The starving clock. Set once at empty, cleared by any mouthful.
  if (sim.needs.hunger <= 0) {
    if (sim.starveDeadline == null) {
      sim.starveDeadline = newAbs + STARVE_GRACE_MIN;
      events.push({ t: 'starving', simId: sim.id });
    } else if (newAbs >= sim.starveDeadline) {
      sim.starveDeadline = null;
      sim.dying = { atMin: newAbs + REAPER_MIN, cause: 'starvation' };
      events.push({ t: 'toast', msg: `Death has come for ${sim.name}.` });
      return;
    }
  } else {
    sim.starveDeadline = null;
  }

  // Fire is patient but not that patient.
  if (state.fires.length && nearFire(state, sim)) {
    sim.fireExposure += dt;
    if (sim.fireExposure >= FIRE_KILL_MIN) { killSim(state, sim, 'fire', events); return; }
  } else {
    sim.fireExposure = 0;
  }

  if (sim.busyWith) return;          // captured by someone's social; their tick does the work

  stepQueue(state, sim, dt, newAbs, events);
}

function decayNeeds(state, sim, dt) {
  const seated = state.derived.seatAt[Math.round(sim.pos.y)]?.[Math.round(sim.pos.x)];
  for (const n of NEEDS) {
    if (sim.atWork && n.id === 'social') { sim.needs.social = clamp(sim.needs.social + (5 / 60) * dt, 0, 100); continue; }
    if (isSleeping(sim) && (n.id === 'energy' || n.id === 'comfort')) continue; // the bed's perMin owns these
    let rate = (n.decay / 60) * traitMult(sim, 'decay.' + n.id);
    if (sim.atWork) rate *= 0.4;
    if (n.id === 'comfort' && seated && !sim.atWork) rate = -(8 / 60);
    sim.needs[n.id] = clamp(sim.needs[n.id] - rate * dt, 0, 100);
  }
}

const isSleeping = (sim) => {
  const head = sim.queue?.[0];       // townies have no queue and never sleep here
  return head?.state === 'running' && head.kind === 'object' && !!headInteraction(sim)?.until;
};
function headInteraction(sim) {
  const head = sim.queue?.[0];
  if (!head || head.kind !== 'object') return null;
  return OBJECTS[head.objDef]?.interactions.find((i) => i.id === head.def) || null;
}

function nearFire(state, sim) {
  return state.fires.some((f) =>
    Math.abs(f.x - sim.pos.x) <= 1.2 && Math.abs(f.y - sim.pos.y) <= 1.2);
}

/* ---- the action queue ---- */

function stepQueue(state, sim, dt, newAbs, events) {
  const head = sim.queue[0];
  if (!head) return;

  if (head.state === 'queued') {
    const res = resolveTarget(state, sim, head);
    if (!res) {
      sim.queue.shift();
      events.push({ t: 'toast', msg: `${sim.name} can’t get there.` });
      return;
    }
    head.tx = res.tx; head.ty = res.ty;
    if (head.kind === 'object') head.objDef = objectById(state, head.objectId)?.def;
    sim.path = res.path;
    head.state = 'moving';
  }

  if (head.state === 'moving') {
    if (walk(sim, dt)) {
      // Arrived. What happens next depends on what this was.
      if (head.kind === 'go') { sim.queue.shift(); return; }
      if (head.kind === 'work') {
        const c = CAREERS[sim.job.career];
        sim.queue.shift();
        sim.atWork = true;
        sim.moodAtDeparture = mood(state, sim);
        const base = Math.floor(newAbs / 1440) * 1440;
        sim.workReturnMin = base + c.end * 60 + (state.time.minute > c.end * 60 ? 1440 : 0);
        events.push({ t: 'toast', msg: `${sim.name} left for work.` });
        return;
      }
      if (head.kind === 'extinguish') {
        head.state = 'running';
        head.remainingMin = EXTINGUISH_MIN;
        return;
      }
      if (head.kind === 'object') {
        const obj = objectById(state, head.objectId);
        const ia = obj && OBJECTS[obj.def].interactions.find((i) => i.id === head.def);
        if (!ia) { sim.queue.shift(); events.push({ t: 'toast', msg: 'That’s gone.' }); return; }
        // Someone may have claimed the seat/bed while we crossed the room.
        head.state = 'running';
        head.remainingMin = ia.minutes;
        sim.facing = faceToward(sim.pos, obj);
        return;
      }
      if (head.kind === 'social') {
        const target = simById(state, head.targetId);
        const refuse = !target || target.atWork || target.busyWith || target.dying ||
          target.passedOutUntil != null || isSleeping(target) ||
          dist(sim.pos, target.pos) > 2.2;
        if (refuse) {
          sim.queue.shift();
          events.push({ t: 'toast', msg: `${sim.name} couldn’t get their attention.` });
          return;
        }
        const social = SOCIALS.find((s) => s.id === head.def);
        target.busyWith = { aid: head.aid, withId: sim.id };
        if (target.path) target.path = [];
        head.state = 'running';
        head.remainingMin = social.minutes;
        return;
      }
    }
    return;
  }

  // running
  head.remainingMin -= dt;
  if (head.kind === 'object') runObjectAction(state, sim, head, dt, events);
  if (head.kind === 'extinguish' && head.remainingMin <= 0) {
    state.fires = state.fires.filter((f) => !(Math.abs(f.x - head.tx) <= 1 && Math.abs(f.y - head.ty) <= 1));
    sim.queue.shift();
    events.push({ t: 'toast', msg: `${sim.name} put out the fire.` });
  }
  if (head.kind === 'social' && head.remainingMin <= 0) finishSocial(state, sim, head, events);
}

function runObjectAction(state, sim, head, dt, events) {
  const obj = objectById(state, head.objectId);
  const ia = obj && OBJECTS[obj.def].interactions.find((i) => i.id === head.def);
  if (!ia) { sim.queue.shift(); return; }

  for (const [need, perMin] of Object.entries(ia.perMin)) {
    sim.needs[need] = clamp(sim.needs[need] + perMin * dt, 0, 100);
  }
  if (ia.skillPerMin) {
    const bonus = mood(state, sim) >= 70 ? MOOD_SKILL_BONUS : 1;
    for (const [sk, perMin] of Object.entries(ia.skillPerMin)) {
      sim.skills[sk] = clamp(sim.skills[sk] + perMin * traitMult(sim, 'skill.' + sk) * bonus * dt, 0, SKILL_MAX);
    }
  }

  const doneEarly = ia.until && sim.needs[ia.until] >= 100;
  if (head.remainingMin <= 0 || doneEarly) {
    if (ia.set) for (const [need, v] of Object.entries(ia.set)) sim.needs[need] = v;
    if (ia.id === 'cook' || ia.id === 'quick' || ia.id === 'snack') {
      // Foodie: any meal is a small joy.
      const t = TRAITS.find((x) => sim.traits.includes(x.id) && x.mealFun);
      if (t) sim.needs.fun = clamp(sim.needs.fun + t.mealFun, 0, 100);
    }
    if (ia.fireRisk) {
      const p = Math.max(0, FIRE_BASE - FIRE_PER_SKILL * sim.skills.cooking);
      if (rand(state) < p) {
        state.fires.push({ x: obj.x, y: obj.y, age: 0, spread: 0 });
        events.push({ t: 'fire', msg: 'FIRE! The stove is burning!' });
      }
    }
    if (ia.consumes) {
      const i = state.lot.objects.indexOf(obj);
      if (i !== -1) { state.lot.objects.splice(i, 1); rebuildDerived(state); }
    }
    sim.queue.shift();
  }
}

function finishSocial(state, sim, head, events) {
  const target = simById(state, head.targetId);
  const social = SOCIALS.find((s) => s.id === head.def);
  sim.queue.shift();
  if (target?.busyWith?.aid === head.aid) target.busyWith = null;
  if (!target) return;

  const failed = social.fail != null && rand(state) < social.fail;
  const isTownie = (id) => id.startsWith('t');
  const relMult = (a, otherId) =>
    traitMult(a, 'rel') * (isTownie(otherId) ? traitMult(a, 'townieRel') : 1);

  if (failed) {
    const sting = social.failFriend * traitMult(sim, 'rejection');
    relRow(sim, target.id).friend = clamp(relRow(sim, target.id).friend + sting, 0, 100);
    relRow(target, sim.id).friend = clamp(relRow(target, sim.id).friend + social.failFriend, 0, 100);
    events.push({ t: 'toast', msg: `${sim.name}’s ${social.label.toLowerCase()} fell flat.` });
    return;
  }

  for (const [a, b] of [[sim, target], [target, sim]]) {
    const row = relRow(a, b.id);
    row.friend = clamp(row.friend + social.friend * relMult(a, b.id), 0, 100);
    row.romance = clamp(row.romance + social.romance * traitMult(a, 'romance') * relMult(a, b.id), 0, 100);
    if (social.partner) row.partner = true;
    if (a.needs) {
      a.needs.social = clamp(a.needs.social + social.social, 0, 100);
      a.needs.fun = clamp(a.needs.fun + social.fun, 0, 100);
    }
  }
  if (social.partner) events.push({ t: 'toast', msg: `${sim.name} and ${target.name} are partners! 💍` });
}

/* ---- movement ---- */

// Advance along the waypoint list. Returns true once there's nowhere left to go.
function walk(sim, dt) {
  let budget = WALK_SPEED * dt;
  while (budget > 0) {
    const next = sim.path[0];
    if (!next) return true;
    const dx = next[0] - sim.pos.x, dy = next[1] - sim.pos.y;
    const d = Math.hypot(dx, dy);
    if (d <= budget) {
      sim.pos.x = next[0]; sim.pos.y = next[1];
      sim.path.shift();
      budget -= d;
    } else {
      sim.pos.x += (dx / d) * budget;
      sim.pos.y += (dy / d) * budget;
      sim.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
      return false;
    }
  }
  return sim.path.length === 0;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function faceToward(pos, obj) {
  const dx = obj.x - pos.x, dy = obj.y - pos.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
}

/* ---- townies ---- */

function stepTownies(state, dt, newAbs, events) {
  const vp = state.visitPlan;
  if (vp && (state.time.day > vp.day || (state.time.day === vp.day && state.time.minute >= vp.minute))) {
    state.visitPlan = null;
    const townie = state.townies.find((t) => t.id === vp.townieId);
    if (townie && !townie.present && state.sims.length) {
      townie.present = true;
      townie.pos = { x: LOT_DOOR[0], y: LOT_DOOR[1] };
      townie.path = [];
      townie.leavesAtMin = newAbs + VISIT_STAY_MIN;
      townie.nextChatMin = newAbs + 20;
      townie.arrivedAtMin = newAbs;
      events.push({ t: 'doorbell', name: townie.name });
    }
  }

  for (const townie of state.townies) {
    if (!townie.present) continue;
    const curfew = Math.floor(newAbs / 1440) * 1440 + VISIT_CURFEW * 60;
    const overstayed = newAbs >= townie.leavesAtMin || (newAbs >= curfew && state.time.minute >= VISIT_CURFEW * 60);
    if (overstayed && !townie.busyWith) {
      townie.present = false; townie.pos = null; townie.path = [];
      events.push({ t: 'toast', msg: `${townie.name} went home.` });
      continue;
    }
    if (townie.busyWith) {
      // A chat the townie started itself resolves here; one a sim started
      // resolves in that sim's finishSocial.
      if (townie.chatEndsAtMin && newAbs >= townie.chatEndsAtMin) {
        const other = simById(state, townie.chatWith);
        townie.busyWith = null;
        townie.chatEndsAtMin = null;
        townie.chatWith = null;
        townie.nextChatMin = newAbs + 45;
        if (other) {
          other.busyWith = null;
          const chat = SOCIALS[0];
          other.needs.social = clamp(other.needs.social + chat.social, 0, 100);
          relRow(other, townie.id).friend = clamp(relRow(other, townie.id).friend + chat.friend, 0, 100);
          relRow(townie, other.id).friend = clamp(relRow(townie, other.id).friend + chat.friend, 0, 100);
        }
      }
      continue;
    }

    // Drift toward the nearest household member; occasionally start a chat of
    // their own, which is the only way a lone sim's social bar ever refills
    // without the player micromanaging both halves of every conversation.
    const nearest = state.sims
      .filter((s) => !s.atWork && !s.dying && s.passedOutUntil == null)
      .sort((a, b) => dist(a.pos, townie.pos) - dist(b.pos, townie.pos))[0];
    if (!nearest) {
      // Nobody home to talk to; an hour of standing on the lawn and they leave.
      if (newAbs - townie.arrivedAtMin > 60) townie.leavesAtMin = newAbs;
      continue;
    }
    if (dist(nearest.pos, townie.pos) > 1.6) {
      if (!townie.path.length) {
        const from = [Math.round(townie.pos.x), Math.round(townie.pos.y)];
        const to = [Math.round(nearest.pos.x), Math.round(nearest.pos.y)];
        const p = findPath(state.lot.w, state.lot.h,
          (x, y) => state.derived.blocked[y][x] !== 0, canWalk(state), from, to);
        // Path to an adjacent tile, not onto their head; a null path for an
        // hour means the house has no door and the townie gives up.
        if (p && p.length) { p.pop(); townie.path = p; }
        else if (newAbs - townie.arrivedAtMin > 60) townie.leavesAtMin = newAbs;
      }
      walk(townie, dt);
    } else if (newAbs >= townie.nextChatMin && !nearest.busyWith && !isSleeping(nearest)) {
      // Townies chat unprompted, through the same social machinery.
      const chat = SOCIALS[0];
      nearest.busyWith = { aid: -1, withId: townie.id };
      townie.busyWith = { aid: -1, withId: nearest.id };
      townie.chatEndsAtMin = newAbs + chat.minutes;
      townie.chatWith = nearest.id;
    }
  }
}

/* ---- fire ---- */

function stepFires(state, dt, events) {
  if (!state.fires.length) return;
  let rebuilt = false;
  for (const f of [...state.fires]) {
    f.age += dt;
    // Spread: every FIRE_SPREAD_MIN, try to jump to an adjacent object tile.
    if (Math.floor(f.age / FIRE_SPREAD_MIN) > f.spread) {
      f.spread++;
      const targets = [];
      for (const [nx, ny] of neighbours(state, f.x, f.y)) {
        const id = state.derived.blocked[ny][nx];
        if (id !== 0 && !state.fires.some((g) => g.x === nx && g.y === ny)) targets.push([nx, ny]);
      }
      if (targets.length) {
        const [nx, ny] = targets[randInt(state, targets.length)];
        state.fires.push({ x: nx, y: ny, age: 0, spread: 0 });
        events.push({ t: 'fire', msg: 'The fire is spreading!' });
      }
    }
    // Whatever stands in a mature flame is destroyed.
    if (f.age >= FIRE_BURN_MIN) {
      const id = state.derived.blocked[f.y]?.[f.x];
      const obj = id ? objectById(state, id) : null;
      if (obj && obj.def !== 'urn') {
        state.lot.objects.splice(state.lot.objects.indexOf(obj), 1);
        rebuilt = true;
        events.push({ t: 'toast', msg: `The ${OBJECTS[obj.def].label.toLowerCase()} burned to ash.` });
      }
      // A fire with nothing left to eat goes out on its own.
      if (!obj) state.fires.splice(state.fires.indexOf(f), 1);
    }
  }
  if (rebuilt) rebuildDerived(state);
}

/* ---- ghosts ---- */

function stepGhosts(state, dt, events, crossedDaily) {
  if (crossedDaily(GHOST_HOUR * 60)) {
    for (const g of state.ghosts) {
      if (rand(state) < GHOST_CHANCE) {
        const urn = objectById(state, g.urnObjectId);
        g.active = true;
        g.pos = urn ? { x: urn.x, y: urn.y } : { x: state.lot.w / 2, y: state.lot.h / 2 };
        g.tx = null;
      }
    }
    if (state.ghosts.some((g) => g.active)) events.push({ t: 'toast', msg: 'A chill settles over the house…' });
  }
  if (crossedDaily(GHOST_DAWN * 60)) {
    for (const g of state.ghosts) { g.active = false; g.pos = null; }
  }
  for (const g of state.ghosts) {
    if (!g.active || !g.pos) continue;
    // Glide to a random spot; walls are a living-person problem.
    if (g.tx == null || (Math.abs(g.pos.x - g.tx) < 0.1 && Math.abs(g.pos.y - g.ty) < 0.1)) {
      g.tx = 1 + randInt(state, state.lot.w - 2);
      g.ty = 1 + randInt(state, state.lot.h - 2);
    }
    const dx = g.tx - g.pos.x, dy = g.ty - g.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const sp = Math.min(d, 1.0 * dt);
    g.pos.x += (dx / d) * sp;
    g.pos.y += (dy / d) * sp;
    for (const sim of state.sims) {
      if (sim.atWork || g.spookedIds.includes(sim.id)) continue;
      if (dist(sim.pos, g.pos) <= GHOST_RANGE) {
        g.spookedIds.push(sim.id);
        sim.needs.fun = clamp(sim.needs.fun + SPOOK_FUN, 0, 100);
        sim.needs.comfort = clamp(sim.needs.comfort + SPOOK_COMFORT, 0, 100);
        events.push({ t: 'toast', msg: `${sim.name} was spooked by ${g.name}’s ghost!` });
      }
    }
  }
}

/* ---- death ---- */

function killSim(state, sim, cause, events) {
  const i = state.sims.indexOf(sim);
  if (i === -1) return;
  state.sims.splice(i, 1);
  // Release anyone this sim had captured, and anyone holding them.
  for (const other of [...state.sims, ...state.townies]) {
    if (other.busyWith?.withId === sim.id) other.busyWith = null;
  }
  const [ux, uy] = nearestFreeTile(state, Math.round(sim.pos.x), Math.round(sim.pos.y));
  const urnId = placeFixed(state, 'urn', ux, uy);
  state.ghosts.push({ name: sim.name, shirt: sim.shirt, urnObjectId: urnId,
    active: false, pos: null, tx: null, ty: null, spookedIds: [] });
  state.deadLog.push({ name: sim.name, day: state.time.day, cause });
  events.push({ t: 'death', name: sim.name, cause });
}

function placeFixed(state, def, x, y) {
  // Fixed objects (urns, puddles) skip the shop but still occupy the world.
  if (def === 'puddle' && state.lot.objects.some((o) => o.def === 'puddle' && o.x === x && o.y === y)) return 0;
  const obj = { id: state.lot.nextObjectId++, def, x, y, rot: 0 };
  state.lot.objects.push(obj);
  rebuildDerived(state);
  return obj.id;
}

function nearestFreeTile(state, x, y) {
  const { w, h } = state.lot;
  for (let r = 0; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = clamp(x + dx, 0, w - 1), ny = clamp(y + dy, 0, h - 1);
      if (state.derived.blocked[ny][nx] === 0) return [nx, ny];
    }
  }
  return [x, y];
}

/* ============================== saves ============================== */

// A deep JSON copy with the derived caches stripped. Everything else in state
// is already plain data — that's a rule this file keeps on purpose.
export function serialize(state) {
  const { derived, ...rest } = state;
  return JSON.parse(JSON.stringify(rest));
}

// Storage is untrusted input: an old version of this file wrote it, or a hand
// with devtools open edited it. Coerce, clamp, and drop what can't be mended;
// return null only when there is no game worth salvaging in it.
export function deserialize(raw) {
  if (!raw || typeof raw !== 'object' || !raw.lot || !Array.isArray(raw.sims)) return null;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const state = {
    v: SAVE_VERSION,
    phase: raw.phase === 'gameover' ? 'gameover' : 'live',
    mode: 'live',                    // never resume into build mode
    seed: num(raw.seed, 1),
    rng: { s: num(raw.rng?.s, 1) >>> 0 },
    time: { day: Math.max(1, num(raw.time?.day, 1)), minute: clamp(num(raw.time?.minute, 480), 0, 1439.99), speed: 1 },
    funds: num(raw.funds, 0),
    bills: { due: Math.max(0, num(raw.bills?.due, 0)), issuedDay: num(raw.bills?.issuedDay, 0), deadlineDay: num(raw.bills?.deadlineDay, 0) },
    lot: sanitiseLot(raw.lot, num),
    sims: raw.sims.map((s, i) => sanitiseSim(s, i, num)).filter(Boolean).slice(0, MAX_SIMS),
    townies: (Array.isArray(raw.townies) ? raw.townies : []).map((t, i) => sanitiseTownie(t, i, num)).filter(Boolean),
    visitPlan: raw.visitPlan && num(raw.visitPlan.minute, -1) >= 0
      ? { day: num(raw.visitPlan.day, 1), minute: num(raw.visitPlan.minute, 600), townieId: String(raw.visitPlan.townieId || 't1') }
      : null,
    ghosts: (Array.isArray(raw.ghosts) ? raw.ghosts : []).map((g) => ({
      name: String(g?.name || 'Ghost'), shirt: String(g?.shirt || '#98a0a8'),
      urnObjectId: num(g?.urnObjectId, 0), active: false, pos: null, tx: null, ty: null, spookedIds: [],
    })),
    fires: [],                       // an unattended browser tab doesn't burn the house down
    deadLog: (Array.isArray(raw.deadLog) ? raw.deadLog : []).map((d) => ({
      name: String(d?.name || '?'), day: num(d?.day, 1), cause: String(d?.cause || 'mystery'),
    })),
  };
  rebuildDerived(state);
  return state;
}

function sanitiseLot(lot, num) {
  const cleanGrid = (src, w, h, max) => {
    const g2 = grid(w, h, 0);
    if (Array.isArray(src)) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = num(src[y]?.[x], 0);
      g2[y][x] = v >= 0 && v <= max ? Math.floor(v) : 0;
    }
    return g2;
  };
  const objects = (Array.isArray(lot.objects) ? lot.objects : [])
    .filter((o) => o && OBJECTS[o.def])
    .map((o) => ({ id: num(o.id, 0), def: o.def, x: clamp(num(o.x, 0), 0, LOT_W - 1), y: clamp(num(o.y, 0), 0, LOT_H - 1), rot: num(o.rot, 0) & 3 }))
    .filter((o) => o.id > 0);
  return {
    w: LOT_W, h: LOT_H,
    floor: cleanGrid(lot.floor, LOT_W, LOT_H, FLOORS.length - 1),
    wallsN: cleanGrid(lot.wallsN, LOT_W, LOT_H + 1, 3),
    wallsW: cleanGrid(lot.wallsW, LOT_W + 1, LOT_H, 3),
    objects,
    nextObjectId: Math.max(num(lot.nextObjectId, 1), ...objects.map((o) => o.id + 1), 1),
  };
}

function sanitiseSim(s, i, num) {
  if (!s || typeof s !== 'object' || !s.name) return null;
  const needs = {};
  for (const n of NEEDS) needs[n.id] = clamp(num(s.needs?.[n.id], 70), 0, 100);
  const skills = {};
  for (const sk of SKILLS) skills[sk] = clamp(num(s.skills?.[sk], 0), 0, SKILL_MAX);
  const career = CAREERS[s.job?.career] ? s.job.career : 'business';
  const rel = {};
  if (s.rel && typeof s.rel === 'object') {
    for (const [k, r] of Object.entries(s.rel)) {
      rel[k] = { friend: clamp(num(r?.friend, 0), 0, 100), romance: clamp(num(r?.romance, 0), 0, 100), partner: !!r?.partner };
    }
  }
  return {
    id: String(s.id || 's' + (i + 1)),
    name: String(s.name).slice(0, 12),
    shirt: String(s.shirt || SHIRTS[i % SHIRTS.length]),
    traits: (Array.isArray(s.traits) ? s.traits : []).filter((t) => TRAITS.some((x) => x.id === t)).slice(0, 2),
    needs, skills, rel,
    job: {
      career,
      level: clamp(Math.floor(num(s.job?.level, 1)), 1, CAREERS[career].levels.length),
      missedDays: Math.max(0, num(s.job?.missedDays, 0)),
      lastWorkedDay: num(s.job?.lastWorkedDay, 0),
    },
    pos: { x: clamp(num(s.pos?.x, LOT_DOOR[0]), 0, LOT_W - 1), y: clamp(num(s.pos?.y, LOT_DOOR[1]), 0, LOT_H - 1) },
    facing: num(s.facing, 0) & 3,
    // Mid-walk and mid-action progress doesn't survive a reload; the queue
    // does, demoted to 'queued' so every head re-resolves against the loaded world.
    path: [],
    queue: (Array.isArray(s.queue) ? s.queue : []).map((a) => a && a.kind
      ? { ...a, state: 'queued', path: undefined } : null).filter(Boolean).slice(0, QUEUE_CAP),
    nextAid: Math.max(1, num(s.nextAid, 1)),
    atWork: !!s.atWork,
    workReturnMin: num(s.workReturnMin, 0),
    moodAtDeparture: num(s.moodAtDeparture, 0),
    busyWith: null,
    starveDeadline: s.starveDeadline == null ? null : num(s.starveDeadline, null),
    passedOutUntil: s.passedOutUntil == null ? null : num(s.passedOutUntil, null),
    fireExposure: 0,
    dying: s.dying ? { atMin: num(s.dying.atMin, 0), cause: String(s.dying.cause || 'starvation') } : null,
  };
}

function sanitiseTownie(t, i, num) {
  if (!t || typeof t !== 'object') return null;
  return {
    id: String(t.id || 't' + (i + 1)),
    name: String(t.name || TOWNIE_NAMES[i % TOWNIE_NAMES.length]),
    shirt: String(t.shirt || SHIRTS[i % SHIRTS.length]),
    traits: (Array.isArray(t.traits) ? t.traits : []).filter((x) => TRAITS.some((tr) => tr.id === x)),
    rel: (() => {
      const rel = {};
      if (t.rel && typeof t.rel === 'object') {
        for (const [k, r] of Object.entries(t.rel)) {
          rel[k] = { friend: clamp(num(r?.friend, 0), 0, 100), romance: clamp(num(r?.romance, 0), 0, 100), partner: !!r?.partner };
        }
      }
      return rel;
    })(),
    present: false, pos: null, path: [], busyWith: null,
    leavesAtMin: 0, nextChatMin: 0, arrivedAtMin: 0, chatEndsAtMin: null, chatWith: null,
  };
}

/* ============================== small helpers ============================== */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export { clamp };
