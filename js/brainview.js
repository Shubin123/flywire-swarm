// 3D view of the FlyWire brain: every neuron's position as a point, coloured by
// the live activity of its cell type in the selected fly's connectome.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export const CLASS_COLORS = {
  ascending: "#d77cff",
  central: "#5cc8ff",
  descending: "#ff6b4a",
  endocrine: "#ffd166",
  motor: "#ff3b7f",
  optic: "#4f7cac",
  sensory: "#7ddc8a",
  sensory_ascending: "#b5e48c",
  visual_centrifugal: "#9b8cff",
  visual_projection: "#3ad1c4",
  unknown: "#888888",
};

const S = 12; // world size of the brain
const LABELS = [
  ["sugar", 1, "sugar GRN"], ["loom", 0, "LPLC2"], ["pfl3", 0, "PFL3"], ["dna02", 1, "DNa02"],
  ["gf", 0, "Giant Fiber"], ["mn9", 1, "MN9"], ["mdn", 0, "MDN"], ["orn", 1, "ORN"],
];

// inferno-like ramp for activity (dark → red → orange → pale yellow)
const RAMP = [
  [0, 0.12, 0.04, 0.3],
  [0.35, 0.78, 0.16, 0.35],
  [0.7, 1.0, 0.52, 0.1],
  [1, 1.0, 0.95, 0.6],
];
function ramp(a, out) {
  a = Math.max(0, Math.min(1, a));
  let k = 1;
  while (k < RAMP.length - 1 && a > RAMP[k][0]) k++;
  const [a0, r0, g0, b0] = RAMP[k - 1], [a1, r1, g1, b1] = RAMP[k];
  const t = (a - a0) / (a1 - a0);
  return out.setRGB(r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t);
}

function toWorld(px, py, pz, out) {
  // FlyWire: x = left→right, y = dorsal→ventral, z = anterior→posterior
  return out.set(px * S, -py * S, -pz * S * 1.6);
}

