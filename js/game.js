// Game theory: symmetric 2x2 games played over food, the replicator equation
// (Taylor & Jonker 1978) and evolutionarily stable states (Maynard Smith & Price 1973).
//
// Strategy A is the "selfish" option (Hawk / Defect / Hare), B the other one.
// matrix(V, C) returns [[a, b], [c, d]]: payoff to the row player for
// A vs A, A vs B, B vs A and B vs B.

export const GAMES = {
  hawkdove: {
    name: "Hawk–Dove", A: "Hawk", B: "Dove",
    vLabel: "Value of food bout V", cLabel: "Cost of fighting C", defaults: [2, 5],
    matrix: (V, C) => [[(V - C) / 2, V], [0, V / 2]],
    about: "Hawks escalate and risk injury; doves share or retreat. When C > V neither pure strategy is stable and the population settles at a Hawk share of V/C.",
    refs: ["maynardsmith1973", "maynardsmith1982"],
  },
  pd: {
    name: "Prisoner's Dilemma", A: "Defect", B: "Cooperate",
    vLabel: "Benefit given to partner b", cLabel: "Cost of giving c", defaults: [3, 1],
    matrix: (V, C) => [[0, V], [-C, V - C]],
    about: "A donation game: cooperators pay c so the partner gains b. Defection dominates, so with well-mixed partners cooperation dies out even though mutual cooperation pays more.",
    refs: ["nash1950", "nowak1992", "ohtsuki2006"],
  },
  stag: {
    name: "Stag Hunt", A: "Hare", B: "Stag",
    vLabel: "Joint (stag) payoff V", cLabel: "Safe (hare) payoff C", defaults: [4, 1.5],
    matrix: (V, C) => [[C, C], [0, V]],
    about: "Hunting stag pays V only if the partner joins; hare pays C regardless. Both pure strategies are stable — which one wins depends on whether the Hare share starts above the threshold 1 − C/V.",
    refs: ["maynardsmith1982", "hofbauer1998"],
  },
};

export function payoffs(m, aIsA, bIsA) {
  const i = aIsA ? 0 : 1, j = bIsA ? 0 : 1;
  return [m[i][j], m[j][i]];
}

// rest points of the replicator dynamics on x = share of strategy A
export function equilibria(m) {
  const [[a, b], [c, d]] = m;
  const stable = [], unstable = [];
  (a > c || (a === c && b > d) ? stable : unstable).push(1);
  (d > b || (d === b && c > a) ? stable : unstable).push(0);
  const den = a - c + (d - b);
  if (Math.abs(den) > 1e-12) {
    const x = (d - b) / den;
    if (x > 1e-6 && x < 1 - 1e-6) (a < c && d < b ? stable : unstable).push(x);
  }
  return { stable: stable.sort(), unstable: unstable.sort() };
}

// the stable rest point whose basin contains x (no unstable point in between)
export function attractor(m, x) {
  const { stable, unstable } = equilibria(m);
  let best = stable[0] ?? x, bd = Infinity;
  for (const s of stable) {
    const lo = Math.min(s, x), hi = Math.max(s, x);
    if (unstable.some((u) => u > lo && u < hi)) continue;
    if (Math.abs(s - x) < bd) (bd = Math.abs(s - x)), (best = s);
  }
  return best;
}

// dx/dt = x (1 - x) (f_A - f_B)
export function replicatorStep(x, m, dt) {
  const fA = x * m[0][0] + (1 - x) * m[0][1];
  const fB = x * m[1][0] + (1 - x) * m[1][1];
  return Math.min(1, Math.max(0, x + dt * x * (1 - x) * (fA - fB)));
}

export class GameStats {
  constructor() {
    this.contests = 0;
    this.recent = [0, 0]; // exponentially weighted hawk plays / total plays (~last 300 choices)
    this.hh = 0;
    this.hd = 0;
    this.dd = 0;
    this.oaN = 0;
    this.oaSum = [0, 0, 0, 0, 0]; // sum x, sum y, sum xx, sum yy, sum xy
  }
  record(aH, bH) {
    this.contests++;
    const decay = 0.993;
    this.recent[0] = this.recent[0] * decay + (aH ? 1 : 0) + (bH ? 1 : 0);
    this.recent[1] = this.recent[1] * decay + 2;
    if (aH && bH) this.hh++;
    else if (aH || bH) this.hd++;
    else this.dd++;
  }
  // correlation between octopaminergic activity and choosing hawk
  noteChoice(oa, hawk) {
    const y = hawk ? 1 : 0;
    const s = this.oaSum;
    s[0] += oa;
    s[1] += y;
    s[2] += oa * oa;
    s[3] += y * y;
    s[4] += oa * y;
    this.oaN++;
    if (this.oaN > 4000) {
      // exponential forgetting so the estimate tracks the evolving population
      for (let i = 0; i < 5; i++) s[i] *= 0.5;
      this.oaN = 2000;
    }
  }
  oaCorrelation() {
    const n = this.oaN, s = this.oaSum;
    if (n < 10) return 0;
    const cov = s[4] / n - (s[0] / n) * (s[1] / n);
    const vx = s[2] / n - (s[0] / n) ** 2, vy = s[3] / n - (s[1] / n) ** 2;
    return vx > 1e-9 && vy > 1e-9 ? cov / Math.sqrt(vx * vy) : 0;
  }
  // share of recent choices that were Hawk
  played() {
    return this.recent[1] ? this.recent[0] / this.recent[1] : 0;
  }
}
