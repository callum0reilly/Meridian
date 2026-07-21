// Turning a PDF's text into flashcards. Pure logic — no DOM, no pdf.js, no
// network. Input is the line array that pdf.js gives us (see pdf.js), output is
// a list of cards. That split is what lets the tests below feed it hand-written
// lines and assert on exact cards.
//
// ---- What this is and isn't ----
//
// There is no model here. This reads *shape*, not meaning: font size marks a
// heading, a colon or a dash marks a definition, "X refers to Y" is a sentence
// pattern we can lift a term out of. That works well on the material people
// actually revise from — textbook chapters, lecture slides, glossaries, spec
// documents — because that material is already written as term-then-explanation.
// It does poorly on continuous prose (a novel, an essay) because prose has no
// such shape to read, and no amount of regex invents one.
//
// So the honest contract is: good cards from structured documents, few or no
// cards from unstructured ones. The UI leans on that by showing every card for
// approval before the deck is saved, rather than pretending the output is
// finished work.
//
// ---- Why font size and not just text ----
//
// pdf.js hands back the font size of every run of text, which is a far stronger
// heading signal than anything in the characters themselves. "Photosynthesis"
// on its own line is ambiguous; "Photosynthesis" set 4pt larger than the body
// around it is a heading, and the paragraph beneath it is its definition. Doing
// this on text alone would mean guessing from capitalisation and line length,
// which misfires on every short sentence in the document.

/* ============================== tuning ============================== */

/** A term shorter than this is noise — an initial, a stray letter, a bullet. */
export const MIN_TERM_CHARS = 3;
/** Terms are names of things. Past about eight words it's a sentence instead. */
export const MAX_TERM_WORDS = 9;
/** Below this a "definition" is a fragment, not an answer worth being tested on. */
export const MIN_DEF_CHARS = 25;
/** Backs longer than this get trimmed at a sentence boundary — see `trimDef`. */
export const MAX_DEF_CHARS = 320;
/** A heading must beat the body text size by this ratio to count as one. */
export const HEADING_RATIO = 1.12;
/** Running heads are detected by appearing on at least this many pages. */
export const RUNNING_HEAD_PAGES = 3;

/* ========================== small utilities ========================== */

const words = (s) => s.trim().split(/\s+/).filter(Boolean);

/** Comparison key for deduping: case, punctuation and spacing all ignored. */
export const normalise = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Join lines into a paragraph, healing words the PDF broke across a line end.
 *
 * A line ending "photo-" followed by "synthesis" is one word that hit the right
 * margin, so the hyphen goes and the halves fuse. A line ending "well-" followed
 * by "known" is the same shape but a genuine hyphenated compound, and there is
 * no reliable way to tell them apart without a dictionary. Fusing is the right
 * default because soft line-break hyphens vastly outnumber hard ones in running
 * text, and "wellknown" on the back of a card is a cosmetic bug where
 * "photo synthesis" is a wrong answer.
 */
