// Meridian Bros — level codes. A custom world as one line of text you can
// paste into a chat: a header, then every row run-length encoded, so a
// mostly-empty sky costs four characters rather than 150.
//
//   MB1;<name>;<theme>;<flags>;<lives>;<par>;<row>/<row>/…
//   row: runs of <count><glyph>, e.g. "150." or "2.S13.E23.E…"
//
// Pure — no DOM — so it can be tested, and so the host can check a level a
// client sends before letting anyone run around in it.

import { ROWS, GLYPHS, WORLDS, WORLD_BY_ID } from './levels.js';

export const MAX_WIDTH = 400;
export const MIN_WIDTH = 30;
const VERSION = 'MB1';

function rle(row) {
  let out = '';
  for (let i = 0; i < row.length;) {
    let j = i;
    while (j < row.length && row[j] === row[i]) j++;
    out += (j - i > 1 ? j - i : '') + row[i];
    i = j;
  }
  return out;
}

function unrle(s) {
  let out = '';
  let n = '';
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') { n += ch; continue; }
    if (!GLYPHS.includes(ch)) throw new Error(`unknown tile "${ch}"`);
    out += ch.repeat(n ? +n : 1);
    n = '';
  }
  if (n) throw new Error('a count with no tile after it');
  return out;
}

export function encodeLevel(def) {
  const flags = (def.ice ? 'i' : '') + (def.wind ? 'w' : '');
  return [
    VERSION,
    encodeURIComponent(def.name || 'Untitled'),
    def.theme || WORLDS[0].id,
    flags,
    def.lives ?? 5,
    def.par ?? '',
    def.map.map(rle).join('/'),
  ].join(';');
}

export function decodeLevel(code) {
  const parts = String(code || '').trim().split(';');
  if (parts.length < 7 || parts[0] !== VERSION) throw new Error('That doesn\'t look like a Bros level code.');
  const [, name, theme, flags, lives, par, rows] = parts;
  return sanitiseLevel({
    name: decodeURIComponent(name),
    theme,
    ice: flags.includes('i'),
    wind: flags.includes('w'),
    lives: lives === '' ? 5 : +lives,
    par: par === '' ? null : +par,
    map: rows.split('/').map(unrle),
  });
}

/**
 * Make a level definition safe to share and to play: only known glyphs, a
 * sane size, exactly one start and one flag, a real theme. Throws with a
 * message the editor can show.
 */
export function sanitiseLevel(def) {
  if (!def || !Array.isArray(def.map)) throw new Error('No map.');
  const name = String(def.name || 'Untitled').trim().slice(0, 24) || 'Untitled';
  const theme = WORLD_BY_ID.has(def.theme) && !WORLD_BY_ID.get(def.theme).custom ? def.theme : WORLDS[0].id;
  const rows = def.map.slice(0, ROWS).map((r) => String(r));
  while (rows.length < ROWS) rows.unshift('');
  const w = Math.max(...rows.map((r) => r.length));
  if (w < MIN_WIDTH) throw new Error(`A level needs at least ${MIN_WIDTH} columns.`);
  if (w > MAX_WIDTH) throw new Error(`A level can be at most ${MAX_WIDTH} columns wide.`);
  const map = rows.map((r) => r.padEnd(w, '.'));
  const all = map.join('');
  for (const ch of all) if (!GLYPHS.includes(ch)) throw new Error(`Unknown tile "${ch}".`);
  const starts = (all.match(/S/g) || []).length;
  const flags = (all.match(/F/g) || []).length;
  if (starts !== 1) throw new Error(starts ? 'Only one start (S) allowed.' : 'Place a start (S).');
  if (flags !== 1) throw new Error(flags ? 'Only one flag (F) allowed.' : 'Place a flag (F).');
  const lives = Number.isInteger(def.lives) && def.lives >= 1 && def.lives <= 99 ? def.lives : 5;
  const par = Number.isInteger(def.par) && def.par > 0 && def.par < 6000 ? def.par : null;
  return {
    id: def.id || 'custom-' + hash(all + name),
    name, theme, ice: !!def.ice, wind: !!def.wind, lives, par, map,
  };
}

/** A short stable id for a level's content, so the same level shared twice
 *  is the same world on every machine. */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/* ---- the shelf: levels saved in this browser ---- */

const KEY = 'bros.levels';

export function loadLevels() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}

export function saveLevels(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
