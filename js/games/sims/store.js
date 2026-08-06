// Household persistence, in localStorage.
//
// A life sim without a save is a tamagotchi you meet once. The whole point of
// no-aging, keep-the-house design is that the family is still there next week —
// so the save is a first-class feature, not a convenience.
//
// Same contract as study/flashcards/store.js: reading never throws (junk, old
// versions and private mode all come back as null and a fresh start), and
// writing reports failure as a typed result so the UI can say what happened
// instead of dying inside an autosave timer. All field-level repair lives in
// rules.deserialize — this file only moves bytes.

import { serialize, deserialize } from './rules.js';

const KEY = 'meridian.sims.save.v1';

/** The saved household, repaired and ready to step — or null. */
export function load() {
  let raw;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;                     // private mode, or storage disabled
  }
  if (!raw) return null;
  try {
    return deserialize(JSON.parse(raw));
  } catch {
    console.warn('[sims] save was unreadable; starting fresh');
    return null;
  }
}

/**
 * @returns {{ok: true} | {ok: false, reason: 'quota'|'unavailable', message: string}}
 */
export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(serialize(state)));
    return { ok: true };
  } catch (err) {
    const quota = err?.name === 'QuotaExceededError' ||
                  err?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err?.code === 22;
    return quota
      ? { ok: false, reason: 'quota', message: 'No room in browser storage — the household can’t be saved.' }
      : { ok: false, reason: 'unavailable', message: 'This browser won’t save the household (private browsing blocks it).' };
  }
}

export function wipe() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}
