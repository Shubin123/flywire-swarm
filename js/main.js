// Entry point: loads the FlyWire data, starts the swarm and draws it with three.js.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { loadData, Connectome } from "./connectome.js";
import { Sim, ARENA, CORPSE_LIFE } from "./sim.js";
import { analyseConnectome } from "./analysis.js";
import { BrainView } from "./brainview.js";
import { Brain2D } from "./brain2d.js";
import { CanvasRenderer } from "./canvasview.js";
import { Panels, MODE_COLORS, swarmColor } from "./panels.js";
import { IdeasMap } from "./ideas.js";
import { GAMES } from "./game.js";
import { restore } from "./snapshot.js";
import { ModelStore } from "./store.js";

const $ = (s) => document.querySelector(s);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const setLoad = (msg, frac) => {
  $("#loader-msg").textContent = msg;
  $("#loader-fill").style.width = `${Math.round(frac * 100)}%`;
};

// ------------------------------------------------------------------ data
setLoad("Loading the FlyWire v783 connectome…", 0.1);
const BUILD = document.querySelector('meta[name="build"]')?.content || "";
let data, refs;
try {
  [data, refs] = await Promise.all([
    loadData("./", BUILD),
    fetch(`./data/refs.json${BUILD ? "?v=" + BUILD : ""}`).then((r) => r.json()),
  ]);
} catch (err) {
  setLoad(`Could not load the data (${err.message}). Serve this folder over http(s), not file://, and try a hard refresh.`, 1);
  throw err;
}
setLoad("Analysing the graph (PageRank, betweenness, Louvain)…", 0.5);
await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); // let the message paint
const cx = new Connectome(data.conn);
const analysis = analyseConnectome(cx);
setLoad("Hatching flies…", 0.8);

const settings = { color: "strategy", social: true, path: true, pathsAll: false, speed: 1, paused: false };
let sim = new Sim(cx, { flies: 220 });
const WORKER_URL = new URL(`./brain-worker.js${BUILD ? "?v=" + BUILD : ""}`, import.meta.url);
sim.brains.enableWorker(WORKER_URL);
let selected = -1;
let follow = false;

// ------------------------------------------------------------------ renderer & scene
const stage = $("#stage");

// Renderer fallback chain: WebGL → WebGPU → 2D canvas. Recent browsers refuse to
// create a WebGL context when hardware acceleration is off or the GPU is
// blocklisted; WebGPU may still work, and the canvas view works everywhere.
// ?renderer=webgl|webgpu|2d forces a starting point (handy for testing).
const RENDER_PREF = new URLSearchParams(location.search).get("renderer");
async function pickRenderer() {
  if (!RENDER_PREF || RENDER_PREF === "webgl") {
    try {
      return [new THREE.WebGLRenderer({ antialias: true }), "webgl"];
    } catch (err) {
      console.warn("WebGL unavailable:", err.message);
    }
  }
  if (RENDER_PREF !== "2d" && navigator.gpu) {
    try {
      const { WebGPURenderer } = await import("three/webgpu");
      const r = new WebGPURenderer({ antialias: true });
      await r.init();
      if (r.backend?.isWebGPUBackend) return [r, "webgpu"];
      r.dispose();
    } catch (err) {
      console.warn("WebGPU unavailable:", err.message);
    }
  }
  return [new CanvasRenderer(() => ({ sim, settings, selected, flyColor })), "2d"];
}
const [renderer, RENDER_KIND] = await pickRenderer();
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
if (RENDER_KIND !== "2d") {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}
stage.appendChild(renderer.domElement);

// Without hardware acceleration WebGL may fall back to a CPU rasteriser that is ~10x slower.
let SOFTWARE_GL = false;
if (RENDER_KIND === "webgl") {
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  SOFTWARE_GL = /swiftshader|llvmpipe|software|basic render/i.test(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "");
  if (SOFTWARE_GL) renderer.setPixelRatio(1);
}

const scene = new THREE.Scene();
const SKY = new THREE.Color(0x0b0f14);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 110, 260);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
camera.position.set(0, 78, 92);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 8;
controls.maxDistance = 240;

scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x1a1208, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(40, 80, 30);
scene.add(sun);

// floor + grid
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(ARENA + 24, ARENA + 24),
  new THREE.MeshStandardMaterial({ color: 0x141b22, roughness: 0.95 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(ARENA, 24, 0x2a3a4a, 0x1c2731);
grid.position.y = 0.01;
scene.add(grid);
const border = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(ARENA, 0.01, ARENA)),
  new THREE.LineBasicMaterial({ color: 0x3d5266 })
);
scene.add(border);

// obstacles and patches are rebuilt on restart
const worldGroup = new THREE.Group();
scene.add(worldGroup);
let patchMeshes = [];

function buildWorld() {
  worldGroup.clear();
  const stone = new THREE.MeshStandardMaterial({ color: 0x3a4652, roughness: 0.8 });
  for (const o of sim.obstacles) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r * 1.08, 7, 32), stone);
    m.position.set(o.x, 3.5, o.z);
    worldGroup.add(m);
  }
  patchMeshes = sim.patches.map(() => makePatch());
  for (const p of patchMeshes) worldGroup.add(p.group);
}

