// Tests for the pdf.js line grouper.
//
// This is the impure module, but `itemsToLines` itself is pure: text runs in,
// lines out. Testing it directly matters because every heuristic downstream
// trusts its output, and the paragraph flag in particular is the difference
// between a page of cards and a page merged into one useless block.
//
// Importing this module does not touch the network — pdf.js itself is loaded
// lazily inside `loadPdfJs`, which nothing here calls.
//
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import { itemsToLines } from '../js/study/flashcards/pdf.js';

/**
 * A pdf.js text run. `transform` is [a, b, c, d, x, y]: the font size sits in
 * `a` and the baseline position in `x`/`y`, which is the layout pdf.js reports
 * and the only reason this shape looks the way it does.
 */
const item = (str, y, { x = 72, size = 12, font = 'Times' } = {}) =>
  ({ str, transform: [size, 0, 0, size, x, y], fontName: font, height: size });

/** Lines going down a page at a constant leading, as ordinary body text. */
const column = (texts, { top = 700, leading = 14, ...rest } = {}) =>
  texts.map((t, i) => item(t, top - i * leading, rest));

test('runs sharing a baseline become one line', () => {
  const lines = itemsToLines([
    item('Osmosis', 700, { x: 72 }),
    item('is the movement of water', 700, { x: 130 }),
  ], 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Osmosis is the movement of water');
});

test('a bold run inside a line does not make the whole line bold', () => {
  // This is the case that matters: "**Osmosis** is the movement of..." must not
  // register as a heading just because it opens with a bold term.
  const lines = itemsToLines([
    item('Osmosis', 700, { x: 72, font: 'Times-Bold' }),
    item('is the movement of water', 700, { x: 130 }),
  ], 1);
  assert.equal(lines[0].bold, false);
});

test('a wholly bold line is reported as bold', () => {
  const lines = itemsToLines([
    item('Key', 700, { x: 72, font: 'Times-Bold' }),
    item('terms', 700, { x: 100, font: 'Times-Bold' }),
  ], 1);
  assert.equal(lines[0].bold, true);
});

test('lines come back top of page first', () => {
  // PDF y grows upwards, so the sort is descending; getting it backwards would
  // silently reverse every document.
  const lines = itemsToLines([item('bottom', 100), item('top', 700), item('middle', 400)], 1);
  assert.deepEqual(lines.map((l) => l.text), ['top', 'middle', 'bottom']);
});

test('a superscript does not become a line of its own', () => {
  const lines = itemsToLines([
    item('E = mc', 700),
    item('2', 704, { size: 8 }),   // sits slightly above the baseline
  ], 1);
  assert.equal(lines.length, 1);
});

test('empty and whitespace-only runs are dropped', () => {
  const lines = itemsToLines([item('', 700), item('   ', 690), item('real', 680)], 1);
  assert.deepEqual(lines.map((l) => l.text), ['real']);
});

test('the line size is the largest run in it', () => {
  const lines = itemsToLines([item('big', 700, { size: 18 }), item('small', 700, { x: 200, size: 10 })], 1);
  assert.equal(lines[0].size, 18);
});

test('the page number is carried onto every line', () => {
  const lines = itemsToLines(column(['a', 'b']), 7);
  assert.ok(lines.every((l) => l.page === 7));
});

/* ---------------- paragraph detection ---------------- */

test('evenly spaced lines are all one paragraph', () => {
  const lines = itemsToLines(column(['one', 'two', 'three', 'four']), 1);
  assert.deepEqual(lines.map((l) => l.para), [true, false, false, false]);
});

test('an extra gap starts a new paragraph', () => {
  const items = [
    ...column(['first line', 'second line', 'third line'], { top: 700, leading: 14 }),
    item('new paragraph', 700 - 2 * 14 - 19),   // a paragraph gap below the last
    item('its second line', 700 - 2 * 14 - 19 - 14),
  ];
  const lines = itemsToLines(items, 1);
  assert.deepEqual(lines.map((l) => l.text), [
    'first line', 'second line', 'third line', 'new paragraph', 'its second line',
  ]);
  assert.deepEqual(lines.map((l) => l.para), [true, false, false, true, false]);
});

test('leading is taken from the commonest gap, not the median', () => {
  // A page of two-line paragraphs: half the gaps are paragraph gaps, so the
  // median lands on one and would set the threshold above every real break.
  // This is the exact shape that merged a whole page into one block.
  const leading = 14, para = 19;
  const items = [];
  let y = 700;
  for (let p = 0; p < 4; p++) {
    items.push(item(`para ${p} line 1`, y));
    y -= leading;
    items.push(item(`para ${p} line 2`, y));
    y -= para;
  }
  const lines = itemsToLines(items, 1);
  assert.deepEqual(lines.map((l) => l.para), [true, false, true, false, true, false, true, false]);
});

test('the first line of a page always starts a block', () => {
  assert.equal(itemsToLines(column(['only page content']), 3)[0].para, true);
});

test('a single line is handled without dividing by zero', () => {
  const lines = itemsToLines([item('alone', 700)], 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].para, true);
});

test('no items yields no lines', () => {
  assert.deepEqual(itemsToLines([], 1), []);
});

test('tight leading still separates paragraphs proportionally', () => {
  // 8pt type with 9pt leading: the absolute gaps are far smaller, so a fixed
  // point threshold would find no paragraphs at all here.
  const items = [
    ...column(['a', 'b', 'c'], { top: 700, leading: 9, size: 8 }),
    item('new para', 700 - 2 * 9 - 13, { size: 8 }),
  ];
  const lines = itemsToLines(items, 1);
  assert.deepEqual(lines.map((l) => l.para), [true, false, false, true]);
});