export function joinLines(texts) {
  let out = '';
  for (const raw of texts) {
    const t = raw.trim();
    if (!t) continue;
    if (!out) { out = t; continue; }
    if (/[a-z]-$/.test(out)) out = out.slice(0, -1) + t;
    else out += ' ' + t;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Trim a definition to length without cutting mid-sentence.
 *
 * Prefers the last sentence end inside the budget; falls back to a word
 * boundary with an ellipsis when a single sentence runs longer than the whole
 * budget, which happens in legal and academic text.
 */
export function trimDef(text, max = MAX_DEF_CHARS) {
  const t = text.trim();
  if (t.length <= max) return t;

  const window = t.slice(0, max + 1);
  const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  if (stop > max * 0.4) return t.slice(0, stop + 1).trim();

  const space = window.lastIndexOf(' ');
  return t.slice(0, space > 0 ? space : max).trim() + '…';
}

/**
 * Does this look like the *name* of something, rather than a sentence about it?
 *
 * Rejecting trailing sentence punctuation is the load-bearing check: "The
 * mitochondrion is the powerhouse of the cell." is a claim, "Mitochondrion" is
 * a term, and the full stop is what separates them.
 */
export function looksLikeTerm(s) {
  const t = s.trim();
  if (t.length < MIN_TERM_CHARS) return false;
  if (words(t).length > MAX_TERM_WORDS) return false;
  if (/[.!?]$/.test(t)) return false;
  if (!/[a-z]/i.test(t)) return false;             // pure numbers, symbols, rules
  if (/^(figure|fig|table|chapter|section|page|appendix|note)\b/i.test(t)) return false;
  return true;
}

/** Strip list markers, trailing dot leaders and page numbers from a heading. */
const cleanTerm = (s) =>
  s.replace(/^[\s•·▪◦‣*–—-]+/, '')
    .replace(/^\(?\d{1,2}[.)]\s+/, '')            // "3. " / "(3) " list numbering
    .replace(/^\d+(\.\d+)*\s+/, '')               // "2.4.1 " section numbering
    .replace(/\s*\.{3,}\s*\d+$/, '')              // contents-page dot leaders
    .replace(/\s+/g, ' ')
    .trim();

/* ====================== stage 1: clean the lines ====================== */

/**
 * Drop the furniture that repeats on every page.
 *
 * Chapter titles in the running head, page numbers in the footer and copyright
 * lines are all text pdf.js reports exactly like body copy, and all of them
 * would otherwise become headings with the first paragraph of the page as their
 * "definition". Anything whose exact text lands on several different pages is
 * furniture by definition — real content doesn't repeat verbatim page after
 * page. Counting *pages* rather than occurrences matters: a glossary can list
 * the same short term twice on one page without being a running head.
 */
export function stripRunningHeads(lines) {
  const pages = new Map();  // normalised text -> Set of page numbers
  for (const l of lines) {
    const key = normalise(l.text);
    if (!key) continue;
    if (!pages.has(key)) pages.set(key, new Set());
    pages.get(key).add(l.page);
  }

  return lines.filter((l) => {
    const t = l.text.trim();
    if (!t) return false;
    if (/^\d{1,4}$/.test(t)) return false;                    // bare page number
    if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(t)) return false;
    const seen = pages.get(normalise(t));
    return !seen || seen.size < RUNNING_HEAD_PAGES;
  });
}

/**
 * The size of ordinary body text, as the most common size in the document.
 *
 * Weighted by characters, not by line count: a chapter opener can carry a dozen
 * short lines of large display type, which by line count could outvote the body
 * text on that page and invert every heading test that follows.
 */
export function bodySize(lines) {
  const weight = new Map();
  for (const l of lines) {
    const size = Math.round(l.size || 0);
    if (!size) continue;
    weight.set(size, (weight.get(size) || 0) + l.text.trim().length);
  }
  let best = 0, bestWeight = -1;
  for (const [size, w] of weight) {
    if (w > bestWeight) { best = size; bestWeight = w; }
  }
  return best || 12;
}

/* ====================== stage 2: lines into blocks ====================== */

/**
 * Fold lines into `{ kind: 'heading' | 'body', text, page }` blocks.
 *
 * Consecutive body lines merge into one paragraph so that sentence patterns can
 * match across a line break — PDFs break lines at the margin, not at meaning,
 * and a definition split over two lines is the common case, not the exception.
 */
export function toBlocks(lines, body = bodySize(lines)) {
  const blocks = [];
  let buffer = [];
  let bufferPage = 1;

  const flush = () => {
    if (!buffer.length) return;
    const text = joinLines(buffer);
    if (text) blocks.push({ kind: 'body', text, page: bufferPage });
    buffer = [];
  };

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) { flush(); continue; }

    // Bold counts as a heading only on a short line. Bold runs inside a
    // paragraph — emphasised terms, defined words — are common, and treating
    // each one as a section heading would shred every paragraph containing one.
    const large = (line.size || 0) >= body * HEADING_RATIO;
    const boldTitle = line.bold && words(text).length <= MAX_TERM_WORDS;

    if ((large || boldTitle) && looksLikeTerm(cleanTerm(text))) {
      flush();
      blocks.push({ kind: 'heading', text: cleanTerm(text), page: line.page });
    } else {
      // Two ways a body line starts a new block rather than continuing one:
      // the extractor measured a paragraph gap above it (see markParagraphs in
      // pdf.js), or it announces itself as a glossary entry. Either way,
      // merging it into the paragraph above would bury it — a heading upstream
      // would then claim the whole run as its single definition.
      if (buffer.length && (line.para || startsEntry(text))) flush();
      if (!buffer.length) bufferPage = line.page;
      buffer.push(text);
    }
  }
  flush();
  return blocks;
}

