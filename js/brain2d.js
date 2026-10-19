// Canvas fallback for the brain view (no WebGL or WebGPU): a slowly turning
// projection of a subsample of the FlyWire neurons, coloured by the activity of
// their cell type, with the reduced graph's nodes on top.
import * as THREE from "three";
import { CLASS_COLORS, LABELS, ramp, toWorld } from "./brainview.js";

const STRIDE = 3; // draw every 3rd neuron (~46k points) to keep the CPU budget small

export class Brain2D {
  constructor(el, cx, neurons, analysis) {
    this.el = el;
    this.cx = cx;
    this.analysis = analysis;
    this.mode = "activity";
    this.N = cx.N;
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.angle = 0;
    this.drag = null;
    this.canvas.addEventListener("pointerdown", (e) => (this.drag = [e.clientX, this.angle]));
    addEventListener("pointerup", () => (this.drag = null));
    addEventListener("pointermove", (e) => this.drag && (this.angle = this.drag[1] + (e.clientX - this.drag[0]) * 0.01));

    const v = new THREE.Vector3();
    const q = neurons.xyzg;
    const m = Math.ceil(neurons.count / STRIDE);
    this.px = new Float32Array(m);
    this.py = new Float32Array(m);
    this.pz = new Float32Array(m);
    this.grp = new Uint16Array(m);
    this.cls = new Uint8Array(m);
    for (let i = 0, k = 0; i < neurons.count; i += STRIDE, k++) {
      toWorld(q[4 * i] / 65535 - 0.5, q[4 * i + 1] / 65535 - 0.5, q[4 * i + 2] / 65535 - 0.5, v);
      this.px[k] = v.x;
      this.py[k] = v.y;
      this.pz[k] = v.z;
      this.grp[k] = q[4 * i + 3];
      this.cls[k] = neurons.superClass[i];
    }
    this.classCol = neurons.classes.map((c) => new THREE.Color(CLASS_COLORS[c] || CLASS_COLORS.unknown));
    this.nodePos = cx.nodes.map((nd) => toWorld(nd.p[0], nd.p[1], nd.p[2], new THREE.Vector3()));
    this.act = new Float32Array(this.N);
    this.nodeCol = Array.from({ length: this.N }, () => new THREE.Color());
    this.frame = 0;
    this.setMode("activity");
  }

  setMode(mode) {
    this.mode = mode;
    const c = new THREE.Color();
    for (let i = 0; i < this.N; i++) {
      if (mode === "community") c.setHSL((this.analysis.lv.membership[i] * 0.618) % 1, 0.75, 0.58);
      else if (mode === "pagerank") {
        const r = Math.min(1, Math.sqrt(this.analysis.pr[i] * this.N) / 3);
        c.setHSL(0.62 - 0.6 * r, 0.9, 0.3 + 0.4 * r);
      } else c.set(CLASS_COLORS[this.cx.nodes[i].sc] || CLASS_COLORS.unknown);
      this.nodeCol[i].copy(c);
    }
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio);
    this.canvas.width = Math.round(this.el.clientWidth * dpr);
    this.canvas.height = Math.round(this.el.clientHeight * dpr);
  }

  render(sim, selected) {
    if (!this.el.offsetParent) return;
    if (++this.frame % 3) return; // ~20 fps is plenty here
    if (this.canvas.width !== Math.round(this.el.clientWidth * Math.min(2, devicePixelRatio))) this.resize();
    const N = this.N, R = sim.brains.R, act = this.act;
    if (selected >= 0) for (let i = 0; i < N; i++) act[i] = R[selected * N + i];
    else {
      act.fill(0);
      for (let f = 0; f < sim.n; f++) for (let i = 0; i < N; i++) act[i] += R[f * N + i];
      for (let i = 0; i < N; i++) act[i] = Math.min(1, act[i] / sim.n);
    }
    if (!this.drag) this.angle += 0.004;
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const scale = Math.min(W, H * 1.6) / 14;
    const ca = Math.cos(this.angle), sa = Math.sin(this.angle);
    const proj = (x, y, z) => [W / 2 + (x * ca + z * sa) * scale, H / 2 - y * scale];
    ctx.fillStyle = "#05080c";
    ctx.fillRect(0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H), d = img.data;
    const c = new THREE.Color();
    for (let k = 0; k < this.px.length; k++) {
      const [sx, sy] = proj(this.px[k], this.py[k], this.pz[k]);
      const x = sx | 0, y = sy | 0;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const g = this.grp[k];
      let a = 0;
      if (g !== 65535) {
        a = this.mode === "activity" ? act[g] : 0.6;
        if (this.mode === "activity") ramp(a, c).lerp(this.classCol[this.cls[k]], 1 - Math.min(1, a * 2));
        else c.copy(this.nodeCol[g]);
      } else c.copy(this.classCol[this.cls[k]]).multiplyScalar(0.45);
      const o = (y * W + x) * 4, alpha = 0.35 + 0.6 * Math.min(1, a * 2);
      d[o] += (c.r * 255 - d[o]) * alpha;
      d[o + 1] += (c.g * 255 - d[o + 1]) * alpha;
      d[o + 2] += (c.b * 255 - d[o + 2]) * alpha;
    }
    ctx.putImageData(img, 0, 0);
    for (let i = 0; i < N; i++) {
      const p = this.nodePos[i], [sx, sy] = proj(p.x, p.y, p.z);
      const a = this.mode === "activity" ? act[i] : 0.5;
      if (this.mode === "activity") ramp(a, c);
      else c.copy(this.nodeCol[i]);
      ctx.fillStyle = `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},0.8)`;
      ctx.beginPath();
      ctx.arc(sx, sy, (1.2 + 3 * a) * (W / 400), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `${Math.round(10 * (W / 400))}px JetBrains Mono, monospace`;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (const [k, side, text] of LABELS) {
      const idx = this.cx.io[k]?.[side];
      if (idx === undefined || idx < 0) continue;
      const p = this.nodePos[idx], [sx, sy] = proj(p.x, p.y, p.z);
      ctx.fillText(text, sx + 4, sy - 4);
    }
  }
}
