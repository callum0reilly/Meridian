// Can everyone actually get everything? A reachability sweep over the Bros
// worlds, run against the real physics in rules.js.
//
//   node test/bros-reach.mjs                      every world, every character
//   node test/bros-reach.mjs meadow,frost sunny   just those
//
// For each character it searches outward from the spawn over *standing*
// positions: from each one it tries a spread of inputs — walks, run-ups,
// short and full jumps, air steering that changes mid-flight, drops through
// platforms, swimming taps — steps `stepPlayer` through them, and every place
// the hero comes to rest is a new position to search from. Along the way it
// records every coin, gem, key and pickup touched, every ?/@ block bumped and
// every block stood on. Keys and a reached boss open the doors, and bumped
// bricks break, then the search runs again.
//
// Enemies are ignored and buffs aren't used, so it is conservative about
// movement but not about danger. Around moving platforms it also waits a full
// cycle before trying a move, since boarding at the right moment matters.
//
// Not part of `npm test` — the worlds with movers take minutes. Run it after
// editing a world. Exits 1 if anything is out of reach.

const R = await import(new URL('../js/games/bros/rules.js', import.meta.url));
const L = await import(new URL('../js/games/bros/levels.js', import.meta.url));
const { TILE, PLAYER_H, PLAYER_W, CHAR_IDS, makeBody, stepPlayer, collectCoins, collectGems, collectPickups, collectKeys, touchFlag, parseWorld } = R;
const HH = PLAYER_H / 2;
const HW = PLAYER_W / 2;
const IDLE = { left: false, right: false, jump: false, held: false, down: false };

