// Reduced FlyWire connectome + a batched rate model that runs one "brain" per fly.
//
// Nodes are FlyWire cell types split by hemisphere (see tools/build_data.py).
// Edge weights are signed synapse counts (Shiu et al. 2024 sign convention:
// acetylcholine excitatory, GABA/glutamate inhibitory), normalised per target.
// The dynamics are a leaky rate abstraction of the leaky integrate-and-fire
// model in Shiu et al. (2024) — far simpler, but small enough to run hundreds
// of copies at 60 fps in the browser.

export async function loadData(base = "./") {
  const [conn, meta, bin] = await Promise.all([
    fetch(base + "data/connectome.json").then((r) => r.json()),
    fetch(base + "data/neurons.json").then((r) => r.json()),
    fetch(base + "data/neurons.bin").then((r) => r.arrayBuffer()),
  ]);
  const n = meta.count;
  return {
    conn,
    neurons: {
      count: n,
      classes: meta.classes,
      xyzg: new Uint16Array(bin, 0, n * 4),
      superClass: new Uint8Array(bin, n * 8, n),
    },
  };
}

export class Connectome {
  constructor(conn) {
    this.meta = conn.meta;
    this.nodes = conn.nodes;
    this.N = conn.nodes.length;
    this.index = new Map(this.nodes.map((nd, i) => [nd.id, i]));
    this.edges = conn.edges; // [src, tgt, w, synapses]

    // CSR by target for the dynamics
    const N = this.N;
    const counts = new Int32Array(N + 1);
    for (const e of this.edges) counts[e[1] + 1]++;
    for (let i = 0; i < N; i++) counts[i + 1] += counts[i];
    this.inPtr = counts;
    this.inSrc = new Int32Array(this.edges.length);
    this.inW = new Float32Array(this.edges.length);
    const fill = counts.slice(0, N);
    for (const [s, t, w] of this.edges) {
      const k = fill[t]++;
      this.inSrc[k] = s;
      this.inW[k] = w;
    }

    const id = (name) => {
      const i = this.index.get(name);
      return i === undefined ? -1 : i;
    };
    const LR = (t) => [id(t + "|left"), id(t + "|right")];
    this.io = {
      sugar: LR("GRN_sugar"),
      bitter: LR("GRN_bitter"),
      orn: LR("ORN"),
      loom: LR("LPLC2"),
      mech: LR("JO_mechano"),
      pfl3: LR("PFL3"),
      epg: LR("EPG"),
      dna02: LR("DNa02"),
      dna01: LR("DNa01"),
      gf: LR("GF"),
      mdn: LR("MDN"),
      p9: LR("DNp09"),
      mn9: LR("MN9"),
    };
    this.oa = this.nodes.flatMap((nd, i) => (nd.type.startsWith("OA-") ? [i] : []));
    this.mbon = this.nodes.flatMap((nd, i) => (nd.type.startsWith("MBON") ? [i] : []));
    this.sensory = new Set(
      ["sugar", "bitter", "orn", "loom", "mech"].flatMap((k) => this.io[k]).filter((i) => i >= 0)
    );
  }
}

// A population of brains sharing one connectome.
//
// Each brain tick, activity is propagated K synaptic hops outward from the
// current sensory drive (r_{k+1} = f(I + g W r_k - theta), r_0 = 0). Most
// sensorimotor effects in the whole-brain model of Shiu et al. (2024) lie
// within a few hops, and bounding the depth stops the lumped, cell-type-level
// graph from latching into artificial self-sustained states. The readout R is
// a leaky average of the propagated activity, giving neurons a time constant.
export class BrainPool {
  constructor(cx, capacity) {
    this.cx = cx;
    this.cap = capacity;
    this.N = cx.N;
    this.R = new Float32Array(capacity * this.N); // smoothed activity (what the body and the UI read)
    this.I = new Float32Array(capacity * this.N); // external drive
    this.gain = new Float32Array(capacity).fill(9);
    this.hops = 4;
    this.alpha = 0.5; // readout smoothing per tick (~ dt / tau)
    this.theta = 0.05; // firing threshold
    this.noise = 0.03;
    this.a = new Float32Array(this.N);
    this.b = new Float32Array(this.N);
  }

  reset(f) {
    const o = f * this.N;
    this.R.fill(0, o, o + this.N);
    this.I.fill(0, o, o + this.N);
  }

  setInput(f, node, v) {
    if (node >= 0) this.I[f * this.N + node] = v;
  }

  rate(f, node) {
    return node >= 0 ? this.R[f * this.N + node] : 0;
  }

  meanRate(f, nodes) {
    if (!nodes.length) return 0;
    let s = 0;
    const o = f * this.N;
    for (const i of nodes) s += this.R[o + i];
    return s / nodes.length;
  }

  step(count, silenced = null) {
    const { N, R, I, alpha, theta, noise, hops } = this;
    const { inPtr, inSrc, inW } = this.cx;
    let a = this.a, b = this.b;
    for (let f = 0; f < count; f++) {
      const o = f * N;
      const g = this.gain[f];
      a.fill(0);
      for (let h = 0; h < hops; h++) {
        for (let t = 0; t < N; t++) {
          let x = I[o + t] - theta;
          for (let k = inPtr[t], e = inPtr[t + 1]; k < e; k++) x += g * inW[k] * a[inSrc[k]];
          if (h === hops - 1) x += noise * (Math.random() - 0.5);
          b[t] = x > 0 ? Math.tanh(x) : 0;
        }
        if (silenced) for (const t of silenced) b[t] = 0;
        const tmp = a;
        a = b;
        b = tmp;
      }
      for (let t = 0; t < N; t++) R[o + t] += alpha * (a[t] - R[o + t]);
    }
    this.a = a;
    this.b = b;
  }

  // copy the brain state of fly a into fly b (used when flies reproduce)
  copy(a, b) {
    this.R.copyWithin(b * this.N, a * this.N, (a + 1) * this.N);
  }
}
