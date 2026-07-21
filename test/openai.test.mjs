// Tests for the pure parts of the OpenAI client — chunking, key validation and
// costing. Run: node --test test/
//
// The request itself isn't tested here: it needs a real key and real money, and
// a mocked fetch would only assert that the code sends what the code sends. The
// logic worth guarding is the logic that decides *what* gets sent and what the
// user is told it cost.
import test from 'node:test';
import assert from 'node:assert/strict';

import { chunk, looksLikeKey, costOf, formatCost, MODELS, DEFAULT_MODEL } from '../js/study/flashcards/openai.js';

/* ---------------- chunking ---------------- */

test('a short document is one chunk', () => {
  assert.deepEqual(chunk('## Osmosis\n\nSome text.', 1000), ['## Osmosis\n\nSome text.']);
});

test('an empty document is no chunks', () => {
  assert.deepEqual(chunk(''), []);
  assert.deepEqual(chunk('   \n  '), []);
});

test('a long document splits into several chunks', () => {
  const doc = Array.from({ length: 40 }, (_, i) => `## Term ${i}\n\n${'x'.repeat(80)}`).join('\n\n');
  const chunks = chunk(doc, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 500));
});

test('chunking prefers to break at a heading', () => {
  // Two sections, each comfortably inside the limit but together over it. The
  // split must land between them, or one chunk gets a heading with no body and
  // the other a body with no heading.
  const doc = `## First\n\n${'a'.repeat(300)}\n\n## Second\n\n${'b'.repeat(300)}`;
  const chunks = chunk(doc, 400);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].startsWith('## First'));
  assert.ok(chunks[1].startsWith('## Second'));
});

test('chunking falls back to a page marker when there is no heading', () => {
  const doc = `[p.1]\n\n${'a'.repeat(300)}\n\n[p.2]\n\n${'b'.repeat(300)}`;
  const chunks = chunk(doc, 400);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1].startsWith('[p.2]'));
});

test('one enormous paragraph is split bluntly rather than hanging', () => {
  // No boundary exists to break at. Splitting mid-sentence is bad; not
  // terminating is worse.
  const chunks = chunk('x'.repeat(2500), 500);
  assert.equal(chunks.length, 5);
  assert.equal(chunks.join('').length, 2500);
});

test('a boundary too early in the window is ignored', () => {
  // A heading 30 characters in would otherwise produce a near-empty chunk and
  // push the whole document through in tiny, expensive pieces.
  const doc = `${'a'.repeat(30)}\n\n## Early\n\n${'b'.repeat(900)}`;
  const chunks = chunk(doc, 500);
  assert.ok(chunks[0].length > 100, `first chunk was only ${chunks[0].length} chars`);
});

test('chunking loses no content', () => {
  const doc = Array.from({ length: 20 }, (_, i) => `## Term ${i}\n\nBody text for term ${i}.`).join('\n\n');
  const rejoined = chunk(doc, 300).join('\n\n');
  for (let i = 0; i < 20; i++) {
    assert.ok(rejoined.includes(`Term ${i}`), `lost heading ${i}`);
    assert.ok(rejoined.includes(`Body text for term ${i}.`), `lost body ${i}`);
  }
});

/* ---------------- key validation ---------------- */

test('looksLikeKey accepts a plausible key and rejects junk', () => {
  assert.equal(looksLikeKey('sk-proj-' + 'x'.repeat(40)), true);
  assert.equal(looksLikeKey('sk-' + 'x'.repeat(48)), true);
  assert.equal(looksLikeKey('  sk-proj-' + 'x'.repeat(40) + '  '), true);
  assert.equal(looksLikeKey('sk-short'), false);
  assert.equal(looksLikeKey('not-a-key-at-all'), false);
  assert.equal(looksLikeKey(''), false);
  assert.equal(looksLikeKey(null), false);
});

test('an Anthropic key left over from the old provider is rejected', () => {
  // The prefix check is loose, but not so loose that a key from the service this
  // no longer talks to sails through and buys a 401 at the user's expense.
  assert.equal(looksLikeKey('sk-ant-api03-' + 'x'.repeat(40)), false);
});

/* ---------------- costing ---------------- */

test('costOf prices against the named model', () => {
  const usage = { input_tokens: 1e6, output_tokens: 1e6 };
  const full = MODELS.find((m) => m.id === 'gpt-5');
  assert.equal(costOf(usage, 'gpt-5'), full.inPer1M + full.outPer1M);
});

test('costOf falls back to the default model for an unknown id', () => {
  const usage = { input_tokens: 1e6, output_tokens: 0 };
  const fallback = MODELS.find((m) => m.id === DEFAULT_MODEL);
  assert.equal(costOf(usage, 'gpt-nonexistent'), fallback.inPer1M);
});

test('a cheaper model costs less for the same work', () => {
  const usage = { input_tokens: 50_000, output_tokens: 10_000 };
  assert.ok(costOf(usage, 'gpt-5-nano') < costOf(usage, 'gpt-5'));
});

test('formatCost stays meaningful when the number is tiny', () => {
  assert.equal(formatCost(0.004), 'under 1¢');
  assert.equal(formatCost(0.12), '12¢');
  assert.equal(formatCost(2.5), '$2.50');
});
