// One-off graph analysis of the reduced connectome, run in the browser at start-up.
import { pagerank, betweenness, louvain, shortestPath } from "./graph.js";

export function analyseConnectome(cx) {
  const N = cx.N;
  const pr = pagerank(N, cx.edges);
  const bc = betweenness(N, cx.edges);
  const lv = louvain(N, cx.edges);
  const inDeg = new Int32Array(N), outDeg = new Int32Array(N);
  for (const [s, t] of cx.edges) {
    outDeg[s]++;
    inDeg[t]++;
  }
  let exc = 0;
  for (const e of cx.edges) if (e[2] > 0) exc++;

  const io = cx.io;
  const pairs = [
    { label: "Sugar taste → proboscis (feeding)", src: io.sugar[1], dst: io.mn9[1] },
    { label: "Looming → Giant Fiber (escape)", src: io.loom[0], dst: io.gf[0] },
    { label: "Goal (PFL3) → DNa02 (steering)", src: io.pfl3[0], dst: io.dna02[1] },
    { label: "Touch (JO) → MDN (backing up)", src: io.mech[0], dst: io.mdn[0] },
    { label: "Bitter taste → octopamine (arousal)", src: io.bitter[0], dst: strongestOA(cx, io.bitter[0]) },
  ].filter((p) => p.src >= 0 && p.dst >= 0);
  for (const p of pairs) p.path = shortestPath(N, cx.edges, p.src, p.dst);

  const rank = (arr) => [...arr.keys()].sort((a, b) => arr[b] - arr[a]);
  return {
    pr, bc, lv, inDeg, outDeg, exc, pairs,
    prOrder: rank(pr),
    bcOrder: rank(bc),
    density: cx.edges.length / (N * (N - 1)),
  };
}

function strongestOA(cx, src) {
  // the octopaminergic cell type reachable in the fewest strong hops
  let best = -1, bestLen = Infinity;
  for (const o of cx.oa) {
    const p = shortestPath(cx.N, cx.edges, src, o);
    if (p.length && p.length < bestLen) {
      best = o;
      bestLen = p.length;
    }
  }
  return best;
}
