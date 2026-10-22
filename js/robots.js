// Robots that share the arena with the swarm. The arms follow ArmLab / 6dof-gym-web
// (https://shubin123.github.io/6dof-gym-web/): six revolute joints plus a tool,
// analytic IK targets and a safety layer, re-implemented here with joint dynamics
// (inertia, PD servo, torque and speed limits, sag under load).
//   picker   gripper arm: picks single flies off the food and crushes them
//   net      arm with a cloth net (mass-spring bag) that traps flies, closes by
//            a twist of the hoop and empties them into a killing jar
//   shooter  turret: fires balls (drag, bounce, momentum) at flies near the stacker
//   stacker  arm stacking 16 rigid blocks; flies bump it and stray balls knock
//            blocks out, and an off-balance tower falls by itself

export const ARM = { L0: 2.5, L1: 9, L2: 8, L3: 2.2 };
export const STACK_GOAL = 16;
export const ROBOT_KINDS = ["picker", "net", "shooter", "stacker"];
export const NET = { M: 12, D: 6, R: 1.6, SEG: 0.5 }; // ring points, rings below the hoop, hoop radius, ring spacing
export const JAR = { r: 1.8, h: 3 };
const DT = 1 / 30;
const G = 20; // gravity (world units / s²) shared with flies' corpses and balls
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------------------ arm kinematics and dynamics
// joint angles -> world points: base, shoulder, elbow, wrist, tool tip
export function fkArm(A, q = A.q) {
  const { L0, L1, L2, L3 } = ARM;
  const c = Math.cos(q[0]), s = Math.sin(q[0]);
  const at = (r, y) => [A.x + c * r, y, A.z + s * r];
  const a1 = q[1], a2 = q[1] + q[2], a3 = q[1] + q[2] + q[3];
  const r1 = L1 * Math.cos(a1), y1 = L0 + L1 * Math.sin(a1);
  const r2 = r1 + L2 * Math.cos(a2), y2 = y1 + L2 * Math.sin(a2);
  const r3 = r2 + L3 * Math.cos(a3), y3 = y2 + L3 * Math.sin(a3);
  return [[A.x, 0, A.z], at(0, L0), at(r1, y1), at(r2, y2), at(r3, y3)];
}

// analytic IK for the tool tip at goal with the tool pointing straight down (elbow up)
function ikArm(A, goal, wristYaw = 0) {
  const { L0, L1, L2, L3 } = ARM;
  const gx = goal[0] - A.x, gz = goal[2] - A.z;
  const gy = Math.max(0.2, goal[1]);
  const q0 = Math.hypot(gx, gz) > 0.3 ? Math.atan2(gz, gx) : A.q[0];
  const r = Math.min(Math.hypot(gx, gz), L1 + L2 - 0.05);
  const h = gy + L3 - L0; // the wrist sits L3 above the tip
  const d = clamp(Math.hypot(r, h), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
  const a1 = Math.atan2(h, r) + Math.acos((d * d + L1 * L1 - L2 * L2) / (2 * L1 * d));
  const a2 = Math.atan2(h - L1 * Math.sin(a1), r - L1 * Math.cos(a1));
  return [q0, a1, a2 - a1, -Math.PI / 2 - a2, wristYaw, 0];
}

// Per joint: inertia grows with what the tool carries, a PID servo with gravity
// feed-forward (for the bare arm, so an unmodelled payload still sags until the
// integral catches up) produces torque that saturates, and speed is limited. A step that would put the tool
// under the floor or outside the joint limits is rejected, as in ArmLab.
const INERTIA = [3, 4, 2.5, 0.6, 0.3, 0.3];
const TORQUE = [26, 40, 30, 8, 4, 4];
const VMAX = [1.6, 1.4, 1.8, 3, 4, 4];
const KP = [30, 40, 30, 14, 8, 8], KD = [16, 22, 15, 4, 2.4, 2.4], KI = [4, 30, 24, 4, 0, 0];
const QMIN = [-Infinity, 0.05, -2.95, -3.1, -Infinity, -Infinity], QMAX = [Infinity, 2.9, 0, 3.1, Infinity, Infinity];
function driveArm(A, goal, wristYaw = 0, load = 0) {
  const want = ikArm(A, goal, wristYaw);
  const q = A.q.slice();
  const a1 = q[1], a2 = q[1] + q[2];
  const sag = [0, (2 + 6 * load) * Math.cos(a1) + (1 + 4 * load) * Math.cos(a2), (1 + 4 * load) * Math.cos(a2), 0, 0, 0];
  const ff = [0, 2 * Math.cos(a1) + Math.cos(a2), Math.cos(a2), 0, 0, 0];
  A.qi ||= [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < 6; k++) {
    const I = INERTIA[k] * (1 + (k > 0 ? load : 0.5 * load));
    const e = wrap(want[k] - q[k]);
    A.qi[k] = clamp(A.qi[k] + e * DT, -0.3, 0.3); // anti-windup
    const tau = clamp(KP[k] * e - KD[k] * A.qd[k] + KI[k] * A.qi[k] + ff[k], -TORQUE[k], TORQUE[k]);
    A.qd[k] = clamp(A.qd[k] + ((tau - sag[k]) / I) * DT, -VMAX[k], VMAX[k]);
    q[k] = clamp(q[k] + A.qd[k] * DT, QMIN[k], QMAX[k]);
    if (q[k] === QMIN[k] || q[k] === QMAX[k]) A.qd[k] = 0;
  }
  const pts = fkArm(A, q);
  if (pts.slice(2).some((p) => p[1] < 0.05)) {
    A.qd.fill(0); // safety: reject the step
    A.rejected = (A.rejected || 0) + 1;
  } else A.q = q;
  A.pts = fkArm(A);
}
const tipSpeed = (A) => Math.abs(A.qd[0]) * 10 + Math.abs(A.qd[1]) * 10 + Math.abs(A.qd[2]) * 6;
const near = (p, q, tol) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;

// ------------------------------------------------------------------ setup
export function makeRobots(sim, rng) {
  // bases sit in open floor, clear of pillars and of each other
  const spots = [[0, 0]];
  for (let tries = 0; spots.length < 4 && tries < 2000; tries++) {
    const a = rng() * Math.PI * 2, r = 22 + rng() * 22;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (sim.obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 8)) continue;
    if (spots.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 26)) continue;
    spots.push([x, z]);
  }
  while (spots.length < 4) spots.push([(spots.length - 2) * 30, -40]);
  return ROBOT_KINDS.map((kind, k) => {
    const [x, z] = spots[k];
    const R = { kind, x, z, state: "scan", timer: 1 + k * 0.3, kills: 0, held: [] };
    if (kind === "shooter") {
      Object.assign(R, { yaw: 0, pitch: 0.3, yawV: 0, pitchV: 0, recoil: 0, reload: 0, shots: 0, hits: 0, target: -1 });
      shooterPoints(R);
      return R;
    }
    Object.assign(R, { q: [rng() * 6, 1.2, -2.2, -0.6, 0, 0], qd: [0, 0, 0, 0, 0, 0], grip: 1, fly: -1, path: null, dropAt: [x + 9, 4, z] });
    R.pts = fkArm(R);
    if (kind === "net") {
      const a = rng() * Math.PI * 2;
      Object.assign(R, { jar: [x + Math.cos(a) * 7, z + Math.sin(a) * 7], lid: 0, caught: [], bodies: [], closed: false, n: [0, -1, 0], netted: 0, escaped: 0, jarred: 0 });
      initNet(R);
    }
    if (kind === "stacker") {
      const a0 = rng() * Math.PI * 2;
      R.stackAt = [x + Math.cos(a0) * 8, z + Math.sin(a0) * 8];
      R.blocks = [];
      for (let b = 0; b < STACK_GOAL; b++) R.blocks.push({ x: 0, y: 0.5, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, rx: 0, rz: 0, wx: 0, wz: 0, held: false });
      scatterBlocks(R, rng, false);
      Object.assign(R, { stacked: 0, completions: 0, knocked: 0, startT: 0, bestTime: null, block: -1, collapses: 0 });
    }
    return R;
  });
}

