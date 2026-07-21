// Downloading a deck to a file.
//
// Decks live in localStorage (see store.js), which is a good default — no
// account, no server, nothing to sync — but it is also a directory the browser
// is free to clear. "Clear browsing data", a quota eviction, or simply studying
// on a different machine all lose a deck that took real money and real
// attention to build. Export is the escape hatch: one file, on your disk, yours.
//
// ---- Why JSON and not CSV ----
//
// CSV is what most flashcard tools export, and it is the wrong shape here. A
// deck's value is not only its text — it is the schedule attached to each card,
// built up over weeks of grading. A CSV of front/back columns throws that away
// and hands back a deck that is due entirely today, which is the same deck a
// user could have regenerated from the PDF. The JSON below keeps the srs block
// verbatim, so a re-imported deck resumes rather than restarts.
//
// The file is deliberately the same shape `migrate` in store.js already accepts,
// so importing it later is a matter of reading and validating, not translating.

/** Written into every file so a future reader knows what it is holding. */
export const FORMAT = 'meridian.flashcards.deck';
export const FORMAT_VERSION = 1;

/**
 * The object written to disk for one deck.
 *
 * `exported` is recorded because the schedule is made of absolute timestamps: a
 * file restored two months later will show most of its cards as overdue, and
 * the date is what lets a person — or a future importer — tell "overdue because
 * I stopped studying" from "overdue because the clock moved on without me".
 */
export function deckToFile(deck, now = Date.now()) {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exported: now,
    deck: {
      id: deck.id,
      title: deck.title,
      source: deck.source,
      created: deck.created,
      cards: deck.cards.map((c) => ({
        id: c.id,
        front: c.front,
        back: c.back,
        page: c.page,
        srs: c.srs,
      })),
    },
  };
}

/**
 * A filename from a deck title.
 *
 * Titles come from PDF metadata and from a free text box, so they contain
 * anything: slashes, colons, emoji, a hundred characters of subtitle. Windows
 * rejects most of the punctuation outright and the rest makes for a file that
 * is annoying to handle in a shell, so this reduces to a conservative set and
 * lets an unusable title fall back rather than producing a file called ".json".
 */
export function exportFilename(title, now = Date.now()) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/['’]/g, '')            // don't leave "don-t" where "dont" reads fine
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');             // the slice may have landed mid-separator
  const date = new Date(now).toISOString().slice(0, 10);
  return `${slug || 'deck'}-${date}.json`;
}

/**
 * Hand the file to the browser's download machinery.
 *
 * An object URL with a synthetic click is the only route that works without a
 * server — and the revoke matters: the blob is held alive by the URL, so
 * skipping it would leak a copy of every deck the user exported for the life of
 * the tab. It is deferred because revoking before the click is dispatched
 * cancels the download in Firefox.
 */
export function downloadDeck(deck, now = Date.now()) {
  const json = JSON.stringify(deckToFile(deck, now), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));

  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename(deck.title, now);
  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
