// Robots that share the arena with the swarm. The arms follow ArmLab / 6dof-gym-web
// (https://shubin123.github.io/6dof-gym-web/): six revolute joints plus a tool,
// analytic IK targets and a per-tick joint-step cap, re-implemented here.
//   picker   gripper arm: picks single flies off the food and crushes them
//   net      arm with a hoop net: sweeps through the densest knot of flies
//   shooter  turret: lobs balls at flies closing in on the stacker
//   stacker  arm whose only job is to stack 16 blocks; flies bump it and stray
//            balls knock its tower down, so it works under fire

export const ARM = { L0: 2.5, L1: 9, L2: 8, L3: 2.2, step: 0.07 };
export const STACK_GOAL = 16;
export const ROBOT_KINDS = ["picker", "net", "shooter", "stacker"];
const DT = 1 / 30;
const G = 20; // gravity for balls and falling blocks
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------------ kinematics
// joint angles -> world points: base, shoulder, elbow, wrist, tool tip
export function fkArm(A) {
  const { L0, L1, L2, L3 } = ARM;
  const [q0, q1, q2, q3] = A.q;
  const c = Math.cos(q0), s = Math.sin(q0);
  const at = (r, y) => [A.x + c * r, y, A.z + s * r];
  const a1 = q1, a2 = q1 + q2, a3 = q1 + q2 + q3;
  const r1 = L1 * Math.cos(a1), y1 = L0 + L1 * Math.sin(a1);
  const r2 = r1 + L2 * Math.cos(a2), y2 = y1 + L2 * Math.sin(a2);
  const r3 = r2 + L3 * Math.cos(a3), y3 = y2 + L3 * Math.sin(a3);
  A.pts = [[A.x, 0, A.z], at(0, L0), at(r1, y1), at(r2, y2), at(r3, y3)];
}

// analytic IK for the tool tip at goal with the tool pointing straight down (elbow up)
function ikArm(A, goal, wristYaw = 0) {
  const { L0, L1, L2, L3 } = ARM;
  const gx = goal[0] - A.x, gz = goal[2] - A.z;
  const gy = Math.max(0.2, goal[1]); // never below the floor
  const q0 = Math.hypot(gx, gz) > 0.3 ? Math.atan2(gz, gx) : A.q[0];
  const r = Math.min(Math.hypot(gx, gz), L1 + L2 - 0.05);
  const h = gy + L3 - L0; // the wrist sits L3 above the tip
  const d = Math.min(L1 + L2 - 1e-3, Math.max(Math.abs(L1 - L2) + 1e-3, Math.hypot(r, h)));
  const a1 = Math.atan2(h, r) + Math.acos((d * d + L1 * L1 - L2 * L2) / (2 * L1 * d));
  const a2 = Math.atan2(h - L1 * Math.sin(a1), r - L1 * Math.cos(a1));
  return [q0, a1, a2 - a1, -Math.PI / 2 - a2, wristYaw, 0];
}

// move toward the IK solution, each joint clipped to the step cap (ArmLab rejects
// larger steps outright; here they are clipped so the arm keeps moving)
function driveArm(A, goal, wristYaw) {
  const want = ikArm(A, goal, wristYaw);
  for (let k = 0; k < 6; k++) A.q[k] += Math.max(-ARM.step, Math.min(ARM.step, wrap(want[k] - A.q[k])));
  fkArm(A);
}

const near = (p, q, tol) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;

