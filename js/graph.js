// Graph theory toolkit: PageRank, Louvain communities, Brandes betweenness,
// Dijkstra, local clustering coefficient and union-find.

// PageRank (Page, Brin, Motwani & Winograd 1999) on a weighted directed graph.
export function pagerank(N, edges, { d = 0.85, iters = 60 } = {}) {
  const outW = new Float64Array(N);
  for (const [s, , w] of edges) outW[s] += Math.abs(w);
  let pr = new Float64Array(N).fill(1 / N);
  for (let it = 0; it < iters; it++) {
    const nx = new Float64Array(N).fill((1 - d) / N);
    let dangling = 0;
    for (let i = 0; i < N; i++) if (outW[i] === 0) dangling += pr[i];
    for (const [s, t, w] of edges) nx[t] += (d * pr[s] * Math.abs(w)) / outW[s];
    for (let i = 0; i < N; i++) nx[i] += (d * dangling) / N;
    pr = nx;
  }
  return pr;
}

// Louvain modularity optimisation (Blondel, Guillaume, Lambiotte & Lefebvre 2008)
// on the undirected projection of a weighted graph.
export function louvain(N, edges, { seed = 7 } = {}) {
  let rng = seed;
  const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296);

  // adjacency as Map per node
  let adj = Array.from({ length: N }, () => new Map());
  for (const [s, t, w] of edges) {
    if (s === t) continue;
    const a = Math.abs(w);
    adj[s].set(t, (adj[s].get(t) || 0) + a);
    adj[t].set(s, (adj[t].get(s) || 0) + a);
  }
  let membership = Array.from({ length: N }, (_, i) => i); // original node -> community
  let n = N;
  let selfLoop = new Float64Array(n);

  for (let level = 0; level < 10; level++) {
    const k = new Float64Array(n);
    let m2 = 0;
    for (let i = 0; i < n; i++) {
      for (const w of adj[i].values()) k[i] += w;
      k[i] += selfLoop[i];
      m2 += k[i];
    }
    if (m2 === 0) break;
    const comm = Int32Array.from({ length: n }, (_, i) => i);
    const tot = Float64Array.from(k);
    let moved = true;
    let anyMove = false;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let pass = 0; pass < 20 && moved; pass++) {
      moved = false;
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (const i of order) {
        const ci = comm[i];
        const links = new Map();
        for (const [j, w] of adj[i]) links.set(comm[j], (links.get(comm[j]) || 0) + w);
        tot[ci] -= k[i];
        let best = ci;
        let bestGain = (links.get(ci) || 0) - (tot[ci] * k[i]) / m2;
        for (const [c, w] of links) {
          const gain = w - (tot[c] * k[i]) / m2;
          if (gain > bestGain + 1e-12) {
            bestGain = gain;
            best = c;
          }
        }
        tot[best] += k[i];
        if (best !== ci) {
          comm[i] = best;
          moved = true;
          anyMove = true;
        }
      }
    }
    if (!anyMove) break;
    // relabel and aggregate
    const relabel = new Map();
    for (let i = 0; i < n; i++) if (!relabel.has(comm[i])) relabel.set(comm[i], relabel.size);
    const n2 = relabel.size;
    const adj2 = Array.from({ length: n2 }, () => new Map());
    const self2 = new Float64Array(n2);
    for (let i = 0; i < n; i++) {
      const ci = relabel.get(comm[i]);
      self2[ci] += selfLoop[i];
      for (const [j, w] of adj[i]) {
        const cj = relabel.get(comm[j]);
        if (ci === cj) self2[ci] += w;
        else adj2[ci].set(cj, (adj2[ci].get(cj) || 0) + w);
      }
    }
    membership = membership.map((c) => relabel.get(comm[c]));
    adj = adj2;
    selfLoop = self2;
    n = n2;
  }
  return { membership, count: n, modularity: modularity(N, edges, membership) };
}