function shooterPoints(R) {
  const top = [R.x, 3, R.z];
  const cp = Math.cos(R.pitch), len = 3 - R.recoil;
  R.pts = [[R.x, 0, R.z], top, [R.x + Math.cos(R.yaw) * cp * len, 3 + Math.sin(R.pitch) * len, R.z + Math.sin(R.yaw) * cp * len]];
}

// ------------------------------------------------------------------ update
export function updateRobots(sim) {
  const on = sim.params.robots || {};
  for (const R of sim.robots) {
    if (!on[R.kind]) park(sim, R);
    else {
      if (R.state === "park") (R.state = "scan"), (R.timer = 0.5);
      R.timer -= DT;
      if (R.kind === "picker") picker(sim, R);
      else if (R.kind === "net") net(sim, R);
      else if (R.kind === "shooter") shooter(sim, R);
      else stacker(sim, R);
    }
    if (R.kind === "net") {
      stepCloth(sim, R);
      bagContents(sim, R);
      jar(sim, R);
    }
    if (R.kind === "stacker") stepBlocks(sim, R);
    carry(R);
  }
  updateBalls(sim);
}

function park(sim, R) {
  R.state = "park";
  release(R);
  if (R.kind === "shooter") {
    R.pitch += (-0.2 - R.pitch) * 0.05;
    return shooterPoints(R);
  }
  if (R.kind === "net") freeAll(sim, R, false);
  if (R.kind === "stacker" && R.block >= 0) letGo(R);
  driveArm(R, [R.x + 4, 10, R.z]);
}

// bodies the picker has crushed ride in its fingers until it lets go
function carry(R) {
  if (!R.held.length || R.kind !== "picker") return;
  const t = R.pts[4];
  for (const c of R.held) Object.assign(c, { x: t[0] + c.ox, y: Math.max(0, t[1] - 0.4 + c.oy), z: t[2] + c.oz, vx: 0, vy: 0, vz: 0 });
}
function release(R) {
  for (const c of R.held) Object.assign(c, { held: false, vx: 0, vy: 0, vz: 0 });
  R.held.length = 0;
}

// called by the sim when a fly dies of a robot: keep the body where the robot has it
export function collectBody(sim, R, c, i) {
  if (R.kind === "picker") {
    Object.assign(c, { held: true, ox: (sim.rng() - 0.5) * 0.2, oy: -sim.rng() * 0.2, oz: (sim.rng() - 0.5) * 0.2 });
    R.held.push(c);
  } else if (R.kind === "net") {
    const k = R.caught.findIndex((e) => e.i === i);
    if (k < 0) return;
    const e = R.caught.splice(k, 1)[0];
    c.held = true;
    R.bodies.push({ c, u: e.u, a: e.a, f: e.f });
  }
}

const free = (sim, i) => i >= 0 && i < sim.n && sim.hp[i] > 0 && sim.energy[i] > 0 && !sim.held[i];
const reach = ARM.L1 + ARM.L2 - 0.5;

// ------------------------------------------------------------------ picker
function picker(sim, R) {
  let goal = [R.x + 6, 9, R.z], close = false;
  switch (R.state) {
    case "scan": {
      R.grip = 1;
      if (R.timer > 0) break;
      let best = -1, bs = Infinity;
      for (let i = 0; i < sim.n; i++) {
        // a gripper can only take a fly that holds still: one sitting down, feeding or resting
        if (!free(sim, i) || sim.y[i] > 0.6 || sim.speed[i] > 3) continue;
        const r = Math.hypot(sim.x[i] - R.x, sim.z[i] - R.z);
        if (r > reach || r < 3) continue;
        const score = r * (0.5 + 0.5 * sim.hp[i]);
        if (score < bs) (bs = score), (best = i);
      }
      if (best >= 0) (R.fly = best), (R.state = "reach"), (R.timer = 8);
      else R.timer = 0.5;
      break;
    }
    case "reach":
      if (!free(sim, R.fly) || R.timer <= 0) (R.state = "scan"), (R.timer = 0.3);
      else {
        // creep in to just above it, slowly enough not to set off its looming detectors
        goal = [sim.x[R.fly], sim.y[R.fly] + 1.4, sim.z[R.fly]];
        const t = R.pts[4];
        if (sim.y[R.fly] > 1.5) (R.state = "scan"), (R.timer = 0.3); // it took off
        else if (Math.hypot(t[0] - goal[0], t[2] - goal[2]) < 0.6 && Math.abs(t[1] - goal[1]) < 0.6) (R.state = "strike"), (R.timer = 0.6);
      }
      break;
    case "strike":
      // drop and snap shut the moment anything is between the fingers
      if (!free(sim, R.fly)) (R.state = "lift"), (R.timer = 1);
      else {
        goal = [sim.x[R.fly], sim.y[R.fly], sim.z[R.fly]];
        const t = R.pts[4];
        if (R.timer <= 0 || sim.hash.query(t[0], t[2], 0.9, sim.x, sim.z, sim.tmp).some((i) => free(sim, i) && Math.abs(sim.y[i] - t[1]) < 0.7)) close = true;
      }
      break;
    case "lift":
      goal = [R.pts[4][0], 10, R.pts[4][2]];
      R.grip = Math.max(0, R.grip - 4 * DT);
      if (R.timer <= 0) (R.state = "drop"), (R.timer = 3);
      break;
    case "drop":
      goal = R.dropAt;
      if (R.timer <= 0.6) {
        R.grip = Math.min(1, R.grip + 3 * DT);
        release(R);
      }
      if (R.timer <= 0) (R.state = "scan"), (R.timer = 0.5);
      break;
  }
  if (close) {
    // whatever is between the fingers is crushed; flies brushing the fingers are clipped
    const t = R.pts[4];
    for (let i = 0; i < sim.n; i++) {
      if (!free(sim, i)) continue;
      const dh = Math.hypot(sim.x[i] - t[0], sim.z[i] - t[2]), dy = Math.abs(sim.y[i] - t[1]);
      if (dh > 1.3 || dy > 1.2) continue;
      if (sim.wound(i, dh < 0.9 && dy < 0.8 ? 1 : 0.35, "picked", R)) R.kills++;
      else {
        const a = Math.atan2(sim.z[i] - t[2], sim.x[i] - t[0]);
        sim.push(i, Math.cos(a) * 6, 5, Math.sin(a) * 6); // squirms free, wounded
        sim.escape[i] = 1;
      }
    }
    Object.assign(R, { fly: -1, state: "lift", timer: 1.4, grip: 0 });
    const a = R.q[0] + Math.PI * (0.6 + 0.8 * sim.rng());
    R.dropAt = [R.x + Math.cos(a) * 9, 4, R.z + Math.sin(a) * 9];
  }
  // the servo tracks a set-point that moves at a capped speed: fast across the
  // arena, a slow creep over the last few units so the fly is not startled
  R.sp ||= R.pts[4].slice();
  const dx = goal[0] - R.sp[0], dy = goal[1] - R.sp[1], dz = goal[2] - R.sp[2], d = Math.hypot(dx, dy, dz);
  const vmax = R.state === "strike" ? 30 : R.state === "reach" && R.fly >= 0 ? (Math.hypot(sim.x[R.fly] - R.pts[4][0], sim.z[R.fly] - R.pts[4][2]) < 4 ? 1.2 : 10) : 10;
  const k = d > vmax * DT ? (vmax * DT) / d : 1;
  R.sp = [R.sp[0] + dx * k, R.sp[1] + dy * k, R.sp[2] + dz * k];
  driveArm(R, R.sp, 0, R.held.length * 0.1);
}

