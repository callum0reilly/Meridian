// Flashcards — the study tab's first tool. Drop a PDF in, approve the cards it
// found, then review them on a spaced repetition schedule.
//
// ---- Four screens ----
//   library  a list of saved decks, and the drop zone for a new PDF
//   review   every generated card, each one keep-or-discard, before saving
//   study    one card at a time, flip, grade
//   done     what the session did, and when the next one is due
//
// ---- Why the approve screen exists ----
//
// The cards are written by a model (see openai.js), which is a large step up
// from the regexes it replaced but is still working from an extract of a PDF
// and can still produce a card that's redundant, or subtly wrong, or tests
// something the user already knows cold. Hiding that behind a "Generated 84
// cards!" banner would mean discovering it one wrong card at a time,
// mid-revision, which is exactly when you least want to be editing.
//
// The screen also exists because generation now costs money. Cards are shown
// before they're saved so the spend is visible against something concrete
// rather than appearing on a bill weeks later.
//
// ---- Solo, but no longer offline ----
//
// No room codes, no peers, nothing to share — the games are the social half of
// Meridian and this is the half you use alone at midnight. It is no longer
// *offline*, though: importing a PDF sends its text to OpenAI, and the drop
// zone says so. Studying an existing deck still needs no network at all, which
// is the half that matters on a train.

import { extractLines } from './pdf.js';
import { linesToMarkdown } from './doctext.js';
import {
  generateCards, OpenAIError, MODELS,
  loadKey, saveKey, looksLikeKey, loadModel, saveModel, forgetLegacyKey,
  costOf, formatCost,
} from './openai.js';
import { review as gradeCard, dueQueue, deckStats, describeNext, GRADES } from './srs.js';
import { loadDecks, saveDecks, makeDeck } from './store.js';
import { downloadDeck } from './export.js';

const MAX_MB = 50;

const LIBRARY_HTML = `
  <div class="study">
    <div class="study-head">
      <h2>Flashcards</h2>
      <div class="lead">Turn a PDF into a deck, then revise it on a spaced schedule.</div>
    </div>

    <label class="drop" tabindex="0">
      <input type="file" accept="application/pdf,.pdf" hidden>
      <div class="drop-icon" aria-hidden="true">＋</div>
      <div class="drop-main">Drop a PDF here, or click to choose one</div>
      <div class="drop-sub">Its text is sent to OpenAI to write the cards. Decks stay in this browser.</div>
    </label>
    <div class="err droperr"></div>

    <details class="settings">
      <summary>API key<span class="keystate"></span></summary>
      <div class="settingsbody">
        <p class="settingsnote">
          Cards are written by GPT-5, which needs your own OpenAI API key. It's stored in
          this browser only and sent straight to OpenAI — Meridian has no server and never
          sees it. Usage is billed to your account, typically a few pence per document.
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">Get a key</a>.
        </p>
        <div class="keyrow">
          <input class="keyinput" type="password" spellcheck="false" autocomplete="off"
                 placeholder="sk-…" aria-label="OpenAI API key">
          <button class="ghost keysave">Save</button>
        </div>
        <div class="keyerr err"></div>
        <label class="modelrow">
          <span>Model</span>
          <select class="modelpick" aria-label="Model"></select>
        </label>
      </div>
    </details>

    <div class="decks"></div>
  </div>
`;

const BUSY_HTML = `
  <div class="study centred">
    <div class="busy">
      <div class="spinner" aria-hidden="true"></div>
      <h2 class="busytitle">Reading your PDF…</h2>
      <div class="busysub"></div>
      <div class="bar"><div class="barfill"></div></div>
      <button class="ghost cancel">Cancel</button>
    </div>
  </div>
`;

