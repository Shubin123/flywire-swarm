// Concept map: the five ideas and all ten links between them, each tied to a
// live quantity in the running simulation.
import { essHawk } from "./game.js";

const NODES = [
  { id: "cx", label: "Connectome", color: "#f2a541",
    text: "Each fly runs a reduced copy of the FlyWire v783 whole-brain wiring diagram: cell types as nodes, signed synapse counts as edges. Senses enter through sensory neurons; behaviour leaves through descending and motor neurons.",
    refs: ["dorkenwald2024", "schlegel2024", "shiu2024"] },
  { id: "graph", label: "Graph theory", color: "#5cc8ff",
    text: "Two graphs are analysed live: the connectome (PageRank, betweenness, Louvain communities, Dijkstra paths) and the swarm's social proximity graph (degree, components via union-find, clustering coefficient, leaders).",
    refs: ["page1999", "brandes2001", "dijkstra1959", "watts1998"] },
  { id: "cluster", label: "Clustering", color: "#7ddc8a",
    text: "DBSCAN finds swarms in space; k-means++ finds behavioural modes in neural-activity space; Louvain finds modules in the connectome.",
    refs: ["ester1996", "arthur2007", "lloyd1982", "blondel2008"] },
  { id: "game", label: "Game theory", color: "#ff6b4a",
    text: "Flies that meet on food play Hawk–Dove. Reproduction in proportion to energy makes the population follow replicator dynamics toward the evolutionarily stable hawk share V/C.",
    refs: ["maynardsmith1973", "taylor1978", "maynardsmith1982"] },
  { id: "heur", label: "Heuristics", color: "#b388ff",
    text: "Flies choose patches with take-the-best, travel with A* on an occupancy grid, and leave when intake falls below an aspiration level (satisficing / marginal value theorem).",
    refs: ["gigerenzer1996", "hart1968", "simon1955", "charnov1976"] },
];

