// Game theory: Hawk-Dove contests over food (Maynard Smith & Price 1973) and
// the replicator equation (Taylor & Jonker 1978) used as the analytic reference.

export function hawkDovePayoff(a, b, V, C) {
  // a, b: true = hawk. Returns [payoff a, payoff b].
  if (a && b) return [(V - C) / 2, (V - C) / 2];
  if (a && !b) return [V, 0];
  if (!a && b) return [0, V];
  return [V / 2, V / 2];
}

// Evolutionarily stable hawk frequency: V/C when C > V, otherwise pure hawk.
export function essHawk(V, C) {
  return C > V ? V / C : 1;
}

// dx/dt = x (1 - x) (f_H - f_D) for the Hawk-Dove game.
export function replicatorStep(x, V, C, dt) {
  const fH = x * (V - C) / 2 + (1 - x) * V;
  const fD = (1 - x) * V / 2;
  return Math.min(1, Math.max(0, x + dt * x * (1 - x) * (fH - fD)));
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