// ------------------------------------------------------------------ net: cloth, capture, jar
// The bag is a mass-spring cloth (position-based dynamics, Jakobsen 2001):
// ring 0 is pinned to the hoop, rings 1..D and an apex hang from it under
// gravity and air drag, so a sweeping net trails behind the hoop and a still
// one hangs. Flies that pass through the mouth are inside; they struggle (the
// cloth bulges where they push) and crawl toward the mouth to escape until the
// hoop is twisted shut.
function initNet(R) {
  const { M, D } = NET;
  const count = M * D + 1 + M; // rings 1..D, apex, plus the hoop ring (pinned)
  R.cloth = new Float32Array(count * 3);
  R.clothPrev = new Float32Array(count * 3);
  hoopFrame(R);
  const c = R.hoop, idx = (k, j) => (k === 0 ? M * D + 1 + j : (k - 1) * M + j);
  for (let k = 0; k <= D; k++)
    for (let j = 0; j < M; j++) {
      const p = ringPoint(R, j, NET.R * (1 - 0.13 * k));
      const o = idx(k, j) * 3;
      R.cloth.set([p[0], p[1] - k * NET.SEG, p[2]], o);
    }
  R.cloth.set([c[0], c[1] - (D + 1) * NET.SEG, c[2]], M * D * 3);
  R.clothPrev.set(R.cloth);
}
export const netIndex = (k, j) => (k === 0 ? NET.M * NET.D + 1 + (j % NET.M) : k > NET.D ? NET.M * NET.D : (k - 1) * NET.M + (j % NET.M));
let NET_LINKS = null;
function netLinks() {
  if (NET_LINKS) return NET_LINKS;
  const { M, D, R: r0, SEG } = NET, L = [];
  const rad = (k) => r0 * (1 - 0.13 * k);
  for (let k = 0; k <= D; k++)
    for (let j = 0; j < M; j++) {
      L.push(netIndex(k, j), netIndex(k, j + 1), 2 * rad(k) * Math.sin(Math.PI / M)); // around the ring
      if (k < D) L.push(netIndex(k, j), netIndex(k + 1, j), Math.hypot(SEG, rad(k) - rad(k + 1))); // down the bag
      else L.push(netIndex(k, j), netIndex(D + 1, 0), Math.hypot(SEG, rad(k)));
      if (k < D) L.push(netIndex(k, j), netIndex(k + 1, j + 1), Math.hypot(SEG, rad(k) - rad(k + 1)) * 1.25); // shear, slack
    }
  return (NET_LINKS = new Float32Array(L));
}

// hoop centre and an orthonormal frame (n = mouth direction)
function hoopFrame(R) {
  const n = R.n, t = R.pts[4];
  let ux = -n[2], uy = 0, uz = n[0];
  let ul = Math.hypot(ux, uz);
  if (ul < 1e-3) (ux = 1), (uz = 0), (ul = 1);
  ux /= ul;
  uz /= ul;
  const v = [n[1] * uz - n[2] * uy, n[2] * ux - n[0] * uz, n[0] * uy - n[1] * ux];
  R.u = [ux, uy, uz];
  R.v = v;
  R.hoop = [t[0] + n[0] * 0.2, t[1] + n[1] * 0.2, t[2] + n[2] * 0.2];
}
function ringPoint(R, j, r) {
  const a = (j / NET.M) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
  return [R.hoop[0] + R.u[0] * c + R.v[0] * s, R.hoop[1] + R.u[1] * c + R.v[1] * s, R.hoop[2] + R.u[2] * c + R.v[2] * s];
}

// turn the mouth toward a wanted direction at a limited wrist rate
function aimHoop(R, want, rate = 3) {
  const n = R.n;
  const l = Math.hypot(...want) || 1;
  const w = want.map((x) => x / l);
  const d = clamp(n[0] * w[0] + n[1] * w[1] + n[2] * w[2], -1, 1);
  const ang = Math.acos(d), step = Math.min(1, (rate * DT) / Math.max(ang, 1e-6));
  for (let k = 0; k < 3; k++) n[k] += (w[k] - n[k]) * step;
  const nl = Math.hypot(...n) || 1;
  for (let k = 0; k < 3; k++) n[k] /= nl;
}

function stepCloth(sim, R) {
  hoopFrame(R);
  const P = R.cloth, Q = R.clothPrev, { M, D } = NET;
  const pinned = M * D + 1;
  // the hoop ring follows the tool exactly
  for (let j = 0; j < M; j++) {
    const p = ringPoint(R, j, NET.R), o = (pinned + j) * 3;
    Q[o] = P[o];
    Q[o + 1] = P[o + 1];
    Q[o + 2] = P[o + 2];
    P.set(p, o);
  }
  // Verlet integration with air drag; heavier where flies sit
  const drag = 0.06, g = G * DT * DT; // netting is light, so air drag dominates: terminal speed ~11 units/s
  for (let p = 0; p < pinned; p++) {
    const o = p * 3;
    for (let k = 0; k < 3; k++) {
      const x = P[o + k], v = (x - Q[o + k]) * (1 - drag);
      Q[o + k] = x;
      P[o + k] = x + v - (k === 1 ? g : 0);
    }
  }
  const L = netLinks();
  for (let it = 0; it < 8; it++) {
    for (let e = 0; e < L.length; e += 3) {
      const a = L[e] * 3, b = L[e + 1] * 3, rest = L[e + 2];
      const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
      const d = Math.hypot(dx, dy, dz);
      if (d <= rest || d < 1e-6) continue; // netting is slack in compression
      const diff = (d - rest) / d;
      const wa = L[e] >= pinned ? 0 : 1, wb = L[e + 1] >= pinned ? 0 : 1;
      const s = diff / (wa + wb || 1);
      P[a] += dx * s * wa;
      P[a + 1] += dy * s * wa;
      P[a + 2] += dz * s * wa;
      P[b] -= dx * s * wb;
      P[b + 1] -= dy * s * wb;
      P[b + 2] -= dz * s * wb;
    }
    for (let p = 0; p < pinned; p++) {
      const o = p * 3;
      if (P[o + 1] < 0.05) P[o + 1] = 0.05; // floor
      for (const ob of sim.obstacles) {
        const dx = P[o] - ob.x, dz = P[o + 2] - ob.z, d = Math.hypot(dx, dz);
        if (d < ob.r + 0.05 && P[o + 1] < 7) (P[o] = ob.x + (dx / d) * (ob.r + 0.05)), (P[o + 2] = ob.z + (dz / d) * (ob.r + 0.05));
      }
    }
  }
}