export function modularity(N, edges, membership) {
  const k = new Float64Array(N);
  let m2 = 0;
  const inside = new Map();
  for (const [s, t, w] of edges) {
    if (s === t) continue;
    const a = Math.abs(w);
    k[s] += a;
    k[t] += a;
    m2 += 2 * a;
    if (membership[s] === membership[t]) inside.set(membership[s], (inside.get(membership[s]) || 0) + 2 * a);
  }
  const tot = new Map();
  for (let i = 0; i < N; i++) tot.set(membership[i], (tot.get(membership[i]) || 0) + k[i]);
  let q = 0;
  for (const [c, t] of tot) q += (inside.get(c) || 0) / m2 - (t / m2) ** 2;
  return q;
}

// Brandes (2001) betweenness centrality, unweighted directed.
export function betweenness(N, edges) {
  const out = Array.from({ length: N }, () => []);
  for (const [s, t] of edges) out[s].push(t);
  const cb = new Float64Array(N);
  const sigma = new Float64Array(N);
  const dist = new Int32Array(N);
  const delta = new Float64Array(N);
  const preds = Array.from({ length: N }, () => []);
  const queue = new Int32Array(N);
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    sigma.fill(0);
    dist.fill(-1);
    delta.fill(0);
    for (const p of preds) p.length = 0;
    sigma[s] = 1;
    dist[s] = 0;
    let qh = 0, qt = 0, sp = 0;
    queue[qt++] = s;
    while (qh < qt) {
      const v = queue[qh++];
      stack[sp++] = v;
      for (const w of out[v]) {
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue[qt++] = w;
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          preds[w].push(v);
        }
      }
    }
    while (sp > 0) {
      const w = stack[--sp];
      for (const v of preds[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== s) cb[w] += delta[w];
    }
  }
  return cb;
}

// Dijkstra (1959) shortest path with cost = 1/|w| (strong synapses are "short").
export function shortestPath(N, edges, src, dst) {
  const out = Array.from({ length: N }, () => []);
  for (const [s, t, w, n] of edges) out[s].push([t, 1 / Math.log1p(n || Math.abs(w) * 100)]);
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  dist[src] = 0;
  const heap = new MinHeap();
  heap.push(0, src);
  while (heap.size) {
    const [d, v] = heap.pop();
    if (done[v]) continue;
    done[v] = 1;
    if (v === dst) break;
    for (const [t, c] of out[v]) {
      if (d + c < dist[t]) {
        dist[t] = d + c;
        prev[t] = v;
        heap.push(dist[t], t);
      }
    }
  }
  if (!isFinite(dist[dst])) return [];
  const path = [];
  for (let v = dst; v >= 0; v = prev[v]) path.unshift(v);
  return path;
}

// Watts & Strogatz (1998) local clustering coefficient, averaged, for an
// undirected adjacency list.
export function avgClustering(adj) {
  let sum = 0, n = 0;
  for (let i = 0; i < adj.length; i++) {
    const nb = adj[i];
    const k = nb.length;
    if (k < 2) continue;
    const set = new Set(nb);
    let links = 0;
    for (let a = 0; a < k; a++) for (const x of adj[nb[a]]) if (set.has(x)) links++;
    sum += links / (k * (k - 1));
    n++;
  }
  return n ? sum / n : 0;
}

export class UnionFind {
  constructor(n) {
    this.p = Int32Array.from({ length: n }, (_, i) => i);
    this.r = new Uint8Array(n);
  }
  find(x) {
    while (this.p[x] !== x) x = this.p[x] = this.p[this.p[x]];
    return x;
  }
  union(a, b) {
    a = this.find(a);
    b = this.find(b);
    if (a === b) return;
    if (this.r[a] < this.r[b]) [a, b] = [b, a];
    this.p[b] = a;
    if (this.r[a] === this.r[b]) this.r[a]++;
  }
}

export class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const { k, v } = this;
    const top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}
