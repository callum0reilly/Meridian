// Impostor. Pure logic — no DOM, no canvas, no timers, no network.
//
// Same contract as the other rules modules: one state object, mutated through
// exported functions, each reporting what happened so the caller can narrate
// it. The host owns one of these; nobody else ever sees it whole (see the
// redaction note in index.js).
//
// ---- Ticks, not seconds ----
//
// Everything here is counted in ticks of 1/20s, for the reason flappy/rules.js
// spells out at length: a simulation paced by frames is a simulation whose
// rules change with the monitor. 20Hz rather than 60 because this is a network
// game — every tick is a packet to every player, and a walking speed of 10
// units a tick interpolates smoothly enough that nobody can tell it apart from
// 60. See index.js for the interpolation.
//
// ---- What is deliberately not here ----
//
// Vents, sabotage, cameras, doors, the admin table. Those are the second
// layer of Among Us; this is the first one — walk, work, kill, report, argue,
// vote — and it is a whole game on its own.

import {
  PLAYER_R, STATIONS, STATION_BY_ID, BUTTON,
  spawnPoint, fits, within, hasLOS, WORLD_W, WORLD_H,
} from './map.js';

export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
const secs = (s) => Math.round(s * TICK_HZ);

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;

/** Seat colours, in assignment order. Ten players, ten distinguishable hues. */
export const COLORS = [
  'red', 'blue', 'green', 'pink', 'orange',
  'yellow', 'black', 'white', 'purple', 'cyan',
];

export const COLOR_HEX = {
  red: '#e5484d', blue: '#3d7dff', green: '#30a46c', pink: '#f07eb8', orange: '#f7861c',
  yellow: '#ffc53d', black: '#4a5265', white: '#dfe6f2', purple: '#8b5cf6', cyan: '#22c4d6',
};

/* ---- movement ---- */
export const SPEED = 210 / TICK_HZ;        // world units per tick
export const GHOST_SPEED = 250 / TICK_HZ;  // the dead have nothing to slow them

/* ---- vision, in world units ----
   The impostor sees further than the crew. It is the original's thumb on the
   scale and it is the right one: the crew's advantage is numbers, so the
   impostor's has to be information. */
export const CREW_VISION = 230;
export const IMPOSTOR_VISION = 310;

/* ---- reach ---- */
export const KILL_RANGE = 74;
export const USE_RANGE = 78;
export const REPORT_RANGE = 96;

/* ---- clocks ---- */
export const KILL_COOLDOWN = secs(25);
export const OPENING_COOLDOWN = secs(10);   // grace at the start of a round
export const VOTE_SECS = 30;
const VOTE_TICKS = secs(VOTE_SECS);
const RESULT_TICKS = secs(7);               // how long the ejection is on screen
const BUTTON_COOLDOWN = secs(15);

export const TASKS_PER_PLAYER = 5;
export const EMERGENCIES_EACH = 1;

/** One impostor up to six players, two from seven. */
export const impostorCount = (n) => (n >= 7 ? 2 : 1);

/* ============================== setup ============================== */

