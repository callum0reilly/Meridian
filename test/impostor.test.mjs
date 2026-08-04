// Tests for the Impostor map and rules.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORLD_W, WORLD_H, ROOMS, STATIONS, STATION_BY_ID, BUTTON, PLAYER_R,
  walkable, fits, hasLOS, spawnPoint, roomAt, within,
} from '../js/games/impostor/map.js';

import {
  TICK_HZ, MIN_PLAYERS, MAX_PLAYERS, COLORS,
  SPEED, GHOST_SPEED, KILL_RANGE, USE_RANGE, REPORT_RANGE,
  KILL_COOLDOWN, OPENING_COOLDOWN, TASKS_PER_PLAYER, VOTE_SECS,
  impostorCount, createState, setInput, step, stepBody, canSee,
  applyKill, applyTask, applyReport, applyButton, applyVote, applyLeave,
  killTarget, bodyAt, taskAt, buttonBlocked, checkWin, restart,
  livingCrew, livingImpostors,
} from '../js/games/impostor/rules.js';

/* ---------------- helpers ---------------- */

/** Deterministic rng, so a failing case is a failing case tomorrow too. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'p' + i, name: 'P' + i, color: COLORS[i], connected: true,
}));

/**
 * A round with the roles pinned, so a test can say "p0 is the impostor"
 * instead of hunting for whoever the shuffle picked.
 */
function game(n = 4, impostorIdx = [0]) {
  const s = createState(seats(n), { rng: rng(7), impostors: impostorIdx.length });
  s.seats.forEach((seat, i) => { s.players[seat.id].impostor = impostorIdx.includes(i); });
  s.taskGoal = (n - impostorIdx.length) * TASKS_PER_PLAYER;
  return s;
}

const put = (s, id, x, y) => { const p = s.players[id]; p.x = x; p.y = y; return p; };
const run = (s, ticks) => { let sync = false; for (let i = 0; i < ticks; i++) if (step(s).sync) sync = true; return sync; };

/**
 * Step until the meeting closes, and stop on the tick it does.
 *
 * Anything a meeting sets on its way out — kill cooldowns, the button
 * cooldown — starts draining the very next tick, so a test that runs a fixed
 * generous number of seconds and then reads those clocks is reading them at
 * some arbitrary point on the way down.
 */
function runToPlaying(s, maxTicks = 60 * TICK_HZ) {
  for (let i = 0; i < maxTicks; i++) {
    step(s);
    if (s.phase !== 'meeting') return i + 1;
  }
  throw new Error('the meeting never closed');
}

/** A point comfortably inside a named room. */
function inRoom(id, dx = 0, dy = 0) {
  const r = ROOMS.find((x) => x.id === id);
  return { x: r.x + r.w / 2 + dx, y: r.y + r.h / 2 + dy };
}

/* ================================================================== */
/*                              the map                               */
/* ================================================================== */

test('every station stands on open floor inside the room it claims', () => {
  for (const st of STATIONS) {
    assert.ok(walkable(st.x, st.y), `${st.id} is inside a wall`);
    assert.equal(roomAt(st.x, st.y)?.id, st.room, `${st.id} is not in ${st.room}`);
  }
});

test('station ids are unique — they are the wire format for a completed task', () => {
  assert.equal(STATION_BY_ID.size, STATIONS.length);
});

test('every station is reachable from the button, so no task is a dead letter', () => {
  // Flood the ship on a 10-unit grid. A station nobody can walk to is a task
  // list that can never be finished, which is a crew that can never win.
  const STEP = 10;
  const cols = Math.ceil(WORLD_W / STEP), rows = Math.ceil(WORLD_H / STEP);
  const key = (i, j) => j * cols + i;
  const cell = (v) => Math.floor(v / STEP);
  const centre = (i) => i * STEP + STEP / 2;

  const seen = new Set();
  const start = key(cell(BUTTON.x), cell(BUTTON.y));
  const queue = [start];
  seen.add(start);

  while (queue.length) {
    const k = queue.pop();
    const i = k % cols, j = Math.floor(k / cols);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const nk = key(ni, nj);
      if (seen.has(nk) || !walkable(centre(ni), centre(nj))) continue;
      seen.add(nk);
      queue.push(nk);
    }
  }

  for (const st of STATIONS) {
    assert.ok(seen.has(key(cell(st.x), cell(st.y))), `${st.id} is cut off from the button`);
  }
  for (const r of ROOMS) {
    assert.ok(seen.has(key(cell(r.x + r.w / 2), cell(r.y + r.h / 2))), `${r.id} is cut off`);
  }
});