export class BrainView {
  constructor(el, cx, neurons, analysis) {
    this.el = el;
    this.cx = cx;
    this.analysis = analysis;
    this.mode = "activity";
    this.N = cx.N;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.setClearColor(0x05080c);
    el.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.style.position = "absolute";
    this.labels.domElement.style.inset = "0";
    this.labels.domElement.style.pointerEvents = "none";
    el.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(0, 1, 13.5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.6;

    // --- neuron point cloud
    const n = neurons.count;
    const pos = new Float32Array(n * 3), grp = new Float32Array(n), col = new Float32Array(n * 3);
    const v = new THREE.Vector3(), c = new THREE.Color();
    const classCols = neurons.classes.map((k) => new THREE.Color(CLASS_COLORS[k] || CLASS_COLORS.unknown));
    for (let i = 0; i < n; i++) {
      const q = neurons.xyzg;
      toWorld(q[4 * i] / 65535 - 0.5, q[4 * i + 1] / 65535 - 0.5, q[4 * i + 2] / 65535 - 0.5, v);
      pos.set([v.x, v.y, v.z], 3 * i);
      grp[i] = q[4 * i + 3];
      c.copy(classCols[neurons.superClass[i]]);
      col.set([c.r, c.g, c.b], 3 * i);
    }
    this.nodeTex = new THREE.DataTexture(new Float32Array(this.N * 4), this.N, 1, THREE.RGBAFormat, THREE.FloatType);
    this.nodeTex.needsUpdate = true;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("grp", new THREE.BufferAttribute(grp, 1));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.pointsMat = new THREE.ShaderMaterial({
      uniforms: {
        nodeTex: { value: this.nodeTex },
        N: { value: this.N },
        size: { value: 1.6 * Math.min(2, devicePixelRatio) },
        dim: { value: 0.45 },
      },
      vertexShader: /* glsl */ `
        attribute float grp;
        attribute vec3 color;
        uniform sampler2D nodeTex;
        uniform float N, size, dim;
        varying vec3 vCol;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float boost = 0.0;
          vec3 c = color * dim;
          if (grp < 65535.0) {
            vec4 t = texture2D(nodeTex, vec2((grp + 0.5) / N, 0.5));
            c = mix(color * dim * 1.3, t.rgb, t.a);
            boost = t.a;
          }
          vCol = c;
          vA = 0.35 + 0.6 * boost;
          gl_PointSize = size * (1.0 + 1.2 * boost) * (14.0 / -mv.z);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        varying float vA;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d);
          if (r > 0.25) discard;
          gl_FragColor = vec4(vCol, vA * (1.0 - r * 3.0));
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.pointsMat);
    this.scene.add(this.points);

    // --- reduced graph: nodes and edges
    this.nodePos = cx.nodes.map((nd) => toWorld(nd.p[0], nd.p[1], nd.p[2], new THREE.Vector3()));
    this.nodeBase = cx.nodes.map((nd) => new THREE.Color(CLASS_COLORS[nd.sc] || CLASS_COLORS.unknown));
    const sphere = new THREE.SphereGeometry(1, 10, 8);
    this.nodeMesh = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 }), this.N);
    this.nodeSize = cx.nodes.map((nd) => 0.018 + 0.009 * Math.log10(1 + nd.syn / 1000));
    this.scene.add(this.nodeMesh);

    const E = cx.edges.length;
    const epos = new Float32Array(E * 6);
    this.edgeCol = new Float32Array(E * 6);
    cx.edges.forEach(([s, t], k) => {
      const a = this.nodePos[s], b = this.nodePos[t];
      epos.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6);
    });
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.BufferAttribute(epos, 3));
    eg.setAttribute("color", new THREE.BufferAttribute(this.edgeCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.edges = new THREE.LineSegments(
      eg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.18, depthWrite: false })
    );
    this.scene.add(this.edges);

    // --- key sensorimotor paths
    for (const p of analysis.pairs) {
      if (p.path.length < 2) continue;
      const g = new THREE.BufferGeometry().setFromPoints(p.path.map((i) => this.nodePos[i]));
      this.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 })));
    }

    // --- labels on the input/output cell types
    for (const [k, side, text] of LABELS) {
      const idx = cx.io[k]?.[side];
      if (idx === undefined || idx < 0) continue;
      const div = document.createElement("div");
      div.className = "brain-label";
      div.textContent = text;
      const obj = new CSS2DObject(div);
      obj.position.copy(this.nodePos[idx]).add(new THREE.Vector3(0, 0.25, 0));
      this.scene.add(obj);
    }

    this.act = new Float32Array(this.N);
    this.frame = 0;
    this.setMode("activity");
    this.renderer.domElement.addEventListener("pointerdown", () => (this.controls.autoRotate = false));
  }

  setMode(mode) {
    this.mode = mode;
    const N = this.N, tex = this.nodeTex.image.data, c = new THREE.Color();
    this.staticCol = [];
    for (let i = 0; i < N; i++) {
      if (mode === "community") c.setHSL((this.analysis.lv.membership[i] * 0.618) % 1, 0.75, 0.58);
      else if (mode === "pagerank") {
        const r = Math.min(1, Math.sqrt(this.analysis.pr[i] * N) / 3);
        c.setHSL(0.62 - 0.6 * r, 0.9, 0.3 + 0.4 * r);
      } else c.copy(this.nodeBase[i]);
      this.staticCol.push(c.clone());
      tex.set([c.r, c.g, c.b, mode === "class" ? 0.5 : 0.85], i * 4);
    }
    this.nodeTex.needsUpdate = true;
    this.paintEdges(null);
    this.paintNodes(null);
  }

  paintNodes(act) {
    const m = new THREE.Matrix4(), c = new THREE.Color();
    for (let i = 0; i < this.N; i++) {
      const a = act ? act[i] : 0;
      const s = this.nodeSize[i] * (1 + (act ? 2.5 * a : 0.4));
      m.makeScale(s, s, s).setPosition(this.nodePos[i]);
      this.nodeMesh.setMatrixAt(i, m);
      if (act) ramp(a, c);
      else c.copy(this.staticCol[i]);
      this.nodeMesh.setColorAt(i, c);
    }
    this.nodeMesh.instanceMatrix.needsUpdate = true;
    this.nodeMesh.instanceColor.needsUpdate = true;
  }

  paintEdges(act) {
    const ec = this.edgeCol;
    this.cx.edges.forEach(([s, t, w], k) => {
      const exc = w > 0;
      const a = act ? 0.15 + 0.85 * act[s] : 0.5;
      const r = exc ? 1.0 : 0.25, g = exc ? 0.55 : 0.6, b = exc ? 0.2 : 1.0;
      ec[k * 6] = ec[k * 6 + 3] = r * a;
      ec[k * 6 + 1] = ec[k * 6 + 4] = g * a;
      ec[k * 6 + 2] = ec[k * 6 + 5] = b * a;
    });
    this.edges.geometry.attributes.color.needsUpdate = true;
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // activity of the selected fly (or the swarm average) drives the colours
  render(sim, selected) {
    if (!this.el.offsetParent) return; // tab hidden
    if (this.el.clientWidth !== this.renderer.domElement.clientWidth) this.resize();
    this.frame++;
    if (this.mode === "activity" && this.frame % 2 === 0) {
      const R = sim.brains.R, N = this.N, act = this.act;
      if (selected >= 0) for (let i = 0; i < N; i++) act[i] = R[selected * N + i];
      else {
        act.fill(0);
        const n = sim.n;
        for (let f = 0; f < n; f++) for (let i = 0; i < N; i++) act[i] += R[f * N + i];
        for (let i = 0; i < N; i++) act[i] = Math.min(1, act[i] / n);
      }
      const tex = this.nodeTex.image.data, hot = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const a = act[i];
        ramp(a, hot);
        tex[i * 4] = hot.r;
        tex[i * 4 + 1] = hot.g;
        tex[i * 4 + 2] = hot.b;
        tex[i * 4 + 3] = Math.min(1, Math.max(0, (a - 0.04) * 2));
      }
      this.nodeTex.needsUpdate = true;
      this.paintNodes(act);
      this.paintEdges(act);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