function makePatch() {
  const group = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ color: 0xf2a541, transparent: true, opacity: 0.6, depthWrite: false })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.03;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.96, 1.04, 64),
    new THREE.MeshBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  const glow = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 5, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xf2a541, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  glow.position.y = 2.5;
  group.add(disc, ring, glow);
  return { group, disc, ring, glow };
}

// ------------------------------------------------------------------ flies
const CAP = sim.cap;
function flyBodyGeometry() {
  const thorax = new THREE.SphereGeometry(0.22, 12, 8);
  thorax.scale(1.2, 0.95, 0.95);
  const abdomen = new THREE.SphereGeometry(0.24, 12, 8);
  abdomen.scale(1.55, 0.9, 1);
  abdomen.translate(-0.42, -0.02, 0);
  const head = new THREE.SphereGeometry(0.16, 10, 8);
  head.translate(0.32, 0.02, 0);
  return mergeGeometries([thorax, abdomen, head]);
}
function wingGeometry(side) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(0.15, 0.25, -0.2, 0.75, -0.55, 0.7);
  shape.bezierCurveTo(-0.7, 0.5, -0.35, 0.1, 0, 0);
  const g = new THREE.ShapeGeometry(shape, 8);
  g.rotateX(-Math.PI / 2); // lay flat, extending toward -z
  if (side > 0) g.scale(1, 1, -1); // right wing extends toward +z
  g.translate(0.05, 0.12, 0);
  return g;
}
const bodyMesh = new THREE.InstancedMesh(
  flyBodyGeometry(),
  new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }),
  CAP
);
const eyeMesh = new THREE.InstancedMesh(
  (() => {
    const l = new THREE.SphereGeometry(0.09, 8, 6);
    l.translate(0.36, 0.07, 0.1);
    const r = new THREE.SphereGeometry(0.09, 8, 6);
    r.translate(0.36, 0.07, -0.1);
    return mergeGeometries([l, r]);
  })(),
  new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.3 }),
  CAP
);
const wingMat = new THREE.MeshBasicMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
const wingL = new THREE.InstancedMesh(wingGeometry(-1), wingMat, CAP);
const wingR = new THREE.InstancedMesh(wingGeometry(1), wingMat, CAP);
const shadowMesh = new THREE.InstancedMesh(
  new THREE.CircleGeometry(0.45, 16).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
  CAP
);
for (const m of [bodyMesh, eyeMesh, wingL, wingR, shadowMesh]) {
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  scene.add(m);
}
const FLY_SCALE = 1.5;

// leader markers (highest-degree fly of each social component)
const leaderMesh = new THREE.InstancedMesh(
  new THREE.OctahedronGeometry(0.28),
  new THREE.MeshBasicMaterial({ color: 0xffe08a }),
  64
);
leaderMesh.frustumCulled = false;
scene.add(leaderMesh);

// social graph edges
const MAX_EDGES = 8000;
const edgeGeo = new THREE.BufferGeometry();
const edgePos = new Float32Array(MAX_EDGES * 6);
edgeGeo.setAttribute("position", new THREE.BufferAttribute(edgePos, 3).setUsage(THREE.DynamicDrawUsage));
const edgeLines = new THREE.LineSegments(
  edgeGeo,
  new THREE.LineBasicMaterial({ color: 0x7fb7ff, transparent: true, opacity: 0.22, depthWrite: false })
);
edgeLines.frustumCulled = false;
scene.add(edgeLines);

// A* routes
const pathGeo = new THREE.BufferGeometry();
pathGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
const pathLine = new THREE.Line(pathGeo, new THREE.LineDashedMaterial({ color: 0xffe08a, dashSize: 1, gapSize: 0.6 }));
pathLine.frustumCulled = false;
scene.add(pathLine);
const allPathGeo = new THREE.BufferGeometry();
const allPathPos = new Float32Array(CAP * 12 * 6);
allPathGeo.setAttribute("position", new THREE.BufferAttribute(allPathPos, 3).setUsage(THREE.DynamicDrawUsage));
const allPaths = new THREE.LineSegments(allPathGeo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.12 }));
allPaths.frustumCulled = false;
scene.add(allPaths);

const selRing = new THREE.Mesh(
  new THREE.RingGeometry(0.9, 1.1, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
);
selRing.visible = false;
scene.add(selRing);

// predator: a dark swallow-like silhouette
const predator = new THREE.Group();
{
  const mat = new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.7, 3.2, 10), mat);
  body.rotation.z = -Math.PI / 2;
  predator.add(body);
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0.6, 0);
  wingShape.lineTo(-1.2, 4);
  wingShape.lineTo(-0.6, 0);
  const wg = new THREE.ShapeGeometry(wingShape).rotateX(-Math.PI / 2);
  const wl = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ color: 0x252b35, side: THREE.DoubleSide }));
  const wr = wl.clone();
  wr.scale.z = -1;
  predator.add(wl, wr);
  predator.userData.wings = [wl, wr];
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.16), new THREE.MeshBasicMaterial({ color: 0xff4040 }));
  eye.position.set(1.1, 0.25, 0);
  predator.add(eye);
  predator.scale.setScalar(1.6);
}
scene.add(predator);