test('a full table spawns without anyone standing in a wall', () => {
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    for (let i = 0; i < n; i++) {
      const p = spawnPoint(i, n);
      assert.ok(fits(p.x, p.y), `seat ${i} of ${n} spawns clipped into geometry`);
    }
  }
});

test('sight is blocked by walls and clear across a room', () => {
  const cafe = inRoom('cafeteria');
  assert.ok(hasLOS(cafe.x - 150, cafe.y - 100, cafe.x + 150, cafe.y + 100));
  // Cafeteria to MedBay is two rooms and a dogleg — the line crosses hull.
  assert.equal(hasLOS(700, 100, 480, 170), false);
});

test('fits() is stricter than walkable() at a wall', () => {
  const r = ROOMS.find((x) => x.id === 'medbay');
  // A point one unit inside the corner is on the floor, but a whole body
  // centred there is half in the wall.
  assert.ok(walkable(r.x + 1, r.y + 1));
  assert.equal(fits(r.x + 1, r.y + 1), false);
  assert.ok(fits(r.x + PLAYER_R + 1, r.y + PLAYER_R + 1));
});

/* ================================================================== */
/*                              setup                                 */
/* ================================================================== */

test('a fresh round deals roles, tasks and a spawn ring', () => {
  const s = createState(seats(6), { rng: rng(3) });
  assert.equal(s.phase, 'playing');
  assert.equal(s.seats.length, 6);
  assert.equal(livingImpostors(s).length, 1);
  assert.equal(livingCrew(s).length, 5);
  for (const p of Object.values(s.players)) {
    assert.equal(p.tasks.length, TASKS_PER_PLAYER);
    assert.equal(new Set(p.tasks.map((t) => t.id)).size, TASKS_PER_PLAYER, 'a task was dealt twice');
    assert.equal(p.killCd, OPENING_COOLDOWN);
    assert.ok(fits(p.x, p.y));
  }
});

test('impostor count steps up at seven players', () => {
  assert.equal(impostorCount(3), 1);
  assert.equal(impostorCount(6), 1);
  assert.equal(impostorCount(7), 2);
  assert.equal(impostorCount(10), 2);
});

test('the goal counts crew task lists only — an impostor list is scenery', () => {
  const s = createState(seats(8), { rng: rng(5) });
  const crew = 8 - impostorCount(8);
  assert.equal(s.taskGoal, crew * TASKS_PER_PLAYER);
});

/* ================================================================== */
/*                            movement                                */
/* ================================================================== */

test('input is clamped to a unit vector however it arrives', () => {
  const s = game();
  setInput(s, 'p0', 50, 0);
  assert.equal(s.players.p0.ix, 1);
  setInput(s, 'p0', 3, 4);          // length 5
  assert.ok(Math.abs(Math.hypot(s.players.p0.ix, s.players.p0.iy) - 1) < 1e-9);
  setInput(s, 'p0', 0.5, 0);        // a half-press stays a half-press
  assert.equal(s.players.p0.ix, 0.5);
  setInput(s, 'p0', NaN, 0);
  assert.equal(s.players.p0.ix, 0);
});

test('walking covers SPEED units a tick on open floor', () => {
  const s = game();
  const at = inRoom('cafeteria');
  const p = put(s, 'p1', at.x, at.y);
  setInput(s, 'p1', 1, 0);
  step(s);
  assert.ok(Math.abs(p.x - (at.x + SPEED)) < 1e-9);
  assert.equal(p.y, at.y);
});

// Hard against Cafeteria's left wall. The offset matters: the MedBay hall
// opens onto this wall at y 170–230, and a fixture placed in the doorway
// slides straight through it and looks like a collision failure.
const WALL_Y = 240;

