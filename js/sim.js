// The swarm simulation. Pure logic (no DOM / three.js) so it can be tested headless.
//
// Every fly carries its own copy of the reduced FlyWire connectome (BrainPool).
// Senses -> sensory neurons -> connectome -> descending/motor neurons -> body.
// On top of that sit four other layers that read from and write to each other:
//   heuristics  (take-the-best patch choice, A* routes, satisficing leave rule)
//   game theory (Hawk-Dove contests on food, birth-death selection ~ replicator dynamics)
//   graph theory (social proximity graph, connectome centrality & communities)
//   clustering  (DBSCAN swarms, k-means behavioural modes from neural activity)

import { BrainPool } from "./connectome.js";
import { NavGrid, takeTheBest, shouldLeave } from "./heuristics.js";
import { SpatialHash, dbscan, kmeans } from "./cluster.js";
import { GAMES, payoffs, replicatorStep, attractor, equilibria, GameStats } from "./game.js";
import { UnionFind, avgClustering } from "./graph.js";
import { makeRobots, updateRobots, robotLooms } from "./robots.js";

export const ARENA = 120;
export const CORPSE_LIFE = 6; // seconds a dead fly's body stays on the floor
const DT = 1 / 30;
const TAU = Math.PI * 2;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function mulberry32(a) {
  const rng = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.state = (v) => (v === undefined ? a : (a = v)); // read or restore, for snapshots
  return rng;
}

export const MODE_NAMES = ["Foraging", "Feeding", "Escaping", "Aroused"];

export class Sim {
  constructor(cx, opts = {}) {
    this.cx = cx;
    this.cap = 400;
    this.n = opts.flies ?? 220;
    this.params = {
      game: "hawkdove",
      V: 2, // first payoff parameter (value of the food bout in Hawk-Dove)
      C: 5, // second payoff parameter (cost of fighting in Hawk-Dove)
      mutation: 0.25,
      selection: 2, // intensity of selection in payoff comparisons
      learnFrom: "neighbours", // copy strategies from social-graph neighbours or from anyone
      payoffEnergy: 0.3, // energy gained per unit of game payoff
      predator: true,
      chasers: 2, // dragonflies that run down single flies, preferring the wounded
      robots: { picker: true, net: true, shooter: true, stacker: true }, // see robots.js
      gain: 9,
      aspiration: 0.12, // satisficing intake threshold
      socialRadius: 3.5,
      dbEps: 3.5,
      dbMin: 4,
      k: 4,
      ...opts.params,
    };
    this.silenced = new Set();
    this.rng = mulberry32(opts.seed ?? 20241002);
    this.t = 0;
    this.tick = 0;
    this.births = 0;
    this.deaths = { starved: 0, old: 0, fights: 0, eaten: 0, bitten: 0, picked: 0, netted: 0, shot: 0, swatted: 0 };

    this.brains = new BrainPool(cx, this.cap);
    this.calibrate();

    // world layout
    const R = this.rng;
    this.obstacles = [];
    while (this.obstacles.length < 7) {
      const o = { x: (R() - 0.5) * ARENA * 0.75, z: (R() - 0.5) * ARENA * 0.75, r: 2.5 + R() * 3.5 };
      if (Math.hypot(o.x, o.z) > 12 && this.obstacles.every((p) => Math.hypot(p.x - o.x, p.z - o.z) > p.r + o.r + 8))
        this.obstacles.push(o);
    }
    this.patches = [];
    for (let i = 0; i < 9; i++) this.patches.push(this.newPatch({ bitter: false }));
    for (let i = 0; i < 3; i++) this.patches.push(this.newPatch({ bitter: true }));
    this.grid = new NavGrid(ARENA, 60, this.obstacles);
    this.predator = { x: 0, y: 30, z: 0, vx: 0, vy: 0, vz: 0, mode: "patrol", timer: 6, tx: 0, tz: 0, kills: 0 };
    this.chasers = [];
    this.robots = makeRobots(this, R);
    this.balls = [];

    // fly state (structure of arrays)
    const c = this.cap;
    const F32 = () => new Float32Array(c);
    Object.assign(this, {
      x: F32(), z: F32(), y: F32(), h: F32(), speed: F32(), vy: F32(), energy: F32(), age: F32(), life: F32(),
      hp: F32(), hurt: F32(), // body integrity 0..1 (wounds from fights, predators and robots) and time since the last hit
      cause: new Array(c).fill(null), killer: new Array(c).fill(null), // why a fly died this tick, and the robot that collects it
      hawkGene: F32(), gainGene: F32(), intake: F32(), wing: F32(), escape: F32(), cooldown: F32(), decide: F32(),
      oa: F32(), residence: F32(), payoff: F32(), played: new Int32Array(c), lastHawk: new Int8Array(c).fill(-1), target: new Int16Array(c).fill(-1), reason: new Array(c).fill(""),
      path: new Array(c).fill(null), pathIdx: new Int16Array(c), swarm: new Int32Array(c).fill(-1),
      mode: new Int8Array(c), comp: new Int32Array(c), degree: new Int16Array(c), generation: new Int32Array(c),
      feeding: new Uint8Array(c), parent: new Int32Array(c).fill(-1), id: new Int32Array(c),
    });
    this.nextId = 0;
    this.corpses = []; // recently dead flies, falling and lying where they died: { x, y, z, h, vy, age, cause }
    for (let i = 0; i < this.n; i++) this.spawn(i, null);

    this.hash = new SpatialHash(Math.max(this.params.socialRadius, this.params.dbEps));
    this.socialEdges = [];
    this.stats = new GameStats();
    this.theoryX = this.meanHawk();
    this.history = [];
    this.kmeansCentroids = null;
    this.modeCounts = [0, 0, 0, 0];
    this.swarms = { count: 0, noise: 0, sizes: [], hawk: [] };
    this.social = { edges: 0, components: 0, giant: 0, clustering: 0, avgDegree: 0, leaders: [] };
    this.astarStats = { astar: 0, dijkstra: 0, samples: 0 };
    this.events = { contest: 0, astar: 0, escape: 0, birth: 0, feed: 0, imitate: 0 };
    this.tmp = [];
  }

