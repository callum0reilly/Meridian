// Card generation, via the OpenAI API.
//
// This is the part that replaced the regexes. The old extractor read document
// shape and could only ever produce cards for material already written as
// term-then-explanation; anything discursive — a history chapter, a case study,
// an argument — went in and nothing came out. A model reads the material, so the
// contract changes from "good cards from structured documents, few or none from
// unstructured ones" to just "good cards".
//
// ---- The key lives in the user's browser ----
//
// Meridian is a static site. There is no server here to hold a key on the
// user's behalf, and a key shipped inside the JS would be a key anyone can read
// out of devtools and spend. So the user brings their own, it goes in
// localStorage, and it's sent from their browser straight to OpenAI.
//
// The rule this design respects is about *whose* key travels: sending your own
// key from your own browser to a service you hold the account with is fine, and
// it's what keeps this feature from requiring a backend, a deploy target and a
// bill. Sending *your* key from *your users'* browsers is the mistake, and it is
// the one this avoids.
//
// The tradeoff is honest and worth stating in the UI: this is a feature for
// people who have an API key, not something you can hand to a classmate.
//
// ---- Why the document is chunked ----
//
// Not for the context window — the model takes hundreds of thousands of tokens
// and a textbook chapter is a few thousand. It's chunked because output is the
// real limit: a 60-page chapter's worth of cards is far more than one response
// can hold, and a request that hits its token ceiling comes back with the JSON
// cut off mid-card. Chunking also means progress can move while it works, and
// one failed chunk costs one chunk rather than the whole document.

import { normalise } from './doctext.js';

const API_URL = 'https://api.openai.com/v1/responses';

const KEY_STORE = 'meridian.study.openai.key.v1';
const MODEL_STORE = 'meridian.study.openai.model.v1';

/** Storage this feature used when it ran on Anthropic. See forgetLegacyKey(). */
const LEGACY_STORES = ['meridian.study.anthropic.key.v1', 'meridian.study.anthropic.model.v1'];

/**
 * Models offered in settings.
 *
 * The full model is the default because it's the user's money and their
 * revision, and quietly spending less of the former to get worse cards isn't a
 * call this code should make on their behalf. The prices are here so the UI can
 * show what a document cost, and they are the one thing in this file that goes
 * stale on someone else's schedule — check them against OpenAI's pricing page if
 * the figures shown start to look wrong.
 */
export const MODELS = [
  { id: 'gpt-5', label: 'GPT-5 — best cards', inPer1M: 1.25, outPer1M: 10 },
  { id: 'gpt-5-mini', label: 'GPT-5 mini — balanced', inPer1M: 0.25, outPer1M: 2 },
  { id: 'gpt-5-nano', label: 'GPT-5 nano — cheapest', inPer1M: 0.05, outPer1M: 0.4 },
];

export const DEFAULT_MODEL = MODELS[0].id;

/**
 * Characters of Markdown per request.
 *
 * Sized so the cards for one chunk comfortably fit inside MAX_TOKENS. Roughly
 * 6k input tokens in, at most ~8k of card text out — the asymmetry is
 * deliberate, because dense glossary pages produce far more card text than the
 * prose they came from.
 */
const CHUNK_CHARS = 24000;

/**
 * Output ceiling per request.
 *
 * Higher than the ~8k of cards a chunk can produce, because on a reasoning model
 * this ceiling covers the reasoning tokens too. Sized at 8k for the answer and
 * the same again for the thinking that precedes it: set it to the size of the
 * answer alone and a chunk that thinks hard can run out of room before it has
 * written a single card.
 */
const MAX_TOKENS = 16000;

/** Chunks in flight at once. Enough to be quick, low enough to stay under rate limits. */
const CONCURRENCY = 2;

/** Give up on a chunk after this many attempts, counting the first. */
const MAX_ATTEMPTS = 3;

/* ============================ key storage ============================ */

/**
 * Read/write the API key and model choice.
 *
 * Wrapped in try/catch for the same reason store.js is: private-mode browsers
 * throw on localStorage access, and a study tab that throws during init is a
 * dead tab. A missing key is a state the UI already handles — it's what a new
 * user has — so falling back to it is safe.
 */
export function loadKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}

export function saveKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
    return true;
  } catch { return false; }
}

export function loadModel() {
  try {
    const saved = localStorage.getItem(MODEL_STORE);
    return MODELS.some((m) => m.id === saved) ? saved : DEFAULT_MODEL;
  } catch { return DEFAULT_MODEL; }
}

export function saveModel(id) {
  try { localStorage.setItem(MODEL_STORE, id); return true; } catch { return false; }
}

