// Heuristics: A* path search, take-the-best patch choice and a
// marginal-value / satisficing leaving rule.
import { MinHeap } from "./graph.js";

// Occupancy grid over the arena; obstacles are discs.
export class NavGrid {
  constructor(size, res, obstacles, margin = 1.2) {
    this.size = size; // arena spans [-size/2, size/2]
    this.res = res;
    this.cell = size / res;
    this.block = new Uint8Array(res * res);
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++) {
        const [x, z] = this.center(i, j);
        for (const o of obstacles)
          if (Math.hypot(x - o.x, z - o.z) < o.r + margin) this.block[j * res + i] = 1;
      }
  }
  toCell(x, z) {
    const r = this.res;
    const i = Math.min(r - 1, Math.max(0, Math.floor((x / this.size + 0.5) * r)));
    const j = Math.min(r - 1, Math.max(0, Math.floor((z / this.size + 0.5) * r)));
    return [i, j];
  }
  center(i, j) {
    return [(i + 0.5) * this.cell - this.size / 2, (j + 0.5) * this.cell - this.size / 2];
  }
  nearestFree(i, j) {
    const r = this.res;
    if (!this.block[j * r + i]) return [i, j];
    for (let d = 1; d < r; d++)
      for (let dj = -d; dj <= d; dj++)
        for (let di = -d; di <= d; di++) {
          const a = i + di, b = j + dj;
          if (a >= 0 && b >= 0 && a < r && b < r && !this.block[b * r + a]) return [a, b];
        }
    return [i, j];
  }

  // A* (Hart, Nilsson & Raphael 1968) with the octile-distance heuristic, which
  // is admissible on an 8-connected grid. weightH = 0 turns it into Dijkstra.
  search(sx, sz, gx, gz, weightH = 1) {
    const r = this.res;
    let [si, sj] = this.nearestFree(...this.toCell(sx, sz));
    let [gi, gj] = this.nearestFree(...this.toCell(gx, gz));
    const start = sj * r + si, goal = gj * r + gi;
    const g = new Float32Array(r * r).fill(Infinity);
    const prev = new Int32Array(r * r).fill(-1);
    const closed = new Uint8Array(r * r);
    const h = (c) => {
      const dx = Math.abs((c % r) - gi), dz = Math.abs(((c / r) | 0) - gj);
      return weightH * (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz));
    };
    const heap = new MinHeap();
    g[start] = 0;
    heap.push(h(start), start);
    let expanded = 0;
    while (heap.size) {
      const [, c] = heap.pop();
      if (closed[c]) continue;
      closed[c] = 1;
      expanded++;
      if (c === goal) break;
      const ci = c % r, cj = (c / r) | 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= r || nj >= r) continue;
          const n = nj * r + ni;
          if (this.block[n] || closed[n]) continue;
          if (di && dj && (this.block[cj * r + ni] || this.block[nj * r + ci])) continue; // no corner cutting
          const ng = g[c] + (di && dj ? Math.SQRT2 : 1);
          if (ng < g[n]) {
            g[n] = ng;
            prev[n] = c;
            heap.push(ng + h(n), n);
          }
        }
    }
    const path = [];
    if (prev[goal] >= 0 || goal === start)
      for (let c = goal; c >= 0; c = prev[c]) path.unshift(this.center(c % r, (c / r) | 0));
    return { path: simplify(path, this), expanded, cost: g[goal] };
  }

  lineFree(ax, az, bx, bz) {
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / (this.cell * 0.5));
    for (let s = 0; s <= steps; s++) {
      const t = s / Math.max(1, steps);
      const [i, j] = this.toCell(ax + (bx - ax) * t, az + (bz - az) * t);
      if (this.block[j * this.res + i]) return false;
    }
    return true;
  }
}

// string pulling: drop waypoints that have line of sight past them
function simplify(path, grid) {
  if (path.length < 3) return path;
  const out = [path[0]];
  let a = 0;
  for (let i = 2; i < path.length; i++) {
    if (!grid.lineFree(path[a][0], path[a][1], path[i][0], path[i][1])) {
      out.push(path[i - 1]);
      a = i - 1;
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

// Take-the-best (Gigerenzer & Goldstein 1996): compare options cue by cue in
// order of validity and decide on the first cue that discriminates.
export const PATCH_CUES = [
  { key: "sugar", label: "richer patch", better: (a, b) => a.sugar - b.sugar, jnd: 0.25 },
  { key: "crowd", label: "fewer rivals", better: (a, b) => b.crowd - a.crowd, jnd: 2 },
  { key: "dist", label: "closer", better: (a, b) => b.dist - a.dist, jnd: 3 },
];

export function takeTheBest(options, cues = PATCH_CUES) {
  let best = options[0];
  let reason = "only option";
  for (let k = 1; k < options.length; k++) {
    const o = options[k];
    for (const cue of cues) {
      const d = cue.better(o, best);
      if (Math.abs(d) >= cue.jnd) {
        if (d > 0) {
          best = o;
          reason = cue.label;
        }
        break;
      }
    }
  }
  return { best, reason };
}

// Leave a patch when the recent intake rate falls below the aspiration level
// (Charnov's 1976 marginal value theorem, implemented as Simon's 1955 satisficing).
export function shouldLeave(intakeRate, aspiration) {
  return intakeRate < aspiration;
}
