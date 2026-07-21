// Tests for the flashcard extractor.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_DEF_CHARS, MAX_DEF_CHARS, RUNNING_HEAD_PAGES,
  normalise, joinLines, trimDef, looksLikeTerm, startsEntry,
  stripRunningHeads, bodySize, toBlocks, cardsFromBlocks, extractCards,
} from '../js/study/flashcards/cards.js';

/* ---------------- helpers ---------------- */

/** A body-text line. Size 12 is the body size in every fixture below. */
const body = (text, page = 1) => ({ text, size: 12, bold: false, page });
/** A heading line — larger than body, which is the signal `toBlocks` reads. */
const head = (text, page = 1) => ({ text, size: 18, bold: false, page });

/** A definition long enough to clear MIN_DEF_CHARS without saying anything. */
const LONG = 'the movement of water across a partially permeable membrane';

/* ---------------- text utilities ---------------- */

test('normalise ignores case, punctuation and spacing', () => {
  assert.equal(normalise('  The   Krebs-Cycle! '), 'the krebs cycle');
  assert.equal(normalise('ATP'), normalise('a.t.p.'.replace(/\./g, '')));
});

test('joinLines fuses words the PDF broke across a line end', () => {
  assert.equal(joinLines(['photo-', 'synthesis is a process']), 'photosynthesis is a process');
});

test('joinLines separates lines that did not end mid-word', () => {
  assert.equal(joinLines(['the cell wall', 'is rigid']), 'the cell wall is rigid');
});

test('joinLines drops blank lines rather than doubling spaces', () => {
  assert.equal(joinLines(['one', '   ', 'two']), 'one two');
});

test('trimDef cuts at a sentence end when there is one in range', () => {
  const out = trimDef('Aaa bbb ccc ddd. '.repeat(40).trim());
  assert.ok(out.endsWith('.'), 'should end on a full stop');
  assert.ok(out.length <= MAX_DEF_CHARS);
  assert.ok(!out.endsWith('…'), 'should not have needed the word-boundary fallback');
});

test('trimDef ignores a sentence end so early it would gut the definition', () => {
  // Cutting at the first full stop here would leave 20 characters of a 320
  // budget, which throws away the answer to keep the punctuation tidy.
  const out = trimDef('Short opener here. ' + 'padding words '.repeat(60));
  assert.ok(out.endsWith('…'));
  assert.ok(out.length > 100);
});

test('trimDef falls back to a word boundary for one very long sentence', () => {
  const out = trimDef(('word '.repeat(200)).trim());
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('wor…'), 'should not cut mid-word');
});

test('trimDef leaves short definitions alone', () => {
  assert.equal(trimDef('Short and complete.'), 'Short and complete.');
});

/* ---------------- term detection ---------------- */

test('looksLikeTerm accepts a name and rejects a sentence', () => {
  assert.equal(looksLikeTerm('Osmosis'), true);
  assert.equal(looksLikeTerm('The Krebs cycle'), true);
  assert.equal(looksLikeTerm('Osmosis is the movement of water.'), false);
});

test('looksLikeTerm rejects fragments, numbers and figure captions', () => {
  assert.equal(looksLikeTerm('A'), false);
  assert.equal(looksLikeTerm('42'), false);
  assert.equal(looksLikeTerm('Figure 3'), false);
  assert.equal(looksLikeTerm('Table 1'), false);
});

test('looksLikeTerm rejects anything sentence-length', () => {
  assert.equal(looksLikeTerm('one two three four five six seven eight nine ten'), false);
});

/* ---------------- cleaning the page ---------------- */

test('stripRunningHeads drops text repeating across enough pages', () => {
  const lines = [];
  for (let p = 1; p <= RUNNING_HEAD_PAGES; p++) {
    lines.push(body('Chapter 4 — Cell Biology', p), body('Real content on page ' + p, p));
  }
  const kept = stripRunningHeads(lines);
  assert.equal(kept.filter((l) => l.text.startsWith('Chapter 4')).length, 0);
  assert.equal(kept.length, RUNNING_HEAD_PAGES);
});

test('stripRunningHeads keeps a term repeated on too few pages', () => {
  const lines = [body('Osmosis', 1), body('Osmosis', 2), body('other', 3)];
  assert.equal(stripRunningHeads(lines).length, 3);
});

