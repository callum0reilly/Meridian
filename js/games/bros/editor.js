// Meridian Bros — the level editor. A grid you paint tiles onto, the same
// glyphs the built-in worlds are written in, saved in this browser and
// shareable as a one-line code. "Play it" hands the level back to the lobby,
// which hosts a room with it.
//
// It is deliberately plain: the map format IS the editor's data model, so
// everything here is a thin skin over a rows array and share.js.

import { ROWS, WORLDS, GLYPHS } from './levels.js';
import { encodeLevel, decodeLevel, sanitiseLevel, loadLevels, saveLevels, MIN_WIDTH, MAX_WIDTH } from './share.js';

const CELL = 16;

/** What each glyph is, for the palette and for painting the grid. */
const TILES = [
  ['Terrain', [
    ['#', 'Ground', '#8a5a33'], ['B', 'Brick', '#c96e4a'], ['|', 'Pillar', '#2fa7b0'], ['=', 'Platform', '#b07b3f'],
    ['!', 'Spring', '#e5484d'], ['$', 'Breakable', '#b8865a'], ['D', 'Door', '#8f98ad'],
  ]],
  ['Blocks', [['?', 'Coin block', '#ffb224'], ['@', 'Heart block', '#ff6b9a']]],
  ['Hazards', [['^', 'Spikes', '#9aa7b8'], ['~', 'Lava', '#ff6b35'], ['L', 'Laser A', '#ff3b6b'], ['l', 'Laser B', '#c72a52']]],
  ['Fluids', [['w', 'Water', '#3498db'], ['u', 'Updraft', '#bfe6ff'], ['.', 'Air (erase)', '#1d2639']]],
  ['Movers', [['M', 'Mover ↔', '#c8b79e'], ['-', 'Rail ↔', '#5a5040'], ['V', 'Mover ↕', '#c8b79e'], [':', 'Rail ↕', '#5a5040']]],
  ['Pickups', [
    ['o', 'Coin', '#ffd23e'], ['G', 'Gem', '#39c0d6'], ['K', 'Key', '#ffd23e'],
    ['Z', 'Speed', '#ffb224'], ['W', 'Ward', '#7fb2e6'], ['N', 'Magnet', '#c563e6'],
  ]],
  ['Enemies', [['E', 'Walker', '#a4703f'], ['X', 'Spiker', '#3f4a63'], ['Y', 'Flyer', '#8b6fd1'], ['J', 'Hopper', '#6cc04a'], ['Q', 'Boss', '#9c2a2a']]],
  ['Markers', [['S', 'Start', '#2fbf6b'], ['F', 'Flag', '#e5484d'], ['C', 'Checkpoint', '#30a46c']]],
];
const COLOUR = Object.fromEntries(TILES.flatMap(([, list]) => list.map(([g, , c]) => [g, c])));
const LABEL = Object.fromEntries(TILES.flatMap(([, list]) => list.map(([g, l]) => [g, l])));

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function blankRows(w) {
  const rows = Array.from({ length: ROWS }, () => '.'.repeat(w).split(''));
  for (let x = 0; x < w; x++) { rows[ROWS - 1][x] = '#'; rows[ROWS - 2][x] = '#'; }
  rows[ROWS - 3][2] = 'S';
  rows[ROWS - 3][w - 4] = 'F';
  return rows;
}

const HTML = `
  <div class="editor">
    <div class="edtop">
      <button class="edback">← Back</button>
      <input class="edname" maxlength="24" placeholder="Level name" autocomplete="off">
      <label>Theme <select class="edtheme"></select></label>
      <label><input type="checkbox" class="edice"> Ice</label>
      <label><input type="checkbox" class="edwind"> Wind</label>
      <label>Width <input type="number" class="edwidth" min="${MIN_WIDTH}" max="${MAX_WIDTH}" step="10"></label>
      <label>Lives <input type="number" class="edlives" min="1" max="99"></label>
      <label>Par (s) <input type="number" class="edpar" min="0" max="5999" placeholder="—"></label>
      <span class="spacer"></span>
      <button class="edsave">Save</button>
      <button class="primary edplay">Play it</button>
    </div>
    <div class="edpal"></div>
    <div class="edhint">Click or drag to paint. Rows go top to bottom; the bottom two rows are the usual floor. A level needs one <b>S</b> and one <b>F</b>.</div>
    <div class="edwrap"><canvas class="edcanvas"></canvas></div>
    <div class="ederr"></div>
    <div class="edbottom">
      <div class="edshare">
        <div class="loghead">Share code</div>
        <textarea class="edcode" rows="3" spellcheck="false" placeholder="Save to see this level's code, or paste a friend's code here and press Load."></textarea>
        <div class="row"><button class="edcopy">Copy code</button><button class="edload">Load code</button></div>
      </div>
      <div class="edshelf">
        <div class="loghead">Your levels</div>
        <ul class="edlist"></ul>
      </div>
    </div>
  </div>
`;