/* ==================== stage 3: blocks into cards ==================== */

/**
 * Sentence patterns that name their own subject.
 *
 * Each returns [term, definition]. Ordered most specific first: "X is defined
 * as Y" must win before the looser "X is Y", or the term would come back as
 * "X is defined" with the wrong half of the sentence attached.
 */
const SENTENCE_PATTERNS = [
  /^(?:an?\s+|the\s+)?(.{2,70}?)\s+(?:is|are)\s+defined\s+as\s+(.+)$/i,
  /^(?:an?\s+|the\s+)?(.{2,70}?)\s+(?:refers?\s+to|means|denotes|describes)\s+(.+)$/i,
  /^(?:an?\s+|the\s+)?(.{2,70}?)\s+(?:is|are)\s+(?:an?|the)\s+(.+)$/i,
  /^(?:an?\s+|the\s+)?(.{2,70}?)\s+(?:is|are)\s+known\s+as\s+(.+)$/i,
];

/** "Term — definition" / "Term: definition" on a single line. */
const SEPARATOR = /^\s*(.{2,70}?)\s*[:—–]\s+(.{10,})$/;

/**
 * Openers that mean a colon is punctuation rather than a glossary entry.
 *
 * "There are three types: diffusion, osmosis and active transport" has exactly
 * the shape of a definition and is nothing of the kind. What separates it from
 * "Active transport: the movement of..." is that its left side is a clause with
 * a subject, and clauses in English body text overwhelmingly open with one of
 * these words. "The" and "A" are deliberately absent — "The Krebs cycle:" is a
 * perfectly ordinary way to label an entry.
 */
const CLAUSE_OPENERS =
  /^(there|this|these|those|it|they|we|you|in|on|at|for|when|if|but|however|some|each|every|all|most|many|such|note|example|following|includes?)\b/i;

/**
 * Is this line a glossary-style entry — "Term: definition"?
 *
 * Answers two questions with one rule. It decides where to break a run of body
 * lines, because PDFs give no reliable paragraph marker beyond spacing, and it
 * decides whether a separator line earns a card. Requiring a capital and
 * rejecting clause openers is what keeps ordinary prose containing a colon from
 * being both chopped into fragments and mined for a card about nothing.
 */
export function startsEntry(text) {
  const m = text.match(SEPARATOR);
  if (!m) return false;
  const term = cleanTerm(m[1]);
  return looksLikeTerm(term) && /^[A-Z0-9]/.test(term) && !CLAUSE_OPENERS.test(term);
}

function cardFrom(term, def, page, kind) {
  const front = cleanTerm(term);
  const back = trimDef(def.trim().replace(/^[\s:—–-]+/, ''));
  if (!looksLikeTerm(front)) return null;
  if (back.length < MIN_DEF_CHARS) return null;

  // A back that opens by restating the front only teaches whatever it adds
  // *after* the restatement — so that remainder, not the whole back, is what
  // has to clear the length bar. This is what rejects contents-page entries
  // ("Osmosis" → "Osmosis and diffusion") while keeping a real definition that
  // happens to begin with the term it defines.
  const nf = normalise(front);
  const nb = normalise(back);
  if (nb.startsWith(nf) && nb.slice(nf.length).trim().length < MIN_DEF_CHARS) return null;

  return { front, back, page, kind };
}