function shuffled(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Deal roles and tasks and put everyone round the table.
 *
 * `seats` is the lobby's seat list — id, name, colour — in join order. The
 * seat *order* is the wire format for positions (see index.js), so it is fixed
 * for the whole match and never re-sorted.
 */
export function createState(seats, { rng = Math.random, impostors = null } = {}) {
  const n = seats.length;
  const wanted = impostors ?? impostorCount(n);
  const impostorIds = new Set(shuffled(seats.map((s) => s.id), rng).slice(0, wanted));

  const players = {};
  seats.forEach((seat, i) => {
    const at = spawnPoint(i, n);
    players[seat.id] = {
      id: seat.id,
      seat: i,
      alive: true,
      impostor: impostorIds.has(seat.id),
      x: at.x,
      y: at.y,
      ix: 0,               // last input received, as a unit-ish vector
      iy: 0,
      killCd: OPENING_COOLDOWN,
      emergencies: EMERGENCIES_EACH,
      // Impostors get a list too. It is fake — completing it moves nothing —
      // but without one they have nothing to walk to and nothing to point at
      // when someone asks where they have been.
      tasks: shuffled(STATIONS, rng).slice(0, TASKS_PER_PLAYER).map((s) => ({ id: s.id, done: false })),
      left: false,
    };
  });

  const state = {
    phase: 'playing',        // playing | meeting | over
    tick: 0,
    seats: seats.map((s) => ({ id: s.id, name: s.name, color: s.color })),
    players,
    bodies: [],              // { id, x, y } — the victim's id names the body
    meeting: null,
    buttonCd: BUTTON_COOLDOWN,
    taskDone: 0,
    taskGoal: 0,
    winner: null,            // 'crew' | 'impostors'
    reason: null,
    log: [],
    rng,
  };
  state.taskGoal = countGoal(state);
  return state;
}

/** How many task completions the crew needs. Impostor lists are not counted. */
function countGoal(state) {
  let goal = 0;
  for (const p of Object.values(state.players)) {
    if (p.impostor || p.left) continue;
    goal += p.tasks.length;
  }
  return goal;
}

/* ============================== queries ============================== */

export const playerList = (state) => state.seats.map((s) => state.players[s.id]).filter(Boolean);
export const livingCrew = (state) => playerList(state).filter((p) => p.alive && !p.impostor && !p.left);
export const livingImpostors = (state) => playerList(state).filter((p) => p.alive && p.impostor && !p.left);
export const canVote = (state, id) => {
  const p = state.players[id];
  return !!p && p.alive && !p.left;
};

export const visionOf = (p) => (p.impostor ? IMPOSTOR_VISION : CREW_VISION);

/**
 * Can `id` see `other` right now?
 *
 * The dead see everything — they have no stake left and watching is the only
 * thing the game still gives them. The living see inside their own light, and
 * only through open floor: this is the test the host culls positions with, so
 * "can't see" here means "was never sent", not "drawn dark".
 */
export function canSee(state, id, other) {
  const me = state.players[id], them = state.players[other];
  if (!me || !them || me === them) return me === them;
  if (!me.alive) return true;
  if (!them.alive) return false;                 // ghosts are invisible to the living
  if (!within(me.x, me.y, them.x, them.y, visionOf(me))) return false;
  return hasLOS(me.x, me.y, them.x, them.y);
}

/** The station `id` is standing at and still owes, or null. */
export function taskAt(state, id) {
  const p = state.players[id];
  if (!p || p.left || state.phase !== 'playing') return null;
  for (const t of p.tasks) {
    if (t.done) continue;
    const st = STATION_BY_ID.get(t.id);
    if (st && within(p.x, p.y, st.x, st.y, USE_RANGE)) return st;
  }
  return null;
}

/** The player `id` could kill right now, or null. */
export function killTarget(state, id) {
  const me = state.players[id];
  if (!me || !me.impostor || !me.alive || me.left) return null;
  if (me.killCd > 0 || state.phase !== 'playing') return null;

  let best = null, bestD = Infinity;
  for (const p of playerList(state)) {
    if (p === me || !p.alive || p.impostor || p.left) continue;
    if (!within(me.x, me.y, p.x, p.y, KILL_RANGE)) continue;
    if (!hasLOS(me.x, me.y, p.x, p.y)) continue;
    const d = (me.x - p.x) ** 2 + (me.y - p.y) ** 2;
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

/** The body `id` is standing over, or null. Ghosts cannot report. */
export function bodyAt(state, id) {
  const me = state.players[id];
  if (!me || !me.alive || me.left || state.phase !== 'playing') return null;
  for (const b of state.bodies) {
    if (!within(me.x, me.y, b.x, b.y, REPORT_RANGE)) continue;
    if (hasLOS(me.x, me.y, b.x, b.y)) return b;
  }
  return null;
}

/** Can `id` press the emergency button? Returns a reason string if not. */
export function buttonBlocked(state, id) {
  const me = state.players[id];
  if (!me || !me.alive || me.left) return 'Only the living can call a meeting.';
  if (state.phase !== 'playing') return 'A meeting is already running.';
  if (!within(me.x, me.y, BUTTON.x, BUTTON.y, USE_RANGE)) return 'You are not at the button.';
  if (me.emergencies <= 0) return 'You have used your emergency meeting.';
  if (state.buttonCd > 0) return `Button cooling down — ${Math.ceil(state.buttonCd / TICK_HZ)}s.`;
  return null;
}

/* ============================== input ============================== */

/**
 * Record a movement intent. Clamped to a unit vector so a hand-written
 * `{ix: 50}` off a patched client is worth exactly as much as a keypress.
 */
export function setInput(state, id, ix, iy) {
  const p = state.players[id];
  if (!p) return;
  const len = Math.hypot(ix, iy);
  if (!Number.isFinite(len) || len < 0.05) { p.ix = 0; p.iy = 0; return; }
  const k = Math.min(1, len) / len;
  p.ix = ix * k;
  p.iy = iy * k;
}

/* ============================== stepping ============================== */

/**
 * Advance one tick.
 *
 * @returns {{sync: boolean}} sync is true when something structural changed —
 * a meeting opened or closed, someone was ejected, the game ended — and the
 * host owes everyone a full state push rather than just the next position
 * snapshot.
 */
export function step(state) {
  if (state.phase === 'over') return { sync: false };
  state.tick += 1;

  if (state.buttonCd > 0) state.buttonCd -= 1;

  if (state.phase === 'meeting') return stepMeeting(state);

  for (const p of playerList(state)) {
    if (p.left) continue;
    if (p.killCd > 0) p.killCd -= 1;
    stepBody(p);
  }
  return { sync: false };
}

/**
 * Walk one body one tick. Exported because the client runs it too: predicting
 * your own movement locally is the only way the game feels attached to your
 * hands, and predicting it with a *reimplementation* of this is how prediction
 * quietly drifts out of agreement with the host. One function, both ends.
 *
 * Blocked moves are retried one axis at a time so you slide along a wall
 * instead of sticking to it. Running a corridor at 45 degrees and stopping
 * dead on the doorframe is the single most irritating thing a top-down game
 * can do, and it is three lines to avoid.
 *
 * Ghosts skip the wall test entirely — passing through the ship is most of
 * what being dead is for — and are held inside the world bounds only.
 */
export function stepBody(p) {
  const speed = p.alive ? SPEED : GHOST_SPEED;
  const dx = p.ix * speed, dy = p.iy * speed;
  if (!dx && !dy) return;

  if (!p.alive) {
    p.x = Math.max(0, Math.min(WORLD_W, p.x + dx));
    p.y = Math.max(0, Math.min(WORLD_H, p.y + dy));
    return;
  }

  if (fits(p.x + dx, p.y + dy)) { p.x += dx; p.y += dy; return; }
  if (dx && fits(p.x + dx, p.y)) { p.x += dx; return; }
  if (dy && fits(p.x, p.y + dy)) { p.y += dy; }
}

/* ============================== killing ============================== */

/**
 * Kill. Returns the result, or null if the kill wasn't on.
 *
 * The impostor is moved onto the victim's spot. The original does this and it
 * is not cosmetic: without it a kill at the edge of range leaves a body a
 * body's length away from anyone, which reads on a witness's screen as the
 * victim having died of nothing.
 */
export function applyKill(state, id, targetId) {
  const target = killTarget(state, id);
  if (!target || (targetId && target.id !== targetId)) return null;
  const me = state.players[id];

  target.alive = false;
  state.bodies.push({ id: target.id, x: target.x, y: target.y });
  me.x = target.x;
  me.y = target.y;
  me.killCd = KILL_COOLDOWN;
  target.ix = 0;
  target.iy = 0;

  logLine(state, `${nameOf(state, target.id)} was killed.`);
  const ended = checkWin(state);
  return { victim: target.id, ended };
}

/* ============================== tasks ============================== */

/**
 * Mark a task done. Returns null if this player doesn't owe that task or
 * isn't standing at it — the client runs the minigame, so this is the only
 * thing standing between a solved puzzle and a `room.send({t:'task'})` typed
 * into a console.
 *
 * An impostor's completion is accepted and recorded — their list has to tick
 * along visibly or the pretence is worthless — but it never touches the bar.
 */
export function applyTask(state, id, stationId) {
  const p = state.players[id];
  if (!p || p.left || state.phase !== 'playing') return null;
  const t = p.tasks.find((x) => x.id === stationId && !x.done);
  if (!t) return null;
  const st = STATION_BY_ID.get(stationId);
  if (!st || !within(p.x, p.y, st.x, st.y, USE_RANGE)) return null;

  t.done = true;
  if (p.impostor) return { counted: false, ended: false };

  state.taskDone += 1;
  return { counted: true, ended: checkWin(state) };
}

/* ============================== meetings ============================== */

export function applyReport(state, id, bodyId) {
  const body = bodyAt(state, id);
  if (!body || (bodyId && body.id !== bodyId)) return null;
  openMeeting(state, { reason: 'body', byId: id, aboutId: body.id });
  return { body: body.id };
}

export function applyButton(state, id) {
  if (buttonBlocked(state, id)) return null;
  state.players[id].emergencies -= 1;
  openMeeting(state, { reason: 'button', byId: id, aboutId: null });
  return { by: id };
}

function openMeeting(state, { reason, byId, aboutId }) {
  state.phase = 'meeting';
  state.bodies = [];                  // the crew has been called away from them
  state.meeting = {
    reason,
    byId,
    aboutId,
    stage: 'vote',                    // vote | result
    endsAt: state.tick + VOTE_TICKS,
    votes: {},                        // voterId -> targetId | 'skip'
    result: null,
  };

  // Everyone back to the table, standing still. Freezing input as well as
  // position matters: a key held when the meeting opened would otherwise be
  // spent walking the instant it closes.
  const n = state.seats.length;
  state.seats.forEach((s, i) => {
    const p = state.players[s.id];
    if (!p) return;
    const at = spawnPoint(i, n);
    p.x = at.x; p.y = at.y; p.ix = 0; p.iy = 0;
  });

  logLine(state, reason === 'button'
    ? `${nameOf(state, byId)} called an emergency meeting.`
    : `${nameOf(state, byId)} reported ${nameOf(state, aboutId)}'s body.`);
}

/** Cast or change a vote. Returns false if this player has no say. */
export function applyVote(state, id, targetId) {
  const m = state.meeting;
  if (!m || m.stage !== 'vote' || !canVote(state, id)) return false;
  if (id in m.votes) return false;          // votes are final, as in the original
  if (targetId !== null && !canVote(state, targetId)) return false;

  m.votes[id] = targetId === null ? 'skip' : targetId;
  return true;
}

function stepMeeting(state) {
  const m = state.meeting;

  if (m.stage === 'vote') {
    const voters = playerList(state).filter((p) => canVote(state, p.id));
    const allIn = voters.every((p) => p.id in m.votes);
    if (!allIn && state.tick < m.endsAt) return { sync: false };
    tally(state);
    return { sync: true };
  }

  if (state.tick < m.endsAt) return { sync: false };
  return closeMeeting(state);
}

/**
 * Count the votes and decide.
 *
 * A tie ejects nobody, and so does a skip majority. Both are the same rule
 * really — the ship only throws someone out on a clear plurality — but they
 * are reported separately because "it was tied" and "we skipped" are very
 * different things to be told when you were the one on trial.
 */
function tally(state) {
  const m = state.meeting;
  const counts = {};
  let skips = 0;
  for (const v of Object.values(m.votes)) {
    if (v === 'skip') skips += 1;
    else counts[v] = (counts[v] || 0) + 1;
  }

  let topId = null, top = 0, tied = false;
  for (const [pid, n] of Object.entries(counts)) {
    if (n > top) { topId = pid; top = n; tied = false; }
    else if (n === top) tied = true;
  }

  const ejectedId = (!topId || tied || skips >= top) ? null : topId;
  m.stage = 'result';
  m.endsAt = state.tick + RESULT_TICKS;
  m.result = {
    counts,
    skips,
    ejectedId,
    tied: tied && !!topId && skips < top,
    skipped: !!topId && !tied && skips >= top,
    wasImpostor: ejectedId ? state.players[ejectedId].impostor : null,
    // Nobody may have voted at all if the timer ran out on an empty room.
    noVotes: Object.keys(m.votes).length === 0,
  };

  if (!ejectedId) {
    logLine(state, m.result.noVotes ? 'Nobody voted. No one was ejected.'
      : m.result.tied ? 'The vote was tied. No one was ejected.'
      : 'The crew skipped. No one was ejected.');
    return;
  }

  const p = state.players[ejectedId];
  p.alive = false;
  p.ix = 0; p.iy = 0;
  logLine(state, `${nameOf(state, ejectedId)} was ejected. They were ${p.impostor ? '' : 'not '}the impostor.`);
}

function closeMeeting(state) {
  state.meeting = null;
  state.phase = 'playing';
  state.buttonCd = BUTTON_COOLDOWN;
  // Everyone leaves the table on the same clock, ejected impostor or not.
  // Coming out of a meeting able to kill immediately turns every meeting into
  // a free kill for whoever stands nearest the door.
  for (const p of playerList(state)) {
    if (p.impostor) p.killCd = Math.max(p.killCd, OPENING_COOLDOWN);
  }
  checkWin(state);
  return { sync: true };
}

/* ============================== leaving ============================== */

/**
 * A player closed the tab.
 *
 * They are marked gone rather than deleted: the seat list is the wire format
 * for positions, so removing an entry would renumber everyone mid-match. Their
 * outstanding tasks come off the goal — leaving them on it means the crew can
 * never finish, and the crew losing because someone's wifi dropped is not a
 * loss anybody accepts.
 */
export function applyLeave(state, id) {
  const p = state.players[id];
  if (!p || p.left) return { sync: false };
  p.left = true;
  p.alive = false;
  p.ix = 0; p.iy = 0;
  state.bodies = state.bodies.filter((b) => b.id !== id);
  if (state.meeting) delete state.meeting.votes[id];

  if (!p.impostor) {
    const owed = p.tasks.filter((t) => !t.done).length;
    state.taskGoal = Math.max(state.taskDone, state.taskGoal - owed);
  }
  logLine(state, `${nameOf(state, id)} disconnected.`);
  checkWin(state);
  return { sync: true };
}

/* ============================== ending ============================== */

/**
 * Decide whether the round is over. Called after every event that could end
 * it, never on a timer.
 *
 * Order matters. Tasks are checked first so that a crew who finished the bar
 * on the same tick as a kill still wins — the work was done before the knife
 * came out, and the alternative punishes the player who was heads-down doing
 * exactly what the game asked of them.
 */
export function checkWin(state) {
  if (state.phase === 'over') return true;

  if (state.taskGoal > 0 && state.taskDone >= state.taskGoal) return end(state, 'crew', 'tasks');

  const imps = livingImpostors(state);
  const crew = livingCrew(state);
  if (imps.length === 0) return end(state, 'crew', 'ejected');
  if (imps.length >= crew.length) return end(state, 'impostors', 'outnumbered');
  return false;
}

function end(state, winner, reason) {
  state.phase = 'over';
  state.winner = winner;
  state.reason = reason;
  state.meeting = null;
  return true;
}

/* ============================== restarting ============================== */

/** A fresh round with the same seats, reshuffling who the impostor is. */
export function restart(state, seats = state.seats) {
  return createState(seats, { rng: state.rng });
}

/* ============================== helpers ============================== */

const nameOf = (state, id) => state.seats.find((s) => s.id === id)?.name || 'Someone';

function logLine(state, text) {
  state.log.push(text);
  if (state.log.length > 60) state.log.shift();
}

export { PLAYER_R };
