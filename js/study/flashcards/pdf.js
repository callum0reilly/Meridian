// PDF text extraction, via pdf.js. The only impure part of the flashcard
// pipeline: it touches the network (to fetch the library) and the file the user
// picked. Everything downstream of `extractLines` is plain data.
//
// ---- Why the library loads lazily ----
//
// pdf.js is about a megabyte with its worker. index.html loads PeerJS eagerly
// because every game needs it the moment you open a lobby, but nothing needs a
// PDF parser until someone actually drops a file in — and most sessions never
// will. A dynamic import keeps that cost off the Ludo players entirely, which
// is the same reasoning app.js uses to defer each tab's init.
//
// ---- Why a pinned version ----
//
// pdf.js changes its build layout between majors (the .mjs entry point and the
// worker path have both moved). An unpinned CDN URL means the study tab breaks
// one day without anybody touching this repo, which for a static site with no
// build step and no lockfile is the failure mode to design against.

const PDFJS_VERSION = '4.7.76';
const BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/`;

let libPromise = null;

/** Load pdf.js once per session; concurrent callers share the one import. */
function loadPdfJs() {
  if (!libPromise) {
    libPromise = import(/* @vite-ignore */ BASE + 'pdf.min.mjs')
      .then((lib) => {
        // The worker runs parsing off the main thread. Without it pdf.js still
        // works but blocks the UI for the whole document, which on a 200-page
        // scan is long enough to trip the browser's unresponsive-page warning.
        lib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
        return lib;
      })
      .catch((err) => {
        libPromise = null;   // let a later attempt retry rather than cache the failure
        throw new Error('Could not load the PDF reader. Check your connection: ' + err.message);
      });
  }
  return libPromise;
}

/**
 * Group a page's text items into lines with a font size and a bold flag.
 *
 * pdf.js reports positioned *runs*, not lines: a single visual line arrives as
 * several items whenever the font changes mid-line, which is exactly what
 * happens on "**Osmosis** is the movement of..." — the part we most want to
 * detect. Grouping by baseline puts it back together.
 *
 * Baselines are matched with a tolerance rather than by equality because
 * subscripts, superscripts and inline maths sit a fraction off the line and
 * would otherwise each become a line of their own.
 */
export function itemsToLines(items, page) {
  const rows = [];
  for (const item of items) {
    const text = item.str;
    if (!text || !text.trim()) continue;

    const y = item.transform[5];
    const size = Math.abs(item.transform[0]) || item.height || 0;
    const bold = /bold|black|heavy|semib/i.test(item.fontName || '');
    const tolerance = Math.max(2, size * 0.5);

    const row = rows.find((r) => Math.abs(r.y - y) <= tolerance);
    if (row) {
      // pdf.js sets hasEOL on a run that ends its line, and sometimes emits
      // adjacent runs with no space between them; trust the source's spacing
      // only when one side already has it.
      const glue = /\s$/.test(row.text) || /^\s/.test(text) ? '' : ' ';
      row.text += glue + text;
      row.size = Math.max(row.size, size);
      row.bold = row.bold && bold;      // a line is bold only if all of it is
      row.x = Math.min(row.x, item.transform[4]);
    } else {
      rows.push({ y, x: item.transform[4], text, size, bold, page });
    }
  }

  // Top of the page down. PDF y-coordinates grow upwards, so this is a
  // descending sort — getting it backwards silently reverses every document.
  rows.sort((a, b) => b.y - a.y);
  markParagraphs(rows);

  return rows.map((r) => ({
    text: r.text.replace(/\s+/g, ' ').trim(),
    size: r.size, bold: r.bold, para: r.para, page,
  }));
}

/**
 * Flag the rows that begin a new paragraph, by the gap above them.
 *
 * A PDF has no paragraph marks — it has ink at coordinates. The only thing
 * separating "…across the membrane." at the end of one paragraph from
 * "Denaturation refers to…" at the start of the next is a few extra points of
 * vertical space, and without reading that space every paragraph on the page
 * merges into one blob. Downstream that is not a cosmetic problem: a heading
 * would then claim the whole page as its definition and every term below the
 * first would vanish.
 *
 * The threshold is relative to the document's own leading rather than a fixed
 * number of points, because line spacing varies wildly between documents and
 * any constant is right for exactly one of them.
 */
function markParagraphs(rows) {
  if (rows.length < 2) {
    if (rows[0]) rows[0].para = true;
    return;
  }

  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i - 1].y - rows[i].y);
  const leading = lineLeading(gaps);

  // Enough clearance to sit above the leading's own jitter, small enough to
  // stay under a real paragraph gap. On typical 12pt text that puts the line
  // around 16pt, against a 14pt leading and 19pt paragraph spacing.
  const threshold = leading + Math.max(leading * 0.15, 2);

  // The first line on a page always starts a block: a page break is at least as
  // strong a separator as a blank line, and the running text that genuinely
  // continues across it is rejoined by nothing here — which costs one merged
  // sentence occasionally, against reliably splitting every real section.
  rows[0].para = true;
  for (let i = 1; i < rows.length; i++) rows[i].para = gaps[i - 1] > threshold;
}

/**
 * The document's line leading, as the most repeated gap between lines.
 *
 * The mode and not the median: on a page of short paragraphs, half the gaps are
 * paragraph gaps and the median lands on one of them, which sets the threshold
 * above every real break and merges the whole page into a single block. Lines
 * inside a paragraph, by contrast, are always the *most numerous* gap in any
 * document with prose in it, because paragraphs contain more line breaks than
 * they have edges.
 *
 * Gaps are bucketed to the nearest point before counting — subpixel differences
 * would otherwise scatter one leading across several near-identical values and
 * leave no mode at all.
 */
function lineLeading(gaps) {
  const counts = new Map();
  for (const gap of gaps) {
    if (gap <= 0) continue;
    const bucket = Math.round(gap);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }

  let best = 0, bestCount = 0;
  for (const [bucket, count] of counts) {
    // Ties break towards the smaller gap: leading is the tightest spacing on
    // the page, so on a short page where two gaps tie it is the lower one.
    if (count > bestCount || (count === bestCount && bucket < best)) {
      best = bucket; bestCount = count;
    }
  }
  return best;
}

/**
 * Read a PDF file into the line array `doctext.js` consumes.
 *
 * @param {File|ArrayBuffer} file
 * @param {{onProgress?: (done:number,total:number)=>void, signal?: AbortSignal}} opts
 * @returns {Promise<{lines: Array, pages: number, title: string}>}
 */
export async function extractLines(file, { onProgress, signal } = {}) {
  const lib = await loadPdfJs();
  const data = file instanceof ArrayBuffer ? file : await file.arrayBuffer();

  const task = lib.getDocument({ data: new Uint8Array(data) });
  signal?.addEventListener('abort', () => task.destroy(), { once: true });

  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    if (err?.name === 'PasswordException') {
      throw new Error('That PDF is password-protected, so its text can\'t be read.');
    }
    throw new Error('That file could not be read as a PDF.');
  }

  const lines = [];
  const pages = doc.numPages;
  let title;
  try {
    for (let p = 1; p <= pages; p++) {
      if (signal?.aborted) throw new Error('cancelled');
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      lines.push(...itemsToLines(content.items, p));
      page.cleanup();
      onProgress?.(p, pages);
    }
    // Read before the destroy below — getMetadata needs the document alive.
    title = await docTitle(doc, file);
  } finally {
    doc.destroy();
  }

  return { lines, pages, title };
}

/**
 * A name for the deck: the PDF's own title, else the filename.
 *
 * Embedded titles are often left at whatever the authoring tool defaulted to —
 * "Microsoft Word - final2.docx", or the LaTeX job name — so anything that
 * looks like a filename is rejected in favour of the actual filename, which at
 * least the user chose to keep.
 */
async function docTitle(doc, file) {
  const fallback = (file?.name || 'Untitled').replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
  try {
    const { info } = await doc.getMetadata();
    const title = (info?.Title || '').trim();
    if (title && title.length > 2 && !/\.(docx?|tex|pdf|indd|pptx?)\b/i.test(title)) return title;
  } catch { /* metadata is optional; the filename is always there */ }
  return fallback || 'Untitled';
}

/** True once the library is in memory, so the UI can skip its loading copy. */
export const isReady = () => libPromise !== null;