// a point inside the bag from (u along the bag 0..1, a around 0..1, f out from the axis 0..1)
function bagPoint(R, u, a, f) {
  const P = R.cloth, { M, D } = NET;
  const kf = clamp(u, 0, 1) * D, k0 = Math.floor(Math.min(kf, D - 1e-6)), t = kf - k0;
  const ring = (k) => {
    if (k > D) {
      const o = netIndex(D + 1, 0) * 3;
      return [P[o], P[o + 1], P[o + 2]];
    }
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < M; j++) {
      const o = netIndex(k, j) * 3;
      cx += P[o];
      cy += P[o + 1];
      cz += P[o + 2];
    }
    cx /= M;
    cy /= M;
    cz /= M;
    const jf = (((a % 1) + 1) % 1) * M, j0 = Math.floor(jf), s = jf - j0;
    const o0 = netIndex(k, j0) * 3, o1 = netIndex(k, j0 + 1) * 3;
    const px = P[o0] + (P[o1] - P[o0]) * s, py = P[o0 + 1] + (P[o1 + 1] - P[o0 + 1]) * s, pz = P[o0 + 2] + (P[o1 + 2] - P[o0 + 2]) * s;
    return [cx + (px - cx) * f, cy + (py - cy) * f, cz + (pz - cz) * f];
  };
  const p0 = ring(k0), p1 = ring(k0 + 1);
  return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];
}

// is a world point inside the bag? returns u (depth) and the radial fraction, or null
function inBag(R, x, y, z) {
  const P = R.cloth, c = R.hoop, o = netIndex(NET.D + 1, 0) * 3;
  const ax = P[o] - c[0], ay = P[o + 1] - c[1], az = P[o + 2] - c[2];
  const L = Math.hypot(ax, ay, az);
  if (L < 0.3) return null;
  const dx = x - c[0], dy = y - c[1], dz = z - c[2];
  const t = (dx * ax + dy * ay + dz * az) / (L * L);
  if (t < 0 || t > 1) return null;
  const rx = dx - ax * t, ry = dy - ay * t, rz = dz - az * t;
  const rad = Math.hypot(rx, ry, rz), max = NET.R * (1 - 0.8 * t);
  if (rad > max) return null;
  // angle around the axis, measured against the hoop frame
  const a = (Math.atan2(rx * R.v[0] + ry * R.v[1] + rz * R.v[2], rx * R.u[0] + ry * R.u[1] + rz * R.u[2]) / (Math.PI * 2) + 1) % 1;
  return { u: t, a, f: rad / NET.R };
}

function bagContents(sim, R) {
  const P = R.cloth;
  // capture: any free fly now inside the bag came in through the mouth
  // (only a net moving mouth-first scoops flies up; a still net is simply avoided)
  if (R.state === "sweep") {
    const c = R.hoop;
    for (const i of sim.hash.query(c[0], c[2], NET.R + NET.D * NET.SEG + 0.5, sim.x, sim.z, sim.tmp)) {
      if (R.caught.length >= 12) break; // a full bag
      if (!free(sim, i)) continue;
      const b = inBag(R, sim.x[i], sim.y[i], sim.z[i]);
      if (!b) continue;
      sim.held[i] = 1;
      R.caught.push({ i, id: sim.id[i], u: b.u, a: b.a, f: clamp(b.f, 0.2, 0.8) });
      R.netted++;
    }
  }
  R.caught = R.caught.filter((e) => e.i < sim.n && sim.id[e.i] === e.id && sim.held[e.i] === 1);
  for (let k = R.caught.length - 1; k >= 0; k--) {
    const e = R.caught[k], i = e.i;
    // while the net sweeps, the air rushing through it presses flies to the bottom;
    // otherwise they settle, but a fly whose escape reflex fires crawls for the mouth
    const panic = sim.escape[i] > 0 || sim.rng() < 0.02;
    const du = R.state === "sweep" ? 0.03 : panic ? -0.012 : 0.004;
    e.u = clamp(e.u + du + (sim.rng() - 0.5) * 0.01, 0, 0.97);
    e.a += (sim.rng() - 0.5) * 0.05;
    e.f = clamp(e.f + (sim.rng() - 0.5) * 0.08, 0.2, 0.85);
    const p = bagPoint(R, e.u, e.a, e.f);
    // the fly's push and weight deform the cloth nearby
    const kk = Math.min(NET.D, Math.max(1, Math.round(e.u * NET.D))), jj = Math.round(e.a * NET.M) % NET.M;
    const o = netIndex(kk, jj) * 3;
    P[o] += (P[o] - p[0]) * 0.06 * (panic ? 2 : 1);
    P[o + 1] += (P[o + 1] - p[1]) * 0.06 * (panic ? 2 : 1) - 0.004;
    P[o + 2] += (P[o + 2] - p[2]) * 0.06 * (panic ? 2 : 1);
    sim.x[i] = p[0];
    sim.y[i] = Math.max(0, p[1]);
    sim.z[i] = p[2];
    sim.speed[i] = 0;
    sim.wing[i] += 2; // buzzing
    // abrasion against the mesh
    if (sim.wound(i, 0.04 * DT, "netted", R)) R.kills++;
    if (e.u <= 0.02 && !R.closed) {
      // out through the mouth
      sim.held[i] = 0;
      sim.push(i, R.n[0] * 6, R.n[1] * 6 + 3, R.n[2] * 6);
      sim.escape[i] = 1;
      R.caught.splice(k, 1);
      R.escaped++;
    }
  }
  for (const b of R.bodies) {
    const p = bagPoint(R, b.u, b.a, b.f);
    b.u = Math.min(0.97, b.u + 0.01);
    Object.assign(b.c, { x: p[0], y: Math.max(0, p[1]), z: p[2], vx: 0, vy: 0, vz: 0 });
  }
}

// tip everything out of the mouth; over the jar it all goes in
function freeAll(sim, R, overJar) {
  for (const e of R.caught) {
    if (e.i >= sim.n || sim.id[e.i] !== e.id) continue;
    sim.held[e.i] = 0;
    if (overJar) {
      sim.held[e.i] = 2;
      sim.x[e.i] = R.jar[0] + (sim.rng() - 0.5);
      sim.z[e.i] = R.jar[1] + (sim.rng() - 0.5);
      sim.y[e.i] = JAR.h - 0.3;
      R.jarred++;
    } else sim.push(e.i, (sim.rng() - 0.5) * 4, 2, (sim.rng() - 0.5) * 4);
  }
  for (const b of R.bodies) Object.assign(b.c, { held: false, vy: -1, vx: 0, vz: 0 });
  R.caught.length = 0;
  R.bodies.length = 0;
}

