// Tests for The Sims 5 rules, catalogue and pathfinding.
// Run: node --test test/
//
// Everything here imports only the pure modules — never index.js — so no DOM
// stub is needed. Sim time is stepped through rules.step at 1× speed; one
// sim-hour is exactly 500 ticks (60 / 0.12), which the runMin helper leans on.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createState, refound, step, rand, absMin, MIN_PER_TICK, LOT_W, LOT_H,
  simById, objectById, mood, relTo, rebuildDerived, repathMovers,
  queueGo, queueObjectAction, queueSocial, queueGoToWork, cancelAction,
  availableSocials, availableInteractions, canGoToWork,
  placeObject, moveObject, sellObject, setEdge, paintFloor, payBills, canPlace,
  serialize, deserialize, roomScoreAt,
} from '../js/games/sims/rules.js';
import {
  OBJECTS, NEEDS, TRAITS, CAREERS, SOCIALS, START_FUNDS,
  WALL_COST, DOOR_COST, FLOOR_COST, RESALE, STARVE_GRACE_MIN, REAPER_MIN,
  objectTiles, slotTiles, rotSize,
} from '../js/games/sims/catalogue.js';
import { findPath } from '../js/games/sims/path.js';

/* ---------------- helpers ---------------- */

function mk(seed = 42) {
  return createState([
    { name: 'Ann', shirt: '#e5484d', traits: ['neat'], career: 'business' },
    { name: 'Bob', shirt: '#3d7dff', traits: [], career: 'business' },
  ], { seed });
}

/** Advance roughly `mins` sim-minutes at the state's current speed (1× unless
 *  changed) and return every event emitted along the way. */
function runMin(g, mins, { feed = false } = {}) {
  const events = [];
  const ticks = Math.round(mins / (MIN_PER_TICK * (g.time.speed || 1)));
  for (let i = 0; i < ticks; i++) {
    if (feed && i % 500 === 0) {
      for (const s of g.sims) for (const n of NEEDS) s.needs[n.id] = 100;
    }
    events.push(...step(g).events);
    if (g.phase === 'gameover') break;
  }
  return events;
}