  // Probe the connectome once to learn which PFL3 hemisphere drives which DNa02
  // (PFL3 axons cross the midline) so a heuristic goal can be injected correctly.
  calibrate() {
    const { io } = this.cx;
    const b = new BrainPool(this.cx, 1);
    b.gain[0] = 9;
    const probe = (node) => {
      b.reset(0);
      b.setInput(0, node, 1);
      for (let i = 0; i < 60; i++) b.step(1);
      return b.rate(0, io.dna02[1]) - b.rate(0, io.dna02[0]); // >0 means right turn
    };
    const l = probe(io.pfl3[0]);
    const r = probe(io.pfl3[1]);
    this.pflRight = l > r ? io.pfl3[0] : io.pfl3[1]; // stimulate this to turn right
    this.pflLeft = l > r ? io.pfl3[1] : io.pfl3[0];
    this.pflCrossed = l > r;
  }

  newPatch({ bitter }) {
    const R = this.rng;
    for (let tries = 0; tries < 200; tries++) {
      const p = {
        x: (R() - 0.5) * ARENA * 0.82, z: (R() - 0.5) * ARENA * 0.82,
        r: bitter ? 4 : 3.8 + R() * 2.4, bitter, sugar: bitter ? 0 : 0.6 + R() * 0.4, occupants: 0, age: 0,
      };
      const clearObs = this.obstacles.every((o) => Math.hypot(o.x - p.x, o.z - p.z) > o.r + p.r + 2);
      const clearPatch = (this.patches || []).every((q) => Math.hypot(q.x - p.x, q.z - p.z) > q.r + p.r + 6);
      if (clearObs && clearPatch) return p;
    }
    return { x: 0, z: 0, r: 3, bitter, sugar: bitter ? 0 : 1, occupants: 0, age: 0 };
  }

  spawn(i, parent) {
    const R = this.rng;
    const P = this.params;
    if (parent === null) {
      this.x[i] = (R() - 0.5) * ARENA * 0.8;
      this.z[i] = (R() - 0.5) * ARENA * 0.8;
      this.hawkGene[i] = (R() - 0.5) * 3;
      this.gainGene[i] = 1 + (R() - 0.5) * 0.3;
      this.generation[i] = 0;
      this.parent[i] = -1;
      this.brains.reset(i);
    } else {
      this.x[i] = this.x[parent] + (R() - 0.5) * 3;
      this.z[i] = this.z[parent] + (R() - 0.5) * 3;
      this.hawkGene[i] = this.hawkGene[parent] + gauss(R) * P.mutation * 0.6;
      this.gainGene[i] = Math.min(1.4, Math.max(0.7, this.gainGene[parent] + gauss(R) * P.mutation * 0.1));
      this.generation[i] = this.generation[parent] + 1;
      this.parent[i] = this.id[parent];
      this.brains.copy(parent, i);
    }
    this.id[i] = this.nextId++;
    this.y[i] = 1 + R() * 3;
    this.h[i] = R() * TAU;
    this.speed[i] = 3;
    this.vy[i] = 0;
    this.energy[i] = 4;
    this.hp[i] = 1;
    this.hurt[i] = 9;
    this.cause[i] = null;
    this.killer[i] = null;
    this.age[i] = 0;
    this.life[i] = 70 + R() * 70;
    this.intake[i] = 0.3;
    this.residence[i] = 0;
    this.payoff[i] = 0;
    this.played[i] = 0;
    this.escape[i] = 0;
    this.cooldown[i] = 0;
    this.decide[i] = R();
    this.target[i] = -1;
    this.path[i] = null;
    this.lastHawk[i] = -1;
    this.reason[i] = "";
    this.wing[i] = R() * TAU;
  }

  // heritable probability of choosing strategy A; steep so that flies are mostly
  // one type, as in the replicator equation's population of pure strategists
  disposition(i) {
    return sigmoid(4 * this.hawkGene[i]);
  }

  // probability of actually choosing A now: disposition shifted by octopaminergic arousal
  choiceProb(i) {
    return sigmoid(4 * this.hawkGene[i] + 3 * (this.oa[i] - 0.05));
  }

  meanHawk() {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.disposition(i);
    return this.n ? s / this.n : 0;
  }

  setFlyCount(n) {
    n = Math.max(10, Math.min(this.cap, n | 0));
    for (let i = this.n; i < n; i++) this.spawn(i, this.pickParent());
    this.n = n;
  }

  // energy-proportional choice among the living for births
  pickParent() {
    let total = 0;
    const w = (i) => (this.hp[i] > 0 ? Math.max(0, this.energy[i]) : 0); // the dying do not breed
    for (let i = 0; i < this.n; i++) total += w(i);
    if (total <= 0) return Math.floor(this.rng() * this.n);
    let r = this.rng() * total;
    for (let i = 0; i < this.n; i++) {
      r -= w(i);
      if (r <= 0) return i;
    }
    return this.n - 1;
  }