// the killing jar: flies inside are trapped under the lid and die within seconds
function jar(sim, R) {
  const [jx, jz] = R.jar;
  R.lid = clamp(R.lid + (R.state === "dump" && R.timer < 2.4 ? -2 : 1) * DT, 0, 1);
  for (let i = 0; i < sim.n; i++) {
    if (sim.held[i] !== 2) continue;
    const dx = sim.x[i] - jx, dz = sim.z[i] - jz, d = Math.hypot(dx, dz), lim = JAR.r - 0.3;
    if (d > lim) (sim.x[i] = jx + (dx / d) * lim), (sim.z[i] = jz + (dz / d) * lim);
    if (sim.y[i] > JAR.h - 0.3) (sim.y[i] = JAR.h - 0.3), (sim.vy[i] = Math.min(0, sim.vy[i]));
    if (sim.wound(i, 0.3 * DT, "netted", R)) R.kills++;
  }
  // bodies settle inside the glass
  for (const c of sim.corpses) {
    const dx = c.x - jx, dz = c.z - jz, d = Math.hypot(dx, dz);
    if (d < JAR.r + 0.5 && d > JAR.r - 0.3 && c.y < JAR.h && !c.held) (c.x = jx + (dx / d) * (JAR.r - 0.3)), (c.z = jz + (dz / d) * (JAR.r - 0.3)), (c.vx = c.vz = 0);
  }
}

function net(sim, R) {
  let goal = [R.x - 5, 9, R.z], want = [0, -1, 0], load = (R.caught.length + R.bodies.length) * 0.02;
  switch (R.state) {
    case "scan": {
      R.closed = false;
      if (R.timer > 0) break;
      // the densest knot of free flies within reach (sampled)
      let best = -1, bs = 2;
      for (let s = 0; s < 40; s++) {
        const i = Math.floor(sim.rng() * sim.n);
        if (!free(sim, i)) continue;
        const r = Math.hypot(sim.x[i] - R.x, sim.z[i] - R.z);
        if (r > reach - 3 || r < 6) continue;
        const k = sim.hash.query(sim.x[i], sim.z[i], 3, sim.x, sim.z, sim.tmp).length;
        if (k > bs) (bs = k), (best = i);
      }
      if (best < 0) {
        R.timer = 0.6;
        break;
      }
      // sweep tangentially through the knot, mouth first, at the flies' height
      const cx = sim.x[best], cz = sim.z[best], cy = Math.max(1.2, sim.y[best] + 0.6);
      const a = Math.atan2(cz - R.z, cx - R.x) + Math.PI / 2 * (sim.rng() < 0.5 ? 1 : -1);
      R.path = [[cx - Math.cos(a) * 7, cy + 0.5, cz - Math.sin(a) * 7], [cx + Math.cos(a) * 7, cy, cz + Math.sin(a) * 7], [Math.cos(a), 0, Math.sin(a)]];
      R.state = "windup";
      R.timer = 4;
      break;
    }
    case "windup":
      goal = R.path[0];
      want = R.path[2];
      if (near(R.pts[4], goal, 1.2) || R.timer <= 0) (R.state = "sweep"), (R.timer = 2.5);
      break;
    case "sweep":
      goal = R.path[1];
      want = R.path[2];
      if (near(R.pts[4], goal, 1.2) || R.timer <= 0) (R.state = "twist"), (R.timer = 0.8);
      break;
    case "twist":
      // flip the hoop so the bag folds over the rim: the classic way to close a net
      goal = [R.pts[4][0], R.pts[4][1] + 2, R.pts[4][2]];
      want = [-R.path[2][2], 0.2, R.path[2][0]];
      if (R.timer <= 0) {
        R.closed = true;
        R.state = R.caught.length || R.bodies.length ? "carry" : "scan";
        R.timer = R.state === "carry" ? 5 : 0.8;
      }
      break;
    case "carry":
      goal = [R.jar[0], JAR.h + 5, R.jar[1]];
      want = [-R.path[2][2], 0.2, R.path[2][0]];
      if ((near(R.pts[4], goal, 1) && tipSpeed(R) < 1.5) || R.timer <= 0) (R.state = "dump"), (R.timer = 2.6);
      break;
    case "dump":
      // mouth down over the open jar and shake
      goal = [R.jar[0] + Math.sin(R.timer * 18) * 0.25, JAR.h + 3, R.jar[1]];
      want = [0, -1, 0];
      if (R.timer < 1.8 && (R.caught.length || R.bodies.length)) freeAll(sim, R, near(R.hoop, [R.jar[0], R.hoop[1], R.jar[1]], JAR.r));
      if (R.timer <= 0) (R.state = "scan"), (R.timer = 1);
      break;
  }
  aimHoop(R, want, R.state === "twist" ? 5 : 2.5);
  driveArm(R, goal, 0, load);
}

// ------------------------------------------------------------------ shooter and balls
const BALL_SPEED = 34, BALL_MASS = 0.15, BALL_R = 0.25, BALL_DRAG = 0.012; // quadratic drag per unit speed
function shooter(sim, R) {
  R.reload -= DT;
  R.recoil = Math.max(0, R.recoil - 3 * DT);
  if (R.timer <= 0 || !free(sim, R.target)) {
    // cover the stacker: shoot the flies closest to it first, else the nearest fly in range
    const st = sim.robots.find((q) => q.kind === "stacker");
    const guard = st && sim.params.robots?.stacker ? st.stackAt : null;
    let best = -1, bs = Infinity;
    for (let i = 0; i < sim.n; i++) {
      if (!free(sim, i)) continue;
      const d = Math.hypot(sim.x[i] - R.x, sim.z[i] - R.z);
      if (d > 45 || d < 3) continue;
      const score = d + (guard ? 1.5 * Math.hypot(sim.x[i] - guard[0], sim.z[i] - guard[1]) : 0);
      if (score < bs) (bs = score), (best = i);
    }
    R.target = best;
    R.timer = 1.5;
  }
  if (R.target < 0) return shooterPoints(R);
  // lead the target, then lift the barrel to cancel the ball's drop (drag adds ~flight time)
  const i = R.target, m = R.pts[1];
  let tx = sim.x[i], tz = sim.z[i], t = 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.hypot(tx - m[0], tz - m[2]);
    t = d / (BALL_SPEED * (1 - BALL_DRAG * BALL_SPEED * 0.25 * Math.min(1, d / 40)));
    tx = sim.x[i] + (Math.cos(sim.h[i]) * sim.speed[i] + sim.kvx[i]) * t;
    tz = sim.z[i] + (Math.sin(sim.h[i]) * sim.speed[i] + sim.kvz[i]) * t;
  }
  const horiz = Math.hypot(tx - m[0], tz - m[2]);
  const vy = (sim.y[i] - m[1]) / Math.max(t, 1e-3) + 0.5 * G * t;
  const wantYaw = Math.atan2(tz - m[2], tx - m[0]), wantPitch = Math.atan2(vy, horiz / Math.max(t, 1e-3));
  // turret drives: PD with acceleration limits, so it overshoots a little on fast slews
  const ey = wrap(wantYaw - R.yaw), ep = wantPitch - R.pitch;
  R.yawV = clamp(R.yawV + clamp(60 * ey - 12 * R.yawV, -30, 30) * DT, -4, 4);
  R.pitchV = clamp(R.pitchV + clamp(60 * ep - 12 * R.pitchV, -25, 25) * DT, -3, 3);
  R.yaw += R.yawV * DT;
  R.pitch += R.pitchV * DT;
  shooterPoints(R);
  if (R.reload <= 0 && Math.abs(ey) < 0.04 && Math.abs(ep) < 0.04 && Math.abs(R.yawV) < 0.6) {
    const sp = Math.hypot(horiz / Math.max(t, 1e-3), vy);
    const mz = R.pts[2];
    sim.balls.push({ x: mz[0], y: mz[1], z: mz[2], vx: Math.cos(R.yaw) * Math.cos(R.pitch) * sp, vy: Math.sin(R.pitch) * sp, vz: Math.sin(R.yaw) * Math.cos(R.pitch) * sp, age: 0, from: R });
    if (sim.balls.length > 80) sim.balls.shift();
    R.reload = 0.6;
    R.recoil = 0.6;
    R.pitchV += 1.2; // muzzle climb
    R.shots++;
  }
}