test('a body pressed into a wall slides along it instead of sticking', () => {
  const s = game();
  const r = ROOMS.find((x) => x.id === 'cafeteria');
  const p = put(s, 'p1', r.x + PLAYER_R, r.y + WALL_Y);
  setInput(s, 'p1', -1, 1);            // down and into the wall
  const before = p.x;
  step(s);
  assert.equal(p.x, before, 'should not have moved into the wall');
  assert.ok(p.y > r.y + WALL_Y, 'should still have slid downward');
});

test('the dead walk through walls, and faster', () => {
  const s = game();
  const r = ROOMS.find((x) => x.id === 'cafeteria');
  const p = put(s, 'p1', r.x + PLAYER_R, r.y + WALL_Y);
  p.alive = false;
  setInput(s, 'p1', -1, 0);
  step(s);
  assert.ok(Math.abs(p.x - (r.x + PLAYER_R - GHOST_SPEED)) < 1e-9);
  assert.ok(!walkable(p.x - PLAYER_R, p.y), 'the ghost should be inside the hull');
});

test('a ghost cannot leave the world', () => {
  const s = game();
  const p = put(s, 'p1', 5, 5);
  p.alive = false;
  setInput(s, 'p1', -1, -1);
  run(s, 20);
  assert.ok(p.x >= 0 && p.y >= 0);
  assert.ok(p.x <= WORLD_W && p.y <= WORLD_H);
});

test('stepBody moves a client copy exactly as the host moves the original', () => {
  // This is the contract client-side prediction rests on. If these ever
  // disagree, every player rubber-bands and nobody can say why.
  const s = game();
  const at = inRoom('storage');
  const p = put(s, 'p1', at.x, at.y);
  setInput(s, 'p1', 0.6, -0.8);
  const copy = { x: p.x, y: p.y, ix: p.ix, iy: p.iy, alive: true };
  for (let i = 0; i < 40; i++) { step(s); stepBody(copy); }
  assert.ok(Math.abs(copy.x - p.x) < 1e-9 && Math.abs(copy.y - p.y) < 1e-9);
});

/* ================================================================== */
/*                            killing                                 */
/* ================================================================== */

/** p0 impostor, p1 crew, both stood together in Storage with kills off cooldown. */
function killable(n = 4) {
  const s = game(n, [0]);
  const at = inRoom('storage');
  put(s, 'p0', at.x, at.y);
  put(s, 'p1', at.x + 30, at.y);
  s.players.p0.killCd = 0;
  return s;
}

test('a crewmate is never a killer', () => {
  const s = killable();
  s.players.p1.killCd = 0;
  assert.equal(killTarget(s, 'p1'), null);
  assert.equal(applyKill(s, 'p1', 'p0'), null);
  assert.ok(s.players.p0.alive);
});

test('the opening cooldown holds the first kill off', () => {
  const s = killable();
  s.players.p0.killCd = OPENING_COOLDOWN;
  assert.equal(killTarget(s, 'p0'), null);
  run(s, OPENING_COOLDOWN - 1);
  assert.equal(killTarget(s, 'p0'), null);
  step(s);
  assert.equal(killTarget(s, 'p0')?.id, 'p1');
});

test('a kill drops a body, moves the killer onto it and starts the clock', () => {
  const s = killable();
  const res = applyKill(s, 'p0', 'p1');
  assert.equal(res.victim, 'p1');
  assert.equal(s.players.p1.alive, false);
  assert.equal(s.bodies.length, 1);
  assert.equal(s.bodies[0].id, 'p1');
  assert.equal(s.players.p0.x, s.bodies[0].x);
  assert.equal(s.players.p0.y, s.bodies[0].y);
  assert.equal(s.players.p0.killCd, KILL_COOLDOWN);
  assert.equal(killTarget(s, 'p0'), null, 'cannot kill twice in a row');
});