const REVIEW_HTML = `
  <div class="study">
    <div class="study-head">
      <h2>Check the cards</h2>
      <div class="lead reviewlead"></div>
    </div>
    <div class="reviewbar">
      <input class="decktitle" maxlength="60" placeholder="Deck name" aria-label="Deck name">
      <div class="spacer"></div>
      <span class="keptcount"></span>
      <button class="ghost none">Discard all</button>
      <button class="ghost all">Keep all</button>
      <button class="primary savedeck">Save deck</button>
    </div>
    <div class="err saveerr"></div>
    <div class="cardlist"></div>
  </div>
`;

const STUDY_HTML = `
  <div class="study session">
    <div class="sessionbar">
      <button class="ghost quit">← Library</button>
      <div class="sessiontitle"></div>
      <div class="spacer"></div>
      <div class="counts"></div>
    </div>
    <div class="bar thin"><div class="barfill"></div></div>

    <div class="cardstage">
      <div class="flashcard" tabindex="0" role="button" aria-live="polite">
        <div class="face front"></div>
        <div class="face back" hidden></div>
        <div class="flip-hint">click, or press space, to flip</div>
      </div>
    </div>

    <div class="grades" hidden></div>
    <div class="cardmeta"></div>
  </div>
`;

const DONE_HTML = `
  <div class="study centred">
    <div class="busy">
      <h2>Session complete</h2>
      <div class="donesub"></div>
      <div class="donerow">
        <button class="primary again">Study again</button>
        <button class="ghost back">Back to library</button>
      </div>
    </div>
  </div>
`;