// closest point on segment ab to p
function closestOnSeg(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const t = clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / (abx * abx + aby * aby + abz * abz || 1), 0, 1);
  return [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t];
}
function bounce(b, nx, ny, nz, e, mu = 0.2) {
  const vn = b.vx * nx + b.vy * ny + b.vz * nz;
  if (vn >= 0) return 0;
  b.vx -= (1 + e) * vn * nx;
  b.vy -= (1 + e) * vn * ny;
  b.vz -= (1 + e) * vn * nz;
  // friction on the tangential part
  b.vx *= 1 - mu;
  b.vz *= 1 - mu;
  return -vn;
}

function updateBalls(sim) {
  const st = sim.robots.find((q) => q.kind === "stacker" && sim.params.robots?.stacker);
  const arms = sim.robots.filter((q) => q.kind !== "shooter" && sim.params.robots?.[q.kind]);
  for (const b of sim.balls) {
    b.age += DT;
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    const k = 1 - BALL_DRAG * sp * DT;
    b.vx *= k;
    b.vy = b.vy * k - G * DT;
    b.vz *= k;
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.z += b.vz * DT;
    if (b.y < BALL_R) {
      b.y = BALL_R;
      bounce(b, 0, 1, 0, Math.abs(b.vy) > 2 ? 0.55 : 0, 0.04); // bounce, then roll with rolling friction
    }
    for (const o of sim.obstacles) {
      const dx = b.x - o.x, dz = b.z - o.z, d = Math.hypot(dx, dz);
      if (d < o.r + BALL_R && b.y < 7) {
        b.x = o.x + (dx / d) * (o.r + BALL_R);
        b.z = o.z + (dz / d) * (o.r + BALL_R);
        bounce(b, dx / d, 0, dz / d, 0.5);
      }
    }
    // arm links are capsules
    for (const A of arms)
      for (let j = 1; j < 4; j++) {
        const c = closestOnSeg([b.x, b.y, b.z], A.pts[j], A.pts[j + 1]);
        const dx = b.x - c[0], dy = b.y - c[1], dz = b.z - c[2], d = Math.hypot(dx, dy, dz), r = 0.45 + BALL_R;
        if (d < r && d > 1e-6) {
          b.x = c[0] + (dx / d) * r;
          b.y = c[1] + (dy / d) * r;
          b.z = c[2] + (dz / d) * r;
          bounce(b, dx / d, dy / d, dz / d, 0.5);
        }
      }
    if (st) for (const blk of st.blocks) ballBlock(b, blk, st);
    // flies: only a ball still moving fast does harm; momentum carries into the fly
    if (Math.hypot(b.vx, b.vy, b.vz) > 8)
      for (const i of sim.hash.query(b.x, b.z, 0.7, sim.x, sim.z, sim.tmp)) {
        if (!free(sim, i) || Math.abs(sim.y[i] - b.y) > 0.6) continue;
        const v = Math.hypot(b.vx, b.vy, b.vz);
        if (sim.wound(i, clamp(v / 60, 0.2, 0.7), "shot", b.from)) b.from.kills++;
        b.from.hits++;
        sim.push(i, b.vx * 0.35, b.vy * 0.35 + 1, b.vz * 0.35);
        // the ball loses the momentum it gave away
        b.vx *= 0.7;
        b.vy *= 0.7;
        b.vz *= 0.7;
        break;
      }
  }
  while (sim.balls.length && sim.balls[0].age > 5) sim.balls.shift();
}

function ballBlock(b, blk, st) {
  const h = 0.5;
  const cx = clamp(b.x, blk.x - h, blk.x + h), cy = clamp(b.y, blk.y - h, blk.y + h), cz = clamp(b.z, blk.z - h, blk.z + h);
  const dx = b.x - cx, dy = b.y - cy, dz = b.z - cz, d = Math.hypot(dx, dy, dz);
  if (d >= BALL_R || d < 1e-6) return;
  const nx = dx / d, ny = dy / d, nz = dz / d;
  b.x = cx + nx * BALL_R;
  b.y = cy + ny * BALL_R;
  b.z = cz + nz * BALL_R;
  const vn = -(b.vx * nx + b.vy * ny + b.vz * nz);
  if (vn <= 0) return;
  // impulse exchange between the ball and a 1-unit wooden block (mass 1)
  const e = 0.45, J = ((1 + e) * vn) / (1 / BALL_MASS + 1);
  b.vx += (J / BALL_MASS) * nx;
  b.vy += (J / BALL_MASS) * ny;
  b.vz += (J / BALL_MASS) * nz;
  if (blk.held) return;
  blk.vx -= J * nx;
  blk.vy -= J * ny;
  blk.vz -= J * nz;
  blk.wx += (sim_rand() - 0.5) * J * 4;
  blk.wz += (sim_rand() - 0.5) * J * 4;
  blk.awake = true;
  if (J > 0.6 && st.stacked > 0) st.knocked++;
}
let seed = 1;
const sim_rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647); // visual spin only

// ------------------------------------------------------------------ stacker and rigid blocks
function scatterBlocks(R, rng, fling) {
  const [sx, sz] = R.stackAt;
  const away = Math.atan2(sz - R.z, sx - R.x) + Math.PI;
  R.blocks.forEach((b, k) => {
    const a = away + (k / STACK_GOAL - 0.5) * 2.6;
    const r = 7 + (k % 3) * 2.2;
    if (fling) {
      const tx = R.x + Math.cos(a) * r, tz = R.z + Math.sin(a) * r;
      Object.assign(b, { held: false, awake: true, vx: (tx - b.x) * 0.5, vy: 3 + rng() * 3, vz: (tz - b.z) * 0.5, wx: (rng() - 0.5) * 8, wz: (rng() - 0.5) * 8 });
    } else Object.assign(b, { x: R.x + Math.cos(a) * r, y: 0.5, z: R.z + Math.sin(a) * r, vx: 0, vy: 0, vz: 0, held: false, awake: false });
  });
}