test('range and walls both matter', () => {
  const s = killable();
  put(s, 'p1', s.players.p0.x + KILL_RANGE + 5, s.players.p0.y);
  assert.equal(killTarget(s, 'p0'), null, 'out of reach');

  put(s, 'p1', s.players.p0.x + KILL_RANGE - 5, s.players.p0.y);
  assert.equal(killTarget(s, 'p0')?.id, 'p1');

  // Same distance, but through the hull.
  //
  // No two spots a player can legally *stand* on this map are within
  // KILL_RANGE of each other with a wall between — the rooms are too far
  // apart and the halls too wide for a 32-unit body to be cut off that
  // close up. So the victim goes on floor a whole body could not occupy,
  // in the mouth of the Upper Engine ─ Reactor hall. That is the point of
  // the check: positions reach this function off the wire, and it does not
  // get to assume they are ones the simulation would have produced.
  put(s, 'p0', 100, 280);              // Upper Engine, bottom-left corner
  put(s, 'p1', 150, 310);              // round the corner, 58 units away
  assert.equal(killTarget(s, 'p0'), null, 'should not reach through a wall');
});

test('impostors do not kill each other', () => {
  const s = game(8, [0, 1]);
  const at = inRoom('storage');
  put(s, 'p0', at.x, at.y);
  put(s, 'p1', at.x + 30, at.y);
  put(s, 'p2', at.x - 400, at.y);      // out of the way
  s.players.p0.killCd = 0;
  assert.equal(killTarget(s, 'p0'), null);
});

test('the nearest crewmate is the one who dies', () => {
  const s = killable(5);
  const at = inRoom('storage');
  put(s, 'p1', at.x + 60, at.y);
  put(s, 'p2', at.x + 20, at.y);
  assert.equal(killTarget(s, 'p0')?.id, 'p2');
});

test('a kill that levels the numbers ends it there and then', () => {
  const s = killable(3);              // p0 impostor, p1 and p2 crew
  put(s, 'p2', 200, 860);             // far away, still alive
  const res = applyKill(s, 'p0', 'p1');
  assert.ok(res.ended);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'impostors');
  assert.equal(s.reason, 'outnumbered');
});

test('a finished game stops stepping', () => {
  const s = killable(3);
  applyKill(s, 'p0', 'p1');
  const tick = s.tick;
  run(s, 10);
  assert.equal(s.tick, tick);
});

/* ================================================================== */
/*                              tasks                                 */
/* ================================================================== */

/** Stand `id` at the first station on their list. */
function atOwnStation(s, id) {
  const t = s.players[id].tasks[0];
  const st = STATION_BY_ID.get(t.id);
  put(s, id, st.x, st.y);
  return st;
}

test('a task only completes if you are standing at it and it is on your list', () => {
  const s = game();
  const st = atOwnStation(s, 'p1');
  assert.equal(taskAt(s, 'p1')?.id, st.id);

  put(s, 'p1', st.x + USE_RANGE + 20, st.y);
  assert.equal(applyTask(s, 'p1', st.id), null, 'too far away');

  put(s, 'p1', st.x, st.y);
  const other = STATIONS.find((x) => !s.players.p1.tasks.some((t) => t.id === x.id));
  assert.equal(applyTask(s, 'p1', other.id), null, 'not on this list');

  assert.equal(applyTask(s, 'p1', st.id).counted, true);
  assert.equal(s.taskDone, 1);
  assert.equal(applyTask(s, 'p1', st.id), null, 'already done');
});

test('an impostor ticks their own list off and the bar never moves', () => {
  const s = game();
  const st = atOwnStation(s, 'p0');
  const res = applyTask(s, 'p0', st.id);
  assert.equal(res.counted, false);
  assert.equal(s.taskDone, 0);
  assert.equal(s.players.p0.tasks[0].done, true, 'the list still has to look busy');
});

test('finishing the bar wins it for the crew, even from beyond the grave', () => {
  const s = game(4, [0]);
  s.players.p1.alive = false;         // a ghost still owes their list
  for (const id of ['p1', 'p2', 'p3']) {
    for (const t of s.players[id].tasks) {
      const st = STATION_BY_ID.get(t.id);
      put(s, id, st.x, st.y);
      applyTask(s, id, t.id);
    }
  }
  assert.equal(s.taskDone, s.taskGoal);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'crew');
  assert.equal(s.reason, 'tasks');
});

/* ================================================================== */
/*                        bodies and meetings                         */
/* ================================================================== */

