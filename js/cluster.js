// Clustering: spatial hashing, DBSCAN on positions, k-means++ on neural states.

export class SpatialHash {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }
  build(xs, zs, n) {
    this.map.clear();
    for (let i = 0; i < n; i++) {
      const k = this.key(Math.floor(xs[i] / this.cell), Math.floor(zs[i] / this.cell));
      let b = this.map.get(k);
      if (!b) this.map.set(k, (b = []));
      b.push(i);
    }
  }
  key(i, j) {
    return (i + 1024) * 4096 + (j + 1024);
  }
  // indices within radius r of (x, z); r must be <= cell
  query(x, z, r, xs, zs, out) {
    out.length = 0;
    const ci = Math.floor(x / this.cell), cj = Math.floor(z / this.cell);
    const r2 = r * r;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const b = this.map.get(this.key(ci + di, cj + dj));
        if (!b) continue;
        for (const i of b) {
          const dx = xs[i] - x, dz = zs[i] - z;
          if (dx * dx + dz * dz <= r2) out.push(i);
        }
      }
    return out;
  }
}

// DBSCAN (Ester, Kriegel, Sander & Xu 1996). Returns labels (-1 = noise).
export function dbscan(n, xs, zs, eps, minPts, hash) {
  const labels = new Int32Array(n).fill(-2); // -2 unvisited
  const nb = [], nb2 = [];
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    hash.query(xs[i], zs[i], eps, xs, zs, nb);
    if (nb.length < minPts) {
      labels[i] = -1;
      continue;
    }
    labels[i] = c;
    const seeds = nb.slice();
    for (let s = 0; s < seeds.length; s++) {
      const j = seeds[s];
      if (labels[j] === -1) labels[j] = c;
      if (labels[j] !== -2) continue;
      labels[j] = c;
      hash.query(xs[j], zs[j], eps, xs, zs, nb2);
      if (nb2.length >= minPts) for (const q of nb2) if (labels[q] < 0) seeds.push(q);
    }
    c++;
  }
  return { labels, count: c };
}

// k-means with k-means++ seeding (Arthur & Vassilvitskii 2007) and Lloyd (1982)
// iterations. data: array of Float32Array rows.
export function kmeans(data, k, { iters = 12, prev = null } = {}) {
  const n = data.length;
  if (n === 0) return { labels: [], centroids: [] };
  const d = data[0].length;
  const dist2 = (a, b) => {
    let s = 0;
    for (let i = 0; i < d; i++) s += (a[i] - b[i]) ** 2;
    return s;
  };
  let C;
  if (prev && prev.length === k) C = prev.map((c) => Float32Array.from(c)); // warm start keeps labels stable
  else {
    C = [Float32Array.from(data[Math.floor(Math.random() * n)])];
    const D = new Float64Array(n);
    while (C.length < k) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        D[i] = Math.min(...C.map((c) => dist2(data[i], c)));
        sum += D[i];
      }
      let r = Math.random() * sum, pick = 0;
      for (; pick < n - 1 && r > D[pick]; pick++) r -= D[pick];
      C.push(Float32Array.from(data[pick]));
    }
  }
  const labels = new Int32Array(n);
  let inertia = 0;
  for (let it = 0; it < iters; it++) {
    inertia = 0;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = dist2(data[i], C[c]);
        if (dd < bd) (bd = dd), (best = c);
      }
      labels[i] = best;
      inertia += bd;
    }
    const sums = Array.from({ length: k }, () => new Float64Array(d));
    const cnt = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      cnt[labels[i]]++;
      for (let j = 0; j < d; j++) sums[labels[i]][j] += data[i][j];
    }
    for (let c = 0; c < k; c++)
      if (cnt[c]) for (let j = 0; j < d; j++) C[c][j] = sums[c][j] / cnt[c];
  }
  return { labels, centroids: C, inertia };
}