// ------------------------------------------------------------------ setup
export function makeRobots(sim, rng) {
  // bases sit in open floor, clear of pillars and of each other
  const spots = [[0, 0]];
  for (let tries = 0; spots.length < 4 && tries < 2000; tries++) {
    const a = rng() * Math.PI * 2, r = 22 + rng() * 22;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (sim.obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 6)) continue;
    if (spots.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 26)) continue;
    spots.push([x, z]);
  }
  while (spots.length < 4) spots.push([(spots.length - 2) * 30, -40]);
  return ROBOT_KINDS.map((kind, k) => {
    const [x, z] = spots[k];
    const R = { kind, x, z, state: "scan", timer: 1 + k * 0.3, kills: 0, held: [] };
    if (kind === "shooter") {
      Object.assign(R, { yaw: 0, pitch: 0.3, reload: 0, shots: 0, hits: 0, target: -1 });
      shooterPoints(R);
      return R;
    }
    Object.assign(R, { q: [rng() * 6, 1.2, -2.2, -0.6, 0, 0], grip: 1, fly: -1, hitSet: null, path: null, dropAt: [x + 9, 4, z] });
    if (kind === "stacker") {
      const a0 = rng() * Math.PI * 2;
      R.stackAt = [x + Math.cos(a0) * 8, z + Math.sin(a0) * 8];
      R.blocks = [];
      for (let b = 0; b < STACK_GOAL; b++) R.blocks.push({ x: 0, y: 0.5, z: 0, vx: 0, vy: 0, vz: 0, state: "floor", level: -1 });
      scatterBlocks(R, rng, false);
      Object.assign(R, { stacked: 0, completions: 0, knocked: 0, startT: 0, bestTime: null, block: -1 });
    }
    fkArm(R);
    return R;
  });
}

function scatterBlocks(R, rng, fling) {
  const [sx, sz] = R.stackAt;
  const away = Math.atan2(sz - R.z, sx - R.x) + Math.PI;
  R.blocks.forEach((b, k) => {
    const a = away + ((k / STACK_GOAL) - 0.5) * 2.6;
    const r = 7 + (k % 3) * 2.2;
    if (fling) {
      // tumble off the tower toward a free spot
      Object.assign(b, { state: "falling", level: -1, vx: (R.x + Math.cos(a) * r - b.x) * 0.8, vy: 4 + rng() * 3, vz: (R.z + Math.sin(a) * r - b.z) * 0.8 });
    } else Object.assign(b, { x: R.x + Math.cos(a) * r, y: 0.5, z: R.z + Math.sin(a) * r, state: "floor", level: -1 });
  });
  R.stacked = 0;
}

function shooterPoints(R) {
  const top = [R.x, 3, R.z];
  const cp = Math.cos(R.pitch);
  R.pts = [[R.x, 0, R.z], top, [R.x + Math.cos(R.yaw) * cp * 3, 3 + Math.sin(R.pitch) * 3, R.z + Math.sin(R.yaw) * cp * 3]];
}

// ------------------------------------------------------------------ update
export function updateRobots(sim) {
  const on = sim.params.robots || {};
  for (const R of sim.robots) {
    if (!on[R.kind]) {
      park(sim, R);
      continue;
    }
    if (R.state === "park") (R.state = "scan"), (R.timer = 0.5);
    R.timer -= DT;
    if (R.kind === "picker") picker(sim, R);
    else if (R.kind === "net") net(sim, R);
    else if (R.kind === "shooter") shooter(sim, R);
    else stacker(sim, R);
    carry(R);
  }
  updateBalls(sim);
}

function park(sim, R) {
  R.state = "park";
  release(R);
  if (R.kind === "shooter") {
    R.pitch += (-0.2 - R.pitch) * 0.05;
    shooterPoints(R);
  } else driveArm(R, [R.x + 4, 10, R.z]);
  if (R.kind === "stacker") settleBlocks(sim, R);
}

// dead flies collected by a tool ride along with it until it lets go
function carry(R) {
  if (!R.held.length || !R.pts) return;
  const t = R.pts[R.pts.length - 1];
  for (const c of R.held) Object.assign(c, { x: t[0] + c.ox, y: Math.max(0, t[1] - 0.4 + c.oy), z: t[2] + c.oz, vy: 0 });
}

function release(R) {
  for (const c of R.held) (c.held = false), (c.vy = 0);
  R.held.length = 0;
}

const alive = (sim, i) => i >= 0 && i < sim.n && sim.hp[i] > 0 && sim.energy[i] > 0;
const reach = ARM.L1 + ARM.L2 - 0.5;