/**
 * Drop the Anthropic key this feature used to store.
 *
 * Nothing reads it any more and no screen can show or clear it, so leaving it
 * behind means a live credential sitting in localStorage that its owner has no
 * way to reach. Called once when the library loads. It only ever deletes keys
 * this app put there itself.
 */
export function forgetLegacyKey() {
  try { for (const k of LEGACY_STORES) localStorage.removeItem(k); } catch { /* nothing to do */ }
}

/**
 * Shape check for a key, so an obvious typo is caught before it costs a request.
 *
 * Deliberately loose — it checks the prefix and a plausible length, not a full
 * format, because the exact tail of the key format is OpenAI's to change and a
 * validator that's stricter than the server rejects valid keys the day that
 * happens. Project keys (sk-proj-…) and older account keys both pass. The real
 * check is the first 401.
 *
 * The one exception is sk-ant-, which is excluded on purpose: this feature used
 * to run on Anthropic, so pasting the old key back in is the single most likely
 * wrong answer here, and it's one this check can name instead of charging a
 * round trip to discover.
 */
export function looksLikeKey(key) {
  return /^sk-(?!ant-)\S{20,}$/.test((key || '').trim());
}

/* ============================== chunking ============================== */

/**
 * Split Markdown into request-sized pieces, preferring to break at a heading.
 *
 * Breaking mid-section is what this is avoiding. A heading and the paragraph
 * beneath it are a term and its definition; split between them and the chunk
 * holding the heading has nothing to define it while the chunk holding the
 * definition has nothing to call it, so both sides produce a worse card than
 * either would have produced whole. Page markers are the second-choice boundary
 * and a blank line the third.
 *
 * @param {string} markdown
 * @param {number} limit
 * @returns {string[]}
 */
export function chunk(markdown, limit = CHUNK_CHARS) {
  const text = markdown.trim();
  if (!text) return [];
  if (text.length <= limit) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    if (text.length - start <= limit) {
      chunks.push(text.slice(start).trim());
      break;
    }

    const window = text.slice(start, start + limit);

    // Only accept a boundary in the back half of the window. A heading 200
    // characters in would otherwise produce a near-empty chunk and push the
    // whole document through in tiny, expensive pieces.
    const floor = Math.floor(limit * 0.5);
    let cut = -1;
    for (const marker of ['\n\n## ', '\n\n[p.', '\n\n']) {
      const at = window.lastIndexOf(marker);
      if (at > floor) { cut = at; break; }
    }
    if (cut < 0) cut = limit;   // one enormous paragraph; split it bluntly

    const piece = text.slice(start, start + cut).trim();
    if (piece) chunks.push(piece);
    start += cut;
  }

  return chunks.filter(Boolean);
}

/* ============================== prompting ============================== */

const SYSTEM = `You write flashcards for a student revising from their own course material.

You will be given an extract from a document, converted to Markdown. Lines starting with ## are headings detected from the document's typography. Markers like [p.12] give the page number of the text that follows them.

Write cards that test understanding of the material, following these rules:

- One idea per card. If a paragraph contains three facts worth knowing, that is three cards, not one card listing them.
- The front is a question or a term. The back is the answer, in your own words, complete enough to be worth reading but no longer than about two sentences.
- The back must be answerable from the front alone. "What are the three types?" is unanswerable out of context; "What are the three types of passive transport?" is a card.
- Never write a card whose answer is not in the extract. If the material does not say why something happens, do not write a "why" card about it.
- Skip the document's own furniture: title pages, contents, acknowledgements, references, figure captions that only label, and exercises that expect the reader to do work rather than know something.
- Set page to the number from the nearest [p.N] marker above the material the card came from.
- If a passage is narrative, procedural or argumentative rather than definitional, still write cards for it: the sequence of a process, the reason behind a decision, the evidence for a claim.
- If an extract genuinely contains nothing worth revising, return an empty list rather than padding it.

Prefer fewer, better cards. A student who gets every card right should actually know the material.`;

/**
 * Response schema. Constrained so a malformed deck is impossible by construction.
 *
 * Shaped to satisfy strict mode, which is what makes that guarantee hold: every
 * object lists all of its properties as required and closes itself to extras.
 */
const SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          front: { type: 'string', description: 'The question or term. One line.' },
          back: { type: 'string', description: 'The answer. At most about two sentences.' },
          page: { type: 'integer', description: 'Page number from the nearest [p.N] marker.' },
        },
        required: ['front', 'back', 'page'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
};

/* ============================ the request ============================ */