test('stripRunningHeads drops bare page numbers', () => {
  const kept = stripRunningHeads([body('12', 1), body('Real text', 1), body('Page 3 of 9', 1)]);
  assert.deepEqual(kept.map((l) => l.text), ['Real text']);
});

test('bodySize weights by characters, so a few big display lines do not win', () => {
  const lines = [
    { text: 'BIG TITLE', size: 30, bold: false, page: 1 },
    { text: 'SUBTITLE', size: 30, bold: false, page: 1 },
    body('x'.repeat(400)),
  ];
  assert.equal(bodySize(lines), 12);
});

/* ---------------- blocks ---------------- */

test('toBlocks merges consecutive body lines into one paragraph', () => {
  const blocks = toBlocks([body('Osmosis is'), body('the movement of water.')]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'body');
  assert.equal(blocks[0].text, 'Osmosis is the movement of water.');
});

test('toBlocks marks a larger line as a heading', () => {
  const blocks = toBlocks([head('Osmosis'), body(LONG)]);
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'body']);
});

test('toBlocks treats a short bold line as a heading', () => {
  const blocks = toBlocks([{ text: 'Osmosis', size: 12, bold: true, page: 1 }, body(LONG)]);
  assert.equal(blocks[0].kind, 'heading');
});

test('toBlocks does not treat a long bold line as a heading', () => {
  // A whole bold paragraph is emphasis, not a section title — see the comment
  // in toBlocks. It must stay in the body buffer.
  const long = 'this bold run is far too long to be a section heading of any kind';
  const blocks = toBlocks([{ text: long, size: 12, bold: true, page: 1 }]);
  assert.equal(blocks[0].kind, 'body');
});

test('toBlocks strips list and section numbering from headings', () => {
  assert.equal(toBlocks([head('2.4.1 Osmosis'), body(LONG)])[0].text, 'Osmosis');
  assert.equal(toBlocks([head('3. Diffusion'), body(LONG)])[0].text, 'Diffusion');
});

test('startsEntry spots a glossary entry but not a prose colon', () => {
  assert.equal(startsEntry('Active transport: the movement of substances uphill'), true);
  assert.equal(startsEntry('There are three types: diffusion, osmosis and active transport'), false);
  assert.equal(startsEntry('However: this is just an aside about the topic'), false);
  assert.equal(startsEntry('no capital here: so this is not an entry either'), false);
  assert.equal(startsEntry('A paragraph with no separator at all'), false);
});

test('an entry line breaks out of the paragraph above it', () => {
  // Without the break, the glossary below this lead-in merges into it and only
  // the first entry ever becomes a card.
  const blocks = toBlocks([
    body('Cells move substances across their membranes in several ways.'),
    body('Diffusion: the net movement of particles down a concentration gradient'),
    body('Osmosis: the movement of water across a partially permeable membrane'),
  ]);
  assert.equal(blocks.length, 3);
});

/* ---------------- cards ---------------- */

test('a heading followed by a paragraph becomes a card', () => {
  const cards = cardsFromBlocks(toBlocks([head('Osmosis'), body(LONG)]));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].front, 'Osmosis');
  assert.equal(cards[0].back, LONG);
  assert.equal(cards[0].kind, 'heading');
});

test('a heading with nothing under it makes no card', () => {
  assert.deepEqual(cardsFromBlocks(toBlocks([head('Osmosis'), head('Diffusion')])), []);
});

test('a heading consumes its paragraph, so the paragraph is not mined twice', () => {
  const cards = cardsFromBlocks(toBlocks([head('Osmosis'), body('Diffusion means ' + LONG)]));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].front, 'Osmosis', 'the heading should win over the sentence pattern');
});

test('"X: definition" on one line becomes a card', () => {
  const cards = extractCards([body('Osmosis: ' + LONG)]);
  assert.equal(cards[0].front, 'Osmosis');
  assert.equal(cards[0].back, LONG);
});

test('an em-dash separator works the same as a colon', () => {
  const cards = extractCards([body('Osmosis — ' + LONG)]);
  assert.equal(cards[0].front, 'Osmosis');
});

test('sentence patterns lift the subject out as the term', () => {
  const cases = [
    ['Osmosis is defined as ' + LONG, 'Osmosis'],
    ['Osmosis refers to ' + LONG, 'Osmosis'],
    ['Osmosis means ' + LONG, 'Osmosis'],
    ['An enzyme is a protein that catalyses a biological reaction', 'enzyme'],
  ];
  for (const [text, front] of cases) {
    const cards = extractCards([body(text)]);
    assert.equal(cards.length, 1, `expected a card from: ${text}`);
    assert.equal(cards[0].front, front);
  }
});