// dead flies: bodies on their backs, tinted by what killed them
const CAUSE_COLORS = { eaten: 0xa01818, bitten: 0xa01818, picked: 0x9a4a12, netted: 0x4f7a44, shot: 0xb0601a, swatted: 0x5a64a8, fights: 0x9a3a22, starved: 0x6a6a6a, old: 0x7a7a7a };
const VIOLENT = new Set(["eaten", "bitten", "picked", "netted", "shot", "swatted", "fights"]);
// a dark splat on the floor under flies that were killed, so deaths stay visible
const splatMesh = new THREE.InstancedMesh(
  new THREE.CircleGeometry(0.7, 12).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x5a0606, transparent: true, opacity: 0.75, depthWrite: false }),
  160
);
splatMesh.frustumCulled = false;
splatMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(splatMesh);
const corpseMesh = new THREE.InstancedMesh(flyBodyGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.9 }), 160);
corpseMesh.frustumCulled = false;
corpseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(corpseMesh);

// dragonflies: long abdomen, two pairs of glassy wings
const chaserMeshes = [];
function makeChaser() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1fa3a3, metalness: 0.5, roughness: 0.35 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 3.2, 8).rotateZ(Math.PI / 2).translate(-0.9, 0, 0), mat);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), new THREE.MeshStandardMaterial({ color: 0x0d5e5e, metalness: 0.3 }));
  head.position.x = 0.75;
  g.add(body, head);
  const wmat = new THREE.MeshBasicMaterial({ color: 0xbff4ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
  g.userData.wings = [];
  for (const [x, side] of [[0.3, 1], [0.3, -1], [-0.2, 1], [-0.2, -1]]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 2.4).rotateX(-Math.PI / 2).translate(0, 0, side * 1.25), wmat);
    w.position.x = x;
    w.userData.side = side;
    g.add(w);
    g.userData.wings.push(w);
  }
  scene.add(g);
  return g;
}

// robots: links are unit cylinders stretched between the points the sim's forward kinematics gives
const UP = new THREE.Vector3(0, 1, 0), vA = new THREE.Vector3(), vB = new THREE.Vector3();
function link(r, color) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 12).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.45 }));
  scene.add(m);
  return m;
}
function span(m, a, b) {
  vA.set(...a);
  vB.set(...b).sub(vA);
  const len = vB.length() || 1e-3;
  m.position.copy(vA);
  m.quaternion.setFromUnitVectors(UP, vB.divideScalar(len));
  m.scale.set(1, len, 1);
}
const ROBOT_COLORS = { picker: 0xd98e04, net: 0x3fa36b, shooter: 0xb84a3a, stacker: 0x4a7bd1 };
const robotViews = [];
function makeRobotView(R) {
  const col = ROBOT_COLORS[R.kind];
  const v = { kind: R.kind, parts: [] };
  const add = (m) => (v.parts.push(m), m);
  v.base = add(new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2, 0.6, 20), new THREE.MeshStandardMaterial({ color: 0x2a323c })));
  scene.add(v.base);
  if (R.kind === "shooter") {
    v.post = add(link(0.6, 0x39424d));
    v.barrel = add(link(0.32, col));
    v.turret = add(new THREE.Mesh(new THREE.SphereGeometry(0.9, 14, 10), new THREE.MeshStandardMaterial({ color: col, metalness: 0.4 })));
    scene.add(v.turret);
    return v;
  }
  v.links = [add(link(0.5, 0x39424d)), add(link(0.42, col)), add(link(0.34, col)), add(link(0.18, 0x39424d))];
  v.joints = [1, 2, 3].map(() => {
    const j = add(new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), new THREE.MeshStandardMaterial({ color: 0x20262e })));
    scene.add(j);
    return j;
  });
  if (R.kind === "net") {
    v.hoop = add(new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.08, 8, 32).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc8d0d8, metalness: 0.6 })));
    v.bag = add(new THREE.Mesh(new THREE.ConeGeometry(1.6, 2.2, 20, 1, true).rotateX(Math.PI).translate(0, -1.1, 0), new THREE.MeshBasicMaterial({ color: 0x9fd8b0, wireframe: true, transparent: true, opacity: 0.45 })));
    scene.add(v.hoop, v.bag);
  } else {
    const fm = new THREE.MeshStandardMaterial({ color: 0xc8d0d8, metalness: 0.6 });
    v.fingers = [0, 1].map(() => add(new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.9, 0.5).translate(0, -0.45, 0), fm)));
    scene.add(...v.fingers);
  }
  return v;
}
const ballMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.25, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0x552200 }), 96);
const blockMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.96, 0.96, 0.96), new THREE.MeshStandardMaterial({ roughness: 0.6 }), 16);
for (const m of [ballMesh, blockMesh]) {
  m.frustumCulled = false;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(m);
}
const stackPad = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.05, 4).rotateX(-Math.PI / 2).rotateY(Math.PI / 4), new THREE.MeshBasicMaterial({ color: 0x4a7bd1, side: THREE.DoubleSide }));
stackPad.position.y = 0.03;
scene.add(stackPad);
const C_BLOCK = { floor: new THREE.Color(0x8a6a44), held: new THREE.Color(0xd8b37a), stack: new THREE.Color(0xf2c14e), falling: new THREE.Color(0xc0503a) };