test('a body is reportable at range, through nothing', () => {
  const s = killable();
  applyKill(s, 'p0', 'p1');
  const b = s.bodies[0];

  put(s, 'p2', b.x + REPORT_RANGE + 10, b.y);
  assert.equal(bodyAt(s, 'p2'), null);
  assert.equal(applyReport(s, 'p2', 'p1'), null);

  put(s, 'p2', b.x + REPORT_RANGE - 10, b.y);
  assert.equal(bodyAt(s, 'p2')?.id, 'p1');
  assert.equal(applyReport(s, 'p2', 'p1').body, 'p1');
  assert.equal(s.phase, 'meeting');
});

test('the dead cannot report', () => {
  const s = killable(5);
  applyKill(s, 'p0', 'p1');
  const b = s.bodies[0];
  put(s, 'p2', b.x, b.y);
  s.players.p2.alive = false;
  assert.equal(bodyAt(s, 'p2'), null);
});

test('calling a meeting clears the bodies and gathers everyone at the table', () => {
  const s = killable(5);
  applyKill(s, 'p0', 'p1');
  put(s, 'p2', s.bodies[0].x, s.bodies[0].y);
  applyReport(s, 'p2', 'p1');

  assert.equal(s.bodies.length, 0);
  assert.equal(s.meeting.reason, 'body');
  assert.equal(s.meeting.byId, 'p2');
  assert.equal(s.meeting.aboutId, 'p1');
  assert.equal(s.meeting.stage, 'vote');
  for (const p of Object.values(s.players)) {
    assert.ok(within(p.x, p.y, BUTTON.x, BUTTON.y, 200), 'not at the table');
    assert.equal(p.ix, 0);
    assert.equal(p.iy, 0);
  }
});

test('nobody moves during a meeting', () => {
  const s = game();
  // The button has to actually be pressable, or this quietly becomes a test
  // that a player walks around normally: everyone spawns on a 90-unit ring
  // and USE_RANGE is 78, so nobody starts a round in reach of it.
  put(s, 'p1', BUTTON.x, BUTTON.y);
  s.buttonCd = 0;
  assert.ok(applyButton(s, 'p1'), 'the meeting should have opened');

  const p = s.players.p1;
  const { x, y } = p;                  // read after the table gathers everyone
  setInput(s, 'p1', 1, 1);
  run(s, 10);
  assert.equal(p.x, x);
  assert.equal(p.y, y);
});

test('the button needs you at it, once each, and not straight after a meeting', () => {
  const s = game();
  const p = put(s, 'p1', BUTTON.x + 400, BUTTON.y);
  assert.match(buttonBlocked(s, 'p1'), /not at the button/);
  assert.equal(applyButton(s, 'p1'), null);

  put(s, 'p1', BUTTON.x, BUTTON.y);
  s.buttonCd = 0;
  assert.equal(buttonBlocked(s, 'p1'), null);
  assert.equal(applyButton(s, 'p1').by, 'p1');
  assert.equal(p.emergencies, 0);

  // Ride the meeting out, then it is both used up and cooling down. Stop on
  // the tick it closes — the cooldown it sets is 15s and draining.
  runToPlaying(s);
  assert.equal(s.phase, 'playing');
  put(s, 'p1', BUTTON.x, BUTTON.y);
  assert.match(buttonBlocked(s, 'p1'), /used your emergency meeting/);
  put(s, 'p2', BUTTON.x, BUTTON.y);
  assert.match(buttonBlocked(s, 'p2'), /cooling down/);
});

/* ================================================================== */
/*                             the vote                               */
/* ================================================================== */

/** A meeting in progress, called by p1, with everyone alive. */
function meeting(n = 5, impostorIdx = [0]) {
  const s = game(n, impostorIdx);
  put(s, 'p1', BUTTON.x, BUTTON.y);
  s.buttonCd = 0;
  applyButton(s, 'p1');
  return s;
}

test('a plurality ejects, and the crew is told what it threw out', () => {
  const s = meeting(5);                       // p0 impostor
  assert.ok(applyVote(s, 'p1', 'p0'));
  assert.ok(applyVote(s, 'p2', 'p0'));
  assert.ok(applyVote(s, 'p3', 'p0'));
  assert.ok(applyVote(s, 'p4', 'p3'));        // a rival candidate, outvoted
  assert.ok(applyVote(s, 'p0', null));

  step(s);                                    // everyone in — tally at once
  const r = s.meeting.result;
  assert.equal(s.meeting.stage, 'result');
  assert.equal(r.ejectedId, 'p0');
  assert.equal(r.wasImpostor, true);
  assert.equal(r.counts.p0, 3);
  assert.equal(r.counts.p3, 1);
  assert.equal(r.skips, 1);
  assert.equal(s.players.p0.alive, false);
});