/**
 * @param root      element to render into
 * @param onBack    () => void
 * @param onPlay    (def) => void — a sanitised level definition
 * @param initial   an existing definition to open, or null for a fresh grid
 */
export function mountEditor(root, { onBack, onPlay, initial = null }) {
  root.innerHTML = HTML;
  const el = (sel) => root.querySelector('.' + sel);
  const canvas = el('edcanvas');
  const ctx = canvas.getContext('2d');

  let rows = initial ? initial.map.map((r) => [...r]) : blankRows(150);
  let glyph = '#';
  let painting = false;
  let editingId = initial?.id || null;

  el('edtheme').innerHTML = WORLDS.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
  el('edname').value = initial?.name || '';
  el('edtheme').value = initial?.theme || WORLDS[0].id;
  el('edice').checked = !!initial?.ice;
  el('edwind').checked = !!initial?.wind;
  el('edlives').value = initial?.lives ?? 5;
  el('edpar').value = initial?.par ?? '';
  el('edwidth').value = rows[0].length;

  /* ---- palette ---- */
  el('edpal').innerHTML = TILES.map(([group, list]) => `
    <div class="edgroup"><span class="edcap">${group}</span>${list.map(([g, label, colour]) => `
      <button class="edtile${g === glyph ? ' on' : ''}" data-g="${g}" title="${label}" style="--c:${colour}">
        <span class="sw">${g === '.' ? '' : esc(g)}</span><span class="lb">${label}</span>
      </button>`).join('')}</div>`).join('');
  el('edpal').querySelectorAll('.edtile').forEach((b) => {
    b.onclick = () => {
      glyph = b.dataset.g;
      el('edpal').querySelectorAll('.edtile').forEach((x) => x.classList.toggle('on', x === b));
    };
  });

  /* ---- the grid ---- */
  function draw() {
    const w = rows[0].length;
    canvas.width = w * CELL;
    canvas.height = ROWS * CELL;
    ctx.fillStyle = '#131a29';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < w; x++) {
        const g = rows[y][x];
        if (g === '.') continue;
        ctx.fillStyle = COLOUR[g] || '#888';
        ctx.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
        if ('#B|=$^~wu-:'.includes(g)) continue;   // terrain reads by colour; glyphs for the rest
        ctx.fillStyle = 'w'.includes(g) ? '#fff' : 'rgba(0,0,0,0.75)';
        ctx.fillText(g, x * CELL + CELL / 2, y * CELL + CELL / 2 + 1);
      }
    }
    // faint grid lines every 10 columns, so coordinates can be read off
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 10) { ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, canvas.height); }
    ctx.stroke();
  }

  function cellAt(ev) {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - r.left) * (canvas.width / r.width) / CELL);
    const y = Math.floor((ev.clientY - r.top) * (canvas.height / r.height) / CELL);
    if (x < 0 || y < 0 || x >= rows[0].length || y >= ROWS) return null;
    return { x, y };
  }

  function paint(ev) {
    const c = cellAt(ev);
    if (!c) return;
    // S and F are singletons: painting a new one moves it.
    if (glyph === 'S' || glyph === 'F') {
      for (const row of rows) for (let x = 0; x < row.length; x++) if (row[x] === glyph) row[x] = '.';
    }
    if (rows[c.y][c.x] === glyph) return;
    rows[c.y][c.x] = glyph;
    draw();
  }

  canvas.addEventListener('pointerdown', (ev) => { painting = true; canvas.setPointerCapture(ev.pointerId); paint(ev); ev.preventDefault(); });
  canvas.addEventListener('pointermove', (ev) => { if (painting) paint(ev); });
  canvas.addEventListener('pointerup', () => { painting = false; });
  canvas.addEventListener('pointercancel', () => { painting = false; });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  el('edwidth').onchange = () => {
    const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, +el('edwidth').value || 150));
    el('edwidth').value = w;
    rows = rows.map((r) => {
      const out = r.slice(0, w);
      while (out.length < w) out.push('.');
      return out;
    });
    draw();
  };

  /* ---- the definition ---- */
  const currentDef = () => sanitiseLevel({
    id: editingId,
    name: el('edname').value,
    theme: el('edtheme').value,
    ice: el('edice').checked,
    wind: el('edwind').checked,
    lives: +el('edlives').value || 5,
    par: el('edpar').value === '' ? null : +el('edpar').value,
    map: rows.map((r) => r.join('')),
  });

  const showErr = (msg) => { el('ederr').textContent = msg || ''; };

  function tryDef() {
    try { showErr(''); return currentDef(); }
    catch (e) { showErr(e.message); return null; }
  }

  el('edsave').onclick = () => {
    const def = tryDef();
    if (!def) return;
    // Content changed → the id changes; keep the shelf entry in place.
    const list = loadLevels();
    const i = list.findIndex((d) => d.id === editingId);
    const fresh = { ...def, id: def.id };
    if (i >= 0) list[i] = fresh; else list.unshift(fresh);
    editingId = fresh.id;
    saveLevels(list);
    el('edcode').value = encodeLevel(fresh);
    renderShelf();
    el('edsave').textContent = 'Saved';
    setTimeout(() => { const b = el('edsave'); if (b) b.textContent = 'Save'; }, 1200);
  };

  el('edplay').onclick = () => {
    const def = tryDef();
    if (def) onPlay(def);
  };

  el('edback').onclick = () => onBack();

  el('edcopy').onclick = async () => {
    const def = tryDef();
    if (!def) return;
    el('edcode').value = encodeLevel(def);
    try { await navigator.clipboard.writeText(el('edcode').value); el('edcopy').textContent = 'Copied!'; }
    catch { el('edcode').select(); el('edcopy').textContent = 'Press Ctrl+C'; }
    setTimeout(() => { const b = el('edcopy'); if (b) b.textContent = 'Copy code'; }, 1400);
  };

  el('edload').onclick = () => {
    try {
      const def = decodeLevel(el('edcode').value);
      open(def);
      showErr('');
    } catch (e) { showErr(e.message); }
  };

  function open(def) {
    rows = def.map.map((r) => [...r]);
    editingId = def.id;
    el('edname').value = def.name;
    el('edtheme').value = def.theme;
    el('edice').checked = !!def.ice;
    el('edwind').checked = !!def.wind;
    el('edlives').value = def.lives ?? 5;
    el('edpar').value = def.par ?? '';
    el('edwidth').value = rows[0].length;
    draw();
  }

  function renderShelf() {
    const list = loadLevels();
    el('edlist').innerHTML = list.length ? list.map((d) => `
      <li data-id="${esc(d.id)}">
        <span class="nm">${esc(d.name)}</span>
        <span class="meta">${esc(WORLDS.find((w) => w.id === d.theme)?.name || d.theme)} · ${d.map[0].length} wide</span>
        <button class="open">Open</button>
        <button class="play">Play</button>
        <button class="del" title="Delete">✕</button>
      </li>`).join('') : '<li class="empty">Nothing saved yet. Paint something and press Save.</li>';
    el('edlist').querySelectorAll('li[data-id]').forEach((li) => {
      const d = list.find((x) => x.id === li.dataset.id);
      li.querySelector('.open').onclick = () => { open(d); el('edcode').value = encodeLevel(d); };
      li.querySelector('.play').onclick = () => onPlay(d);
      li.querySelector('.del').onclick = () => {
        if (!confirm(`Delete "${d.name}"?`)) return;
        saveLevels(list.filter((x) => x.id !== d.id));
        renderShelf();
      };
    });
  }

  draw();
  renderShelf();
  if (initial) el('edcode').value = encodeLevel(initial);
}

export { GLYPHS, LABEL };