// ------------------------------------------------------------------ colours
const C_HAWK = new THREE.Color(0xff6b4a), C_DOVE = new THREE.Color(0x63d4ff);
const C_NOISE = new THREE.Color(0x6b7785);
const C_WOUND = new THREE.Color(0x4a0a0a), C_HIT = new THREE.Color(0xffffff);
const tmpC = new THREE.Color();
// every colouring shows health too: wounds darken a fly toward dried blood, and a
// fresh hit flashes white
function flyColor(i, out) {
  baseColor(i, out);
  if (settings.color !== "health") out.lerp(C_WOUND, 0.75 * (1 - sim.hp[i]));
  if (sim.hurt[i] < 0.25) out.lerp(C_HIT, 0.8 * (1 - sim.hurt[i] / 0.25));
  return out;
}
function baseColor(i, out) {
  switch (settings.color) {
    case "health": {
      const hp = Math.max(0, Math.min(1, sim.hp[i]));
      return out.setHSL(0.33 * hp, 0.85, 0.32 + 0.22 * hp); // green → yellow → red
    }
    case "swarm":
      return sim.swarm[i] < 0 ? out.copy(C_NOISE) : out.set(swarmColor(sim.swarm[i]));
    case "mode":
      return out.set(MODE_COLORS[sim.mode[i]]);
    case "energy": {
      const e = Math.max(0, Math.min(1, sim.energy[i] / 12));
      return out.setHSL(0.0 + 0.33 * e, 0.75, 0.35 + 0.25 * e);
    }
    default: {
      out.copy(C_DOVE).lerp(C_HAWK, sim.disposition(i));
      if (sim.cooldown[i] > 1.1) out.lerp(sim.lastHawk[i] ? C_HAWK : C_DOVE, 0.6).multiplyScalar(1.4); // flash on contest
      return out;
    }
  }
}