function init(root, header) {
  // This feature used to run on Anthropic, and a user who used it then still has
  // that key in localStorage with nothing left that can read, show or clear it.
  // Drop it on the way past rather than leaving a live credential stranded.
  forgetLegacyKey();

  let decks = loadDecks();
  let view = 'library';
  let visible = false;

  // --- import in flight ---
  let controller = null;

  // --- approve screen ---
  let draft = null;        // { title, source, cards, keep: Set<id> }

  // --- study session ---
  let session = null;      // { deck, queue, card, flipped, done, again }

  const el = (sel) => root.querySelector('.' + sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  header.innerHTML = '<div class="tag studytag"></div>';
  const tag = header.querySelector('.studytag');

  function persist() {
    const res = saveDecks(decks);
    if (!res.ok) console.warn('[study] ' + res.message);
    return res;
  }

  function updateTag() {
    const now = Date.now();
    const due = decks.reduce((n, d) => n + deckStats(d.cards, now).due, 0);
    tag.textContent = !decks.length ? 'No decks yet'
      : due ? `${due} card${due === 1 ? '' : 's'} due`
      : 'All caught up';
  }

  /* ============================ library ============================ */

  function showLibrary(err) {
    view = 'library';
    session = null;
    draft = null;
    root.innerHTML = LIBRARY_HTML;
    if (err) el('droperr').textContent = err;

    const drop = el('drop');
    const input = drop.querySelector('input');
    input.onchange = () => { if (input.files[0]) startImport(input.files[0]); };

    // The label already opens the picker on click; keyboard users get the same
    // via the tabindex on it, which needs the key handler wired by hand.
    drop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); }
    });

    for (const type of ['dragenter', 'dragover']) {
      drop.addEventListener(type, (ev) => { ev.preventDefault(); drop.classList.add('over'); });
    }
    for (const type of ['dragleave', 'drop']) {
      drop.addEventListener(type, () => drop.classList.remove('over'));
    }
    drop.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const file = ev.dataTransfer?.files?.[0];
      if (file) startImport(file);
    });

    renderSettings();
    renderDecks();
    updateTag();
  }

  /* ============================ settings ============================ */

  /**
   * The key panel.
   *
   * Opens itself when there's no key stored, because without one the drop zone
   * above it does nothing — a collapsed `<details>` would leave a new user
   * dropping a PDF and getting an error with the fix hidden behind a summary
   * they had no reason to click.
   */
  function renderSettings() {
    const box = el('settings');
    const key = loadKey();
    if (!key) box.open = true;

    el('keystate').textContent = key ? 'Saved' : 'Needed';
    el('keystate').className = 'keystate ' + (key ? 'ok' : 'missing');
    el('keyinput').value = key;

    el('modelpick').innerHTML = MODELS
      .map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
    el('modelpick').value = loadModel();
    el('modelpick').onchange = (ev) => saveModel(ev.target.value);

    el('keysave').onclick = () => {
      const value = el('keyinput').value.trim();
      const err = el('keyerr');

      // An empty box is "forget my key", which is the only way to clear it and
      // shouldn't be blocked by the format check below.
      if (value && !looksLikeKey(value)) {
        err.textContent = /^sk-ant-/.test(value)
          ? 'That\'s an Anthropic key. Flashcards use OpenAI now — you\'ll need a key from platform.openai.com.'
          : 'That doesn\'t look like an OpenAI key — they start with sk-.';
        return;
      }
      if (!saveKey(value)) {
        err.textContent = 'This browser refused to store the key (private mode?).';
        return;
      }
      err.textContent = '';
      el('keystate').textContent = value ? 'Saved' : 'Needed';
      el('keystate').className = 'keystate ' + (value ? 'ok' : 'missing');
      el('droperr').textContent = '';
    };
  }

  function renderDecks() {
    const now = Date.now();
    const list = el('decks');
    if (!decks.length) {
      list.innerHTML = '<div class="empty">Your decks will appear here.</div>';
      return;
    }

    list.innerHTML = '<div class="deckshead">Your decks</div>' + decks.map((d) => {
      const s = deckStats(d.cards, now);
      const next = nextDueLabel(d, now);
      return `
        <div class="deck" data-id="${d.id}">
          <div class="deckmain">
            <div class="deckname">${esc(d.title)}</div>
            <div class="decksub">${s.total} cards · ${esc(d.source || 'PDF')}</div>
          </div>
          <div class="pills">
            ${s.new ? `<span class="pill new">${s.new} new</span>` : ''}
            ${s.learning ? `<span class="pill learning">${s.learning} learning</span>` : ''}
            ${s.review ? `<span class="pill review">${s.review} known</span>` : ''}
          </div>
          <div class="deckdue">${s.due ? `<b>${s.due}</b> due` : esc(next)}</div>
          <button class="primary study" ${s.due ? '' : 'disabled'}>Study</button>
          <button class="ghost dl" aria-label="Download ${esc(d.title)}">Download</button>
          <button class="ghost del" aria-label="Delete ${esc(d.title)}">Delete</button>
        </div>`;
    }).join('');

    list.querySelectorAll('.deck').forEach((row) => {
      const deck = decks.find((d) => d.id === row.dataset.id);
      row.querySelector('.study').onclick = () => startSession(deck);
      row.querySelector('.dl').onclick = () => downloadDeck(deck);
      row.querySelector('.del').onclick = () => {
        if (!confirm(`Delete "${deck.title}" and its ${deck.cards.length} cards? ` +
                     'This can\'t be undone — download it first if you want to keep it.')) return;
        decks = decks.filter((d) => d.id !== deck.id);
        persist();
        renderDecks();
        updateTag();
      };
    });
  }

  /** "Next in 3d", or an invitation when the deck has never been studied. */
  function nextDueLabel(deck, now) {
    const upcoming = deck.cards.map((c) => c.srs.due).filter((t) => t > now).sort((a, b) => a - b)[0];
    if (!upcoming) return 'Nothing due';
    const ms = upcoming - now;
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `Next in ${Math.max(1, mins)}m`;
    if (mins < 1440) return `Next in ${Math.round(mins / 60)}h`;
    return `Next in ${Math.round(mins / 1440)}d`;
  }

  /* ============================= import ============================= */

  async function startImport(file) {
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
      el('droperr').textContent = 'That isn\'t a PDF.';
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      el('droperr').textContent = `That PDF is over ${MAX_MB}MB. Try a single chapter instead.`;
      return;
    }

    // Checked here rather than at the point of use so the whole PDF isn't read
    // before the user is told the one thing that was going to stop them.
    const apiKey = loadKey();
    if (!apiKey) {
      el('droperr').textContent = 'Add your OpenAI API key below first — that\'s what writes the cards.';
      el('settings').open = true;
      el('keyinput').focus();
      return;
    }
    const model = loadModel();

    view = 'busy';
    root.innerHTML = BUSY_HTML;
    el('busysub').textContent = file.name;
    controller = new AbortController();
    el('cancel').onclick = () => { controller.abort(); showLibrary(); };

    try {
      const { lines, pages, title } = await extractLines(file, {
        signal: controller.signal,
        onProgress: (done, total) => {
          const pct = Math.round((done / total) * 100);
          el('barfill').style.width = pct + '%';
          el('busysub').textContent = `${file.name} — page ${done} of ${total}`;
        },
      });

      if (controller.signal.aborted) return;

      // A PDF with no text layer is a scan: the pages are images, and there is
      // nothing here to extract. Saying so plainly beats handing back an empty
      // deck and letting the user conclude the feature is broken.
      const chars = lines.reduce((n, l) => n + l.text.length, 0);
      if (chars < 200) {
        showLibrary('That PDF has no selectable text — it\'s probably a scan. This tool can\'t read images.');
        return;
      }

      const markdown = linesToMarkdown(lines);

      el('busytitle').textContent = 'Writing cards…';
      el('barfill').style.width = '0%';
      el('busysub').textContent = 'Reading the material…';

      const { cards, usage, failed, total } = await generateCards(markdown, {
        apiKey,
        model,
        pages,
        signal: controller.signal,
        onProgress: (done, chunks) => {
          el('barfill').style.width = Math.round((done / chunks) * 100) + '%';
          el('busysub').textContent = chunks > 1
            ? `Section ${Math.min(done + 1, chunks)} of ${chunks}`
            : 'Reading the material…';
        },
      });

      if (controller.signal.aborted) return;

      if (!cards.length) {
        showLibrary('No cards came back for that PDF. If it\'s mostly figures, tables or exercises, ' +
                    'there may be nothing in it to test.');
        return;
      }

      draft = {
        title,
        source: `${file.name} · ${pages} page${pages === 1 ? '' : 's'}`,
        cards,
        keep: new Set(cards.map((c) => c.id)),
        cost: formatCost(costOf(usage, model)),
        // A partial run still produces a usable deck, but silently handing back
        // a short one would leave the user believing their chapter had less in
        // it than it did. The approve screen says so instead.
        failed,
        total,
      };
      showApprove();
    } catch (err) {
      if (controller?.signal.aborted) return;
      console.error('[study] import failed', err);
      // OpenAIError messages are already written for the user; anything else is
      // a PDF-side failure or a bug, and gets a generic line.
      showLibrary(err instanceof OpenAIError
        ? err.message
        : err.message || 'That PDF could not be read.');
    } finally {
      controller = null;
    }
  }

  /* ============================= approve ============================= */

  function showApprove() {
    view = 'review';
    root.innerHTML = REVIEW_HTML;
    const shortfall = draft.failed
      ? ` ${draft.failed} of ${draft.total} sections failed, so some of the document is missing.`
      : '';
    el('reviewlead').textContent =
      `${draft.cards.length} cards from ${draft.source}, for ${draft.cost}.${shortfall} ` +
      'Discard anything that isn\'t worth learning — you can\'t edit them after saving.';
    el('decktitle').value = draft.title;

    el('cardlist').innerHTML = draft.cards.map((c) => `
      <div class="pcard" data-id="${c.id}">
        <div class="pcardtext">
          <div class="pfront">${esc(c.front)}</div>
          <div class="pback">${esc(c.back)}</div>
        </div>
        <div class="ppage">p.${c.page}</div>
        <button class="ghost toss" aria-label="Discard this card">Discard</button>
      </div>`).join('');

    el('cardlist').querySelectorAll('.pcard').forEach((row) => {
      row.querySelector('.toss').onclick = () => toggleKeep(row, row.dataset.id);
    });

    el('all').onclick = () => { draft.cards.forEach((c) => draft.keep.add(c.id)); syncApprove(); };
    el('none').onclick = () => { draft.keep.clear(); syncApprove(); };
    el('savedeck').onclick = saveDraft;
    syncApprove();
  }

  function toggleKeep(row, id) {
    if (draft.keep.has(id)) draft.keep.delete(id);
    else draft.keep.add(id);
    syncApprove();
  }

  /** Repaint the kept/discarded state without rebuilding the list. */
  function syncApprove() {
    const n = draft.keep.size;
    el('cardlist').querySelectorAll('.pcard').forEach((row) => {
      const kept = draft.keep.has(row.dataset.id);
      row.classList.toggle('tossed', !kept);
      row.querySelector('.toss').textContent = kept ? 'Discard' : 'Keep';
    });
    el('keptcount').textContent = `${n} of ${draft.cards.length} kept`;
    el('savedeck').disabled = n === 0;
  }

  function saveDraft() {
    const kept = draft.cards.filter((c) => draft.keep.has(c.id));
    if (!kept.length) return;

    const deck = makeDeck(el('decktitle').value.trim() || draft.title, draft.source, kept);
    decks = [deck, ...decks];
    const res = persist();
    if (!res.ok) {
      // Roll back so the list on screen matches what is actually stored.
      decks = decks.filter((d) => d.id !== deck.id);
      el('saveerr').textContent = res.message;
      return;
    }
    showLibrary();
  }

  /* ============================== study ============================== */

  function startSession(deck) {
    const queue = dueQueue(deck.cards, Date.now());
    if (!queue.length) return;
    session = { deck, queue, card: null, flipped: false, done: 0, again: 0 };
    view = 'study';
    root.innerHTML = STUDY_HTML;

    el('quit').onclick = () => { persist(); showLibrary(); };
    el('flashcard').onclick = flip;
    el('flashcard').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); flip(); }
    });
    el('sessiontitle').textContent = deck.title;

    nextCard();
  }

  /**
   * Take the next card from the queue.
   *
   * The queue is rebuilt from the deck each time rather than walked once,
   * because grading changes what is due: a card you press "again" on becomes
   * due in a minute and has to come back *this session*, which a fixed list
   * decided up front could never do. Rebuilding is O(deck), which at a few
   * hundred cards is nothing next to the time between two keypresses.
   */
  function nextCard() {
    const now = Date.now();
    const queue = dueQueue(session.deck.cards, now);

    // Cards in learning are due within minutes, so an empty queue does not mean
    // the session is over — it means there is a gap before the next repeat. The
    // session ends when nothing is coming back inside the learning window.
    if (!queue.length) {
      const soon = session.deck.cards
        .filter((c) => c.srs.stage === 'learning')
        .map((c) => c.srs.due)
        .sort((a, b) => a - b)[0];

      if (soon && soon - now < 11 * 60 * 1000) {
        // Show it early rather than making the user sit and wait out a timer.
        session.card = session.deck.cards.find((c) => c.srs.due === soon);
      } else {
        return showDone();
      }
    } else {
      session.card = queue[0];
    }

    session.flipped = false;
    renderCard();
  }

  function renderCard() {
    const card = session.card;
    const stage = card.srs.stage;

    el('front').textContent = card.front;
    el('back').textContent = card.back;
    el('back').hidden = !session.flipped;
    el('flashcard').classList.toggle('flipped', session.flipped);
    el('flashcard').setAttribute('aria-label',
      session.flipped ? 'Answer shown. Grade how well you knew it.' : 'Question. Activate to reveal the answer.');
    root.querySelector('.flip-hint').hidden = session.flipped;

    el('cardmeta').innerHTML =
      `<span class="stage ${stage}">${stage === 'new' ? 'New card' : stage === 'learning' ? 'Learning' : 'Review'}</span>` +
      `<span class="pg">page ${card.page}</span>`;

    const remaining = dueQueue(session.deck.cards, Date.now()).length;
    el('counts').textContent = `${session.done} done · ${remaining} to go`;
    // Progress against the work known about at this moment, which grows when
    // cards are failed. Honest, if occasionally backwards.
    const total = session.done + Math.max(remaining, 1);
    el('barfill').style.width = Math.round((session.done / total) * 100) + '%';

    renderGrades();
  }

  function flip() {
    if (session.flipped) return;
    session.flipped = true;
    renderCard();
    // Move focus to the grades so the keyboard path continues without a reach
    // for the mouse; the shortcut keys work regardless of what has focus.
    root.querySelector('.grades button')?.focus();
  }

  const GRADE_LABELS = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

  function renderGrades() {
    const box = el('grades');
    box.hidden = !session.flipped;
    if (!session.flipped) { box.innerHTML = ''; return; }

    const now = Date.now();
    box.innerHTML = GRADES.map((g, i) => `
      <button class="grade ${g}" data-g="${g}">
        <span class="gl">${GRADE_LABELS[g]}</span>
        <span class="gi">${describeNext(session.card.srs, g, now)}</span>
        <span class="gk">${i + 1}</span>
      </button>`).join('');
    box.querySelectorAll('button').forEach((b) => { b.onclick = () => grade(b.dataset.g); });
  }

  function grade(g) {
    if (!session || !session.flipped) return;
    const card = session.card;
    card.srs = gradeCard(card.srs, g, Date.now());
    session.done += 1;
    if (g === 'again') session.again += 1;
    // Written through on every card, not at the end: the session's value is in
    // the schedule it produced, and closing the tab mid-session is normal use,
    // not an error case.
    persist();
    nextCard();
  }

  function showDone() {
    view = 'done';
    const { done, again, deck } = session;
    root.innerHTML = DONE_HTML;
    const stats = deckStats(deck.cards, Date.now());
    const next = nextDueLabel(deck, Date.now());

    el('donesub').innerHTML =
      `${done} card${done === 1 ? '' : 's'} reviewed in <b>${esc(deck.title)}</b>` +
      (again ? ` · ${again} you'll see again sooner` : '') +
      `<div class="sub">${stats.new} still new · ${next.toLowerCase()}</div>`;

    el('again').disabled = !stats.due;
    el('again').onclick = () => startSession(deck);
    el('back').onclick = showLibrary;
    updateTag();
  }

  /* ============================ shortcuts ============================ */

  // Bound on the document so the keys work wherever focus is, and gated on
  // `visible` so pressing 3 while playing Uno doesn't grade a flashcard in a
  // hidden panel. Panels stay in the DOM when their tab is off screen (see
  // app.js), so this guard is load-bearing rather than defensive.
  function onKey(ev) {
    if (!visible || view !== 'study' || !session) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (/^(input|textarea)$/i.test(ev.target?.tagName)) return;

    if (!session.flipped && (ev.key === ' ' || ev.key === 'Enter')) {
      ev.preventDefault();
      flip();
      return;
    }
    if (session.flipped) {
      const i = '1234'.indexOf(ev.key);
      if (i >= 0) { ev.preventDefault(); grade(GRADES[i]); }
      else if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); grade('good'); }
    }
  }
  document.addEventListener('keydown', onKey);

  showLibrary();

  return {
    onShow() {
      visible = true;
      // Due counts move with the clock, so a library left open for an hour is
      // stale by the time you come back to it.
      if (view === 'library') { renderDecks(); updateTag(); }
    },
    onHide() { visible = false; },
  };
}

// `init` returns the show/hide hooks, which the shell reads off the module
// object — so they are installed here once the module has actually booted. The
// shell calls onShow() itself immediately after init, so there is no need to
// prime it here.
const flashcards = {
  id: 'flashcards',
  title: 'Flashcards',
  init(root, header) {
    const hooks = init(root, header);
    flashcards.onShow = hooks.onShow;
    flashcards.onHide = hooks.onHide;
  },
};

export default flashcards;