const LINKS = [
  { a: "cx", b: "graph", title: "A connectome is a graph",
    text: "The wiring diagram is a weighted directed graph, so centrality, communities and shortest paths become statements about the brain. Lin et al. (2024) did this for the whole FlyWire connectome; here the same tools run on the reduced copy, and Dijkstra's strongest paths are drawn in the brain view.",
    live: (s, an, cx) => `top PageRank: ${cx.nodes[an.prOrder[0]].id.replace("|", " ")} · sugar→MN9 path: ${an.pairs[0]?.path.length - 1} hops`,
    refs: ["lin2024", "page1999", "dijkstra1959"], events: [] },
  { a: "cx", b: "cluster", title: "Cell types are clusters; behaviour is a cluster of neural states",
    text: "FlyWire cell types were defined by clustering neurons on morphology and connectivity (Schlegel et al. 2024; Matsliah et al. 2024) — every node in this model is such a cluster. In the other direction, k-means on each fly's descending-neuron activity recovers behavioural modes, and the predator dives at the largest DBSCAN swarm, which LPLC2 → Giant Fiber must then escape.",
    live: (s) => `behaviour modes now: ${s.modeCounts.join(" / ")} · escapes: ${s.events.escape}`,
    refs: ["schlegel2024", "matsliah2024", "arthur2007", "hamilton1971"], events: ["escape"] },
  { a: "cx", b: "game", title: "Strategy is read out of the brain",
    text: "The probability of playing Hawk is the fly's heritable disposition plus the activity of octopaminergic (OA-) cell types in its own connectome; octopamine promotes aggression in flies. Hunger (odour drive), bitter taste and looming threats raise OA activity, so physiology shifts the game.",
    live: (s) => `corr(OA activity, chose Hawk) = ${s.stats.oaCorrelation().toFixed(2)}`,
    refs: ["hoyer2008", "zhou2008"], events: ["contest"] },
  { a: "cx", b: "heur", title: "Heuristics are executed by circuits",
    text: "The heuristic layer only chooses a direction. That goal is injected into PFL3 neurons, which in the FlyWire connectome drive the DNa02 steering neurons (which PFL3 hemisphere drives which DNa02 is measured from the wiring at start-up) — so every turn toward food passes through real synapses, and silencing PFL3 or DNa02 breaks navigation.",
    live: (s) => `${countGoal(s)} flies are steering toward an A* waypoint through PFL3 → DNa02`,
    refs: ["westeinde2024", "mussellspires2024"], events: ["astar"] },
  { a: "graph", b: "cluster", title: "Communities are graph clusters",
    text: "Louvain clusters the connectome by maximising modularity. A DBSCAN cluster is a connected component of the ε-neighbourhood graph among core points, plus the border points attached to them — so with the same radius, swarms and social-graph components are two views of one structure.",
    live: (s) => `${s.social.components} social-graph components vs ${s.swarms.count} DBSCAN swarms (+${s.swarms.noise} noise)`,
    refs: ["blondel2008", "newman2004", "ester1996"], events: [] },
  { a: "graph", b: "game", title: "Who plays whom is a graph",
    text: "Contests only happen between flies that are neighbours in the proximity graph. Evolutionary graph theory shows that the structure of such interaction graphs changes which strategies win.",
    live: (s) => `${s.stats.contests.toLocaleString()} contests along social edges · mean degree ${s.social.avgDegree.toFixed(1)}`,
    refs: ["nowak1992", "lieberman2005", "ohtsuki2006"], events: ["contest"] },
  { a: "graph", b: "heur", title: "A* is a heuristic graph search",
    text: "Routes are shortest paths on an 8-connected grid graph. A* adds an admissible distance heuristic to Dijkstra's algorithm, returning the same optimal path while expanding far fewer nodes.",
    live: (s) => {
      const a = s.astarStats;
      return a.samples ? `A* expands ${Math.round((100 * a.astar) / a.dijkstra)}% of the cells Dijkstra expands` : "sampling…";
    },
    refs: ["hart1968", "dijkstra1959"], events: ["astar"] },
  { a: "cluster", b: "game", title: "Crowding sets the stakes",
    text: "Dense swarms on a patch mean more contests per fly and attract the predator (Hamilton's selfish herd). The swarm-size bar chart is coloured by each swarm's mean hawk disposition.",
    live: (s) => {
      const sw = s.swarms;
      if (!sw.count) return "no swarms right now";
      const k = sw.sizes.indexOf(Math.max(...sw.sizes));
      return `largest swarm: ${sw.sizes[k]} flies, mean hawk disposition ${sw.hawk[k].toFixed(2)}`;
    },
    refs: ["hamilton1971", "ester1996"], events: ["contest"] },
  { a: "cluster", b: "heur", title: "Clustering is itself a heuristic",
    text: "Optimal k-means is NP-hard, so Lloyd's iteration with k-means++ seeding is a heuristic with guarantees. The flies use cluster information heuristically too: 'fewer rivals' is the second cue in their take-the-best patch choice.",
    live: (s) => `${countReason(s, "fewer rivals")} flies chose their patch because it had fewer rivals`,
    refs: ["aloise2009", "lloyd1982", "arthur2007", "gigerenzer1996"], events: [] },
  { a: "game", b: "heur", title: "Bounded rationality reaches the equilibrium",
    text: "No fly computes a Nash equilibrium. Each follows a fixed rule shaped by inheritance and its brain state, yet selection drives the population to the ESS — the game-theoretic answer emerges from simple heuristics.",
    live: (s) => `hawk share played ${(s.history.at(-1)?.played ?? 0).toFixed(2)} vs ESS V/C = ${essHawk(s.params.V, s.params.C).toFixed(2)}`,
    refs: ["simon1955", "nash1950", "maynardsmith1973", "hofbauer1998"], events: ["birth"] },
];

const countGoal = (s) => {
  let c = 0;
  for (let i = 0; i < s.n; i++) if (s.path[i]) c++;
  return c;
};
const countReason = (s, r) => {
  let c = 0;
  for (let i = 0; i < s.n; i++) if (s.reason[i] === r) c++;
  return c;
};

const SVGNS = "http://www.w3.org/2000/svg";