// ------------------------------------------------------------------ per-frame scene update
const dummy = new THREE.Object3D();
dummy.rotation.order = "YXZ";
function updateScene() {
  const n = sim.n;
  for (let i = 0; i < n; i++) {
    const x = sim.x[i], y = sim.y[i] + 0.25, z = sim.z[i], h = sim.h[i];
    const pitch = sim.y[i] > 0.3 ? -0.15 : 0;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, -h, pitch);
    dummy.scale.setScalar(FLY_SCALE);
    dummy.updateMatrix();
    bodyMesh.setMatrixAt(i, dummy.matrix);
    eyeMesh.setMatrixAt(i, dummy.matrix);
    bodyMesh.setColorAt(i, flyColor(i, tmpC));

    const flap = sim.y[i] > 0.05 ? Math.sin(sim.wing[i]) * 0.9 : 0.15;
    dummy.rotation.set(flap, -h, pitch);
    dummy.updateMatrix();
    wingR.setMatrixAt(i, dummy.matrix);
    dummy.rotation.set(-flap, -h, pitch);
    dummy.updateMatrix();
    wingL.setMatrixAt(i, dummy.matrix);

    dummy.position.set(x, 0.02, z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(Math.max(0.4, 1.4 - sim.y[i] * 0.12));
    dummy.updateMatrix();
    shadowMesh.setMatrixAt(i, dummy.matrix);
  }
  for (const m of [bodyMesh, eyeMesh, wingL, wingR, shadowMesh]) {
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  }
  if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;

  // patches
  for (let k = 0; k < sim.patches.length; k++) {
    const p = sim.patches[k], m = patchMeshes[k];
    m.group.position.set(p.x, 0, p.z);
    m.group.scale.set(p.r, 1, p.r);
    const col = p.bitter ? 0x9a5cff : 0xf2a541;
    m.disc.material.color.set(col);
    m.ring.material.color.set(p.bitter ? 0xc9a6ff : 0xffd28a);
    m.glow.material.color.set(col);
    m.disc.material.opacity = p.bitter ? 0.45 : 0.15 + 0.6 * p.sugar;
    m.glow.material.opacity = p.bitter ? 0.05 : 0.03 + 0.1 * p.sugar;
  }

  // leaders
  const leaders = sim.social.leaders || [];
  let L = 0;
  for (const i of leaders) {
    if (L >= 64 || i >= n) break;
    dummy.position.set(sim.x[i], sim.y[i] + 1.4, sim.z[i]);
    dummy.rotation.set(0, performance.now() / 500, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    leaderMesh.setMatrixAt(L++, dummy.matrix);
  }
  leaderMesh.count = L;
  leaderMesh.instanceMatrix.needsUpdate = true;
  leaderMesh.visible = settings.social;

  // social edges
  edgeLines.visible = settings.social;
  if (settings.social) {
    const E = sim.socialEdges;
    const m = Math.min(MAX_EDGES, E.length / 2);
    for (let e = 0; e < m; e++) {
      const a = E[2 * e], b = E[2 * e + 1], o = e * 6;
      edgePos[o] = sim.x[a]; edgePos[o + 1] = sim.y[a] + 0.3; edgePos[o + 2] = sim.z[a];
      edgePos[o + 3] = sim.x[b]; edgePos[o + 4] = sim.y[b] + 0.3; edgePos[o + 5] = sim.z[b];
    }
    edgeGeo.setDrawRange(0, m * 2);
    edgeGeo.attributes.position.needsUpdate = true;
  }

  // routes
  allPaths.visible = settings.pathsAll;
  if (settings.pathsAll) {
    let o = 0;
    for (let i = 0; i < n; i++) {
      const path = sim.path[i];
      if (!path) continue;
      let px = sim.x[i], pz = sim.z[i];
      for (let k = sim.pathIdx[i]; k < path.length && o < allPathPos.length - 6; k++) {
        allPathPos.set([px, 0.15, pz, path[k][0], 0.15, path[k][1]], o);
        o += 6;
        px = path[k][0];
        pz = path[k][1];
      }
    }
    allPathGeo.setDrawRange(0, o / 3);
    allPathGeo.attributes.position.needsUpdate = true;
  }
  if (selected >= 0 && selected < n) {
    selRing.visible = true;
    selRing.position.set(sim.x[selected], 0.05, sim.z[selected]);
    const path = sim.path[selected];
    pathLine.visible = settings.path && !!path;
    if (pathLine.visible) {
      const arr = pathGeo.attributes.position.array;
      arr.set([sim.x[selected], 0.2, sim.z[selected]], 0);
      let c = 1;
      for (let k = sim.pathIdx[selected]; k < path.length && c < 64; k++, c++) arr.set([path[k][0], 0.2, path[k][1]], c * 3);
      pathGeo.setDrawRange(0, c);
      pathGeo.attributes.position.needsUpdate = true;
      pathLine.computeLineDistances();
    }
    if (follow) {
      const target = new THREE.Vector3(sim.x[selected], sim.y[selected], sim.z[selected]);
      const delta = target.clone().sub(controls.target).multiplyScalar(0.08);
      controls.target.add(delta);
      camera.position.add(delta);
    }
  } else {
    selRing.visible = false;
    pathLine.visible = false;
  }

  // corpses
  let nc = 0;
  for (const c of sim.corpses) {
    if (nc >= 160) break;
    const fade = Math.min(1, (CORPSE_LIFE - c.age) / 1); // shrink away in the last second
    dummy.position.set(c.x, c.y + 0.12, c.z);
    dummy.rotation.set(Math.PI, -c.h, c.held ? 0.5 : 0.2); // legs up
    dummy.scale.setScalar(FLY_SCALE * Math.max(0.05, c.held ? 1 : fade));
    dummy.updateMatrix();
    corpseMesh.setMatrixAt(nc, dummy.matrix);
    corpseMesh.setColorAt(nc++, tmpC.set(CAUSE_COLORS[c.cause] ?? 0x333333));
  }
  corpseMesh.count = nc;
  let ns = 0;
  for (const c of sim.corpses) {
    if (ns >= 160 || c.held || c.y > 0.05 || !VIOLENT.has(c.cause)) continue;
    dummy.position.set(c.x, 0.025, c.z);
    dummy.rotation.set(0, c.h, 0);
    dummy.scale.set(1.3 * Math.min(1, c.age * 3), 1, Math.min(1, c.age * 3) * Math.max(0.05, Math.min(1, CORPSE_LIFE - c.age)));
    dummy.updateMatrix();
    splatMesh.setMatrixAt(ns++, dummy.matrix);
  }
  splatMesh.count = ns;
  splatMesh.instanceMatrix.needsUpdate = true;
  corpseMesh.instanceMatrix.needsUpdate = true;
  if (corpseMesh.instanceColor) corpseMesh.instanceColor.needsUpdate = true;

  // dragonflies
  while (chaserMeshes.length < sim.chasers.length) chaserMeshes.push(makeChaser());
  chaserMeshes.forEach((g, k) => {
    const c = sim.chasers[k];
    g.visible = !!c;
    if (!c) return;
    g.position.set(c.x, c.y, c.z);
    g.rotation.set(0, -Math.atan2(c.vz, c.vx), Math.atan2(c.vy, Math.hypot(c.vx, c.vz) + 1e-3) * 0.5);
    const t = performance.now() / 22 + k;
    for (const w of g.userData.wings) w.rotation.x = w.userData.side * Math.sin(t + (w.position.x > 0 ? 0 : 1.2)) * 0.6;
  });

  // robots
  while (robotViews.length < sim.robots.length) robotViews.push(makeRobotView(sim.robots[robotViews.length]));
  sim.robots.forEach((R, k) => {
    const v = robotViews[k], on = !!sim.params.robots?.[R.kind];
    for (const m of v.parts) m.visible = on;
    if (!on) return;
    const P = R.pts;
    v.base.position.set(R.x, 0.3, R.z);
    if (R.kind === "shooter") {
      span(v.post, P[0], P[1]);
      span(v.barrel, P[1], P[2]);
      v.turret.position.set(...P[1]);
      return;
    }
    for (let j = 0; j < 4; j++) span(v.links[j], P[j], P[j + 1]);
    v.joints.forEach((m, j) => m.position.set(...P[j + 1]));
    const t = P[4];
    if (v.hoop) {
      v.hoop.position.set(...t);
      v.bag.position.set(...t);
      v.hoop.rotation.y = v.bag.rotation.y = -R.q[0];
    } else {
      const yaw = R.q[0] + R.q[4], open = 0.15 + 0.45 * R.grip;
      v.fingers.forEach((m, s) => {
        const side = s ? 1 : -1;
        m.position.set(t[0] - Math.sin(yaw) * open * side, t[1] + 0.5, t[2] + Math.cos(yaw) * open * side);
        m.rotation.set(0, -yaw, 0);
      });
    }
  });
  ballMesh.count = Math.min(96, sim.balls.length);
  for (let b = 0; b < ballMesh.count; b++) {
    const ball = sim.balls[b];
    dummy.position.set(ball.x, ball.y, ball.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    ballMesh.setMatrixAt(b, dummy.matrix);
  }
  ballMesh.instanceMatrix.needsUpdate = true;
  const st = sim.robots.find((R) => R.kind === "stacker");
  const stOn = !!(st && sim.params.robots?.stacker);
  blockMesh.visible = stackPad.visible = stOn;
  if (stOn) {
    stackPad.position.set(st.stackAt[0], 0.03, st.stackAt[1]);
    st.blocks.forEach((b, k) => {
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(0, b.state === "stack" ? 0 : k * 0.7, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      blockMesh.setMatrixAt(k, dummy.matrix);
      blockMesh.setColorAt(k, C_BLOCK[b.state]);
    });
    blockMesh.instanceMatrix.needsUpdate = true;
    if (blockMesh.instanceColor) blockMesh.instanceColor.needsUpdate = true;
  }

  // predator
  const p = sim.predator;
  predator.position.set(p.x, p.y, p.z);
  predator.rotation.y = -Math.atan2(p.vz, p.vx);
  predator.rotation.z = Math.atan2(p.vy, Math.hypot(p.vx, p.vz) + 1e-3) * 0.6;
  const beat = Math.sin(performance.now() / (p.mode === "dive" ? 60 : 160)) * 0.5;
  predator.userData.wings[0].rotation.x = beat;
  predator.userData.wings[1].rotation.x = -beat;
  predator.visible = sim.params.predator || p.y < 39;
}

// ------------------------------------------------------------------ picking
function pick(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector3();
  let best = -1, bestD = 22 * 22;
  for (let i = 0; i < sim.n; i++) {
    v.set(sim.x[i], sim.y[i] + 0.3, sim.z[i]).project(camera);
    if (v.z > 1) continue;
    const sx = ((v.x + 1) / 2) * rect.width + rect.left;
    const sy = ((1 - v.y) / 2) * rect.height + rect.top;
    const d = (sx - clientX) ** 2 + (sy - clientY) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const i = pick(e.clientX, e.clientY);
  select(i >= 0 ? i : -1);
  $("#hint").style.opacity = 0;
});
function select(i) {
  selected = i;
  if (i < 0) follow = false;
  panels.selectFly(i);
}

// ------------------------------------------------------------------ panels, brain, ideas
// The brain view (139k points in a second WebGL context) is built right after the
// first frame so the swarm appears immediately; until then a stand-in absorbs calls.
let brain = { mode: "activity", resize() {}, render() {}, setMode(m) { this.mode = m; } };
async function buildBrain() {
  let real;
  try {
    real = RENDER_KIND === "2d" ? new Brain2D($("#brain-view"), cx, data.neurons, analysis) : await BrainView.create($("#brain-view"), cx, data.neurons, analysis, RENDER_KIND);
  } catch (err) {
    console.warn("3D brain view unavailable, using the canvas version:", err.message);
    $("#brain-view").replaceChildren();
    real = new Brain2D($("#brain-view"), cx, data.neurons, analysis);
  }
  if (brain.mode !== "activity") real.setMode(brain.mode);
  brain = real;
  panels.brain = real;
  real.resize();
}
const panels = new Panels({ sim: () => sim, cx, analysis, refs, brain, onFollow: (v) => (follow = v), onDeselect: () => select(-1) });
const ideas = new IdeasMap($("#ideas-svg"), $("#ideas-detail"), { sim: () => sim, cx, analysis, refs });

// ------------------------------------------------------------------ shareable state (?V=2&C=5&game=pd…)
const SLIDERS = { V: "#r-V", C: "#r-C", mut: "#r-mut", n: "#r-n", gain: "#r-gain", eps: "#r-eps", min: "#r-min", drag: "#r-drag" };
const ROBOT_BOXES = { picker: "#c-picker", net: "#c-net", shooter: "#c-shooter", stacker: "#c-stacker" };
const query = new URLSearchParams(location.search);
for (const [k, id] of Object.entries(SLIDERS)) if (query.has(k)) $(id).value = query.get(k);
if (query.has("pred")) $("#c-pred").checked = query.get("pred") !== "0";
if (query.has("bots")) for (const [k, id] of Object.entries(ROBOT_BOXES)) $(id).checked = query.get("bots").split(",").includes(k);

// ------------------------------------------------------------------ controls wiring
function bindRange(id, out, fmt, apply) {
  const el = $(id), o = $(out);
  const f = () => {
    o.textContent = fmt(+el.value);
    apply(+el.value);
  };
  el.addEventListener("input", f);
  f();
}
bindRange("#r-V", "#o-V", (v) => v.toFixed(1), (v) => (sim.params.V = v));
bindRange("#r-C", "#o-C", (v) => v.toFixed(1), (v) => (sim.params.C = v));
bindRange("#r-mut", "#o-mut", (v) => v.toFixed(2), (v) => (sim.params.mutation = v));
bindRange("#r-n", "#o-n", (v) => v.toFixed(0), (v) => sim.setFlyCount(v));
bindRange("#r-gain", "#o-gain", (v) => v.toFixed(1), (v) => (sim.params.gain = v));
bindRange("#r-eps", "#o-eps", (v) => v.toFixed(1), (v) => (sim.params.dbEps = v));
bindRange("#r-min", "#o-min", (v) => v.toFixed(0), (v) => (sim.params.dbMin = v));
$("#c-pred").addEventListener("change", (e) => (sim.params.predator = e.target.checked));
sim.params.predator = $("#c-pred").checked;
bindRange("#r-drag", "#o-drag", (v) => v.toFixed(0), (v) => (sim.params.chasers = v));
function applyRobots() {
  sim.params.robots = Object.fromEntries(Object.entries(ROBOT_BOXES).map(([k, id]) => [k, $(id).checked]));
}
for (const id of Object.values(ROBOT_BOXES)) $(id).addEventListener("change", applyRobots);
applyRobots();
$("#c-social").addEventListener("change", (e) => (settings.social = e.target.checked));
$("#c-path").addEventListener("change", (e) => (settings.path = e.target.checked));
$("#c-paths-all").addEventListener("change", (e) => (settings.pathsAll = e.target.checked));
$("#sel-speed").addEventListener("change", (e) => (settings.speed = +e.target.value));
$("#btn-pause").addEventListener("click", togglePause);
addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target === document.body) {
    e.preventDefault();
    togglePause();
  }
});
function togglePause() {
  settings.paused = !settings.paused;
  $("#btn-pause").textContent = settings.paused ? "Resume" : "Pause";
}
for (const [btn, cls] of [["#btn-left", "hide-left"], ["#btn-right", "hide-right"]]) {
  $(btn).addEventListener("click", (e) => {
    const on = document.body.classList.toggle(cls);
    e.target.setAttribute("aria-pressed", String(!on));
    resize();
  });
}