  // Social learning along the proximity graph: a fly compares its recent game
  // payoff with a random neighbour's and copies the neighbour's disposition with
  // the Fermi probability 1 / (1 + exp(-s (pi_j - pi_i))) (pairwise comparison,
  // Traulsen, Nowak & Pacheco 2006). In large populations this follows the
  // replicator equation, so the analytic equilibria still apply.
  imitate() {
    const P = this.params, adj = this.adj;
    if (!adj || P.learnFrom === "none") return;
    // each fly reconsiders about once every 8 s, slower than its payoff memory turns over
    const expected = this.n * DT / 8;
    const tries = Math.floor(expected) + (this.rng() < expected % 1 ? 1 : 0);
    for (let t = 0; t < tries; t++) {
      const i = Math.floor(this.rng() * this.n);
      if (this.played[i] < 2) continue;
      let j;
      if (P.learnFrom === "anyone") j = Math.floor(this.rng() * this.n); // well-mixed population
      else {
        const nb = adj[i]; // neighbours on the social graph
        if (!nb || !nb.length) continue;
        j = nb[Math.floor(this.rng() * nb.length)];
      }
      if (this.played[j] < 2) continue;
      const pCopy = 1 / (1 + Math.exp(-P.selection * (this.payoff[j] - this.payoff[i])));
      if (this.rng() < pCopy) {
        this.hawkGene[i] = this.hawkGene[j] + gauss(this.rng) * P.mutation * 0.2;
        this.events.imitate++;
      }
    }
  }

  odorAt(x, z) {
    let c = 0;
    for (const p of this.patches) {
      if (p.bitter || p.sugar <= 0.02) continue;
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      c += p.sugar * Math.exp(-d2 / (2 * 16 * 16));
    }
    return c;
  }

