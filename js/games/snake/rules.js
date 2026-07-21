// Snake, as it was on the Nokia 3310. Pure logic — no DOM, no timers, no canvas.
//
// Same shape as the other rules modules: one state object, mutated through
// these functions, with every function reporting what happened so the caller
// can react to it. Unlike Ludo/Uno/X-and-O's there is no host and no seats —
// this is one player against a grid, so `state` is the whole game.
//
// The only randomness is where food lands, so `rng` is injectable and a whole
// game is reproducible from a seed plus a key log. That is what lets the tests
// below assert on exact pellet positions.
//
// ---- Which Snake this is ----
//
// The 3310 shipped Snake I: a fixed rectangular arena, walls that kill, no
// maze levels, no wrap-around. Level (1–9) picks the speed before you start
// and does not change during a game. Snake II added mazes, portals and
// mid-game acceleration; none of that is here on purpose.

export const COLS = 24;
export const ROWS = 16;
export const START_LENGTH = 3;
export const GROW_PER_FOOD = 3;   // segments added per pellet

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 9;
export const DEFAULT_LEVEL = 3;

/**
 * Milliseconds per step at each level. Level 1 is a stroll, level 9 is about
 * as fast as a human can still steer on a grid this size.
 *
 * Not a linear ramp: the gap between consecutive levels shrinks as they get
 * faster, because at speed a fixed 18ms cut is a much larger proportional jump
 * than it is at the slow end. Even proportions make the ladder feel even.
 */
export const TICK_MS = [260, 210, 170, 140, 118, 100, 86, 76, 68];

export const tickMs = (level) => TICK_MS[clampLevel(level) - 1];

/**
 * Nearest valid level, or the default for anything that isn't a number.
 *
 * Deliberately not `Number(n) || DEFAULT_LEVEL`: that reads 0 as "missing" and
 * hands back level 3, when what the caller asked for is plainly the bottom of
 * the range. Only a genuine non-number falls through to the default.
 */
export const clampLevel = (n) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_LEVEL;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, v));
};

/** Named directions, so callers pass 'up' rather than a vector they built. */
export const DIRS = {
  up:    { x: 0, y: -1 },
  down:  { x: 0, y: 1 },
  left:  { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

/** Turns buffered ahead of the next step. See `turn` for why this exists. */
const QUEUE_LIMIT = 2;

/* ============================== setup ============================== */

export function createState({
  cols = COLS, rows = ROWS, level = DEFAULT_LEVEL, rng = Math.random,
} = {}) {
  const state = {
    phase: 'playing',       // playing | dead | won
    cols, rows,
    level: clampLevel(level),
    snake: [],              // head first; each { x, y }
    dir: 'right',
    queue: [],              // pending turns, applied one per step
    food: null,
    score: 0,
    eaten: 0,
    grow: 0,                // segments still owed from the last pellet
    steps: 0,
    cause: null,            // 'wall' | 'self', once dead
    rng,
  };

  // Start mid-height against the left wall, heading right, so the first thing
  // in front of the player is the whole board rather than a wall two cells on.
  const y = Math.floor(rows / 2);
  for (let i = 0; i < START_LENGTH; i++) state.snake.push({ x: START_LENGTH - 1 - i, y });

  state.food = placeFood(state);
  return state;
}

/* ============================== the grid ============================== */

export const inBounds = (state, p) =>
  p.x >= 0 && p.y >= 0 && p.x < state.cols && p.y < state.rows;

export const samePoint = (a, b) => a.x === b.x && a.y === b.y;

/**
 * Every cell not currently under the snake.
 *
 * Walked in full rather than by rejection-sampling a random cell: a nearly
 * complete snake leaves so few gaps that rejection sampling would spin for an
 * unbounded number of tries exactly when the player is about to win. A board
 * this size is a few hundred cells, so scanning it is cheaper than the retry
 * loop it replaces.
 */
export function freeCells(state) {
  const taken = new Set(state.snake.map((s) => s.x + ',' + s.y));
  const out = [];
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      if (!taken.has(x + ',' + y)) out.push({ x, y });
    }
  }
  return out;
}