function segment(id, onPick) {
  const buttons = document.querySelectorAll(`${id} button`);
  const pick = (v) => {
    buttons.forEach((x) => x.classList.toggle("on", x.dataset.v === v));
    onPick(v);
  };
  buttons.forEach((b) => b.addEventListener("click", () => pick(b.dataset.v)));
  return pick;
}

// game choice: relabel the two payoff sliders and (unless restoring a link) load sensible defaults
function setGame(game, keepValues) {
  const g = GAMES[game];
  $("#lbl-V").textContent = g.vLabel;
  $("#lbl-C").textContent = g.cLabel;
  if (!keepValues) {
    $("#r-V").value = g.defaults[0];
    $("#r-C").value = g.defaults[1];
  }
  $("#o-V").textContent = (+$("#r-V").value).toFixed(1);
  $("#o-C").textContent = (+$("#r-C").value).toFixed(1);
  sim.setGame(game, +$("#r-V").value, +$("#r-C").value);
  panels.legend(settings.color);
  panels.update(selected);
}
segment("#seg-game", (v) => setGame(v, false));
const pickLearn = segment("#seg-learn", (v) => (sim.params.learnFrom = v));
const pickColor = segment("#seg-color", (v) => {
  settings.color = v;
  panels.legend(v);
});
if (GAMES[query.get("game")]) {
  document.querySelectorAll("#seg-game button").forEach((x) => x.classList.toggle("on", x.dataset.v === query.get("game")));
  setGame(query.get("game"), true);
}
if (query.get("learn") === "anyone") pickLearn("anyone");
if (["strategy", "health", "swarm", "mode", "energy"].includes(query.get("color"))) pickColor(query.get("color"));
panels.legend(settings.color);

