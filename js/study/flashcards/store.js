// Deck persistence, in localStorage.
//
// Spaced repetition is the whole reason this exists. An interval measured in
// days is a promise to show you a card next Tuesday, and a deck that evaporates
// on refresh cannot keep that promise — it would show every card as new, every
// session, which is a flashcard viewer rather than a study tool.
//
// ---- Why localStorage and not IndexedDB ----
//
// Decks are small: a card is a couple of hundred bytes, so a 300-card deck is
// well under 100KB and a realistic library of them fits inside the ~5MB budget
// with room to spare. The original PDF is deliberately *not* kept — it is by
// far the largest thing in play and nothing after extraction ever reads it
// again. IndexedDB would buy space this feature doesn't need at the cost of an
// async API through every call site.
//
// The one real risk is the quota, and `save` reports that as a typed failure
// rather than throwing, so the UI can say which deck didn't fit.

import { newSchedule } from './srs.js';

const KEY = 'meridian.study.decks.v1';

/** Bumped only for changes that need `migrate` to do something. */
const VERSION = 1;

const nowId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ============================== reading ============================== */

/**
 * Every deck, newest first.
 *
 * Storage can fail or hold junk — a half-written value, another tab's key, a
 * browser in private mode that refuses to persist. All of those come back as an
 * empty library rather than an exception, because a study tab that renders
 * nothing is recoverable and one that throws during init is a dead tab.
 */
export function loadDecks() {
  let raw;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return [];   // private mode, or storage disabled entirely
  }
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    const decks = Array.isArray(parsed?.decks) ? parsed.decks : [];
    return decks.map(migrate).filter(Boolean).sort((a, b) => b.created - a.created);
  } catch {
    console.warn('[study] deck store was unreadable; starting empty');
    return [];
  }
}

/**
 * Repair a deck read from storage.
 *
 * Anything in localStorage is untrusted input — it may have been written by an
 * older version of this file, or edited by hand. Cards missing their schedule
 * get a fresh one instead of crashing the queue on `undefined.due`.
 */
function migrate(deck) {
  if (!deck || typeof deck !== 'object' || !Array.isArray(deck.cards)) return null;
  return {
    id: deck.id || nowId(),
    title: String(deck.title || 'Untitled deck'),
    source: String(deck.source || ''),
    created: Number(deck.created) || Date.now(),
    cards: deck.cards
      .filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string')
      .map((c) => ({
        id: c.id || nowId(),
        front: c.front,
        back: c.back,
        page: Number(c.page) || 1,
        // `kind` used to be stored here — the old extractor tagged each card
        // with the rule that produced it. Nothing ever read it, and the model
        // doesn't work in those categories, so it's dropped on load rather than
        // carried forward as a field that means nothing.
        srs: c.srs && typeof c.srs.due === 'number' ? c.srs : newSchedule(),
      })),
  };
}

/* ============================== writing ============================== */

/**
 * Persist the library.
 *
 * @returns {{ok: true} | {ok: false, reason: 'quota'|'unavailable', message: string}}
 */
export function saveDecks(decks) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, decks }));
    return { ok: true };
  } catch (err) {
    // Chrome, Firefox and Safari all name the quota error differently; the code
    // 22 check is the one that holds across them.
    const quota = err?.name === 'QuotaExceededError' ||
                  err?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err?.code === 22;
    return quota
      ? { ok: false, reason: 'quota', message: 'No room left in browser storage — delete a deck and try again.' }
      : { ok: false, reason: 'unavailable', message: 'This browser won\'t save decks (private browsing blocks it).' };
  }
}

/** A deck object from approved cards. Not saved — the caller decides that. */
export function makeDeck(title, source, cards) {
  return {
    id: nowId(),
    title: title || 'Untitled deck',
    source: source || '',
    created: Date.now(),
    cards: cards.map((c) => ({
      id: c.id,
      front: c.front,
      back: c.back,
      page: c.page,
      srs: newSchedule(),
    })),
  };
}