// Blocks are unit boxes that stay upright for contact purposes (axis-aligned),
// with gravity, restitution, Coulomb friction and sequential impulse-free
// position correction (sort by height, push out along the shallowest axis).
// Tumbling is drawn from an angular velocity that friction kills on landing.
// Balance: a tower falls where the centre of mass of everything above a block
// is not over that block.
function stepBlocks(sim, R) {
  const B = R.blocks;
  for (const b of B) {
    if (b.held) continue;
    if (!b.awake && Math.abs(b.vy) < 1e-3) continue;
    b.vy -= G * DT;
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.z += b.vz * DT;
    b.rx += b.wx * DT;
    b.rz += b.wz * DT;
  }
  // contacts, a few passes (lower blocks first so stacks settle bottom-up)
  const order = B.map((_, k) => k).sort((a, c) => B[a].y - B[c].y);
  for (let pass = 0; pass < 4; pass++) {
    for (const k of order) {
      const b = B[k];
      if (b.held) continue;
      if (b.y < 0.5) {
        b.y = 0.5;
        land(b);
      }
      for (const o of sim.obstacles) {
        const dx = b.x - o.x, dz = b.z - o.z, d = Math.hypot(dx, dz);
        if (d < o.r + 0.5) (b.x = o.x + (dx / d) * (o.r + 0.5)), (b.z = o.z + (dz / d) * (o.r + 0.5)), (b.vx *= -0.3), (b.vz *= -0.3);
      }
      for (const k2 of order) {
        if (k2 === k) continue;
        const c = B[k2];
        const ox = 1 - Math.abs(b.x - c.x), oy = 1 - Math.abs(b.y - c.y), oz = 1 - Math.abs(b.z - c.z);
        if (ox <= 0 || oy <= 0 || oz <= 0) continue;
        const wb = b.held ? 0 : 1, wc = c.held ? 0 : 1;
        if (wb + wc === 0) continue;
        if (wb) b.awake = true;
        if (wc) c.awake = true;
        const sb = wb / (wb + wc), sc = wc / (wb + wc);
        if (oy <= ox && oy <= oz) {
          const s = Math.sign(b.y - c.y) || 1;
          b.y += s * oy * sb;
          c.y -= s * oy * sc;
          if (s > 0 && wb) land(b, c);
          else if (s < 0 && wc) land(c, b);
        } else if (ox <= oz) {
          const s = Math.sign(b.x - c.x) || 1;
          b.x += s * ox * sb;
          c.x -= s * ox * sc;
          const v = (b.vx * sb + c.vx * sc) * 0.5;
          if (wb) b.vx = v;
          if (wc) c.vx = v;
        } else {
          const s = Math.sign(b.z - c.z) || 1;
          b.z += s * oz * sb;
          c.z -= s * oz * sc;
          const v = (b.vz * sb + c.vz * sc) * 0.5;
          if (wb) b.vz = v;
          if (wc) c.vz = v;
        }
      }
    }
  }
  for (const b of B)
    if (!b.held && b.awake && Math.hypot(b.vx, b.vy, b.vz) < 0.05 && b.restOn !== undefined) {
      b.awake = false;
      b.vx = b.vy = b.vz = 0;
    }
  balance(sim, R);
  countStack(R);
}

// resting contact on the floor or on block `on`: kill the normal velocity, apply friction
function land(b, on = null) {
  if (b.vy < -2) b.vy = -b.vy * 0.2; // a little bounce for hard landings
  else b.vy = on ? on.vy : 0;
  const mu = 0.6 * G * DT; // Coulomb friction: velocity change capped by mu * g * dt
  const vx = b.vx - (on ? on.vx : 0), vz = b.vz - (on ? on.vz : 0), v = Math.hypot(vx, vz);
  const s = v > mu ? (v - mu) / v : 0;
  b.vx = (on ? on.vx : 0) + vx * s;
  b.vz = (on ? on.vz : 0) + vz * s;
  b.wx *= 0.5;
  b.wz *= 0.5;
  b.rx *= 0.7; // settles flat
  b.rz *= 0.7;
  b.restOn = on ? 1 : 0;
}

// which block rests on which (top face to bottom face, overlapping footprints)
function supports(B) {
  const below = B.map(() => -1);
  B.forEach((b, k) => {
    if (b.held) return;
    let best = -1, bd = 0.08;
    B.forEach((c, j) => {
      if (j === k || c.held) return;
      const gap = Math.abs(b.y - c.y - 1);
      if (gap < bd && Math.abs(b.x - c.x) < 1 && Math.abs(b.z - c.z) < 1) (bd = gap), (best = j);
    });
    below[k] = best;
  });
  return below;
}

function balance(sim, R) {
  const B = R.blocks, below = supports(B);
  // nothing underneath: start falling
  B.forEach((b, k) => {
    if (!b.held && below[k] < 0 && b.y > 0.55) b.awake = true;
  });
  // centre of mass of each block plus everything it carries, top-down
  const order = B.map((_, k) => k).sort((a, c) => B[c].y - B[a].y);
  const mass = B.map(() => 1), mx = B.map((b) => b.x), mz = B.map((b) => b.z);
  for (const k of order) {
    const j = below[k];
    if (j < 0) continue;
    const m = mass[j] + mass[k];
    mx[j] = (mx[j] * mass[j] + mx[k] * mass[k]) / m;
    mz[j] = (mz[j] * mass[j] + mz[k] * mass[k]) / m;
    mass[j] = m;
  }
  for (const k of order) {
    const j = below[k];
    if (j < 0) continue;
    const dx = mx[k] - B[j].x, dz = mz[k] - B[j].z;
    const moving = Math.hypot(B[k].vx, B[k].vz) > 0.3;
    if ((Math.abs(dx) > 0.5 || Math.abs(dz) > 0.5) && !moving) {
      // tips over the edge: everything from k up starts to fall that way
      const s = Math.hypot(dx, dz) || 1;
      for (const q of B.map((_, i) => i).filter((i) => isAbove(i, k, below))) {
        Object.assign(B[q], { awake: true, vx: B[q].vx + (dx / s) * 1.5, vz: B[q].vz + (dz / s) * 1.5, wx: (dz / s) * 3, wz: (-dx / s) * 3 });
      }
      R.collapses++;
    }
  }
}
function isAbove(i, k, below) {
  for (let q = i, n = 0; q >= 0 && n < 20; q = below[q], n++) if (q === k) return true;
  return false;
}

// the stack is the column resting on the floor at stackAt
function countStack(R) {
  const B = R.blocks, [sx, sz] = R.stackAt;
  let level = 0;
  for (;;) {
    const y = level + 0.5;
    const b = B.find((b) => !b.held && Math.abs(b.y - y) < 0.1 && Math.abs(b.x - sx) < 0.6 && Math.abs(b.z - sz) < 0.6);
    if (!b) break;
    level++;
  }
  R.stacked = level;
}
const inStack = (R, b) => Math.abs(b.x - R.stackAt[0]) < 0.6 && Math.abs(b.z - R.stackAt[1]) < 0.6 && b.y < R.stacked + 0.6;