// silencing experiments
const io = cx.io;
const SILENCE = [
  { label: "Giant Fiber (DNp01)", hint: "no escape take-offs", nodes: io.gf },
  { label: "MN9 proboscis motor neuron", hint: "cannot feed → starvation", nodes: io.mn9 },
  { label: "PFL3 goal neurons", hint: "heuristic goals no longer steer", nodes: io.pfl3 },
  { label: "DNa02 steering neurons", hint: "no deliberate turns", nodes: io.dna02 },
  { label: "Octopaminergic (OA-) types", hint: "no arousal → fewer hawks", nodes: cx.oa },
  { label: "LPLC2 looming detectors", hint: "blind to the predator", nodes: io.loom },
  { label: "MDN moonwalker neurons", hint: "no backing away", nodes: io.mdn },
];
const silenceBox = $("#silence");
for (const s of SILENCE) {
  const lab = document.createElement("label");
  lab.className = "check";
  lab.innerHTML = `<input type="checkbox" /> <span>${s.label}<small>${s.hint}</small></span>`;
  lab.querySelector("input").addEventListener("change", applySilence);
  s.input = lab.querySelector("input");
  silenceBox.appendChild(lab);
}
function applySilence() {
  sim.silenced = new Set(SILENCE.flatMap((s) => (s.input.checked ? s.nodes.filter((i) => i >= 0) : [])));
}
for (const k of (query.get("silence") || "").split(",")) if (k !== "" && SILENCE[+k]) SILENCE[+k].input.checked = true;
applySilence();