const closeTo = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} !≈ ${b}`);

/* ---------------- needs ---------------- */

test('needs decay at catalogue rates over idle sim-hours', () => {
  const g = mk();
  const before = { ...g.sims[1].needs };
  runMin(g, 120);   // two sim-hours, everyone standing around obediently
  const bob = g.sims[1];
  closeTo(bob.needs.hunger, before.hunger - 9, 0.2, 'hunger −4.5/h');
  closeTo(bob.needs.energy, before.energy - 10, 0.2, 'energy −5/h');
  closeTo(bob.needs.hygiene, before.hygiene - 7, 0.2, 'hygiene −3.5/h');
});

test('the neat trait slows hygiene decay', () => {
  const g = mk();
  runMin(g, 120);
  const ann = g.sims[0];   // neat
  const bob = g.sims[1];
  closeTo(ann.needs.hygiene, 80 - 7 * 0.6, 0.2, 'neat hygiene ×0.6');
  assert.ok(ann.needs.hygiene > bob.needs.hygiene);
});

test('an exhausted sim passes out and wakes with some energy back', () => {
  const g = mk();
  g.sims[0].needs.energy = 0.01;
  runMin(g, 5);
  assert.notEqual(g.sims[0].passedOutUntil, null);
  runMin(g, 200);   // 180 asleep on the floor, then normal decay resumes
  assert.equal(g.sims[0].passedOutUntil, null);
  closeTo(g.sims[0].needs.energy, 58.3, 1.5, 'wakes around the passout floor');
});

/* ---------------- starvation ---------------- */

test('empty hunger starts the grace countdown and ends with an urn and a ghost', () => {
  const g = mk();
  g.sims[0].needs.hunger = 0;
  const events = runMin(g, STARVE_GRACE_MIN + REAPER_MIN + 30);
  assert.ok(events.some((e) => e.t === 'starving'));
  assert.ok(events.some((e) => e.t === 'death' && e.name === 'Ann'));
  assert.equal(g.sims.length, 1);
  assert.ok(g.lot.objects.some((o) => o.def === 'urn'));
  assert.equal(g.ghosts.length, 1);
  assert.deepEqual(g.deadLog.map((d) => d.cause), ['starvation']);
});

test('eating during the grace period cancels the countdown', () => {
  const g = mk();
  g.sims[0].needs.hunger = 0;
  runMin(g, 120);
  assert.notEqual(g.sims[0].starveDeadline, null);
  g.sims[0].needs.hunger = 50;   // stands in for a meal
  runMin(g, 1);
  assert.equal(g.sims[0].starveDeadline, null);
  runMin(g, STARVE_GRACE_MIN);
  assert.equal(g.sims.length, 2);
});

/* ---------------- pathfinding ---------------- */

test('findPath crosses open ground and refuses sealed targets', () => {
  const open = () => false;
  const cross = () => true;
  const p = findPath(10, 10, open, cross, [0, 0], [5, 5]);
  assert.ok(p && p.length === 10);   // manhattan distance, 4-dir
  const blocked = (x, y) => x === 5 && y === 5;
  assert.equal(findPath(10, 10, blocked, cross, [0, 0], [5, 5]), null);
});

test('sims path through a doorway in a wall that bisects the lot', () => {
  const g = mk();
  for (let x = 0; x < LOT_W; x++) assert.ok(setEdge(g, 'N', x, 12, 1).ok);
  assert.ok(setEdge(g, 'N', 5, 12, 2).ok);   // one door at x=5
  queueGo(g, 's1', 12, 5);
  runMin(g, 90);
  assert.deepEqual([g.sims[0].pos.x, g.sims[0].pos.y], [12, 5]);
});

test('a fully sealed room is unreachable and the action is dropped', () => {
  const g = mk();
  for (let x = 2; x <= 4; x++) { setEdge(g, 'N', x, 2, 1); setEdge(g, 'N', x, 5, 1); }
  for (let y = 2; y <= 4; y++) { setEdge(g, 'W', 2, y, 1); setEdge(g, 'W', 5, y, 1); }
  queueGo(g, 's1', 3, 3);
  const events = runMin(g, 2);
  assert.equal(g.sims[0].queue.length, 0);
  assert.ok(events.some((e) => e.t === 'toast' && e.msg.includes('can’t get there')));
});

test('object use-slots respect rotation', () => {
  const g = mk();
  const res = placeObject(g, 'bed', 10, 10, 1);   // 1×2 rotated to 2×1
  assert.ok(res.ok);
  const obj = objectById(g, res.id);
  assert.deepEqual(rotSize('bed', 1), { w: 2, d: 1 });
  assert.equal(objectTiles(obj).length, 2);
  for (const [sx, sy] of slotTiles(obj)) {
    assert.ok(!objectTiles(obj).some(([ox, oy]) => ox === sx && oy === sy),
      'bed slots sit beside the bed, not on it');
  }
});

/* ---------------- the queue ---------------- */

test('queued actions run in order and can be cancelled', () => {
  const g = mk();
  queueGo(g, 's1', 5, 20);
  queueGo(g, 's1', 18, 20);
  runMin(g, 60);
  assert.deepEqual([g.sims[0].pos.x, g.sims[0].pos.y], [18, 20]);

  queueGo(g, 's1', 2, 2);
  const aid = g.sims[0].queue[0].aid;
  runMin(g, 2);
  cancelAction(g, 's1', aid);
  assert.equal(g.sims[0].queue.length, 0);
  assert.equal(g.sims[0].path.length, 0);
});

test('using an object applies its per-minute needs', () => {
  const g = mk();
  placeObject(g, 'shower', 10, 10, 0);
  g.sims[0].pos = { x: 11, y: 10 };
  g.sims[0].needs.hygiene = 10;
  const shower = g.lot.objects[0];
  assert.ok(queueObjectAction(g, 's1', shower.id, 'shower').ok);
  runMin(g, 40);
  assert.ok(g.sims[0].needs.hygiene > 70, `hygiene refilled, got ${g.sims[0].needs.hygiene}`);
  assert.equal(g.sims[0].queue.length, 0);
});

test('cooking requires a fridge on the lot', () => {
  const g = mk();
  placeObject(g, 'stove', 10, 10, 0);
  const stove = g.lot.objects[0];
  assert.equal(queueObjectAction(g, 's1', stove.id, 'cook').ok, false);
  assert.equal(availableInteractions(g, stove).length, 0);
  placeObject(g, 'fridge', 12, 10, 0);
  assert.equal(availableInteractions(g, stove).length, 1);
  assert.ok(queueObjectAction(g, 's1', stove.id, 'cook').ok);
});

/* ---------------- socials ---------------- */

test('a chat lifts both sims and both sides of the relationship', () => {
  const g = mk();
  g.sims[0].pos = { x: 5, y: 5 };
  g.sims[1].pos = { x: 6, y: 5 };
  assert.ok(queueSocial(g, 's1', 's2', 'chat').ok);
  runMin(g, 15);
  assert.ok(relTo(g.sims[0], 's2').friend >= 4);
  assert.ok(relTo(g.sims[1], 's1').friend >= 4);
  assert.ok(g.sims[1].needs.social > 70, 'the target got the social bump too');
  assert.equal(g.sims[1].busyWith, null, 'the captive is released');
});

test('romance is gated behind friendship and thresholds', () => {
  const g = mk();
  const gates = availableSocials(g.sims[0], g.sims[1]);
  assert.equal(gates.find((x) => x.social.id === 'chat').ok, true);
  assert.equal(gates.find((x) => x.social.id === 'flirt').ok, false);
  assert.equal(gates.find((x) => x.social.id === 'propose').ok, false);
  assert.equal(queueSocial(g, 's1', 's2', 'kiss').ok, false);

  g.sims[0].rel['s2'] = { friend: 60, romance: 80, partner: false };
  const gates2 = availableSocials(g.sims[0], g.sims[1]);
  assert.equal(gates2.find((x) => x.social.id === 'propose').ok, true);
});

test('a proposal makes partners of both sides', () => {
  const g = mk();
  g.sims[0].pos = { x: 5, y: 5 };
  g.sims[1].pos = { x: 6, y: 5 };
  g.sims[0].rel['s2'] = { friend: 60, romance: 80, partner: false };
  g.sims[1].rel['s1'] = { friend: 60, romance: 80, partner: false };
  assert.ok(queueSocial(g, 's1', 's2', 'propose').ok);
  runMin(g, 15);
  assert.equal(relTo(g.sims[0], 's2').partner, true);
  assert.equal(relTo(g.sims[1], 's1').partner, true);
});

test('sims can socialise with a visiting townie', () => {
  // Regression: the arrival check used to read the target's action queue,
  // which townies don't have.
  const g = mk();
  const townie = g.townies[0];
  townie.present = true;
  townie.pos = { x: 6, y: 5 };
  townie.leavesAtMin = 1e9;
  g.sims[0].pos = { x: 5, y: 5 };
  assert.ok(queueSocial(g, 's1', townie.id, 'chat').ok);
  runMin(g, 15);
  assert.ok(relTo(g.sims[0], townie.id).friend >= 4);
  assert.ok(relTo(townie, 's1').friend >= 4);
});

test('a busy or absent target refuses the social', () => {
  const g = mk();
  g.sims[0].pos = { x: 5, y: 5 };
  g.sims[1].pos = { x: 6, y: 5 };
  g.sims[1].atWork = true;
  g.sims[1].workReturnMin = 1e9;   // deep in overtime
  assert.ok(queueSocial(g, 's1', 's2', 'chat').ok);
  runMin(g, 10);
  assert.equal(g.sims[0].queue.length, 0);
  assert.equal(relTo(g.sims[0], 's2').friend, 0);
});

/* ---------------- careers ---------------- */

test('a worked shift pays out, and skills plus mood earn the promotion', () => {
  const g = mk();
  g.sims[0].skills.charisma = 2;   // level 2 requirement
  assert.ok(canGoToWork(g, g.sims[0]));
  queueGoToWork(g, 's1');
  runMin(g, 30);
  assert.equal(g.sims[0].atWork, true);
  const events = runMin(g, 7.5 * 60, { feed: true });   // 08:30 → past the 15:00 shift end
  assert.equal(g.sims[0].atWork, false);
  assert.ok(events.some((e) => e.t === 'promotion' && e.name === 'Ann'));
  assert.equal(g.sims[0].job.level, 2);
  assert.ok(g.funds >= START_FUNDS + CAREERS.business.levels[0].pay);
});

test('a skipped shift is a missed day; two in a row is a demotion', () => {
  const g = mk();
  g.sims[0].job.level = 3;
  const events = runMin(g, 3 * 1440, { feed: true });   // three lazy days
  assert.ok(events.some((e) => e.t === 'demotion' && e.name === 'Ann'));
  assert.ok(g.sims[0].job.level < 3);
});

/* ---------------- build mode and money ---------------- */

test('buying, blocking, selling and painting all move the ledger correctly', () => {
  const g = mk();
  const res = placeObject(g, 'fridge', 3, 3, 0);
  assert.ok(res.ok);
  assert.equal(g.funds, START_FUNDS - OBJECTS.fridge.price);
  assert.equal(placeObject(g, 'stove', 3, 3, 0).ok, false);   // overlap
  assert.equal(placeObject(g, 'bed', 23, 23, 0).ok, false);   // footprint off the lot
  assert.equal(canPlace(g, 'stove', 3, 3, 0), false);

  const sold = sellObject(g, res.id);
  assert.ok(sold.ok);
  assert.equal(sold.refund, Math.round(OBJECTS.fridge.price * RESALE));
  assert.equal(g.funds, START_FUNDS - OBJECTS.fridge.price + sold.refund);

  const f0 = g.funds;
  assert.ok(setEdge(g, 'N', 4, 4, 1).ok);
  assert.equal(g.funds, f0 - WALL_COST);
  assert.equal(setEdge(g, 'N', 4, 4, 2).ok, true);            // door upgrade
  assert.equal(g.funds, f0 - WALL_COST - DOOR_COST);
  assert.equal(setEdge(g, 'W', 9, 9, 2).ok, false);           // no wall to fit it in
  assert.ok(paintFloor(g, 5, 5, 1).ok);
  assert.equal(g.lot.floor[5][5], 1);
});

test('a wall cannot slice through a placed object', () => {
  const g = mk();
  placeObject(g, 'bed', 8, 8, 0);   // 1×2: tiles (8,8) and (8,9)
  assert.equal(setEdge(g, 'N', 8, 9, 1).ok, false);
  assert.equal(setEdge(g, 'N', 8, 8, 1).ok, true);   // along its top edge is fine
});

test('bills arrive on day three and go unpaid at your peril', () => {
  const g = mk();
  placeObject(g, 'fridge', 3, 3, 0);
  const events = runMin(g, 2 * 1440 + 120, { feed: true });   // into day 3, past 09:00
  const bill = events.find((e) => e.t === 'bill');
  assert.ok(bill);
  assert.equal(bill.due, 60 + Math.round(OBJECTS.fridge.price * 0.01));
  assert.ok(g.bills.due > 0);

  const events2 = runMin(g, 2 * 1440, { feed: true });        // ignore it for two more days
  assert.ok(events2.some((e) => e.t === 'repossess'));
  assert.equal(g.bills.due, 0);
  assert.ok(!g.lot.objects.some((o) => o.def === 'fridge'));
});

test('paying bills needs the money and clears the debt', () => {
  const g = mk();
  g.bills.due = 500;
  g.funds = 100;
  assert.equal(payBills(g).ok, false);
  g.funds = 600;
  assert.ok(payBills(g).ok);
  assert.equal(g.funds, 100);
  assert.equal(g.bills.due, 0);
});

/* ---------------- rooms ---------------- */

test('flood fill separates indoors from outdoors, and decor lifts the room', () => {
  const g = mk();
  for (let x = 2; x <= 4; x++) { setEdge(g, 'N', x, 2, 1); setEdge(g, 'N', x, 5, 1); }
  for (let y = 2; y <= 4; y++) { setEdge(g, 'W', 2, y, 1); setEdge(g, 'W', 5, y, 1); }
  setEdge(g, 'N', 3, 5, 2);   // a door doesn't leak the room
  assert.ok(g.derived.roomId[3][3] > 0);
  assert.equal(g.derived.roomId[0][0], 0);
  assert.equal(roomScoreAt(g, 3, 3), 50);
  assert.equal(roomScoreAt(g, 0, 0), 75);   // the outdoors is fixed

  placeObject(g, 'painting', 3, 3, 0);
  assert.equal(roomScoreAt(g, 3.4, 3.9), 50 + 6 * OBJECTS.painting.decor);
  setEdge(g, 'N', 4, 2, 3);   // wall → window
  assert.equal(roomScoreAt(g, 3.4, 3.9), 50 + 6 * OBJECTS.painting.decor + 3);
});

/* ---------------- persistence ---------------- */

test('serialize → JSON → deserialize round-trips the whole state', () => {
  const g = mk(7);
  runMin(g, 30);
  const a = serialize(g);
  const b = serialize(deserialize(JSON.parse(JSON.stringify(a))));
  assert.deepEqual(b, a);
});

test('deserialize treats storage as untrusted input', () => {
  assert.equal(deserialize(null), null);
  assert.equal(deserialize('nonsense'), null);
  assert.equal(deserialize({ sims: [] }), null);

  const g = deserialize({
    lot: { objects: [{ id: 1, def: 'notreal', x: 3, y: 3 }, { id: 2, def: 'fridge', x: 99, y: -5, rot: 9 }] },
    sims: [
      { name: 'Mangled', needs: { hunger: 'NaNny' }, job: { career: 'astronaut', level: 99 }, traits: ['fake', 'neat'] },
      null,
    ],
    funds: '123',
    time: { day: 0, minute: 99999 },
  });
  assert.ok(g);
  assert.equal(g.sims.length, 1);
  assert.equal(g.sims[0].needs.hunger, 70);          // repaired, not crashed
  assert.equal(g.sims[0].job.career, 'business');    // unknown career falls back
  assert.deepEqual(g.sims[0].traits, ['neat']);      // fake trait dropped
  assert.equal(g.lot.objects.length, 1);             // unknown def dropped, bad coords clamped
  assert.equal(g.funds, 123);
  assert.ok(g.time.day >= 1 && g.time.minute < 1440);
  runMin(g, 10);                                     // and the repaired state actually steps
});

test('same seed and same commands give the same world, twice', () => {
  const script = (g) => {
    queueGo(g, 's1', 5, 5);
    queueGo(g, 's2', 18, 18);
  };
  const run = () => {
    const g = mk(1234);
    script(g);
    for (let i = 0; i < 5000; i++) step(g);
    return serialize(g);
  };
  assert.deepEqual(run(), run());
});

test('refound keeps the house and the urns but resets the family and funds', () => {
  const g = mk();
  placeObject(g, 'sofa', 10, 10, 0);
  g.sims[0].needs.hunger = 0;
  g.sims[1].needs.hunger = 0;
  runMin(g, STARVE_GRACE_MIN + REAPER_MIN + 60);
  assert.equal(g.phase, 'gameover');
  assert.equal(g.lot.objects.filter((o) => o.def === 'urn').length, 2);

  refound(g, [{ name: 'Newt', career: 'athlete' }]);
  assert.equal(g.phase, 'live');
  assert.equal(g.sims.length, 1);
  assert.equal(g.funds, START_FUNDS);
  assert.ok(g.lot.objects.some((o) => o.def === 'sofa'), 'the furniture survives');
  assert.equal(g.lot.objects.filter((o) => o.def === 'urn').length, 2, 'so do the dead');
  assert.equal(g.deadLog.length, 2);
  runMin(g, 10);
});

/* ---------------- rng ---------------- */

test('the explicit-state rng advances in place and survives a save', () => {
  const g = mk(99);
  const before = g.rng.s;
  const v1 = rand(g);
  assert.notEqual(g.rng.s, before);
  const copy = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  assert.equal(rand(g), rand(copy));
  assert.ok(v1 >= 0 && v1 < 1);
});
