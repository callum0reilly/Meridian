// Tests for the PDF-lines-to-Markdown conversion.
// Run: node --test test/
//
// What's covered here is the layout reading — which lines are furniture, which
// are headings, where paragraphs end. The card *content* is the model's job now
// and isn't unit-testable; what is testable, and what these guard, is that the
// model gets a faithful, well-marked rendering of the document.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNNING_HEAD_PAGES,
  normalise, joinLines, looksLikeTerm, cleanTerm,
  stripRunningHeads, bodySize, toBlocks, blocksToMarkdown, linesToMarkdown,
} from '../js/study/flashcards/doctext.js';

/* ---------------- helpers ---------------- */

/** A body-text line. Size 12 is the body size in every fixture below. */
const body = (text, page = 1) => ({ text, size: 12, bold: false, page });
/** A heading line — larger than body, which is the signal `toBlocks` reads. */
const head = (text, page = 1) => ({ text, size: 18, bold: false, page });

/** A definition long enough to be a real paragraph without saying anything. */
const LONG = 'the movement of water across a partially permeable membrane';

/* ---------------- text utilities ---------------- */

test('normalise ignores case, punctuation and spacing', () => {
  assert.equal(normalise('  The   Krebs-Cycle! '), 'the krebs cycle');
});

test('joinLines fuses words the PDF broke across a line end', () => {
  assert.equal(joinLines(['photo-', 'synthesis is a process']), 'photosynthesis is a process');
});

test('joinLines separates lines that did not end mid-word', () => {
  assert.equal(joinLines(['Osmosis is', 'the movement']), 'Osmosis is the movement');
});

test('joinLines drops blank lines rather than doubling spaces', () => {
  assert.equal(joinLines(['one', '   ', 'two']), 'one two');
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

test('cleanTerm strips list markers, numbering and dot leaders', () => {
  assert.equal(cleanTerm('• Osmosis'), 'Osmosis');
  assert.equal(cleanTerm('2.4.1 Osmosis'), 'Osmosis');
  assert.equal(cleanTerm('Osmosis ....... 42'), 'Osmosis');
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

test('a measured paragraph gap breaks the paragraph above it', () => {
  // `para` is set by markParagraphs in pdf.js from the vertical gap. Ignoring it
  // would run two sections together and hide the boundary the layout drew.
  const lines = [
    body('The first paragraph ends here.'),
    { ...body('A second paragraph starts here.'), para: true },
  ];
  assert.equal(toBlocks(lines).length, 2);
});

/* ---------------- markdown ---------------- */

test('blocksToMarkdown marks headings and emits a page marker', () => {
  const md = blocksToMarkdown([
    { kind: 'heading', text: 'Osmosis', page: 4 },
    { kind: 'body', text: LONG, page: 4 },
  ]);
  assert.equal(md, `[p.4]\n\n## Osmosis\n\n${LONG}`);
});

test('the page marker repeats only when the page changes', () => {
  const md = blocksToMarkdown([
    { kind: 'body', text: 'one', page: 1 },
    { kind: 'body', text: 'two', page: 1 },
    { kind: 'body', text: 'three', page: 2 },
  ]);
  assert.equal(md.match(/\[p\.\d+\]/g).length, 2);
  assert.deepEqual(md.match(/\[p\.\d+\]/g), ['[p.1]', '[p.2]']);
});

test('linesToMarkdown runs the whole pipeline', () => {
  const lines = [
    head('Osmosis', 1),
    body('Osmosis is the movement of water across a', 1),
    body('partially permeable membrane.', 1),
  ];
  assert.equal(
    linesToMarkdown(lines),
    '[p.1]\n\n## Osmosis\n\nOsmosis is the movement of water across a partially permeable membrane.',
  );
});

test('linesToMarkdown strips furniture before rendering', () => {
  const lines = [];
  for (let p = 1; p <= RUNNING_HEAD_PAGES; p++) {
    lines.push(body('Cell Biology', p), body('Content on page ' + p, p));
  }
  assert.ok(!linesToMarkdown(lines).includes('Cell Biology'));
});

test('an empty document is handled', () => {
  assert.equal(linesToMarkdown([]), '');
});