/**
 * Pull cards out of one paragraph.
 *
 * Only the first sentence is tried for the sentence patterns. A definition
 * announces itself at the start of a paragraph; matching mid-paragraph picks up
 * every incidental "the result is a smaller value" clause in the document and
 * turns it into a card nobody wants.
 */
function cardsFromParagraph(block) {
  const out = [];

  // Gated on `startsEntry` rather than the bare separator match: a colon in
  // running prose ("There are several factors affecting X: a, b and c") has the
  // exact shape of a glossary entry, and the same test that stops it splitting
  // a paragraph has to stop it becoming a card.
  const sepMatch = block.text.match(SEPARATOR);
  if (sepMatch && startsEntry(block.text)) {
    const card = cardFrom(sepMatch[1], sepMatch[2], block.page, 'definition');
    if (card) { out.push(card); return out; }
  }

  const firstSentence = (block.text.match(/^.*?[.!?](?:\s|$)/) || [block.text])[0];
  for (const re of SENTENCE_PATTERNS) {
    const m = firstSentence.match(re);
    if (!m) continue;
    // The rest of the paragraph rides along as context, since the sentence the
    // term came from is usually only half the answer.
    const rest = block.text.slice(firstSentence.length).trim();
    const def = rest ? m[2].trim().replace(/[.\s]+$/, '') + '. ' + rest : m[2];
    const card = cardFrom(m[1], def, block.page, 'definition');
    if (card) { out.push(card); break; }
  }
  return out;
}

/**
 * Headings that organise a document rather than name something in it.
 *
 * "Key terms" is a real heading — it structures the page and should still break
 * the blocks around it — but it is not a thing you can be tested on, and a card
 * asking "Key terms?" is nonsense. Worse, letting it match would eat the first
 * genuine entry underneath it as its own definition, so the good card is lost
 * to make a bad one.
 */
const GENERIC_HEADINGS =
  /^(key\s+terms?|terms?|glossary|summary|overview|introduction|contents|conclusion|objectives?|aims?|notes?|examples?|exercises?|questions?|answers?|references?|further\s+reading|bibliography|revision|recap)$/i;

/**
 * Build the deck.
 *
 * Heading-plus-paragraph beats sentence patterns for the same paragraph: if a
 * paragraph sits under "Osmosis", the question worth asking is "Osmosis?", not
 * whatever term the first sentence happens to name.
 */
export function cardsFromBlocks(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind !== 'heading') {
      out.push(...cardsFromParagraph(block));
      continue;
    }
    // A structural heading makes no card and, crucially, does not consume the
    // block beneath it — that block gets mined on its own next time round.
    if (GENERIC_HEADINGS.test(block.text)) continue;

    const next = blocks[i + 1];
    if (!next || next.kind !== 'body') continue;   // heading with nothing under it
    const card = cardFrom(block.text, next.text, block.page, 'heading');
    if (card) { out.push(card); i++; }             // paragraph is spoken for
  }
  return out;
}

/* ============================== pipeline ============================== */

let nextId = 0;
const cardId = () => 'c' + (Date.now().toString(36)) + (nextId++).toString(36);

/**
 * Lines in, deck out.
 *
 * @param {Array<{text,size,bold,page}>} lines
 * @param {{max?: number}} opts
 * @returns {Array<{id,front,back,page,kind}>}
 */
export function extractCards(lines, { max = 300 } = {}) {
  const clean = stripRunningHeads(lines);
  const blocks = toBlocks(clean);
  const cards = cardsFromBlocks(blocks);

  // Keep the first of any repeated term. A term defined twice is usually a
  // contents entry followed by the real section, and the real one is longer —
  // but ordering by document position is more predictable for the reader than
  // silently preferring whichever copy is wordier.
  const seen = new Set();
  const unique = [];
  for (const card of cards) {
    const key = normalise(card.front);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...card, id: cardId() });
    if (unique.length >= max) break;
  }
  return unique;
}