function picker(sim, R) {
  let goal = [R.x + 6, 9, R.z], close = false;
  switch (R.state) {
    case "scan": {
      R.grip = 1;
      if (R.timer > 0) break;
      let best = -1, bs = Infinity;
      for (let i = 0; i < sim.n; i++) {
        const r = Math.hypot(sim.x[i] - R.x, sim.z[i] - R.z);
        if (r > reach || r < 3 || sim.hp[i] <= 0) continue;
        // easiest prey first: sitting on food, already hurt
        const score = r * (sim.y[i] < 0.6 ? 0.5 : 1.5) * (0.5 + 0.5 * sim.hp[i]);
        if (score < bs) (bs = score), (best = i);
      }
      if (best >= 0) (R.fly = best), (R.state = "reach"), (R.timer = 4);
      else R.timer = 0.5;
      break;
    }
    case "reach":
      if (!alive(sim, R.fly) || R.timer <= 0) (R.state = "scan"), (R.timer = 0.3);
      else {
        goal = [sim.x[R.fly], sim.y[R.fly] + 2.5, sim.z[R.fly]];
        const t = R.pts[4];
        if (Math.hypot(t[0] - goal[0], t[2] - goal[2]) < 0.8 && Math.abs(t[1] - goal[1]) < 1) (R.state = "strike"), (R.timer = 0.8);
      }
      break;
    case "strike":
      if (!alive(sim, R.fly)) (R.state = "lift"), (R.timer = 1);
      else {
        goal = [sim.x[R.fly], sim.y[R.fly], sim.z[R.fly]];
        if (near(R.pts[4], goal, 0.6) || R.timer <= 0) close = true;
      }
      break;
    case "lift":
      goal = [R.pts[4][0], 10, R.pts[4][2]];
      R.grip = Math.max(0, R.grip - 4 * DT);
      if (R.timer <= 0) (R.state = "drop"), (R.timer = 2.5);
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
      if (sim.hp[i] <= 0) continue;
      const d = Math.hypot(sim.x[i] - t[0], sim.y[i] - t[1], sim.z[i] - t[2]);
      if (d > 1.3) continue;
      if (sim.wound(i, d < 0.8 ? 0.85 : 0.35, "picked", R)) R.kills++;
      else (sim.vy[i] = 6), (sim.escape[i] = 1); // squirms free, wounded
    }
    Object.assign(R, { fly: -1, state: "lift", timer: 1.2, grip: 0 });
    const a = R.q[0] + Math.PI * (0.6 + 0.8 * sim.rng());
    R.dropAt = [R.x + Math.cos(a) * 9, 4, R.z + Math.sin(a) * 9];
  }
  driveArm(R, goal, R.state === "reach" ? 0.6 * Math.sin(R.timer * 3) : 0);
}