/** An error the UI should show verbatim, rather than a stack trace. */
export class OpenAIError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.name = 'OpenAIError';
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * Map an HTTP failure to something a student can act on.
 *
 * The API's own error prose is written for developers reading a server log, so
 * the common cases get replaced. `retryable` drives the backoff loop: it marks
 * the failures that are about *this moment* — a rate limit, an overloaded
 * server — as opposed to the ones where trying again just fails identically.
 */
function describeFailure(status, body) {
  const detail = body?.error?.message || '';
  switch (status) {
    case 400:
      return new OpenAIError(`The API rejected that request: ${detail}`, { status });
    case 401:
      return new OpenAIError('That API key was rejected. Check it in settings.', { status });
    case 403:
      return new OpenAIError('That API key isn\'t allowed to use this model.', { status });
    case 404:
      return new OpenAIError('That model isn\'t available on your account.', { status });
    case 413:
      return new OpenAIError('That section of the PDF was too large to send.', { status });
    case 429:
      // 429 is also how an exhausted balance arrives, and no amount of backing
      // off will conjure credit. Only the rate limit is worth another attempt,
      // and only one of these two is something the user can act on.
      if (body?.error?.type === 'insufficient_quota') {
        return new OpenAIError('That account has no API credit left.', { status });
      }
      return new OpenAIError('Rate limited by the API.', { retryable: true, status });
    case 503:
      return new OpenAIError('The API is busy.', { retryable: true, status });
    default:
      if (status >= 500) return new OpenAIError('The API had a problem.', { retryable: true, status });
      return new OpenAIError(detail || `The API returned ${status}.`, { status });
  }
}

/**
 * Pull the model's text out of a response.
 *
 * `output` is a list of items rather than a single message: reasoning items come
 * first and carry no text, so this looks for the message and the output_text
 * part inside it rather than indexing a position that moves.
 */
function outputText(data) {
  for (const item of data.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      // A refusal is a successful response carrying a refusal in place of the
      // text, so it has to be caught here rather than by status code. It
      // shouldn't fire on course material, but "shouldn't" and "doesn't" differ
      // and the alternative is a confusing parse failure.
      if (part.type === 'refusal') {
        throw new OpenAIError('The model declined to generate cards for that section.');
      }
      if (part.type === 'output_text') return part.text;
    }
  }
  return '';
}

/**
 * One chunk of Markdown, one request, its cards back.
 *
 * `temperature` is deliberately absent: the reasoning models reject it outright,
 * and the variation it used to buy is not something card generation wants
 * anyway.
 */
async function requestCards(markdown, { apiKey, model, signal }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions: SYSTEM,
      input: [{ role: 'user', content: markdown }],
      max_output_tokens: MAX_TOKENS,
      // Deciding what in a passage is worth being tested on is a judgement call,
      // and the cards are visibly better when the model reasons about it first.
      // Medium effort holds the cost of that judgement down on a task that is,
      // after all, mostly extraction.
      reasoning: { effort: 'medium' },
      text: {
        format: { type: 'json_schema', name: 'cards', strict: true, schema: SCHEMA },
      },
      // Each chunk is independent, so there is no thread to keep — and leaving
      // the user's course material on someone else's server is not a choice this
      // feature should make for them.
      store: false,
    }),
  });

  if (!res.ok) {
    // A failed response may or may not be JSON — an upstream proxy or a network
    // appliance can return HTML — so parsing it must not throw over the top of
    // the real error.
    let body = null;
    try { body = await res.json(); } catch { /* keep the status */ }
    const err = describeFailure(res.status, body);
    if (err.retryable) {
      const after = Number(res.headers.get('retry-after'));
      if (Number.isFinite(after) && after > 0) err.retryAfterMs = after * 1000;
    }
    throw err;
  }

  const data = await res.json();

  // Structured output makes malformed JSON impossible but not *truncated* JSON:
  // hitting the ceiling cuts the response off and the parse below fails.
  if (data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens') {
    throw new OpenAIError('That section produced more cards than one response could hold.');
  }

  const text = outputText(data);
  if (!text) return { cards: [], usage: data.usage };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpenAIError('The API returned a response this app could not read.');
  }

  return { cards: Array.isArray(parsed.cards) ? parsed.cards : [], usage: data.usage };
}

/** Sleep that rejects rather than resolving if the import is cancelled. */
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
});

/** One chunk, with backoff on the failures that are worth retrying. */
async function requestWithRetry(markdown, opts) {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await requestCards(markdown, opts);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (!(err instanceof OpenAIError) || !err.retryable || attempt === MAX_ATTEMPTS) throw err;
      last = err;
      // Honour the server's own retry-after when it sends one; otherwise back
      // off exponentially from a second.
      await wait(err.retryAfterMs ?? 1000 * 2 ** (attempt - 1), opts.signal);
    }
  }
  throw last;
}

