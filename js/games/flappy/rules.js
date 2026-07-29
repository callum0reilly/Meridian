// Flappy Bird. Pure logic — no DOM, no canvas, no timers.
//
// Same shape as the other rules modules: one state object, mutated through
// these functions, with every call reporting what happened so the caller can
// react to it. Like Snake there is no host and no seats — one bird against a
// pipe field — so `state` is the whole game.
//
// ---- Fixed steps, not frames ----
//
// The numbers below are per *step*, and a step is 1/60s. The obvious way to
// write this game is to advance it once per `requestAnimationFrame`, but then
// gravity is whatever the monitor happens to be: the same 0.45 makes the bird
// fall twice as fast on a 120Hz laptop as on a 60Hz one, and a run recorded on
// one machine is unplayable on another. Stepping on a clock instead means the
// bird falls at the same rate everywhere, and it is what lets the tests below
// count steps and assert on exact positions.
//
// ---- Coordinates ----
//
// y grows downwards, as it does on a canvas, so gravity is positive and a flap
// is negative. The playfield is a fixed 400x600 with the bottom 80 as ground;
// the view scales that with CSS rather than the model knowing anything about
// how big it is on screen.

export const WIDTH = 400;
export const HEIGHT = 600;
export const GROUND_H = 80;

/** The floor the bird dies on — the top of the ground strip, not the canvas. */
export const FLOOR = HEIGHT - GROUND_H;

export const TICK_MS = 1000 / 60;

/* ---- flight ---- */
export const GRAVITY = 0.45;      // added to vy each step
export const FLAP_V = -8;         // vy is *set* to this, not nudged by it
export const BIRD_X = 100;        // the bird never moves horizontally
export const BIRD_R = 14;

/* ---- pipes ---- */
export const PIPE_GAP = 160;      // vertical hole the bird flies through
export const PIPE_W = 60;
export const PIPE_SPEED = 2.4;    // pixels per step, leftwards
export const PIPE_SPACING = 220;  // horizontal distance between pipes
export const PIPE_MARGIN = 60;    // gap stays this far off the ceiling/ground
export const PIPE_COUNT = 3;      // enough to cover the screen plus one waiting
export const FIRST_PIPE_X = WIDTH + 100;

/** Highest and lowest the top pipe may end, so no gap is unreachable. */
export const MIN_TOP = PIPE_MARGIN;
export const MAX_TOP = FLOOR - PIPE_GAP - PIPE_MARGIN;

/** How far the menu bird drifts up and down while waiting to start. */
const BOB_AMPLITUDE = 8;
const BOB_PERIOD = 15;

/* ============================== setup ============================== */

export function createState({ rng = Math.random } = {}) {
  const state = {
    phase: 'ready',           // ready | playing | dead
    bird: { x: BIRD_X, y: HEIGHT / 2, vy: 0, r: BIRD_R },
    pipes: [],                // left to right; each { x, top, passed }
    score: 0,
    ticks: 0,
    cause: null,              // 'ground' | 'pipe', once dead
    rng,
  };

  // Laid out from off-screen right so the first pipe arrives a couple of
  // seconds in. A bird that has to flap immediately on the first frame is a
  // bird that dies before the player has read the instructions.
  for (let i = 0; i < PIPE_COUNT; i++) {
    state.pipes.push(makePipe(state, FIRST_PIPE_X + PIPE_SPACING * i));
  }
  return state;
}

/** A pipe at `x` with a randomly placed gap. */
export function makePipe(state, x) {
  const top = MIN_TOP + state.rng() * (MAX_TOP - MIN_TOP);
  return { x, top, passed: false };
}

/* ============================== input ============================== */

/**
 * Flap. Returns true if the bird actually beat its wings.
 *
 * The first flap also starts the run, so pressing space on the menu doesn't
 * cost you a press — the bird takes off on the same input that begins the game.
 * A dead bird ignores this entirely; restarting is the caller's business, since
 * "any key also restarts" turns the reflex press after a crash into an
 * accidental new run you weren't looking at yet.
 */