export class IdeasMap {
  constructor(svg, detail, { sim, cx, analysis, refs }) {
    this.svg = svg;
    this.detail = detail;
    this.sim = sim;
    this.cx = cx;
    this.an = analysis;
    this.refs = refs;
    this.lastEvents = {};
    this.current = { kind: "node", item: NODES[0] };

    const cxp = 200, cyp = 184, R = 136;
    const pos = {};
    NODES.forEach((n, k) => {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / NODES.length;
      pos[n.id] = [cxp + R * Math.cos(a), cyp + R * Math.sin(a)];
    });
    this.pos = pos;
    for (const l of LINKS) {
      const [x1, y1] = pos[l.a], [x2, y2] = pos[l.b];
      const line = el("line", { x1, y1, x2, y2, class: "edge", "stroke-width": 2 });
      const hit = el("line", { x1, y1, x2, y2, class: "edge-hit" });
      hit.addEventListener("click", () => this.show("link", l));
      hit.addEventListener("mouseenter", () => line.classList.add("on"));
      hit.addEventListener("mouseleave", () => line.classList.toggle("on", this.current.item === l));
      l.el = line;
      svg.append(line, hit);
    }
    for (const n of NODES) {
      const g = el("g", { class: "node", transform: `translate(${pos[n.id][0]},${pos[n.id][1]})` });
      g.append(el("circle", { r: 40, stroke: n.color }));
      const words = n.label.split(" ");
      words.forEach((w, k) => {
        const t = el("text", { y: 4 + (k - (words.length - 1) / 2) * 13 });
        t.textContent = w;
        g.append(t);
      });
      g.addEventListener("click", () => this.show("node", n));
      n.el = g;
      svg.append(g);
    }
    this.show("node", NODES[0]);
  }

  show(kind, item) {
    this.current = { kind, item };
    for (const l of LINKS) l.el.classList.toggle("on", l === item);
    for (const n of NODES) n.el.classList.toggle("on", n === item);
    this.render();
  }

  render() {
    const { kind, item } = this.current;
    const refs = item.refs.map((k) => this.cite(k)).join("; ");
    if (kind === "node") {
      const links = LINKS.filter((l) => l.a === item.id || l.b === item.id);
      this.detail.innerHTML = `<h4 style="color:${item.color}">${item.label}</h4><p>${item.text}</p>
        <div class="note">Linked to: ${links.map((l) => `<a href="#" data-l="${LINKS.indexOf(l)}">${l.title}</a>`).join(" · ")}</div>
        <div class="refs">${refs}</div>`;
      this.detail.querySelectorAll("a[data-l]").forEach((a) =>
        a.addEventListener("click", (e) => {
          e.preventDefault();
          this.show("link", LINKS[+a.dataset.l]);
        })
      );
    } else {
      const A = NODES.find((n) => n.id === item.a), B = NODES.find((n) => n.id === item.b);
      this.detail.innerHTML = `<h4><span style="color:${A.color}">${A.label}</span> ↔ <span style="color:${B.color}">${B.label}</span>: ${item.title}</h4>
        <p>${item.text}</p><div class="live">▶ ${item.live(this.sim(), this.an, this.cx)}</div><div class="refs">${refs}</div>`;
    }
  }

  cite(key) {
    const r = this.refs[key];
    if (!r) return key;
    const a = r.authors;
    const who = a.length === 1 ? a[0].split(" ").at(-1) : a.length === 2 ? `${a[0].split(" ").at(-1)} & ${a[1].split(" ").at(-1)}` : `${a[0].split(" ").at(-1)} et al.`;
    const link = r.doi ? `https://doi.org/${r.doi}` : r.url;
    return `<a href="${link}" target="_blank" rel="noopener">${who} ${r.year}</a>`;
  }

  // edge thickness follows how often each link fired since the last update
  update() {
    const s = this.sim();
    const ev = s.events;
    const delta = {};
    for (const k in ev) {
      delta[k] = ev[k] - (this.lastEvents[k] ?? ev[k]);
      this.lastEvents[k] = ev[k];
    }
    for (const l of LINKS) {
      const d = l.events.reduce((a, k) => a + Math.max(0, delta[k] || 0), 0);
      l.el.setAttribute("stroke-width", (2 + Math.min(6, Math.log1p(d) * 1.6)).toFixed(1));
    }
    if (this.svg.closest(".tab.on") && this.current.kind === "link") {
      const live = this.detail.querySelector(".live");
      if (live) live.textContent = "▶ " + this.current.item.live(s, this.an, this.cx);
    }
  }
}

function el(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
