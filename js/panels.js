// Side panels: tabs, live statistics, charts, the selected-fly card and citations.
import { MODE_NAMES } from "./sim.js";
import { GAMES, equilibria } from "./game.js";
import { CLASS_COLORS } from "./brainview.js";

export const MODE_COLORS = ["#7ddc8a", "#f2a541", "#ff4d6d", "#b388ff"];
const MODE_TEXT = [
  "cruising / goal-directed steering (DNa02)",
  "proboscis extension via MN9",
  "Giant Fiber + LPLC2 looming response",
  "octopamine, MDN and touch — contests & crowding",
];
export const swarmColor = (k) => `hsl(${(k * 137.508) % 360} 75% 60%)`;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "–");
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const kv = (rows) => rows.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join("");

function stackerLine(s) {
  const R = s.robots.find((r) => r.kind === "stacker");
  if (!R || !s.params.robots?.stacker) return "off";
  return `${R.stacked}/16 · ${R.completions} · ${R.knocked} · ${R.bestTime == null ? "–" : R.bestTime.toFixed(0) + " s"}`;
}

function netLine(s) {
  const R = s.robots.find((r) => r.kind === "net");
  if (!R || !s.params.robots?.net) return "off";
  return `${R.caught.length} · ${R.jarred} · ${R.escaped}`;
}