  patchAt(x, z) {
    for (let k = 0; k < this.patches.length; k++) {
      const p = this.patches[k];
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < p.r * p.r) return k;
    }
    return -1;
  }

  // ------------------------------------------------------------------ heuristics
  choosePatch(i) {
    const opts = [];
    for (let k = 0; k < this.patches.length; k++) {
      const p = this.patches[k];
      if (p.bitter || p.sugar < 0.08) continue;
      opts.push({
        k,
        sugar: p.sugar * 3 + gauss(this.rng) * 0.15, // noisy perception
        crowd: p.occupants,
        dist: Math.hypot(p.x - this.x[i], p.z - this.z[i]),
      });
    }
    if (!opts.length) {
      this.target[i] = -1;
      this.reason[i] = "nothing worth visiting";
      return;
    }
    // shuffle so ties don't always break the same way
    for (let a = opts.length - 1; a > 0; a--) {
      const b = Math.floor(this.rng() * (a + 1));
      [opts[a], opts[b]] = [opts[b], opts[a]];
    }
    const { best, reason } = takeTheBest(opts);
    this.target[i] = best.k;
    this.reason[i] = reason;
    this.path[i] = null;
  }

  planPath(i) {
    const p = this.patches[this.target[i]];
    const res = this.grid.search(this.x[i], this.z[i], p.x, p.z, 1);
    this.path[i] = res.path.length ? res.path : [[p.x, p.z]];
    this.pathIdx[i] = Math.min(1, this.path[i].length - 1);
    this.events.astar++;
    // occasionally re-run the same query as Dijkstra (h = 0) to show what the heuristic saves
    if (this.rng() < 0.05) {
      const d = this.grid.search(this.x[i], this.z[i], p.x, p.z, 0);
      this.astarStats.astar += res.expanded;
      this.astarStats.dijkstra += d.expanded;
      this.astarStats.samples++;
    }
  }

  // ------------------------------------------------------------------ main step
  step() {
    const P = this.params;
    const { io } = this.cx;
    const B = this.brains;
    const n = this.n;
    this.t += DT;
    this.tick++;
    this.hash.cell = Math.max(P.socialRadius, P.dbEps);
    this.hash.build(this.x, this.z, n);
    for (const p of this.patches) p.occupants = 0;
    for (let i = 0; i < n; i++) {
      const k = this.patchAt(this.x[i], this.z[i]);
      if (k >= 0 && this.y[i] < 0.6) this.patches[k].occupants++;
    }

    const pred = this.predator;
    const looms = robotLooms(this);
    let plans = 0;
    for (let i = 0; i < n; i++) {
      const x = this.x[i], z = this.z[i], h = this.h[i];
      B.gain[i] = P.gain * this.gainGene[i];

      // --- senses -> sensory neurons
      const pk = this.patchAt(x, z);
      const landed = this.y[i] < 0.6;
      const patch = pk >= 0 ? this.patches[pk] : null;
      const sugar = patch && !patch.bitter && landed ? clamp01(patch.sugar * 1.4) : 0;
      const bitter = patch && patch.bitter && landed ? 1 : 0;
      B.setInput(i, io.sugar[0], sugar);
      B.setInput(i, io.sugar[1], sugar);
      B.setInput(i, io.bitter[0], bitter);
      B.setInput(i, io.bitter[1], bitter);

      const cL = this.odorAt(x + Math.cos(h - 0.6) * 0.8, z + Math.sin(h - 0.6) * 0.8);
      const cR = this.odorAt(x + Math.cos(h + 0.6) * 0.8, z + Math.sin(h + 0.6) * 0.8);
      const hunger = clamp01(1 - this.energy[i] / 8);
      // odour arouses hungry flies (the reduced olfactory pathway carries no reliable
      // left/right signal, so odour-guided search is left to the heuristic layer)
      B.setInput(i, io.orn[0], 0.15 * hunger * clamp01(cL));
      B.setInput(i, io.orn[1], 0.15 * hunger * clamp01(cR));

      // looming: predator's angular size, lateralised by which side it is on
      let loomL = 0, loomR = 0;
      if (P.predator) {
        const dx = pred.x - x, dz = pred.z - z, dy = pred.y - this.y[i];
        const d = Math.hypot(dx, dy, dz);
        if (d < 22) {
          const ang = wrap(Math.atan2(dz, dx) - h);
          const size = clamp01(2.5 / d) * (pred.mode === "dive" ? 1.4 : 0.6);
          if (ang > 0) loomR = size;
          else loomL = size;
        }
      }
      // an approaching dragonfly looms too, smaller but much closer
      for (const c of this.chasers) {
        const dx = c.x - x, dz = c.z - z, d = Math.hypot(dx, c.y - this.y[i], dz);
        if (d > 8) continue;
        const size = clamp01(1.2 / d) * (c.target === i ? 1.3 : 0.7);
        if (wrap(Math.atan2(dz, dx) - h) > 0) loomR = Math.max(loomR, size);
        else loomL = Math.max(loomL, size);
      }
      // and so do robot tools coming down
      for (const t of looms) {
        const dx = t[0] - x, dz = t[2] - z, d = Math.hypot(dx, t[1] - this.y[i], dz);
        if (d > 6) continue;
        const size = clamp01(1.5 / d) * 0.8;
        if (wrap(Math.atan2(dz, dx) - h) > 0) loomR = Math.max(loomR, size);
        else loomL = Math.max(loomL, size);
      }
      B.setInput(i, io.loom[0], clamp01(loomL));
      B.setInput(i, io.loom[1], clamp01(loomR));

      // mechanosensation: jostling neighbours (and fights, added in contest())
      const nb = this.hash.query(x, z, 1.2, this.x, this.z, this.tmp);
      const crowd = clamp01((nb.length - 1) * 0.15);
      B.setInput(i, io.mech[0], crowd * 0.5);
      B.setInput(i, io.mech[1], crowd * 0.5);

      // --- heuristic layer: decide where to go, plan with A*, feed bearing into PFL3
      this.decide[i] -= DT;
      if (this.decide[i] <= 0) {
        this.decide[i] = 0.8 + this.rng() * 0.6;
        const onTarget = this.target[i] >= 0 && pk === this.target[i];
        const depleted = this.target[i] >= 0 && this.patches[this.target[i]].sugar < 0.05;
        const settled = onTarget && this.residence[i] > 4;
        const sated = settled && this.energy[i] > 10;
        if (this.target[i] < 0 || depleted || sated || (settled && shouldLeave(this.intake[i], P.aspiration) && this.energy[i] > 2)) {
          if (onTarget) this.reason[i] = sated ? "sated: left to explore" : "satisficed: intake fell below aspiration";
          this.choosePatch(i);
        }
      }
      if (this.target[i] >= 0 && !this.path[i] && plans < 8 && this.escape[i] <= 0) {
        this.planPath(i);
        plans++;
      }
      let bearing = 0, goalDist = Infinity;
      if (this.path[i]) {
        const path = this.path[i];
        let w = path[this.pathIdx[i]];
        if (Math.hypot(w[0] - x, w[1] - z) < 2 && this.pathIdx[i] < path.length - 1) w = path[++this.pathIdx[i]];
        bearing = wrap(Math.atan2(w[1] - z, w[0] - x) - h);
        const tp = this.patches[this.target[i]];
        goalDist = Math.hypot(tp.x - x, tp.z - z);
      }
      const goalDrive = this.path[i] && goalDist > 1 ? clamp01(Math.abs(bearing) / 1.2) * 0.9 : 0;
      B.setInput(i, this.pflRight, bearing > 0 ? goalDrive : 0);
      B.setInput(i, this.pflLeft, bearing < 0 ? goalDrive : 0);
    }

    // --- run every connectome (15 Hz brain clock, 30 Hz body clock)
    if (this.tick % 2 === 0) B.step(n, this.silenced.size ? this.silenced : null);

    // --- motor neurons -> body
    for (let i = 0; i < n; i++) {
      const r = (node) => B.rate(i, node);
      const turn = r(io.dna02[1]) + 0.5 * r(io.dna01[1]) - r(io.dna02[0]) - 0.5 * r(io.dna01[0]);
      const gf = Math.max(r(io.gf[0]), r(io.gf[1]));
      const mdn = (r(io.mdn[0]) + r(io.mdn[1])) / 2;
      const p9 = (r(io.p9[0]) + r(io.p9[1])) / 2;
      const mn9 = Math.max(r(io.mn9[0]), r(io.mn9[1]));
      this.oa[i] = B.meanRate(i, this.cx.oa);

      let x = this.x[i], z = this.z[i];
      const pk = this.patchAt(x, z);
      const patch = pk >= 0 ? this.patches[pk] : null;
      const onFood = patch && !patch.bitter && patch.sugar > 0.02;

      // Giant Fiber escape takeoff (von Reyn et al. 2014): fly up and away
      if (gf > 0.3 && this.escape[i] <= 0) {
        this.escape[i] = 1.4;
        this.h[i] = Math.atan2(z - pred.z, x - pred.x) + (this.rng() - 0.5) * 0.8;
        this.vy[i] = 9;
        this.speed[i] = 14;
        this.path[i] = null;
        this.target[i] = -1;
        this.events.escape++;
      }

      // reflex layer (Reynolds 1987 separation + walls + obstacles); the brain
      // supplies the deliberate turning, this only prevents collisions
      let avoid = 0;
      const look = 3;
      const fx = x + Math.cos(this.h[i]) * look, fz = z + Math.sin(this.h[i]) * look;
      for (const o of this.obstacles) {
        const d = Math.hypot(fx - o.x, fz - o.z);
        if (d < o.r + 1.5) avoid += wrap(Math.atan2(z - o.z, x - o.x) - this.h[i]) * 0.15;
      }
      const lim = ARENA / 2 - 3;
      if (Math.abs(fx) > lim || Math.abs(fz) > lim) avoid += wrap(Math.atan2(-z, -x) - this.h[i]) * 0.12;
      const nb = this.hash.query(x, z, 0.8, this.x, this.z, this.tmp);
      for (const j of nb) {
        if (j === i) continue;
        const a = wrap(Math.atan2(this.z[j] - z, this.x[j] - x) - this.h[i]);
        avoid -= Math.sign(a) * 0.03;
      }

      const feeding = onFood && this.y[i] < 0.6 ? mn9 : 0;
      this.residence[i] = pk >= 0 && pk === this.target[i] && this.y[i] < 0.6 ? this.residence[i] + DT : 0;
      this.feeding[i] = feeding > 0.15 ? 1 : 0;
      // torn wings: wounded flies are slower, so the predator catches them more easily
      let base = (5.5 + 5 * p9 - 6 * mdn) * (0.4 + 0.6 * this.hp[i]);
      if (this.target[i] >= 0) {
        const tp = this.patches[this.target[i]];
        const d = Math.hypot(tp.x - x, tp.z - z);
        if (d < tp.r) base *= 0.25 + 0.75 * (1 - feeding); // proboscis extension halts walking
      }
      if (this.escape[i] > 0) {
        this.escape[i] -= DT;
        base = Math.max(base, 12 * this.escape[i]);
      } else {
        this.h[i] += (turn * 4.2 + this.noiseTurn(i)) * DT;
      }
      this.h[i] += avoid;
      this.speed[i] += (base - this.speed[i]) * 0.15;

      // altitude: cruise above the floor, land when the target patch is reached
      let goalY = 2.2;
      if (this.target[i] >= 0) {
        const tp = this.patches[this.target[i]];
        if (Math.hypot(tp.x - x, tp.z - z) < tp.r * 0.9) goalY = 0;
      }
      if (this.escape[i] > 0) goalY = 8;
      this.vy[i] += ((goalY - this.y[i]) * 2.5 - this.vy[i] * 1.5) * DT;
      this.y[i] = Math.max(0, this.y[i] + this.vy[i] * DT);

      x += Math.cos(this.h[i]) * this.speed[i] * DT;
      z += Math.sin(this.h[i]) * this.speed[i] * DT;
      // keep out of obstacles and inside the arena
      for (const o of this.obstacles) {
        const d = Math.hypot(x - o.x, z - o.z);
        if (d < o.r + 0.4) {
          x = o.x + ((x - o.x) / d) * (o.r + 0.4);
          z = o.z + ((z - o.z) / d) * (o.r + 0.4);
        }
      }
      this.x[i] = Math.max(-ARENA / 2 + 1, Math.min(ARENA / 2 - 1, x));
      this.z[i] = Math.max(-ARENA / 2 + 1, Math.min(ARENA / 2 - 1, z));

      // energy: feeding through MN9 (Shiu et al. 2024: sugar GRNs -> MN9)
      let gain = 0;
      if (feeding > 0) {
        gain = feeding * patch.sugar * 1.6 * DT;
        patch.sugar = Math.max(0, patch.sugar - gain * 0.004);
        if (gain > 0) this.events.feed++;
      }
      this.intake[i] += (gain / DT - this.intake[i]) * 0.02;
      this.energy[i] = Math.min(12, this.energy[i] + gain - (0.08 + 0.008 * this.speed[i]) * DT);
      this.cooldown[i] -= DT;
      this.hurt[i] += DT;
      if (this.hp[i] > 0) this.hp[i] = Math.min(1, this.hp[i] + 0.02 * DT); // wounds heal slowly
      this.age[i] += DT;
      this.wing[i] += (this.y[i] > 0.05 ? 1.6 : 0.15) * (1 + this.speed[i] * 0.05);
    }

    this.contests();
    this.imitate();
    this.updatePredator();
    this.updateChasers();
    updateRobots(this);
    this.lifeCycle();
    this.updateCorpses();
    this.updatePatches();
    if (this.tick % 3 === 0) this.socialGraph();
    if (this.tick % 10 === 0) this.swarmClusters();
    if (this.tick % 30 === 0) this.behaviourModes();
    if (this.tick % 15 === 0) this.recordHistory();
  }

  noiseTurn(i) {
    return (this.rng() - 0.5) * 1.6;
  }

  // ------------------------------------------------------------------ game theory
  contests() {
    const P = this.params;
    const B = this.brains;
    const { io } = this.cx;
    const nb = [];
    for (let i = 0; i < this.n; i++) {
      if (this.cooldown[i] > 0 || this.y[i] > 0.6) continue;
      const pk = this.patchAt(this.x[i], this.z[i]);
      if (pk < 0 || this.patches[pk].bitter || this.patches[pk].sugar < 0.05) continue;
      this.hash.query(this.x[i], this.z[i], 1.5, this.x, this.z, nb);
      let j = -1;
      for (const q of nb) if (q !== i && this.cooldown[q] <= 0 && this.y[q] < 0.6) { j = q; break; }
      if (j < 0) continue;
      // each fly's strategy = heritable disposition + octopaminergic arousal of its own connectome
      const pi = this.choiceProb(i);
      const pj = this.choiceProb(j);
      const hi = this.rng() < pi, hj = this.rng() < pj;
      this.stats.noteChoice(this.oa[i], hi);
      this.stats.noteChoice(this.oa[j], hj);
      const m = GAMES[P.game].matrix(P.V, P.C);
      // expected payoffs, as in the replicator equation (an escalated Hawk-Hawk fight
      // costs each fly (V - C) / 2 on average; a random winner would add survivorship bias)
      const [ai, aj] = payoffs(m, hi, hj);
      // payoffs are energy, scaled so that a single bad contest rarely kills: if
      // fights killed outright, losers' payoffs would vanish before anyone could
      // learn from them (survivorship bias) and the population would overshoot
      this.energy[i] += P.payoffEnergy * ai;
      this.energy[j] += P.payoffEnergy * aj;
      // running mean payoff per contest (window of ~8 contests)
      this.payoff[i] += (ai - this.payoff[i]) / Math.min(8, ++this.played[i]);
      this.payoff[j] += (aj - this.payoff[j]) / Math.min(8, ++this.played[j]);
      // an escalated Hawk-Hawk fight also wounds both flies in proportion to C
      if (P.game === "hawkdove" && hi && hj) {
        this.wound(i, 0.03 * P.C, "fights");
        this.wound(j, 0.03 * P.C, "fights");
      }
      if (this.energy[i] <= 0) this.cause[i] ??= "fights"; // killed in a fight
      if (this.energy[j] <= 0) this.cause[j] ??= "fights";
      const contested = this.patches[pk];
      contested.sugar = Math.max(0, contested.sugar - (Math.max(0, ai) + Math.max(0, aj)) * 0.002); // payoffs are food from the patch
      this.lastHawk[i] = hi ? 1 : 0;
      this.lastHawk[j] = hj ? 1 : 0;
      this.stats.record(hi, hj);
      this.events.contest++;
      // the loser is jostled (felt through its mechanosensory neurons) but is not
      // chased off: forced displacement would let winners monopolise patches, so
      // newcomers would meet them more often than random pairing assumes
      const loser = ai < aj ? i : aj < ai ? j : -1;
      if (loser >= 0) {
        B.setInput(loser, io.mech[0], 1);
        B.setInput(loser, io.mech[1], 1);
        this.vy[loser] = 2;
      }
      this.cooldown[i] = this.cooldown[j] = 1.5;
    }
  }

  updatePredator() {
    const p = this.predator;
    if (!this.params.predator) {
      p.y += (40 - p.y) * 0.02;
      return;
    }
    p.timer -= DT;
    if (p.mode === "patrol") {
      const a = this.t * 0.25;
      const tx = Math.cos(a) * 45, tz = Math.sin(a * 1.3) * 45;
      p.vx += (tx - p.x) * 0.01;
      p.vz += (tz - p.z) * 0.01;
      p.vy += (24 - p.y) * 0.02;
      if (p.timer <= 0 && this.swarms.biggest) {
        // predators target the largest swarm (Hamilton's 1971 selfish herd)
        p.mode = "dive";
        p.timer = 3.5;
        p.tx = this.swarms.biggest.x;
        p.tz = this.swarms.biggest.z;
      }
    } else {
      p.vx += (p.tx - p.x) * 0.04;
      p.vz += (p.tz - p.z) * 0.04;
      p.vy += (0.8 - p.y) * 0.05;
      if (p.timer <= 0) {
        p.mode = "patrol";
        p.timer = 10 + this.rng() * 8;
      }
      // the beak catches what it touches; the wings and the pressure wave of the
      // dive batter flies further out, at most once per pass
      for (let i = 0; i < this.n; i++) {
        if (this.hp[i] <= 0) continue;
        const d = Math.hypot(this.x[i] - p.x, this.y[i] - p.y, this.z[i] - p.z);
        if (d < 1.4) {
          this.wound(i, 1, "eaten");
        } else if (d < 3.5 && this.hurt[i] > 1) {
          this.wound(i, 0.25 + 0.45 * (1 - d / 3.5), "eaten");
          // knocked tumbling away from the strike
          const a = Math.atan2(this.z[i] - p.z, this.x[i] - p.x);
          this.x[i] += Math.cos(a) * 0.6;
          this.z[i] += Math.sin(a) * 0.6;
          this.vy[i] -= 3;
        }
        if (this.hp[i] <= 0) p.kills++;
      }
    }
    p.vx *= 0.94;
    p.vy *= 0.94;
    p.vz *= 0.94;
    p.x += p.vx * DT * 6;
    p.y += p.vy * DT * 6;
    p.z += p.vz * DT * 6;
  }

  // Dragonflies hunt by interception, singling out one fly at a time (Olberg et al.
  // 2000; Combes et al. 2012); here they favour slow, wounded and isolated flies.
  updateChasers() {
    const want = this.params.chasers | 0;
    while (this.chasers.length < want) {
      const a = this.rng() * TAU;
      this.chasers.push({ x: Math.cos(a) * ARENA * 0.48, y: 6, z: Math.sin(a) * ARENA * 0.48, vx: 0, vy: 0, vz: 0, target: -1, retarget: 0, bite: 0, kills: 0 });
    }
    this.chasers.length = Math.max(0, want);
    for (const c of this.chasers) {
      c.retarget -= DT;
      c.bite -= DT;
      if (c.target >= this.n || (c.target >= 0 && this.hp[c.target] <= 0)) c.target = -1;
      if (c.target < 0 || c.retarget <= 0) {
        let best = -1, bs = Infinity;
        for (let i = 0; i < this.n; i++) {
          const d = Math.hypot(this.x[i] - c.x, this.z[i] - c.z);
          const score = d * (0.35 + 0.65 * this.hp[i]) * (1 + 0.15 * Math.min(6, this.degree[i]));
          if (score < bs) (bs = score), (best = i);
        }
        c.target = best;
        c.retarget = 3 + this.rng() * 2;
      }
      let ax = 0, ay = (5 - c.y) * 0.5, az = 0;
      if (c.target >= 0 && c.bite <= 0) {
        // aim at where the fly will be (proportional navigation, simplified)
        const i = c.target;
        const lead = 0.25;
        const tx = this.x[i] + Math.cos(this.h[i]) * this.speed[i] * lead;
        const tz = this.z[i] + Math.sin(this.h[i]) * this.speed[i] * lead;
        const dx = tx - c.x, dy = this.y[i] + 0.2 - c.y, dz = tz - c.z, d = Math.hypot(dx, dy, dz) + 1e-6;
        ax = (dx / d) * 40;
        ay = (dy / d) * 40;
        az = (dz / d) * 40;
        if (Math.hypot(this.x[i] - c.x, this.y[i] - c.y, this.z[i] - c.z) < 1.1) {
          c.bite = 1.2; // handling time, then the chase resumes
          this.vy[i] -= 2;
          if (this.wound(i, 0.4, "bitten")) {
            c.kills++;
            c.target = -1;
          }
        }
      }
      for (const o of this.obstacles) {
        const d = Math.hypot(c.x - o.x, c.z - o.z);
        if (d < o.r + 2 && c.y < 8) (ax += ((c.x - o.x) / d) * 30), (az += ((c.z - o.z) / d) * 30);
      }
      c.vx += ax * DT;
      c.vy += ay * DT;
      c.vz += az * DT;
      const sp = Math.hypot(c.vx, c.vy, c.vz), max = 11; // faster than cruising flies, slower than an escape take-off
      if (sp > max) (c.vx *= max / sp), (c.vy *= max / sp), (c.vz *= max / sp);
      c.x = Math.max(-ARENA / 2, Math.min(ARENA / 2, c.x + c.vx * DT));
      c.y = Math.max(0.3, c.y + c.vy * DT);
      c.z = Math.max(-ARENA / 2, Math.min(ARENA / 2, c.z + c.vz * DT));
    }
  }

  // damage a fly's body; at zero health it dies of `cause` (a key of this.deaths)
  // when lifeCycle() runs. A robot passed as `by` that carries a held[] list
  // collects the body. Returns true if this blow killed the fly.
  wound(i, dmg, cause, by = null) {
    if (this.hp[i] <= 0) return false;
    this.hp[i] = Math.max(0, this.hp[i] - dmg);
    this.hurt[i] = 0;
    if (this.hp[i] > 0) return false;
    this.cause[i] = cause;
    this.killer[i] = by;
    return true;
  }

  lifeCycle() {
    for (let i = 0; i < this.n; i++) {
      const old = this.age[i] > this.life[i];
      if (this.energy[i] > 0 && this.hp[i] > 0 && !old) continue;
      const cause = this.cause[i] ?? (this.energy[i] <= 0 ? "starved" : "old");
      this.deaths[cause]++;
      // the body drops where the fly died and stays a few seconds; its slot is reused for a newborn
      this.corpses.push({ x: this.x[i], y: this.y[i], z: this.z[i], h: this.h[i], vy: Math.min(0, this.vy[i]), age: 0, cause });
      if (this.corpses.length > 150) this.corpses.shift();
      const by = this.killer[i];
      if (by && (by.kind === "picker" || by.kind === "net")) {
        const c = this.corpses.at(-1), r = by.kind === "net" ? 0.9 : 0.2;
        Object.assign(c, { held: true, ox: (this.rng() - 0.5) * r, oy: -this.rng() * r, oz: (this.rng() - 0.5) * r });
        by.held.push(c);
      }
      const parent = this.pickParent();
      if (parent !== i && this.energy[parent] > 2) this.energy[parent] -= 1; // reproduction costs energy
      this.spawn(i, parent === i ? null : parent);
      this.births++;
      this.events.birth++;
    }
  }

  updateCorpses() {
    for (const c of this.corpses) {
      c.age += DT;
      if (c.held) continue;
      c.vy -= 20 * DT;
      c.y = Math.max(0, c.y + c.vy * DT);
    }
    while (this.corpses.length && this.corpses[0].age > CORPSE_LIFE && !this.corpses[0].held) this.corpses.shift();
  }

  updatePatches() {
    for (let k = 0; k < this.patches.length; k++) {
      const p = this.patches[k];
      p.age += DT;
      if (p.bitter) continue;
      p.sugar = Math.min(1, p.sugar + 0.02 * DT);
      if (p.sugar < 0.03 && p.age > 20) {
        // exhausted patches reappear somewhere else
        this.patches[k] = this.newPatch({ bitter: false });
        for (let i = 0; i < this.n; i++) if (this.target[i] === k) this.target[i] = -1;
      }
    }
  }

  // ------------------------------------------------------------------ graph theory
  socialGraph() {
    const n = this.n, R = this.params.socialRadius;
    const uf = new UnionFind(n);
    const adj = Array.from({ length: n }, () => []);
    const edges = [];
    const nb = [];
    for (let i = 0; i < n; i++) {
      this.hash.query(this.x[i], this.z[i], R, this.x, this.z, nb);
      for (const j of nb) {
        if (j <= i) continue;
        edges.push(i, j);
        adj[i].push(j);
        adj[j].push(i);
        uf.union(i, j);
      }
    }
    const size = new Map();
    for (let i = 0; i < n; i++) {
      const r = uf.find(i);
      this.comp[i] = r;
      this.degree[i] = adj[i].length;
      size.set(r, (size.get(r) || 0) + 1);
    }
    // leaders: highest-degree fly in each component of 5+
    const lead = new Map();
    for (let i = 0; i < n; i++) {
      const r = this.comp[i];
      if (size.get(r) < 5) continue;
      if (!lead.has(r) || this.degree[i] > this.degree[lead.get(r)]) lead.set(r, i);
    }
    this.socialEdges = edges;
    this.adj = adj;
    this.social = {
      edges: edges.length / 2,
      components: size.size,
      giant: Math.max(...size.values()),
      clustering: this.tick % 15 === 0 ? avgClustering(adj) : this.social.clustering,
      avgDegree: edges.length / n,
      leaders: [...lead.values()],
    };
  }

  // ------------------------------------------------------------------ clustering
  swarmClusters() {
    const n = this.n;
    const { labels, count } = dbscan(n, this.x, this.z, this.params.dbEps, this.params.dbMin, this.hash);
    const sizes = new Array(count).fill(0), hawk = new Array(count).fill(0);
    const cx = new Array(count).fill(0), cz = new Array(count).fill(0);
    let noise = 0;
    for (let i = 0; i < n; i++) {
      this.swarm[i] = labels[i];
      if (labels[i] < 0) {
        noise++;
        continue;
      }
      sizes[labels[i]]++;
      hawk[labels[i]] += this.disposition(i);
      cx[labels[i]] += this.x[i];
      cz[labels[i]] += this.z[i];
    }
    let biggest = null;
    for (let c = 0; c < count; c++) {
      hawk[c] /= sizes[c];
      if (!biggest || sizes[c] > biggest.size) biggest = { size: sizes[c], x: cx[c] / sizes[c], z: cz[c] / sizes[c] };
    }
    // how many DBSCAN swarms sit inside a single social-graph component (same radius => always 1)
    this.swarms = { count, noise, sizes, hawk, biggest };
  }

  // k-means on each fly's motor/neuromodulatory activity -> behavioural modes
  behaviourModes() {
    const { io } = this.cx;
    const B = this.brains;
    const data = [];
    for (let i = 0; i < this.n; i++) {
      const r = (a) => (B.rate(i, a[0]) + B.rate(i, a[1])) / 2;
      data.push(
        Float32Array.of(
          Math.abs(B.rate(i, io.dna02[1]) - B.rate(i, io.dna02[0])) + r(io.orn),
          r(io.mn9) + r(io.sugar),
          Math.max(B.rate(i, io.gf[0]), B.rate(i, io.gf[1])) + r(io.loom) + (this.escape[i] > 0 ? 0.5 : 0),
          this.oa[i] + r(io.mdn) + r(io.mech)
        )
      );
    }
    // standardise columns so a feature that is always a bit active does not dominate
    const D = data[0].length;
    const mu = new Float32Array(D), sd = new Float32Array(D);
    for (const row of data) for (let d = 0; d < D; d++) mu[d] += row[d] / data.length;
    for (const row of data) for (let d = 0; d < D; d++) sd[d] += (row[d] - mu[d]) ** 2 / data.length;
    for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d]) + 0.05;
    for (const row of data) for (let d = 0; d < D; d++) row[d] = (row[d] - mu[d]) / sd[d];
    const k = this.params.k;
    const res = kmeans(data, k, { prev: this.kmeansCentroids });
    this.kmeansCentroids = res.centroids;
    // name each cluster by its most over-expressed feature (columns align with MODE_NAMES);
    // clusters with nothing above average are plain cruising/foraging
    const names = res.centroids.map((c) => {
      let best = 0;
      for (let d = 1; d < c.length; d++) if (c[d] > c[best]) best = d;
      return c[best] < 0.5 ? 0 : best;
    });
    this.modeRaw = { mu, sd };
    this.modeNames = names;
    this.modeCounts = [0, 0, 0, 0];
    for (let i = 0; i < this.n; i++) {
      this.mode[i] = names[res.labels[i]];
      this.modeCounts[this.mode[i]]++;
    }
    this.kmeansInertia = res.inertia;
  }

  recordHistory() {
    const P = this.params;
    const observed = this.meanHawk();
    const m = GAMES[P.game].matrix(P.V, P.C);
    // normalise by payoff scale so every game relaxes at a comparable, readable speed
    const scale = Math.abs(m[0][0]) + Math.abs(m[0][1]) + Math.abs(m[1][0]) + Math.abs(m[1][1]) + 1e-9;
    for (let s = 0; s < 15; s++) this.theoryX = replicatorStep(this.theoryX, m, (DT * 1.8) / scale);
    const eq = equilibria(m);
    this.history.push({
      t: this.t, observed, theory: this.theoryX, ess: attractor(m, observed),
      threshold: eq.unstable.find((u) => u > 0 && u < 1) ?? null,
      played: this.stats.played(), n: this.n, energy: this.meanEnergy(),
    });
    if (this.history.length > 600) this.history.shift();
  }

  // switch game; the analytic reference restarts from the current population
  setGame(game, V, C) {
    Object.assign(this.params, { game, V, C });
    this.theoryX = this.meanHawk();
    this.stats = new GameStats();
    this.history = [];
  }

  meanEnergy() {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.energy[i];
    return s / this.n;
  }
}

function gauss(R) {
  return Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(TAU * R());
}
