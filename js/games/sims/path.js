// The Sims 5 — pathfinding. Pure, imports nothing.
//
// Plain A* over the tile grid, four directions only. Diagonals are left out on
// purpose: the classic bug in iso house games is a sim cutting the corner of a
// wall junction, and forbidding diagonal steps removes the whole class of it.
// With float positions and short waypoint hops the movement still looks fine.
//
// Walls live on tile EDGES, not tiles, so blocking is two separate questions:
//   isBlocked(x, y)        — can a sim stand on this tile at all?
//   canCross(x, y, dir)    — can a sim step off tile (x,y) in direction dir?
// dir: 0 = north (y-1), 1 = east (x+1), 2 = south (y+1), 3 = west (x-1).
// The callers close these over the lot's wall arrays and the derived blocked
// grid; this file never sees the lot itself.
//
// 24×24 is 576 nodes. A linear-scan open list is comfortably fast at that size
// and much harder to get wrong than a heap.

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/**
 * @returns {[number,number][] | null} waypoints from (excluding `from`) to and
 * including `to`, or null when unreachable. from === to returns [].
 */
export function findPath(w, h, isBlocked, canCross, from, to) {
  const [fx, fy] = from, [tx, ty] = to;
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return null;
  if (isBlocked(tx, ty)) return null;
  if (fx === tx && fy === ty) return [];

  const idx = (x, y) => y * w + x;
  const g = new Float64Array(w * h).fill(Infinity);
  const came = new Int32Array(w * h).fill(-1);
  const closed = new Uint8Array(w * h);
  const open = [idx(fx, fy)];
  g[idx(fx, fy)] = 0;

  const heur = (x, y) => Math.abs(x - tx) + Math.abs(y - ty);

  while (open.length) {
    // Lowest f = g + h wins; ties broken by insertion order, which A* allows.
    let best = 0;
    let bestF = Infinity;
    for (let i = 0; i < open.length; i++) {
      const n = open[i];
      const f = g[n] + heur(n % w, (n / w) | 0);
      if (f < bestF) { bestF = f; best = i; }
    }
    const cur = open.splice(best, 1)[0];
    const cx = cur % w, cy = (cur / w) | 0;
    if (cx === tx && cy === ty) {
      const path = [];
      for (let n = cur; n !== idx(fx, fy); n = came[n]) path.push([n % w, (n / w) | 0]);
      return path.reverse();
    }
    closed[cur] = 1;

    for (let dir = 0; dir < 4; dir++) {
      const nx = cx + DX[dir], ny = cy + DY[dir];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = idx(nx, ny);
      if (closed[ni] || isBlocked(nx, ny) || !canCross(cx, cy, dir)) continue;
      const ng = g[cur] + 1;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        if (!open.includes(ni)) open.push(ni);
      }
    }
  }
  return null;
}