function net(sim, R) {
  let goal = [R.x - 5, 9, R.z];
  switch (R.state) {
    case "scan": {
      if (R.timer > 0) break;
      // the densest knot of flies within reach (sampled)
      let best = -1, bs = 2;
      for (let s = 0; s < 40; s++) {
        const i = Math.floor(sim.rng() * sim.n);
        const r = Math.hypot(sim.x[i] - R.x, sim.z[i] - R.z);
        if (r > reach - 2 || r < 5) continue;
        const k = sim.hash.query(sim.x[i], sim.z[i], 3, sim.x, sim.z, sim.tmp).length;
        if (k > bs) (bs = k), (best = i);
      }
      if (best < 0) {
        R.timer = 0.6;
        break;
      }
      // sweep tangentially through the knot, at the flies' height
      const cx = sim.x[best], cz = sim.z[best], cy = Math.max(0.8, sim.y[best]);
      const a = Math.atan2(cz - R.z, cx - R.x) + Math.PI / 2;
      R.path = [[cx - Math.cos(a) * 6, cy + 1, cz - Math.sin(a) * 6], [cx + Math.cos(a) * 6, cy, cz + Math.sin(a) * 6]];
      R.state = "windup";
      R.timer = 3;
      break;
    }
    case "windup":
      goal = R.path[0];
      if (near(R.pts[4], goal, 1) || R.timer <= 0) (R.state = "sweep"), (R.timer = 2.2), (R.hitSet = new Set());
      break;
    case "sweep": {
      goal = R.path[1];
      const t = R.pts[4];
      for (const i of sim.hash.query(t[0], t[2], 1.8, sim.x, sim.z, sim.tmp)) {
        if (R.hitSet.has(i) || R.hitSet.size >= 12 || sim.hp[i] <= 0 || Math.abs(sim.y[i] - t[1]) > 1.8) continue;
        R.hitSet.add(i);
        if (sim.wound(i, 0.65, "netted", R)) R.kills++;
        else (sim.vy[i] = 5), (sim.escape[i] = 1); // tangled, then thrashes out
      }
      if (near(t, goal, 1) || R.timer <= 0) {
        R.state = "dump";
        R.timer = 3;
        const a = Math.atan2(t[2] - R.z, t[0] - R.x) + Math.PI;
        R.dropAt = [R.x + Math.cos(a) * 8, 5, R.z + Math.sin(a) * 8];
      }
      break;
    }
    case "dump":
      goal = R.dropAt;
      if (R.timer <= 0.8) release(R);
      if (R.timer <= 0) (R.state = "scan"), (R.timer = 1.5);
      break;
  }
  driveArm(R, goal);
}

const BALL_SPEED = 34;
function shooter(sim, R) {
  R.reload -= DT;
  if (R.timer <= 0 || !alive(sim, R.target)) {
    // cover the stacker: shoot the flies closest to it first, else the nearest fly in range
    const st = sim.robots.find((q) => q.kind === "stacker");
    const guard = st && sim.params.robots?.stacker ? st.stackAt : null;
    let best = -1, bs = Infinity;
    for (let i = 0; i < sim.n; i++) {
      if (sim.hp[i] <= 0) continue;
      const d = Math.hypot(sim.x[i] - R.x, sim.z[i] - R.z);
      if (d > 45 || d < 3) continue;
      const score = d + (guard ? 1.5 * Math.hypot(sim.x[i] - guard[0], sim.z[i] - guard[1]) : 0);
      if (score < bs) (bs = score), (best = i);
    }
    R.target = best;
    R.timer = 1.5;
  }
  if (R.target < 0) return shooterPoints(R);
  // lead the target, then lift the barrel to cancel the ball's drop
  const i = R.target, m = R.pts[1];
  let tx = sim.x[i], ty = sim.y[i], tz = sim.z[i], t = 0;
  for (let k = 0; k < 2; k++) {
    t = Math.hypot(tx - m[0], tz - m[2]) / BALL_SPEED;
    tx = sim.x[i] + Math.cos(sim.h[i]) * sim.speed[i] * t;
    tz = sim.z[i] + Math.sin(sim.h[i]) * sim.speed[i] * t;
  }
  const horiz = Math.hypot(tx - m[0], tz - m[2]);
  const vy = (ty - m[1]) / Math.max(t, 1e-3) + 0.5 * G * t;
  const wantYaw = Math.atan2(tz - m[2], tx - m[0]), wantPitch = Math.atan2(vy, horiz / Math.max(t, 1e-3));
  const dy = wrap(wantYaw - R.yaw), dp = wantPitch - R.pitch;
  R.yaw += Math.max(-0.12, Math.min(0.12, dy));
  R.pitch += Math.max(-0.08, Math.min(0.08, dp));
  shooterPoints(R);
  if (R.reload <= 0 && Math.abs(dy) < 0.05 && Math.abs(dp) < 0.05) {
    const sp = Math.hypot(horiz / Math.max(t, 1e-3), vy);
    const mz = R.pts[2];
    sim.balls.push({ x: mz[0], y: mz[1], z: mz[2], vx: Math.cos(R.yaw) * Math.cos(R.pitch) * sp, vy: Math.sin(R.pitch) * sp, vz: Math.sin(R.yaw) * Math.cos(R.pitch) * sp, age: 0, live: true, from: R });
    if (sim.balls.length > 80) sim.balls.shift();
    R.reload = 0.55;
    R.shots++;
  }
}

