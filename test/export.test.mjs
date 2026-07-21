// Tests for deck export. The download itself needs a DOM, so only the two pure
// functions are covered here — the file's contents and its name.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import { deckToFile, exportFilename, FORMAT, FORMAT_VERSION } from '../js/study/flashcards/export.js';
import { newSchedule, review } from '../js/study/flashcards/srs.js';

const T0 = 1_700_000_000_000;   // 2023-11-14, in UTC

const deck = () => ({
  id: 'd1',
  title: 'Cell Biology, ch. 4',
  source: 'biology.pdf · 12 pages',
  created: T0 - 86_400_000,
  cards: [
    { id: 'c1', front: 'What is a ribosome?', back: 'The site of protein synthesis.', page: 3, srs: newSchedule() },
    { id: 'c2', front: 'Where is ATP made?', back: 'The mitochondrion.', page: 5, srs: review(newSchedule(), 'good', T0) },
  ],
});

/* ---------------- file contents ---------------- */

test('the file is tagged so a reader can identify it', () => {
  const out = deckToFile(deck(), T0);
  assert.equal(out.format, FORMAT);
  assert.equal(out.version, FORMAT_VERSION);
  assert.equal(out.exported, T0);
});

test('every card survives with its schedule intact', () => {
  const src = deck();
  const out = deckToFile(src, T0);

  assert.equal(out.deck.cards.length, 2);
  assert.deepEqual(out.deck.cards[1].srs, src.cards[1].srs);
  assert.equal(out.deck.cards[1].srs.stage, 'learning');   // not reset to new
});

test('the deck round-trips through JSON unchanged', () => {
  const out = deckToFile(deck(), T0);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test('the file holds nothing beyond the deck', () => {
  // Guards against a future field on the deck object — a cached PDF, an API
  // key, a draft — riding along into a file the user may well share.
  const src = { ...deck(), apiKey: 'sk-ant-secret', pdfBytes: 'AAAA' };
  const out = deckToFile(src, T0);

  assert.deepEqual(Object.keys(out.deck).sort(), ['cards', 'created', 'id', 'source', 'title']);
  assert.equal(JSON.stringify(out).includes('sk-ant-secret'), false);
});

/* ---------------- filenames ---------------- */

test('a title becomes a dated slug', () => {
  assert.equal(exportFilename('Cell Biology, ch. 4', T0), 'cell-biology-ch-4-2023-11-14.json');
});

test('characters the filesystem rejects are stripped', () => {
  assert.equal(exportFilename('Notes: A/B <testing>', T0), 'notes-a-b-testing-2023-11-14.json');
});

test('apostrophes close up rather than splitting the word', () => {
  assert.equal(exportFilename("Ohm's law", T0), 'ohms-law-2023-11-14.json');
});

test('a title with nothing usable in it still names a file', () => {
  for (const title of ['', '   ', '???', '第四章', null, undefined]) {
    assert.equal(exportFilename(title, T0), 'deck-2023-11-14.json', `title: ${title}`);
  }
});

test('a very long title is cut without leaving a trailing separator', () => {
  const name = exportFilename('a '.repeat(80), T0);
  assert.equal(name.includes('--'), false);
  assert.equal(name, 'a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a-2023-11-14.json');
});