export class Panels {
  constructor({ sim, cx, analysis, refs, brain, onFollow, onDeselect }) {
    this.sim = sim;
    this.cx = cx;
    this.an = analysis;
    this.refs = refs;
    this.brain = brain;
    this.onFollow = onFollow;
    this.onDeselect = onDeselect;
    this.selected = -1;
    this.following = false;

    document.querySelectorAll(".tabs button").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
        document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + b.dataset.tab));
        this.update(this.selected);
        if (b.dataset.tab === "brain") this.brain.resize();
      })
    );
    document.querySelectorAll("#seg-brain button").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("#seg-brain button").forEach((x) => x.classList.toggle("on", x === b));
        this.brain.setMode(b.dataset.v);
        this.brainCaption();
      })
    );
    $("#btn-brain-full").addEventListener("click", () => {
      $("#brain-wrap").classList.toggle("full");
      this.brain.resize();
    });

    this.buildIoBars();
    this.staticGraph();
    this.about();
    this.brainCaption();
  }

  // ------------------------------------------------------------------ legend & fly card
  legend(mode) {
    const g = GAMES[this.sim().params.game];
    let html = "";
    if (mode === "strategy")
      html = `<span><i class="sw" style="background:var(--dove)"></i>${g.B}-leaning</span><span><i class="sw" style="background:var(--hawk)"></i>${g.A}-leaning</span><span>flash = contest just played</span>`;
    else if (mode === "swarm") html = `<span>colour = DBSCAN swarm</span><span><i class="sw" style="background:#6b7785"></i>noise</span>`;
    else if (mode === "health") html = `<span><i class="sw" style="background:hsl(120 85% 54%)"></i>unhurt</span><span><i class="sw" style="background:hsl(60 85% 43%)"></i>wounded</span><span><i class="sw" style="background:hsl(0 85% 32%)"></i>near death</span><span>white flash = hit</span>`;
    else if (mode === "mode") html = MODE_NAMES.map((m, i) => `<span><i class="sw" style="background:${MODE_COLORS[i]}"></i>${m}</span>`).join("");
    else html = `<span><i class="sw" style="background:hsl(0 75% 35%)"></i>starving</span><span><i class="sw" style="background:hsl(120 75% 60%)"></i>well fed</span>`;
    if (mode !== "health") html += `<span>darker = wounded</span>`;
    html += `<span><i class="sw" style="background:#f2a541"></i>sugar</span><span><i class="sw" style="background:#9a5cff"></i>bitter</span><span>◆ social-graph leader</span>`;
    $("#legend").innerHTML = html;
  }

  selectFly(i) {
    this.selected = i;
    this.following = false;
    this.onFollow(false);
    $("#flycard").classList.toggle("hidden", i < 0);
    this.brainCaption();
    this.update(i);
  }

  flyCard(i) {
    const s = this.sim();
    const tgt = s.target[i] >= 0 ? `patch ${s.target[i]}` : "none";
    const strat = s.disposition(i);
    const g = GAMES[s.params.game];
    const last = s.lastHawk[i] < 0 ? "–" : s.lastHawk[i] ? g.A : g.B;
    $("#flycard").innerHTML = `<span class="close" title="Deselect">✕</span>
      <b>Fly #${s.id[i]}</b> <span class="note">gen ${s.generation[i]}${s.parent[i] >= 0 ? ` · parent #${s.parent[i]}` : ""}</span>
      <div class="kv">${kv([
        ["health", `${Math.round(100 * Math.max(0, s.hp[i]))}%`],
        ["energy", fmt(s.energy[i], 1)],
        [`${g.A} disposition`, fmt(strat)],
        ["recent game payoff", s.played[i] ? fmt(s.payoff[i]) : "–"],
        ["octopamine (OA) activity", fmt(s.oa[i])],
        ["last contest", last],
        ["target", tgt],
        ["heuristic reason", esc(s.reason[i] || "–")],
        ["swarm (DBSCAN)", s.swarm[i] < 0 ? "noise" : "#" + s.swarm[i]],
        ["behaviour (k-means)", MODE_NAMES[s.mode[i]]],
        ["social degree", s.degree[i]],
        ["connectome gain", fmt(s.params.gain * s.gainGene[i], 1)],
      ])}</div>
      <button class="btn small wide" id="btn-follow">${this.following ? "Stop following" : "Follow with camera"}</button>`;
    $("#flycard .close").onclick = () => this.onDeselect();
    $("#btn-follow").onclick = () => {
      this.following = !this.following;
      this.onFollow(this.following);
      this.flyCard(i);
    };
  }

  // ------------------------------------------------------------------ brain tab
  brainCaption() {
    const m = this.brain.mode;
    const who = this.selected >= 0 ? `fly #${this.sim().id[this.selected]}` : "the whole swarm (mean)";
    const text = {
      activity: `Live activity of ${this.cx.N} FlyWire cell types in ${who}. Each dot is one of ${this.cx.meta.neurons.toLocaleString()} proofread neurons at its real position; it lights up with its cell type. Dark → red → yellow = rising activity. Orange edges excite, blue inhibit. White lines are the strongest sensorimotor paths.`,
      community: `Louvain communities (Blondel et al. 2008) of the reduced connectome: ${this.an.lv.count} modules, modularity Q = ${fmt(this.an.lv.modularity)}.`,
      pagerank: `PageRank (Page et al. 1999) of each cell type — warm colours are the hubs that signal flows into.`,
      class: `FlyWire super-classes (Schlegel et al. 2024): ${Object.entries(CLASS_COLORS)
        .filter(([k]) => k !== "unknown")
        .map(([k, c]) => `<span style="color:${c}">${k.replace("_", " ")}</span>`)
        .join(", ")}.`,
    }[m];
    $("#brain-caption").innerHTML = text;
  }

  buildIoBars() {
    const io = this.cx.io;
    this.ioDefs = [
      ["Senses → sensory neurons", null],
      ["sugar GRNs", io.sugar, "in"], ["bitter GRNs", io.bitter, "in"],
      ["ORNs (odour)", io.orn, "in"], ["LPLC2 (looming)", io.loom, "in"],
      ["JO (touch)", io.mech, "in"], ["PFL3 (A* goal)", io.pfl3, "in"],
      ["Descending / motor neurons", null],
      ["DNa02 left", [io.dna02[0]]], ["DNa02 right", [io.dna02[1]]],
      ["Giant Fiber", io.gf], ["MDN (backward)", io.mdn],
      ["DNp09 (forward)", io.p9], ["MN9 (proboscis)", io.mn9],
      ["OA- neurons", this.cx.oa],
    ];
    $("#io-bars").innerHTML = this.ioDefs
      .map(([l, nodes, kind], k) =>
        nodes ? `<div class="bar ${kind || ""}"><div class="lbl">${l}<b id="iov${k}">0</b></div><div class="track"><div class="fill" id="iof${k}"></div></div></div>` : `<div class="io-head">${l}</div>`
      )
      .join("");
  }

  updateIo(i) {
    const s = this.sim(), N = this.cx.N, R = s.brains.R;
    // per fly: strongest member for small groups (left/right pairs), mean for big ones (OA- types)
    const stat = (f, nodes) => {
      let m = 0, sum = 0, c = 0;
      for (const node of nodes) {
        if (node < 0) continue;
        const r = R[f * N + node];
        m = Math.max(m, r);
        sum += r;
        c++;
      }
      return nodes.length > 2 ? (c ? sum / c : 0) : m;
    };
    this.ioDefs.forEach(([, nodes], k) => {
      if (!nodes) return;
      let v = 0;
      if (i >= 0) v = stat(i, nodes);
      else {
        for (let f = 0; f < s.n; f++) v += stat(f, nodes);
        v /= s.n || 1;
      }
      $(`#iov${k}`).textContent = fmt(v);
      $(`#iof${k}`).style.width = `${Math.min(100, v * 100)}%`;
    });
  }

  // ------------------------------------------------------------------ graphs tab (static parts)
  staticGraph() {
    const cx = this.cx, an = this.an, m = cx.meta;
    $("#cx-stats").innerHTML = kv([
      ["FlyWire neurons (v783)", m.neurons.toLocaleString()],
      ["synapses in edge list", m.synaptic_connections.toLocaleString()],
      ["neuron-to-neuron edges", m.edges_full.toLocaleString()],
      ["cell-type × side groups", m.groups_full.toLocaleString()],
      ["nodes simulated per fly", cx.N],
      ["edges simulated per fly", cx.edges.length.toLocaleString()],
      ["excitatory edges", `${Math.round((100 * an.exc) / cx.edges.length)}%`],
      ["density", fmt(an.density, 4)],
      ["Louvain modules / Q", `${an.lv.count} / ${fmt(an.lv.modularity)}`],
    ]);
    const name = (i) => esc(cx.nodes[i].id.replace("|", " "));
    $("#top-pr").innerHTML = an.prOrder.slice(0, 8).map((i) => `<li>${name(i)} <span>${fmt(an.pr[i] * 1000, 1)}‰</span></li>`).join("");
    $("#top-bc").innerHTML = an.bcOrder.slice(0, 8).map((i) => `<li>${name(i)} <span>${Math.round(an.bc[i])}</span></li>`).join("");
    $("#paths").innerHTML = an.pairs
      .map(
        (p) =>
          `<div class="path"><div class="note" style="margin:4px 0 2px">${esc(p.label)} · ${p.path.length - 1} hops</div>${p.path
            .map((i) => `<span class="hop">${name(i)}</span>`)
            .join('<span class="arrow">→</span>')}</div>`
      )
      .join("");

    // Louvain modules: list the biggest with a few member types
    const groups = new Map();
    an.lv.membership.forEach((c, i) => {
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(i);
    });
    const top = [...groups.values()].sort((a, b) => b.length - a.length).slice(0, 8);
    $("#louvain").innerHTML =
      `<p class="note">${an.lv.count} modules, Q = ${fmt(an.lv.modularity)}. Largest modules with their highest-PageRank members:</p>` +
      top
        .map((mem) => {
          const c = an.lv.membership[mem[0]];
          const col = `hsl(${((c * 0.618) % 1) * 360} 75% 58%)`;
          const best = mem.sort((a, b) => an.pr[b] - an.pr[a]).slice(0, 4).map(name).join(", ");
          return `<div class="chips" style="margin:4px 0"><span class="chip" style="border-color:${col}">${mem.length} types</span> <span class="note" style="margin:0">${best}</span></div>`;
        })
        .join("");
  }

  // ------------------------------------------------------------------ live updates
  update(selected) {
    this.selected = selected;
    const s = this.sim();
    if (selected >= 0 && selected < s.n) this.flyCard(selected);
    const tab = document.querySelector(".tabs button.on")?.dataset.tab;
    if (tab === "brain") this.updateIo(selected);
    if (tab === "game") this.updateGame();
    if (tab === "graph") this.updateGraph();
    if (tab === "cluster") this.updateCluster();
  }

  updateGame() {
    const s = this.sim(), P = s.params, g = GAMES[P.game];
    const m = g.matrix(P.V, P.C);
    const cell = (a, b) => `${fmt(a, 1)}, ${fmt(b, 1)}`;
    $("#payoff").innerHTML = `<table class="payoff">
      <tr><th>${g.name}</th><th>vs ${g.A}</th><th>vs ${g.B}</th></tr>
      <tr><th>${g.A}</th><td>${cell(m[0][0], m[0][0])}</td><td>${cell(m[0][1], m[1][0])}</td></tr>
      <tr><th>${g.B}</th><td>${cell(m[1][0], m[0][1])}</td><td>${cell(m[1][1], m[1][1])}</td></tr></table>`;
    $("#game-about").textContent = g.about;
    const eq = equilibria(m);
    const show = (xs) => (xs.length ? xs.map((x) => fmt(x)).join(", ") : "none");
    const st = s.stats;
    const total = st.hh + st.hd + st.dd || 1;
    const [a, b] = [g.A[0], g.B[0]];
    $("#game-stats").innerHTML = kv([
      [`stable ${g.A} shares (ESS)`, show(eq.stable)],
      ["unstable rest points", show(eq.unstable)],
      [`${g.A} share played (recent)`, fmt(s.stats.played())],
      [`mean ${g.A} disposition`, fmt(s.meanHawk())],
      ["replicator-equation prediction", fmt(s.theoryX)],
      ["contests · imitations", `${st.contests.toLocaleString()} · ${s.events.imitate.toLocaleString()}`],
      [`${a}${a} / ${a}${b} / ${b}${b}`, `${Math.round((100 * st.hh) / total)}% / ${Math.round((100 * st.hd) / total)}% / ${Math.round((100 * st.dd) / total)}%`],
      [`corr(octopamine, ${g.A})`, fmt(st.oaCorrelation())],
      ["deaths: fights / starved / old", `${s.deaths.fights} / ${s.deaths.starved} / ${s.deaths.old}`],
      ["killed by bird / dragonflies", `${s.deaths.eaten} / ${s.deaths.bitten}`],
      ["robot kills: picked / net / shot / swatted", `${s.deaths.picked} / ${s.deaths.netted} / ${s.deaths.shot} / ${s.deaths.swatted}`],
      ["stacker: stack · done · knocked · best", stackerLine(s)],
      ["net: in the bag · jarred · escaped", netLine(s)],
      ["births · max generation", `${s.births} · ${Math.max(...s.generation.slice(0, s.n))}`],
    ]);
    this.chartHawk();
  }

  chartHawk() {
    const s = this.sim(), cv = $("#chart-hawk");
    const ctx = setupCanvas(cv);
    const W = cv.clientWidth, H = cv.clientHeight;
    const hist = s.history;
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 28, r: 6, t: 8, b: 18 };
    const X = (k) => pad.l + ((W - pad.l - pad.r) * k) / Math.max(1, hist.length - 1);
    const Y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v);
    ctx.strokeStyle = css("--line");
    ctx.fillStyle = css("--muted");
    ctx.font = "10px Inter, sans-serif";
    ctx.lineWidth = 1;
    for (const v of [0, 0.5, 1]) {
      ctx.beginPath();
      ctx.moveTo(pad.l, Y(v));
      ctx.lineTo(W - pad.r, Y(v));
      ctx.stroke();
      ctx.fillText(v.toFixed(1), 4, Y(v) + 3);
    }
    ctx.fillText(`${Math.round(hist.length ? hist.at(-1).t - hist[0].t : 0)} s`, W - 40, H - 4);
    const line = (key, color, dash = [], width = 2) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      hist.forEach((h, k) => (k ? ctx.lineTo(X(k), Y(h[key])) : ctx.moveTo(X(k), Y(h[key]))));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line("ess", css("--muted"), [2, 3], 1);
    if (hist.length && hist.at(-1).threshold != null) line("threshold", "rgba(255,255,255,0.35)", [1, 4], 1);
    line("theory", css("--accent-2"), [6, 4], 1.5);
    line("observed", "rgba(255,107,74,0.45)", [], 1.5);
    line("played", css("--hawk"), [], 2.2);
    const g = GAMES[s.params.game];
    $("#hawk-legend").innerHTML = `<span><i style="background:var(--hawk)"></i>${g.A} share played</span><span><i style="background:rgba(255,107,74,.45)"></i>mean disposition</span><span><i style="background:var(--accent-2)"></i>replicator equation</span><span><i style="background:var(--muted)"></i>ESS it is heading to</span>${hist.at(-1)?.threshold != null ? `<span><i style="background:rgba(255,255,255,.35)"></i>tipping point</span>` : ""}`;
  }

  updateGraph() {
    const s = this.sim(), so = s.social, a = s.astarStats;
    $("#social-stats").innerHTML = kv([
      ["proximity radius", `${s.params.socialRadius} units`],
      ["edges", so.edges],
      ["mean degree", fmt(so.avgDegree, 1)],
      ["connected components (union-find)", so.components],
      ["giant component", `${so.giant} flies`],
      ["clustering coefficient", fmt(so.clustering)],
      ["leaders (max-degree per component)", so.leaders.length],
    ]);
    const save = a.dijkstra ? 1 - a.astar / a.dijkstra : 0;
    $("#astar-stats").innerHTML = kv([
      ["grid", `${s.grid.res} × ${s.grid.res}, 8-connected`],
      ["heuristic", "octile distance (admissible)"],
      ["routes planned", s.events.astar.toLocaleString()],
      ["mean cells expanded: A*", a.samples ? fmt(a.astar / a.samples, 0) : "–"],
      ["mean cells expanded: Dijkstra", a.samples ? fmt(a.dijkstra / a.samples, 0) : "–"],
      ["work saved by the heuristic", `${Math.round(save * 100)}%`],
    ]);
  }

  updateCluster() {
    const s = this.sim(), sw = s.swarms;
    const sizes = [...sw.sizes].sort((a, b) => b - a);
    $("#db-stats").innerHTML = kv([
      ["ε / minPts", `${s.params.dbEps} / ${s.params.dbMin}`],
      ["swarms", sw.count],
      ["flies in swarms", s.n - sw.noise],
      ["noise (solitary)", sw.noise],
      ["largest swarm", sizes[0] || 0],
      ["predator targets", sw.biggest ? `swarm of ${sw.biggest.size}` : "–"],
    ]);
    // swarm sizes coloured by their mean disposition toward the selfish option
    const cv = $("#chart-swarms"), ctx = setupCanvas(cv);
    const W = cv.clientWidth, H = cv.clientHeight;
    ctx.clearRect(0, 0, W, H);
    const order = sw.sizes.map((n, k) => k).sort((a, b) => sw.sizes[b] - sw.sizes[a]).slice(0, 24);
    const max = Math.max(1, ...sw.sizes);
    const bw = (W - 10) / Math.max(order.length, 8);
    order.forEach((k, j) => {
      const h = ((H - 22) * sw.sizes[k]) / max;
      const t = sw.hawk[k];
      ctx.fillStyle = `rgb(${Math.round(99 + 156 * t)},${Math.round(212 - 105 * t)},${Math.round(255 - 181 * t)})`;
      ctx.fillRect(5 + j * bw, H - 14 - h, bw - 3, h);
    });
    ctx.fillStyle = css("--muted");
    ctx.font = "10px Inter, sans-serif";
    ctx.fillText(`swarm sizes (bar colour = mean ${GAMES[s.params.game].A} disposition)`, 4, H - 2);

    const total = s.n || 1;
    $("#modes").innerHTML = MODE_NAMES.map(
      (m, i) => `<div class="mode-row"><span style="color:${MODE_COLORS[i]}">${m}</span><div class="track"><div class="fill" style="width:${(100 * s.modeCounts[i]) / total}%;background:${MODE_COLORS[i]}"></div></div><span class="n">${s.modeCounts[i]}</span></div><div class="note" style="margin:-2px 0 6px 98px">${MODE_TEXT[i]}</div>`
    ).join("");
  }

  // ------------------------------------------------------------------ citations
  about() {
    const R = this.refs;
    const cite = (key) => {
      const r = R[key];
      if (!r) return "";
      const a = r.authors;
      const short = a.length > 8 ? `${a.slice(0, 6).join(", ")}, … ${a.at(-1)}` : a.join(", ");
      const link = r.doi ? `https://doi.org/${r.doi}` : r.url;
      const full = a.length > 8 ? `<details><summary>all ${a.length} authors</summary>${esc(a.join(", "))}</details>` : "";
      return `<li id="ref-${key}"><span class="authors">${esc(short)}</span> (${r.year}). <i>${esc(r.title)}</i>. ${esc(r.venue)}. ${link ? `<a href="${link}" target="_blank" rel="noopener">${r.doi ? "doi:" + esc(r.doi) : "link"}</a>` : ""}${full}</li>`;
    };
    const group = (title, keys) => `<div class="grp"><h4>${title}</h4><ol class="refs">${keys.map(cite).join("")}</ol></div>`;
    const m = this.cx.meta;
    $("#about").innerHTML = `
      <h4 style="margin-top:4px">What you are looking at</h4>
      <p>A swarm of simulated flies, entirely in your browser — no server. Each fly carries its own copy of a
      <b>${this.cx.N}-node, ${this.cx.edges.length.toLocaleString()}-edge</b> reduction of the FlyWire whole-brain connectome
      (${m.neurons.toLocaleString()} neurons, ${m.synaptic_connections.toLocaleString()} synapses). Nodes are FlyWire cell types split
      by hemisphere; edges are summed, signed synapse counts (acetylcholine excitatory; GABA and glutamate inhibitory),
      following the convention of Shiu et al. (2024).</p>
      <p><b>Senses → connectome → body.</b> Sugar on a patch drives sugar gustatory receptor neurons; the connectome carries this to the
      MN9 proboscis motor neuron, and the fly only gains energy in proportion to MN9 activity (the sugar → MN9 result of Shiu et al. 2024).
      A diving predator drives LPLC2 looming detectors → Giant Fiber → take-off (von Reyn et al. 2014; Ache et al. 2019).
      The heuristic layer's chosen direction is injected into PFL3, which steers through DNa02 (Westeinde et al. 2024; Mussells Pires et al. 2024).
      Jostling drives Johnston's organ neurons → MDN backing up (Bidaye et al. 2014). Octopaminergic cell types bias the fly toward the selfish option in the chosen game (Hoyer et al. 2008; Zhou, Rao &amp; Rao 2008).</p>
      <p><b>Games and learning.</b> Flies on food play Hawk–Dove, the Prisoner's Dilemma or the Stag Hunt with expected payoffs. Every ~8 s a fly
      compares its recent payoff with a graph neighbour's (or anyone's) and copies that fly's disposition with the Fermi probability
      (Traulsen, Nowak &amp; Pacheco 2006); births are proportional to energy. Losers are jostled but not chased off, and payoffs are scaled
      so one contest rarely kills: both choices keep pairings random and avoid survivorship bias, so the replicator-equation
      predictions remain a fair yardstick.</p>
      <p><b>Honest limitations.</b> This is an illustration, not a biophysical model. The reduction lumps neurons by cell type, keeps the
      strongest ~15 inputs per node, and replaces spiking neurons with a 4-hop rate propagation so hundreds of brains can run in a background Web Worker.
      Lumping removes the sparse coding of the real olfactory system, so odour only sets arousal here; odour-guided search is done by
      the heuristic layer. Game, heuristic and clustering layers are deliberately simple textbook algorithms. A reflex layer prevents collisions.</p>
      <p><b>Data.</b> Connectivity: FlyWire v783 via the edge list published with Shiu et al. (2024) (MIT licence; FlyWire data CC BY 4.0).
      Neuron positions, super-classes and cell types: FlyWire annotations (Schlegel et al. 2024, with updates from Matsliah et al. 2024,
      Berg et al. 2026 and Tastekin et al. 2026, as the maintainers ask). The reduction script is in <code>tools/build_data.py</code>.
      FlyWire was built by the FlyWire Consortium — hundreds of proofreaders, annotators and scientists listed in the papers below.</p>
      ${group("FlyWire connectome & data", ["dorkenwald2024", "schlegel2024", "matsliah2024", "lin2024", "eckstein2024", "buhmann2021", "zheng2018", "berg2026", "tastekin2026", "flywire_zenodo", "flywire_annotations"])}
      ${group("Whole-brain model this builds on", ["shiu2024", "shiu_code"])}
      ${group("Circuits used for behaviour", ["vonreyn2014", "ache2019", "bidaye2014", "bidaye2020", "westeinde2024", "mussellspires2024", "hoyer2008", "zhou2008"])}
      ${group("Game theory", ["maynardsmith1973", "maynardsmith1982", "taylor1978", "hofbauer1998", "nash1950", "traulsen2006", "nowak1992", "hauert2004", "lieberman2005", "ohtsuki2006", "hamilton1971"])}
      ${group("Heuristics", ["hart1968", "gigerenzer1996", "simon1955", "charnov1976", "reynolds1987"])}
      ${group("Graph theory", ["dijkstra1959", "page1999", "brandes2001", "watts1998", "blondel2008", "newman2004"])}
      ${group("Clustering", ["ester1996", "lloyd1982", "arthur2007", "aloise2009"])}
      ${group("Software", ["threejs"])}`;
  }
}

function setupCanvas(cv) {
  const dpr = Math.min(2, devicePixelRatio);
  const w = cv.clientWidth, h = cv.clientHeight || +cv.getAttribute("height");
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