export function flap(state) {
  if (state.phase === 'ready') state.phase = 'playing';
  else if (state.phase !== 'playing') return false;

  // Set rather than add: a flap is a fixed upward impulse, so hammering the
  // key while already rising doesn't stack into an escape to orbit.
  state.bird.vy = FLAP_V;
  return true;
}

/* ============================== stepping ============================== */

/**
 * Advance one step (1/60s).
 *
 * @returns {{moved, scored, died, cause, score}}
 */
export function step(state) {
  const still = { moved: false, scored: 0, died: false, cause: state.cause, score: state.score };

  if (state.phase === 'ready') {
    // Gentle bob on the menu. Driven by the step counter rather than the wall
    // clock so a paused menu doesn't lurch when it comes back.
    state.ticks += 1;
    state.bird.y = HEIGHT / 2 + Math.sin(state.ticks / BOB_PERIOD) * BOB_AMPLITUDE;
    return still;
  }
  if (state.phase !== 'playing') return still;

  state.ticks += 1;
  state.bird.vy += GRAVITY;
  state.bird.y += state.bird.vy;

  let scored = 0;
  for (const p of state.pipes) {
    p.x -= PIPE_SPEED;
    // Scored on the trailing edge clearing the bird's centre: the point you
    // are unambiguously through, rather than the moment of nearest miss.
    if (!p.passed && p.x + PIPE_W < state.bird.x) {
      p.passed = true;
      scored += 1;
    }
  }
  state.score += scored;

  // Recycle the pipe that has left the screen to the far right of the queue,
  // so the field is three objects for the whole run rather than an array that
  // grows for as long as you survive.
  // The spacing is measured before the shift, not after: with a field of one
  // there is nothing left to measure from once the old pipe is gone, and a
  // recycler that only works while the array is full is a trap for whoever
  // changes PIPE_COUNT.
  if (state.pipes.length && state.pipes[0].x + PIPE_W < 0) {
    const lastX = state.pipes[state.pipes.length - 1].x;
    state.pipes.shift();
    state.pipes.push(makePipe(state, lastX + PIPE_SPACING));
  }

  // The ceiling is a lid, not a blade: you bonk and drop. Killing there is
  // technically consistent but it punishes the panicky over-flap that every
  // new player does in their first minute, and it isn't how the original
  // behaved either.
  if (state.bird.y - state.bird.r < 0) {
    state.bird.y = state.bird.r;
    state.bird.vy = 0;
  }

  if (state.bird.y + state.bird.r > FLOOR) {
    // Park the bird on the ground before ending, so the last frame drawn is a
    // bird lying on the grass rather than one halfway through it.
    state.bird.y = FLOOR - state.bird.r;
    return die(state, 'ground', scored);
  }

  for (const p of state.pipes) {
    if (hits(state.bird, p)) return die(state, 'pipe', scored);
  }

  return { moved: true, scored, died: false, cause: null, score: state.score };
}

/**
 * Is the bird inside this pipe?
 *
 * The bird is treated as its bounding box, not as a circle. A circle test is
 * more truthful at the pipe lips and about a pixel more generous, which is a
 * pixel of forgiveness on the one collision the player will argue with. This
 * is the harsher, simpler reading, and it's the one the game was tuned on.
 */
export function hits(bird, p) {
  const inX = bird.x + bird.r > p.x && bird.x - bird.r < p.x + PIPE_W;
  if (!inX) return false;
  return bird.y - bird.r < p.top || bird.y + bird.r > p.top + PIPE_GAP;
}

function die(state, cause, scored) {
  state.phase = 'dead';
  state.cause = cause;
  state.bird.vy = 0;
  return { moved: true, scored, died: true, cause, score: state.score };
}

/* ============================== restarting ============================== */

/** Fresh run, same random source. */
export function restart(state) {
  return createState({ rng: state.rng });
}