function updateBalls(sim) {
  const st = sim.robots.find((q) => q.kind === "stacker");
  for (const b of sim.balls) {
    b.age += DT;
    b.vy -= G * DT;
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.z += b.vz * DT;
    if (b.y < 0.25) {
      // bounce and roll; a ball that has touched the ground is spent
      b.y = 0.25;
      b.vy = -b.vy * 0.45;
      b.vx *= 0.7;
      b.vz *= 0.7;
      b.live = false;
    }
    for (const o of sim.obstacles) {
      const d = Math.hypot(b.x - o.x, b.z - o.z);
      if (d < o.r + 0.25 && b.y < 7) {
        const nx = (b.x - o.x) / d, nz = (b.z - o.z) / d, dot = b.vx * nx + b.vz * nz;
        b.vx -= 1.6 * dot * nx;
        b.vz -= 1.6 * dot * nz;
        b.x = o.x + nx * (o.r + 0.3);
        b.z = o.z + nz * (o.r + 0.3);
        b.live = false;
      }
    }
    if (b.live) {
      for (const i of sim.hash.query(b.x, b.z, 0.8, sim.x, sim.z, sim.tmp)) {
        if (sim.hp[i] <= 0 || Math.abs(sim.y[i] - b.y) > 0.8) continue;
        if (sim.wound(i, 0.5, "shot", b.from)) b.from.kills++;
        b.from.hits++;
        sim.vy[i] += b.vy * 0.2;
        sim.x[i] += b.vx * 0.02;
        sim.z[i] += b.vz * 0.02;
        b.live = false;
        b.vx *= -0.3;
        b.vz *= -0.3;
        break;
      }
    }
    // friendly fire: a ball that strikes the stacker's tower knocks the blocks above it off
    if (st && st.stacked && Math.hypot(b.x - st.stackAt[0], b.z - st.stackAt[1]) < 0.9 && b.y < st.stacked) {
      topple(sim, st, Math.max(0, Math.floor(b.y)));
      b.vx *= -0.4;
      b.vz *= -0.4;
      b.live = false;
    }
  }
  while (sim.balls.length && sim.balls[0].age > 3) sim.balls.shift();
}

// blocks from level up fall off the tower and go back to the floor
function topple(sim, R, level) {
  for (const b of R.blocks) {
    if (b.state !== "stack" || b.level < level) continue;
    const a = sim.rng() * Math.PI * 2;
    Object.assign(b, { state: "falling", level: -1, vx: Math.cos(a) * 3, vy: 2, vz: Math.sin(a) * 3 });
    R.knocked++;
  }
  R.stacked = Math.min(R.stacked, level);
}

function settleBlocks(sim, R) {
  for (const b of R.blocks) {
    if (b.state !== "falling") continue;
    b.vy -= G * DT;
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.z += b.vz * DT;
    if (b.y <= 0.5) Object.assign(b, { y: 0.5, vx: 0, vy: 0, vz: 0, state: "floor" });
  }
}