test('"is defined as" beats the looser "is a" pattern', () => {
  // Ordering in SENTENCE_PATTERNS is what makes this work; if the loose pattern
  // ran first the term would come back as "Osmosis is defined".
  const cards = extractCards([body('Osmosis is defined as a passive transport process across membranes')]);
  assert.equal(cards[0].front, 'Osmosis');
});

test('the rest of the paragraph rides along as context', () => {
  const cards = extractCards([body('Osmosis means the movement of water. It requires no energy input at all.')]);
  assert.match(cards[0].back, /no energy input/);
});

test('a definition pattern later in a paragraph is ignored', () => {
  // Only the first sentence is mined — otherwise every incidental clause in the
  // document becomes a card.
  const text = 'Cells were first observed in the seventeenth century by Hooke. ' +
               'The result is a smaller value than the one obtained before.';
  assert.deepEqual(extractCards([body(text)]), []);
});

test('a colon in running prose makes no card', () => {
  // Same rule that stops this splitting a paragraph must stop it becoming a
  // card — it has the shape of a glossary entry and none of the substance.
  assert.deepEqual(extractCards([
    body('There are several factors affecting enzyme activity: temperature, pH and substrate concentration all matter.'),
  ]), []);
});

test('too short a definition makes no card', () => {
  assert.equal(MIN_DEF_CHARS > 10, true);
  assert.deepEqual(extractCards([body('Osmosis: water moves')]), []);
});

test('a back that merely restates the front is dropped', () => {
  // The contents-page case: the back adds nothing past the echo of the front.
  assert.deepEqual(cardsFromBlocks([
    { kind: 'heading', text: 'Osmosis', page: 1 },
    { kind: 'body', text: 'Osmosis and water potential', page: 1 },
  ]), []);
});

test('a definition that opens with its own term is kept', () => {
  // Only the echo is discounted, not the whole back — plenty of real
  // definitions begin by naming the thing they define.
  const cards = cardsFromBlocks([
    { kind: 'heading', text: 'Osmosis', page: 1 },
    { kind: 'body', text: 'Osmosis is ' + LONG, page: 1 },
  ]);
  assert.equal(cards.length, 1);
});

test('extractCards keeps the first of a repeated term', () => {
  const cards = extractCards([
    head('Osmosis', 1), body('First definition of the term, long enough to count.', 1),
    head('Osmosis', 2), body('Second definition of the term, long enough to count.', 2),
  ]);
  assert.equal(cards.length, 1);
  assert.match(cards[0].back, /First/);
});

test('extractCards honours its max', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(head('Term ' + i), body(`Definition number ${i} of something.`));
  assert.equal(extractCards(lines, { max: 5 }).length, 5);
});

test('every card gets a unique id', () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(head('Term ' + i), body(`Definition number ${i} of something.`));
  const cards = extractCards(lines);
  assert.equal(new Set(cards.map((c) => c.id)).size, cards.length);
});

test('prose with no structure yields no cards rather than junk', () => {
  // The honest failure mode: a novel has nothing to read, so it produces
  // nothing. Better an empty deck than twenty cards of narrative fragments.
  const cards = extractCards([
    body('It was a bright cold day in April, and the clocks were striking thirteen.'),
    body('Winston Smith slipped quickly through the glass doors of Victory Mansions.'),
  ]);
  assert.deepEqual(cards, []);
});

test('an empty document is handled', () => {
  assert.deepEqual(extractCards([]), []);
});

test('a realistic page produces the cards you would expect', () => {
  const lines = [
    head('Chapter 2: Transport in Cells', 1),
    body('Cells must move substances across their membranes constantly.', 1),
    head('Diffusion', 1),
    body('the net movement of particles from a region of higher concentration to a region of lower concentration', 1),
    head('Osmosis', 1),
    body('the movement of water molecules across a partially permeable membrane, down a water potential gradient', 1),
    body('Active transport: the movement of substances against a concentration gradient, requiring ATP', 1),
  ];
  const cards = extractCards(lines);
  assert.deepEqual(cards.map((c) => c.front), ['Diffusion', 'Osmosis', 'Active transport']);
  assert.ok(cards.every((c) => c.back.length >= MIN_DEF_CHARS));
});