/** A pellet on a free cell, or null when the snake covers the whole board. */
export function placeFood(state) {
  const free = freeCells(state);
  if (!free.length) return null;
  return free[Math.floor(state.rng() * free.length)];
}

/* ============================== steering ============================== */

/**
 * Queue a turn. Returns true if it was taken.
 *
 * Turns are queued rather than applied straight to `state.dir` because of one
 * specific way of dying that isn't the player's fault. Going right, you want
 * to double back downwards, so you press up then left inside a single tick. If
 * each keypress overwrote `dir`, the up would vanish unused and the next step
 * would drive left into your own neck. Buffering means both presses happen,
 * one per step, and the snake turns the corner you actually asked for.
 *
 * The queue holds two: enough for that double-tap, short enough that a panicky
 * flurry of presses doesn't leave the snake replaying inputs from a second ago.
 *
 * Reversal is checked against the *last queued* direction rather than the
 * current one, since that is what the snake will be travelling in by the time
 * this turn is reached.
 */
export function turn(state, name) {
  if (state.phase !== 'playing') return false;
  if (!DIRS[name]) return false;
  if (state.queue.length >= QUEUE_LIMIT) return false;

  const last = state.queue[state.queue.length - 1] ?? state.dir;
  if (name === last) return false;              // already going that way
  if (name === OPPOSITE[last]) return false;    // no 180s — that's just suicide

  state.queue.push(name);
  return true;
}

/* ============================== stepping ============================== */

/**
 * Advance one tick.
 *
 * @returns {{moved, ate, died, won, cause, head, score}}
 */
export function step(state) {
  const nothing = { moved: false, ate: false, died: false, won: false, cause: state.cause, head: null, score: state.score };
  if (state.phase !== 'playing') return nothing;

  if (state.queue.length) state.dir = state.queue.shift();
  const d = DIRS[state.dir];
  const head = { x: state.snake[0].x + d.x, y: state.snake[0].y + d.y };

  if (!inBounds(state, head)) return die(state, 'wall');

  // The tail cell empties on this very step unless the snake is still growing,
  // so chasing your own tail round a tight loop is legal — as it was on the
  // phone. Excluding it here rather than after the move keeps that true.
  const body = state.grow > 0 ? state.snake : state.snake.slice(0, -1);
  if (body.some((s) => samePoint(s, head))) return die(state, 'self');

  state.snake.unshift(head);
  if (state.grow > 0) state.grow -= 1;
  else state.snake.pop();

  state.steps += 1;

  let ate = false;
  if (state.food && samePoint(head, state.food)) {
    ate = true;
    state.eaten += 1;
    state.grow += GROW_PER_FOOD;
    state.score += pointsPerFood(state.level);
    state.food = placeFood(state);

    // No free cell left means the snake is the board. Nobody is ever going to
    // see this, but a game that can't be won is a game with a bug in it.
    if (!state.food) {
      state.phase = 'won';
      return { moved: true, ate: true, died: false, won: true, cause: null, head, score: state.score };
    }
  }

  return { moved: true, ate, died: false, won: false, cause: null, head, score: state.score };
}

/**
 * A pellet is worth its level.
 *
 * The alternative — flat scoring — makes level 1 the correct way to farm a
 * high score, since the snake is identical and you have four times as long to
 * steer it. Paying out by level means the leaderboard rewards the speed you
 * survived at, not the patience you had.
 */
export const pointsPerFood = (level) => clampLevel(level);

function die(state, cause) {
  state.phase = 'dead';
  state.cause = cause;
  return { moved: false, ate: false, died: true, won: false, cause, head: null, score: state.score };
}

/* ============================== restarting ============================== */

/** Fresh game on the same grid. `level` defaults to the one just played. */
export function restart(state, level = state.level) {
  return createState({ cols: state.cols, rows: state.rows, level, rng: state.rng });
}