export function sweep(world, charId) {
  const lv = parseWorld(world);
  const hasClock = lv.movers.length > 0 || world.map.some((r) => /[Ll]/.test(r)) || !!world.wind;
  const hasWater = world.map.some((r) => r.includes('w'));
  const allUsed = new Set(lv.pickups.filter((p) => p.block).map((p) => p.block));
  const boss = lv.enemies.find((e) => e.type === 'boss');
  const got = { coins: new Set(), gems: new Set(), keys: new Set(), pickups: new Set(), bumped: new Set(), stood: new Set(), flag: false };
  const none = new Set();

  const moves = [];
  for (const wait of hasClock ? [0, 45, 90, 135, 180] : [0]) {
    for (const d of [-1, 1]) for (const n of [5, 14, 36]) moves.push({ wait, kind: 'walk', d, n });
    moves.push({ wait, kind: 'drop' });
    for (const p of [0, 8, 24]) for (const d of p ? [-1, 1] : [0])
      for (const h of [70, 5]) for (const tap of hasWater ? [0, 12] : [0])
        for (const a1 of [-1, 0, 1]) for (const t1 of [12, 40, 999]) for (const a2 of t1 === 999 ? [a1] : [-1, 0, 1])
          moves.push({ wait, kind: 'jump', p, d, h, tap, a1, t1, a2 });
  }
  const longWaits = [];
  if (lv.movers.length) {
    for (let wait = 0; wait <= 720; wait += 24) {
      for (const d of [-1, 1]) {
        longWaits.push({ wait, kind: 'walk', d, n: 10 });
        longWaits.push({ wait, kind: 'jump', p: 0, d: 0, h: 70, tap: 0, a1: d, t1: 999, a2: d });
      }
    }
  }
  const nearMover = (b) => lv.movers.some((m) =>
    b.x > Math.min(m.x0, m.x1) - TILE * 5 && b.x < Math.max(m.x0, m.x1) + TILE * 5 &&
    b.y > Math.min(m.y0, m.y1) - TILE * 5 && b.y < Math.max(m.y0, m.y1) + TILE * 4);

  const seen = new Map();
  const queue = [];
  const add = (b, clock) => {
    const key = `${Math.round(b.x / 10)},${Math.round(b.y / 4)},${b.wet ? 1 : 0},${b.ride}`;
    if (seen.has(key)) return;
    const s = { b: { ...b, buff: null }, clock };
    seen.set(key, s);
    queue.push(s);
  };

  const observe = (b) => {
    for (const i of collectCoins(b, lv, none)) got.coins.add(i);
    for (const i of collectGems(b, lv, none)) got.gems.add(i);
    for (const i of collectKeys(b, lv, none)) got.keys.add(i);
    for (const i of collectPickups(b, lv, none, allUsed)) got.pickups.add(i);
    if (touchFlag(b, lv)) got.flag = true;
    if (b.onGround) {
      const ty = Math.floor((b.y + HH + 2) / TILE);
      for (let tx = Math.floor((b.x - HW + 0.01) / TILE); tx <= Math.floor((b.x + HW - 0.01) / TILE); tx++) {
        if (L.solidAt(lv, tx, ty)) got.stood.add(tx + ',' + ty);
      }
    }
  };

  let opened = false;
  const run = (s, c) => {
    const b = { ...s.b };
    let clock = s.clock;
    for (let t = 0; t < c.wait; t++) { stepPlayer(b, IDLE, lv, ++clock); if (b.dead) return; observe(b); }
    let airborne = 0;
    for (let t = 0; t < 420; t++) {
      const input = { ...IDLE };
      let dir = 0;
      if (c.kind === 'walk') {
        if (t < c.n) dir = c.d;
        else if (b.onGround && Math.abs(b.vx) < 0.1) break;
      } else if (c.kind === 'drop') {
        input.down = t < 3;
        if (t > 3 && b.onGround) break;
      } else {
        const rel = t - c.p;
        if (rel < 0) dir = c.d;
        else {
          input.jump = rel === 0 || (c.tap > 0 && rel % c.tap === 0 && rel < 300);
          input.held = rel < c.h;
          dir = rel < c.t1 ? c.a1 : c.a2;
        }
      }
      input.left = dir < 0;
      input.right = dir > 0;
      const ev = stepPlayer(b, input, lv, ++clock);
      if (b.dead) return;
      if (ev.bump) {
        const key = ev.bump.tx + ',' + ev.bump.ty;
        const ch = L.tileAt(lv, ev.bump.tx, ev.bump.ty);
        if (ch === '?' || ch === '@') got.bumped.add(key);
        if (ch === '$' && !lv.broken.has(key)) { lv.broken.add(key); opened = true; }
      }
      observe(b);
      if (!b.onGround) airborne++;
      if (c.kind === 'jump' && t >= c.p && airborne > 1 && b.onGround) break;
    }
    if (b.onGround || b.wet) { if (!b.onGround) b.vx = 0; add(b, clock); }
  };

  const start = makeBody(lv, charId, 0);
  let clock = 0;
  for (let i = 0; i < 200 && !start.onGround; i++) stepPlayer(start, IDLE, lv, ++clock);
  add(start, clock);

  for (let pass = 0; pass < 4; pass++) {
    opened = false;
    while (queue.length) {
      const s = queue.shift();
      for (const c of moves) run(s, c);
      if (longWaits.length && nearMover(s.b)) for (const c of longWaits) run(s, c);
    }
    if (!lv.unlocked && (got.keys.size ||
        (boss && [...seen.values()].some((s) => Math.abs(s.b.x - boss.x) < TILE * 8 && Math.abs(s.b.y - boss.y) < TILE * 2)))) {
      lv.unlocked = true;
      opened = true;
    }
    if (!opened) break;
    queue.push(...seen.values());
  }

  const blocks = [];
  lv.grid.forEach((row, ty) => [...row].forEach((ch, tx) => { if (ch === '?' || ch === '@') blocks.push(`${ch}(${tx},${ty})`); }));
  const at = (p) => `(${Math.floor(p.x / TILE)},${Math.floor(p.y / TILE)})`;
  const coord = (s) => s.slice(2, -1);
  return {
    flag: got.flag,
    coins: lv.coins.filter((_, i) => !got.coins.has(i)).map(at),
    gems: lv.gems.filter((_, i) => !got.gems.has(i)).map(at),
    keys: lv.keys.filter((_, i) => !got.keys.has(i)).map(at),
    pickups: lv.pickups.filter((_, i) => !got.pickups.has(i)).map((p) => p.type + at(p)),
    'not bumpable': blocks.filter((k) => !got.bumped.has(coord(k))),
    'not standable': blocks.filter((k) => !got.stood.has(coord(k))),
  };
}

const [worldArg, charArg] = process.argv.slice(2);
const worlds = [...L.WORLDS, ...L.HARD_WORLDS].filter((w) => !worldArg || worldArg.split(',').includes(w.id));
const chars = charArg ? charArg.split(',') : CHAR_IDS;
let problems = 0;
for (const world of worlds) {
  for (const ch of chars) {
    const t0 = Date.now();
    const r = sweep(world, ch);
    const bad = Object.entries(r).filter(([k, v]) => k !== 'flag' && v.length);
    if (!r.flag) bad.unshift(['flag', ['unreachable']]);
    problems += bad.length;
    console.log(`${world.id} [${ch}] ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      (bad.length ? '\n  ' + bad.map(([k, v]) => `${k}: ${v.join(' ')}`).join('\n  ') : 'all reachable'));
  }
}
process.exit(problems ? 1 : 0);
