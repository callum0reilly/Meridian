// Spaced repetition scheduling. Pure logic — no DOM, no storage, no clock of
// its own: every function that needs the time takes it as an argument, so a
// test can run a year of reviews in a millisecond.
//
// ---- Which algorithm this is ----
//
// SM-2, the Anki/SuperMemo family, with learning steps in front of it. A card
// you have never seen goes through short same-session steps (one minute, ten
// minutes) before it is allowed to graduate to day-scale intervals.
//
// Those learning steps are not decoration. Pure SM-2 schedules a new card's
// second showing a day later, which means a first session with a fresh deck
// shows you thirty cards once each and then declares you finished — you close
// the tab having learnt nothing, because nothing was repeated while you were
// still there. The learning steps are what make a single sitting feel like
// studying rather than like reading a list.
//
// ---- Times are epoch milliseconds ----
//
// Not Date objects and not day numbers, so a card survives JSON.stringify into
// localStorage and comes back identical. `intervalDays` is kept as a float —
// rounding it to whole days at each step compounds, and a 0.4-day interval is
// meaningful for a card you keep failing.

export const MIN_EASE = 1.3;
export const MAX_EASE = 3.0;
export const START_EASE = 2.5;

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Same-session steps a new card walks before it earns a day-scale interval. */
export const LEARNING_STEPS = [1 * MINUTE, 10 * MINUTE];

/** Interval a card graduates to, in days, by the grade that graduated it. */
export const GRADUATE_DAYS = { good: 1, easy: 4 };

/** The four buttons, worst to best. */
export const GRADES = ['again', 'hard', 'good', 'easy'];

/**
 * A card's scheduling state, fresh.
 *
 * `due: 0` rather than `Date.now()` so a new card is due at any clock reading —
 * this keeps `newSchedule()` pure and means a deck restored from storage on a
 * machine with a skewed clock still shows its unseen cards.
 */
export const newSchedule = () => ({
  stage: 'new',        // new | learning | review
  step: 0,             // index into LEARNING_STEPS, while learning
  ease: START_EASE,
  intervalDays: 0,
  due: 0,
  reps: 0,
  lapses: 0,
  lastGrade: null,
});

const clampEase = (e) => Math.min(MAX_EASE, Math.max(MIN_EASE, e));

/**
 * Apply a grade. Returns a new schedule — the caller decides what to persist.
 *
 * @param {object} sched  from `newSchedule()` or a previous `review()`
 * @param {'again'|'hard'|'good'|'easy'} grade
 * @param {number} now  epoch ms
 */
export function review(sched, grade, now) {
  if (!GRADES.includes(grade)) throw new Error('unknown grade: ' + grade);

  const next = { ...sched, reps: sched.reps + 1, lastGrade: grade };
  const learning = sched.stage === 'new' || sched.stage === 'learning';

  if (learning) {
    if (grade === 'again') {
      // Back to the start of the steps: a card you couldn't answer has not
      // half-learnt itself, and resuming mid-ladder would show it once more
      // and then bank it for a day.
      next.stage = 'learning';
      next.step = 0;
      next.due = now + LEARNING_STEPS[0];
      return next;
    }
    if (grade === 'easy') return graduate(next, GRADUATE_DAYS.easy, now);

    // 'hard' repeats the current step rather than advancing, so a shaky card
    // gets another short look instead of being pushed out to tomorrow.
    const step = grade === 'good' ? sched.step + 1 : sched.step;
    if (step >= LEARNING_STEPS.length) return graduate(next, GRADUATE_DAYS.good, now);
    next.stage = 'learning';
    next.step = step;
    next.due = now + (grade === 'hard' ? hardDelay(step) : LEARNING_STEPS[step]);
    return next;
  }

  // ---- review-stage card ----
  if (grade === 'again') {
    // A lapse drops the card back into learning and takes a bite out of ease,
    // but the old interval is not thrown away — the card is not as new as one
    // you have never seen, and re-teaching it from one day costs sessions.
    next.stage = 'learning';
    next.step = 0;
    next.lapses = sched.lapses + 1;
    next.ease = clampEase(sched.ease - 0.2);
    next.intervalDays = Math.max(1, sched.intervalDays * 0.4);
    next.due = now + LEARNING_STEPS[0];
    return next;
  }

  const base = Math.max(sched.intervalDays, 1);
  let days, ease = sched.ease;
  if (grade === 'hard') { days = base * 1.2; ease = clampEase(ease - 0.15); }
  else if (grade === 'good') { days = base * ease; }
  else { days = base * ease * 1.3; ease = clampEase(ease + 0.15); }

  next.stage = 'review';
  next.ease = ease;
  next.intervalDays = days;
  next.due = now + days * DAY;
  return next;
}

/**
 * How long 'hard' waits while still on learning step `i`.
 *
 * Not simply `LEARNING_STEPS[i]`. On the first step that is one minute, which
 * is exactly what 'again' gives — so the two buttons would read "Again 1m" and
 * "Hard 1m" and do the identical thing, leaving the user to pick between two
 * labels with no difference behind them. Sitting hard halfway to the next step
 * gives it its own meaning: sooner than 'good', later than a failure.
 */
function hardDelay(i) {
  const next = LEARNING_STEPS[i + 1];
  return next === undefined ? LEARNING_STEPS[i] * 1.5 : (LEARNING_STEPS[i] + next) / 2;
}

function graduate(next, days, now) {
  next.stage = 'review';
  next.step = 0;
  next.intervalDays = days;
  next.due = now + days * DAY;
  return next;
}

/* ============================== queueing ============================== */

export const isDue = (sched, now) => sched.due <= now;

/**
 * The cards to show, in the order to show them.
 *
 * Overdue review cards come before learning cards, which come before unseen
 * ones. Reviews first because they are the ones with a schedule to honour —
 * everything else can wait a few minutes without decaying. Unseen cards last
 * because introducing new material before clearing the backlog is how a deck
 * becomes unmanageable.
 *
 * Within reviews, most overdue first. Within new cards, document order, so a
 * deck built from a PDF teaches in the order the PDF explained things.
 */
export function dueQueue(cards, now) {
  const rank = { review: 0, learning: 1, new: 2 };
  return cards
    .filter((c) => isDue(c.srs, now))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const byStage = rank[a.c.srs.stage] - rank[b.c.srs.stage];
      if (byStage) return byStage;
      if (a.c.srs.stage === 'new') return a.i - b.i;
      return a.c.srs.due - b.c.srs.due;
    })
    .map(({ c }) => c);
}

/** Headline counts for the deck list and the session bar. */
export function deckStats(cards, now) {
  const stats = { total: cards.length, new: 0, learning: 0, review: 0, due: 0 };
  for (const c of cards) {
    stats[c.srs.stage] += 1;
    if (isDue(c.srs, now)) stats.due += 1;
  }
  return stats;
}

/**
 * When the next card comes back, as a short human string.
 *
 * Shown on the grade buttons before you press them, which is the only way to
 * make the difference between "hard" and "good" legible — otherwise they are
 * four unlabelled degrees of a feeling.
 */
export function describeNext(sched, grade, now) {
  const due = review(sched, grade, now).due;
  const ms = Math.max(0, due - now);
  if (ms < 45 * MINUTE) return Math.max(1, Math.round(ms / MINUTE)) + 'm';
  if (ms < DAY) return Math.round(ms / (60 * MINUTE)) + 'h';
  const days = ms / DAY;
  if (days < 30) return Math.round(days) + 'd';
  if (days < 365) return Math.round(days / 30) + 'mo';
  return (days / 365).toFixed(1).replace(/\.0$/, '') + 'y';
}
