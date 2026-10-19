// Entry point: loads the FlyWire data, starts the swarm and draws it with three.js.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { loadData, Connectome } from "./connectome.js";
import { Sim, ARENA } from "./sim.js";
import { analyseConnectome } from "./analysis.js";
import { BrainView } from "./brainview.js";
import { Panels, MODE_COLORS, swarmColor } from "./panels.js";
import { IdeasMap } from "./ideas.js";
import { GAMES } from "./game.js";

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
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

// Without hardware acceleration WebGL falls back to a CPU rasteriser that is ~10x slower.
const glInfo = renderer.getContext().getExtension("WEBGL_debug_renderer_info");
const glName = glInfo ? renderer.getContext().getParameter(glInfo.UNMASKED_RENDERER_WEBGL) : "";
const SOFTWARE_GL = /swiftshader|llvmpipe|software|basic render/i.test(glName);
if (SOFTWARE_GL) renderer.setPixelRatio(1);

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

// ------------------------------------------------------------------ colours
const C_HAWK = new THREE.Color(0xff6b4a), C_DOVE = new THREE.Color(0x63d4ff);
const C_NOISE = new THREE.Color(0x6b7785);
const tmpC = new THREE.Color();
function flyColor(i, out) {
  switch (settings.color) {
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
function buildBrain() {
  const real = new BrainView($("#brain-view"), cx, data.neurons, analysis);
  if (brain.mode !== "activity") real.setMode(brain.mode);
  brain = real;
  panels.brain = real;
  real.resize();
}
const panels = new Panels({ sim: () => sim, cx, analysis, refs, brain, onFollow: (v) => (follow = v), onDeselect: () => select(-1) });
const ideas = new IdeasMap($("#ideas-svg"), $("#ideas-detail"), { sim: () => sim, cx, analysis, refs });

// ------------------------------------------------------------------ shareable state (?V=2&C=5&game=pd…)
const SLIDERS = { V: "#r-V", C: "#r-C", mut: "#r-mut", n: "#r-n", gain: "#r-gain", eps: "#r-eps", min: "#r-min" };
const query = new URLSearchParams(location.search);
for (const [k, id] of Object.entries(SLIDERS)) if (query.has(k)) $(id).value = query.get(k);
if (query.has("pred")) $("#c-pred").checked = query.get("pred") !== "0";

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
if (["strategy", "swarm", "mode", "energy"].includes(query.get("color"))) pickColor(query.get("color"));
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

$("#btn-reset").addEventListener("click", () => {
  const params = { ...sim.params };
  sim.brains.dispose();
  sim = new Sim(cx, { flies: +$("#r-n").value, params, seed: (Math.random() * 1e9) | 0 });
  sim.brains.enableWorker(WORKER_URL);
  applySilence();
  buildWorld();
  select(-1);
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
if (!SOFTWARE_GL) setTimeout(() => ($("#hint").style.opacity = 0), 9000);
else {
  $("#hint").textContent = "Hardware acceleration looks off in this browser, so the 3D view will be slow — enable it in browser settings for 60 fps.";
  $("#hint").style.opacity = 1;
}

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