function letGo(R) {
  const b = R.blocks[R.block];
  if (b) Object.assign(b, { held: false, awake: true });
  R.block = -1;
  R.grip = 1;
}

function stacker(sim, R) {
  const [sx, sz] = R.stackAt;
  const B = R.blocks;
  let goal = [sx, R.stacked + 4, sz], load = 0;
  if (R.block >= 0 && R.state !== "fetch" && R.state !== "grasp" && !B[R.block].held) (R.block = -1), (R.state = "scan");
  switch (R.state) {
    case "scan": {
      R.grip = 1;
      if (R.stacked >= STACK_GOAL) {
        // task done: record the time, then knock it down and start over
        R.completions++;
        const took = sim.t - R.startT;
        R.bestTime = R.bestTime == null ? took : Math.min(R.bestTime, took);
        R.state = "done";
        R.timer = 3;
        break;
      }
      if (R.stacked === 0) R.startT = sim.t;
      let best = -1, bd = Infinity;
      B.forEach((b, k) => {
        if (b.held || b.awake || inStack(R, b) || b.y > 0.6) return; // only blocks lying still on the floor
        const d = Math.hypot(b.x - R.x, b.z - R.z);
        if (d < bd && d < reach - 1 && d > 2.5) (bd = d), (best = k);
      });
      if (best >= 0) (R.block = best), (R.state = "fetch"), (R.timer = 6);
      break;
    }
    case "fetch": {
      const b = B[R.block];
      goal = [b.x, b.y + 2.5, b.z];
      if (b.awake || inStack(R, b)) R.state = "scan";
      else if (near(R.pts[4], goal, 0.5) && tipSpeed(R) < 1) (R.state = "grasp"), (R.timer = 2.5);
      else if (R.timer <= 0) R.state = "scan";
      break;
    }
    case "grasp": {
      const b = B[R.block];
      goal = [b.x, b.y + 0.5, b.z];
      if (b.awake) R.state = "scan";
      else if (near(R.pts[4], goal, 0.25) || R.timer <= 0) {
        if (near(R.pts[4], goal, 0.5)) {
          b.held = true;
          b.ox = b.x - R.pts[4][0]; // the grasp is not perfectly centred
          b.oz = b.z - R.pts[4][2];
          R.grip = 0.3;
          R.state = "lift";
          R.timer = 6;
        } else R.state = "scan"; // missed it
      }
      break;
    }
    case "lift":
    case "carry":
    case "place": {
      load = 0.25;
      const hover = R.stacked + 2.6;
      if (R.state === "lift") goal = [R.pts[4][0], hover, R.pts[4][2]];
      else if (R.state === "carry") goal = [sx, hover, sz];
      else goal = [sx, R.stacked + 1.04, sz];
      const t = R.pts[4];
      if (R.state === "lift" && t[1] > hover - 0.4) R.state = "carry";
      else if (R.state === "carry" && Math.hypot(t[0] - sx, t[2] - sz) < 0.15 && tipSpeed(R) < 0.8) R.state = "place";
      else if (R.state === "place" && t[1] < R.stacked + 1.12 && tipSpeed(R) < 0.6) {
        // set it down: the block sits wherever the gripper really is, so placement error accumulates
        letGo(R);
        R.state = "settle";
        R.timer = 0.6;
      }
      if (R.state !== "settle" && R.timer <= 0) letGo(R), (R.state = "scan"); // stuck: let go and retry
      break;
    }
    case "settle":
      goal = [R.pts[4][0], R.stacked + 3, R.pts[4][2]];
      if (R.timer <= 0) R.state = "scan";
      break;
    case "done":
      goal = [sx + 3, STACK_GOAL + 3, sz];
      if (R.timer <= 0) {
        scatterBlocks(R, sim.rng, true);
        R.state = "scan";
      }
      break;
  }
  driveArm(R, goal, 0, load);
  const t = R.pts[4];
  const held = R.block >= 0 && B[R.block].held ? B[R.block] : null;
  if (held) {
    const px = held.x, pz = held.z, py = held.y;
    Object.assign(held, { x: t[0] + held.ox * 0.3, y: Math.max(0.5, t[1] - 0.5), z: t[2] + held.oz * 0.3, rx: 0, rz: 0 });
    // velocity of the carried block, so a dropped block keeps its swing
    held.vx = (held.x - px) / DT;
    held.vy = (held.y - py) / DT;
    held.vz = (held.z - pz) / DT;
  }
  // under fire from the swarm: flies that hit the moving block get swatted and
  // the knock can tear it out of the gripper; fast flies hitting the tower shove it
  if (held && (R.state === "lift" || R.state === "carry"))
    for (const i of sim.hash.query(held.x, held.z, 1.1, sim.x, sim.z, sim.tmp)) {
      if (!free(sim, i) || Math.abs(sim.y[i] - held.y) > 1) continue;
      const rel = Math.hypot(held.vx - Math.cos(sim.h[i]) * sim.speed[i], held.vz - Math.sin(sim.h[i]) * sim.speed[i]);
      if (sim.wound(i, clamp(rel / 30, 0.1, 0.5), "swatted", R)) R.kills++;
      const a = Math.atan2(sim.z[i] - held.z, sim.x[i] - held.x);
      sim.push(i, Math.cos(a) * rel * 0.6, 3, Math.sin(a) * rel * 0.6);
      if (sim.rng() < 0.12 + rel * 0.01) {
        letGo(R);
        R.state = "scan";
        R.knocked++;
        break;
      }
    }
  if (R.stacked > 1)
    for (const i of sim.hash.query(sx, sz, 0.9, sim.x, sim.z, sim.tmp)) {
      if (!free(sim, i) || sim.y[i] > R.stacked) continue;
      const lvl = Math.floor(sim.y[i]);
      const blk = B.find((b) => !b.held && Math.abs(b.y - (lvl + 0.5)) < 0.2 && inStack(R, b));
      if (!blk) continue;
      // a fly weighs next to nothing: it nudges the block by its momentum
      const m = 0.02, vx = Math.cos(sim.h[i]) * sim.speed[i], vz = Math.sin(sim.h[i]) * sim.speed[i];
      blk.vx += vx * m;
      blk.vz += vz * m;
      blk.awake = true;
      sim.wound(i, 0.1, "swatted", R);
      sim.push(i, -vx * 0.8, 1, -vz * 0.8);
    }
}

// tools that flies' looming detectors can see: position and velocity
export function robotLooms(sim) {
  const out = [];
  const on = sim.params.robots || {};
  for (const R of sim.robots) {
    if (R.kind === "shooter") continue;
    const p = R.kind === "net" ? R.hoop : R.pts[4];
    const prev = R.prevTool || p;
    R.prevTool = p.slice();
    if (on[R.kind]) out.push([p[0], p[1], p[2], (p[0] - prev[0]) / DT, (p[1] - prev[1]) / DT, (p[2] - prev[2]) / DT]);
  }
  return out;
}