function stacker(sim, R) {
  settleBlocks(sim, R);
  const [sx, sz] = R.stackAt;
  const B = R.blocks;
  let goal = [sx, R.stacked + 4, sz];
  const blk = R.block >= 0 ? B[R.block] : null;
  if (blk && blk.state !== "held" && R.state !== "fetch" && R.state !== "grasp") (R.block = -1), (R.state = "scan");
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
      let best = -1, bd = Infinity;
      B.forEach((b, k) => {
        if (b.state !== "floor") return;
        const d = Math.hypot(b.x - R.x, b.z - R.z);
        if (d < bd) (bd = d), (best = k);
      });
      if (best >= 0) (R.block = best), (R.state = "fetch"), (R.timer = 5);
      break;
    }
    case "fetch": {
      const b = B[R.block];
      goal = [b.x, b.y + 2.5, b.z];
      if (b.state !== "floor") R.state = "scan";
      else if (near(R.pts[4], goal, 0.6)) (R.state = "grasp"), (R.timer = 2);
      break;
    }
    case "grasp": {
      const b = B[R.block];
      goal = [b.x, b.y + 0.5, b.z];
      if (b.state !== "floor") R.state = "scan";
      else if (near(R.pts[4], goal, 0.4) || R.timer <= 0) {
        b.state = "held";
        R.grip = 0.3;
        R.state = "lift";
        R.timer = 4;
      }
      break;
    }
    case "lift":
    case "carry":
    case "place": {
      const top = R.stacked + 0.5; // centre height of the next block
      if (R.state === "lift") goal = [R.pts[4][0], R.stacked + 3.5, R.pts[4][2]];
      else if (R.state === "carry") goal = [sx, R.stacked + 3.5, sz];
      else goal = [sx, top + 0.5, sz];
      if (R.state === "lift" && R.pts[4][1] > R.stacked + 3) R.state = "carry";
      else if (R.state === "carry" && Math.hypot(R.pts[4][0] - sx, R.pts[4][2] - sz) < 0.3) R.state = "place";
      else if (R.state === "place" && near(R.pts[4], goal, 0.3)) {
        const b = B[R.block];
        Object.assign(b, { state: "stack", level: R.stacked, x: sx, y: top, z: sz });
        if (R.stacked === 0) R.startT = sim.t;
        R.stacked++;
        R.block = -1;
        R.grip = 1;
        R.state = "scan";
      }
      if (R.state !== "scan" && R.timer <= 0) dropBlock(sim, R); // stuck: let go and retry
      break;
    }
    case "done":
      goal = [sx + 3, STACK_GOAL + 3, sz];
      if (R.timer <= 0) {
        scatterBlocks(R, sim.rng, true);
        R.state = "scan";
      }
      break;
  }
  driveArm(R, goal);
  const t = R.pts[4];
  const held = R.block >= 0 && B[R.block].state === "held" ? B[R.block] : null;
  if (held) Object.assign(held, { x: t[0], y: Math.max(0.5, t[1] - 0.5), z: t[2] });
  // under fire from the swarm: flies that hit the moving block get swatted and may
  // knock it out of the gripper; flies blundering into the tower can shake the top off
  if (held && (R.state === "lift" || R.state === "carry"))
    for (const i of sim.hash.query(held.x, held.z, 1.1, sim.x, sim.z, sim.tmp)) {
      if (sim.hp[i] <= 0 || Math.abs(sim.y[i] - held.y) > 1) continue;
      if (sim.wound(i, 0.3, "swatted", R)) R.kills++;
      sim.vy[i] = 4;
      if (sim.rng() < 0.3) {
        dropBlock(sim, R);
        R.knocked++;
        break;
      }
    }
  if (R.stacked > 2)
    for (const i of sim.hash.query(sx, sz, 0.8, sim.x, sim.z, sim.tmp))
      if (sim.hp[i] > 0 && sim.y[i] < R.stacked && sim.speed[i] > 8 && sim.rng() < 0.08) {
        sim.wound(i, 0.15, "swatted", R);
        topple(sim, R, R.stacked - 1);
      }
}

function dropBlock(sim, R) {
  if (R.block >= 0) Object.assign(R.blocks[R.block], { state: "falling", vx: (sim.rng() - 0.5) * 3, vy: 0, vz: (sim.rng() - 0.5) * 3 });
  R.block = -1;
  R.grip = 1;
  R.state = "scan";
}

// points robots expose to flies' looming detectors (tool tips and live balls)
export function robotLooms(sim) {
  const out = [];
  const on = sim.params.robots || {};
  for (const R of sim.robots) if (on[R.kind] && R.kind !== "shooter") out.push(R.pts[4]);
  return out;
}