test('a leader only tying the skips is not a plurality, and ejects nobody', () => {
  const s = meeting(5);
  applyVote(s, 'p1', 'p0');
  applyVote(s, 'p2', 'p0');
  applyVote(s, 'p3', null);
  applyVote(s, 'p4', null);
  applyVote(s, 'p0', 'p4');
  step(s);

  const r = s.meeting.result;
  assert.equal(r.counts.p0, 2);
  assert.equal(r.skips, 2);
  assert.equal(r.ejectedId, null, 'the ship needs more votes than skips to open the airlock');
  assert.equal(r.skipped, true);
  assert.ok(s.players.p0.alive);
});

test('ejecting the last impostor wins it, but only once the airlock has closed', () => {
  const s = meeting(5);
  for (const id of ['p0', 'p1', 'p2', 'p3', 'p4']) applyVote(s, id, 'p0');
  step(s);
  assert.equal(s.phase, 'meeting', 'the result is still on screen');
  run(s, 8 * TICK_HZ);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'crew');
  assert.equal(s.reason, 'ejected');
});

test('a tie ejects nobody', () => {
  const s = meeting(4);
  applyVote(s, 'p0', 'p2');
  applyVote(s, 'p1', 'p2');
  applyVote(s, 'p2', 'p1');
  applyVote(s, 'p3', 'p1');
  step(s);
  assert.equal(s.meeting.result.ejectedId, null);
  assert.equal(s.meeting.result.tied, true);
  for (const p of Object.values(s.players)) assert.ok(p.alive);
});

test('skips beating the leader ejects nobody, and says so differently', () => {
  // A real tie needs the tied pair to be ahead of the skips — two candidates
  // on one vote each behind three skips is a skip, and gets reported as one.
  const s = meeting(5);
  applyVote(s, 'p0', 'p1');
  applyVote(s, 'p1', 'p0');
  applyVote(s, 'p2', 'p0');
  applyVote(s, 'p3', 'p1');
  applyVote(s, 'p4', null);
  step(s);
  const r = s.meeting.result;
  assert.equal(r.ejectedId, null);
  assert.equal(r.skipped, false, 'a tie is reported as a tie, not as a skip');
  assert.equal(r.tied, true);

  const s2 = meeting(5);
  applyVote(s2, 'p0', null);
  applyVote(s2, 'p1', null);
  applyVote(s2, 'p2', null);
  applyVote(s2, 'p3', 'p0');
  applyVote(s2, 'p4', null);
  step(s2);
  assert.equal(s2.meeting.result.ejectedId, null);
  assert.equal(s2.meeting.result.skipped, true);
});

test('the timer ends a vote nobody cast', () => {
  const s = meeting(4);
  run(s, VOTE_SECS * TICK_HZ + 1);
  assert.equal(s.meeting.stage, 'result');
  assert.equal(s.meeting.result.noVotes, true);
  assert.equal(s.meeting.result.ejectedId, null);
});

test('votes are final, the dead have none, and the dead are not on the ballot', () => {
  const s = meeting(5);
  s.players.p4.alive = false;

  assert.ok(applyVote(s, 'p1', 'p0'));
  assert.equal(applyVote(s, 'p1', 'p2'), false, 'cannot change a vote');
  assert.equal(s.meeting.votes.p1, 'p0');

  assert.equal(applyVote(s, 'p4', 'p0'), false, 'the dead do not vote');
  assert.equal(applyVote(s, 'p2', 'p4'), false, 'the dead are not on the ballot');
});

test('a meeting ends with everyone back on a kill cooldown', () => {
  const s = meeting(5);
  s.players.p0.killCd = 0;              // came into the meeting ready to kill
  for (const id of ['p0', 'p1', 'p2', 'p3', 'p4']) applyVote(s, id, null);
  runToPlaying(s);
  assert.equal(s.phase, 'playing');
  assert.equal(s.meeting, null);
  assert.equal(s.players.p0.killCd, OPENING_COOLDOWN);
  assert.ok(s.buttonCd > 0);
});

