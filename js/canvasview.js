// Last-resort renderer for browsers with neither WebGL nor WebGPU: draws the
// swarm with the 2D canvas API, projecting through the same three.js camera so
// orbit controls and fly picking keep working unchanged.
import * as THREE from "three";
import { ARENA } from "./sim.js";

const STONE = "#3a4652", STONE_TOP = "#4b5a68";

export class CanvasRenderer {
  constructor(getState) {
    this.getState = getState; // () => ({ sim, settings, selected, flyColor })
    this.domElement = document.createElement("canvas");
    this.domElement.style.display = "block";
    this.ctx = this.domElement.getContext("2d");
    this.dpr = Math.min(2, devicePixelRatio);
    this.w = this.h = 1;
    this.v = new THREE.Vector3();
    this.c = new THREE.Color();
  }

  setPixelRatio(p) {
    this.dpr = p;
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
    this.domElement.width = Math.round(w * this.dpr);
    this.domElement.height = Math.round(h * this.dpr);
    this.domElement.style.width = w + "px";
    this.domElement.style.height = h + "px";
  }

  // world -> [screen x, screen y, pixels per world unit] or null if behind the camera
  project(x, y, z) {
    const cam = this.camera.position;
    const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
    const v = this.v.set(x, y, z).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    const ppu = this.h / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * d);
    return [((v.x + 1) / 2) * this.w, ((1 - v.y) / 2) * this.h, ppu];
  }

  polygon(points, fill, stroke) {
    const ctx = this.ctx;
    ctx.beginPath();
    let started = false;
    for (const [x, y, z] of points) {
      const p = this.project(x, y, z);
      if (!p) continue;
      started ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
      started = true;
    }
    if (!started) return;
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  circle(cx, y, cz, r, n = 28) {
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
    }
    return pts;
  }

  line(a, b, style, width = 1) {
    const p = this.project(...a), q = this.project(...b);
    if (!p || !q) return;
    const ctx = this.ctx;
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(q[0], q[1]);
    ctx.stroke();
  }

  render(scene, camera) {
    this.camera = camera;
    const { sim, settings, selected, flyColor } = this.getState();
    const ctx = this.ctx, H = ARENA / 2;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, this.w, this.h);

    // floor, grid, border
    this.polygon([[-H - 12, 0, -H - 12], [H + 12, 0, -H - 12], [H + 12, 0, H + 12], [-H - 12, 0, H + 12]], "#141b22");
    ctx.lineWidth = 1;
    for (let g = -H; g <= H + 0.01; g += ARENA / 24) {
      this.line([g, 0, -H], [g, 0, H], "#1c2731");
      this.line([-H, 0, g], [H, 0, g], "#1c2731");
    }
    this.polygon([[-H, 0, -H], [H, 0, -H], [H, 0, H], [-H, 0, H]], null, "#3d5266");

    // food patches
    for (const p of sim.patches) {
      const a = p.bitter ? 0.45 : 0.15 + 0.6 * p.sugar;
      this.polygon(this.circle(p.x, 0.02, p.z, p.r), p.bitter ? `rgba(154,92,255,${a})` : `rgba(242,165,65,${a})`, p.bitter ? "#c9a6ff" : "#ffd28a");
    }

    // social graph
    if (settings.social) {
      const E = sim.socialEdges;
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(127,183,255,0.22)";
      ctx.beginPath();
      for (let e = 0; e < E.length; e += 2) {
        const a = E[e], b = E[e + 1];
        const p = this.project(sim.x[a], sim.y[a] + 0.3, sim.z[a]), q = this.project(sim.x[b], sim.y[b] + 0.3, sim.z[b]);
        if (!p || !q) continue;
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
      }
      ctx.stroke();
    }

    // A* route of the selected fly
    if (settings.path && selected >= 0 && sim.path[selected]) {
      ctx.setLineDash([6, 4]);
      let prev = [sim.x[selected], 0.2, sim.z[selected]];
      for (let k = sim.pathIdx[selected]; k < sim.path[selected].length; k++) {
        const w = sim.path[selected][k];
        this.line(prev, [w[0], 0.2, w[1]], "#ffe08a", 1.5);
        prev = [w[0], 0.2, w[1]];
      }
      ctx.setLineDash([]);
    }

    // dead flies: dark crosses that fade
    for (const c of sim.corpses) {
      const p = this.project(c.x, c.y + 0.1, c.z);
      if (!p) continue;
      const r = Math.max(1.5, 0.45 * p[2]);
      ctx.strokeStyle = c.cause === "starved" || c.cause === "old" ? "rgba(90,90,90,0.8)" : "rgba(140,20,20,0.85)";
      ctx.lineWidth = Math.max(1, 0.2 * p[2]);
      ctx.beginPath();
      ctx.moveTo(p[0] - r, p[1] - r);
      ctx.lineTo(p[0] + r, p[1] + r);
      ctx.moveTo(p[0] + r, p[1] - r);
      ctx.lineTo(p[0] - r, p[1] + r);
      ctx.stroke();
    }

    // flies, far to near
    const order = [];
    for (let i = 0; i < sim.n; i++) order.push(i);
    const cam = camera.position;
    const dist = (i) => (sim.x[i] - cam.x) ** 2 + (sim.z[i] - cam.z) ** 2;
    order.sort((a, b) => dist(b) - dist(a));
    for (const i of order) {
      const x = sim.x[i], y = sim.y[i] + 0.25, z = sim.z[i], h = sim.h[i];
      const g = this.project(x, 0.02, z);
      if (g) {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.beginPath();
        ctx.arc(g[0], g[1], Math.max(1, 0.45 * g[2]), 0, Math.PI * 2);
        ctx.fill();
      }
      const head = this.project(x + Math.cos(h) * 0.5, y, z + Math.sin(h) * 0.5);
      const tail = this.project(x - Math.cos(h) * 0.7, y, z - Math.sin(h) * 0.7);
      if (!head || !tail) continue;
      const ppu = head[2];
      if (sim.y[i] > 0.05) {
        // wings
        const flap = 0.6 + 0.4 * Math.sin(sim.wing[i]);
        ctx.fillStyle = "rgba(207,230,255,0.35)";
        for (const s of [-1, 1]) {
          const wp = this.project(x - Math.cos(h) * 0.2 - Math.sin(h) * 0.5 * s * flap, y + 0.15, z - Math.sin(h) * 0.2 + Math.cos(h) * 0.5 * s * flap);
          if (!wp) continue;
          ctx.beginPath();
          ctx.arc(wp[0], wp[1], Math.max(1, 0.35 * ppu), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.strokeStyle = "#" + flyColor(i, this.c).getHexString();
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(2, 0.55 * ppu);
      ctx.beginPath();
      ctx.moveTo(tail[0], tail[1]);
      ctx.lineTo(head[0], head[1]);
      ctx.stroke();
      ctx.fillStyle = "#b3261e";
      ctx.beginPath();
      ctx.arc(head[0], head[1], Math.max(1, 0.18 * ppu), 0, Math.PI * 2);
      ctx.fill();
    }

    // leaders and selection
    if (settings.social)
      for (const i of sim.social.leaders || []) {
        const p = this.project(sim.x[i], sim.y[i] + 1.4, sim.z[i]);
        if (!p) continue;
        ctx.fillStyle = "#ffe08a";
        ctx.beginPath();
        ctx.moveTo(p[0], p[1] - 4);
        ctx.lineTo(p[0] + 3, p[1]);
        ctx.lineTo(p[0], p[1] + 4);
        ctx.lineTo(p[0] - 3, p[1]);
        ctx.fill();
      }
    if (selected >= 0 && selected < sim.n) {
      ctx.lineWidth = 2;
      this.polygon(this.circle(sim.x[selected], 0.05, sim.z[selected], 1), null, "#ffffff");
    }

    // pillars (drawn last so they occlude what is behind them roughly correctly)
    const obs = [...sim.obstacles].sort((a, b) => (b.x - cam.x) ** 2 + (b.z - cam.z) ** 2 - ((a.x - cam.x) ** 2 + (a.z - cam.z) ** 2));
    for (const o of obs) {
      this.polygon(this.circle(o.x, 0, o.z, o.r * 1.08), STONE);
      // side silhouette: hull of bottom and top rims
      const pts = [...this.circle(o.x, 0, o.z, o.r * 1.08, 20), ...this.circle(o.x, 7, o.z, o.r, 20)]
        .map((p) => this.project(...p))
        .filter(Boolean);
      const hull = convexHull(pts);
      if (hull.length > 2) {
        ctx.fillStyle = STONE;
        ctx.beginPath();
        hull.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.fill();
      }
      this.polygon(this.circle(o.x, 7, o.z, o.r), STONE_TOP);
    }

    // robots, the stacker's blocks, balls and dragonflies
    const ROBOT = { picker: "#d98e04", net: "#3fa36b", shooter: "#b84a3a", stacker: "#4a7bd1" };
    ctx.lineCap = "round";
    for (const R of sim.robots) {
      if (!sim.params.robots?.[R.kind]) continue;
      for (let j = 0; j + 1 < R.pts.length; j++) this.line(R.pts[j], R.pts[j + 1], ROBOT[R.kind], Math.max(2, 4 - j * 0.6));
      const t = R.pts.at(-1);
      if (R.kind === "net") this.polygon(this.circle(t[0], t[1], t[2], 1.6, 16), "rgba(159,216,176,0.2)", "#c8d0d8");
      if (R.kind === "stacker")
        for (const b of R.blocks) {
          const p = this.project(b.x, b.y, b.z);
          if (!p) continue;
          const h = 0.48 * p[2];
          ctx.fillStyle = b.state === "stack" ? "#f2c14e" : b.state === "falling" ? "#c0503a" : "#8a6a44";
          ctx.fillRect(p[0] - h, p[1] - h, 2 * h, 2 * h);
        }
    }
    ctx.fillStyle = "#ffb347";
    for (const b of sim.balls) {
      const p = this.project(b.x, b.y, b.z);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p[0], p[1], Math.max(1.5, 0.25 * p[2]), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const c of sim.chasers) {
      const a = Math.atan2(c.vz, c.vx);
      this.line([c.x - Math.cos(a) * 2.5, c.y, c.z - Math.sin(a) * 2.5], [c.x + Math.cos(a), c.y, c.z + Math.sin(a)], "#1fa3a3", 3);
      this.line([c.x - Math.sin(a) * 1.4, c.y, c.z + Math.cos(a) * 1.4], [c.x + Math.sin(a) * 1.4, c.y, c.z - Math.cos(a) * 1.4], "rgba(191,244,255,0.5)", 2);
    }

    // predator
    const pr = sim.predator;
    if (sim.params.predator || pr.y < 39) {
      const a = Math.atan2(pr.vz, pr.vx);
      const tip = [pr.x + Math.cos(a) * 2.6, pr.y, pr.z + Math.sin(a) * 2.6];
      const l = [pr.x - Math.cos(a) * 1.5 - Math.sin(a) * 4, pr.y, pr.z - Math.sin(a) * 1.5 + Math.cos(a) * 4];
      const r = [pr.x - Math.cos(a) * 1.5 + Math.sin(a) * 4, pr.y, pr.z - Math.sin(a) * 1.5 - Math.cos(a) * 4];
      this.polygon([tip, l, [pr.x, pr.y, pr.z], r], "#1b1f26", "#3a4250");
      const e = this.project(...tip);
      if (e) {
        ctx.fillStyle = "#ff4040";
        ctx.beginPath();
        ctx.arc(e[0], e[1], 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

// Andrew's monotone chain
function convexHull(pts) {
  const p = pts.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