function stateQuery() {
  const q = new URLSearchParams();
  q.set("game", sim.params.game);
  for (const [k, id] of Object.entries(SLIDERS)) q.set(k, $(id).value);
  if (!sim.params.predator) q.set("pred", "0");
  const bots = Object.keys(ROBOT_BOXES).filter((k) => sim.params.robots[k]);
  if (bots.length !== 4) q.set("bots", bots.join(","));
  if (sim.params.learnFrom !== "neighbours") q.set("learn", sim.params.learnFrom);
  if (settings.color !== "strategy") q.set("color", settings.color);
  const off = SILENCE.flatMap((s, k) => (s.input.checked ? [k] : []));
  if (off.length) q.set("silence", off.join(","));
  return "?" + q.toString();
}
let lastQuery = "";
function syncUrl() {
  const q = stateQuery();
  if (q !== lastQuery) {
    lastQuery = q;
    history.replaceState(null, "", q);
  }
}
$("#btn-share").addEventListener("click", async () => {
  syncUrl();
  const btn = $("#btn-share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied ✓";
  } catch {
    btn.textContent = "Copy the address bar";
  }
  setTimeout(() => (btn.textContent = "Copy link to this setup"), 1800);
});

// ------------------------------------------------------------------ save / load
function swapSim(next) {
  sim.brains.dispose();
  sim = next;
  sim.brains.enableWorker(WORKER_URL);
  buildWorld();
  select(-1);
}
// put every control back in step with a restored model
function syncControls(ui) {
  const P = sim.params;
  const vals = { V: P.V, C: P.C, mut: P.mutation, n: sim.n, gain: P.gain, eps: P.dbEps, min: P.dbMin, drag: P.chasers };
  for (const [k, id] of Object.entries(SLIDERS)) {
    $(id).value = vals[k];
    $(id).dispatchEvent(new Event("input"));
  }
  $("#c-pred").checked = P.predator;
  for (const [k, id] of Object.entries(ROBOT_BOXES)) $(id).checked = !!P.robots?.[k];
  applyRobots();
  document.querySelectorAll("#seg-game button").forEach((x) => x.classList.toggle("on", x.dataset.v === P.game));
  $("#lbl-V").textContent = GAMES[P.game].vLabel; // not setGame(): that would wipe the restored history
  $("#lbl-C").textContent = GAMES[P.game].cLabel;
  panels.legend(settings.color);
  pickLearn(P.learnFrom);
  SILENCE.forEach((x, k) => (x.input.checked = (ui.silence || []).includes(k)));
  applySilence();
  if (ui.color) pickColor(ui.color);
}
new ModelStore({
  getSim: () => sim,
  getUi: () => ({ color: settings.color, silence: SILENCE.flatMap((s, k) => (s.input.checked ? [k] : [])) }),
  onLoad: (snap) => {
    swapSim(restore(cx, snap));
    syncControls(snap.ui || {});
  },
});

$("#btn-reset").addEventListener("click", () => {
  const params = { ...sim.params };
  swapSim(new Sim(cx, { flies: +$("#r-n").value, params, seed: (Math.random() * 1e9) | 0 }));
  applySilence();
});

// ------------------------------------------------------------------ resize & loop
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = w < h ? 62 : 45; // portrait screens need a wider view to fit the arena
  camera.updateProjectionMatrix();
  brain.resize();
}
addEventListener("resize", resize);
new ResizeObserver(resize).observe(stage);

buildWorld();
resize();
const RENDER_NOTE = {
  webgpu: "Rendering with WebGPU (WebGL is unavailable in this browser).",
  "2d": RENDER_PREF === "2d" ? "2D canvas view (?renderer=2d)." : "Neither WebGL nor WebGPU is available here, so this is a simplified 2D canvas view. Enable hardware acceleration in your browser settings for full 3D.",
};
if (SOFTWARE_GL) RENDER_NOTE.webgl = "Hardware acceleration looks off in this browser, so the 3D view will be slow — enable it in browser settings for 60 fps.";
if (RENDER_NOTE[RENDER_KIND] && !(RENDER_KIND === "webgpu" && RENDER_PREF === "webgpu")) {
  $("#hint").textContent = RENDER_NOTE[RENDER_KIND];
  $("#hint").style.opacity = 1;
  setTimeout(() => ($("#hint").style.opacity = 0), 15000);
} else setTimeout(() => ($("#hint").style.opacity = 0), 9000);

const STEP = 1 / 30;
let acc = 0, last = performance.now(), uiTimer = 0, started = false;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!settings.paused && !document.hidden) {
    acc += dt * settings.speed;
    let steps = 0;
    while (acc >= STEP && steps < 6) {
      sim.step();
      acc -= STEP;
      steps++;
    }
    if (steps === 6) acc = 0; // fall behind gracefully on slow machines
  }
  if (selected >= sim.n) select(-1);
  updateScene();
  controls.update();
  renderer.render(scene, camera);
  brain.render(sim, selected);
  if (!started) {
    // first frame is on screen: drop the loader, then build the brain view
    started = true;
    $("#loader").classList.add("done");
    setTimeout(buildBrain, 50);
  }
  uiTimer += dt;
  if (uiTimer > 0.25) {
    uiTimer = 0;
    panels.update(selected);
    ideas.update();
    syncUrl();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