/* ================================================================== */
/*                        vision and redaction                        */
/* ================================================================== */

test('you see who is in your light, and nobody through a wall', () => {
  const s = game(4);
  const at = inRoom('storage');
  put(s, 'p0', at.x, at.y);
  put(s, 'p1', at.x + 40, at.y);
  put(s, 'p2', at.x + 40, at.y);
  put(s, 'p3', 200, 860);                      // Lower Engine, across the ship

  assert.ok(canSee(s, 'p1', 'p2'));
  assert.equal(canSee(s, 'p1', 'p3'), false, 'too far and through the hull');
  assert.ok(canSee(s, 'p1', 'p1'), 'you always see yourself');
});

test('the impostor sees further than the crew', () => {
  const s = game(4, [0]);
  const r = ROOMS.find((x) => x.id === 'storage');
  // A gap wider than crew vision but inside the impostor's, in a straight line.
  put(s, 'p0', r.x + 20, r.y + 120);
  put(s, 'p1', r.x + 280, r.y + 120);
  assert.ok(canSee(s, 'p0', 'p1'), 'impostor should see the length of Storage');
  assert.equal(canSee(s, 'p1', 'p0'), false, 'crew should not');
});

test('the living cannot see ghosts; the dead see everything', () => {
  const s = game(4);
  const at = inRoom('storage');
  put(s, 'p0', at.x, at.y);
  put(s, 'p1', at.x + 30, at.y);
  put(s, 'p2', 200, 860);
  s.players.p1.alive = false;

  assert.equal(canSee(s, 'p0', 'p1'), false, 'ghosts are invisible to the living');
  assert.ok(canSee(s, 'p1', 'p0'));
  assert.ok(canSee(s, 'p1', 'p2'), 'and across the ship');
});

/* ================================================================== */
/*                           disconnects                              */
/* ================================================================== */

test('a crewmate leaving takes their unfinished work off the goal', () => {
  const s = game(5, [0]);
  const st = atOwnStation(s, 'p1');
  applyTask(s, 'p1', st.id);
  const goal = s.taskGoal;

  applyLeave(s, 'p1');
  assert.equal(s.players.p1.left, true);
  assert.equal(s.players.p1.alive, false);
  assert.equal(s.taskGoal, goal - (TASKS_PER_PLAYER - 1));
  assert.ok(s.taskGoal >= s.taskDone, 'the goal must never fall below what is done');
  assert.equal(s.phase, 'playing');
});

test('a leaver is out of the count, the vote and the body list', () => {
  const s = killable(5);
  applyKill(s, 'p0', 'p1');
  assert.equal(s.bodies.length, 1);
  applyLeave(s, 'p1');
  assert.equal(s.bodies.length, 0, 'a leaver takes their body with them');
  assert.equal(livingCrew(s).length, 3);
});

test('the impostor leaving hands it to the crew', () => {
  const s = game(4, [0]);
  applyLeave(s, 'p0');
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'crew');
  assert.equal(s.reason, 'ejected');
});

/* ================================================================== */
/*                            restarting                              */
/* ================================================================== */

test('a rematch is a clean round with the same seats', () => {
  const s = killable(4);
  applyKill(s, 'p0', 'p1');
  applyTask(s, 'p2', s.players.p2.tasks[0].id);   // won't take, wrong place — fine

  const next = restart(s);
  assert.equal(next.phase, 'playing');
  assert.equal(next.tick, 0);
  assert.equal(next.taskDone, 0);
  assert.equal(next.bodies.length, 0);
  assert.equal(next.winner, null);
  assert.deepEqual(next.seats.map((x) => x.id), s.seats.map((x) => x.id));
  for (const p of Object.values(next.players)) {
    assert.ok(p.alive);
    assert.equal(p.emergencies, 1);
  }
});

test('checkWin is idempotent once the round is decided', () => {
  const s = game(4, [0]);
  applyLeave(s, 'p0');
  assert.equal(s.winner, 'crew');
  assert.ok(checkWin(s));
  assert.equal(s.winner, 'crew', 'a second look must not rewrite the result');
});