/* ============================ the pipeline ============================ */

const cardId = () => 'c' + Math.random().toString(36).slice(2, 10);

/** Cheap, deterministic id for spotting the same card twice. */
const cardKey = (c) => normalise(c.front);

/**
 * Discard anything malformed and clamp what's left.
 *
 * Structured output guarantees the *types*, not the *values* — nothing stops a
 * blank front or a page number the document doesn't have. Everything here is
 * cheap insurance against one odd card poisoning a deck the user then has to
 * find and delete by hand.
 */
function cleanCard(raw, pages) {
  const front = String(raw.front ?? '').trim();
  const back = String(raw.back ?? '').trim();
  if (!front || !back) return null;
  if (front.length > 300 || back.length > 1000) return null;

  const page = Number.isFinite(raw.page) ? Math.min(Math.max(1, Math.round(raw.page)), pages) : 1;
  return { id: cardId(), front, back, page };
}

/**
 * Generate a deck from a document's Markdown.
 *
 * Chunks run with limited concurrency and a failure in one does not abandon the
 * rest — a 40-page chapter where page 31 tripped a rate limit should still
 * produce 39 pages of cards, with the shortfall reported. Only a run where
 * *every* chunk failed is treated as a failed import, because that means
 * something systematic (a bad key, no network) rather than bad luck.
 *
 * @param {string} markdown
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {number} opts.pages       page count, for clamping card page numbers
 * @param {AbortSignal} [opts.signal]
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<{cards:Array, usage:object, failed:number, total:number}>}
 */
export async function generateCards(markdown, { apiKey, model, pages = 1, signal, onProgress } = {}) {
  if (!apiKey) throw new OpenAIError('No API key set.');

  const pieces = chunk(markdown);
  if (!pieces.length) return { cards: [], usage: emptyUsage(), failed: 0, total: 0 };

  const results = new Array(pieces.length).fill(null);
  const usage = emptyUsage();
  let done = 0;
  let firstError = null;

  onProgress?.(0, pieces.length);

  // A shared cursor rather than a fixed split, so a slow chunk doesn't leave one
  // worker idle while another still has half the document to get through.
  let next = 0;
  async function worker() {
    while (next < pieces.length) {
      const i = next++;
      if (signal?.aborted) return;
      try {
        const out = await requestWithRetry(pieces[i], { apiKey, model, signal });
        results[i] = out.cards;
        addUsage(usage, out.usage);
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) return;
        console.warn(`[study] chunk ${i + 1}/${pieces.length} failed`, err);
        firstError ??= err;
        results[i] = [];
      }
      onProgress?.(++done, pieces.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pieces.length) }, worker));
  if (signal?.aborted) throw new Error('cancelled');

  const failed = results.filter((r) => r !== null && !r.length).length;
  if (results.every((r) => !r?.length) && firstError) throw firstError;

  // Dedupe across chunks. Overlapping material is normal — a term introduced in
  // one section and recapped in another — and two identical cards in a deck is
  // one card you grade twice and learn once. First occurrence wins, so cards
  // stay in document order.
  const seen = new Set();
  const cards = [];
  for (const list of results) {
    for (const raw of list || []) {
      const card = cleanCard(raw, pages);
      if (!card) continue;
      const key = cardKey(card);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cards.push(card);
    }
  }

  return { cards, usage, failed, total: pieces.length };
}

/* ============================== costing ============================== */

const emptyUsage = () => ({ input_tokens: 0, output_tokens: 0 });

function addUsage(total, usage) {
  if (!usage) return;
  total.input_tokens += usage.input_tokens || 0;
  // output_tokens already counts the reasoning tokens, which bill at the output
  // rate — so what this adds up is the whole bill, not the visible half of it.
  total.output_tokens += usage.output_tokens || 0;
}

/**
 * What a run cost, in dollars.
 *
 * Shown after an import rather than estimated before one. An estimate would have
 * to guess the output length, which is the larger and more variable half of the
 * bill, and a number that's wrong by 3x is worse than no number — this way the
 * user learns the real cost of their own documents after one or two runs.
 */
export function costOf(usage, modelId) {
  const model = MODELS.find((m) => m.id === modelId) || MODELS[0];
  const dollars =
    (usage.input_tokens / 1e6) * model.inPer1M +
    (usage.output_tokens / 1e6) * model.outPer1M;
  return dollars;
}

/** Format a cost for display, with enough precision to be meaningful when tiny. */
export function formatCost(dollars) {
  if (dollars < 0.01) return 'under 1¢';
  if (dollars < 1) return `${Math.round(dollars * 100)}¢`;
  return `$${dollars.toFixed(2)}`;
}
