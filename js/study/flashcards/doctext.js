// Turning a PDF's line array into clean Markdown for the model to read.
//
// This is what's left of the old `cards.js` after the card-shaping regexes came
// out. The regexes went because a model reads meaning and they only ever read
// shape — but the *structural* half of that file was never guessing at meaning,
// it was reading real typographic signal out of the PDF, and no model can
// recover that signal once it's been flattened into a wall of text.
//
// ---- Why not just send the raw text ----
//
// pdf.js gives back positioned runs. Concatenating them yields a document with
// every heading, page number and running footer inline and indistinguishable
// from body copy, paragraphs broken at the right margin rather than at meaning,
// and words split across line ends. A model handed that spends its attention
// reconstructing the document instead of understanding it, and it pays for the
// furniture by the token on every page.
//
// So the split is: this module reads *layout* — font size marks a heading, a
// vertical gap marks a paragraph, text repeating across pages is furniture —
// and the model reads *meaning*. Each does the half it can actually do.
//
// ---- What this buys, concretely ----
//
// Marking headings as `## Heading` is the highest-value part. A heading and the
// paragraph beneath it is a term and its definition, and that relationship is
// pure typography: "Photosynthesis" set 4pt larger than the body around it is a
// heading, and set at body size it's a word in a sentence. Handing the model
// `## Photosynthesis` states the relationship outright rather than asking it to
// infer one that the flattening already destroyed.
//
// Stripping running heads and page numbers typically removes 5–10% of the
// characters in a textbook chapter, which is a straight token saving on every
// request, and removes the most common source of junk cards in the old
// pipeline — a footer becoming a "term" with the page's first paragraph as its
// "definition".

/* ============================== tuning ============================== */

/** A heading candidate shorter than this is noise — an initial, a bullet. */
export const MIN_TERM_CHARS = 3;
/** Headings are names of things. Past about eight words it's a sentence. */
export const MAX_TERM_WORDS = 9;
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
 * text, and a model reading "wellknown" recovers the intent where one reading
 * "photo synthesis" has been handed two words that aren't in the document.
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
 * Does this look like the *name* of something, rather than a sentence about it?
 *
 * Rejecting trailing sentence punctuation is the load-bearing check: "The
 * mitochondrion is the powerhouse of the cell." is a claim, "Mitochondrion" is
 * a term, and the full stop is what separates them. A large-type line that
 * fails this is set large for some other reason — a pull quote, a chapter
 * epigraph — and marking it as a heading would nest the real content under it.
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
export const cleanTerm = (s) =>
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
 * lines are all text pdf.js reports exactly like body copy. Anything whose exact
 * text lands on several different pages is furniture by definition — real
 * content doesn't repeat verbatim page after page. Counting *pages* rather than
 * occurrences matters: a glossary can list the same short term twice on one page
 * without being a running head.
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
 * Consecutive body lines merge into one paragraph, because PDFs break lines at
 * the margin and not at meaning — a definition split over two lines is the
 * common case, not the exception.
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
      // A body line starts a new block when the extractor measured a paragraph
      // gap above it (see markParagraphs in pdf.js). Merging across that gap
      // would run two sections together and hide the boundary the layout was
      // drawing.
      if (buffer.length && line.para) flush();
      if (!buffer.length) bufferPage = line.page;
      buffer.push(text);
    }
  }
  flush();
  return blocks;
}

/* ==================== stage 3: blocks into Markdown ==================== */

/**
 * Render blocks as Markdown with page markers.
 *
 * Page markers are the reason cards can cite a page at all. The model is asked
 * to echo back the marker nearest the material it used, which is the only way a
 * page number survives a round trip through a language model — asking it to
 * count pages itself would produce confident fiction. They cost about four
 * tokens each and they're what makes a wrong card findable in the source.
 *
 * Headings become `##` regardless of their level in the original. Reconstructing
 * a real heading hierarchy from font sizes is possible but unreliable on the
 * documents people actually revise from (slide decks in particular have no
 * consistent hierarchy at all), and the model needs to know *that* a line is a
 * heading far more than it needs to know how deeply nested it is.
 */
export function blocksToMarkdown(blocks) {
  const out = [];
  let lastPage = null;

  for (const block of blocks) {
    if (block.page !== lastPage) {
      out.push(`[p.${block.page}]`);
      lastPage = block.page;
    }
    out.push(block.kind === 'heading' ? `## ${block.text}` : block.text);
  }
  return out.join('\n\n');
}

/**
 * The whole pipeline: pdf.js lines in, Markdown out.
 *
 * @param {Array<{text:string,size:number,bold:boolean,para:boolean,page:number}>} lines
 * @returns {string}
 */
export function linesToMarkdown(lines) {
  const clean = stripRunningHeads(lines);
  return blocksToMarkdown(toBlocks(clean));
}
